// Decision layer: a fast, cheap "should we?" call placed in front of the
// expensive ones.
//
// The point of this module is that NOTHING in it knows about any particular
// vendor. Prevail asks typed questions and gets back normalized signals
// (probabilities, a chosen option, a score). What actually happens next is
// decided by Prevail's own deterministic logic, never by the decision model.
// That split is deliberate: a decision model is a hint generator, and hints
// must not be able to route a request past a gate on their own.
//
// The first implementation is TypeSafeProvider (decision-typesafe.ts). Swapping in a
// different decision model should mean writing one new file and changing one
// config value.

// ── The question vocabulary ────────────────────────────────────────────
// Three shapes, chosen because they are the intersection of what decision
// models can answer reliably and what routing code actually needs.

/** A yes/no question. The answer is a probability, not a boolean. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  /** Optional guidance on what true and false each mean. */
  criteria?: { true: string; false: string };
}

/** Pick one of a fixed set of options. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option key -> what that option means. */
  criteria: Record<string, string>;
}

/** Rate against ordered levels, lowest first. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered level descriptions, lowest first. */
  criteria: string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

// ── The answer vocabulary ──────────────────────────────────────────────
// Normalized. A provider that calls its yes/no probability something else
// translates it here, so routing code never learns a vendor's word for it.

export interface NoulAnswer {
  type: "noul";
  /** 0..1 probability that the answer is yes. */
  probability: number;
}

export interface ChoiceAnswer {
  type: "choice";
  /** The selected option key. */
  choice: string;
  /** 0..1 confidence in that selection. */
  confidence: number;
  /** option key -> 0..1. May be partial. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** The rated value, on the scale implied by the question's levels. */
  score: number;
  /** 0..1 confidence in that rating. */
  confidence: number;
  /** level index (as a string) -> 0..1. May be partial. */
  probabilities: Record<string, number>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResult {
  /** Answer per question key. A provider may omit a key it could not answer. */
  answers: Record<string, DecisionAnswer>;
  /** Wall-clock time for the call, measured by us and not by the vendor. */
  latencyMs: number;
  /** Estimated USD cost of this call. 0 when the provider is free or unknown. */
  costUsd: number;
  /** The concrete model that answered, for the record. */
  model: string;
}

export interface EvaluateOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A source of fast structured decisions.
 *
 * Implementations MUST NOT throw out of `evaluate` for an ordinary failure
 * (network, timeout, bad output, missing key). They return null and let the
 * caller carry on with whatever it would have done anyway.
 */
export interface DecisionProvider {
  /** Stable id for logs and config, e.g. "typesafe". */
  readonly id: string;
  /** Configured and usable right now. Cheap, no network. */
  available(): boolean;
  /** Why it is unavailable, for a status line. Null when available. */
  unavailableReason(): string | null;
  evaluate(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts?: EvaluateOptions,
  ): Promise<DecisionResult | null>;
}

// ── Defaults ───────────────────────────────────────────────────────────

/**
 * A decision call is only worth making if it is much cheaper than the work it
 * might save. Past about a second that stops being true for routing, because
 * the caller is holding a user's request open while it waits. Fail fast and
 * route the way we would have routed anyway.
 */
export const DECISION_TIMEOUT_MS = 1_200;

/**
 * Ask a provider a set of questions. This is the only entry point routing code
 * should use, and it cannot throw: a missing provider, an unconfigured one, a
 * slow one or a broken one all come back as null, which means "no hint, decide
 * the way you already would".
 */
export async function evaluateDecision(
  provider: DecisionProvider | null | undefined,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  opts: EvaluateOptions = {},
): Promise<DecisionResult | null> {
  if (!provider || !provider.available()) return null;
  try {
    return await provider.evaluate(state, questions, {
      timeoutMs: opts.timeoutMs ?? DECISION_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch {
    // A provider is contractually not supposed to throw. If one does, that is
    // still not a reason to fail the user's actual request.
    return null;
  }
}

// ── Guards that keep a hint from becoming a decision ───────────────────

/**
 * Below this, a signal is not worth acting on. Deterministic logic should
 * treat a low-confidence answer as no answer at all rather than as a weak
 * vote, because a decision model that is unsure is exactly the case where
 * its output is least calibrated.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.6;

export function isActionable(a: DecisionAnswer | undefined): boolean {
  if (!a) return false;
  switch (a.type) {
    // A noul near 0.5 is a coin flip; both tails are informative.
    case "noul":
      return Math.abs(a.probability - 0.5) >= MIN_ACTIONABLE_CONFIDENCE - 0.5;
    case "choice":
    case "score":
      return a.confidence >= MIN_ACTIONABLE_CONFIDENCE;
  }
}

// ── Validation ─────────────────────────────────────────────────────────
// Providers speak to a network service, so everything coming back is
// untrusted input: wrong types, out-of-range numbers, options that were never
// offered. A provider normalizes, then calls this. Anything that does not pass
// is dropped, and a dropped answer is simply an absent hint.

const finite01 = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Drop any answer that is malformed, out of range, or does not correspond to
 * the question that was asked. Returns only answers safe to reason about.
 */
export function sanitizeAnswers(
  questions: Record<string, DecisionQuestion>,
  answers: Record<string, unknown>,
): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const raw = answers[key] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") continue;

    if (q.type === "noul") {
      if (!finite01(raw.probability)) continue;
      out[key] = { type: "noul", probability: raw.probability };
      continue;
    }

    if (q.type === "choice") {
      const choice = raw.choice;
      // An option we never offered is a protocol violation, not an answer.
      if (typeof choice !== "string" || !(choice in q.criteria)) continue;
      if (!finite01(raw.confidence)) continue;
      out[key] = {
        type: "choice",
        choice,
        confidence: raw.confidence,
        probabilities: pickProbabilities(raw.probabilities, (k) => k in q.criteria),
      };
      continue;
    }

    // score
    const score = raw.score;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    // Levels are an ordered array, so a valid score sits within its bounds.
    if (score < 0 || score > q.criteria.length - 1) continue;
    if (!finite01(raw.confidence)) continue;
    out[key] = {
      type: "score",
      score,
      confidence: raw.confidence,
      probabilities: pickProbabilities(raw.probabilities, (k) => {
        const i = Number(k);
        return Number.isInteger(i) && i >= 0 && i < q.criteria.length;
      }),
    };
  }
  return out;
}

function pickProbabilities(v: unknown, keyOk: (k: string) => boolean): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (keyOk(k) && finite01(p)) out[k] = p;
  }
  return out;
}
