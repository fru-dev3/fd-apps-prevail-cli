// Model pricing + token estimation for the 3D Arena (intelligence · speed ·
// cost). We don't get exact token usage back from every CLI, so cost is an
// ESTIMATE derived from character counts (about 4 chars/token) times published
// per-million-token rates. Local / open-source models run on the user's own
// hardware, so their marginal token cost is $0 - that asymmetry is the whole
// point of the cost dimension (a local 70B can be "free" but slow; a frontier
// model is fast and sharp but metered).
//
// Rates are USD per 1,000,000 tokens, matched by loose substring on the model
// id. Keep this list short and current; an unmatched frontier model returns
// null (we show "-" rather than a wrong number).

export interface ModelPrice {
  inUsd: number; // $/1M input tokens
  outUsd: number; // $/1M output tokens
  source: "frontier" | "local";
}

// CLI kinds that run models locally - token cost is $0 regardless of model.
const LOCAL_CLIS = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "llama",
  "localai",
  "mlx",
  "local",
  "jan",
  "gpt4all",
]);

// Substring → rate. First match wins, so order most-specific first.
const RATES: Array<{ match: RegExp; inUsd: number; outUsd: number }> = [
  // Anthropic (refreshed 2026-09-11). Fable is the frontier tier; Opus 5 is
  // $5/$25, a third of the Opus 4.x price this table used to carry.
  { match: /fable|mythos/i, inUsd: 10, outUsd: 50 },
  // Opus 5.5 (2026-09-22) is priced below Opus 5; must precede the generic rule.
  // The bare "opus" alias runs the current release, so it takes the same rate.
  { match: /opus-5[.-]5|^opus(@|$)/i, inUsd: 4, outUsd: 20 },
  { match: /opus/i, inUsd: 5, outUsd: 25 },
  { match: /sonnet/i, inUsd: 2, outUsd: 10 },
  { match: /haiku/i, inUsd: 1, outUsd: 5 },
  // OpenAI
  { match: /gpt-4o-mini|4o-mini|o4-mini|o3-mini/i, inUsd: 0.15, outUsd: 0.6 },
  { match: /gpt-4o|gpt-4\.1|chatgpt/i, inUsd: 2.5, outUsd: 10 },
  { match: /\bo1\b|\bo3\b|\bo4\b/i, inUsd: 15, outUsd: 60 },
  { match: /gpt-4/i, inUsd: 10, outUsd: 30 },
  { match: /gpt-3\.5/i, inUsd: 0.5, outUsd: 1.5 },
  // GPT-6 tiers (OpenRouter rates, 2026-09-25). Sol and Luna must precede the
  // Astra rule, which catches bare "gpt-6" (first match wins).
  { match: /gpt-6-luna/i, inUsd: 0.1, outUsd: 0.5 },
  { match: /gpt-6-sol/i, inUsd: 2, outUsd: 10 },
  { match: /gpt-6|astra/i, inUsd: 10, outUsd: 50 },
  // GPT-5.6 family (Sol flagship / Terra balanced / Luna fast). Tier-specific
  // rates must come BEFORE the generic gpt-5 rule below (first match wins). Bare
  // "gpt-5.6" routes to Sol. Re-checked against OpenRouter on 2026-09-11: all
  // three tiers came down since the July rates this table carried.
  { match: /gpt-5\.6-luna/i, inUsd: 0.2, outUsd: 1.2 },
  { match: /gpt-5\.6-terra/i, inUsd: 2, outUsd: 12 },
  { match: /gpt-5\.6(-sol)?/i, inUsd: 2, outUsd: 10 },
  { match: /gpt-5|gpt5/i, inUsd: 1.25, outUsd: 10 },
  // Google — the 3.x Flash generations are priced well above the old 2.x Flash.
  { match: /gemini.*3\.\d.*flash|gemini-3.*flash/i, inUsd: 0.75, outUsd: 3.75 },
  { match: /gemini.*flash/i, inUsd: 0.075, outUsd: 0.3 },
  { match: /gemini.*pro|gemini-2|gemini-1\.5/i, inUsd: 1.25, outUsd: 5 },
  { match: /gemini/i, inUsd: 1.25, outUsd: 5 },
  // xAI
  { match: /grok-4\.7/i, inUsd: 1.6, outUsd: 4.8 },
  { match: /grok/i, inUsd: 2, outUsd: 6 },
  // DeepSeek (hosted)
  { match: /deepseek/i, inUsd: 0.27, outUsd: 1.1 },
  // Mistral (hosted)
  { match: /mistral-large/i, inUsd: 2, outUsd: 6 },
  { match: /mistral/i, inUsd: 0.4, outUsd: 2 },
  // Open / hosted-open families (common via OpenRouter and others). Approximate
  // published rates; matched on the family substring so the "vendor/" prefix in
  // an OpenRouter id (e.g. "z-ai/glm-5.2") doesn't matter.
  { match: /glm-5\.3-prime/i, inUsd: 2.8, outUsd: 8.8 },
  { match: /\bglm\b|zhipu/i, inUsd: 0.6, outUsd: 2.2 },
  { match: /\bkimi\b|moonshot/i, inUsd: 0.6, outUsd: 2.5 },
  { match: /qwen3\.8-max-prime/i, inUsd: 4, outUsd: 12 },
  { match: /qwen/i, inUsd: 0.4, outUsd: 1.2 },
  { match: /\byi-/i, inUsd: 0.3, outUsd: 0.3 },
  { match: /llama/i, inUsd: 0.2, outUsd: 0.6 },
];

