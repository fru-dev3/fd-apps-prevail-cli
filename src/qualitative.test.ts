import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMetrics, dayOf, glance, readRegistry, seedMetricsMd, weekOf } from "./metrics.ts";
import {
  answerHypothesis, askedDue, bh, guardrails, hypotheses, lagTests, mattersVsLived, pausedBy, pearson, proxies, pValueR, readWeights, recordLadder, recordWho5,
  seasons, setWho5, themeTrends,
} from "./qualitative.ts";
import { readCheckins, weeklyReview } from "./review.ts";
import { setConsent } from "./sources.ts";

const ROOT = join("/tmp", `prevail-qual-${process.pid}`);
const V = join(ROOT, "vault");
const HOME = join(ROOT, "home");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
// Wednesday 2026-09-30, noon local.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const DAY = 86_400_000;
const mondays = (n: number) => Array.from({ length: n }, (_, i) => weekOf(dayOf(NOW - (n - i) * 7 * DAY)));

// A seeded random so "noise" is the same every run.
function rng(seed: number) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

function write(src: string, rows: object[]) {
  const by = new Map<string, object[]>();
  for (const r of rows) { const m = (r as { ts: string }).ts.slice(0, 7); (by.get(m) ?? by.set(m, []).get(m)!).push(r); }
  const d = join(V, "build", "_meta", "events", src);
  mkdirSync(d, { recursive: true });
  for (const [m, rs] of by) writeFileSync(join(d, `${m}.mac-a.jsonl`), rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const ev = (src: string, kind: string, ts: string, attrs: Record<string, number | string> = {}, n = 1) => ({ ts, src, kind, n, host: "mac-a", tier: "measured", attrs });

function seed(opts: { correlated?: boolean } = {}) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general", "memory"), { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const r = rng(7);
  const weeks = mondays(20);
  const sleep: object[] = []; const calm: object[] = []; const mail: object[] = []; const cal: object[] = [];
  weeks.forEach((w, i) => {
    const hours = 6 + r() * 2;
    for (let d = 0; d < 5; d++) sleep.push(ev("apple-health", "health.sleep", dayOf(Date.parse(`${w}T12:00:00`) + d * DAY), { hours: Math.round(hours * 100) / 100 }));
    const c = opts.correlated ? Math.max(1, Math.min(5, Math.round((hours - 6) * 2 + 1))) : 1 + Math.floor(r() * 5);
    calm.push({ ...ev("checkins", "checkin.calm", w, { calm: c, week: w, at: Date.parse(`${w}T12:00:00`) }), tier: "asked" });
    // A normal of about 10 sent mails a week; the last full week is heavy.
    const heavy = i === weeks.length - 1;
    for (let d = 0; d < 5; d++) mail.push(ev("gmail", "email.sent", dayOf(Date.parse(`${w}T12:00:00`) + d * DAY), {}, heavy ? 6 : 2));
    cal.push(ev("calendar", "cal.after_hours", w, { hours: heavy ? 6 : 1 }));
    cal.push(ev("calendar", "cal.meeting", w, { hours: heavy ? 20 : 8 }));
  });
  write("apple-health", sleep); write("checkins", calm); write("gmail", mail); write("calendar", cal);
  writeFileSync(join(V, "build", "metrics.md"), seedMetricsMd().replace("## Pinned\n", "## Pinned\n- Sleep ~id:m-sleep ~per:week ~unit:hours ~tier:measured ~serves:v-peace ~enough:8\n- Emails sent ~id:m-emails-sent ~per:week ~unit:count ~tier:measured ~serves:g-work ~guard:m-calm\n") + "\n## Seasons\n- Family visit ~id:s-visit ~from:2026-09-14 ~to:2026-09-20 ~pauses:m-emails-sent\n");
  writeFileSync(join(V, "build", "compass.md"), ["# Compass", "", "## Values", "- Peace of mind ~id:v-peace ~rank:1", "- Craft ~id:v-craft ~rank:2", "- Adventure ~id:v-adv ~rank:3", "", "## Goals", "- [ ] Ship good work ~id:g-work ~serves:v-craft ~status:active", ""].join("\n"));
}

describe("asked: ladder and WHO-5", () => {
  beforeEach(() => seed());
  test("the ladder is due once a quarter; WHO-5 is off until turned on, then monthly", () => {
    expect(askedDue(V, NOW)).toEqual({ ladder: true, who5: false });
    expect(() => recordLadder(V, 11, 3)).toThrow();
    recordLadder(V, 6, 8, NOW);
    expect(askedDue(V, NOW).ladder).toBe(false);
    expect(askedDue(V, NOW + 10 * DAY).ladder).toBe(true); // October is a new quarter
    expect(() => recordWho5(V, [3, 3, 3, 3, 3], NOW)).toThrow(/off/);
    setWho5(V, true);
    expect(askedDue(V, NOW).who5).toBe(true);
    expect(recordWho5(V, [3, 4, 2, 3, 5], NOW).score).toBe(68);
    expect(askedDue(V, NOW).who5).toBe(false);
    // The calm check-in list ignores the other asked events.
    expect(readCheckins(V).every((c) => typeof c.calm === "number")).toBe(true);
  });
  test("ladder and WHO-5 become metrics", async () => {
    recordLadder(V, 6, 8, NOW);
    setWho5(V, true);
    recordWho5(V, [3, 4, 2, 3, 5], NOW);
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const g = glance(c, { ids: ["m-ladder-now", "m-ladder-future", "m-who5"] });
    expect(g.rows.map((r) => r.value)).toEqual([6, 8, 68]);
  });
});

describe("seasons, hypotheses, guardrails", () => {
  beforeEach(() => seed());
  test("seasons from metrics.md and weeks away; metrics.md's Seasons lines are not metrics", async () => {
    expect(readRegistry(V).has("s-visit")).toBe(false);
    write("timeline", ["2026-08-31", "2026-09-01", "2026-09-02"].map((d) => ev("timeline", "day.away", d)));
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const ss = seasons(V, c);
    expect(ss.map((s) => s.title)).toEqual(["Family visit", "Away"]);
    expect(pausedBy(ss, "m-emails-sent", "2026-09-14")?.title).toBe("Family visit");
    expect(pausedBy(ss, "m-sleep", "2026-09-14")).toBeNull();
    expect(pausedBy(ss, "m-commits", "2026-08-31")?.title).toBe("Away");
    const q = await import("./qualitative.ts");
    const g = glance(c, { week: "2026-09-14", ids: ["m-emails-sent", "m-sleep"], paused: (id, w) => q.pausedBy(ss, id, w)?.title ?? null });
    expect(g.rows[0]!.paused).toBe("Family visit");
    expect(g.rows[1]!.paused).toBeUndefined();
  });
  test("a heavy week raises one hypothesis; no trains it down until it stops", async () => {
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const hs = hypotheses(V, c);
    const heavy = hs.find((h) => h.kind === "heavy-week")!;
    expect(heavy.text).toMatch(/^Heavy week\? /);
    expect(heavy.evidence.map((e) => e.metric).sort()).toEqual(["m-after-hours", "m-emails-sent", "m-meeting-hours"]);
    answerHypothesis(V, heavy, false, NOW);
    expect(readWeights(V)["heavy-week"]!["m-emails-sent"]).toBeLessThan(1);
    expect(hypotheses(V, c).find((h) => h.key === heavy.key)).toBeUndefined(); // answered once
    // Say no to the same kind of week a few times: its features fall below the bar.
    for (let i = 0; i < 6; i++) answerHypothesis(V, { ...heavy, key: `heavy-week:x${i}` }, false, NOW);
    const later = hypotheses(V, c, heavy.week).filter((h) => h.kind === "heavy-week").length;
    rmSync(join(V, "build", "_meta", "metrics", "hypotheses.jsonl"));
    expect(hypotheses(V, c, heavy.week).filter((h) => h.kind === "heavy-week")).toHaveLength(0);
    expect(later).toBe(0);
    // Each answer is also an asked event.
    const lines = readFileSync(join(V, "build", "_meta", "events", "checkins", `${dayOf(NOW).slice(0, 7)}.${(await import("./metrics.ts")).hostSlug()}.jsonl`), "utf8");
    expect(lines).toContain("checkin.hypothesis");
  });
  test("a guardrail slips when the guard metric drops below normal", async () => {
    // Calm 1 in the last full week, against a normal of 2 to 4 (seeded noise).
    const lastFull = weekOf(dayOf(NOW - 7 * DAY));
    write("checkins", mondays(20).map((w) => ({ ...ev("checkins", "checkin.calm", w, { calm: w === lastFull ? 1 : 4, week: w, at: Date.parse(`${w}T12:00:00`) }), tier: "asked" })));
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const g = guardrails(V, c);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ metric: "m-emails-sent", guard: "m-calm", state: "slipping" });
    const r = await weeklyReview(V, { now: NOW, week: lastFull });
    expect(r.guardrails[0]).toContain("slipped");
    expect(r.asked.ladder).toBe(true);
    expect(r.hypothesis?.text).toContain("Heavy week?");
  });
  test("matters vs lived: rank against metrics that serve each value; unmeasured said so", async () => {
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const l = mattersVsLived(V, c);
    expect(l.map((v) => [v.id, v.matters])).toEqual([["v-peace", 5], ["v-craft", 4], ["v-adv", 3]]);
    const peace = l[0]!;
    expect(peace.metrics.map((m) => m.id)).toEqual(["m-sleep"]);
    expect(peace.metrics[0]!.basis).toContain("enough of");
    expect(peace.checkin).toBeGreaterThan(0); // calm counts for peace
    expect(l[1]!.metrics.map((m) => m.id)).toEqual(["m-emails-sent"]); // through the goal it serves
    expect(l[2]).toMatchObject({ lived: null, unmeasured: true });
  });
});

