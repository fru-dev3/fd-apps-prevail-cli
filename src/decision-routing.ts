// Routing decisions, expressed as typed questions plus Prevail's own rules.
//
// The division of labour matters more than anything else in this file:
//
//   the decision model  answers questions and returns probabilities
//   Prevail             decides what actually happens
//
// A signal never selects a branch by itself. Every rule below reads a signal,
// checks it against a threshold, and then applies Prevail's own policy. That
// is what makes the model swappable, and it is also what stops a confident
// wrong answer from routing a request somewhere it should not go.

import {
  evaluateDecision,
  isActionable,
  type ChoiceAnswer,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionResult,
  type NoulAnswer,
  type ScoreAnswer,
} from "./decision.ts";

// ── What Prevail knows before it routes ────────────────────────────────
// Deliberately its own type rather than anything borrowed from the council
// code. The integration maps into this, so the decision layer has no opinion
// about how the rest of Prevail is shaped.

export interface RoutingContext {
  /** The user's request, verbatim. Never sent anywhere without scrubbing. */
  prompt: string;
  /** Vault domain the request belongs to, when known. */
  domain?: string | null;
  /** How many runtimes are actually usable right now. */
  availableModels: number;
  /** Is a council even possible? Fewer than two models means no. */
  councilPossible: boolean;
  /** Can this request reach an execution agent (acts, playbooks)? */
  agentPossible: boolean;
  /** What Prevail would do today, with no decision layer involved. */
  currentPlan: RoutingMode;
  /** True when the request is already carrying retrieved context. */
  hasContext?: boolean;
}

export type RoutingMode = "single" | "council" | "more-context" | "agent";

export interface RoutingPlan {
  mode: RoutingMode;
  /** Plain-language why, suitable for a log line or a status row. */
  reason: string;
  /** Did a decision signal actually change anything? */
  decisionAssisted: boolean;
}

// ── The questions ──────────────────────────────────────────────────────
// Kept few and concrete. Each one exists because a specific rule below reads
// it; a question nothing reads is just latency and cost.

export const ROUTING_QUESTION_KEYS = ["route", "stakes", "needsMoreContext"] as const;

export function buildRoutingQuestions(ctx: RoutingContext): Record<string, DecisionQuestion> {
  // Only offer branches that are actually reachable. Offering "council" when
  // one runtime is installed invites an answer no rule can honour.
  const routeCriteria: Record<string, string> = {
    single: "A single capable model can answer this well on its own.",
  };
  if (ctx.councilPossible) {
    routeCriteria.council =
      "The question is contested, high stakes, or benefits from disagreement between several models.";
  }
  if (ctx.agentPossible) {
    routeCriteria.agent =
      "The request asks for something to be done or changed, not for an answer to be written.";
  }
  routeCriteria.more_context =
    "The request cannot be answered well without first retrieving more of the user's own records.";

  return {
    route: {
      type: "choice",
      instructions:
        "A personal assistant is deciding how to handle this request. How should it be handled?",
      criteria: routeCriteria,
    },
    stakes: {
      type: "score",
      instructions:
        "How consequential is getting this wrong for the person asking?",
      criteria: [
        "Trivial. A wrong answer costs nothing.",
        "Ordinary. A wrong answer is an inconvenience.",
        "Serious. A wrong answer costs real money, time, health or a relationship.",
      ],
    },
    needsMoreContext: {
      type: "noul",
      instructions:
        "Would answering this well require the assistant to look up the person's own stored records first?",
      criteria: {
        true: "The answer depends on specifics only their records would hold.",
        false: "The request can be answered from general knowledge or from what is already present.",
      },
    },
  };
}

// ── Privacy ────────────────────────────────────────────────────────────
// A decision model is a third party on the network. Routing a request means
// showing it the request, so this is the one place the decision layer can leak
// something. Three levers, all conservative by default.

export type StatePrivacy = "signals" | "redacted" | "full";

/** Default. Enough text to route on, with the obvious identifiers removed. */
export const DEFAULT_STATE_PRIVACY: StatePrivacy = "redacted";

/**
 * Swappable so the integration can hand in Prevail's existing egress scrubber
 * rather than this one. This is a floor, not a substitute for that.
 */
export type Scrubber = (text: string) => string;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const LONG_NUMBER = /\b\d{6,}\b/g;
const MONEY = /\$\s?[\d,]+(?:\.\d{2})?/g;
const URL = /https?:\/\/\S+/g;

