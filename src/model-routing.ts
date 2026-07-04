// model-routing — the "Auto" model router.
//
// When a chat turn's model is the sentinel "auto", the engine reads the prompt
// and routes it to the best available model instead of a user-pinned one. The
// design is a LAYERED HYBRID (see docs/plan): free heuristics decide the obvious
// ends instantly; a gated local-first classifier resolves the ambiguous middle;
// a capability filter plus a cost/quality scorer picks from the DYNAMIC catalog
// of installed models, biased by an Economy - Balanced - Quality setting.
//
// Two hard invariants:
//   1. NON-BREAKING. This module is only ever reached when model === "auto".
//      Every other turn is byte-identical to before.
//   2. PRIVACY. Candidates are supplied by the caller (chat-json) AFTER privacy
//      composition, so under Bunker / local-only the candidate set is already
//      local-only and the classifier runs on a local model or is skipped. This
//      module never re-detects or reaches for a cloud model on its own.
//
// chooseModel(...) is a PURE function (no IO) so it is exhaustively unit
// testable. classifyPrompt(...) is the only IO surface and fails open to the
// heuristic difficulty on any error or timeout.

import { createHash } from "node:crypto";

import type { CliKind } from "./config.ts";
import { priceFor, isLocalCliKind } from "./model-pricing.ts";
import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";
import { difficultyBand, learnedPreference, type RouteOverride } from "./route-learning.ts";

// ---------------------------------------------------------------------------
// Bias setting (the Economy - Balanced - Quality slider).
// ---------------------------------------------------------------------------

export type RouteBias = "economy" | "balanced" | "quality";

export function normalizeBias(v: string | undefined | null): RouteBias {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "economy" || s === "quality") return s;
  return "balanced";
}

// ---------------------------------------------------------------------------
// MODEL_META — a small static capability table keyed by id-substring.
//
//   tier  1..4  rough capability class (1 tiny/fast .. 4 frontier)
//   ctx          context-window size in tokens
//   tools        supports tool / function calling
//   vision       accepts image input
//   speed 1..5   relative response speed (5 fastest)
//
// Matched by loose substring on the model id (first match wins, so order
// most-specific first). An unmatched id falls back to DEFAULT_META - a mid,
// conservative profile so an unknown model is neither over- nor under-trusted.
// ---------------------------------------------------------------------------

export interface ModelMeta {
  tier: 1 | 2 | 3 | 4;
  ctx: number;
  tools: boolean;
  vision: boolean;
  speed: 1 | 2 | 3 | 4 | 5;
}

interface MetaRule extends ModelMeta {
  match: RegExp;
}

// Safe default for an id we do not recognize: mid capability, small context
// (so unknown models are not chosen for long-context needs unless nothing else
// qualifies), tools assumed on (most modern chat models expose them), no
// vision (conservative - never route an image turn to an unproven model).
export const DEFAULT_META: ModelMeta = { tier: 2, ctx: 8192, tools: true, vision: false, speed: 3 };

