// Today T3: the radar. Synthetic histories where each slip is known: every one
// must be flagged before its due date (the plan asks for 80%), and the quiet
// ones must not be. Routines measured by rolling rates, routine candidates in
// the user's words, and the radar on the Today card and in the review.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapRoutines, computeRadarSync, perWeek, routineCandidates, routineState } from "./radar.ts";
import type { HeaderLite } from "./commitments.ts";
import { openDecision } from "./decision-records.ts";
import { composeToday } from "./today.ts";
import { tryInterrupt } from "./interruptions.ts";

const ROOT = join("/tmp", `prevail-radar-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = new Date(2026, 9, 1, 12).getTime(); // Thu 2026-10-01
const DAY = 86_400_000;
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta", "entities"), { recursive: true });
  for (const d of ["general", "foo", "bar"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), "{}"); }
}

describe("routines", () => {
  test("cadences and rolling rates; two misses under the normal is slipping, never a streak", () => {
    expect([perWeek("weekly"), perWeek("daily"), perWeek("3x-week"), perWeek("5d"), perWeek("monthly"), perWeek("sometimes")]).toEqual([1, 7, 3, 1.4, 0.25, null]);
    const r = { id: "rt-a", title: "Foo run", cadence: "3x-week", metric: "m-workouts" };
    const slipping = routineState(r, [3, 3, 4, 3, 3, 2, 3, 3, 3, 3, 1, 0]);
    expect(slipping).toMatchObject({ met4: 2, normalMet: 3.5, slipping: true, text: "Foo run: 2 of the last 4 weeks on target (normal 3.5)" });
    expect(routineState(r, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2]).slipping).toBe(false); // one miss
    expect(routineState(r, [0, 0, 1, 0, 0, 0, 0, 0, 1, 3, 0, 0]).slipping).toBe(false); // already its normal
  });
  test("candidates come from Habits and routines in the user's words; bootstrap adds them as proposed", () => {
    seed();
    writeFileSync(join(D("foo"), "ideal-state.md"), "# Foo\n\n## Habits and routines\nPlan the week every Sunday evening. Run 3 times a week. Keep things tidy.\n\n## What to avoid\nDaily panic.\n");
    const c = routineCandidates(V);
    expect(c.map((x) => [x.title, x.cadence])).toEqual([["Plan the week every Sunday evening", "weekly"], ["Run 3 times a week", "3x-week"]]);
    const r = bootstrapRoutines(V, NOW);
    expect(r.added.length).toBe(2);
    const text = readFileSync(join(V, "build", "compass.md"), "utf8");
    expect(text).toContain("## Routines");
    expect(text).toMatch(/- Run 3 times a week ~id:rt-\w+ ~cadence:3x-week( ~metric:\S+)? ~status:proposed\n  words: "Run 3 times a week\."/);
    expect(bootstrapRoutines(V, NOW).added).toEqual([]);
  });
});

describe("the radar eval: known slips flagged before they are due", () => {
  beforeEach(seed);
  test("synthetic histories: at least 80% flagged before the due date, quiet ones not flagged", () => {
    const at = (offset: number) => ymd(NOW + offset * DAY);
    // Ten promises that will slip (due in 1 to 3 days, nothing done), five that will not (mail sent since).
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`- [ ] Slip ${i} @${at(1 + (i % 3))} +${at(-5)} ~id:s${i} ~kind:commitment ~to:person/casey`);
    for (let i = 0; i < 5; i++) lines.push(`- [ ] Fine ${i} @${at(2)} +${at(-5)} ~id:f${i} ~kind:commitment ~to:person/jordan`);
    lines.push(`- [ ] Renew the foo policy @${at(20)} ~id:a1`);
    writeFileSync(join(D("foo"), "memory", "tasks.md"), lines.join("\n"));
    const headers: HeaderLite[] = [
      { id: "1", thread: "j", ts: NOW - 2 * DAY, dir: "sent", from: "me@x.com", to: ["jordan@x.com"], subject: "On it" },
      // A question to Sam, who answers within a day; asked four days ago.
      ...[1, 2, 3].flatMap((k) => [{ id: `q${k}`, thread: `old${k}`, ts: NOW - (30 + k) * DAY, dir: "sent" as const, from: "me@x.com", to: ["sam@x.com"], subject: "q" }, { id: `a${k}`, thread: `old${k}`, ts: NOW - (30 + k) * DAY + 6 * 3_600_000, dir: "received" as const, from: "sam@x.com", to: ["me@x.com"], subject: "a" }]),
      { id: "w", thread: "new", ts: NOW - 4 * DAY, dir: "sent", from: "me@x.com", to: ["sam@x.com"], subject: "Can you send the foo lease?", asks: true },
    ];
    mkdirSync(join(V, "data", "apps", "foo-app"), { recursive: true });
    writeFileSync(join(V, "data", "apps", "foo-app", "manifest.json"), JSON.stringify({ name: "Foo app", renewal: { next: at(6) } }));
    openDecision(V, { question: "Keep the foo car?", domain: "foo", due: at(-1) });
    // A person seen every week who has gone quiet for three weeks.
    writeFileSync(join(V, "build", "_meta", "entities", "index.json"), JSON.stringify({ entities: [{ id: "person/alex-reed", name: "Alex Reed", kind: "person", relation: "yours", home_domain: "bar", mentions: [8, 15, 22, 29].map((w) => ({ ts: NOW - (w + 21) * DAY })) }] }));
    const r = computeRadarSync(V, { now: NOW, headers });
    const keys = new Set(r.items.map((x) => x.key));
    const planted = [...Array.from({ length: 10 }, (_, i) => `commitment:foo:s${i}`), "waiting:mail:new", "admin:app:foo-app:renews", "decision:foo:keep-the-foo-car", "relationship:person/alex-reed", "admin:task:foo:a1"];
    const flagged = planted.filter((k) => keys.has(k));
    expect(flagged.length / planted.length).toBeGreaterThanOrEqual(0.8);
    expect(flagged).toEqual(planted);
    for (let i = 0; i < 5; i++) expect(keys.has(`commitment:foo:f${i}`)).toBe(false);
    // Each flagged slip is before its due date (the run is at NOW, every due is later, except the decision already past due).
    for (const x of r.items.filter((y) => y.due && y.kind !== "decision")) expect(x.due! >= ymd(NOW)).toBe(true);
    expect(r.items[0]!.severity).toBeGreaterThanOrEqual(4);
  });
  test("routines and paths with a weekly series; quiet goals; overdue promises may interrupt within the budget", () => {
    writeFileSync(join(V, "build", "compass.md"), "# Compass\n\n## Goals\n- [ ] Foo fitness ~id:g-f ~status:active ~domain:bar\n  path: Morning runs ~id:p-run ~status:chosen\n    expect: m-workouts>=3\n\n## Routines\n- Run 3 times a week ~id:rt-run ~cadence:3x-week ~metric:m-workouts\n");
    utimesSync(join(D("bar"), "memory"), new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
    writeFileSync(join(D("foo"), "memory", "tasks.md"), `- [ ] Return the foo drill @${ymd(NOW - 2 * DAY)} ~id:o1 ~kind:commitment ~to:person/jordan`);
    const weekly = (m: string) => (m === "m-workouts" ? [3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 0, 0] : []);
    const r = computeRadarSync(V, { now: NOW, weekly });
    const by = (k: string) => r.items.find((x) => x.key === k);
    expect(by("routine:rt-run")!.evidence).toBe("Run 3 times a week: 1 of the last 4 weeks on target (normal 4)");
    expect(by("path:p-run:m-workouts")!.evidence).toContain("expected >= 3");
    expect(by("commitment:foo:o1")!.interrupt).toBe("overdue-promise");
    expect(tryInterrupt(V, { kind: "overdue-promise", text: "x", key: "commitment:foo:o1" }, NOW).ok).toBe(true);
  });
  test("Today shows one thing falling behind, from the radar, with how many more", () => {
    writeFileSync(join(D("foo"), "memory", "tasks.md"), `- [ ] Return the foo drill @${ymd(NOW - 2 * DAY)} ~id:o1 ~kind:commitment ~to:person/jordan\n- [ ] Renew the foo license @${ymd(NOW + 5 * DAY)} ~id:a2\n`);
    mkdirSync(join(V, "data", "apps", "foo-app"), { recursive: true });
    writeFileSync(join(V, "data", "apps", "foo-app", "manifest.json"), JSON.stringify({ name: "Foo app", trial: { ends: ymd(NOW + DAY) } }));
    const card = composeToday(V, { now: NOW, refresh: true });
    expect(card.fallingBehind).toMatchObject({ kind: "admin" });
    expect(card.fallingBehind!.text).toContain("Foo app trial ends");
    expect(card.fallingBehind!.count).toBeGreaterThanOrEqual(2);
  });
});

