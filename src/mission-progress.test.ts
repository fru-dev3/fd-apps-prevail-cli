// Missions MS4: progress without data entry. An invented "Learn the cello"
// mission: lessons come from the calendar and practice from what is said in
// its chat, for two weeks, with no data entry; charges from a matching
// merchant land on the ledger once; milestones check themselves; holds ask
// and invites stay drafts; the Compass path is linked; Today shows a mission
// item only when one is due or slipping; the radar, nudges and the review.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkMilestones, createMission, milestone, missionDir, readLedger, readLinks, readMission, setMission, transition } from "./missions.ts";
import {
  approveEvent, createEvent, linkPath, matchMissions, missionFromPath, missionMetricProposals, missionNudges, missionRadar, missionReviewLines,
  missionSaid, missionToday, routineDrafts, totalSince, trackMissionMetric,
} from "./mission-progress.ts";
import { noteSaid } from "./said.ts";
import { computeMetrics, weekly } from "./metrics.ts";
import { writeSourceEvents } from "./source-sync.ts";
import { composeToday } from "./today.ts";
import { planCloseout } from "./closeout.ts";
import { tryInterrupt } from "./interruptions.ts";

const ROOT = join("/tmp", `prevail-msprog-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const DAY = 86_400_000;
const START = new Date(2026, 8, 14, 12).getTime(); // Mon 2026-09-14
const NOW = START + 17 * DAY;                        // Thu 2026-10-01
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "hobbies", "money"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), "{}"); }
  const v = createMission(V, { name: "Learn the cello", outcome: "Learn to play three foo pieces", target: ymd(START + 270 * DAY), start: ymd(START), domains: [{ slug: "hobbies", role: "owner" }, { slug: "money", role: "consulted" }], budgetUsd: 1000, budgetLines: [{ id: "lessons", label: "Lessons", usd: 800 }, { id: "other", label: "Other", usd: 200 }], now: START });
  setMission(V, v.slug, { match: { calendar: ["cello lesson"], email_from: ["@foo-music.example"], merchants: ["FOO MUSIC SCHOOL"] } }, START);
  return v.slug;
}

const calendar = () => [0, 7, 14].map((d, i) => ({ id: `e${i}`, title: "Cello lesson with the foo teacher", start: new Date(START + (d + 5) * DAY).toISOString(), end: new Date(START + (d + 5) * DAY + 3_600_000).toISOString() }))
  .concat([{ id: "e9", title: "Cello lesson with the foo teacher", start: new Date(NOW + 2 * DAY).toISOString(), end: new Date(NOW + 2 * DAY + 3_600_000).toISOString() }, { id: "x", title: "Dentist", start: new Date(NOW).toISOString(), end: new Date(NOW + 3_600_000).toISOString() }]);

describe("progress without data entry", () => {
  test("two weeks of lessons from the calendar and practice said in chat count, with no data entry", async () => {
    const slug = seed();
    const r = matchMissions(V, { now: NOW, calendar: calendar(), host: "testhost" });
    // Four matched (one is next week), two of them already happened; the dentist is not the mission's.
    expect(r.results[0]).toMatchObject({ slug, linked: 4, events: 2 });
    expect(readLinks(V, slug).calendar.map((c) => c.event)).toEqual(["e0", "e1", "e2", "e9"]);
    writeSourceEvents(V, "missions", r.events, "testhost", NOW);
    // Practice said in the mission's chat over two weeks.
    for (const d of [1, 3, 6, 8, 10, 13]) noteSaid(V, { text: `practiced ${d % 2 ? 30 : 45} min today`, domain: `_mission-${slug}`, now: START + d * DAY });
    noteSaid(V, { text: "practiced 20 min on the foo etude", domain: "hobbies", now: START + 2 * DAY }); // not in the mission
    const m = readMission(V, slug)!;
    const props = missionMetricProposals(m);
    expect(props.map((p) => p.key)).toEqual([`${slug}:sessions`, `${slug}:minutes`, `${slug}:events`]);
    for (const p of props) trackMissionMetric(V, slug, p.key, NOW);
    expect(readMission(V, slug)!.metrics).toEqual([`m-${slug}-sessions`, `m-${slug}-minutes`, `m-${slug}-events`]);
    const c = await computeMetrics(V, { now: NOW, home: ROOT });
    const sum = (id: string) => [...weekly(c.points[id] ?? []).values()].reduce((a, b) => a + b, 0);
    expect(sum(`m-${slug}-sessions`)).toBe(6);
    expect(sum(`m-${slug}-minutes`)).toBe(3 * 30 + 3 * 45);
    expect(sum(`m-${slug}-events`)).toBe(2);
    // A milestone checks itself from the lessons counted.
    milestone(V, slug, "add", { title: "Two lessons", check: `m-${slug}-events>=2`, due: ymd(NOW + 30 * DAY) }, NOW);
    milestone(V, slug, "add", { title: "Ten lessons", check: `m-${slug}-events>=10`, due: ymd(NOW + 90 * DAY) }, NOW);
    const hit = checkMilestones(V, slug, (id) => totalSince(c.points, id, ymd(START)), NOW);
    expect(hit.map((x) => x.title)).toEqual(["Two lessons"]);
  });
  test("a matching charge and a spend said in chat land on the ledger once", () => {
    const slug = seed();
    const charges = [{ date: ymd(START + 2 * DAY), desc: "FOO MUSIC SCHOOL TERM 1 LESSONS", usd: 240, id: "c1" }, { date: ymd(START + 3 * DAY), desc: "GROCERY", usd: 50, id: "c2" }];
    matchMissions(V, { now: NOW, charges });
    matchMissions(V, { now: NOW, charges });
    expect(missionSaid(V, slug, "I paid $35 for rosin and strings", "t1", NOW)).toEqual({ spent: 35 });
    expect(missionSaid(V, slug, "I paid $35 for rosin and strings", "t1", NOW)).toEqual({});
    expect(missionSaid(V, slug, "what should I practice?", "t1", NOW)).toEqual({});
    expect(readLedger(V, slug).map((x) => [x.line, x.usd, x.by])).toEqual([["lessons", -240, "matched"], ["other", -35, "user"]]);
  });
});

describe("match rules from the CLI", () => {
  test("missions set takes the match rules", async () => {
    seed();
    const { missionsCommand } = await import("./missions-cli.ts");
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
    try { await missionsCommand(["set", "learn-the-cello", "--match-calendar", "cello lesson, recital", "--match-merchants", "", "--json"], V); } finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
    expect(readMission(V, "learn-the-cello")!.match).toEqual({ calendar: ["cello lesson", "recital"], email_from: ["@foo-music.example"], merchants: [] });
  });
});

describe("calendar holds and the Compass", () => {
  beforeEach(() => { seed(); });
  test("a hold asks and is created only on a yes; with other people it stays a draft", async () => {
    const slug = "learn-the-cello";
    const hold = createEvent(V, slug, { title: "Practice block", start: "2026-10-05T18:00" }, NOW);
    expect(hold.status).toBe("ask");
    const invite = createEvent(V, slug, { title: "Recital", start: "2027-06-14T18:00", attendees: ["guest@example.com"] }, NOW);
    expect(invite.status).toBe("draft");
    await expect(approveEvent(V, slug, invite.id, async () => ({ ok: true, id: "never" }))).rejects.toThrow(/draft/);
    const failed = await approveEvent(V, slug, hold.id, async () => ({ ok: false, error: "no Google calendar is connected on this Mac" }), NOW);
    expect(failed).toMatchObject({ status: "ask", note: "not created: no Google calendar is connected on this Mac" });
    const made = await approveEvent(V, slug, hold.id, async () => ({ ok: true, id: "cal-123" }), NOW);
    expect(made.status).toBe("created");
    expect(readLinks(V, slug).calendar.some((c) => c.event === "cal-123")).toBe(true);
  });
  test("a mission linked to a path writes mission: under it; a chosen path starts a mission", async () => {
    writeFileSync(join(V, "build", "compass.md"), "# Compass\n\n## Goals\n- [ ] Play for the family ~id:g-play ~status:active ~domain:hobbies\n  path: Weekly cello lessons ~id:p-lessons ~status:chosen ~until:2027-06-30\n");
    expect(await linkPath(V, "learn-the-cello", "p-lessons", NOW)).toBe(true);
    expect(readFileSync(join(V, "build", "compass.md"), "utf8")).toContain("  initiative: Weekly cello lessons ~id:p-lessons ~status:chosen ~until:2027-06-30\n    mission: learn-the-cello");
    const v = await missionFromPath(V, "p-lessons", NOW);
    expect(v).toMatchObject({ goal: "g-play", path: "p-lessons", target: "2027-06-30" });
    expect(v.domains).toEqual([{ slug: "hobbies", role: "owner" }]);
  });
});

describe("Today, the radar, nudges and the review", () => {
  test("Today shows a mission item only when something is due or slipping", () => {
    const slug = seed();
    milestone(V, slug, "add", { title: "Term 1 finished", due: ymd(NOW + 40 * DAY) }, NOW);
    expect(missionToday(V, ymd(NOW))).toEqual([]);
    expect(composeToday(V, { now: NOW, refresh: true }).items.some((x) => x.kind === "mission")).toBe(false);
    milestone(V, slug, "add", { title: "First piece", due: ymd(NOW + 3 * DAY) }, NOW);
    const t = missionToday(V, ymd(NOW));
    expect(t.map((x) => [x.kind, x.title])).toEqual([["milestone", "Learn the cello: First piece"]]);
    const card = composeToday(V, { now: NOW, refresh: true });
    expect(card.items.find((x) => x.kind === "mission")).toMatchObject({ title: "Learn the cello: First piece", thread: ["Learn the cello"], unlinked: true });
  });
  test("the radar: gone quiet, behind the calendar, budget past 80%, target passed; nudges spend the budget, one a week each", async () => {
    const slug = seed();
    milestone(V, slug, "add", { title: "Late piece", due: ymd(NOW - 2 * DAY) }, NOW);
    for (const f of ["memory/log.md", "milestones.md", "links.json", "mission.md", "memory/threads"]) { try { utimesSync(join(missionDir(V, slug), f), new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY)); } catch { /* absent */ } }
    matchMissions(V, { now: NOW, charges: [{ date: ymd(START), desc: "FOO MUSIC SCHOOL", usd: 850, id: "c9" }] });
    for (const f of ["memory/log.md", "memory/ledger.jsonl"]) utimesSync(join(missionDir(V, slug), f), new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY));
    let r = missionRadar(V, NOW);
    expect(r.map((x) => x.key).sort()).toEqual([`mission:${slug}:budget`, `mission:${slug}:ms-late-piece`, `mission:${slug}:quiet`].sort());
    setMission(V, slug, { target: ymd(NOW - DAY) }, NOW);
    r = missionRadar(V, NOW);
    expect(r.some((x) => x.key === `mission:${slug}:target` && /extend, complete or pause/.test(x.text))).toBe(true);
    const sent = await missionNudges(V, r, NOW);
    expect(sent.filter((x) => x.ok).length).toBe(1);
    expect(sent.find((x) => !x.ok)!.why).toBe("this mission's nudges this week are used");
    setMission(V, slug, { muted: true }, NOW);
    expect(await missionNudges(V, r, NOW + DAY)).toEqual([]);
    // The global budget still holds: two more slots this week at most.
    tryInterrupt(V, { kind: "overdue-promise", text: "a", key: "a" }, NOW);
    tryInterrupt(V, { kind: "overdue-promise", text: "b", key: "b" }, NOW);
    expect(tryInterrupt(V, { kind: "mission-nudge", text: "c", key: "c" }, NOW).ok).toBe(false);
  });
  test("one review line per active mission; more than seven asks to pause some", () => {
    seed();
    expect(missionReviewLines(V, NOW)[0]).toMatch(/^Learn the cello: day 18 of 271, 0 of 0 milestones, \$0 of \$1000\.$/);
    for (let i = 0; i < 7; i++) createMission(V, { name: `Foo effort ${i}`, now: NOW });
    expect(missionReviewLines(V, NOW).at(-1)).toBe("8 missions are active. Pause some?");
    transition(V, "foo-effort-0", "pause", { now: NOW });
    expect(missionReviewLines(V, NOW).length).toBe(7);
  });
  test("the close-out drafts the routines the mission built, unticked", () => {
    const slug = seed();
    for (const d of [20, 22, 24, 26, 27]) noteSaid(V, { text: "practiced 30 min", domain: `_mission-${slug}`, now: NOW - 28 * DAY + d * DAY });
    expect(routineDrafts(V, slug, NOW)).toEqual(["Practice sessions: about 1 a week"]);
    const plan = planCloseout(V, slug, { now: NOW });
    expect(plan.filings.find((f) => f.kind === "routine")).toMatchObject({ domain: "hobbies", text: "Practice sessions: about 1 a week", apply: false });
  });
});
