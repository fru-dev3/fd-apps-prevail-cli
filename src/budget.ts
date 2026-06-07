// budget — a token/$ cost guard for AI turns.
//
// Two caps, both opt-in:
//
//   - per-run cap : the most a single process invocation may spend before it
//                   refuses further calls. Tracked in-memory for the life of
//                   the process.
//   - per-day cap : the most that may be spent across ALL runs in a calendar
//                   day. Persisted to a JSONL ledger so it survives process
//                   restarts (the whole point — a runaway loop relaunching the
//                   binary still hits the same daily wall).
//
// checkBudget() is called BEFORE a model call and throws a typed
// BudgetExceeded if the *estimated* cost of the turn would breach either cap.
// recordSpend() is called AFTER (or instead, with the same estimate) to commit
// the spend to the in-memory run total and append it to the daily ledger.
//
// Cost estimation reuses the same coarse per-call heuristic as
// src/council-cost.ts so the numbers the user sees in the council convening
// line and the numbers the budget enforces come from the same source of truth.
//
// Ledger location follows the SQLite/vault rule in VAULT-SPEC.md §4: the daily
// spend ledger is a LOCAL, rebuildable index — it lives under ~/.prevail, NOT
// in the synced vault. (A caller may opt to write it inside a vault's _log/
// instead by passing an explicit ledgerPath; that path goes through the
// manifest immutable-zone guard.)

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CliKind } from "./config.ts";
import { configDir } from "./config.ts";

// =============================================================================
// Cost heuristic — kept structurally parallel to src/council-cost.ts so the
// two never silently diverge. Local engines are free; cloud CLIs are priced
// per-call at a coarse default tuned for a few-KB-in / few-KB-out turn.
// =============================================================================

const PER_CALL_USD: Record<CliKind, number> = {
  claude: 0.005,
  codex: 0.004,
  antigravity: 0.003,
  ollama: 0,
  openrouter: 0.005,
};

const PER_CALL_USD_UNKNOWN = 0.005;

function perCallUsd(kind: CliKind): number {
  return kind in PER_CALL_USD ? PER_CALL_USD[kind] : PER_CALL_USD_UNKNOWN;
}

// ~4 chars per token is a decent cross-model rule of thumb (same constant
// chat-pane.tsx uses for the usage badge). Used only for the token half of
// the estimate; the dollar half comes from the per-call heuristic.
const CHARS_PER_TOKEN = 4;

export interface SpendEstimate {
  cli: CliKind;
  /** Rough estimated cost of this one turn, USD. */
  usd: number;
  /** Rough estimated total tokens (prompt + reply) for this turn. */
  tokens: number;
}

// Estimate the cost of a single turn. promptChars is the user prompt size;
// replyChars is an optional expected reply size (callers rarely know it up
// front, so it defaults to a typical few-KB reply for the token estimate).
export function estimateTurnCost(args: {
  cli: CliKind;
  promptChars: number;
  replyChars?: number;
}): SpendEstimate {
  const promptChars = Math.max(0, args.promptChars | 0);
  const replyChars = Math.max(0, (args.replyChars ?? 2000) | 0);
  const tokens = Math.round((promptChars + replyChars) / CHARS_PER_TOKEN);
  return { cli: args.cli, usd: perCallUsd(args.cli), tokens };
}

// =============================================================================
// Caps + typed error
// =============================================================================

export interface BudgetCaps {
  /** Max USD a single process invocation may spend. undefined = no cap. */
  perRunUsd?: number;
  /** Max USD across all runs in one calendar day. undefined = no cap. */
  perDayUsd?: number;
  /**
   * Override the daily-ledger path. Defaults to ~/.prevail/budget.jsonl.
   * When pointed inside a vault, callers should route through the manifest
   * immutable-zone guard themselves before passing it here.
   */
  ledgerPath?: string;
}

export class BudgetExceeded extends Error {
  readonly scope: "run" | "day";
  readonly capUsd: number;
  readonly wouldSpendUsd: number;
  readonly alreadySpentUsd: number;
  constructor(args: {
    scope: "run" | "day";
    capUsd: number;
    wouldSpendUsd: number;
    alreadySpentUsd: number;
  }) {
    const remaining = Math.max(0, args.capUsd - args.alreadySpentUsd);
    super(
      `budget exceeded: this turn (~$${args.wouldSpendUsd.toFixed(3)}) would ` +
        `breach the per-${args.scope} cap of $${args.capUsd.toFixed(2)} ` +
        `(already spent ~$${args.alreadySpentUsd.toFixed(3)} this ${args.scope}, ` +
        `~$${remaining.toFixed(3)} left).`,
    );
    this.name = "BudgetExceeded";
    this.scope = args.scope;
    this.capUsd = args.capUsd;
    this.wouldSpendUsd = args.wouldSpendUsd;
    this.alreadySpentUsd = args.alreadySpentUsd;
  }
}

