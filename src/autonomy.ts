// autonomy.ts — the global "brake" for autonomous agent action.
//
// Two controls, both stored in <vault>/_meta/autonomy.json:
//   1. STATE: "active" | "paused". A one-tap kill switch. When paused, the
//      orchestrator, loop daemon, and approved-action executor all refuse to
//      act (in-flight runs are killed separately via abort_sessions).
//   2. POLICY: a per-ActionClass map of allow | ask | never. The user's
//      pre-emptive rules ("never spend money", "always ask before sending").
//      Consulted by the broker BEFORE anything runs.
//
// Everything is read fresh each call (no caching) so a pause/policy change
// takes effect immediately for the next gated action.

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { vreadFile, vwriteFile, vappendLine } from "./vault-session.ts";
import type { ActionClass } from "./action-policy.ts";

export type AutonomyState = "active" | "paused";
export type PolicyDecision = "allow" | "ask" | "never";

// Safe-by-default policy: reads/reversible edits are fine; anything that leaves
// the vault or spends money asks first; destructive/credential changes are
// forbidden until the user explicitly opts in. `unknown` errs to "ask".
export const DEFAULT_POLICY: Record<ActionClass, PolicyDecision> = {
  read: "allow",
  reversible: "allow",
  external_send: "ask",
  financial: "ask",
  irreversible: "never",
  credential: "never",
  unknown: "ask",
};

interface AutonomyDoc {
  schema: 1;
  state: AutonomyState;
  policy: Partial<Record<ActionClass, PolicyDecision>>;
  // Optional monthly cap (USD) the broker enforces on `financial` actions.
  monthlyFinancialCapUsd?: number | null;
  updatedTs?: number;
}

function autonomyPath(vault: string): string {
  return join(vault, "_meta", "autonomy.json");
}

function read(vault: string): AutonomyDoc {
  try {
    const p = autonomyPath(vault);
    if (existsSync(p)) {
      const d = JSON.parse(vreadFile(p)) as Partial<AutonomyDoc>;
      return {
        schema: 1,
        state: d.state === "paused" ? "paused" : "active",
        policy: (d.policy && typeof d.policy === "object" ? d.policy : {}) as AutonomyDoc["policy"],
        monthlyFinancialCapUsd: typeof d.monthlyFinancialCapUsd === "number" ? d.monthlyFinancialCapUsd : null,
      };
    }
  } catch { /* fall through to default */ }
  return { schema: 1, state: "active", policy: {}, monthlyFinancialCapUsd: null };
}

function write(vault: string, doc: AutonomyDoc): void {
  const dir = join(vault, "_meta");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  vwriteFile(autonomyPath(vault), `${JSON.stringify({ ...doc, schema: 1, updatedTs: Date.now() }, null, 2)}\n`);
}

export function getAutonomyState(vault: string): AutonomyState {
  return read(vault).state;
}

export function setAutonomyState(vault: string, state: AutonomyState): void {
  const doc = read(vault);
  doc.state = state;
  write(vault, doc);
}

export function isPaused(vault: string): boolean {
  return getAutonomyState(vault) === "paused";
}

// The full effective policy (defaults merged with the user's overrides).
export function getActionPolicy(vault: string): Record<ActionClass, PolicyDecision> {
  return { ...DEFAULT_POLICY, ...read(vault).policy };
}

export function policyFor(vault: string, cls: ActionClass): PolicyDecision {
  return getActionPolicy(vault)[cls] ?? DEFAULT_POLICY[cls] ?? "ask";
}

export function setPolicyFor(vault: string, cls: ActionClass, decision: PolicyDecision): void {
  const doc = read(vault);
  doc.policy = { ...doc.policy, [cls]: decision };
  write(vault, doc);
}

export function getMonthlyFinancialCap(vault: string): number | null {
  return read(vault).monthlyFinancialCapUsd ?? null;
}

export function setMonthlyFinancialCap(vault: string, capUsd: number | null): void {
  const doc = read(vault);
  doc.monthlyFinancialCapUsd = capUsd;
  write(vault, doc);
}

// Spend ledger — records each executed financial action's amount so the broker
// can enforce the monthly cap. Append-only at <vault>/_meta/spend.jsonl.
function spendPath(vault: string): string {
  return join(vault, "_meta", "spend.jsonl");
}

export function recordSpend(vault: string, amountUsd: number, ts: number = Date.now()): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  try {
    const dir = join(vault, "_meta");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    vappendLine(spendPath(vault), JSON.stringify({ ts, amountUsd }));
  } catch { /* best effort */ }
}

// Total executed financial spend for the calendar month containing `nowMs`.
export function monthSpendUsd(vault: string, nowMs: number = Date.now()): number {
  try {
    const p = spendPath(vault);
    if (!existsSync(p)) return 0;
    const now = new Date(nowMs);
    const y = now.getFullYear();
    const m = now.getMonth();
    let sum = 0;
    for (const line of vreadFile(p).split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts: number; amountUsd: number };
        const d = new Date(e.ts);
        if (d.getFullYear() === y && d.getMonth() === m && Number.isFinite(e.amountUsd)) sum += e.amountUsd;
      } catch { /* skip bad line */ }
    }
    return sum;
  } catch { return 0; }
}
