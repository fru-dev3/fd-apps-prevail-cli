// "Waiting for you": one list of everything the engine is holding for the
// user, so the desktop can poll a single source for thread badges, domain
// counts and the Home count. Same sources the desktop's Needs you inbox
// (decisioninbox.tsx + tasks.rs decisions_pending) reads:
//   act   connector writes held by the act gate      <vault>/_meta/pending_acts.json
//   gws   Google Workspace writes awaiting approval  <vault>/_meta/pending_gws.json (runtime _meta)
//   loop  loop actions needing approval              <domain>/_loops_runtime.json `pending`
//   task  tasks the AI paused (blocked) or finished and wants signed off (review)
// Read-only and best effort: an unreadable source contributes nothing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPendingActs } from "./act-gate.ts";
import { readPendingGws } from "./gws-gateway.ts";
import { generalDir } from "./decisions.ts";
import { effectiveStatus, readTasks } from "./tasks.ts";
import { scanVault } from "./vault.ts";
import { vreadFile } from "./vault-session.ts";

export interface WaitingItem {
  kind: "act" | "gws" | "loop" | "task";
  id: string;
  domain: string;
  summary: string;
  since: number;
  thread?: string;
}

export interface WaitingReport {
  total: number;
  items: WaitingItem[];
}

function domainTargets(vault: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ name, path });
  };
  try { for (const d of scanVault(vault)) add(d.name, d.path); } catch { /* no domains */ }
  add("general", generalDir(vault));
  return out;
}

function loopItems(domain: string, dir: string): WaitingItem[] {
  const f = join(dir, "_loops_runtime.json");
  if (!existsSync(f)) return [];
  try {
    const doc = JSON.parse(vreadFile(f)) as { loops?: Record<string, { pending?: { text?: string; ts?: number }[] }> };
    const out: WaitingItem[] = [];
    for (const [loopId, entry] of Object.entries(doc.loops ?? {})) {
      (entry?.pending ?? []).forEach((p, idx) => {
        const text = (p?.text ?? "").trim();
        if (!text) return;
        // Same id shape as the desktop's decisions_pending, so both agree.
        out.push({ kind: "loop", id: `${domain}:${loopId}:${idx}`, domain, summary: text, since: typeof p.ts === "number" ? p.ts : 0 });
      });
    }
    return out;
  } catch {
    return [];
  }
}

function taskItems(domain: string, dir: string): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const t of readTasks(dir)) {
    if (t.trashed) continue;
    const st = effectiveStatus(t);
    if (st !== "blocked" && st !== "review") continue;
    const since = t.added ? Date.parse(`${t.added}T00:00:00Z`) || 0 : 0;
    out.push({ kind: "task", id: `task:${t.id ?? ""}`, domain, summary: t.text, since });
  }
  return out;
}

/** Everything waiting on the user, newest first. */
export function collectWaiting(vault: string): WaitingReport {
  const items: WaitingItem[] = [];
  try {
    for (const a of readPendingActs(vault)) {
      items.push({ kind: "act", id: a.id, domain: a.domain, summary: a.summary, since: a.ts ?? 0, ...(a.thread ? { thread: a.thread } : {}) });
    }
  } catch { /* no act queue */ }
  try {
    for (const g of readPendingGws(vault)) {
      items.push({ kind: "gws", id: g.id, domain: g.domain, summary: g.summary, since: g.ts ?? 0, ...(g.thread ? { thread: g.thread } : {}) });
    }
  } catch { /* no gws queue */ }
  for (const d of domainTargets(vault)) {
    items.push(...loopItems(d.name, d.path));
    items.push(...taskItems(d.name, d.path));
  }
  items.sort((a, b) => b.since - a.since);
  return { total: items.length, items };
}
