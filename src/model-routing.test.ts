import { describe, expect, test } from "bun:test";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  difficultyBand,
  learnedPreference,
  recordRouteOverride,
  readRouteOverrides,
  routeLearningFile,
  bucketKey,
  type RouteOverride,
} from "./route-learning.ts";
import {
  chooseModel,
  routeWithFallback,
  metaFor,
  deriveHeuristics,
  makeCandidate,
  normalizeBias,
  shouldRunClassifier,
  parseClassifyResponse,
  cascadeEnabled,
  pickCheaperCandidate,
  cascadeShouldEscalate,
  type RouteCandidate,
  type RouteBias,
} from "./model-routing.ts";

// Helper: candidates for a single-provider Claude install.
function claudeCandidates(): RouteCandidate[] {
  return [
    makeCandidate("claude", "opus"),
    makeCandidate("claude", "sonnet"),
    makeCandidate("claude", "haiku"),
  ];
}

describe("metaFor", () => {
  test("known substrings map to tiers", () => {
    expect(metaFor("opus").tier).toBe(4);
    expect(metaFor("sonnet").tier).toBe(3);
    expect(metaFor("haiku").tier).toBe(2);
    expect(metaFor("claude-haiku-4-5").tier).toBe(2);
    expect(metaFor("gemini-3-pro").tier).toBe(4);
    expect(metaFor("gemini-2.5-flash").tier).toBe(2);
  });
  test("unknown id falls back to a safe mid default", () => {
    const m = metaFor("totally-made-up-model-9000");
    expect(m.tier).toBe(2);
    expect(m.tools).toBe(true);
    expect(m.vision).toBe(false);
  });
});

describe("normalizeBias", () => {
  test("defaults to balanced", () => {
    expect(normalizeBias(undefined)).toBe("balanced");
    expect(normalizeBias("")).toBe("balanced");
    expect(normalizeBias("nonsense")).toBe("balanced");
    expect(normalizeBias("economy")).toBe("economy");
    expect(normalizeBias("QUALITY")).toBe("quality");
  });
});

describe("chooseModel — single model", () => {
  test("one model total = a no-op pick, still returns it", () => {
    const d = chooseModel({
      message: "anything at all",
      candidates: [makeCandidate("claude", "sonnet")],
      bias: "balanced",
    });
    expect(d.model).toBe("sonnet");
    expect(d.confidence).toBeGreaterThan(0.9);
    expect(d.reason).toContain("only one model");
  });
});

describe("chooseModel — Claude-only across bias, moderate difficulty", () => {
  const moderate = { difficulty: 3 };
  test("economy routes down to the cheap tier", () => {
    const d = chooseModel({ message: "x", candidates: claudeCandidates(), bias: "economy", classified: moderate });
    expect(metaFor(d.model).tier).toBe(2); // haiku
  });
  test("balanced routes to the mid tier", () => {
    const d = chooseModel({ message: "x", candidates: claudeCandidates(), bias: "balanced", classified: moderate });
    expect(metaFor(d.model).tier).toBe(3); // sonnet
  });
  test("quality routes up to the top tier", () => {
    const d = chooseModel({ message: "x", candidates: claudeCandidates(), bias: "quality", classified: moderate });
    expect(metaFor(d.model).tier).toBe(4); // opus
  });
});

describe("chooseModel — mixed providers", () => {
  const mixed: RouteCandidate[] = [
    makeCandidate("claude", "opus"),
    makeCandidate("claude", "haiku"),
    makeCandidate("ollama", "llama3.1"),
    makeCandidate("openai", "gpt-4o-mini"),
  ];
  test("a hard prompt on quality bias goes to a top-tier model", () => {
    const d = chooseModel({ message: "x", candidates: mixed, bias: "quality", classified: { difficulty: 5 } });
    expect(metaFor(d.model).tier).toBe(4);
    expect(d.model).toBe("opus");
  });
  test("an easy prompt on economy bias favors a cheap/local model", () => {
    const d = chooseModel({ message: "hi", candidates: mixed, bias: "economy", classified: { difficulty: 1 } });
    expect(metaFor(d.model).tier).toBeLessThanOrEqual(2);
  });
});