export const MODEL_META: MetaRule[] = [
  // Anthropic
  { match: /opus/i,               tier: 4, ctx: 200000, tools: true,  vision: true,  speed: 2 },
  { match: /fable/i,              tier: 4, ctx: 200000, tools: true,  vision: true,  speed: 3 },
  { match: /sonnet/i,             tier: 3, ctx: 200000, tools: true,  vision: true,  speed: 3 },
  { match: /haiku/i,              tier: 2, ctx: 200000, tools: true,  vision: true,  speed: 5 },
  // OpenAI
  { match: /o4-mini|o3-mini|4o-mini|gpt-4o-mini/i, tier: 2, ctx: 128000, tools: true, vision: true, speed: 5 },
  { match: /\bo1\b|\bo3\b|\bo4\b/i, tier: 4, ctx: 200000, tools: true, vision: true, speed: 2 },
  { match: /gpt-5|gpt5/i,         tier: 4, ctx: 400000, tools: true,  vision: true,  speed: 3 },
  { match: /gpt-4o|gpt-4\.1|chatgpt/i, tier: 3, ctx: 128000, tools: true, vision: true, speed: 3 },
  { match: /gpt-4/i,              tier: 3, ctx: 128000, tools: true,  vision: false, speed: 3 },
  { match: /gpt-3\.5/i,           tier: 1, ctx: 16000,  tools: true,  vision: false, speed: 5 },
  // Google
  { match: /gemini.*flash|flash/i, tier: 2, ctx: 1000000, tools: true, vision: true, speed: 5 },
  { match: /gemini.*pro|gemini-3|gemini-2/i, tier: 4, ctx: 1000000, tools: true, vision: true, speed: 3 },
  { match: /gemini|gemma/i,       tier: 3, ctx: 1000000, tools: true,  vision: true,  speed: 4 },
  // xAI
  { match: /grok/i,               tier: 3, ctx: 131072, tools: true,  vision: true,  speed: 3 },
  // DeepSeek
  { match: /deepseek.*reason|reasoner/i, tier: 4, ctx: 128000, tools: false, vision: false, speed: 2 },
  { match: /deepseek/i,           tier: 3, ctx: 128000, tools: true,  vision: false, speed: 3 },
  // Mistral
  { match: /mistral-large/i,      tier: 3, ctx: 128000, tools: true,  vision: false, speed: 3 },
  { match: /mistral|mixtral/i,    tier: 2, ctx: 32000,  tools: true,  vision: false, speed: 4 },
  // Open families
  { match: /\bglm\b|zhipu/i,      tier: 3, ctx: 128000, tools: true,  vision: false, speed: 3 },
  { match: /\bkimi\b|moonshot/i,  tier: 3, ctx: 128000, tools: false, vision: false, speed: 3 },
  { match: /qwen/i,               tier: 2, ctx: 32000,  tools: false, vision: false, speed: 4 },
  { match: /llama/i,              tier: 2, ctx: 128000, tools: false, vision: false, speed: 4 },
  { match: /phi/i,                tier: 1, ctx: 128000, tools: false, vision: false, speed: 5 },
];

// Look up the capability profile for a model id (substring match, safe default).
export function metaFor(model: string | undefined | null): ModelMeta {
  const m = (model ?? "").trim();
  if (!m) return DEFAULT_META;
  for (const rule of MODEL_META) {
    if (rule.match.test(m)) {
      return { tier: rule.tier, ctx: rule.ctx, tools: rule.tools, vision: rule.vision, speed: rule.speed };
    }
  }
  return DEFAULT_META;
}

// ---------------------------------------------------------------------------
// Layer 1 - free heuristic signals (< 1ms, no model call).
// ---------------------------------------------------------------------------

// Rough token estimate (about 4 chars/token English).
function estTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

const HARD_KEYWORDS = /\b(prove|proof|theorem|architect|refactor|debug|optimi[sz]e|analy[sz]e|derive|algorithm|strategy|reason(ing)?|design|plan|trade-?offs?|root cause|complex)\b/i;
const EASY_KEYWORDS = /\b(tl;?dr|summar(y|ize|ise)|rename|re-?format|format|quick|simple|translate|capital of|what time|spell|thanks|hello|\bhi\b|\bhey\b)\b/i;

export interface Heuristics {
  chars: number;
  inputTokens: number;
  hasCodeFence: boolean;
  hardSignal: boolean;
  easySignal: boolean;
  // 1..5 difficulty prior from free signals alone.
  difficultyPrior: number;
  // Minimum context window this turn plausibly needs (tokens).
  requiredCtxTokens: number;
  // True when the free signals do not clearly resolve to an easy or hard end,
  // i.e. the band a classifier should adjudicate.
  ambiguous: boolean;
}

