// Goals G3: the planted-conflict eval (26 invented Compasses with known
// conflicts and synergies, and clean ones where nothing may be invented),
// rules checked in code, the broker gate, jobs carrying serves / costs /
// rules, the cached model pass that needs a quote, and the weekly roll-up.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCompass } from "./compass.ts";
import {
  activePaths, alignmentRollup, answerConflict, computeGraph, conflictLine, detect, evaluateRules, jobCompass, openConflicts, opposed,
  parseCheck, ruleGate, stateFromPoints, type StateValue,
} from "./compass-align.ts";
import { gateAction } from "./broker.ts";
import { dispatch } from "./jobs.ts";

const ROOT = join("/tmp", `prevail-align-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

interface P { title: string; status?: string; f?: Record<string, string> }
interface G { title: string; id: string; serves?: string; status?: string; domain?: string; paths?: P[] }
function compass(o: { values?: [string, string][]; goals?: G[]; rules?: [string, string, string?][]; capacity?: Record<string, number> }): string {
  const out = ["# Compass", "", "## Values"];
  (o.values ?? [["Calm", "v-calm"], ["Family presence", "v-family"], ["Freedom", "v-free"]]).forEach(([t, id], i) => out.push(`- ${t} ~id:${id} ~rank:${i + 1}`));
  out.push("", "## Goals");
  for (const g of o.goals ?? []) {
    out.push(`- [ ] ${g.title} ~id:${g.id}${g.serves ? ` ~serves:${g.serves}` : ""} ~status:${g.status ?? "active"}${g.domain ? ` ~domain:${g.domain}` : ""}`);
    (g.paths ?? []).forEach((p, i) => {
      out.push(`  path: ${p.title} ~id:${g.id}-p${i + 1} ~status:${p.status ?? "chosen"}`);
      for (const [k, v] of Object.entries(p.f ?? {})) out.push(`    ${k}: ${v}`);
    });
  }
  out.push("", "## Non-negotiables");
  for (const [t, id, check] of o.rules ?? []) out.push(`- ${t} ~id:${id}${check ? ` ~check:${check}` : ""}`);
  out.push("", "## Capacity");
  for (const [k, v] of Object.entries(o.capacity ?? {})) out.push(`- ${k}: ${v}`);
  return `${out.join("\n")}\n`;
}
const sv = (id: string, value: number): StateValue => ({ id, title: id, value, source: "test", fresh: true });
const one = (paths: P[], extra: Partial<Parameters<typeof compass>[0]> = {}) => compass({ goals: [{ title: "Foo independence", id: "g-a", serves: "v-free", paths }], ...extra });
const two = (a: P[], b: P[], extra: Partial<Parameters<typeof compass>[0]> = {}) => compass({ goals: [{ title: "Foo independence", id: "g-a", serves: "v-free", paths: a }, { title: "Bar cabin", id: "g-b", serves: "v-calm", paths: b }], ...extra });

// [name, compass text, state vars, expected conflict kinds (sorted), expected synergy-type edges]
const FIXTURES: [string, string, StateValue[], string[], string[]][] = [
  ["hours over capacity", two([{ title: "Night classes", f: { hours: "8" } }], [{ title: "Weekend builds", f: { hours: "6" } }], { capacity: { hours_for_goals_wk: 10 } }), [], ["resource"], []],
  ["money over capacity", two([{ title: "Foo course", f: { usd: "400" } }], [{ title: "Cabin savings", f: { usd: "300" } }], { capacity: { money_for_goals_mo: 500 } }), [], ["resource"], []],
  ["stress over budget", two([{ title: "Weekly foo uploads", f: { stress: "2" } }], [{ title: "Cabin repairs", f: { stress: "2" } }], { capacity: { stress_budget: 3 } }), [], ["resource"], []],
  ["three paths over hours", compass({ goals: [{ title: "A", id: "g-a", paths: [{ title: "P1", f: { hours: "5" } }, { title: "P2", f: { hours: "4" } }, { title: "P3", f: { hours: "3" } }] }], capacity: { hours_for_goals_wk: 10 } }), [], ["resource"], []],
  ["away against home evenings", two([{ title: "Foo consulting", f: { effects: "away-often" } }], [{ title: "Family dinners", f: { needs: "home-evenings" } }]), [], ["presence"], []],
  ["home and away of the same thing", two([{ title: "Bar league", f: { effects: "away-weekends" } }], [{ title: "Weekend cabin work", f: { needs: "home-weekends" } }]), [], ["presence"], []],
  ["a thing and its absence", two([{ title: "Sell the foo car", f: { effects: "no-car" } }], [{ title: "Drive to the cabin", f: { needs: "car" } }]), [], ["presence"], []],
  ["relocate against stay put", two([{ title: "Move for the foo role", f: { effects: "relocate" } }], [{ title: "Coach the bar team", f: { needs: "stay-put" } }]), [], ["presence"], []],
  ["spend savings against a buffer", two([{ title: "Buy the cabin outright", f: { effects: "spend-savings" } }], [{ title: "Twelve months in cash", f: { needs: "cash-buffer" } }]), [], ["presence"], []],
  ["a path breaks a rule (reading)", one([{ title: "Evening foo shifts", f: { effects: "dinners_home_wk-2" } }], { rules: [["Home for dinner five nights", "nn-dinner", "dinners_home_wk>=5"]] }), [sv("dinners_home_wk", 5)], ["rule"], []],
  ["a path breaks a hard limit (no reading)", one([{ title: "Finance the cabin", f: { effects: "new_debt_usd+20000" } }], { rules: [["No new debt", "nn-debt", "new_debt_usd==0"]] }), [], ["rule"], []],
  ["a path costs sleep below the rule", one([{ title: "Early foo shift", f: { effects: "sleep_hours-1" } }], { rules: [["Seven hours of sleep", "nn-sleep", "sleep_hours>=7"]] }), [sv("sleep_hours", 7.5)], ["rule"], []],
  ["a path costs the value its goal serves", compass({ goals: [{ title: "Bar cabin", id: "g-b", serves: "v-calm", paths: [{ title: "Build it all ourselves", f: { values: "v-calm -1" } }] }] }), [], ["value"], []],
  ["one path costs what another builds", two([{ title: "Foo travel", f: { values: "v-family -1" } }], [{ title: "Sunday dinners", f: { values: "v-family +2" } }]), [], ["value"], []],
  ["a heavy cost on any value", one([{ title: "Seventy hour weeks", f: { values: "v-calm -2" } }]), [], ["value"], []],
  ["two kinds at once", two([{ title: "Foo road shows", f: { hours: "9", effects: "away-often" } }], [{ title: "Family dinners", f: { hours: "4", needs: "home-evenings" } }], { capacity: { hours_for_goals_wk: 10 } }), [], ["presence", "resource"], []],
  ["a path enables another", two([{ title: "Cash first", f: { effects: "cash-buffer" } }], [{ title: "Quit the foo job", f: { needs: "cash-buffer" } }]), [], [], ["enables"]],
  ["a shared effect is a synergy", two([{ title: "Run to work", f: { effects: "fit" } }], [{ title: "Cabin hikes", f: { effects: "fit" } }]), [], [], ["synergy"]],
  ["both build one value", two([{ title: "Family trips", f: { values: "v-family +1" } }], [{ title: "Sunday dinners", f: { values: "v-family +2" } }]), [], [], ["synergy"]],
  ["within capacity (clean)", two([{ title: "Night classes", f: { hours: "4" } }], [{ title: "Weekend builds", f: { hours: "5" } }], { capacity: { hours_for_goals_wk: 10 } }), [], [], []],
  ["a small cost the rule absorbs (clean)", one([{ title: "One late foo shift", f: { effects: "dinners_home_wk-1" } }], { rules: [["Home for dinner five nights", "nn-dinner", "dinners_home_wk>=5"]] }), [sv("dinners_home_wk", 7)], [], []],
  ["proposed paths do not count (clean)", two([{ title: "Foo consulting", status: "proposed", f: { effects: "away-often" } }], [{ title: "Family dinners", f: { needs: "home-evenings" } }]), [], [], []],
  ["a proposed rule does not count (clean)", one([{ title: "Finance the cabin", f: { effects: "new_debt_usd+20000" } }]).replace("## Non-negotiables", "## Non-negotiables\n- No new debt ~id:nn-debt ~check:new_debt_usd==0 ~status:proposed"), [], [], []],
  ["a mild cost to an unrelated value (clean)", one([{ title: "Foo evening class", f: { values: "v-calm -1" } }]), [], [], []],
  ["no capacity set (clean)", two([{ title: "Night classes", f: { hours: "30" } }], [{ title: "Weekend builds", f: { hours: "30" } }]), [], [], []],
  ["a released goal's paths are ignored (clean)", compass({ goals: [{ title: "Old foo plan", id: "g-a", status: "released", paths: [{ title: "Foo travel", f: { effects: "away-often" } }] }, { title: "Bar cabin", id: "g-b", paths: [{ title: "Family dinners", f: { needs: "home-evenings" } }] }] }), [], [], []],
];

describe("the planted-conflict eval", () => {
  test(`${FIXTURES.length} fixtures, at least 20`, () => { expect(FIXTURES.length).toBeGreaterThanOrEqual(20); });
  for (const [name, text, vars, kinds, syn] of FIXTURES) {
    test(name, () => {
      const { conflicts, edges } = detect(parseCompass(text), vars);
      expect([...new Set(conflicts.map((c) => c.kind as string))].sort()).toEqual(kinds);
      for (const c of conflicts) {
        expect(c.evidence.length).toBeGreaterThan(0);
        expect(c.question).toMatch(/\?$/);
      }
      for (const s of syn) expect(edges.some((e) => e.rel === s)).toBe(true);
      if (!kinds.length && !syn.length) expect(edges.filter((e) => e.rel !== "synergy" && e.rel !== "enables")).toEqual([]);
    });
  }
  test("the detector finds every planted conflict and invents none (precision and recall 1)", () => {
    let tp = 0, fp = 0, fn = 0;
    for (const [, text, vars, kinds] of FIXTURES) {
      const got = new Set<string>(detect(parseCompass(text), vars).conflicts.map((c) => c.kind));
      for (const k of kinds) (got.has(k) ? tp++ : fn++);
      for (const k of got) if (!kinds.includes(k)) fp++;
    }
    expect({ tp, fp, fn }).toEqual({ tp: 17, fp: 0, fn: 0 });
  });
  test("opposites", () => {
    expect(opposed("no-car", "car")).toBe(true);
    expect(opposed("home-sundays", "away-sundays")).toBe(true);
    expect(opposed("fit", "fit")).toBe(false);
  });
});

describe("rules and state", () => {
  test("checks parse; states are ok, at risk, broken or unchecked", () => {
    expect(parseCheck("dinners_home_wk>=5")).toEqual({ variable: "dinners_home_wk", op: ">=", n: 5 });
    expect(parseCheck("checkin.calm>3")).toEqual({ variable: "checkin.calm", op: ">", n: 3 });
    expect(parseCheck("nonsense")).toBeNull();
    const doc = parseCompass(compass({ rules: [["Sleep", "nn-s", "sleep_hours>=7"], ["Spend", "nn-m", "spend_usd_mo<=3000"], ["Calm", "nn-c", "checkin.calm>=3"], ["Kind words", "nn-k"], ["Debt", "nn-d", "new_debt_usd==0"]] }));
    const st = evaluateRules(doc, [sv("sleep_hours", 6.2), sv("spend_usd_mo", 2900), sv("checkin.calm", 4)]);
    expect(Object.fromEntries(st.map((r) => [r.id, r.state]))).toEqual({ "nn-s": "broken", "nn-m": "at-risk", "nn-c": "ok", "nn-k": "unchecked", "nn-d": "unchecked" });
    expect(st.find((r) => r.id === "nn-s")!.detail).toContain("sleep_hours 6.2 (needs >= 7)");
  });
  test("state variables from daily points: averages, month sums, freshness", () => {
    const now = Date.UTC(2026, 9, 2, 12);
    const days = (id: string, n: number, v: number, endAgo = 0) => Array.from({ length: n }, (_, i) => ({ date: new Date(now - (endAgo + i) * 86_400_000).toISOString().slice(0, 10), value: v }));
    const s = stateFromPoints({ "m-sleep": days("m-sleep", 7, 6.5), "m-spend": days("m-spend", 40, 10), "m-calm": days("m-calm", 1, 3, 30) }, now);
    expect(s.find((x) => x.id === "sleep_hours")).toMatchObject({ value: 6.5, fresh: true });
    expect(s.find((x) => x.id === "spend_usd_mo")!.value).toBe(300);
    expect(s.find((x) => x.id === "checkin.calm")).toMatchObject({ value: 3, fresh: false });
    expect(s.find((x) => x.id === "new_debt_usd")!.value).toBeNull();
  });
});

describe("the vault: the broker, jobs, the model pass, the roll-up", () => {
  const C = () => join(V, "build", "compass.md");
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    for (const d of ["general", "foo", "bar"]) { mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true }); writeFileSync(join(V, "data", "domains", d, "manifest.json"), "{}"); }
    mkdirSync(join(V, "build", "_meta", "compass"), { recursive: true });
    writeFileSync(C(), compass({
      goals: [
        { title: "Foo independence", id: "g-a", serves: "v-free", domain: "foo", paths: [{ title: "Foo consulting", f: { effects: "away-often", values: "v-family -1" } }] },
        { title: "Bar cabin", id: "g-b", serves: "v-calm", domain: "bar", paths: [{ title: "Family dinners", f: { needs: "home-evenings", values: "v-family +2" } }] },
      ],
      rules: [["No new debt", "nn-debt", "new_debt_usd==0"], ["Spend under 3000 a month", "nn-spend", "spend_usd_mo<=3000"]],
    }));
  });
  test("a hard limit blocks in the broker; a softer rule asks; nothing else is touched", () => {
    expect(gateAction("take out a loan for the foo cabin", { vault: V, autonomousActs: true })).toMatchObject({ decision: "block" });
    expect(gateAction("take out a loan for the foo cabin", { vault: V, autonomousActs: true }).reason).toContain("No new debt");
    expect(ruleGate(V, "order the foo boots for $80")).toMatchObject({ decision: "ask", rule: "nn-spend" });
    expect(ruleGate(V, "summarise the foo notes")).toBeNull();
  });
  test("a job carries serves, costs and rules; a rule it would break means it asks", async () => {
    await computeGraph(V, { vars: [] });
    const d = await dispatch({ vault: V, message: "Find the best foo consultancies to join next year", domain: "foo", runner: async () => JSON.stringify({ owner: "foo", consulted: [], informed: [], effort: "quick", open_ended: false, decision: false }) });
    expect(d.job!.compass!.serves.map((s) => s.id)).toEqual(["g-a", "v-free"]);
    expect(d.job!.compass!.costs.map((c) => c.id)).toContain("v-family");
    expect(d.job!.startsAlone).toBe(true);
    const loan = await dispatch({ vault: V, message: "Find the best loan for the foo cabin", domain: "foo", runner: async () => JSON.stringify({ owner: "foo", consulted: [], informed: [], effort: "quick" }) });
    expect(loan.job!.startsAlone).toBe(false);
    expect(loan.job!.askReason).toContain("No new debt");
    expect(jobCompass(V, { ask: "Find a loan", domains: { owner: "foo", consulted: [] } }).rules).toEqual([{ id: "nn-debt", title: "No new debt", state: "unchecked" }]);
  });
  test("the code pass finds the planted conflicts; accepted tensions leave the open list", async () => {
    const g = await computeGraph(V, { vars: [] });
    expect(g.conflicts.map((c) => c.kind).sort()).toEqual(["presence", "value"]);
    expect(conflictLine(V).text).toMatch(/\?$/);
    answerConflict(V, openConflicts(V)[0]!.key, "accepted");
    expect(openConflicts(V).length).toBe(1);
  });
  test("the model pass counts only a quoted answer and is cached by content", async () => {
    writeFileSync(C(), compass({ goals: [{ title: "Foo independence", id: "g-a", serves: "v-free" }, { title: "Bar cabin far from town", id: "g-b", serves: "v-calm" }] }));
    let calls = 0;
    const runner = async () => { calls++; return JSON.stringify({ relation: "-", when: "the role needs the city", evidence: "Bar cabin far from town", resolution: "a cabin within an hour" }); };
    const g = await computeGraph(V, { runner, vars: [] });
    expect(g.conflicts.map((c) => [c.kind, c.asserted_by])).toEqual([["model", "model"]]);
    await computeGraph(V, { runner, vars: [] });
    expect(calls).toBe(1);
    rmSync(join(V, "build", "_meta", "compass", "graph.json"));
    const noQuote = await computeGraph(V, { runner: async () => JSON.stringify({ relation: "--", evidence: "words they never wrote" }), vars: [] });
    expect(noQuote.conflicts).toEqual([]);
  });
  test("the weekly roll-up: matters vs lived, attention, Needs you", async () => {
    writeFileSync(join(V, "data", "domains", "foo", "memory", "tasks.md"), "- [ ] foo\n");
    const r = await alignmentRollup(V, { now: Date.now() });
    expect(r.values.map((v) => v.id)).toEqual(["v-calm", "v-family", "v-free"]);
    expect(r.values.find((v) => v.id === "v-free")!.attention).toBe(100);
    expect(r.saidVsDid[0]).toBe("You rank Calm first; it touched 0% of this month's activity.");
    expect(r.needsYou.some((n) => n.kind === "conflict")).toBe(true);
    expect(activePaths(parseCompass(compass({}))).length).toBe(0);
  });
});
