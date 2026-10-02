import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTasks, renderTasks } from "./tasks.ts";
import { applyOpenLoopsFold, cleanLoop, composeToday, pickThree, planOpenLoopsFold, readWeights, rocWeights, todayFeedback, todayStats, todayText, type TodayItem } from "./today.ts";
import { calibration, decide, listDecisions, openDecision, readRecord, retro, setGut, setRecommendation } from "./decision-records.ts";
import { readDecisions } from "./decisions.ts";

const ROOT = join("/tmp", `prevail-today-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = Date.UTC(2026, 9, 2, 14); // Friday Oct 2

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "money", "family", "home"]) mkdirSync(join(D(d), "memory"), { recursive: true });
  writeFileSync(join(V, "build", "compass.md"), [
    "# Compass", "", "## Values",
    "- Family presence ~id:v-family ~rank:1", "- Peace of mind ~id:v-peace ~rank:2", "- Freedom ~id:v-free ~rank:3", "",
    "## Goals",
    "- [ ] Cash buffer of a year ~id:g-buffer ~serves:v-peace,v-free ~status:active ~domain:money",
    "- [ ] Weekly foo hike with my son ~id:g-hike ~serves:v-family ~status:active ~domain:family", "",
  ].join("\n"));
  writeFileSync(join(D("money"), "memory", "tasks.md"), [
    "# Tasks", "",
    "- [ ] Move the foo savings to the bar account @2026-10-02 ~id:m1",
    "- [ ] Send the quote request to Sam @2026-10-03 ~kind:commitment ~to:person/sam-foo ~src:gmail:abc123 ~id:m2",
    "- [ ] Review the bar statement @2026-10-01 ~id:m3",
    "- [x] Old done task @2026-09-01 ~id:m4",
    "- [ ] No date task ~id:m5",
  ].join("\n"));
  writeFileSync(join(D("family"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Book the hike permit @2026-10-09 ~id:f1\n");
  writeFileSync(join(D("home"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Fix the foo gutter @2026-09-10 ~priority:high\n- [ ] Revised lease from the property manager @2026-10-07 ~kind:waiting ~from:person/pat-bar ~id:h2\n");
}

describe("task grammar: commitments and waiting-fors", () => {
  test("~kind, ~to, ~from and ~src round-trip", () => {
    const md = "# Tasks\n\n- [ ] Send the quote request @2026-10-03 ~src:gmail:abc123 ~id:a1 ~kind:commitment ~to:person/sam-foo\n- [ ] Revised lease ~src:chat:t1 ~id:a2 ~kind:waiting ~from:person/pat-bar\n- [ ] Old style ~loop ~id:a3\n";
    const t = parseTasks(md);
    expect(t[0]).toMatchObject({ text: "Send the quote request", due: "2026-10-03", source: "gmail:abc123", kind: "commitment", to: "person/sam-foo" });
    expect(t[1]).toMatchObject({ kind: "waiting", from: "person/pat-bar", source: "chat:t1" });
    expect(t[2]!.source).toBe("loop");
    expect(renderTasks(t)).toBe(md);
  });
});

describe("open decisions", () => {
  beforeEach(seed);
  test("open, gut first, recommendation, decide (logged), 90-day retro feeds calibration", () => {
    const r = openDecision(V, { question: "Keep or sell the foo rental?", domain: "home", due: "2026-10-15", consulted: ["money"], options: ["Keep", "Sell"] });
    expect(r.slug).toBe("keep-or-sell-the-foo-rental");
    expect(listDecisions(V).map((x) => x.slug)).toEqual(["keep-or-sell-the-foo-rental"]);
    setGut(V, "home", r.slug, "sell");
    setRecommendation(V, "home", r.slug, { line: "keep", confidence: "medium", body: "Cash flow covers it." });
    const d = decide(V, "home", r.slug, "keep", "the numbers", NOW);
    expect(d.retroDue).toBe("2026-12-31");
    expect(listDecisions(V)).toEqual([]);
    expect(readDecisions(V, "home")[0]).toMatchObject({ type: "decision", verdict: "keep", gut: "sell", recommendation: "keep" });
    retro(V, "home", r.slug, "Rents rose; keeping was right.", "recommendation");
    expect(readRecord(V, "home", r.slug)!.sections.Retro).toContain("Rents rose");
    expect(calibration(V)).toEqual([{ domain: "home", retros: 1, gutRight: 0, recommendationRight: 1, pending: 0 }]);
    expect(readFileSync(r.file, "utf8")).not.toMatch(/\u2014/);
  });
});

describe("Today", () => {
  beforeEach(seed);
  test("rank-order centroid weights", () => {
    expect(rocWeights(3).map((w) => Math.round(w * 1000))).toEqual([611, 278, 111]);
  });
  test("three things that matter, each with its thread or unlinked; one falling behind; the rest also due", () => {
    openDecision(V, { question: "Keep or sell the foo rental?", domain: "home", due: "2026-10-06" });
    const c = composeToday(V, { now: NOW });
    expect(c.items.length).toBe(3);
    expect(c.items[0]!.title).toBe("Send the quote request to Sam");
    expect(c.items[0]!.kind).toBe("commitment");
    expect(c.items[0]!.person).toBe("person/sam-foo");
    expect(c.items[0]!.thread).toEqual(["Money", "Cash buffer of a year", "Peace of mind", "Freedom"]);
    // The top value (family) takes a place.
    expect(c.items.some((x) => x.thread.includes("Family presence"))).toBe(true);
    const home = [...c.items, ...c.alsoDue].find((x) => x.domain === "home" && x.kind === "task");
    expect(home?.unlinked).toBe(true);
    expect(home?.thread).toEqual(["Home"]);
    // The permit (an admin deadline on the radar) is already among the three, so falling behind is the oldest overdue task.
    expect(c.fallingBehind?.text).toContain("Fix the foo gutter");
    expect(c.decisionDue?.question).toBe("Keep or sell the foo rental?");
    expect(c.yourDay.connected).toBe(false);
    expect(existsSync(join(V, "build", "_meta", "today", "2026-10-02.json"))).toBe(true);
    // The same day returns the same card.
    expect(composeToday(V, { now: NOW + 3600_000 }).generated).toBe(c.generated);
    const t = todayText(c);
    expect(t).toContain("WHAT MATTERS TODAY");
    expect(t).not.toMatch(/\u2014/);
  });
  test("at most one per domain unless pressing, and never three from one domain", () => {
    const it = (key: string, domain: string, due: string, score: number): TodayItem => ({ key, kind: "task", title: key, domain, due, thread: [domain], unlinked: false, why: "", score, ref: { domain } });
    const p = pickThree([it("a", "x", "2026-10-09", 3), it("b", "x", "2026-10-09", 2), it("c", "y", "2026-10-09", 1), it("d", "z", "2026-10-09", 0.5)], "2026-10-02");
    expect(p.map((x) => x.key)).toEqual(["a", "c", "d"]);
    const q = pickThree([it("a", "x", "2026-09-01", 3), it("b", "x", "2026-09-02", 2), it("c", "x", "2026-09-03", 1), it("d", "z", "2026-10-09", 0.5)], "2026-10-02");
    expect(q.map((x) => x.key)).toEqual(["a", "b", "d"]);
  });
  test("taps retrain the weights; done checks the task off, move puts it on tomorrow", () => {
    const c = composeToday(V, { now: NOW });
    const money = c.items.find((x) => x.ref.id === "m2")!;
    todayFeedback(V, money.key, "done", NOW);
    expect(readFileSync(join(D("money"), "memory", "tasks.md"), "utf8")).toContain("- [x] Send the quote request to Sam @2026-10-03 ~kind:commitment ~to:person/sam-foo ~src:gmail:abc123 ~id:m2 ~closed:2026-10-02");
    const other = c.items.find((x) => x.key !== money.key && x.ref.id)!;
    todayFeedback(V, other.key, "move", NOW);
    expect(readFileSync(join(D(other.domain), "memory", "tasks.md"), "utf8")).toContain("@2026-10-03 ~id:");
    todayFeedback(V, c.items[2]!.key, "not-important", NOW);
    const w = readWeights(V);
    expect(w.domain.money).toBeGreaterThan(1);
    expect(w.domain[c.items[2]!.domain]).toBeLessThan(1);
    // A recompose keeps the taps and leaves handled items out.
    const again = composeToday(V, { now: NOW, refresh: true });
    expect(again.items.some((x) => x.key === money.key)).toBe(false);
    expect(again.feedback.length).toBe(3);
    expect(todayStats(V, 3, NOW)[0]).toMatchObject({ date: "2026-10-02" });
  });
});

describe("folding open-loops files", () => {
  beforeEach(seed);
  test("each open line becomes a task, a waiting-for or a decision, unless the board has it; the file is kept as a backup", () => {
    writeFileSync(join(D("money"), "memory", "open-loops.md"), [
      "# Money, open loops", "",
      "- [ ] 2026-10-20 \u2014 Renew the foo card",
      "- [ ] PENDING \u2014 **Refund** from the bar store, awaiting their reply",
      "- [ ] [DECIDE] \u2014 keep the bar account or close it",
      "- [ ] 2026-07-01 \u2014 Old foo deadline that passed",
      "- [ ] Review the bar statement",
      "- [x] Done already",
    ].join("\n"));
    const plan = planOpenLoopsFold(V, NOW);
    expect(plan.map((l) => `${l.action}:${l.text}${l.due ? `@${l.due}` : ""}`)).toEqual([
      "task:Renew the foo card@2026-10-20",
      "waiting:Refund from the bar store, awaiting their reply",
      "decision:Keep the bar account or close it",
      "task:Old foo deadline that passed (was 2026-07-01)",
      "duplicate:Review the bar statement",
    ]);
    expect(cleanLoop("- [ ] By 2026-07-31 \u2014 Confirm foo status").text).toBe("Confirm foo status");
    const r = applyOpenLoopsFold(V, plan, NOW);
    expect(r).toMatchObject({ tasks: 3, decisions: 1, duplicates: 1 });
    const board = readFileSync(join(D("money"), "memory", "tasks.md"), "utf8");
    expect(board).toContain("- [ ] Renew the foo card @2026-10-20 +2026-10-02 ~src:open-loops ~id:");
    expect(parseTasks(board).find((t) => t.text.startsWith("Refund"))?.kind).toBe("waiting");
    expect(existsSync(join(D("money"), "memory", "open-loops.md"))).toBe(false);
    expect(readFileSync(join(D("money"), "memory", "open-loops.md.pre-today-2026-10-02"), "utf8")).toContain("Done already");
    expect(listDecisions(V)[0]!.question).toBe("Keep the bar account or close it");
    expect(board).not.toMatch(/\u2014/);
  });
});