export const defaultScrubber: Scrubber = (text) =>
  text
    .replace(EMAIL, "[email]")
    .replace(URL, "[url]")
    .replace(PHONE, "[phone]")
    .replace(MONEY, "[amount]")
    .replace(LONG_NUMBER, "[number]");

export interface StateOptions {
  privacy?: StatePrivacy;
  scrub?: Scrubber;
  /** Hard cap on prompt characters sent. Routing does not need an essay. */
  maxPromptChars?: number;
}

/**
 * Build what gets sent over the wire. Returns a small object rather than raw
 * text so the shape is reviewable and so a future field cannot smuggle the
 * whole vault into a routing call.
 */
export function buildRoutingState(ctx: RoutingContext, opts: StateOptions = {}): Record<string, unknown> {
  const privacy = opts.privacy ?? DEFAULT_STATE_PRIVACY;
  const scrub = opts.scrub ?? defaultScrubber;
  const max = opts.maxPromptChars ?? 2_000;

  // Derived features are safe at every level: they describe the request
  // without reproducing it.
  const base: Record<string, unknown> = {
    domain: ctx.domain ?? "unknown",
    request_length: ctx.prompt.length,
    asks_a_question: /\?/.test(ctx.prompt),
    available_models: ctx.availableModels,
    council_possible: ctx.councilPossible,
    agent_possible: ctx.agentPossible,
    context_already_loaded: !!ctx.hasContext,
  };

  if (privacy === "signals") return base;
  const text = ctx.prompt.slice(0, max);
  base.request = privacy === "full" ? text : scrub(text);
  return base;
}

// ── The deterministic rules ────────────────────────────────────────────

export interface RouteOptions {
  /**
   * Shadow mode. When true the signals are computed and recorded but the
   * returned plan is always ctx.currentPlan, so production behaviour is
   * byte-for-byte what it was. This is the default.
   */
  shadow?: boolean;
}

/**
 * Should several models be convened for this request?
 *
 * Reads signals, applies Prevail's policy. The policy, in order:
 *   1. If a council is impossible, the answer is no. No signal overrides this.
 *   2. Serious stakes plus a confident council recommendation convenes one.
 *   3. A confident single-model recommendation on low stakes stands one down.
 *   4. Otherwise keep doing whatever Prevail does today.
 */
/**
 * Probability the model assigned to one option, or null when it did not say.
 *
 * This matters more than the winning option. A three-way question can put
 * `single` at 0.07 and split the remaining 0.93 between two different ways of
 * escalating: the argmax is barely ahead and the vendor's own `confidence`
 * reads low, yet the answer to "is one model enough" is a clear no. Reading
 * only the argmax throws that away, which is exactly what the first live run
 * against the service did.
 */
export function probabilityOf(a: ChoiceAnswer | undefined, key: string): number | null {
  if (!a || a.type !== "choice") return null;
  const p = a.probabilities[key];
  if (typeof p === "number" && Number.isFinite(p)) return p;
  // An option the model never mentioned is not evidence either way, unless it
  // reported a distribution at all, in which case an absent key means zero.
  return Object.keys(a.probabilities).length > 0 ? 0 : null;
}

/** One model is enough at or above this probability. */
const P_SINGLE_SUFFICIENT = 0.6;
/** One model is unlikely to be enough at or below this probability. */
const P_SINGLE_UNLIKELY = 0.25;

export function shouldConveneCouncil(
  ctx: RoutingContext,
  result: DecisionResult | null,
): { convene: boolean; reason: string; decisionAssisted: boolean } {
  const currently = ctx.currentPlan === "council";
  if (!ctx.councilPossible) {
    return { convene: false, reason: "fewer than two runtimes are available", decisionAssisted: false };
  }
  if (!result) {
    return { convene: currently, reason: "no decision signal; unchanged", decisionAssisted: false };
  }

  const route = result.answers.route as ChoiceAnswer | undefined;
  const stakes = result.answers.stakes as ScoreAnswer | undefined;
  // Top level of a three-level scale, and only when the model is sure of it.
  const highStakes = isActionable(stakes) && stakes!.score >= 1.5;

  // The council decision is binary, so read the one probability that answers
  // it directly rather than asking which of three options happened to win.
  const pSingle = probabilityOf(route, "single");
  if (pSingle !== null) {
    if (pSingle <= P_SINGLE_UNLIKELY && highStakes) {
      return { convene: true, reason: "one model is unlikely to be enough and the stakes are high", decisionAssisted: !currently };
    }
    if (pSingle >= P_SINGLE_SUFFICIENT) {
      return { convene: false, reason: "one model is enough here", decisionAssisted: currently };
    }
    // Genuinely in between. Convening is the expensive branch, so ambiguity
    // keeps whatever Prevail was going to do.
    return { convene: currently, reason: "signal not decisive; unchanged", decisionAssisted: false };
  }

  // No distribution to read. Fall back to the winning option, and only when
  // the model was confident enough in it to be worth acting on.
  const routeSays = isActionable(route) ? route!.choice : null;
  if (routeSays === "council" && highStakes) {
    return { convene: true, reason: "contested and high stakes", decisionAssisted: !currently };
  }
  if (routeSays === "single" && !highStakes) {
    return { convene: false, reason: "one model is enough here", decisionAssisted: currently };
  }
  return { convene: currently, reason: "signal not decisive; unchanged", decisionAssisted: false };
}

