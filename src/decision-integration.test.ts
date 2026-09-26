// The promises this layer makes, as tests.
//
//   1. In shadow mode it cannot change what Prevail does.
//   2. Bunker Mode switches it off completely.
//   3. Without a key, or with a broken provider, routing is untouched.
//   4. The comparison it records is honest about cost.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planRoute, probabilityOf, shouldConveneCouncil, buildRoutingState, type RoutingContext } from "./decision-routing.ts";
import { resolveDecisionLayer, resetDecisionLayerCache, decisionEgressAllowed } from "./decision-config.ts";
import {
  recordDecisionShadow,
  readDecisionShadow,
  summarizeDecisionShadow,
  type DecisionShadowEntry,
} from "./decision-shadow.ts";
import type { DecisionResult } from "./decision.ts";

const ctx: RoutingContext = {
  prompt: "Should I move my rentals into the trust before the refinance?",
  domain: "real-estate",
  availableModels: 4,
  councilPossible: true,
  agentPossible: false,
  currentPlan: "single",
};

/** Jev, very confident that this deserves a council. */
const wantsCouncil: DecisionResult = {
  answers: {
    route: { type: "choice", choice: "council", confidence: 0.95, probabilities: { council: 0.95 } },
    stakes: { type: "score", score: 2, confidence: 0.9, probabilities: { "2": 0.9 } },
  },
  latencyMs: 180,
  costUsd: 0.000021,
  model: "jev-1.13.0",
};

describe("shadow mode cannot change behaviour", () => {
  test("a confident disagreement still leaves the plan alone", () => {
    const { proposed, effective } = planRoute(ctx, wantsCouncil, { shadow: true });
    // It wanted a council and said so loudly.
    expect(proposed.mode).toBe("council");
    // And Prevail did what it was already going to do.
    expect(effective.mode).toBe("single");
    expect(effective.mode).toBe(ctx.currentPlan);
  });

  test("shadow is the default when nobody says otherwise", () => {
    const { effective } = planRoute(ctx, wantsCouncil);
    expect(effective.mode).toBe("single");
  });

  test("live mode is what actually lets it steer", () => {
    const { effective } = planRoute(ctx, wantsCouncil, { shadow: false });
    expect(effective.mode).toBe("council");
  });
});

describe("the deterministic rules own the decision", () => {
  test("no signal means no change", () => {
    expect(shouldConveneCouncil(ctx, null).convene).toBe(false);
    expect(shouldConveneCouncil({ ...ctx, currentPlan: "council" }, null).convene).toBe(true);
  });

  test("an impossible council is refused no matter how sure the model is", () => {
    const solo = { ...ctx, availableModels: 1, councilPossible: false };
    const r = shouldConveneCouncil(solo, wantsCouncil);
    expect(r.convene).toBe(false);
    expect(r.reason).toMatch(/fewer than two runtimes/);
  });

  test("a council recommendation on ordinary stakes is not enough on its own", () => {
    const lowStakes: DecisionResult = {
      ...wantsCouncil,
      answers: {
        route: wantsCouncil.answers.route!,
        stakes: { type: "score", score: 0.4, confidence: 0.9, probabilities: {} },
      },
    };
    // Convening is the expensive branch, so ambiguity keeps the status quo.
    expect(shouldConveneCouncil(ctx, lowStakes).convene).toBe(false);
  });

  test("an unsure model is ignored entirely", () => {
    const unsure: DecisionResult = {
      ...wantsCouncil,
      answers: {
        route: { type: "choice", choice: "council", confidence: 0.3, probabilities: {} },
        stakes: { type: "score", score: 2, confidence: 0.2, probabilities: {} },
      },
    };
    expect(shouldConveneCouncil(ctx, unsure).convene).toBe(false);
  });
});

