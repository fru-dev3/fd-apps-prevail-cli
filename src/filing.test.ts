// Generous filing, re-checks and the filing plan. Fake runners and a stub
// decision provider only: nothing spawns a model or touches the network, and
// every name and message is invented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DecisionProvider, DecisionResult } from "./decision.ts";
import { filingCachePath, filingPlan, userWords } from "./filing.ts";
import {
  FILE_MAX_SECONDARY,
  fileFromScores,
  isRecheckTurn,
  recordRouteCorrection,
  routeMessage,
  type RouteRunner,
} from "./route.ts";

let vault = "";
const DOMAINS = ["general", "real-estate", "finance", "health", "legal", "travel", "insurance"];

beforeEach(() => {
  vault = mkdtempSync(join(homedir(), ".prevail-filing-test-"));
  for (const d of DOMAINS) mkdirSync(join(vault, "data", "domains", d, "memory"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

const reply = (hits: [string, number][]): string =>
  JSON.stringify({ domains: hits.map(([slug, confidence]) => ({ slug, confidence })), reason: "x" });

function counting(out: string): { runner: RouteRunner; calls: { prompt: string }[] } {
  const calls: { prompt: string }[] = [];
  return { calls, runner: async (r) => { calls.push({ prompt: r.prompt }); return out; } };
}

function choiceProvider(probabilities: Record<string, number>): DecisionProvider {
  const result: DecisionResult = {
    answers: { route: { type: "choice", choice: Object.keys(probabilities)[0], confidence: 0, probabilities } },
    latencyMs: 1, costUsd: 0, model: "stub-1",
  };
  return { id: "stub", available: () => true, unavailableReason: () => null, evaluate: async () => result };
}

describe("generous filing", () => {
  test("a moderate best match still becomes the home domain", async () => {
    const f = counting(reply([["finance", 0.4], ["health", 0.2]]));
    const r = await routeMessage({ vault, text: "Thinking about the foo budget", runner: f.runner, provider: null });
    expect(r).toMatchObject({ primary: "finance", secondary: [], unfiled: false, changed: true, checked: true });
    expect(r.candidates).toEqual([{ slug: "finance", score: 0.4 }, { slug: "health", score: 0.2 }]);
  });

  test("the decision layer path files generously too, with every domain ranked", async () => {
    const r = await routeMessage({ vault, text: "foo", provider: choiceProvider({ general: 0.5, legal: 0.38, travel: 0.1 }), runner: null });
    expect(r.source).toBe("typesafe");
    expect(r.primary).toBe("legal");
    expect(r.candidates.map((c) => c.slug)).toEqual(["legal", "travel", "finance"]);
  });

  test("secondary domains need 0.6 and are capped", () => {
    const f = fileFromScores([
      { slug: "a", score: 0.9 }, { slug: "b", score: 0.8 }, { slug: "c", score: 0.7 },
      { slug: "d", score: 0.65 }, { slug: "e", score: 0.61 }, { slug: "f", score: 0.59 },
    ]);
    expect(f.primary).toBe("a");
    expect(f.secondary).toEqual(["b", "c", "d"]);
    expect(f.secondary).toHaveLength(FILE_MAX_SECONDARY);
  });

  test("nothing above the low bar is unfiled, with the top 3 candidates", async () => {
    const f = counting(reply([["travel", 0.3], ["health", 0.2], ["legal", 0.16]]));
    const r = await routeMessage({ vault, text: "hmm", runner: f.runner, provider: null });
    expect(r.primary).toBeNull();
    expect(r.unfiled).toBe(true);
    expect(r.candidates.map((c) => c.slug)).toEqual(["travel", "health", "legal"]);
    expect(r.changed).toBe(true);
  });
});

describe("re-checks as a conversation grows", () => {
  test("cadence: turn 1, turn 3, then every 5th", () => {
    const on = Array.from({ length: 20 }, (_, i) => i + 1).filter(isRecheckTurn);
    expect(on).toEqual([1, 3, 5, 10, 15, 20]);
  });

  test("an off turn asks nothing and reports no change", async () => {
    const f = counting(reply([["health", 0.9]]));
    const r = await routeMessage({ vault, text: "more", turn: 2, current: ["finance"], runner: f.runner, provider: null });
    expect(f.calls).toHaveLength(0);
    expect(r).toMatchObject({ checked: false, changed: false, primary: "finance" });
  });

  test("adds new secondary domains and keeps the home", async () => {
    const f = counting(reply([["health", 0.9], ["legal", 0.7]]));
    const r = await routeMessage({ vault, text: "the clinic bill", turn: 3, current: ["finance"], runner: f.runner, provider: null });
    expect(r).toMatchObject({ primary: "finance", secondary: ["health", "legal"], changed: true });
  });

  test("nothing new means no change", async () => {
    const f = counting(reply([["finance", 0.9]]));
    const r = await routeMessage({ vault, text: "rates", turn: 5, current: ["finance", "health"], runner: f.runner, provider: null });
    expect(r).toMatchObject({ primary: "finance", secondary: ["health"], changed: false });
  });

  test("never overrides a user correction: home kept, removed domains never come back", async () => {
    // The user moved home to legal and removed finance and health.
    recordRouteCorrection(vault, { thread: "t-foo", domains: ["legal"], from: ["finance", "health"] });
    const f = counting(reply([["finance", 0.95], ["health", 0.9], ["travel", 0.8]]));
    const r = await routeMessage({ vault, text: "foo", thread: "t-foo", turn: 5, current: ["legal"], runner: f.runner, provider: null });
    expect(r.primary).toBe("legal");
    expect(r.secondary).toEqual(["travel"]);
    expect(r.candidates.map((c) => c.slug)).not.toContain("finance");
  });

  test("a thread the user kept in General stays there", async () => {
    recordRouteCorrection(vault, { thread: "t-bar", domains: [] });
    const f = counting(reply([["finance", 0.95]]));
    const r = await routeMessage({ vault, text: "foo", thread: "t-bar", turn: 3, runner: f.runner, provider: null });
    expect(f.calls).toHaveLength(0);
    expect(r).toMatchObject({ primary: null, unfiled: false, source: "correction" });
  });
});

function thread(domain: string, stem: string, fm: Record<string, string>, turns: string[]): string {
  const dir = join(vault, "data", "domains", domain, "_threads");
  mkdirSync(dir, { recursive: true });
  const head = Object.entries({ title: stem, domain, ...fm }).map(([k, v]) => `${k}: ${v}`).join("\n");
  const body = turns.map((t, i) => (i % 2 === 0 ? `## You\n\n${t}\n\n` : `## claude\n\nsecret reply ${i}\n\n`)).join("");
  const p = join(dir, `${stem}.md`);
  writeFileSync(p, `---\n${head}\n---\n\n${body}`);
  return p;
}

describe("filing plan", () => {
  test("shape, skips and what it sends", async () => {
    thread("general", "g-open", {}, ["Foo lease renewal", "ok"]);
    thread("general", "g-filed", { routed: "finance" }, ["done already"]);
    thread("general", "g-incog", { incognito: "true" }, ["private"]);
    thread("health", "h-open", {}, ["sleep log"]);
    writeFileSync(join(vault, "data", "domains", "health", "manifest.json"), JSON.stringify({ privacy: { localOnly: true } }));
    const f = counting(reply([["real-estate", 0.8], ["legal", 0.65]]));
    const p = await filingPlan({ vault, runner: f.runner, provider: null, bunker: false });
    expect(p.total).toBe(3);
    expect(p.skipped).toBe(2);
    expect(p.plan).toEqual([{
      thread: "g-open", title: "g-open", current_home: "general",
      primary: "real-estate", secondary: ["legal"],
      candidates: [{ slug: "real-estate", score: 0.8 }, { slug: "legal", score: 0.65 }], unfiled: false,
    }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].prompt).toContain("Foo lease renewal");
    expect(f.calls[0].prompt).not.toContain("secret reply");
  });

  test("Bunker Mode skips every thread and sends nothing", async () => {
    thread("general", "g-1", {}, ["foo"]);
    const f = counting(reply([["finance", 0.9]]));
    const p = await filingPlan({ vault, runner: f.runner, provider: null, bunker: true });
    expect(p).toMatchObject({ plan: [], skipped: 1, total: 1 });
    expect(f.calls).toHaveLength(0);
  });

  test("is read-only on threads, capped, and cached by mtime", async () => {
    const a = thread("general", "g-a", {}, ["foo one"]);
    thread("general", "g-b", {}, ["foo two"]);
    const before = readFileSync(a, "utf8");
    const f = counting(reply([["finance", 0.7]]));
    const p1 = await filingPlan({ vault, limit: 1, runner: f.runner, provider: null, bunker: false });
    expect(p1.plan).toHaveLength(1);
    expect(p1.total).toBe(2);
    const p2 = await filingPlan({ vault, runner: f.runner, provider: null, bunker: false });
    expect(p2.plan).toHaveLength(2);
    expect(p2.cached).toBe(1);
    expect(f.calls).toHaveLength(2);
    const p3 = await filingPlan({ vault, runner: f.runner, provider: null, bunker: false });
    expect(p3.cached).toBe(2);
    expect(f.calls).toHaveLength(2);
    expect(readFileSync(a, "utf8")).toBe(before);
    expect(readFileSync(filingCachePath(vault), "utf8")).toContain("g-a");
  });

  test("only the user's own turns are routing text", () => {
    expect(userWords("T", "## You\n\nhi foo\n\n## claude\n\nanswer\n\n## You\n\nbye\n")).toBe("T\n\nhi foo\n\nbye");
  });
});