/** Would more of the user's own records materially help before answering? */
export function shouldGatherMoreContext(
  ctx: RoutingContext,
  result: DecisionResult | null,
): boolean {
  if (ctx.hasContext) return false;
  const a = result?.answers.needsMoreContext as NoulAnswer | undefined;
  return isActionable(a) && a!.probability >= 0.75;
}

/**
 * The full plan. In shadow mode this still returns today's plan; the caller
 * records the difference rather than acting on it.
 */
export function planRoute(
  ctx: RoutingContext,
  result: DecisionResult | null,
  opts: RouteOptions = {},
): { proposed: RoutingPlan; effective: RoutingPlan } {
  const council = shouldConveneCouncil(ctx, result);
  let mode: RoutingMode;
  let reason: string;

  const route = result?.answers.route as ChoiceAnswer | undefined;
  const routeSays = isActionable(route) ? route!.choice : null;

  if (council.convene) {
    mode = "council";
    reason = council.reason;
  } else if (routeSays === "agent" && ctx.agentPossible) {
    // An execution agent is a doing branch, and doing things is gated
    // elsewhere by approval and the act gate. Proposing it here is safe
    // precisely because those gates still run afterwards.
    mode = "agent";
    reason = "the request asks for something to be done";
  } else if (shouldGatherMoreContext(ctx, result)) {
    mode = "more-context";
    reason = "the answer depends on the user's own records";
  } else {
    mode = "single";
    reason = council.reason;
  }

  const proposed: RoutingPlan = {
    mode,
    reason,
    decisionAssisted: mode !== ctx.currentPlan,
  };
  const shadow = opts.shadow ?? true;
  const effective: RoutingPlan = shadow
    ? { mode: ctx.currentPlan, reason: "shadow mode; behaviour unchanged", decisionAssisted: false }
    : proposed;
  return { proposed, effective };
}

// ── One call that does the whole thing ─────────────────────────────────

export interface RouteDecisionOptions extends RouteOptions, StateOptions {
  provider?: DecisionProvider | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Hard privacy gate. When false the decision layer is skipped entirely and
   * nothing leaves the machine. The integration passes Bunker Mode in here.
   */
  egressAllowed?: boolean;
}

export interface RouteDecision {
  proposed: RoutingPlan;
  effective: RoutingPlan;
  /** Null when no decision was made, for any reason. */
  result: DecisionResult | null;
  /** Why no decision was made, when result is null. */
  skipped: string | null;
}

export async function decideRoute(
  ctx: RoutingContext,
  opts: RouteDecisionOptions = {},
): Promise<RouteDecision> {
  const unchanged = (skipped: string): RouteDecision => {
    const plan = planRoute(ctx, null, opts);
    return { ...plan, result: null, skipped };
  };

  // Bunker Mode and friends. Checked before anything is built, so a blocked
  // call cannot even assemble the state.
  if (opts.egressAllowed === false) {
    return unchanged("egress not allowed (local-only mode)");
  }
  const provider = opts.provider ?? null;
  if (!provider) return unchanged("no decision provider configured");
  const why = provider.unavailableReason();
  if (why) return unchanged(why);

  const result = await evaluateDecision(
    provider,
    buildRoutingState(ctx, opts),
    buildRoutingQuestions(ctx),
    { timeoutMs: opts.timeoutMs, signal: opts.signal },
  );
  if (!result) return unchanged("decision provider returned nothing");

  const plan = planRoute(ctx, result, opts);
  return { ...plan, result, skipped: null };
}