describe("the council rule reads the distribution, not just the winner", () => {
  // These are the numbers the real service returned on 2026-09-20 for
  // "Should I take the promotion that pays more but removes my equity?".
  const realJudgmentCall: DecisionResult = {
    answers: {
      route: {
        type: "choice",
        choice: "council",
        confidence: 0.31,
        probabilities: { single: 0.07, council: 0.54, more_context: 0.39 },
      },
      stakes: { type: "score", score: 2.0, confidence: 1.0, probabilities: { "2": 1.0 } },
    },
    latencyMs: 526,
    costUsd: 0.00002507,
    model: "jev-1.13.0",
  };

  test("a high-stakes call where one model is nearly ruled out convenes", () => {
    // The winner only led 0.54 to 0.39 and the vendor's confidence read 0.31,
    // so an argmax-plus-confidence rule called this "not decisive". But the
    // model put `single` at 0.07: it was not undecided about whether one
    // model would do, only about how to escalate.
    const r = shouldConveneCouncil(ctx, realJudgmentCall);
    expect(r.convene).toBe(true);
    expect(r.reason).toMatch(/unlikely to be enough/);
  });

  // And the trivial case from the same run.
  const realTrivial: DecisionResult = {
    answers: {
      route: {
        type: "choice",
        choice: "single",
        confidence: 0.74,
        probabilities: { single: 0.83, council: 0, more_context: 0.17 },
      },
      stakes: { type: "score", score: 0.37, confidence: 0.44, probabilities: {} },
    },
    latencyMs: 177,
    costUsd: 0.00002474,
    model: "jev-1.13.0",
  };

  test("a clearly simple request stays on one model", () => {
    const r = shouldConveneCouncil(ctx, realTrivial);
    expect(r.convene).toBe(false);
    expect(r.reason).toMatch(/one model is enough/);
  });

  test("a genuine three-way split keeps the status quo", () => {
    const split: DecisionResult = {
      ...realJudgmentCall,
      answers: {
        route: { type: "choice", choice: "council", confidence: 0.4, probabilities: { single: 0.4, council: 0.35, more_context: 0.25 } },
        stakes: realJudgmentCall.answers.stakes!,
      },
    };
    expect(shouldConveneCouncil(ctx, split).convene).toBe(false);
    expect(shouldConveneCouncil({ ...ctx, currentPlan: "council" }, split).convene).toBe(true);
  });

  test("low probability on single is still not enough when the stakes are ordinary", () => {
    const lowStakes: DecisionResult = {
      ...realJudgmentCall,
      answers: {
        route: realJudgmentCall.answers.route!,
        stakes: { type: "score", score: 0.3, confidence: 0.9, probabilities: {} },
      },
    };
    expect(shouldConveneCouncil(ctx, lowStakes).convene).toBe(false);
  });

  test("probabilityOf reports an unmentioned option as zero, and absence as unknown", () => {
    const withDist = { type: "choice", choice: "council", confidence: 0.9, probabilities: { council: 0.9 } } as const;
    expect(probabilityOf(withDist, "single")).toBe(0);
    const noDist = { type: "choice", choice: "council", confidence: 0.9, probabilities: {} } as const;
    expect(probabilityOf(noDist, "single")).toBeNull();
  });
});

describe("privacy", () => {
  test("signals mode never puts the request on the wire", () => {
    const s = buildRoutingState(ctx, { privacy: "signals" });
    expect(s.request).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("rentals");
    expect(s.domain).toBe("real-estate");
  });

  test("redacted is the default and strips the obvious identifiers", () => {
    const s = buildRoutingState(
      { ...ctx, prompt: "email me at a@b.com about the $12,500 wire, call 555-123-4567" },
    );
    const text = String(s.request);
    expect(text).not.toContain("a@b.com");
    expect(text).not.toContain("12,500");
    expect(text).not.toContain("555-123-4567");
    expect(text).toContain("[email]");
  });

  test("full mode is opt-in and sends the text verbatim", () => {
    const s = buildRoutingState(ctx, { privacy: "full" });
    expect(String(s.request)).toContain("rentals");
  });
});

describe("the gate", () => {
  let dir = "";
  const prevCfg = process.env.PREVAIL_CONFIG_DIR;
  const prevBunker = process.env.PREVAIL_BUNKER;
  const prevKey = process.env.PREVAIL_TYPESAFE_KEY;

  const writeCfg = (cfg: Record<string, unknown>) =>
    writeFileSync(join(dir, "config.json"), JSON.stringify({ vaultPath: "/tmp/v", ...cfg }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prevail-decision-"));
    process.env.PREVAIL_CONFIG_DIR = dir;
    delete process.env.PREVAIL_BUNKER;
    process.env.PREVAIL_TYPESAFE_KEY = "test-key";
    resetDecisionLayerCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevCfg === undefined) delete process.env.PREVAIL_CONFIG_DIR; else process.env.PREVAIL_CONFIG_DIR = prevCfg;
    if (prevBunker === undefined) delete process.env.PREVAIL_BUNKER; else process.env.PREVAIL_BUNKER = prevBunker;
    if (prevKey === undefined) delete process.env.PREVAIL_TYPESAFE_KEY; else process.env.PREVAIL_TYPESAFE_KEY = prevKey;
    resetDecisionLayerCache();
  });

  test("off by default, even with a key sitting in the environment", () => {
    writeCfg({});
    const l = resolveDecisionLayer();
    expect(l.provider).toBeNull();
    expect(l.reason).toMatch(/off/);
  });

  test("Bunker Mode disables the layer outright", () => {
    writeCfg({ decisionProvider: "typesafe", decisionMode: "live" });
    process.env.PREVAIL_BUNKER = "1";
    expect(decisionEgressAllowed()).toBe(false);
    const l = resolveDecisionLayer();
    expect(l.provider).toBeNull();
    expect(l.live).toBe(false);
    expect(l.reason).toMatch(/Bunker Mode/);
  });

  test("a configured provider with no key stays off and says why", () => {
    writeCfg({ decisionProvider: "typesafe" });
    delete process.env.PREVAIL_TYPESAFE_KEY;
    const l = resolveDecisionLayer();
    expect(l.provider).toBeNull();
    expect(l.reason).toMatch(/PREVAIL_TYPESAFE_KEY/);
  });

  test("turning the provider on gives shadow mode, not live", () => {
    writeCfg({ decisionProvider: "typesafe" });
    const l = resolveDecisionLayer();
    expect(l.provider).not.toBeNull();
    expect(l.live).toBe(false);
    expect(l.privacy).toBe("redacted");
  });

  test("live requires saying live", () => {
    writeCfg({ decisionProvider: "typesafe", decisionMode: "live" });
    expect(resolveDecisionLayer().live).toBe(true);
  });

  test("a garbled mode falls back to shadow rather than live", () => {
    writeCfg({ decisionProvider: "typesafe", decisionMode: "LIVE!" });
    expect(resolveDecisionLayer().live).toBe(false);
  });
});