export function isLocalCliKind(cli: string | undefined | null): boolean {
  if (!cli) return false;
  return LOCAL_CLIS.has(cli.toLowerCase());
}

// Returns the per-token price for a (cli, model) pair, or null when we can't
// confidently price it. Local CLIs are always free.
export function priceFor(cli: string | undefined | null, model: string | undefined | null): ModelPrice | null {
  if (isLocalCliKind(cli)) return { inUsd: 0, outUsd: 0, source: "local" };
  const m = model ?? "";
  for (const r of RATES) {
    if (r.match.test(m)) return { inUsd: r.inUsd, outUsd: r.outUsd, source: "frontier" };
  }
  return null;
}

// Vendor defaults for when a call names a CLI but no (or an unrecognised)
// model: the rate of each CLI's default tier. Used by the shadow-cost ledger
// (usage.ts) and the council / budget heuristics, which must always return a
// number. Direct-provider kinds (anthropic, openai, ...) map to the same tiers.
const VENDOR_DEFAULT: Record<string, { inUsd: number; outUsd: number }> = {
  claude: { inUsd: 4, outUsd: 20 }, // Opus 5.5
  anthropic: { inUsd: 4, outUsd: 20 },
  codex: { inUsd: 2, outUsd: 10 }, // GPT-6 Sol, the Codex default
  openai: { inUsd: 2, outUsd: 10 },
  antigravity: { inUsd: 1.25, outUsd: 5 }, // Gemini Pro tier
  gemini: { inUsd: 1.25, outUsd: 5 },
  google: { inUsd: 1.25, outUsd: 5 },
  xai: { inUsd: 1.6, outUsd: 4.8 }, // Grok 4.7
  kimi: { inUsd: 0.6, outUsd: 2.5 },
  deepseek: { inUsd: 0.27, outUsd: 1.1 },
};

// Conservative catch-all for a CLI kind we have never priced: better to
// over-warn than to under-warn on a budget cap.
const GLOBAL_DEFAULT = { inUsd: 5, outUsd: 15 };

// Like priceFor, but never null: falls back to the vendor default, then the
// global default. Local CLIs stay free.
export function priceForOrDefault(cli: string | undefined | null, model: string | undefined | null): ModelPrice {
  const exact = priceFor(cli, model);
  if (exact) return exact;
  const vendor = VENDOR_DEFAULT[(cli ?? "").toLowerCase()] ?? GLOBAL_DEFAULT;
  return { inUsd: vendor.inUsd, outUsd: vendor.outUsd, source: "frontier" };
}

// Assumed size of one "typical" call for the coarse per-call heuristics
// (council convening line, budget caps): a few KB of prompt in, a shorter
// reply out. The dollar figure is rates times these counts.
export const ASSUMED_CALL_INPUT_TOKENS = 1000;
export const ASSUMED_CALL_OUTPUT_TOKENS = 500;

// Rough USD for one typical call on (cli, model). Always a number; $0 for
// local engines.
export function estimatePerCallUsd(cli: string | undefined | null, model: string | undefined | null): number {
  const price = priceForOrDefault(cli, model);
  return (
    (ASSUMED_CALL_INPUT_TOKENS / 1_000_000) * price.inUsd +
    (ASSUMED_CALL_OUTPUT_TOKENS / 1_000_000) * price.outUsd
  );
}

// Rough token estimate from a character count (about 4 chars/token English).
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

// Estimated USD cost of one request, given prompt + reply character counts.
// Returns null when the model isn't priced (so the UI shows "-").
export function estimateCostUsd(
  cli: string | undefined | null,
  model: string | undefined | null,
  promptChars: number,
  replyChars: number,
): number | null {
  const price = priceFor(cli, model);
  if (!price) return null;
  const inTok = estimateTokens(promptChars);
  const outTok = estimateTokens(replyChars);
  return (inTok / 1_000_000) * price.inUsd + (outTok / 1_000_000) * price.outUsd;
}
