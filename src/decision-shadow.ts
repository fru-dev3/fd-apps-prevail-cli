// Shadow-mode ledger for the decision layer.
//
// While the decision layer is in shadow it changes nothing. It answers the
// same question Prevail just answered for itself, and we write down both
// answers so the two can be compared over real traffic before anyone lets the
// new one drive.
//
// What is worth recording is not just "did they agree". It is whether the
// cheap path would have been cheap enough and fast enough to be worth
// switching to, so every row carries the latency and cost of BOTH sides.
//
// Follows the conventions of route-learning.ts: one JSONL under
// <vault>/build/_meta, written through vault-session so it inherits vault
// encryption, rotated by size, and best-effort throughout. A failed write
// must never disturb the turn that produced it.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimePath } from "./path-safety.ts";
import { vappendLine, vreadFile, vrotateLedgerPrefix } from "./vault-session.ts";

const MAX_BYTES = 400_000;
const KEEP_TAIL_BYTES = 160_000;

/** Which decision the layer was shadowing. */
export type ShadowSurface = "auto-council";

export interface DecisionShadowEntry {
  ts: number;
  /** YYYY-MM-DD local, so a day can be summarized without parsing timestamps. */
  day: string;
  surface: ShadowSurface;
  domain: string | null;
  /** Decision provider id, e.g. "jev". Null when it was skipped. */
  provider: string | null;
  /** Concrete model that answered, when one did. */
  model: string | null;

  /** What Prevail actually did. This is what the user experienced. */
  actual: string;
  /** What the decision layer would have done. Null when it produced nothing. */
  proposed: string | null;
  /** Did the two agree? Null when there was nothing to compare. */
  agreed: boolean | null;
  /** How sure the decision layer was, 0..1, when it said anything. */
  confidence: number | null;

  /** Round trip for the decision call. */
  decision_ms: number | null;
  /** Estimated USD for the decision call. */
  decision_usd: number | null;
  /** Round trip for the expensive path Prevail actually took. */
  baseline_ms: number | null;
  /** Estimated USD for that expensive path, when it is known. */
  baseline_usd: number | null;

  /** Why no decision was made. Null when one was. */
  skipped: string | null;
}

export function decisionShadowFile(vaultRoot: string): string {
  return join(runtimePath(resolve(vaultRoot), "_meta"), "decision-shadow.jsonl");
}

/**
 * Append one comparison. Best effort in every direction: a missing vault, an
 * unwritable directory or a full disk all end with the row dropped and the
 * caller none the wiser.
 */
export function recordDecisionShadow(
  vaultRoot: string,
  rec: Omit<DecisionShadowEntry, "ts" | "day" | "agreed"> & { ts?: number },
): DecisionShadowEntry | null {
  try {
    if (!vaultRoot) return null;
    const ts = rec.ts ?? Date.now();
    const entry: DecisionShadowEntry = {
      ...rec,
      ts,
      day: localDay(ts),
      // Derived rather than passed, so a caller cannot record an agreement
      // that the two recorded values do not actually show.
      agreed: rec.proposed === null ? null : rec.proposed === rec.actual,
    };
    const dir = runtimePath(resolve(vaultRoot), "_meta");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = decisionShadowFile(vaultRoot);
    vappendLine(file, JSON.stringify(entry) + "\n");
    try {
      if (statSync(file).size > MAX_BYTES) {
        vrotateLedgerPrefix(file, join(dir, "decision-shadow.archive.jsonl"), MAX_BYTES, KEEP_TAIL_BYTES);
      }
    } catch { /* rotation is best-effort */ }
    return entry;
  } catch {
    return null;
  }
}

/** Read every row. Missing file gives []; malformed lines are skipped. */
export function readDecisionShadow(vaultRoot: string): DecisionShadowEntry[] {
  try {
    const file = decisionShadowFile(vaultRoot);
    if (!existsSync(file)) return [];
    const out: DecisionShadowEntry[] = [];
    for (const line of vreadFile(file).split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as DecisionShadowEntry;
        if (typeof e.ts === "number" && typeof e.actual === "string") out.push(e);
      } catch { /* skip a torn line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ShadowSummary {
  /** Rows where the decision layer actually answered. */
  compared: number;
  /** Rows where it was skipped, and why, most common first. */
  skipped: number;
  skipReasons: { reason: string; count: number }[];
  /** Of the compared rows, how many matched what Prevail did. */
  agreed: number;
  agreementRate: number | null;
  /** Where they differed, what the layer wanted instead. */
  disagreements: { actual: string; proposed: string; count: number }[];
  /** Latency, milliseconds. */
  decisionMsP50: number | null;
  decisionMsP95: number | null;
  baselineMsP50: number | null;
  /** Money. */
  decisionSpendUsd: number;
  baselineSpendUsd: number;
  /**
   * What switching would plausibly have saved: the expensive calls that the
   * decision layer would have avoided, minus what the decision calls cost.
   * Only counts rows where the layer was confident enough to have acted and
   * chose the cheaper branch.
   */
  estimatedSavingsUsd: number;
}

export function summarizeDecisionShadow(entries: DecisionShadowEntry[]): ShadowSummary {
  const compared = entries.filter((e) => e.proposed !== null);
  const skipped = entries.filter((e) => e.proposed === null);

  const reasons = new Map<string, number>();
  for (const e of skipped) {
    const r = e.skipped ?? "unknown";
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  const diffs = new Map<string, { actual: string; proposed: string; count: number }>();
  for (const e of compared) {
    if (e.agreed) continue;
    const k = `${e.actual}->${e.proposed}`;
    const cur = diffs.get(k) ?? { actual: e.actual, proposed: e.proposed!, count: 0 };
    cur.count++;
    diffs.set(k, cur);
  }

  const decisionSpend = sum(entries.map((e) => e.decision_usd ?? 0));
  const baselineSpend = sum(entries.map((e) => e.baseline_usd ?? 0));

  // Savings are only claimed where the layer would have taken the cheaper
  // branch. Proposing the MORE expensive branch is not a saving, and counting
  // it as one is how a shadow report talks itself into a bad switch.
  const avoided = compared.filter((e) => !e.agreed && isCheaper(e.proposed!, e.actual));
  const estimatedSavingsUsd = sum(avoided.map((e) => e.baseline_usd ?? 0)) - decisionSpend;

  const agreed = compared.filter((e) => e.agreed).length;
  return {
    compared: compared.length,
    skipped: skipped.length,
    skipReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    agreed,
    agreementRate: compared.length === 0 ? null : agreed / compared.length,
    disagreements: [...diffs.values()].sort((a, b) => b.count - a.count),
    decisionMsP50: pct(compared.map((e) => e.decision_ms).filter(isNum), 0.5),
    decisionMsP95: pct(compared.map((e) => e.decision_ms).filter(isNum), 0.95),
    baselineMsP50: pct(entries.map((e) => e.baseline_ms).filter(isNum), 0.5),
    decisionSpendUsd: round6(decisionSpend),
    baselineSpendUsd: round6(baselineSpend),
    estimatedSavingsUsd: round6(estimatedSavingsUsd),
  };
}

/** Cost order of the routing branches, cheapest first. */
const BRANCH_COST = ["single", "more-context", "council", "agent"];

function isCheaper(proposed: string, actual: string): boolean {
  const p = BRANCH_COST.indexOf(proposed);
  const a = BRANCH_COST.indexOf(actual);
  if (p < 0 || a < 0) return false;
  return p < a;
}

const isNum = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function pct(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i]!;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