describe("patterns, not proof", () => {
  test("statistics: r, its p-value, Benjamini-Hochberg", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pValueR(0.5, 20)).toBeCloseTo(0.0248, 2);
    expect(pValueR(0, 20)).toBeCloseTo(1, 5);
    expect(bh([0.001, 0.2, 0.03, 0.8], 0.1)).toEqual([true, false, true, false]);
  });
  test("on noise, the lag tests find nothing", async () => {
    seed();
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const t = lagTests(V, c);
    expect(t.find((x) => x.input === "m-sleep")!.verdict).not.toBe("moves it");
    expect(t.every((x) => x.verdict !== "moves it")).toBe(true);
  });
  test("a proxy is promoted only when it predicts the check-ins", async () => {
    seed({ correlated: true });
    let c = await computeMetrics(V, { now: NOW, home: HOME });
    expect(proxies(V, c).find((p) => p.proxy === "m-sleep")!.status).toBe("promoted");
    expect(lagTests(V, c).find((x) => x.input === "m-sleep")!.verdict).toBe("moves it");
    seed();
    c = await computeMetrics(V, { now: NOW, home: HOME });
    expect(proxies(V, c).find((p) => p.proxy === "m-sleep")!.status).not.toBe("promoted");
  });
  test("themes as words, or a plain state when off", async () => {
    seed();
    let c = await computeMetrics(V, { now: NOW, home: HOME });
    expect(themeTrends(c, V)[0]!.state).toContain("off");
    setConsent(V, "writing-themes", true);
    const d = join(V, "build", "_meta", "events-local", "themes");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "2026-08.mac-a.jsonl"), ["ai tools", "travel"].map((t, i) => JSON.stringify({ ts: "2026-08-01", src: "themes", kind: "theme.writing", n: 2 - i, project: t, host: "mac-a", tier: "inferred", attrs: {} })).join("\n") + "\n");
    writeFileSync(join(d, "2026-09.mac-a.jsonl"), ["ai tools", "family"].map((t, i) => JSON.stringify({ ts: "2026-09-01", src: "themes", kind: "theme.writing", n: 2 - i, project: t, host: "mac-a", tier: "inferred", attrs: {} })).join("\n") + "\n");
    c = await computeMetrics(V, { now: NOW, home: HOME });
    const w = themeTrends(c, V).find((x) => x.kind === "writing")!;
    expect(w).toMatchObject({ month: "2026-09", new: ["family"], gone: ["travel"], steady: ["ai tools"] });
  });
});
