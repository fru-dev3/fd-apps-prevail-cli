import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";
import { decisionLayer } from "./decision-config.ts";
import { evaluateDecision, type DecisionResult } from "./decision.ts";
import {
  buildRoutingQuestions,
  buildRoutingState,
  planRoute,
  type RoutingContext,
} from "./decision-routing.ts";
import { recordDecisionShadow } from "./decision-shadow.ts";
import { estimateCostUsd } from "./model-pricing.ts";

// Auto-council classifier.
//
// When council is OFF and the user types a prompt, we optionally run a
// tiny LLM call that judges whether the prompt is the kind of question
// that would benefit from a multi-model council vs. a quick single
// answer. The answer is a single token (YES / NO) so the call is cheap
// in both time and tokens.
//
// Two modes (in addition to "off") are supported by the caller:
//
//   "suggest" — fire the classifier in parallel with the chat call. If
//               YES, surface a passive system-style suggestion in the
//               transcript prompting the user to re-run via council.
//               The chat call completes regardless, so latency is hidden.
//
//   "auto"    — fire the classifier BEFORE the chat call. If YES, route
//               the prompt to runCouncil instead of single chat. If NO,
//               fall through to single chat (~500ms penalty). The user
//               opted into latency in exchange for not having to read
//               and act on a suggestion.

const CLASSIFIER_INSTRUCTION = [
  "You are a binary classifier. Given a user message to an assistant,",
  "decide whether it is the kind of question that benefits from",
  "multiple expert perspectives — a strategic choice, life decision,",
  "open-ended judgment call, creative direction, or anything where",
  "consulting a few different angles would produce a better answer.",
  "",
  "Reply with EXACTLY one token: YES or NO. No punctuation, no prose,",
  "no explanation, no quotation marks. Default to NO when uncertain.",
  "",
  "Examples that should be YES:",
  "- Should I leave my job?",
  "- How should I structure my will?",
  "- What's the right strategy for launching this product?",
  "- Should I have the difficult conversation with my partner?",
  "",
  "Examples that should be NO:",
  "- Summarize this email.",
  "- What's the capital of France?",
  "- Reformat this code.",
  "- What does this error mean?",
  "- Translate to Spanish.",
].join("\n");

export interface ClassifyArgs {
  cwd: string;
  cli: AvailableCli;
  userPrompt: string;
  signal?: AbortSignal;
  // ── Decision layer (optional, inert unless configured) ───────────────
  // Passing a vault turns on shadow recording: the decision model answers
  // the same question in parallel and both answers are written down. It
  // cannot change the verdict unless the layer is explicitly set to live.
  vault?: string | null;
  domain?: string | null;
  /** How many runtimes are usable, so the layer is not offered an impossible branch. */
  availableModels?: number;
}

// ── Decision layer shadow hook ─────────────────────────────────────────
//
// This is the whole integration. It is written so that the ONLY way it can
// affect the returned verdict is when the layer is explicitly configured
// live; in every other case `settle` hands back exactly the boolean it was
// given. Nothing here throws, and nothing here awaits anything that was not
// already in flight before the expensive classifier started.

interface ShadowHandle {
  settle(actual: boolean, baselineMs: number): Promise<boolean>;
}

const NO_SHADOW: ShadowHandle = { settle: async (actual) => actual };

// Shadow recording must be strictly free. The decision call is started before
// the LLM classifier, but "started earlier" is not the same as "finished
// first": a fast classifier and a slow decision service would otherwise make
// the user wait on a call whose answer is being thrown away. So in shadow mode
// nothing is awaited on the request path at all; the row is written whenever
// the call lands. Only live mode waits, because there the verdict depends on it.
const pendingShadowWrites = new Set<Promise<void>>();

function writeInBackground(work: Promise<void>): void {
  const p = work.catch(() => {}).finally(() => pendingShadowWrites.delete(p));
  pendingShadowWrites.add(p);
}

/**
 * Await any shadow rows still in flight. For tests, and for a short-lived
 * process that would otherwise exit before a row is written.
 */
export async function flushDecisionShadow(): Promise<void> {
  while (pendingShadowWrites.size > 0) {
    await Promise.allSettled([...pendingShadowWrites]);
  }
}

