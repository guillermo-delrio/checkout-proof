// Durable state for the caps and the live re-run evidence, shared by every instance and kept across restarts.
// CP_STORE=firestore (the Cloud Run deployment): Firestore in Native mode, database "(default)" of CP_FIRESTORE_PROJECT,
// over its REST API with the runtime service account's token from the metadata server (no client library, no key).
// Anything else: in memory (tests and local runs), with the same behaviour.
//
// Counters are one document per cap and UTC day ("rerun-2026-10-19"), one integer field per key (`global`, and `v_`
// plus a hash of the visitor's address: no address is stored). A take is a single atomic increment of every field it
// needs; if any of them then passes its limit, the take is undone with a decrement, so a refused attempt costs nothing.
// Two racing takes at the edge may both be refused: the caps can only be stricter than configured, never looser.

export interface TakeResult { ok: boolean; values: Record<string, number>; over?: string }
/** A verified PayPal webhook delivery, kept so the instance running the job can pass it to its shop (a second
 *  instance may receive it). `headers`: PayPal's five transmission headers only (public signature data, no secret). */
export interface Delivery { id: string; at: number; eventId: string; type: string; resourceId: string; headers: Record<string, string>; raw: string }
export interface Store {
  readonly kind: "memory" | "firestore";
  read(doc: string): Promise<Record<string, number>>;
  take(doc: string, limits: Record<string, number>): Promise<TakeResult>;
  /** A lease (one re-run at a time across instances): true if this holder now has it until `untilMs`. */
  lease(name: string, holder: string, untilMs: number): Promise<boolean>;
  /** Gives one back to every key in one atomic write (a run lost to a stopped instance is not counted). */
  give(doc: string, keys: string[]): Promise<void>;
  release(name: string, holder: string): Promise<void>;
  leaseHolder(name: string): Promise<string | null>;
  putJob(id: string, summary: Record<string, unknown>, full: unknown): Promise<void>;
  getJob(id: string): Promise<unknown | undefined>;
  listJobs(limit: number): Promise<Record<string, unknown>[]>;
  putDelivery(jobId: string, d: Delivery): Promise<void>;
  /** Deliveries for a job with `at` > `since`, oldest first (at most 50). */
  listDeliveries(jobId: string, since: number): Promise<Delivery[]>;
}

export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private docs = new Map<string, Record<string, number>>();
  private leases = new Map<string, { holder: string; until: number }>();
  private jobs = new Map<string, { summary: Record<string, unknown>; full: unknown }>();
  private deliveries = new Map<string, Map<string, Delivery>>();
  constructor(private now: () => number = Date.now) {}
  async read(doc: string) { return { ...(this.docs.get(doc) ?? {}) }; }
  async take(doc: string, limits: Record<string, number>) {
    const d = this.docs.get(doc) ?? {};
    for (const k of Object.keys(limits)) d[k] = (d[k] ?? 0) + 1;
    this.docs.set(doc, d);
    const over = Object.keys(limits).find((k) => d[k] > limits[k]);
    if (over) { for (const k of Object.keys(limits)) d[k]--; return { ok: false, values: { ...d }, over }; }
    return { ok: true, values: { ...d } };
  }
  async give(doc: string, keys: string[]) {
    const d = this.docs.get(doc) ?? {};
    for (const k of keys) d[k] = (d[k] ?? 0) - 1;
    this.docs.set(doc, d);
  }
  async lease(name: string, holder: string, untilMs: number) {
    const l = this.leases.get(name);
    if (l && l.holder !== holder && l.until > this.now()) return false;
    this.leases.set(name, { holder, until: untilMs });
    return true;
  }
  async release(name: string, holder: string) { if (this.leases.get(name)?.holder === holder) this.leases.delete(name); }
  async leaseHolder(name: string) { const l = this.leases.get(name); return l && l.until > this.now() ? l.holder : null; }
  async putJob(id: string, summary: Record<string, unknown>, full: unknown) { this.jobs.set(id, { summary, full }); }
  async getJob(id: string) { return this.jobs.get(id)?.full; }
  async listJobs(limit: number) { return [...this.jobs.values()].map((j) => j.summary).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit); }
  async putDelivery(jobId: string, d: Delivery) { const m = this.deliveries.get(jobId) ?? new Map(); m.set(d.id, structuredClone(d)); this.deliveries.set(jobId, m); }
  async listDeliveries(jobId: string, since: number) { return [...(this.deliveries.get(jobId)?.values() ?? [])].filter((d) => d.at > since).sort((a, b) => a.at - b.at).slice(0, 50).map((d) => structuredClone(d)); }
}

