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
  // Anthropic
  { match: /opus/i, inUsd: 15, outUsd: 75 },
  { match: /sonnet/i, inUsd: 3, outUsd: 15 },
  { match: /haiku/i, inUsd: 0.8, outUsd: 4 },
  // OpenAI
  { match: /gpt-4o-mini|4o-mini|o4-mini|o3-mini/i, inUsd: 0.15, outUsd: 0.6 },
  { match: /gpt-4o|gpt-4\.1|chatgpt/i, inUsd: 2.5, outUsd: 10 },
  { match: /\bo1\b|\bo3\b|\bo4\b/i, inUsd: 15, outUsd: 60 },
  { match: /gpt-4/i, inUsd: 10, outUsd: 30 },
  { match: /gpt-3\.5/i, inUsd: 0.5, outUsd: 1.5 },
  // GPT-5.6 family (Sol flagship / Terra balanced / Luna fast). Tier-specific
  // rates must come BEFORE the generic gpt-5 rule below (first match wins). Bare
  // "gpt-5.6" routes to Sol. Rates per OpenAI + OpenRouter, July 2026.
  { match: /gpt-5\.6-luna/i, inUsd: 1, outUsd: 6 },
  { match: /gpt-5\.6-terra/i, inUsd: 2.5, outUsd: 15 },
  { match: /gpt-5\.6(-sol)?/i, inUsd: 5, outUsd: 30 },
  { match: /gpt-5|gpt5/i, inUsd: 5, outUsd: 15 },
  // Google
  { match: /gemini.*flash/i, inUsd: 0.075, outUsd: 0.3 },
  { match: /gemini.*pro|gemini-2|gemini-1\.5/i, inUsd: 1.25, outUsd: 5 },
  { match: /gemini/i, inUsd: 1.25, outUsd: 5 },
  // xAI
  { match: /grok/i, inUsd: 2, outUsd: 10 },
  // DeepSeek (hosted)
  { match: /deepseek/i, inUsd: 0.27, outUsd: 1.1 },
  // Mistral (hosted)
  { match: /mistral-large/i, inUsd: 2, outUsd: 6 },
  { match: /mistral/i, inUsd: 0.4, outUsd: 2 },
  // Open / hosted-open families (common via OpenRouter and others). Approximate
  // published rates; matched on the family substring so the "vendor/" prefix in
  // an OpenRouter id (e.g. "z-ai/glm-5.2") doesn't matter.
  { match: /\bglm\b|zhipu/i, inUsd: 0.6, outUsd: 2.2 },
  { match: /\bkimi\b|moonshot/i, inUsd: 0.6, outUsd: 2.5 },
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