function beginDecisionShadow(args: ClassifyArgs): ShadowHandle {
  let layer;
  try {
    layer = decisionLayer();
  } catch {
    return NO_SHADOW;
  }
  // Nothing to record against without a vault, and nothing to ask without a
  // provider. Either way the classifier runs exactly as it always did.
  if (!args.vault) return NO_SHADOW;
  if (!layer.provider) {
    // Still worth one row: "the layer was off, and here is why" is the first
    // thing to check when a shadow report comes back empty. Recorded once the
    // real verdict is known, so the row carries what Prevail actually did.
    return {
      settle: async (actual, baselineMs) => {
        writeInBackground((async () => record(args, null, actual, baselineMs, layer.reason ?? "unavailable"))());
        return actual;
      },
    };
  }

  const ctx = baseContext(args);
  // Fire now, await later. By the time the LLM classifier returns, this has
  // almost always already settled.
  const inFlight: Promise<DecisionResult | null> = evaluateDecision(
    layer.provider,
    buildRoutingState(ctx, { privacy: layer.privacy }),
    buildRoutingQuestions(ctx),
    { signal: args.signal },
  ).catch(() => null);

  const finish = async (actual: boolean, baselineMs: number): Promise<boolean> => {
    let result: DecisionResult | null = null;
    try {
      result = await inFlight;
    } catch {
      result = null;
    }
    const liveCtx: RoutingContext = { ...ctx, currentPlan: actual ? "council" : "single" };
    const { proposed, effective } = planRoute(liveCtx, result, { shadow: !layer.live });
    record(args, result, actual, baselineMs, result ? null : "decision provider returned nothing", proposed.mode);
    // In shadow, planRoute already returns today's plan as `effective`, so
    // this is the same boolean that came in. In live mode it is the layer's.
    return effective.mode === "council";
  };

  if (layer.live) {
    // Live mode genuinely needs the answer before it can route.
    return { settle: finish };
  }
  return {
    settle: async (actual, baselineMs) => {
      writeInBackground(finish(actual, baselineMs).then(() => {}));
      return actual;
    },
  };
}

function baseContext(args: ClassifyArgs): RoutingContext {
  const models = args.availableModels ?? 1;
  return {
    prompt: args.userPrompt,
    domain: args.domain ?? null,
    availableModels: models,
    // This hook only ever chooses between one model and a council, so the
    // other branches are not offered here. Widening that is a separate
    // change at a call site that can actually honour them.
    councilPossible: models > 1,
    agentPossible: false,
    currentPlan: "single",
  };
}

function record(
  args: ClassifyArgs,
  result: DecisionResult | null,
  actual: boolean,
  baselineMs: number,
  skipped: string | null,
  proposedMode?: string,
): void {
  try {
    if (!args.vault) return;
    const route = result?.answers.route;
    recordDecisionShadow(args.vault, {
      surface: "auto-council",
      domain: args.domain ?? null,
      provider: result ? "typesafe" : null,
      model: result?.model ?? null,
      actual: actual ? "council" : "single",
      proposed: result ? (proposedMode ?? null) : null,
      confidence: route && route.type === "choice" ? route.confidence : null,
      decision_ms: result?.latencyMs ?? null,
      decision_usd: result?.costUsd ?? null,
      baseline_ms: baselineMs,
      // The classifier prompt is fixed-length and the reply is one token, so
      // a character estimate is close enough to compare orders of magnitude.
      baseline_usd: estimateCostUsd(args.cli.kind, "", CLASSIFIER_INSTRUCTION.length + args.userPrompt.length, 8),
      skipped,
    });
  } catch {
    /* a shadow row is never worth disturbing a turn for */
  }
}

// Returns true when the classifier judges the prompt council-worthy.
// Returns false on any classifier failure (offline, error, ambiguous
// reply, abort) — fail-safe to "don't escalate" so the user never
// sees a council fire they didn't ask for due to a flaky call.
export async function classifyAsCouncilWorthy(args: ClassifyArgs): Promise<boolean> {
  // Start the decision layer FIRST, so it runs alongside the LLM classifier
  // rather than after it. In shadow mode nothing on this path ever waits for
  // it: the verdict returns as soon as the classifier is done and the row is
  // written whenever the decision call lands.
  const shadow = beginDecisionShadow(args);

  const prompt = [
    CLASSIFIER_INSTRUCTION,
    "",
    "USER MESSAGE:",
    args.userPrompt.slice(0, 4000),
  ].join("\n");
  let reply = "";
  const startedAt = Date.now();
  try {
    reply = await runChatTurn({
      prompt,
      cwd: args.cwd,
      cli: args.cli,
      // Empty model = CLI default. We don't pin haiku explicitly here
      // because the classifier prompt is short and any small model
      // suffices; users can pin claude-haiku-4-5 in council config if
      // they want predictable cost.
      model: "",
      isFirst: true,
      bare: true,
      signal: args.signal,
      // The classifier should reply with exactly YES or NO. 200 chars
      // catches any model that decides to elaborate before we cut it
      // off — the parser only checks the first token anyway.
      maxOutputChars: 200,
    });
  } catch {
    // The classifier itself failed. Record that too: a shadow report needs to
    // know how often the path it would replace is the one falling over.
    return await shadow.settle(false, Date.now() - startedAt);
  }
  const norm = reply.trim().toUpperCase();
  // Strict YES match — anything else (no answer, prose, NO, error) is
  // treated as a no-go. The classifier was explicitly instructed to
  // default to NO on uncertainty, so this matches its bias.
  const verdict = norm.startsWith("YES");
  return await shadow.settle(verdict, Date.now() - startedAt);
}
