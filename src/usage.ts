// usage — token & shadow-cost accounting for AI turns (P4.7).
//
// Distinct from budget.ts: that module is a CAPS GUARD (a global, per-CLI,
// coarse `~/.prevail/budget.jsonl` used only to refuse a turn that would breach
// a daily/run cap). This module is ANALYTICS — a richer, vault-scoped,
// append-only ledger that records every turn with domain / model / session /
// surface and a per-MODEL shadow cost, so the desktop can answer "what is this
// costing me, and where" sliced by day / domain / model / session.
//
// On a CLI subscription nothing is billed per token, so est_cost_usd is a
// SHADOW number — "what this would cost at API list prices" — flagged with
// billed:false. Token counts are REPORTED when the CLI emits them, else
// ESTIMATED at ~4 chars/token (token_source records which).
//
// Ledger: <vault>/_meta/usage.jsonl, one UsageEntry per line, append-only and
// rebuildable. Lives in the vault (not ~/.prevail) because by-domain roll-ups
// are the whole point and domains are vault-scoped.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// =============================================================================
// Pricing — USD per million tokens, approximate public API list prices as a
// shadow-cost reference (rates as of 2026-06; update freely, this is data-only).
// Generalizes the flat per-call heuristic in council-cost.ts / budget.ts into
// real per-model input/output rates. Resolved by matching substrings of
// "<cli> <model>" (lowercased), first match wins; falls back to a vendor
// default, then a global default. Local engines are free.
// =============================================================================

export interface Rate {
  inUsdPerMtok: number;
  outUsdPerMtok: number;
}

interface PriceRule {
  match: string[]; // all-lowercase substrings; ANY hit selects this rule
  rate: Rate;
}

// Ordered: most specific first.
const PRICE_RULES: PriceRule[] = [
  // Anthropic
  { match: ["opus"], rate: { inUsdPerMtok: 15, outUsdPerMtok: 75 } },
  { match: ["haiku"], rate: { inUsdPerMtok: 1, outUsdPerMtok: 5 } },
  { match: ["sonnet"], rate: { inUsdPerMtok: 3, outUsdPerMtok: 15 } },
  // OpenAI / Codex
  { match: ["gpt-5", "gpt5", "codex", "o3", "o1"], rate: { inUsdPerMtok: 1.25, outUsdPerMtok: 10 } },
  { match: ["gpt-4o", "gpt-4"], rate: { inUsdPerMtok: 2.5, outUsdPerMtok: 10 } },
  // Google / Antigravity
  { match: ["flash"], rate: { inUsdPerMtok: 0.3, outUsdPerMtok: 2.5 } },
  { match: ["gemini", "antigravity", "agy", "pro"], rate: { inUsdPerMtok: 1.25, outUsdPerMtok: 5 } },
  // Local — free
  { match: ["ollama", "llama", "qwen", "mistral", "gpt-oss", "local"], rate: { inUsdPerMtok: 0, outUsdPerMtok: 0 } },
];

const VENDOR_DEFAULT: Record<string, Rate> = {
  claude: { inUsdPerMtok: 15, outUsdPerMtok: 75 },
  codex: { inUsdPerMtok: 1.25, outUsdPerMtok: 10 },
  antigravity: { inUsdPerMtok: 1.25, outUsdPerMtok: 5 },
  ollama: { inUsdPerMtok: 0, outUsdPerMtok: 0 },
};

const GLOBAL_DEFAULT: Rate = { inUsdPerMtok: 5, outUsdPerMtok: 15 };

export function rateFor(cli: string, model: string): Rate {
  const hay = `${cli} ${model}`.toLowerCase();
  for (const rule of PRICE_RULES) {
    if (rule.match.some((m) => hay.includes(m))) return rule.rate;
  }
  return VENDOR_DEFAULT[cli.toLowerCase()] ?? GLOBAL_DEFAULT;
}

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function costUsd(cli: string, model: string, inputTokens: number, outputTokens: number): number {
  const r = rateFor(cli, model);
  const usd = (inputTokens / 1e6) * r.inUsdPerMtok + (outputTokens / 1e6) * r.outUsdPerMtok;
  return Math.round(usd * 1e6) / 1e6; // 6 dp
}

// =============================================================================
// Ledger
// =============================================================================

export type TokenSource = "reported" | "estimated";
export type UsageSurface = "chat" | "council" | "benchmark" | "score" | "telegram" | "other";

export interface UsageEntry {
  ts: number;
  day: string; // YYYY-MM-DD local
  session: string;
  domain: string | null;
  surface: UsageSurface;
  cli: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  token_source: TokenSource;
  est_cost_usd: number;
  billed: boolean;
}

export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function usageLedgerPath(vaultPath: string): string {
  return join(resolve(vaultPath), "_meta", "usage.jsonl");
}

// What a caller hands in — tokens OR chars, plus the dimensions. Everything
// derived (day, cost) is computed here so every front-end stays consistent.
export interface RecordUsageInput {
  session: string;
  domain?: string | null;
  surface?: UsageSurface;
  cli: string;
  model?: string;
  // Provide reported token counts when the CLI emits them…
  inputTokens?: number;
  outputTokens?: number;
  // …or chars to estimate from (~4 chars/token).
  inputChars?: number;
  outputChars?: number;
  billed?: boolean;
  ts?: number;
}

