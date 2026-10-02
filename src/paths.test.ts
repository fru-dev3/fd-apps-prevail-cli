// Goals G4: initiatives (the plan's paths). Forced variety, the code screen
// (non-negotiables, capacity, dominance), even swaps by code, choosing two
// that install running playbooks, the weekly expectation check and the
// quarterly review. Invented Compass only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPathsWith, choosePath, dominates, evenSwap, parsePaths, pathMap, proposePaths, quarterlyReview, readInstalls, retirePath, screenPaths, type GenContext, type PathDraft } from "./paths.ts";
import { parseCompass, readCompass, readLedger } from "./compass.ts";
import { runPlaybook, loadPlaybook } from "./orchestrator.ts";

const ROOT = join("/tmp", `prevail-paths-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = new Date(2026, 9, 2, 12).getTime();
const DAY = 86_400_000;

const COMPASS = `# Compass

## Purpose
Keep learning.

## Values
- Curiosity ~id:v-curious ~rank:1
  words: "I want to stay curious about the world"
- Calm ~id:v-calm ~rank:2
- Family ~id:v-family ~rank:3

## Goals
- [ ] Stay curious about the world ~id:g-curious ~serves:v-curious ~status:active ~domain:foo
  why: "I want to stay curious about the world"

## Non-negotiables
- Family time five hours a week ~id:nn-fam ~check:family_hours_wk>=5

## Capacity
- hours_for_goals_wk: 10
`;

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), "{}"); }
  writeFileSync(join(V, "build", "compass.md"), COMPASS);
}

const P = (title: string, kind: PathDraft["kind"], o: Partial<PathDraft> = {}): PathDraft => ({ title, kind, why: `${title} reaches it`, hours: 2, usd: 0, stress: 1, needs: [], effects: [], values: { "v-curious": 1, "v-calm": 0, "v-family": 0 }, expect: [], commitWeeks: 8, playbooks: [], ...o });
const brief = (name: string, cadence: "daily" | "weekly" = "weekly") => ({ name, cadence, goal: `${name} for the foo goal`, steps: [{ specialists: ["scout"], brief: "Wander the foo news" }, { specialists: ["editor"], brief: "One page of what matters" }] });

const DRAFTS: PathDraft[] = [
  P("Morning foo brief", "low-effort", { hours: 1, values: { "v-curious": 2, "v-calm": 0, "v-family": 0 }, expect: ["m-prompts>=2"], playbooks: [brief("Morning foo brief", "daily")] }),
  P("Sunday reflection", "skill", { hours: 1, stress: 0, values: { "v-curious": 1, "v-calm": 1, "v-family": 0 }, playbooks: [brief("Sunday reflection")] }),
  P("Foo course with a tutor", "capital", { hours: 4, usd: 200, stress: 2, values: { "v-curious": 2, "v-calm": -1, "v-family": 0 } }),
  P("Foo club evenings", "social", { hours: 3, effects: ["family_hours_wk-3"], values: { "v-curious": 2, "v-calm": 0, "v-family": -1 } }),
  P("Read one foo book a quarter", "change-target", { hours: 1, stress: 1, values: { "v-curious": 1, "v-calm": 0, "v-family": 0 } }),
  P("Do nothing", "do-nothing", { hours: 0, stress: 0, values: { "v-curious": 0, "v-calm": 0, "v-family": 0 } }),
  P("Foo deep dive weekends", "skill", { hours: 12, stress: 3, values: { "v-curious": 2, "v-calm": -2, "v-family": -2 } }),
];

describe("generate and screen", () => {
  test("a model's reply is validated: unknown values, bad metric checks, specialists that are off and unknown kinds are dropped", () => {
    const ctx: GenContext = { goal: { id: "g-x", title: "x", serves: [] }, values: [{ id: "v-a", title: "A", rank: 1 }], rules: [], capacity: {}, active: [], specialists: [{ id: "scout", returns: "discoveries", ceiling: "read" }], metrics: [{ id: "m-prompts", title: "Prompts" }] };
    const raw = JSON.stringify({ paths: [
      { title: "One", kind: "skill", hours: 99, stress: 9, values: { "v-a": 5, "v-zzz": 1 }, expect: ["m-prompts>=3", "m-nope>=1", "be good"], stop: "m-prompts<1", playbooks: [{ name: "P", cadence: "hourly", steps: [{ specialists: ["scout", "operator"], brief: "go" }, { specialists: ["ghost"], brief: "x" }] }] },
      { title: "Two", kind: "magic", playbooks: [] },
      { title: "", kind: "skill" },
    ] });
    const p = parsePaths(`noise ${raw} noise`, ctx);
    expect(p.length).toBe(2);
    expect(p[0]).toMatchObject({ hours: 80, stress: 5, values: { "v-a": 2 }, expect: ["m-prompts>=3"], stop: "m-prompts<1" });
    expect(p[0]!.playbooks).toEqual([{ name: "P", cadence: "weekly", goal: "One", steps: [{ specialists: ["scout"], brief: "go" }] }]);
    expect(p[1]!.kind).toBe("other");
  });

  test("code drops what breaks a rule, overruns capacity or is dominated; 2-3 survive with even swaps", () => {
    const values = [{ id: "v-curious", title: "Curiosity", rank: 1 }, { id: "v-calm", title: "Calm", rank: 2 }, { id: "v-family", title: "Family", rank: 3 }];
    const c = screenPaths(DRAFTS, { values, rules: [{ id: "nn-fam", title: "Family time five hours a week", check: "family_hours_wk>=5" }], vars: [], capacity: { hours: 10 }, active: [] });
    const by = Object.fromEntries(c.map((x) => [x.title, x]));
    expect(by["Foo club evenings"]!.reason).toContain('breaks "Family time five hours a week"');
    expect(by["Foo deep dive weekends"]!.reason).toContain("does not fit your capacity: 12 of 10 hours");
    expect(by["Read one foo book a quarter"]!.reason).toContain("is as good or better on every value");
    const alive = c.filter((x) => x.verdict === "survivor");
    expect(alive.length).toBe(3);
    expect(alive[0]!.title).toBe("Morning foo brief");
    expect(alive.every((x, i) => (i === 0 ? !x.swap : !!x.swap))).toBe(true);
    expect(dominates(DRAFTS[0]!, DRAFTS[4]!, ["v-curious", "v-calm", "v-family"])).toBe(true);
    expect(evenSwap(DRAFTS[0]!, DRAFTS[2]!, values)).toBe("Foo course with a tutor gives up Calm, 3 more hours a week, about $200 more a month and stress up 1 of 5 against Morning foo brief.");
  });
});

describe("choose: two initiatives become running playbooks the user only had to choose", () => {
  beforeEach(seed);
  test("propose, then choose two: playbooks with gates and asks, loops in the goal's domain, first tasks, the ledger", async () => {
    const r = await proposePaths(V, "g-curious", { given: DRAFTS, now: NOW });
    const survivors = r.candidates.filter((c) => c.verdict === "survivor");
    const doc = readCompass(V);
    const g = doc.sections.flatMap((s) => s.blocks).flatMap((b) => ("item" in b ? [b.item] : [])).find((x) => x.id === "g-curious")!;
    expect(g.paths.map((p) => [p.title, p.tokens.status, p.tokens.kind])).toEqual(survivors.map((s) => [s.title, "proposed", s.kind]));
    expect(pathMap(V, "g-curious").left.map((x) => x.title)).toContain("Foo club evenings");
    // Proposing again replaces only the proposed lines.
    await proposePaths(V, "g-curious", { given: DRAFTS, now: NOW });
    expect(readCompass(V).sections.flatMap((s) => s.blocks).flatMap((b) => ("item" in b ? [b.item] : [])).find((x) => x.id === "g-curious")!.paths.length).toBe(survivors.length);

    const a = await choosePath(V, survivors[0]!.id, { now: NOW });
    const b = await choosePath(V, survivors[1]!.id, { now: NOW });
    expect([a.playbooks.length, b.playbooks.length]).toEqual([1, 1]);
    const loops = JSON.parse(readFileSync(join(D("foo"), "_loops.json"), "utf8")).loops as { playbook: string; cadence: string; enabled: boolean; autonomy: string }[];
    expect(loops.map((l) => [l.playbook, l.cadence, l.enabled])).toEqual([[a.playbooks[0], "daily", true], [b.playbooks[0], "weekly", true]]);
    const pb = JSON.parse(readFileSync(join(V, "build", "playbooks", `${a.playbooks[0]}.json`), "utf8"));
    expect(pb).toMatchObject({ goalId: "g-curious", pathId: survivors[0]!.id, domain: "foo" });
    const board = readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8");
    expect(board).toContain(`Start the initiative "${survivors[0]!.title}" toward Stay curious about the world`);
    const text = readFileSync(join(V, "build", "compass.md"), "utf8");
    expect(text).toMatch(new RegExp(`path: ${survivors[0]!.title} ~id:${survivors[0]!.id} ~status:chosen ~kind:low-effort ~until:2026-11-27 ~approval:ask`));
    expect(readLedger(V).filter((l) => l.to === "chosen").length).toBe(2);
    expect(readInstalls(V).length).toBe(2);
    await expect(choosePath(V, survivors[0]!.id, { now: NOW })).rejects.toThrow("already chosen");
    // Both playbooks run end to end (a stub model): the work happens without the user staffing anything.
    const turn = async (t: { prompt: string }) => JSON.stringify({ summary: /Scout/.test(t.prompt) ? "three foo things" : "one page", body: "Foo findings worth a look.", sources: ["https://example.com/foo"], check: { ok: true, missing: [] }, notebook: [], filed: {} });
    for (const id of [...a.playbooks, ...b.playbooks]) {
      const run = await runPlaybook(`t-${id}`, loadPlaybook(V, id)!, { vault: V, provider: "claude", model: "", autonomousActs: false, domain: "foo", runDeps: { detectClis: async () => [{ kind: "claude", bin: "/bin/false", label: "claude" }] as never, runChatTurn: turn as never } });
      expect(run.steps.map((s) => s.ok)).toEqual([true, true]);
    }
    // Retiring one stops its loop; nothing is deleted.
    expect((await retirePath(V, survivors[1]!.id, "not for me", NOW)).loops).toBe(1);
    const after = JSON.parse(readFileSync(join(D("foo"), "_loops.json"), "utf8")).loops as { enabled: boolean }[];
    expect(after.map((l) => l.enabled)).toEqual([true, false]);
    expect(existsSync(join(V, "build", "playbooks", `${b.playbooks[0]}.json`))).toBe(true);
  });
});

describe("the weekly check and the quarterly review", () => {
  const doc = parseCompass(`# Compass

## Goals
- [ ] Foo goal ~id:g-1 ~status:active
  path: Foo daily ~id:p-a ~status:chosen ~until:2026-12-31
    expect: m-prompts>=5
    stop: m-calm<3 for 3 weeks
  path: Foo weekly ~id:p-b ~status:chosen ~until:2026-09-01
    expect: m-prompts>=5
  path: Foo other ~id:p-c ~status:proposed
`);
  const base = { now: NOW, chosenAt: () => NOW - 60 * DAY, ranRecently: () => true as boolean | null, rulesBroken: [] as string[], alternatives: (_g: string, except: string) => (except === "p-c" ? [] : ["Foo other"]) };

  test("on track, missing before and after the commit date, the stop rule, too early, a broken rule", () => {
    const ok = checkPathsWith(doc, (m) => (m === "m-prompts" ? [6, 7, 5, 6] : [4, 4, 4]), base);
    expect(ok.map((x) => x.state)).toEqual(["on-track", "on-track"]);
    const miss = checkPathsWith(doc, (m) => (m === "m-prompts" ? [1, 2, 1, 2] : [4, 4, 4]), base);
    expect(miss.map((x) => [x.state, x.reopen])).toEqual([["missing", false], ["missing", true]]);
    expect(miss[0]!.proposal).toContain("Keep going until 2026-12-31 as committed");
    expect(miss[1]!.proposal).toContain("Switch to Foo other");
    const stop = checkPathsWith(doc, (m) => (m === "m-prompts" ? [6, 6, 6, 6] : [2, 2, 2]), base);
    expect(stop[0]!.state).toBe("stop");
    expect(checkPathsWith(doc, () => [6, 6, 6, 6], { ...base, chosenAt: () => NOW - 3 * DAY }).map((x) => x.state)).toEqual(["too-early", "too-early"]);
    const broken = checkPathsWith(doc, (m) => (m === "m-prompts" ? [1, 1, 1, 1] : [4, 4, 4]), { ...base, rulesBroken: ["Family time"] });
    expect(broken[0]!.reopen).toBe(true);
    expect(broken[0]!.proposal).toContain("A non-negotiable is broken (Family time)");
    expect(checkPathsWith(doc, () => [6, 6, 6, 6], { ...base, ranRecently: () => false }).map((x) => x.state)).toEqual(["missing", "missing"]);
  });

  test("the quarterly review writes one page in General", async () => {
    seed();
    const r = await quarterlyReview(V, NOW);
    expect(r.quarter).toBe("2026-Q4");
    expect(readFileSync(join(V, r.file), "utf8")).toContain("# Initiatives, 2026-Q4");
  });
});
