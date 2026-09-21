// The decision layer's job is to be ignorable. These tests mostly assert that
// it fails quietly: a decision model that is down, slow, misconfigured or
// lying must leave Prevail routing exactly as it would have anyway.
import { describe, expect, test } from "bun:test";
import {
  isActionable,
  sanitizeAnswers,
  type DecisionQuestion,
} from "./decision.ts";
import { TypeSafeProvider } from "./decision-typesafe.ts";

const questions: Record<string, DecisionQuestion> = {
  needsCouncil: { type: "noul", instructions: "Does this need several models?" },
  route: {
    type: "choice",
    instructions: "How should this be handled?",
    criteria: { single: "one model", council: "several models", agent: "execute" },
  },
  stakes: { type: "score", instructions: "How high are the stakes?", criteria: ["low", "medium", "high"] },
};

describe("sanitizeAnswers", () => {
  test("keeps well formed answers and renames nothing further", () => {
    const out = sanitizeAnswers(questions, {
      needsCouncil: { probability: 0.91 },
      route: { choice: "council", confidence: 0.8, probabilities: { council: 0.8, single: 0.2 } },
      stakes: { score: 1.4, confidence: 0.7, probabilities: { "1": 0.6 } },
    });
    expect(out.needsCouncil).toEqual({ type: "noul", probability: 0.91 });
    expect(out.route).toMatchObject({ type: "choice", choice: "council", confidence: 0.8 });
    expect(out.stakes).toMatchObject({ type: "score", score: 1.4 });
  });

  test("drops a choice the model was never offered", () => {
    // A decision model inventing an option is the case that would route a
    // request somewhere no branch handles.
    const out = sanitizeAnswers(questions, {
      route: { choice: "delete_everything", confidence: 0.99, probabilities: {} },
    });
    expect(out.route).toBeUndefined();
  });

  test("drops probabilities outside 0..1 and non-finite numbers", () => {
    const out = sanitizeAnswers(questions, {
      needsCouncil: { probability: 1.7 },
    });
    expect(out.needsCouncil).toBeUndefined();
    const nan = sanitizeAnswers(questions, { needsCouncil: { probability: Number.NaN } });
    expect(nan.needsCouncil).toBeUndefined();
  });

  test("drops a score outside the levels that were defined", () => {
    expect(sanitizeAnswers(questions, { stakes: { score: 9, confidence: 0.9 } }).stakes).toBeUndefined();
    expect(sanitizeAnswers(questions, { stakes: { score: -1, confidence: 0.9 } }).stakes).toBeUndefined();
  });

  test("filters the probability map to keys that were actually offered", () => {
    const out = sanitizeAnswers(questions, {
      route: { choice: "single", confidence: 0.9, probabilities: { single: 0.9, bogus: 0.4, council: 2 } },
    });
    expect((out.route as { probabilities: Record<string, number> }).probabilities).toEqual({ single: 0.9 });
  });

  test("garbage of every shape yields no answers rather than throwing", () => {
    for (const junk of [null, undefined, 42, "nope", [], { choice: 1 }]) {
      const out = sanitizeAnswers(questions, { route: junk as unknown as Record<string, unknown> });
      expect(out.route).toBeUndefined();
    }
  });
});

describe("isActionable", () => {
  test("an unsure answer is treated as no answer", () => {
    expect(isActionable({ type: "noul", probability: 0.52 })).toBe(false);
    expect(isActionable({ type: "choice", choice: "single", confidence: 0.4, probabilities: {} })).toBe(false);
    expect(isActionable(undefined)).toBe(false);
  });

  test("a confident answer either way is actionable", () => {
    expect(isActionable({ type: "noul", probability: 0.95 })).toBe(true);
    // A confident NO is just as useful as a confident yes.
    expect(isActionable({ type: "noul", probability: 0.05 })).toBe(true);
    expect(isActionable({ type: "choice", choice: "council", confidence: 0.7, probabilities: {} })).toBe(true);
  });
});

// ── TypeSafeProvider ────────────────────────────────────────────────────────