export function buildEntry(input: RecordUsageInput): UsageEntry {
  const reported = input.inputTokens != null || input.outputTokens != null;
  const inTok = input.inputTokens ?? estimateTokens(" ".repeat(input.inputChars ?? 0));
  const outTok = input.outputTokens ?? estimateTokens(" ".repeat(input.outputChars ?? 0));
  const cli = input.cli;
  const model = input.model ?? "";
  const ts = input.ts ?? Date.now();
  return {
    ts,
    day: dayKey(ts),
    session: input.session,
    domain: input.domain ?? null,
    surface: input.surface ?? "other",
    cli,
    model,
    input_tokens: inTok,
    output_tokens: outTok,
    token_source: reported ? "reported" : "estimated",
    est_cost_usd: costUsd(cli, model, inTok, outTok),
    billed: input.billed ?? false,
  };
}

// Append a usage entry. Best-effort: never throws out to a caller (accounting
// must not crash a turn). Returns the entry that was written (or null on error).
export function recordUsage(vaultPath: string, input: RecordUsageInput): UsageEntry | null {
  const entry = buildEntry(input);
  const file = usageLedgerPath(vaultPath);
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
    return entry;
  } catch {
    return null;
  }
}

export function readUsage(vaultPath: string, sinceMs?: number): UsageEntry[] {
  const file = usageLedgerPath(vaultPath);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as UsageEntry;
      if (typeof e.ts !== "number") continue;
      if (sinceMs != null && e.ts < sinceMs) continue;
      out.push(e);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// =============================================================================
// Aggregation
// =============================================================================

export type UsageDimension = "day" | "domain" | "model" | "session" | "cli" | "surface";

export interface UsageBucket {
  key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
  billed_cost_usd: number; // subset where billed===true
}

export interface UsageReport {
  by: UsageDimension;
  since: number | null;
  total: UsageBucket; // key="__total__"
  buckets: UsageBucket[]; // sorted by est_cost_usd desc (day: chronological)
}

function bucketKey(e: UsageEntry, by: UsageDimension): string {
  switch (by) {
    case "day": return e.day;
    case "domain": return e.domain ?? "(none)";
    case "model": return e.model ? `${e.cli}:${e.model}` : e.cli;
    case "session": return e.session;
    case "cli": return e.cli;
    case "surface": return e.surface;
  }
}

// Scope a set of entries to a single domain before aggregating — powers the
// per-domain Usage tab. `domain` matches `e.domain` case-insensitively; the
// sentinels none/general/(none)/__general__ all select the unscoped (null)
// bucket so "General" usage is addressable too.
export function filterByDomain(entries: UsageEntry[], domain: string): UsageEntry[] {
  const want = domain.trim().toLowerCase();
  const isNone = want === "(none)" || want === "none" || want === "general" || want === "__general__";
  return entries.filter((e) =>
    isNone ? e.domain == null : (e.domain ?? "").toLowerCase() === want,
  );
}

export function aggregateUsage(entries: UsageEntry[], by: UsageDimension, sinceMs?: number): UsageReport {
  const map = new Map<string, UsageBucket>();
  const total: UsageBucket = { key: "__total__", calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0, billed_cost_usd: 0 };
  for (const e of entries) {
    const k = bucketKey(e, by);
    let b = map.get(k);
    if (!b) { b = { key: k, calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0, billed_cost_usd: 0 }; map.set(k, b); }
    b.calls += 1; total.calls += 1;
    b.input_tokens += e.input_tokens; total.input_tokens += e.input_tokens;
    b.output_tokens += e.output_tokens; total.output_tokens += e.output_tokens;
    b.est_cost_usd += e.est_cost_usd; total.est_cost_usd += e.est_cost_usd;
    if (e.billed) { b.billed_cost_usd += e.est_cost_usd; total.billed_cost_usd += e.est_cost_usd; }
  }
  const round = (b: UsageBucket): UsageBucket => ({
    ...b,
    est_cost_usd: Math.round(b.est_cost_usd * 1e6) / 1e6,
    billed_cost_usd: Math.round(b.billed_cost_usd * 1e6) / 1e6,
  });
  const buckets = Array.from(map.values()).map(round);
  if (by === "day") buckets.sort((a, b) => a.key.localeCompare(b.key));
  else buckets.sort((a, b) => b.est_cost_usd - a.est_cost_usd);
  return { by, since: sinceMs ?? null, total: round(total), buckets };
}

// Parse a relative --since like "7d", "24h", "30m", or an ISO date / epoch ms.
export function parseSince(s: string | undefined, now: number = Date.now()): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d+)\s*([dhm])$/i);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    const ms = unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000;
    return now - n * ms;
  }
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 1e10) return asNum; // epoch ms
  const asDate = Date.parse(s);
  return Number.isFinite(asDate) ? asDate : null;
}