describe("chooseModel — privacy: local-only candidate set", () => {
  test("when caller passes only local candidates, the pick is local", () => {
    const localCands: RouteCandidate[] = [makeCandidate("ollama", "llama3.1"), makeCandidate("ollama", "qwen2.5")];
    const d = chooseModel({ message: "design a system", candidates: localCands, bias: "balanced", localOnly: true, classified: { difficulty: 4 } });
    expect(d.cli).toBe("ollama");
    expect(d.reason).toContain("local only");
  });
});

describe("shouldRunClassifier — bunker gates the classifier off", () => {
  test("local-only with a cloud-only classifier is skipped", () => {
    expect(shouldRunClassifier({ ambiguous: true, hasClassifierCli: true, localOnly: true, classifierIsLocal: false })).toBe(false);
  });
  test("local-only with a local classifier is allowed", () => {
    expect(shouldRunClassifier({ ambiguous: true, hasClassifierCli: true, localOnly: true, classifierIsLocal: true })).toBe(true);
  });
  test("obvious (non-ambiguous) prompts never spend a classifier call", () => {
    expect(shouldRunClassifier({ ambiguous: false, hasClassifierCli: true, localOnly: false, classifierIsLocal: true })).toBe(false);
  });
  test("no classifier cli means skip", () => {
    expect(shouldRunClassifier({ ambiguous: true, hasClassifierCli: false, localOnly: false, classifierIsLocal: true })).toBe(false);
  });
});

describe("chooseModel — capability filters", () => {
  test("tools-required drops tool-less models", () => {
    const cands: RouteCandidate[] = [
      makeCandidate("ollama", "qwen2.5"), // tools:false
      makeCandidate("claude", "sonnet"),  // tools:true
    ];
    const d = chooseModel({ message: "use my tools", candidates: cands, bias: "balanced", toolsRequired: true, classified: { difficulty: 3 } });
    expect(metaFor(d.model).tools).toBe(true);
    expect(d.model).toBe("sonnet");
    expect(d.reason).toContain("tools needed");
  });
  test("huge prompt forces a long-context model", () => {
    const cands: RouteCandidate[] = [
      makeCandidate("codex", "small-ctx-unknown"), // default ctx 8192
      makeCandidate("claude", "sonnet"),          // ctx 200000
    ];
    const huge = "word ".repeat(20000); // ~100k chars => ~25k tokens
    const d = chooseModel({ message: huge, candidates: cands, bias: "balanced" });
    expect(metaFor(d.model).ctx).toBeGreaterThanOrEqual(100000);
    expect(d.reason).toContain("long context");
  });
});

describe("chooseModel — heuristic fallback when classifier is null", () => {
  test("null classifier uses the heuristic difficulty (easy prompt -> low tier)", () => {
    const d = chooseModel({ message: "hi thanks", candidates: claudeCandidates(), bias: "balanced", classified: null });
    expect(d.usedClassifier).toBe(false);
    expect(metaFor(d.model).tier).toBeLessThanOrEqual(3);
  });
  test("null classifier, hard heuristic prompt -> higher tier", () => {
    const hard = "Please refactor and optimize this algorithm:\n```js\nfunction f(){}\n``` prove it is correct";
    const d = chooseModel({ message: hard, candidates: claudeCandidates(), bias: "balanced", classified: null });
    expect(d.usedClassifier).toBe(false);
    expect(metaFor(d.model).tier).toBeGreaterThanOrEqual(3);
  });
});

describe("routeWithFallback — router throws -> safe default", () => {
  test("empty candidate set never throws; falls back to the provided default", () => {
    const d = routeWithFallback(
      { message: "x", candidates: [], bias: "balanced" },
      { cli: "claude", model: "" },
    );
    expect(d.cli).toBe("claude");
    expect(d.model).toBe(""); // empty = provider default = today's behavior
    expect(d.reason).toContain("router unavailable");
  });
  test("chooseModel itself throws on empty candidates", () => {
    expect(() => chooseModel({ message: "x", candidates: [], bias: "balanced" })).toThrow();
  });
});

describe("deriveHeuristics", () => {
  test("greetings are easy and non-ambiguous", () => {
    const h = deriveHeuristics("hi thanks");
    expect(h.difficultyPrior).toBeLessThanOrEqual(2);
    expect(h.ambiguous).toBe(false);
  });
  test("code + hard keywords are hard and non-ambiguous", () => {
    const h = deriveHeuristics("refactor this ```code``` and prove correctness of the algorithm");
    expect(h.difficultyPrior).toBeGreaterThanOrEqual(4);
    expect(h.ambiguous).toBe(false);
  });
  test("a plain mid-length question is ambiguous", () => {
    const h = deriveHeuristics("What are the pros and cons of moving my database to a new region?");
    expect(h.ambiguous).toBe(true);
  });
});