export function deriveHeuristics(message: string): Heuristics {
  const text = message ?? "";
  const chars = text.length;
  const inputTokens = estTokens(chars);
  const hasCodeFence = /```/.test(text) || /\bfunction\b|\bclass\b|=>|def |import /.test(text);
  const hardSignal = HARD_KEYWORDS.test(text) || hasCodeFence;
  const easySignal = EASY_KEYWORDS.test(text) && chars < 240;

  let d = 3;
  if (hardSignal) d += 1;
  if (chars > 2000) d += 1;
  if (chars > 8000) d += 1;
  if (easySignal) d -= 2;
  else if (chars < 80 && !hardSignal) d -= 1;
  d = Math.max(1, Math.min(5, d));

  // Reserve headroom for the reply + framing on top of the prompt itself.
  const requiredCtxTokens = Math.round(inputTokens * 1.25) + 2000;

  // Obvious ends: clearly easy (short + easy keyword, no hard signal) or
  // clearly hard (hard signal + some length). Everything else is the middle.
  const obviousEasy = easySignal && !hardSignal && d <= 2;
  const obviousHard = hardSignal && d >= 4;
  const ambiguous = !obviousEasy && !obviousHard;

  return { chars, inputTokens, hasCodeFence, hardSignal, easySignal, difficultyPrior: d, requiredCtxTokens, ambiguous };
}

// ---------------------------------------------------------------------------
// Candidate catalog.
// ---------------------------------------------------------------------------

export interface RouteCandidate {
  cli: CliKind;
  model: string;
  // True when this runs on the user's own hardware ($0 marginal, privacy-safe).
  local: boolean;
}

// Build a candidate from a (cli, model) pair, tagging local-ness from the cli.
export function makeCandidate(cli: CliKind, model: string): RouteCandidate {
  return { cli, model, local: isLocalCliKind(cli) };
}

// ---------------------------------------------------------------------------
// Layer 3 - capability filter + cost/quality scorer (pure).
// ---------------------------------------------------------------------------

export interface RouteInput {
  message: string;
  candidates: RouteCandidate[];
  bias: RouteBias;
  // Privacy: when true, the caller has already restricted `candidates` to
  // local engines. Kept here only for the reason string and gating.
  localOnly?: boolean;
  // Hard capability requirements derived by the caller (attached tools / image).
  toolsRequired?: boolean;
  visionRequired?: boolean;
  // Classifier verdict for the ambiguous middle, or null when not run / failed.
  // difficulty is 1..5; capabilities are advisory hints.
  classified?: { difficulty: number; capabilities?: string[] } | null;
  domain?: string;
  // Learned/personalized router (v1): the user's local override history, read by
  // the caller from the vault store. When the user has settled on a model for THIS
  // bucket (domain + difficulty band) and it is available, honor it. Empty/absent
  // => byte-identical to the heuristic pick.
  overrides?: RouteOverride[];
  // Overrides needed in a bucket before a learned preference is honored. Default 2.
  learnThreshold?: number;
}

export interface RouteDecision {
  cli: CliKind;
  model: string;
  reason: string;
  confidence: number; // 0..1
  tier: number;
  difficulty: number;
  usedClassifier: boolean;
  bias: RouteBias;
}

// Map an effective difficulty (1..5) to a base capability tier (1..4),
// conservative in the middle (a difficulty-3 prompt aims at tier 3, not 2 -
// weak-on-hard is a worse error than strong-on-easy).
function baseTierFor(difficulty: number): number {
  if (difficulty <= 1) return 1;
  if (difficulty === 2) return 2;
  if (difficulty === 3) return 3;
  if (difficulty === 4) return 3;
  return 4;
}

function biasShift(bias: RouteBias): number {
  if (bias === "economy") return -1;
  if (bias === "quality") return 1;
  return 0;
}

// Stable ordering so ties resolve deterministically (same prompt => same route).
function stableSort(cands: RouteCandidate[]): RouteCandidate[] {
  return [...cands].sort((a, b) => {
    const ma = metaFor(a.model);
    const mb = metaFor(b.model);
    if (ma.tier !== mb.tier) return ma.tier - mb.tier;
    if (a.cli !== b.cli) return a.cli < b.cli ? -1 : 1;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
}

// Choose the best model for a turn. PURE. Throws only when there are no
// candidates at all (the caller wraps this and falls back to a default).
export function chooseModel(input: RouteInput): RouteDecision {
  const bias = input.bias;
  const all = input.candidates.filter((c) => c && typeof c.model === "string");
  if (all.length === 0) throw new Error("model-routing: no candidates");

  const h = deriveHeuristics(input.message);
  const usedClassifier = !!input.classified && Number.isFinite(input.classified.difficulty);
  const difficulty = usedClassifier
    ? Math.max(1, Math.min(5, Math.round(input.classified!.difficulty)))
    : h.difficultyPrior;

  // Capability filter. Relax any filter that would empty the pool rather than
  // fail - a slightly-wrong model beats no answer.
  const toolsReq = !!input.toolsRequired;
  const visionReq = !!input.visionRequired;
  const ctxReq = h.requiredCtxTokens;

  function filtered(): RouteCandidate[] {
    let pool = stableSort(all);
    if (toolsReq) {
      const next = pool.filter((c) => metaFor(c.model).tools);
      if (next.length) pool = next;
    }
    if (visionReq) {
      const next = pool.filter((c) => metaFor(c.model).vision);
      if (next.length) pool = next;
    }
    if (ctxReq > DEFAULT_META.ctx) {
      const next = pool.filter((c) => metaFor(c.model).ctx >= ctxReq);
      if (next.length) pool = next;
    }
    return pool;
  }
  const pool = filtered();

  const desiredTier = Math.max(1, Math.min(4, baseTierFor(difficulty) + biasShift(bias)));

  // Score: capability match dominates; bias breaks ties toward cost or quality.
  function score(c: RouteCandidate): number {
    const meta = metaFor(c.model);
    let s = -Math.abs(meta.tier - desiredTier) * 10;
    const price = priceFor(c.cli, c.model);
    const outCost = price ? price.outUsd : 8; // unknown -> mid cost
    if (bias === "economy") {
      s += (4 - meta.tier) * 1.5;     // prefer cheaper class
      s += meta.speed * 0.4;          // and faster
      s -= outCost * 0.05;            // and literally cheaper
      if (c.local) s += 1.0;          // local is free
    } else if (bias === "quality") {
      s += meta.tier * 1.2;           // prefer stronger
    } else {
      s += meta.speed * 0.15;         // balanced: nudge to faster of equals
      s -= outCost * 0.01;
      if (c.local) s += 0.3;
    }
    return s;
  }

  let best = pool[0]!;
  let bestScore = score(best);
  let secondScore = -Infinity;
  for (let i = 1; i < pool.length; i++) {
    const s = score(pool[i]!);
    if (s > bestScore) {
      secondScore = bestScore;
      best = pool[i]!;
      bestScore = s;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  // Layer 5 - learned/personalized preference (v1, local + private). If the user
  // has repeatedly overridden Auto's pick to the same model in THIS bucket
  // (domain + difficulty band) and that model is among the currently-available
  // candidates, honor it over the scored pick. Empty/absent history is a no-op,
  // so a fresh vault is byte-identical to the heuristic+classifier route.
  let learnedApplied: string | null = null;
  if (input.overrides && input.overrides.length > 0) {
    const pref = learnedPreference(input.overrides, input.domain, difficultyBand(difficulty), input.learnThreshold ?? 2);
    if (pref) {
      const hit = pool.find((c) => c.model === pref);
      if (hit) { best = hit; learnedApplied = pref; }
    }
  }

  const meta = metaFor(best.model);
  const reason = learnedApplied
    ? `learned: you usually pick ${learnedApplied} here`
    : buildReason({
        difficulty,
        bias,
        usedClassifier,
        toolsReq,
        visionReq,
        longCtx: ctxReq > DEFAULT_META.ctx,
        localOnly: !!input.localOnly,
        single: all.length === 1,
      });

  // Confidence: clearer decisions score higher. Start from the source, widen by
  // the margin over the runner-up. A learned preference is a deliberate user
  // choice, so it lands high regardless of the scored margin.
  let confidence = usedClassifier ? 0.72 : h.ambiguous ? 0.58 : 0.82;
  if (all.length === 1) confidence = 0.99;
  if (Number.isFinite(secondScore)) {
    const margin = Math.min(1, Math.abs(bestScore - secondScore) / 10);
    confidence = Math.min(0.99, confidence + margin * 0.12);
  }
  if (learnedApplied) confidence = Math.max(confidence, 0.9);

  return {
    cli: best.cli,
    model: best.model,
    reason,
    confidence: Math.round(confidence * 100) / 100,
    tier: meta.tier,
    difficulty,
    usedClassifier,
    bias,
  };
}

// Try chooseModel; on any failure return a default decision (byte-identical to
// today's non-auto turn: empty model = the provider default). Never throws.
export function routeWithFallback(input: RouteInput, fallback: { cli: CliKind; model: string }): RouteDecision {
  try {
    return chooseModel(input);
  } catch {
    return {
      cli: fallback.cli,
      model: fallback.model,
      reason: "router unavailable, using the runtime default",
      confidence: 0.3,
      tier: metaFor(fallback.model).tier,
      difficulty: 3,
      usedClassifier: false,
      bias: input.bias,
    };
  }
}

// ---------------------------------------------------------------------------
// Layer 4 - cascade escalation (OPT-IN, default OFF).
//
// For the ambiguous MIDDLE band only, cascade answers with a CHEAPER model first
// and escalates to the router's normal pick only when a confidence check fails.
// Off, or outside the middle band, is byte-identical to the single-turn path.
// Both functions are PURE so the cascade is exhaustively unit-testable.
// ---------------------------------------------------------------------------

// Truthy env parse for PREVAIL_ROUTE_CASCADE. Anything obviously affirmative
// turns it on; absent / "0" / "false" leaves it OFF (the default).
export function cascadeEnabled(flag: boolean | undefined, env: string | undefined): boolean {
  if (typeof flag === "boolean") return flag;
  const s = (env ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

// The cheaper model to try first: the HIGHEST-tier candidate strictly below the
// target tier (i.e. the next tier down), so we drop exactly one rung, not to the
// floor. Deterministic (stable order). Null when nothing is cheaper - in which
// case there is no cascade to run and the caller uses the normal single turn.
export function pickCheaperCandidate(candidates: RouteCandidate[], targetTier: number): RouteCandidate | null {
  let best: RouteCandidate | null = null;
  let bestTier = 0;
  for (const c of stableSort(candidates)) {
    if (!c || typeof c.model !== "string") continue;
    const t = metaFor(c.model).tier;
    if (t < targetTier && t > bestTier) { best = c; bestTier = t; }
  }
  return best;
}

// The cheap model self-reporting that it can't answer / isn't sure. Kept narrow
// so a confident answer that merely mentions uncertainty in passing does not
// trip it (anchored to first-person "I ..." admissions).
const CHEAP_UNCERTAIN_RE =
  /\b(i(?:'m| am) not sure|i am unsure|i can(?:'|no)?t (?:help|answer|assist|do that)|i do(?:n'|no)t (?:know|have enough)|unable to (?:help|answer|determine)|not able to (?:help|answer)|beyond my|cannot determine|insufficient information)\b/i;

// Decide whether to escalate after the cheap pass. Honest, cheap signals only
// (no extra model call): an empty/truncated answer, a first-person uncertainty
// admission, a difficulty that landed hard (>=4) on a deliberately weak pick, or
// a router that was itself unsure of the pick. Any one is enough.
export function cascadeShouldEscalate(args: { difficulty: number; confidence: number; reply: string }): boolean {
  const reply = (args.reply ?? "").trim();
  if (reply.length < 2) return true;                 // no real answer came back
  if (CHEAP_UNCERTAIN_RE.test(reply)) return true;    // the model punted
  if (Number.isFinite(args.difficulty) && args.difficulty >= 4) return true; // hard middle
  if (Number.isFinite(args.confidence) && args.confidence < 0.5) return true; // unsure route
  return false;
}

interface ReasonArgs {
  difficulty: number;
  bias: RouteBias;
  usedClassifier: boolean;
  toolsReq: boolean;
  visionReq: boolean;
  longCtx: boolean;
  localOnly: boolean;
  single: boolean;
}

// Human-readable one-liner for the routing chip. NO em dashes (Prevail rule).
function buildReason(a: ReasonArgs): string {
  if (a.single) return "only one model available";
  const parts: string[] = [];
  const band = a.difficulty <= 2 ? "light prompt" : a.difficulty === 3 ? "moderate complexity" : "hard prompt";
  parts.push(band);
  parts.push(`${a.bias} bias`);
  if (a.toolsReq) parts.push("tools needed");
  if (a.visionReq) parts.push("image input");
  if (a.longCtx) parts.push("long context");
  if (a.localOnly) parts.push("local only");
  parts.push(a.usedClassifier ? "classified" : "by heuristics");
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Layer 2 - gated local-first classifier (the only IO in this module).
// ---------------------------------------------------------------------------

// Should we spend a classifier call on this turn? Only for the ambiguous middle,
// and only if a viable classifier engine is available. Under local-only the
// classifier MUST be a local engine or we skip (never hand the prompt to a cloud
// model just to classify it).
export function shouldRunClassifier(args: {
  ambiguous: boolean;
  hasClassifierCli: boolean;
  localOnly: boolean;
  classifierIsLocal: boolean;
}): boolean {
  if (!args.ambiguous) return false;
  if (!args.hasClassifierCli) return false;
  if (args.localOnly && !args.classifierIsLocal) return false;
  return true;
}

export interface ClassifyResult {
  difficulty: number; // 1..5
  capabilities: string[];
}

// Small in-process cache keyed by prompt hash so the same prompt routes the same
// way within a session (determinism, no flapping).
const _classifyCache = new Map<string, ClassifyResult | null>();

function hashPrompt(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

const CLASSIFIER_INSTRUCTION = [
  "You are a routing classifier. Judge how hard a user message is to answer well",
  "and which capabilities it needs, so a dispatcher can pick the right model.",
  "",
  "Reply with ONLY a single JSON object, no prose, no fences:",
  '{"difficulty": <1-5>, "capabilities": ["tools"|"vision"|"long_context"|"code"|"reasoning"]}',
  "",
  "difficulty scale:",
  "1 = trivial (greeting, one fact, reformat)",
  "2 = simple (short explanation, quick rewrite)",
  "3 = moderate (multi-step answer, some judgment)",
  "4 = hard (design, debugging, non-trivial reasoning)",
  "5 = very hard (proofs, architecture, deep multi-constraint reasoning)",
  "",
  "capabilities: include only those the message clearly needs; [] if none.",
  "Default to difficulty 3 and [] when unsure.",
].join("\n");

// Classify a prompt's difficulty + capabilities with the cheapest viable model.
// Fails OPEN: returns null on any error, timeout, or unparseable reply, so the
// caller falls back to the free heuristics.
export async function classifyPrompt(args: {
  message: string;
  cwd: string;
  cli: AvailableCli;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ClassifyResult | null> {
  const key = hashPrompt(`${args.cli.kind}:${args.model ?? ""}:${args.message}`);
  if (_classifyCache.has(key)) return _classifyCache.get(key) ?? null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 6000);
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let raw = "";
  try {
    raw = await runChatTurn({
      prompt: [CLASSIFIER_INSTRUCTION, "", "USER MESSAGE:", (args.message ?? "").slice(0, 4000)].join("\n"),
      cwd: args.cwd,
      cli: args.cli,
      model: args.model ?? "",
      isFirst: true,
      bare: true,
      signal: controller.signal,
      maxOutputChars: 400,
    });
  } catch {
    _classifyCache.set(key, null);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  const parsed = parseClassifyResponse(raw);
  _classifyCache.set(key, parsed);
  return parsed;
}

// Tolerant parser: strip fences, find the first object, validate. Never throws.
export function parseClassifyResponse(raw: string): ClassifyResult | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let candidate = text.slice(start);
  let obj: unknown = null;
  try {
    obj = JSON.parse(candidate);
  } catch {
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace <= 0) return null;
    try {
      obj = JSON.parse(candidate.slice(0, lastBrace + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as { difficulty?: unknown; capabilities?: unknown };
  const d = typeof rec.difficulty === "number" ? rec.difficulty : Number(rec.difficulty);
  if (!Number.isFinite(d)) return null;
  const difficulty = Math.max(1, Math.min(5, Math.round(d)));
  const capabilities = Array.isArray(rec.capabilities)
    ? rec.capabilities.filter((x): x is string => typeof x === "string").slice(0, 8)
    : [];
  return { difficulty, capabilities };
}

// Test-only: clear the classify cache between cases.
export function _clearClassifyCache(): void {
  _classifyCache.clear();
}
