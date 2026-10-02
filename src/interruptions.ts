// The interruption budget: Prevail speaks up on its own at most three times a
// week (the user's choice), and only for what deserves it. Everything else,
// and anything over the budget, waits for the weekly review. The daily Today
// card and the weekly review are briefs the user asked for, not
// interruptions. Every proactive message goes through tryInterrupt.
//
// Ledger: build/_meta/interruptions.jsonl, one line per attempt
// { ts, kind, text, key?, sent: bool }.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePath } from "./path-safety.ts";
import { weekOf, dayOf } from "./metrics.ts";

export const INTERRUPTION_BUDGET = 3;
// What may interrupt at all (goals-plan "quiet by default"; today-plan radar).
export const INTERRUPT_KINDS = ["non-negotiable", "conflict", "path-miss", "stalled-goal", "fresh-start", "overdue-promise", "broken-capture"] as const;
export type InterruptKind = (typeof INTERRUPT_KINDS)[number];

export interface Interruption { ts: number; kind: string; text: string; key?: string; sent: boolean }

const ledger = (vault: string) => join(runtimePath(vault, "_meta"), "interruptions.jsonl");

export function readInterruptions(vault: string): Interruption[] {
  const p = ledger(vault);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as Interruption] : []; } catch { return []; } });
}

export function usedThisWeek(vault: string, now = Date.now()): number {
  const w = weekOf(dayOf(now));
  return readInterruptions(vault).filter((r) => r.sent && weekOf(dayOf(r.ts)) === w).length;
}

/**
 * Ask to interrupt. Allowed only for a kind that may interrupt, once per key
 * per week, and while this week's budget lasts; otherwise it is queued for the
 * weekly review. The caller sends only when ok is true.
 */
export function tryInterrupt(vault: string, i: { kind: string; text: string; key?: string }, now = Date.now()): { ok: boolean; used: number; budget: number; why?: string } {
  const w = weekOf(dayOf(now));
  const rows = readInterruptions(vault);
  const used = rows.filter((r) => r.sent && weekOf(dayOf(r.ts)) === w).length;
  let why: string | undefined;
  if (!(INTERRUPT_KINDS as readonly string[]).includes(i.kind)) why = "this kind waits for the weekly review";
  else if (i.key && rows.some((r) => r.key === i.key && weekOf(dayOf(r.ts)) === w)) why = "already raised this week";
  else if (used >= INTERRUPTION_BUDGET) why = `this week's ${INTERRUPTION_BUDGET} interruptions are used`;
  const ok = !why;
  mkdirSync(runtimePath(vault, "_meta"), { recursive: true });
  appendFileSync(ledger(vault), `${JSON.stringify({ ts: now, kind: i.kind, text: i.text.slice(0, 300), ...(i.key ? { key: i.key } : {}), sent: ok })}\n`);
  return { ok, used: used + (ok ? 1 : 0), budget: INTERRUPTION_BUDGET, ...(why ? { why } : {}) };
}

/** What waited for the review this week (queued, not sent). */
export function waitedForReview(vault: string, week: string): Interruption[] {
  const seen = new Set<string>();
  return readInterruptions(vault).filter((r) => !r.sent && weekOf(dayOf(r.ts)) === week).filter((r) => { const k = r.key ?? r.text; if (seen.has(k)) return false; seen.add(k); return true; });
}
