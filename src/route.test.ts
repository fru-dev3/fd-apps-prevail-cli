// Domain routing: fake runners and a stub decision provider only. Nothing here
// spawns a model or touches the network, and every message is invented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionProvider, DecisionResult } from "./decision.ts";
import {
  buildRoutePrompt,
  buildRouteQuestion,
  hitsFromProbabilities,
  parseRouteReply,
  recentRouteExamples,
  recordRouteCorrection,
  routableDomains,
  routeMessage,
  type RouteRunner,
} from "./route.ts";
import { decisionsFile } from "./decisions.ts";

let vault = "";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-route-"));
  for (const d of ["general", "real-estate", "finance", "health"]) {
    mkdirSync(join(vault, "data", "domains", d, "memory"), { recursive: true });
  }
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

const fixed = (reply: string): { runner: RouteRunner; seen: { system: string; prompt: string }[] } => {
  const seen: { system: string; prompt: string }[] = [];
  return { seen, runner: async (r) => { seen.push({ system: r.system, prompt: r.prompt }); return reply; } };
};

function stubProvider(result: DecisionResult | null, seen: unknown[] = []): DecisionProvider {
  return {
    id: "stub",
    available: () => true,
    unavailableReason: () => null,
    evaluate: async (state, questions) => { seen.push({ state, questions }); return result; },
  };
}

describe("routableDomains", () => {
  test("lists the vault's real domains without General", () => {
    expect(routableDomains(vault)).toEqual(["finance", "health", "real-estate"]);
  });
});

describe("parseRouteReply", () => {
  const doms = ["finance", "real-estate"];
  test("keeps only real domains, clamps and sorts", () => {
    const r = parseRouteReply('{"domains":[{"slug":"finance","confidence":0.4},{"slug":"Real-Estate","confidence":1.7},{"slug":"boats","confidence":0.9}],"reason":"a rent question"}', doms);
    expect(r).toEqual({ domains: [{ slug: "real-estate", confidence: 1 }, { slug: "finance", confidence: 0.4 }], reason: "a rent question" });
  });
  test("tolerates prose around the object", () => {
    expect(parseRouteReply('Sure: {"domains":[],"reason":"general"} done', doms)?.domains).toEqual([]);
  });
  test("rejects non-JSON", () => {
    expect(parseRouteReply("real estate, probably", doms)).toBeNull();
    expect(parseRouteReply('{"reason":"x"}', doms)).toBeNull();
  });
});

describe("routeMessage via the model runner", () => {
  test("returns the parsed hits and sends only the message text", async () => {
    const f = fixed('{"domains":[{"slug":"real-estate","confidence":0.91}],"reason":"tenant lease"}');
    const text = "The tenant at Maple Court wants to renew the lease early";
    const r = await routeMessage({ vault, text, runner: f.runner, provider: null });
    expect(r).toEqual({ domains: [{ slug: "real-estate", confidence: 0.91 }], reason: "tenant lease", source: "model" });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].prompt).toBe(`Message:\n${text}`);
    expect(f.seen[0].system).toContain("finance, health, real-estate");
  });

  test("a failing runner stays in General", async () => {
    const r = await routeMessage({ vault, text: "hello there", provider: null, runner: async () => { throw new Error("down"); } });
    expect(r.domains).toEqual([]);
    expect(r.source).toBe("none");
  });

  test("empty text never calls anything", async () => {
    const f = fixed("{}");
    const r = await routeMessage({ vault, text: "   ", runner: f.runner, provider: null });
    expect(r.source).toBe("none");
    expect(f.seen).toHaveLength(0);
  });
});

describe("routeMessage via the decision layer", () => {
  test("turns the choice distribution into hits over real domains only", async () => {
    const seen: unknown[] = [];
    const provider = stubProvider({
      answers: { route: { type: "choice", choice: "finance", confidence: 0.7, probabilities: { finance: 0.7, "real-estate": 0.2, general: 0.08, health: 0.02 } } },
      latencyMs: 5, costUsd: 0, model: "stub-1",
    }, seen);
    const f = fixed("{}");
    const text = "Should I move the emergency fund into treasuries";
    const r = await routeMessage({ vault, text, provider, runner: f.runner });
    expect(r.source).toBe("typesafe");
    expect(r.domains).toEqual([{ slug: "finance", confidence: 0.7 }, { slug: "real-estate", confidence: 0.2 }]);
    expect(f.seen).toHaveLength(0);
    // The state is the message text and nothing else.
    expect((seen[0] as { state: unknown }).state).toBe(text);
  });

  test("falls back to the model when the provider has no answer", async () => {
    const f = fixed('{"domains":[{"slug":"health","confidence":0.8}],"reason":"sleep"}');
    const r = await routeMessage({ vault, text: "I keep waking at 4am", provider: stubProvider(null), runner: f.runner });
    expect(r.source).toBe("model");
    expect(r.domains[0].slug).toBe("health");
  });

  test("the question offers General plus every domain", () => {
    expect(Object.keys(buildRouteQuestion(["finance", "health"]).criteria)).toEqual(["general", "finance", "health"]);
    expect(hitsFromProbabilities({ general: 0.9, finance: 0.1 }, ["finance"])).toEqual([]);
  });
});

describe("corrections", () => {
  test("are logged to General's decision log and pin the thread", async () => {
    const r = recordRouteCorrection(vault, { thread: "t-1", domains: ["Finance", "nope"], from: ["real-estate"], text: "Refinance the duplex at a lower rate" });
    expect(r.domains).toEqual(["finance"]);
    const log = readFileSync(decisionsFile(vault, "general"), "utf8");
    expect(log).toContain('"type":"route_correction"');
    expect(log).toContain('"thread":"t-1"');

    const f = fixed("{}");
    const pinned = await routeMessage({ vault, text: "and what about closing costs", thread: "t-1", runner: f.runner, provider: null });
    expect(pinned).toEqual({ domains: [{ slug: "finance", confidence: 1 }], reason: "you filed this thread", source: "correction" });
    expect(f.seen).toHaveLength(0);
  });

  test("feed back into the model prompt as examples", async () => {
    recordRouteCorrection(vault, { thread: "t-2", domains: ["real-estate"], text: "Gutters on the rental need cleaning" });
    expect(recentRouteExamples(vault, routableDomains(vault))).toEqual([{ excerpt: "Gutters on the rental need cleaning", domains: ["real-estate"] }]);
    const f = fixed('{"domains":[],"reason":"general"}');
    await routeMessage({ vault, text: "Roof inspection next week", thread: "t-3", runner: f.runner, provider: null });
    expect(f.seen[0].prompt).toContain('"Gutters on the rental need cleaning" -> real-estate');
  });

  test("an empty correction keeps the thread in General", async () => {
    recordRouteCorrection(vault, { thread: "t-4", domains: [] });
    const r = await routeMessage({ vault, text: "Budget for the trip", thread: "t-4", runner: fixed("{}").runner, provider: null });
    expect(r.domains).toEqual([]);
    expect(r.source).toBe("correction");
  });

  test("the prompt caps the message", () => {
    const { prompt } = buildRoutePrompt("x".repeat(10_000), ["finance"], []);
    expect(prompt.length).toBeLessThan(4_100);
  });
});