describe("parseClassifyResponse", () => {
  test("parses a clean object", () => {
    const r = parseClassifyResponse('{"difficulty": 4, "capabilities": ["reasoning","code"]}');
    expect(r?.difficulty).toBe(4);
    expect(r?.capabilities).toEqual(["reasoning", "code"]);
  });
  test("strips fences and trailing prose", () => {
    const r = parseClassifyResponse('```json\n{"difficulty": 2, "capabilities": []}\n```\ndone');
    expect(r?.difficulty).toBe(2);
  });
  test("clamps out-of-range difficulty", () => {
    expect(parseClassifyResponse('{"difficulty": 9}')?.difficulty).toBe(5);
    expect(parseClassifyResponse('{"difficulty": 0}')?.difficulty).toBe(1);
  });
  test("returns null on junk", () => {
    expect(parseClassifyResponse("not json at all")).toBeNull();
    expect(parseClassifyResponse("")).toBeNull();
  });
});

// Determinism: the same input yields the same route (pure function, stable sort).
describe("chooseModel — determinism", () => {
  test("identical inputs produce identical decisions", () => {
    const mk = (): RouteCandidate[] => [makeCandidate("claude", "opus"), makeCandidate("claude", "haiku"), makeCandidate("claude", "sonnet")];
    const biases: RouteBias[] = ["economy", "balanced", "quality"];
    for (const bias of biases) {
      const a = chooseModel({ message: "steady prompt", candidates: mk(), bias, classified: { difficulty: 3 } });
      const b = chooseModel({ message: "steady prompt", candidates: mk(), bias, classified: { difficulty: 3 } });
      expect(a.model).toBe(b.model);
    }
  });
});

// ── Layer 4 cascade (opt-in) ────────────────────────────────────────────────

describe("cascadeEnabled", () => {
  test("explicit flag wins over env", () => {
    expect(cascadeEnabled(true, undefined)).toBe(true);
    expect(cascadeEnabled(false, "1")).toBe(false); // flag false overrides truthy env
    expect(cascadeEnabled(true, "0")).toBe(true);
  });
  test("defaults OFF; only affirmative env turns it on", () => {
    expect(cascadeEnabled(undefined, undefined)).toBe(false);
    expect(cascadeEnabled(undefined, "")).toBe(false);
    expect(cascadeEnabled(undefined, "0")).toBe(false);
    expect(cascadeEnabled(undefined, "false")).toBe(false);
    for (const v of ["1", "true", "on", "yes", "TRUE", "On"]) {
      expect(cascadeEnabled(undefined, v)).toBe(true);
    }
  });
});

describe("pickCheaperCandidate", () => {
  const cands = (): RouteCandidate[] => [
    makeCandidate("claude", "opus"),   // tier 4
    makeCandidate("claude", "sonnet"), // tier 3
    makeCandidate("claude", "haiku"),  // tier 2
  ];
  test("drops exactly one rung (next tier down), not to the floor", () => {
    // target tier 4 => cheaper should be sonnet (tier 3), not haiku (tier 2).
    expect(pickCheaperCandidate(cands(), 4)?.model).toBe("sonnet");
    // target tier 3 => haiku (tier 2).
    expect(pickCheaperCandidate(cands(), 3)?.model).toBe("haiku");
  });
  test("null when nothing is cheaper", () => {
    expect(pickCheaperCandidate(cands(), 2)).toBeNull(); // nothing below tier 2 here
    expect(pickCheaperCandidate([makeCandidate("claude", "opus")], 4)).toBeNull();
  });
  test("deterministic across call order", () => {
    const a = pickCheaperCandidate(cands(), 4)?.model;
    const b = pickCheaperCandidate([...cands()].reverse(), 4)?.model;
    expect(a).toBe(b);
  });
});

