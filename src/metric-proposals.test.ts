import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptance, answerProposal, candidates, changePoints, idealMetricLines, insights, metricFor, proposals, setLifecycle } from "./metric-proposals.ts";
import { computeMetrics, glanceIds, readRegistry, hostSlug } from "./metrics.ts";
import { noteSaid } from "./said.ts";

const ROOT = join("/tmp", `prevail-m2-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 2, 15);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "money", "career"]) mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
  writeFileSync(join(V, "data", "domains", "money", "manifest.json"), "{}");
  writeFileSync(join(V, "data", "domains", "money", "ideal-state.md"), "# Money\n\n## Metrics you track\nMonthly spending against the plan; renewal dates and whether anything is near lapse; AI spend versus what it ships.\n\n## Habits\nfoo\n");
  writeFileSync(join(V, "build", "compass.md"), "# Compass\n\n## Values\n- Calm ~id:v-calm ~rank:1\n\n## Goals\n- [ ] Land a foo role ~id:g-role ~status:active\n- [ ] Ship the bar app ~id:g-ship ~status:active\n\n## Non-negotiables\n- Home for dinner most nights ~id:nn-dinner\n");
  // Commits on 12 consecutive weeks, then three weeks far above normal.
  const dir = join(V, "build", "_meta", "events", "git");
  mkdirSync(dir, { recursive: true });
  const lines: Record<string, string[]> = {};
  for (let w = 15; w >= 1; w--) {
    const d = new Date(NOW - w * 7 * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const n = w <= 3 ? 40 : 5 + (w % 3);
    (lines[day.slice(0, 7)] ??= []).push(JSON.stringify({ ts: day, src: "git", kind: "git.commit", n, project: "foo", host: "foo-mac", tier: "measured", attrs: { ai: 0 } }));
  }
  for (const [m, ls] of Object.entries(lines)) writeFileSync(join(dir, `${m}.foo-mac.jsonl`), ls.join("\n") + "\n");
}

describe("metric proposals", () => {
  beforeEach(seed);
  test("the user's stated metrics are split into lines, mapped where Prevail can count them", () => {
    const l = idealMetricLines(V).map((x) => x.line);
    expect(l).toEqual(["Monthly spending against the plan", "renewal dates and whether anything is near lapse", "AI spend versus what it ships"]);
    expect(metricFor("AI spend versus what it ships")).toBe("m-ai-spend");
    expect(metricFor("renewal dates")).toBeUndefined();
  });
  test("proposals come from ideals, unmeasured goals, rules, patterns and chat, with history", async () => {
    for (let i = 0; i < 3; i++) noteSaid(V, { text: `I ran ${3 + i} miles today`, now: NOW - i * 86_400_000 });
    const c = await computeMetrics(V, { now: NOW });
    const all = candidates(V, c);
    const kinds = all.map((p) => `${p.kind}:${p.title}`);
    expect(kinds).toContain("ideal:Card spend for money");
    expect(kinds).toContain("ideal:Renewal dates and whether anything is near lapse");
    expect(kinds).toContain("source:Measure \"Land a foo role\"");
    expect(kinds).toContain("goal:Things shipped, for \"Ship the bar app\"");
    expect(kinds).toContain("source:Check \"Home for dinner most nights\"");
    expect(kinds).toContain("pattern:Commits");
    expect(kinds).toContain("pattern:Ran, as you say it");
    const commits = all.find((p) => p.title === "Commits")!;
    expect(commits.spark).toHaveLength(12);
    expect(commits.computable).toBe(true);
    const role = all.find((p) => p.title.includes("foo role"))!;
    expect(role.why).toContain("Gmail headers");
    expect(role.computable).toBe(false);
    // Ranked: computable and relevant first.
    const ranked = proposals(V, c, 20);
    expect(ranked[0]!.computable).toBe(true);
  });
  test("answers: Track adds the learned metric, two Not useful stop a kind, corrections stick", async () => {
    for (let i = 0; i < 3; i++) noteSaid(V, { text: `I ran ${3 + i} miles today`, now: NOW - i * 86_400_000 });
    let c = await computeMetrics(V, { now: NOW });
    const ran = candidates(V, c).find((p) => p.title.startsWith("Ran"))!;
    expect(answerProposal(V, c, ran.key, "track", { title: "Runs", serves: "v-calm" }, NOW).id).toBe("m-runs");
    const md = readFileSync(join(V, "build", "metrics.md"), "utf8");
    expect(md).toContain("- Runs ~id:m-runs ~per:week ~unit:mi ~tier:asked ~src:stated ~kind:stated.ran ~value:value ~serves:v-calm");
    c = await computeMetrics(V, { now: NOW });
    expect(c.defs.find((m) => m.id === "m-runs")?.learned).toBe(true);
    expect(c.points["m-runs"]!.reduce((a, p) => a + p.value, 0)).toBe(12);
    const ideals = proposals(V, c, 20).filter((p) => p.kind === "ideal");
    answerProposal(V, c, ideals[0]!.key, "dismiss", {}, NOW);
    answerProposal(V, c, ideals[1]!.key, "dismiss", { never: "renewal" }, NOW);
    expect(proposals(V, c, 20).filter((p) => p.kind === "ideal")).toEqual([]);
    expect(acceptance(V, NOW)).toEqual({ month: "2026-10", answered: 3, accepted: 1, rate: 0.33 });
  });
  test("lifecycle: a pinned metric names what it serves; caps; retiring needs a reason", async () => {
    await computeMetrics(V, { now: NOW });
    expect(() => setLifecycle(V, "m-commits", "pinned")).toThrow(/names what it serves/);
    expect(() => setLifecycle(V, "m-commits", "pinned", { serves: "v-nope" })).toThrow(/no Compass line/);
    setLifecycle(V, "m-commits", "pinned", { serves: "g-ship" });
    expect(readRegistry(V).get("m-commits")).toMatchObject({ status: "pinned", tokens: { serves: "g-ship" } });
    expect(glanceIds(V)).toEqual(["m-commits"]);
    setLifecycle(V, "m-shipped", "pinned", { serves: "g-ship" });
    setLifecycle(V, "m-tasks-done", "pinned", { serves: "g-ship" });
    expect(() => setLifecycle(V, "m-decisions", "pinned", { serves: "g-ship" })).toThrow(/at most 3/);
    setLifecycle(V, "m-trips", "pinned");
    expect(() => setLifecycle(V, "m-prompts", "retired")).toThrow(/because/);
    setLifecycle(V, "m-prompts", "retired", { because: "never changed a decision" });
    const md = readFileSync(join(V, "build", "metrics.md"), "utf8");
    expect(md).toMatch(/## Retired\n\n- Prompts you wrote ~id:m-prompts[^\n]*\n  from: [^\n]*\n  because: never changed a decision/);
    expect(readRegistry(V).get("m-prompts")!.because).toBe("never changed a decision");
    setLifecycle(V, "m-commits", "paused");
    expect(readRegistry(V).get("m-commits")!.status).toBe("paused");
  });
  test("change points: three weeks outside your normal, with the files behind them", async () => {
    const c = await computeMetrics(V, { now: NOW });
    const cp = changePoints(c);
    expect(cp.map((x) => `${x.metric}:${x.direction}`)).toEqual(["m-commits:up"]);
    expect(cp[0]!.text).toContain("above your normal for three weeks");
    expect(cp[0]!.text).toContain("A change, not a cause");
    expect(cp[0]!.files[0]).toMatch(/events\/git\/.*foo-mac\.jsonl$/);
    insights(V, c, NOW);
    insights(V, c, NOW);
    expect(readFileSync(join(V, "build", "_meta", "metrics", "insights.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(hostSlug()).toBeTruthy();
  });
});