// =============================================================================
// Per-run accounting — in-memory, process-lifetime.
// =============================================================================

let runSpendUsd = 0;

export function getRunSpendUsd(): number {
  return runSpendUsd;
}

/** Reset the in-memory per-run total. Exposed for tests and long-lived
 *  daemons that want to roll the "run" window without restarting. */
export function resetRunSpend(): void {
  runSpendUsd = 0;
}

// =============================================================================
// Per-day accounting — persisted JSONL ledger under ~/.prevail.
//
// One JSON object per line: { ts, day, cli, usd, tokens }. The daily total is
// derived by summing usd over every line whose `day` matches today. The file
// is append-only and rebuildable; losing it only resets the daily counter.
// =============================================================================

interface LedgerEntry {
  ts: number; // epoch ms
  day: string; // YYYY-MM-DD (local) — the calendar bucket
  cli: CliKind;
  usd: number;
  tokens: number;
}

export function defaultLedgerPath(): string {
  return join(configDir(), "budget.jsonl");
}

// Local calendar day key. Local (not UTC) so "per-day" matches the user's
// wall clock — a daily cap should reset at the user's midnight.
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Sum today's spend from the ledger. Missing/unreadable ledger => 0. Malformed
// lines are skipped (the ledger is best-effort and must never crash a turn).
export function getDaySpendUsd(ledgerPath?: string, ts: number = Date.now()): number {
  const file = ledgerPath ?? defaultLedgerPath();
  if (!existsSync(file)) return 0;
  const today = dayKey(ts);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as Partial<LedgerEntry>;
      if (e && e.day === today && typeof e.usd === "number" && Number.isFinite(e.usd)) {
        total += e.usd;
      }
    } catch {
      // malformed line — skip
    }
  }
  return total;
}

// =============================================================================
// Public guard API
// =============================================================================

export interface BudgetStatus {
  ok: boolean;
  runSpentUsd: number;
  daySpentUsd: number;
  estimate: SpendEstimate;
}

// Throw BudgetExceeded if committing `estimate` would breach either cap.
// No caps set => always passes (current behavior preserved for callers that
// don't opt in). Returns the status when it passes so callers can log it.
export function checkBudget(estimate: SpendEstimate, caps: BudgetCaps = {}): BudgetStatus {
  const daySpent = getDaySpendUsd(caps.ledgerPath);
  const runSpent = runSpendUsd;

  if (typeof caps.perRunUsd === "number" && Number.isFinite(caps.perRunUsd)) {
    if (runSpent + estimate.usd > caps.perRunUsd) {
      throw new BudgetExceeded({
        scope: "run",
        capUsd: caps.perRunUsd,
        wouldSpendUsd: estimate.usd,
        alreadySpentUsd: runSpent,
      });
    }
  }

  if (typeof caps.perDayUsd === "number" && Number.isFinite(caps.perDayUsd)) {
    if (daySpent + estimate.usd > caps.perDayUsd) {
      throw new BudgetExceeded({
        scope: "day",
        capUsd: caps.perDayUsd,
        wouldSpendUsd: estimate.usd,
        alreadySpentUsd: daySpent,
      });
    }
  }

  return { ok: true, runSpentUsd: runSpent, daySpentUsd: daySpent, estimate };
}

// Commit a spend: bump the in-memory run total and append a ledger line for
// the daily total. Ledger write failures are swallowed (never crash a turn
// over accounting) but the in-memory run total is always updated so a single
// run still self-limits even if the disk is read-only.
export function recordSpend(estimate: SpendEstimate, caps: BudgetCaps = {}): void {
  runSpendUsd += estimate.usd;
  if (estimate.usd <= 0) return; // free (local) turns add no ledger noise

  const file = caps.ledgerPath ?? defaultLedgerPath();
  const entry: LedgerEntry = {
    ts: Date.now(),
    day: dayKey(),
    cli: estimate.cli,
    usd: estimate.usd,
    tokens: estimate.tokens,
  };
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // best effort — run cap still enforced in-memory above
  }
}

// Convenience: estimate → check → (caller runs the turn) → recordSpend.
// Most callers want check-before / record-after, so this only does the
// pre-flight check and returns the estimate to hand to recordSpend later.
export function preflightTurn(
  args: { cli: CliKind; promptChars: number; replyChars?: number },
  caps: BudgetCaps = {},
): SpendEstimate {
  const est = estimateTurnCost(args);
  checkBudget(est, caps);
  return est;
}
