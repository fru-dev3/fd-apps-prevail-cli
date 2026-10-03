// A specialist's part in conversations and jobs (owner feedback round 1,
// 2026-10-02): who, what it did (answered, researched, planned, drafted,
// checked, filed), when, and where (the thread or the job). One line per
// event, per machine, so two Macs never write the same file:
//   build/_meta/specialists/involvement.<host>.jsonl
//     { ts, specialist, name, method, domain, thread?, job?, ask? }
// The specialist's page lists the conversations it took part in; its own
// chat reads the last few as context.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { runtimePath } from "./path-safety.ts";

export type Method = "answered" | "researched" | "planned" | "drafted" | "checked" | "filed" | "worked";
export interface Involvement { ts: number; specialist: string; name: string; method: Method; domain: string; thread?: string; job?: string; ask?: string }

const dir = (vault: string) => runtimePath(vault, join("_meta", "specialists"));
const host = () => hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "host";

/** What a step that returns this kind of result did, in one verb. */
export function methodFor(returns: string): Method {
  if (/^(findings|discoveries|numbers|lessons?)$/.test(returns)) return "researched";
  if (/^(plan|strategy)$/.test(returns)) return "planned";
  if (/^(draft|page|nudges|reflection)$/.test(returns)) return "drafted";
  if (/^(verdict|audit|check)$/.test(returns)) return "checked";
  return "worked";
}

export function noteInvolvement(vault: string, row: Omit<Involvement, "ts"> & { ts?: number }): void {
  try {
    mkdirSync(dir(vault), { recursive: true });
    const r: Involvement = { ts: row.ts ?? Date.now(), specialist: row.specialist, name: row.name, method: row.method, domain: row.domain, ...(row.thread ? { thread: row.thread } : {}), ...(row.job ? { job: row.job } : {}), ...(row.ask ? { ask: row.ask.replace(/\s+/g, " ").trim().slice(0, 160) } : {}) };
    appendFileSync(join(dir(vault), `involvement.${host()}.jsonl`), `${JSON.stringify(r)}\n`);
  } catch { /* a record of involvement never blocks the work */ }
}

/** Newest first, from every machine; one specialist or all. */
export function readInvolvement(vault: string, specialist?: string, limit = 50): Involvement[] {
  const d = dir(vault);
  if (!existsSync(d)) return [];
  const out: Involvement[] = [];
  for (const f of readdirSync(d).filter((x) => /^involvement\..+\.jsonl$/.test(x))) {
    for (const l of readFileSync(join(d, f), "utf8").split("\n")) {
      try { const r = JSON.parse(l) as Involvement; if (r && r.specialist && (!specialist || r.specialist === specialist)) out.push(r); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