describe("cascadeShouldEscalate", () => {
  const good = "The capital of France is Paris. It has been the capital since the 10th century.";
  test("stays on the cheap model for a confident, moderate answer", () => {
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.7, reply: good })).toBe(false);
  });
  test("escalates on an empty or truncated cheap answer", () => {
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.7, reply: "" })).toBe(true);
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.7, reply: " " })).toBe(true);
  });
  test("escalates when the cheap model self-reports uncertainty", () => {
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.7, reply: "I'm not sure, this is tricky." })).toBe(true);
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.7, reply: "I don't have enough context to answer." })).toBe(true);
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.7, reply: "I can't help with that." })).toBe(true);
  });
  test("escalates on a hard-middle difficulty or an unsure route", () => {
    expect(cascadeShouldEscalate({ difficulty: 4, confidence: 0.7, reply: good })).toBe(true);
    expect(cascadeShouldEscalate({ difficulty: 3, confidence: 0.4, reply: good })).toBe(true);
  });
});

// End-to-end intent: the router picks a target for the ambiguous middle, cascade
// starts one rung cheaper, and escalation lands back on that target.
describe("cascade integration (router + cheap pick + escalate)", () => {
  const cands = (): RouteCandidate[] => [
    makeCandidate("claude", "opus"),
    makeCandidate("claude", "sonnet"),
    makeCandidate("claude", "haiku"),
  ];
  test("ambiguous moderate prompt: cheap start is a rung below the target", () => {
    // A bare, unclassified moderate prompt with no easy/hard keyword lands in the
    // ambiguous middle (difficulty 3, not obvious-easy/hard).
    const prompt = "Tell me about the history of the coffee bean and how it spread across different continents over time.";
    const h = deriveHeuristics(prompt);
    expect(h.ambiguous).toBe(true);
    expect(h.difficultyPrior).toBe(3);
    const decision = chooseModel({ message: prompt, candidates: cands(), bias: "balanced" });
    const cheap = pickCheaperCandidate(cands(), decision.tier);
    // There is a cheaper rung, and it is strictly weaker than the target.
    expect(cheap).not.toBeNull();
    expect(metaFor(cheap!.model).tier).toBeLessThan(decision.tier);
  });
  test("obvious bands are not ambiguous, so cascade never engages there", () => {
    expect(deriveHeuristics("hi").ambiguous).toBe(false);            // obvious-easy
    expect(deriveHeuristics("Please debug and refactor this algorithm: ```for(;;){}```").ambiguous).toBe(false); // obvious-hard
  });
});

// ── Layer 5 learned/personalized router (v1) ────────────────────────────────

describe("difficultyBand + bucketKey", () => {
  test("bands match the router's light/moderate/hard language", () => {
    expect(difficultyBand(1)).toBe("light");
    expect(difficultyBand(2)).toBe("light");
    expect(difficultyBand(3)).toBe("moderate");
    expect(difficultyBand(4)).toBe("hard");
    expect(difficultyBand(5)).toBe("hard");
    expect(difficultyBand(NaN)).toBe("moderate"); // safe default
  });
  test("bucket key folds empty/general into one bucket", () => {
    expect(bucketKey("", "moderate")).toBe("general::moderate");
    expect(bucketKey("general", "moderate")).toBe("general::moderate");
    expect(bucketKey("wealth", "hard")).toBe("wealth::hard");
  });
});

describe("learnedPreference (pure)", () => {
  const ov = (domain: string, band: RouteOverride["band"], toModel: string, ts = 0): RouteOverride =>
    ({ ts, domain, band, fromModel: "sonnet", toModel });

  test("empty history => null", () => {
    expect(learnedPreference([], "wealth", "moderate")).toBeNull();
  });
  test("below threshold => null", () => {
    expect(learnedPreference([ov("wealth", "moderate", "opus")], "wealth", "moderate", 2)).toBeNull();
  });
  test(">= threshold in the bucket => that model", () => {
    const hist = [ov("wealth", "moderate", "opus", 1), ov("wealth", "moderate", "opus", 2)];
    expect(learnedPreference(hist, "wealth", "moderate", 2)).toBe("opus");
  });
  test("only counts the matching (domain, band) bucket", () => {
    const hist = [
      ov("wealth", "moderate", "opus", 1),
      ov("wealth", "hard", "opus", 2),      // wrong band
      ov("health", "moderate", "opus", 3),  // wrong domain
    ];
    expect(learnedPreference(hist, "wealth", "moderate", 2)).toBeNull(); // only 1 in-bucket
  });
  test("ties break toward the most recent, then model id (deterministic)", () => {
    const hist = [
      ov("wealth", "moderate", "opus", 10), ov("wealth", "moderate", "opus", 11),
      ov("wealth", "moderate", "sonnet", 20), ov("wealth", "moderate", "sonnet", 21),
    ];
    // opus and sonnet both hit 2; sonnet's overrides are more recent.
    expect(learnedPreference(hist, "wealth", "moderate", 2)).toBe("sonnet");
  });
});

