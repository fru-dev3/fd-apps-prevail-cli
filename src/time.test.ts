// Today T5: time follows values. Built against the stored shape the calendar
// reader writes (build/_meta/calendar/events.<account>.json), with invented
// events: hours by value against rank, next week against capacity, protected
// blocks in free slots that ask (or run alone when the owner says so),
// drafted declines for meetings that serve nothing, the day line, and an
// honest "not connected".
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveHold, capacityFor, capacityWarning, classify, dayLine, declineHold, freeSlot, lensOf, proposeTime, readDeclines, readHolds, weekTime } from "./time.ts";
import type { CalEvent } from "./source-sync.ts";

const ROOT = join("/tmp", `prevail-time-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = new Date(2026, 9, 2, 10).getTime(); // Fri 2026-10-02, 10:00
const at = (day: number, h: number, m = 0) => new Date(2026, day > 20 ? 8 : 9, day, h, m).toISOString(); // 28 to 30 are September
const ev = (id: string, title: string, day: number, h: number, hours: number, o: Partial<CalEvent> = {}): CalEvent => ({ id, account: "test", calendar: "primary", title, start: at(day, h), end: new Date(Date.parse(at(day, h)) + hours * 3_600_000).toISOString(), all_day: false, attendees: 2, ...o });

function seed(events: CalEvent[] | null) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo", "bar"]) mkdirSync(join(D(d), "memory"), { recursive: true });
  writeFileSync(join(D("foo"), "manifest.json"), JSON.stringify({ routing: { keywords: ["foo client", "invoice"] } }));
  writeFileSync(join(D("bar"), "manifest.json"), JSON.stringify({ routing: { keywords: ["bar league"] } }));
  writeFileSync(join(D("general"), "manifest.json"), "{}");
  writeFileSync(join(V, "build", "compass.md"), `# Compass

## Values
- Family presence ~id:v-fam ~rank:1
- Foo craft ~id:v-foo ~rank:2
- Bar play ~id:v-bar ~rank:3

## Goals
- [ ] Grow the foo practice ~id:g-foo ~serves:v-foo ~status:active ~domain:foo
- [ ] Bar league season ~id:g-bar ~serves:v-bar ~status:active ~domain:bar
  path: Weekly bar practice ~id:p-bar ~status:chosen ~until:2026-12-31
    hours: 6

## Capacity
- hours_for_goals_wk: 10
- meeting_hours_wk: 8
`);
  if (events) { mkdirSync(join(V, "build", "_meta", "calendar"), { recursive: true }); writeFileSync(join(V, "build", "_meta", "calendar", "events.test.json"), JSON.stringify({ events })); }
}

// This week (Mon Sep 28 to Sun Oct 4) and next (Mon Oct 5 to Sun Oct 11).
const EVENTS: CalEvent[] = [
  ev("e1", "Foo client sync", 29, 10, 2), ev("e2", "Invoice review", 30, 14, 1), ev("e3", "Kids school recital", 1, 17, 2, { attendees: 0 }),
  ev("e4", "Quarterly all-hands", 2, 11, 3), ev("e5", "Bar league game", 3, 19, 2, { attendees: 5 }), ev("e6", "Declined thing", 2, 15, 1, { self_response: "declined" }),
  ev("e7", "Focus: write", 2, 8, 1, { attendees: 0, focus: true }),
  // Next week: heavy.
  ev("n1", "Foo client workshop", 5, 9, 4), ev("n2", "Vendor pitch", 6, 13, 2), ev("n3", "Status meeting", 7, 9, 3), ev("n4", "Another status", 8, 9, 2),
];

describe("time by value", () => {
  beforeEach(() => seed(EVENTS));
  test("each event filed under a value through a mission, a domain's keywords, family words; the rest serves nothing named", async () => {
    const lens = await lensOf(V);
    expect(classify({ title: "Foo client sync", calendar: "primary" }, lens)).toMatchObject({ kind: "domain", domain: "foo", value: "v-foo" });
    expect(classify({ title: "Kids school recital", calendar: "primary" }, lens)).toMatchObject({ kind: "family", value: "v-fam" });
    expect(classify({ title: "Quarterly all-hands", calendar: "primary" }, lens).kind).toBe("none");
    const w = await weekTime(V, { now: NOW });
    expect([w.connected, w.hours, w.meetings, w.focus, w.afterHours]).toEqual([true, 11, 8, 1, 2]);
    expect(w.byValue.map((v) => [v.id, v.hours, v.share])).toEqual([["v-fam", 2, 18], ["v-foo", 3, 27], ["v-bar", 2, 18]]);
    expect(w.lines).toContain("You rank Family presence first; it got 18% of your calendar hours.");
  });

  test("next week against capacity, warned in advance", async () => {
    const next = await weekTime(V, { now: NOW, next: true });
    expect(next.meetings).toBe(11);
    expect(capacityWarning(next, await capacityFor(V))).toBe("Next week has 11 hours of meetings, over your 8; that leaves 29 of 40 hours for everything else.");
  });

  test("protected blocks ask (in free slots, never twice); declines are drafts; Approve uses the calendar writer", async () => {
    const r = await proposeTime(V, { now: NOW });
    expect(r.holds.map((h) => [h.for, h.status])).toEqual([["initiative:p-bar", "ask"]]);
    const h = r.holds[0]!;
    expect(new Date(h.start).getDay()).toBe(1);
    expect(EVENTS.filter((e) => Date.parse(e.start) < Date.parse(h.end) && Date.parse(e.end) > Date.parse(h.start))).toEqual([]);
    expect(r.declines.map((d) => d.title).sort()).toEqual(["Another status", "Status meeting", "Vendor pitch"]);
    expect(r.declines[0]!.body).toMatch(/^Hi, I can't make/);
    const again = await proposeTime(V, { now: NOW });
    expect([again.holds.length, again.declines.length, readHolds(V).length, readDeclines(V).length]).toEqual([0, 0, 1, 3]);
    const fail = await approveHold(V, h.id, async () => ({ ok: false, error: "not signed in" }), NOW);
    expect([fail.status, fail.note]).toEqual(["ask", "not created: not signed in"]);
    const ok = await approveHold(V, h.id, async () => ({ ok: true }), NOW);
    expect(ok.status).toBe("created");
    expect(declineHold(V, h.id, NOW).status).toBe("declined");
  });

  test("holds: alone in the chief of staff's file lets a hold run without asking", async () => {
    writeFileSync(join(V, "build", "chief-of-staff.md"), "---\nname: Foo\nholds: alone\n---\n");
    let wrote = 0;
    const r = await proposeTime(V, { now: NOW, write: async () => { wrote++; return { ok: true }; } });
    expect([wrote, r.holds[0]!.status]).toEqual([1, "created"]);
  });

  test("a free slot skips busy time; the day line; nothing connected says so", () => {
    const s = freeSlot([ev("x", "Busy", 5, 9, 4)], [], "2026-10-05", 1.5)!;
    expect(new Date(s.start).getHours()).toBe(13);
    expect(dayLine(V, new Date(2026, 9, 2, 7).getTime()).note).toBe("1 meeting (3 h) · focus 8 am to 9 am · nothing after 6 pm");
    seed(null);
    expect(dayLine(V, NOW)).toEqual({ connected: false, note: "No calendar is connected yet, so your day is not on the card." });
  });
});

test("no calendar: the week says so by name and nothing is proposed", async () => {
  seed(null);
  const w = await weekTime(V, { now: NOW });
  expect([w.connected, w.note]).toEqual([false, "No calendar is connected on this Mac (Google sign-in), so time by value waits for it."]);
  expect(await proposeTime(V, { now: NOW })).toEqual({ holds: [], declines: [] });
});
