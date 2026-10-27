import { useEffect, useState } from "react";
import type { IndexData, TargetData } from "./types";
import { asset } from "./env";

const cache = new Map<string, Promise<unknown>>();
function load<T>(url: string): Promise<T> {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }));
  return cache.get(url) as Promise<T>;
}

export function useJson<T>(url: string | null): { data?: T; error?: string } {
  const [s, set] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    if (!url) return;
    let live = true;
    set({});
    load<T>(url).then((data) => live && set({ data }), (e) => live && set({ error: String(e.message || e) }));
    return () => { live = false; };
  }, [url]);
  return s;
}

export const useIndex = () => useJson<IndexData>(asset("data/index.json"));
export const useTarget = (slug: string) => useJson<TargetData>(asset(`data/${slug}.json`));

export { POPULATION } from "./population";