describe("the shadow ledger", () => {
  let vault = "";
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "prevail-vault-"));
    mkdirSync(join(vault, "build", "_meta"), { recursive: true });
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  const row = (over: Partial<DecisionShadowEntry> = {}) => ({
    surface: "auto-council" as const,
    domain: "real-estate",
    provider: "typesafe",
    model: "jev-1.13.0",
    actual: "council",
    proposed: "council",
    confidence: 0.9,
    decision_ms: 180,
    decision_usd: 0.00002,
    baseline_ms: 900,
    baseline_usd: 0.004,
    skipped: null,
    ...over,
  });

  test("agreement is derived from the recorded values, not taken on trust", () => {
    const e = recordDecisionShadow(vault, row({ actual: "single", proposed: "council" }));
    expect(e?.agreed).toBe(false);
    const same = recordDecisionShadow(vault, row());
    expect(same?.agreed).toBe(true);
  });

  test("a round trip through the file preserves both sides", () => {
    recordDecisionShadow(vault, row());
    const back = readDecisionShadow(vault);
    expect(back).toHaveLength(1);
    expect(back[0]!.actual).toBe("council");
    expect(back[0]!.proposed).toBe("council");
    expect(back[0]!.decision_usd).toBeCloseTo(0.00002, 8);
  });

  test("a write into a nonexistent vault is dropped, not thrown", () => {
    expect(() => recordDecisionShadow("", row())).not.toThrow();
    expect(recordDecisionShadow("", row())).toBeNull();
    expect(readDecisionShadow("/no/such/vault")).toEqual([]);
  });

  test("savings only count the calls it would actually have avoided", () => {
    const entries = [
      // Would have downgraded a council to a single model: a real saving.
      row({ actual: "council", proposed: "single" }),
      // Would have UPGRADED to a council: that costs more, not less.
      row({ actual: "single", proposed: "council" }),
      // Agreed: no change either way.
      row(),
    ].map((r) => recordDecisionShadow(vault, r)!);

    const s = summarizeDecisionShadow(entries);
    expect(s.compared).toBe(3);
    expect(s.agreed).toBe(1);
    expect(s.agreementRate).toBeCloseTo(1 / 3, 5);
    // One avoided council at $0.004, minus three decision calls at $0.00002.
    expect(s.estimatedSavingsUsd).toBeCloseTo(0.004 - 3 * 0.00002, 8);
    expect(s.disagreements[0]!.count).toBe(1);
  });

  test("skipped rows are counted and explained rather than silently dropped", () => {
    recordDecisionShadow(vault, row({ proposed: null, provider: null, skipped: "Bunker Mode: the decision layer is a cloud call" }));
    recordDecisionShadow(vault, row({ proposed: null, provider: null, skipped: "Bunker Mode: the decision layer is a cloud call" }));
    recordDecisionShadow(vault, row());
    const s = summarizeDecisionShadow(readDecisionShadow(vault));
    expect(s.skipped).toBe(2);
    expect(s.compared).toBe(1);
    expect(s.skipReasons[0]).toEqual({ reason: "Bunker Mode: the decision layer is a cloud call", count: 2 });
  });

  test("an empty ledger summarizes without dividing by zero", () => {
    const s = summarizeDecisionShadow([]);
    expect(s.agreementRate).toBeNull();
    expect(s.decisionMsP50).toBeNull();
    expect(s.estimatedSavingsUsd).toBe(0);
  });
});