const okBody = {
  model: "jev-1.13.0",
  answers: {
    needsCouncil: { type: "noul", noul: 0.88 },
    route: { type: "choice", choice: "council", confidence: 0.77, probabilities: { council: 0.77 } },
  },
  usage: { input_tokens: 1_000_000, output_tokens: 73 },
};

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("TypeSafeProvider", () => {
  test("is unavailable, and silent, without an API key", async () => {
    const p = new TypeSafeProvider({ apiKey: () => null });
    expect(p.available()).toBe(false);
    expect(p.unavailableReason()).toMatch(/no TypeSafe API key/);
    expect(await p.evaluate("x", questions)).toBeNull();
  });

  test("translates the vendor's yes/no field into a plain probability", async () => {
    const p = new TypeSafeProvider({ apiKey: () => "k", fetchImpl: respond(200, okBody) });
    const r = await p.evaluate("state", questions);
    // Jev calls it `noul` on the wire. Nothing downstream should ever see that.
    expect(r?.answers.needsCouncil).toEqual({ type: "noul", probability: 0.88 });
    expect(JSON.stringify(r?.answers)).not.toContain("noul\":0.88");
  });

  test("prices the call from input tokens only", async () => {
    const p = new TypeSafeProvider({ apiKey: () => "k", fetchImpl: respond(200, okBody) });
    const r = await p.evaluate("state", questions);
    // 1M input tokens at $0.042/Mtok, output free.
    expect(r?.costUsd).toBeCloseTo(0.042, 6);
  });

  test("sends the documented endpoint, auth header and body shape", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const p = new TypeSafeProvider({
      apiKey: () => "secret-key",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await p.evaluate({ prompt: "hi" }, questions);
    expect(seenUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const sent = JSON.parse(String(seenInit?.body));
    expect(sent.model).toBe("jev-latest");
    expect(sent.questions.stakes).toEqual({
      type: "score",
      instructions: "How high are the stakes?",
      criteria: ["low", "medium", "high"],
    });
  });

  test("a rate limit opens a breaker so the hot path stops waiting on it", async () => {
    let calls = 0;
    const p = new TypeSafeProvider({
      apiKey: () => "k",
      fetchImpl: (async () => {
        calls++;
        return new Response("", { status: 429 });
      }) as unknown as typeof fetch,
    });
    expect(await p.evaluate("s", questions)).toBeNull();
    expect(p.available()).toBe(false);
    // The second call must not reach the network at all.
    expect(await p.evaluate("s", questions)).toBeNull();
    expect(calls).toBe(1);
    expect(p.unavailableReason()).toMatch(/429/);
  });

  test("a bad key backs off hard instead of hammering", async () => {
    const p = new TypeSafeProvider({ apiKey: () => "bad", fetchImpl: respond(401, {}) });
    await p.evaluate("s", questions);
    expect(p.unavailableReason()).toMatch(/401/);
  });

  test("a timeout is a null, not an exception", async () => {
    const p = new TypeSafeProvider({
      apiKey: () => "k",
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    expect(await p.evaluate("s", questions, { timeoutMs: 20 })).toBeNull();
  });

  test("malformed and hostile responses yield null, never a throw", async () => {
    const bodies = [
      "not json at all",
      JSON.stringify({ answers: null }),
      JSON.stringify({ answers: { route: { type: "choice", choice: "nope", confidence: 0.9 } } }),
      JSON.stringify({}),
    ];
    for (const b of bodies) {
      const p = new TypeSafeProvider({
        apiKey: () => "k",
        fetchImpl: (async () => new Response(b, { status: 200 })) as unknown as typeof fetch,
      });
      expect(await p.evaluate("s", questions)).toBeNull();
    }
  });

  test("a network explosion yields null", async () => {
    const p = new TypeSafeProvider({
      apiKey: () => "k",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(await p.evaluate("s", questions)).toBeNull();
  });

  test("an oversized string state is truncated rather than sent whole", async () => {
    let sentLen = 0;
    const p = new TypeSafeProvider({
      apiKey: () => "k",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sentLen = JSON.parse(String(init.body)).state.length;
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await p.evaluate("x".repeat(50_000), questions);
    expect(sentLen).toBe(8_000);
  });
});
