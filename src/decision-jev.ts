// JevProvider: the one file that knows anything about TypeSafe AI.
//
// Everything vendor-specific lives here - the URL, the auth header, the wire
// vocabulary, the price list. The rest of Prevail talks to the DecisionProvider
// interface in decision.ts and would not notice this being replaced.
//
// API as documented at https://docs.typesafe.ai/api.md, read 2026-09-20:
//   POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer <key>
//   body    { state, model, questions }
//   answers noul -> { noul: 0..1 }
//           choice -> { choice, confidence, probabilities }
//           score  -> { score, confidence, legend, probabilities }
//   errors  401 bad key, 422 validation, 429 rate limit, 529 overloaded
//   limits  64k context total, 32k for state plus the longest question
//   price   $0.042 per 1M input tokens, output tokens free

import {
  DECISION_TIMEOUT_MS,
  sanitizeAnswers,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionResult,
  type EvaluateOptions,
} from "./decision.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

/** USD per input token. Output tokens are free on this model. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * Documented budget is 64k total and 32k for state plus the longest question.
 * We cap the state well under that: a routing decision that needs more than a
 * few thousand tokens of context is a decision worth making with a real model.
 * Truncating is also a privacy win, see buildState in decision-routing.ts.
 */
const MAX_STATE_CHARS = 8_000;

// ── Wire types ─────────────────────────────────────────────────────────

interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, Record<string, unknown>>;
  usage?: JevUsage;
}

// ── Circuit breaker ────────────────────────────────────────────────────
// This sits on the hot path in front of a user's request, so it must never
// retry. A retry costs more latency than the decision can possibly save. When
// the service rate-limits us or falls over, we stop asking for a while and
// Prevail routes exactly as it did before this layer existed.

const COOLDOWN_MS = 60_000;

class Breaker {
  private openUntil = 0;
  private reason = "";
  open(ms: number, why: string) {
    this.openUntil = Date.now() + ms;
    this.reason = why;
  }
  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }
  why(): string {
    return this.reason;
  }
  reset() {
    this.openUntil = 0;
    this.reason = "";
  }
}

export interface JevProviderOptions {
  /**
   * How to find the API key. Injected so this module never reaches into
   * Prevail's config or the Keychain itself, and so tests can supply one.
   */
  apiKey?: () => string | null | undefined;
  model?: string;
  endpoint?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export class JevProvider implements DecisionProvider {
  readonly id = "jev";
  private readonly getKey: () => string | null | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly doFetch: typeof fetch;
  private readonly breaker = new Breaker();

  constructor(opts: JevProviderOptions = {}) {
    this.getKey = opts.apiKey ?? (() => process.env.TYPESAFE_API_KEY);
    this.model = opts.model ?? DEFAULT_MODEL;
    this.endpoint = opts.endpoint ?? ENDPOINT;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    const key = this.getKey();
    if (!key) return "no TypeSafe API key configured";
    if (this.breaker.isOpen()) return `cooling off after ${this.breaker.why()}`;
    return null;
  }

  async evaluate(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts: EvaluateOptions = {},
  ): Promise<DecisionResult | null> {
    const key = this.getKey();
    if (!key || this.breaker.isOpen()) return null;
    if (Object.keys(questions).length === 0) return null;

    const body = JSON.stringify({
      state: clampState(state),
      model: this.model,
      questions: toWireQuestions(questions),
    });

    // One deadline covering the whole call, ours rather than the vendor's.
    const timeoutMs = opts.timeoutMs ?? DECISION_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onOuterAbort = () => ac.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

    const started = Date.now();
    try {
      const res = await this.doFetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: ac.signal,
      });

      if (!res.ok) {
        // The service explains itself in {"detail":{"error_type","message"}}.
        // Carry that into the cooldown reason so a status line can say "bad
        // API key" rather than "unavailable".
        const why = await readErrorDetail(res);
        // 429 and 529 are "come back later", so stop asking for a minute.
        // 401 means the key is wrong and will stay wrong until someone fixes
        // it, so back off much harder rather than hammering with a bad key.
        if (res.status === 429 || res.status === 529) {
          this.breaker.open(COOLDOWN_MS, `HTTP ${res.status}${why}`);
        } else if (res.status === 401) {
          this.breaker.open(10 * COOLDOWN_MS, `HTTP 401${why || " (bad API key)"}`);
        }
        return null;
      }

      const json = (await res.json()) as JevResponse;
      const latencyMs = Date.now() - started;
      const answers = sanitizeAnswers(questions, normalizeAnswers(json.answers ?? {}));
      // Answers that all failed validation is a wire-shape problem, not a
      // decision. Report nothing rather than a confidently empty result.
      if (Object.keys(answers).length === 0) return null;

      this.breaker.reset();
      return {
        answers,
        latencyMs,
        costUsd: (json.usage?.input_tokens ?? 0) * USD_PER_INPUT_TOKEN,
        model: json.model ?? this.model,
      };
    } catch {
      // Timeout, abort, DNS, TLS, malformed JSON. All the same to the caller:
      // there is no hint, carry on.
      return null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

// ── Wire translation ───────────────────────────────────────────────────

function toWireQuestions(
  questions: Record<string, DecisionQuestion>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      out[key] = q.criteria
        ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
        : { type: "noul", instructions: q.instructions };
    } else if (q.type === "choice") {
      out[key] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
    } else {
      out[key] = { type: "score", instructions: q.instructions, criteria: q.criteria };
    }
  }
  return out;
}

/**
 * Rename the vendor's fields to ours before validation. Jev reports a yes/no
 * probability in a field called `noul`; everywhere else in Prevail that is a
 * probability, and routing code should never have to learn the other word.
 */
function normalizeAnswers(
  answers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, a] of Object.entries(answers)) {
    if (!a || typeof a !== "object") continue;
    if (a.type === "noul") {
      out[key] = { probability: a.noul };
    } else {
      // choice and score already use our names for their fields. `legend` is
      // dropped: it restates the question's own levels back to us.
      out[key] = a;
    }
  }
  return out;
}

function clampState(state: unknown): unknown {
  if (typeof state === "string") {
    return state.length > MAX_STATE_CHARS ? state.slice(0, MAX_STATE_CHARS) : state;
  }
  // An object state is built by us (decision-routing.ts) and is already small,
  // but a runaway field should not blow the context budget.
  const asText = JSON.stringify(state ?? null);
  if (asText.length <= MAX_STATE_CHARS) return state;
  return { truncated: true, preview: asText.slice(0, MAX_STATE_CHARS) };
}

/** Best-effort read of the service's own explanation. Never throws. */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: { message?: string } | string };
    const msg = typeof j.detail === "string" ? j.detail : j.detail?.message;
    return msg ? ` (${String(msg).slice(0, 120)})` : "";
  } catch {
    return "";
  }
}