type FsValue = { integerValue?: string; stringValue?: string; timestampValue?: string; doubleValue?: number; booleanValue?: boolean; nullValue?: null; mapValue?: { fields?: Record<string, FsValue> } };
const fromFs = (v: FsValue | undefined): unknown =>
  v === undefined ? undefined : v.integerValue !== undefined ? Number(v.integerValue) : v.doubleValue !== undefined ? v.doubleValue : v.booleanValue !== undefined ? v.booleanValue
    : v.stringValue !== undefined ? v.stringValue : v.timestampValue !== undefined ? v.timestampValue : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromFs(x)])) : null;
const toFs = (v: unknown): FsValue =>
  typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { booleanValue: v } : typeof v === "string" ? { stringValue: v }
    : v && typeof v === "object" && !Array.isArray(v) ? { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toFs(x)])) } } : { nullValue: null };

export class StoreError extends Error { override name = "StoreError"; }

export class FirestoreStore implements Store {
  readonly kind = "firestore" as const;
  private token: { v: string; exp: number } | null = null;
  private base: string;
  constructor(private project: string, private fetchImpl: typeof fetch = fetch, private getToken?: () => Promise<{ access_token: string; expires_in: number }>) {
    this.base = `projects/${project}/databases/(default)/documents`;
  }
  private async auth(): Promise<string> {
    if (this.token && this.token.exp > Date.now()) return this.token.v;
    const t = this.getToken ? await this.getToken() : await (await this.fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) })).json() as any;
    this.token = { v: t.access_token, exp: Date.now() + (Number(t.expires_in) || 300) * 1000 - 60_000 };
    return this.token.v;
  }
  private async call(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await this.fetchImpl(`https://firestore.googleapis.com/v1/${pathAndQuery}`, {
      method, headers: { Authorization: `Bearer ${await this.auth()}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    const json = await r.json().catch(() => ({}));
    if (r.status >= 400 && r.status !== 404 && r.status !== 409 && !(r.status === 400 && /FAILED_PRECONDITION/.test(JSON.stringify(json)))) throw new StoreError(`firestore ${method} → HTTP ${r.status}`);
    return { status: r.status, json };
  }
  private name(col: string, id: string) { return `${this.base}/${col}/${id}`; }
  private async increment(doc: string, fields: string[], by: number): Promise<Record<string, number>> {
    // An update with an empty mask plus increments: creates the document if needed, atomic per field.
    const { json } = await this.call("POST", `${this.base}:commit`, { writes: [{ update: { name: this.name("caps", doc), fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: fields.map((f) => ({ fieldPath: f, increment: { integerValue: String(by) } })) }] });
    const tr: FsValue[] = json?.writeResults?.[0]?.transformResults ?? [];
    if (tr.length !== fields.length) throw new StoreError("firestore: no transform results");
    return Object.fromEntries(fields.map((f, i) => [f, Number(fromFs(tr[i]))]));
  }
  async read(doc: string) {
    const { status, json } = await this.call("GET", this.name("caps", doc));
    if (status === 404) return {};
    return Object.fromEntries(Object.entries(json.fields ?? {}).map(([k, v]) => [k, Number(fromFs(v as FsValue))]));
  }
  async take(doc: string, limits: Record<string, number>) {
    const keys = Object.keys(limits);
    const values = await this.increment(doc, keys, 1);
    const over = keys.find((k) => values[k] > limits[k]);
    if (over) { await this.increment(doc, keys, -1).catch(() => {}); return { ok: false, values, over }; }
    return { ok: true, values };
  }
  async give(doc: string, keys: string[]) { await this.increment(doc, keys, -1); }
  async lease(name: string, holder: string, untilMs: number) {
    const { status, json } = await this.call("GET", this.name("leases", name));
    const cur = status === 404 ? null : (fromFs({ mapValue: { fields: json.fields } }) as { holder: string; until: number });
    if (cur && cur.holder !== holder && cur.until > Date.now()) return false;
    // Written only if nobody wrote it since the read: two instances racing for the slot cannot both win.
    const precondition = status === 404 ? { exists: false } : { updateTime: json.updateTime };
    const w = await this.call("POST", `${this.base}:commit`, { writes: [{ update: { name: this.name("leases", name), fields: { holder: toFs(holder), until: toFs(untilMs) } }, currentDocument: precondition }] });
    return w.status < 300;
  }
  async release(name: string, holder: string) {
    if ((await this.leaseHolder(name)) === holder) await this.call("POST", `${this.base}:commit`, { writes: [{ update: { name: this.name("leases", name), fields: { holder: toFs(""), until: toFs(0) } } }] });
  }
  async leaseHolder(name: string) {
    const { status, json } = await this.call("GET", this.name("leases", name));
    if (status === 404) return null;
    const cur = fromFs({ mapValue: { fields: json.fields } }) as { holder: string; until: number };
    return cur.holder && cur.until > Date.now() ? cur.holder : null;
  }
  // A job is kept as its summary (small, listed) plus the full result as one JSON string (well under 1 MiB).
  async putJob(id: string, summary: Record<string, unknown>, full: unknown) {
    await this.call("PATCH", this.name("jobs", id), { fields: { ...(toFs(summary).mapValue!.fields), json: toFs(JSON.stringify(full)) } });
  }
  async getJob(id: string) {
    const { status, json } = await this.call("GET", this.name("jobs", id));
    if (status === 404 || !json.fields?.json) return undefined;
    return JSON.parse(String(fromFs(json.fields.json)));
  }
  async listJobs(limit: number) {
    const { json } = await this.call("GET", `${this.base}/jobs?pageSize=${Math.min(300, Math.max(limit, 1))}&orderBy=startedAt%20desc&mask.fieldPaths=id&mask.fieldPaths=state&mask.fieldPaths=startedAt&mask.fieldPaths=finishedAt&mask.fieldPaths=commit&mask.fieldPaths=tally&mask.fieldPaths=scenarios&mask.fieldPaths=kind&mask.fieldPaths=expectedVerdict`);
    const rows = (json.documents ?? []).map((d: any) => fromFs({ mapValue: { fields: d.fields } }) as Record<string, unknown>);
    return rows.sort((a: any, b: any) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
  }
  // Deliveries live in deliveries/{jobId}/items (apart from `jobs`, so the history listing never sees them). The poll
  // is one query with a range filter on `at` (a single-field index, automatic): an empty answer costs one read.
  async putDelivery(jobId: string, d: Delivery) {
    await this.call("PATCH", `${this.base}/deliveries/${jobId}/items/${d.id}`, { fields: toFs(d).mapValue!.fields });
  }
  async listDeliveries(jobId: string, since: number) {
    const { json } = await this.call("POST", `${this.base}/deliveries/${jobId}:runQuery`, { structuredQuery: {
      from: [{ collectionId: "items" }], where: { fieldFilter: { field: { fieldPath: "at" }, op: "GREATER_THAN", value: { integerValue: String(Math.floor(since)) } } },
      orderBy: [{ field: { fieldPath: "at" }, direction: "ASCENDING" }], limit: 50 } });
    return (Array.isArray(json) ? json : []).filter((r: any) => r.document).map((r: any) => fromFs({ mapValue: { fields: r.document.fields } }) as Delivery);
  }
}

export function makeStore(env: NodeJS.ProcessEnv = process.env): Store {
  if (env.CP_STORE === "firestore") {
    if (!env.CP_FIRESTORE_PROJECT) throw new Error("CP_STORE=firestore needs CP_FIRESTORE_PROJECT");
    return new FirestoreStore(env.CP_FIRESTORE_PROJECT);
  }
  return new MemoryStore();
}
