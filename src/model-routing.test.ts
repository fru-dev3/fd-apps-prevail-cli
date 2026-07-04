import { describe, expect, test } from "bun:test";

import {
  chooseModel,
  routeWithFallback,
  metaFor,
  deriveHeuristics,
  makeCandidate,
  normalizeBias,
  shouldRunClassifier,
  parseClassifyResponse,
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
