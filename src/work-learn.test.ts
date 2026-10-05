import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readChiefOfStaff } from "./chief-of-staff.ts";
import type { Job } from "./jobs.ts";
import type { RouteRunner } from "./route.ts";
import type { Herdr } from "./spaces.ts";
import { addMilestone, addWork, distilMilestone, engineMilestone, followUp, milestoneByCode, routeTask, updateTask, type WorkDeps, type WorkTask } from "./work.ts";
import { judgePlan, parsePlanJudgement, planTask } from "./work-assemble.ts";
import { answersFrom, isForget, rankContext, sourceRank, topicOf } from "./work-learn.ts";

const ROOT = join("/tmp", `prevail-work-learn-${process.pid}`);
const V = join(ROOT, "vault");
const saved = { config: process.env.PREVAIL_CONFIG_DIR, glyph: process.env.GLYPH_SPACES };
beforeAll(() => { process.env.PREVAIL_CONFIG_DIR = join(ROOT, "config"); process.env.GLYPH_SPACES = join(ROOT, "no-glyph"); });
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of [["PREVAIL_CONFIG_DIR", saved.config], ["GLYPH_SPACES", saved.glyph]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const D = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "career", "money", "travel"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), ".prevail-layout-v4"), "v4\n");
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d, summary: `Foo ${d}` } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state.\n`);
  }
}

function quietHerdr(): Herdr {
  return (args) => {
    if (args[0] === "--version") return "herdr 0.0.0";
    if (args[0] === "machine") return [];
    if (args[0] === "agent" && args[1] === "start" && args[2] === "--help") return "[possible values: claude, codex]";
    if (args[0] === "workspace" && args[1] === "list") return { workspaces: [] };
    if (args[0] === "pane") return { panes: [] };
    return {};
  };
}
function deps(o: { runner?: WorkDeps["runner"]; now?: number } = {}): WorkDeps {
  const h = quietHerdr();
  return {
    runner: o.runner ?? null, spawnSelf: () => {}, herdrFor: () => h,
    ...(o.now ? { now: () => o.now! } : {}),
    machine: { host: "laptop", role: "hub", env: { GLYPH_SPACES: join(ROOT, "no-glyph"), PREVAIL_MACHINE: "laptop" } },
  };
}
/** A router stub that always sends the task to one domain; any other model call gets nothing useful. */
const routeTo = (text: string, id: string, name = "Foo Task"): RouteRunner => async (req) =>
  req.system.includes("router") ? JSON.stringify({ goals: [{ text, tasks: [{ name, text, dest: { kind: "domain", id }, confidence: 0.9, shape: "plan" }] }] }) : "";
const learned = () => readChiefOfStaff(V).learned;

describe("Work mode learns and adapts", () => {
  beforeEach(seed);

  test("a correction changes the next routing, says so in one line, and forget that takes it back", async () => {
    const a = (await addWork(V, "Sort out the foo quarterly review notes", { deps: deps({ runner: routeTo("Sort out the foo quarterly review notes", "general", "Quarterly Review Notes") }) })).tasks[0]!;
    expect(a.dest?.id).toBe("general");
    await routeTask(V, a.id, { dest: "domain:career" }, deps());
    expect(learned()).toContain('Work about "quarterly notes" goes to domain:career (you moved it there)');
    // The domain's memory hears about it too, through its journal.
    expect(readFileSync(join(D("career"), ".system", "journal.jsonl"), "utf8")).toContain("Quarterly Review Notes");

    // The router still says General; the lesson wins.
    const b = (await addWork(V, "Draft the foo quarterly notes for this week", { deps: deps({ runner: routeTo("Draft the foo quarterly notes for this week", "general", "Quarterly Notes") }) })).tasks[0]!;
    expect(b.dest?.id).toBe("career");
    expect(b.thread.space).toBe("career");
    expect(b.learned).toEqual(['Work about "quarterly notes" goes to domain:career (you moved it there)']);
    const line = b.updates!.find((u) => u.learned)!;
    expect(line.text).toBe("From what I learned: it goes to Career, where you moved it before.");

    // Forget that: the lesson leaves "What I've learned" and the next one goes where the router says.
    expect(isForget("forget that")).toBe(true);
    expect(isForget("forget the foo budget and start over with something else entirely now")).toBe(false);
    const f = await followUp(V, b.id, "Forget that", { deps: deps() });
    expect(f.task.updates!.at(-1)!.text).toBe("Forgotten: quarterly notes goes to career. I will not use it again.");
    expect(f.task.learned).toBeUndefined();
    expect(learned().some((l) => l.includes("quarterly notes"))).toBe(false);
    const c = (await addWork(V, "Draft the foo quarterly notes again", { deps: deps({ runner: routeTo("Draft the foo quarterly notes again", "general", "Quarterly Notes") }) })).tasks[0]!;
    expect(c.dest?.id).toBe("general");
  });

  test("an undo takes the lesson back", async () => {
    const a = (await addWork(V, "Sort the foo invoices", { deps: deps({ runner: routeTo("Sort the foo invoices", "general", "Foo Invoices") }) })).tasks[0]!;
    await routeTask(V, a.id, { dest: "domain:money" }, deps());
    expect(learned()).toHaveLength(1);
    await routeTask(V, a.id, { undo: true }, deps());
    expect(learned()).toHaveLength(0);
  });

  test("a repeated question is pre-filled from the earlier answer: fewer, sharper questions", async () => {
    const one = (await addWork(V, "Book a trip to Portugal", { deps: deps({ runner: routeTo("Book a trip to Portugal", "travel") }) })).tasks[0]!;
    expect(one.planning).toBe(true);
    expect(one.updates!.at(-1)!.questions).toContain("What budget should I keep to?");
    await followUp(V, one.id, "Porto, ten days in May, under $1,500, aisle seats", { deps: deps() });
    expect(learned()).toEqual(["Travel plans, budget: under $1,500", "Travel plans, preferences: aisle seats"]);

    const two = (await addWork(V, "Book a trip to Japan", { deps: deps({ runner: routeTo("Book a trip to Japan", "travel") }) })).tasks[0]!;
    expect(two.planning).toBe(true);
    const qs = two.updates!.at(-1)!.questions!;
    expect(qs).not.toContain("What budget should I keep to?");
    expect(qs).not.toContain("Anything I should avoid or must include?");
    expect(qs[0]).toBe("Where in Japan: which cities or places?");
    expect(two.updates!.find((u) => u.learned)!.text).toBe("Using what you told me last time: under $1,500, aisle seats.");
    expect(two.context!.map((c) => c.label)).toEqual(expect.arrayContaining(["What you told me before: under $1,500"]));
    // A newer answer replaces the older one.
    await followUp(V, two.id, "Kyoto, two weeks in April, under $3,000", { deps: deps() });
    expect(learned()).toEqual(["Travel plans, preferences: aisle seats", "Travel plans, budget: under $3,000"]);
  });

  test("a recurring task is recognised and set up like last time", async () => {
    const mon = (d: number) => new Date(2026, 8, d, 9).getTime();
    const text = "Set my weekly priorities for the foo week";
    const first = (await addWork(V, text, { deps: deps({ now: mon(7), runner: routeTo(text, "career", "Weekly Priorities") }) })).tasks[0]!;
    expect(first.recurringOf).toBeUndefined();
    updateTask(V, first.id, (x) => { x.status = "done"; x.outcome = "Three foo priorities set."; x.specialists = ["planner"]; });
    await addWork(V, "Weekly priorities for the foo week please", { deps: deps({ now: mon(14), runner: routeTo("Weekly priorities for the foo week please", "career", "Weekly Priorities") }) });
    // The third Monday: the router guessed General, the history says Career.
    const third = (await addWork(V, "My foo weekly priorities", { deps: deps({ now: mon(21), runner: routeTo("My foo weekly priorities", "general", "Foo Priorities") }) })).tasks[0]!;
    expect(third.recurringOf).toHaveLength(2);
    expect(third.name).toBe("Weekly Priorities");
    expect(third.dest?.id).toBe("career");
    expect(third.updates!.find((u) => u.learned)!.text).toBe("From what I learned: this comes up regularly (2 times before, usually on Mondays), so it is set up like last time.");
    expect(third.context!.map((c) => c.label)).toContain("Last time: Three foo priorities set.");
    // Forget that: these tasks no longer count as recurring.
    await followUp(V, third.id, "please forget that", { deps: deps({ now: mon(21) + 1000 }) });
    const fourth = (await addWork(V, "My foo weekly priorities", { deps: deps({ now: mon(28), runner: routeTo("My foo weekly priorities", "general", "Foo Priorities") }) })).tasks[0]!;
    expect(fourth.recurringOf).toBeUndefined();
  });

  test("the sources that answered well before go first", () => {
    const done = { status: "done", context: [{ label: "From your money notes: foo budget", text: "x" }] } as unknown as WorkTask;
    const rank = sourceRank([{ tasks: [done, done] }] as never);
    const out = rankContext([{ label: "Career notes", text: "a" }, { label: "From your money notes: other line", text: "b" }], rank);
    expect(out.map((c) => c.text)).toEqual(["b", "a"]);
  });

  test("answers split by topic, line by line or by their words", () => {
    expect(topicOf("What budget should I keep to?")).toBe("budget");
    expect(answersFrom(["Where?", "What budget should I keep to?"], "Lisbon\n2,000 at most")).toEqual({ where: "Lisbon", budget: "2,000 at most" });
    expect(answersFrom([], "Porto and Seville, ten days in May, 2,000 at most, to rest")).toEqual({ where: "Porto and Seville", when: "ten days in May", budget: "2,000 at most", why: "to rest" });
  });
});

describe("the planning check is the model's judgement, keywords offline", () => {
  beforeEach(seed);
  const judge = (j: object, route: RouteRunner): RouteRunner => async (req) => (req.system.includes("needs a short plan") ? JSON.stringify(j) : route(req));

  test("the model says under-specified with no keyword in sight: it plans with the model's questions", async () => {
    const text = "Organise the foo reunion";
    const runner = judge({ under_specified: true, high_impact: false, questions: ["Who should come?", "Which weekend suits you?"], domains: ["money", "nope"] }, routeTo(text, "general"));
    const t = (await addWork(V, text, { deps: deps({ runner }) })).tasks[0]!;
    expect(t).toMatchObject({ status: "needs-you", planning: true });
    expect(t.updates!.at(-1)!.questions).toEqual(["Who should come?", "Which weekend suits you?"]);
    expect(t.domains).toContain("money");
    expect(t.domains).not.toContain("nope");
  });

  test("the model says fully specified and low impact: a keyword ask goes straight through", async () => {
    const text = "Book the usual foo table for two at 7pm Friday";
    const t = (await addWork(V, text, { deps: deps({ runner: judge({ under_specified: false, high_impact: false, questions: [], domains: [] }, routeTo(text, "general")) }) })).tasks[0]!;
    expect(t.planning).toBeUndefined();
    expect(t.status).toBe("running");
  });

  test("no model (offline, bunker, or a reply that is not a judgement): the keyword check decides", async () => {
    expect(await judgePlan("Book a foo table", ["general"], null)).toBeNull();
    expect(await judgePlan("Book a foo table", ["general"], async () => "not json")).toBeNull();
    const prev = process.env.PREVAIL_BUNKER;
    process.env.PREVAIL_BUNKER = "1";
    try { expect(await judgePlan("Book a foo table", ["general"], async () => "{}")).toBeNull(); } finally { if (prev === undefined) delete process.env.PREVAIL_BUNKER; else process.env.PREVAIL_BUNKER = prev; }
    expect(planTask(V, { text: "Book a foo table", flags: {} })).not.toBeNull();
    expect(parsePlanJudgement('{"under_specified":true,"high_impact":true,"questions":["A \u2014 b?"],"domains":["Money"]}')).toEqual({ underSpecified: true, highImpact: true, questions: ["A, b?"], domains: ["money"] });
    expect(parsePlanJudgement('{"goals":[]}')).toBeNull();
  });
});

describe("milestones mid-run", () => {
  test("distilled to a sentence from the agent's progress, never raw output", async () => {
    const out = "⏺ Read(data/foo/policy.md)\n⎿  320 lines\nLet me look at the carriers.\nI found three foo carriers that cover both rentals.\n| a | b |\nNow comparing prices?";
    expect(milestoneByCode(out)).toBe("I found three foo carriers that cover both rentals.");
    expect(milestoneByCode("⏺ Bash(ls)\nThinking about it")).toBeNull();
    expect(await distilMilestone(out, { runner: async () => "NONE" })).toBeNull();
    expect(await distilMilestone(out, { runner: async () => "I found three carriers. Next I compare their prices." })).toBe("I found three carriers.");
    // A reply that is not a sentence falls back to code's line.
    expect(await distilMilestone(out, { runner: async () => '{"goals":[]}' })).toBe("I found three foo carriers that cover both rentals.");
    expect(await distilMilestone(out, { runner: null })).toBe("I found three foo carriers that cover both rentals.");
  });

  test("rate-limited: at most one line per five minutes since the task last spoke, only while running", () => {
    const t0 = 1_000_000;
    const t = { status: "running", log: [], updates: [{ ts: t0, from: "task", text: "Working on it, nothing needed from you." }] } as unknown as WorkTask;
    expect(addMilestone(t, "I found three foo carriers.", t0 + 60_000)).toBe(false);
    expect(addMilestone(t, "I found three foo carriers.", t0 + 6 * 60_000)).toBe(true);
    expect(addMilestone(t, "I drafted the foo request.", t0 + 8 * 60_000)).toBe(false);
    expect(addMilestone(t, "I drafted the foo request.", t0 + 12 * 60_000)).toBe(true);
    expect(t.updates!.filter((u) => u.milestone).map((u) => u.text)).toEqual(["I found three foo carriers.", "I drafted the foo request."]);
    t.status = "done";
    expect(addMilestone(t, "I finished.", t0 + 60 * 60_000)).toBe(false);
  });

  test("an engine job says when a step is done", () => {
    const job = { status: "running", team: [{ step: 1, specialists: ["researcher"] }, { step: 2, specialists: ["writer"] }], progress: [{ step: 1, specialist: "researcher", pass: 1 }] } as unknown as Job;
    expect(engineMilestone(job, 1)).toBeNull();
    job.progress!.push({ step: 2, specialist: "writer", pass: 1 });
    expect(engineMilestone(job, 1)).toEqual({ step: 2, text: "The researcher step is done; the writer is on it now." });
    expect(engineMilestone(job, 2)).toBeNull();
  });
});
