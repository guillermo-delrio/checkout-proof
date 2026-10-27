// Runs Claude Code headless (claude -p) in a work copy. Max plan; no PayPal credentials in its environment.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, OUT, mkdirp } from "../env.ts";

export const MODEL = "claude-opus-5-5";

// The APIMatic server-SDK context plugin, vendored (out/vendor) and renamed: its manifest is also called "paypal",
// which collides with PayPal's AI Toolkit plugin. Only the TypeScript skills are kept.
export function apimaticPluginDir(): string {
  const src = path.join(OUT, "vendor", "server-sdk-context-plugin-preview");
  const dst = path.join(OUT, "context", "paypal-server-sdk");
  if (!fs.existsSync(src)) throw new Error("clone https://github.com/paypaldev/server-sdk-context-plugin-preview into out/vendor first");
  fs.rmSync(dst, { recursive: true, force: true });
  mkdirp(path.join(dst, ".claude-plugin"));
  const m = JSON.parse(fs.readFileSync(path.join(src, ".claude-plugin", "plugin.json"), "utf8"));
  fs.writeFileSync(path.join(dst, ".claude-plugin", "plugin.json"), JSON.stringify({ ...m, name: "paypal-server-sdk", skills: ["./skills/typescript"] }, null, 2));
  fs.cpSync(path.join(src, "skills", "typescript"), path.join(dst, "skills", "typescript"), { recursive: true });
  return dst;
}

export interface ClaudeRun { ok: boolean; result: string; costUsd?: number; turns?: number; durationS: number; skills: string[]; tools: Record<string, number>; transcript: string }

export async function runClaude(cwd: string, prompt: string, logDir: string, label: string, opts: { effort?: string; budgetUsd?: number } = {}): Promise<ClaudeRun> {
  mkdirp(logDir);
  fs.writeFileSync(path.join(logDir, `${label}-prompt.md`), prompt);
  const transcript = path.join(logDir, `${label}-transcript.jsonl`);
  const args = [
    "-p", prompt,
    "--model", MODEL, "--effort", opts.effort ?? "high",
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--strict-mcp-config",                       // no MCP servers: the model makes no PayPal calls
    "--plugin-dir", apimaticPluginDir(),
    "--no-session-persistence",
    "--max-budget-usd", String(opts.budgetUsd ?? 8),
    "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "TodoWrite",
    "Bash(npm install --ignore-scripts:*)", "Bash(npm ls:*)", "Bash(npm view:*)", "Bash(node --check:*)", "Bash(ls:*)",
    "WebFetch(domain:developer.paypal.com)", "WebFetch(domain:raw.githubusercontent.com)", "WebFetch(domain:github.com)",
    "--disallowedTools", `Read(/${path.join(ROOT, ".env")})`, `Read(/${path.join(OUT, "s1")}/**)`, "Bash(git:*)", "Bash(curl:*)",
  ];
  // The model's process gets no PayPal or other secrets from this CLI's environment, and no Anthropic API key: the
  // model runs on the signed-in Claude plan, never on API billing.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PAYPAL_|SECRET|TOKEN|PASSWORD|^ANTHROPIC_API_KEY$/i.test(k)));
  const t0 = Date.now();
  const out = fs.openSync(transcript, "w");
  const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let last = "";
  let stderr = "";
  child.stdout.on("data", (d) => { fs.writeSync(out, d); last += d.toString(); if (last.length > 200000) last = last.slice(-100000); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const code: number = await new Promise((r) => child.on("close", r));
  fs.closeSync(out);
  const lines = fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = lines.reverse().find((l: any) => l.type === "result") as any;
  const tools: Record<string, number> = {};
  const skills: string[] = [];
  for (const l of lines as any[]) for (const c of l?.message?.content ?? []) if (c.type === "tool_use") {
    tools[c.name] = (tools[c.name] ?? 0) + 1;
    if (c.name === "Skill") skills.push(c.input?.skill ?? c.input?.name ?? JSON.stringify(c.input));
  }
  return {
    ok: code === 0 && res && !res.is_error, result: res?.result ?? stderr.slice(-2000), costUsd: res?.total_cost_usd, turns: res?.num_turns,
    durationS: Math.round((Date.now() - t0) / 1000), skills: [...new Set(skills)], tools, transcript: path.relative(ROOT, transcript),
  };
}