describe("chooseModel — learned preference consult", () => {
  const cands = (): RouteCandidate[] => [
    makeCandidate("claude", "opus"),
    makeCandidate("claude", "sonnet"),
    makeCandidate("claude", "haiku"),
  ];
  const moderate = { difficulty: 3 }; // difficultyBand(3) === "moderate"

  test("empty/absent store => decision is unchanged vs the pre-learning pick", () => {
    const base = chooseModel({ message: "x", candidates: cands(), bias: "balanced", classified: moderate, domain: "wealth" });
    const withEmpty = chooseModel({ message: "x", candidates: cands(), bias: "balanced", classified: moderate, domain: "wealth", overrides: [] });
    expect(withEmpty.model).toBe(base.model);
    expect(base.model).toBe("sonnet"); // moderate + balanced => sonnet by heuristic
  });

  test(">= 2 overrides to opus in the bucket => prefers opus when available", () => {
    const overrides: RouteOverride[] = [
      { ts: 1, domain: "wealth", band: "moderate", fromModel: "sonnet", toModel: "opus" },
      { ts: 2, domain: "wealth", band: "moderate", fromModel: "sonnet", toModel: "opus" },
    ];
    const d = chooseModel({ message: "x", candidates: cands(), bias: "balanced", classified: moderate, domain: "wealth", overrides });
    expect(d.model).toBe("opus");
    expect(d.reason).toContain("learned");
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("learned pref is ignored when that model is not in the candidate set", () => {
    const overrides: RouteOverride[] = [
      { ts: 1, domain: "wealth", band: "moderate", fromModel: "sonnet", toModel: "opus" },
      { ts: 2, domain: "wealth", band: "moderate", fromModel: "sonnet", toModel: "opus" },
    ];
    const noOpus = [makeCandidate("claude", "sonnet"), makeCandidate("claude", "haiku")];
    const d = chooseModel({ message: "x", candidates: noOpus, bias: "balanced", classified: moderate, domain: "wealth", overrides });
    expect(d.model).toBe("sonnet"); // unchanged: opus not installed
    expect(d.reason).not.toContain("learned");
  });

  test("wrong-bucket overrides do not affect the pick", () => {
    const overrides: RouteOverride[] = [
      { ts: 1, domain: "wealth", band: "hard", fromModel: "sonnet", toModel: "opus" },
      { ts: 2, domain: "wealth", band: "hard", fromModel: "sonnet", toModel: "opus" },
    ];
    // This turn is moderate, so the hard-bucket preference must not apply.
    const d = chooseModel({ message: "x", candidates: cands(), bias: "balanced", classified: moderate, domain: "wealth", overrides });
    expect(d.model).toBe("sonnet");
  });
});

describe("route-learning store (write + read, malformed-tolerant)", () => {
  test("records round-trip and malformed lines are skipped", () => {
    const vault = mkdtempSync(join(tmpdir(), "prevail-routelearn-"));
    try {
      recordRouteOverride(vault, { domain: "wealth", band: "moderate", fromModel: "sonnet", toModel: "opus" });
      recordRouteOverride(vault, { domain: "wealth", band: "moderate", fromModel: "haiku", toModel: "opus" });
      // A malformed line and an incomplete record must both be tolerated + skipped.
      appendFileSync(routeLearningFile(vault), "this is not json\n");
      appendFileSync(routeLearningFile(vault), JSON.stringify({ ts: 5, domain: "wealth" }) + "\n"); // no band/toModel
      const rows = readRouteOverrides(vault);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.toModel === "opus" && r.band === "moderate")).toBe(true);
      // And the learned preference reads through the store end to end.
      expect(learnedPreference(rows, "wealth", "moderate", 2)).toBe("opus");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("missing store => empty list (no throw)", () => {
    const vault = mkdtempSync(join(tmpdir(), "prevail-routelearn-empty-"));
    try {
      expect(readRouteOverrides(vault)).toEqual([]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
