// Metrics M5: stories and experiments. The monthly recap, Your Year (and its
// privacy: local-only domains, ~local Compass lines and local-only sources
// never appear), the heatmap, places from trip regions, patterns with false
// discovery control (nothing on noise, the planted signal found, pairs read
// from the same events skipped) and n-of-1 experiments. Invented data only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, type Computed, type MetricEvent, type Point } from "./metrics.ts";
import { experimentThisWeek, heatmap, monthRecap, patterns, places, proposeExperiment, readExperiments, recapMarkdown, scoreExperiment, setExperiment, welch, writeYear, yearHtml, yearStory } from "./stories.ts";

const ROOT = join("/tmp", `prevail-stories-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = new Date(2026, 9, 2, 12).getTime(); // Fri 2026-10-02
const day = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo", "bar", "secret"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), JSON.stringify(d === "secret" ? { privacy: { localOnly: true } } : {})); }
  writeFileSync(join(V, "build", "_meta", "projects.json"), JSON.stringify({ projects: [
    { slug: "a", domain: "foo", monthly: { "2026-08": 30, "2026-09": 60 } }, { slug: "b", domain: "bar", monthly: { "2026-09": 20 } }, { slug: "c", domain: "secret", monthly: { "2026-09": 500 } },
  ] }));
  writeFileSync(join(V, "build", "compass.md"), "# Compass\n\n## Values\n- Foo craft ~id:v-foo ~rank:1\n- Hidden thing ~id:v-hid ~rank:2 ~local\n\n## Goals\n- [ ] Make foo ~id:g-foo ~serves:v-foo ~status:active ~domain:foo\n");
}

function pts(xs: [string, number][]): Point[] { return xs.map(([date, value]) => ({ date, value, n: 1 })); }
function computed(over: Partial<Computed> = {}): Computed {
  const points: Record<string, Point[]> = {};
  for (const d of CATALOG) points[d.id] = [];
  points["m-prompts"] = pts([[day(2026, 8, 3), 40], [day(2026, 8, 20), 60], [day(2026, 9, 2), 150], [day(2026, 9, 21), 150], [day(2026, 10, 1), 3]]);
  points["m-commits"] = pts([[day(2026, 8, 5), 10], [day(2026, 9, 5), 12], [day(2026, 10, 1), 1]]);
  points["m-calm"] = pts([[day(2026, 9, 26), 4]]);
  const ev = (o: Partial<MetricEvent>): MetricEvent => ({ ts: day(2026, 9, 5), src: "claude", kind: "ai.tokens", n: 1, host: "h", tier: "measured", attrs: {}, ...o });
  return {
    ts: NOW, defs: CATALOG, from: "2025-09-01", points, sources: [], files: {}, hosts: {}, times: [new Date(2026, 8, 3, 22).getTime(), new Date(2026, 8, 4, 22).getTime()], commitHours: [{ day: day(2026, 9, 5), hour: 9 }],
    events: [
      ev({ attrs: { usd_api: 30, in: 1000 } }), ev({ ts: day(2026, 8, 5), attrs: { usd_api: 10, in: 500 } }), ev({ src: "codex", attrs: { usd_api: 5, in: 100 } }),
      ev({ src: "git", kind: "git.commit", n: 12, project: "foo-app", attrs: { ai: 9 } }), ev({ src: "git", kind: "git.commit", n: 1, project: "bar-site", ts: day(2026, 10, 1), attrs: {} }),
      ev({ src: "photos", kind: "photo.taken", file: "build/_meta/events-local/photos/2026-09.h.jsonl", attrs: {} }),
      ev({ src: "apps", kind: "app.last_used", project: "com.example.FooEdit", attrs: {} }),
    ],
    trips: [{ date: day(2026, 7, 4), region: "Minnesota · USA", activity: "Hike", file: "x" }, { date: day(2026, 8, 1), region: "Minnesota · USA (Narrated)", activity: "Drive", file: "x" }, { date: day(2026, 5, 1), region: "Egypt · Africa", activity: "Walk", file: "x" }, { date: day(2026, 5, 2), region: "—", activity: "?", file: "x" }],
    ...over,
  };
}

describe("the monthly recap", () => {
  beforeEach(seed);
  test("numbers against the month before, a surprise only on a real base, private domains left out", () => {
    const r = monthRecap(V, computed(), "2026-09");
    const prompts = r.lines.find((l) => l.id === "m-prompts")!;
    expect([prompts.value, prompts.prev, prompts.change]).toEqual([300, 100, 200]);
    expect(r.surprise).toBe("Prompts you wrote rose 200% against the month before (100 to 300).");
    expect(r.topDomains).toEqual([{ domain: "foo", share: 75 }, { domain: "bar", share: 25 }]);
    const oct = monthRecap(V, computed(), "2026-10");
    expect([oct.partial, oct.surprise]).toEqual([true, null]);
    expect(recapMarkdown(oct)).toContain("The month is not over yet.");
    expect(recapMarkdown(r)).not.toMatch(/—/);
  });
});

describe("Your Year", () => {
  beforeEach(seed);
  test("AI, building, the hour, places, where time went; never a local-only domain, a ~local line or a local-only source", async () => {
    const s = await yearStory(V, computed(), "2026");
    expect([s.ai.usd, s.ai.byTool.map((t) => t.tool), s.ai.peak]).toEqual([45, ["claude", "codex"], { month: "2026-09", share: 78 }]);
    expect(s.building).toMatchObject({ commits: 13, aiCommits: 9, repos: 2 });
    expect(s.hour).toBe(22);
    expect(s.time.map((t) => t.domain)).toEqual(["foo", "bar"]);
    expect(s.values.map((v) => v.title)).toEqual(["Foo craft"]);
    expect(s.values[0]!.months.find((m) => m.month === "2026-09")!.share).toBe(75);
    expect(s.exploration.photoDays).toBe(0);
    expect(s.tools).toEqual([{ app: "FooEdit", days: 1 }]);
    const html = yearHtml(s);
    expect(html).toContain("#008000");
    expect(html).not.toMatch(/https?:\/\/|<script|—/);
    expect(html).not.toContain("secret");
    expect(html).not.toContain("Hidden thing");
    const w = writeYear(V, s);
    expect(readFileSync(join(V, w.html), "utf8")).toContain("2026, your year");
  });

  test("places from trip regions, a heatmap that spreads the weekly calm over its week", () => {
    const p = places(computed().trips);
    expect(p.map((x) => [x.place, x.country, x.trips, x.lat != null])).toEqual([["Minnesota", "USA", 2, true], ["Egypt", "Egypt", 1, true]]);
    const h = heatmap(computed(), "m-calm", "2026");
    expect(h.length).toBe(7);
    expect(h.every((x) => x.value === 4)).toBe(true);
    expect(h[0]!.date).toBe("2026-09-21");
  });
});

describe("patterns and experiments", () => {
  const weeks = (n: number, f: (i: number) => number, start = new Date(2026, 3, 6, 12).getTime()) => pts(Array.from({ length: n }, (_, i) => [new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10), f(i)]));
  function noise(seed0: number) { let s = seed0; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

  test("noise reports nothing; a planted lagged signal is found; pairs read from the same events are skipped", () => {
    const r = noise(7);
    const c = computed();
    for (const id of ["m-watch-minutes", "m-workouts", "m-sleep", "m-steps", "m-calm", "m-meeting-hours"]) c.points[id] = weeks(24, () => Math.round(r() * 100));
    c.points["m-prompts"] = weeks(24, () => Math.round(r() * 100));
    c.points["m-commits"] = weeks(24, () => Math.round(r() * 100));
    c.points["m-ai-commits"] = c.points["m-commits"]!.map((p) => ({ ...p, value: Math.round(p.value * 0.8) }));
    expect(patterns(c).found).toEqual([]);
    const x = c.points["m-workouts"]!;
    c.points["m-calm"] = x.map((p, i) => ({ ...p, date: x[i + 1]?.date ?? "2099-01-01", value: p.value / 10 + r() })).filter((p) => p.date < "2099");
    const f = patterns(c).found;
    expect(f.some((p) => p.a === "m-workouts" && p.b === "m-calm" && p.lag === 1)).toBe(true);
    expect(f.some((p) => [p.a, p.b].sort().join() === "m-ai-commits,m-commits")).toBe(false);
    expect(f[0]!.text).toContain("A pattern, not proof.");
  });

  test("one experiment at a time, alternating weeks, scored by code", () => {
    seed();
    const c = computed();
    const e = proposeExperiment(V, c, { input: "m-workouts", outcome: "m-calm", now: NOW });
    expect(e.start).toBe("2026-10-05");
    expect(e.weeks.map((w) => w.arm)).toEqual(["A", "B", "A", "B"]);
    expect(e.instruction).toBe("On A weeks, aim for more workouts than usual; on B weeks, as usual.");
    setExperiment(V, e.id, "running", NOW);
    expect(() => proposeExperiment(V, c, { input: "m-sleep", outcome: "m-calm", now: NOW })).toThrow("one experiment at a time");
    expect(experimentThisWeek(V, new Date(2026, 9, 6, 12).getTime())).toMatchObject({ arm: "A" });
    expect(experimentThisWeek(V, new Date(2026, 9, 13, 12).getTime())).toMatchObject({ arm: "B", text: "A B week: workouts as usual." });
    c.points["m-calm"] = pts([["2026-10-05", 5], ["2026-10-06", 5], ["2026-10-12", 2], ["2026-10-19", 4.8], ["2026-10-26", 2.2]]);
    const s = scoreExperiment(V, c, e.id, new Date(2026, 10, 3, 12).getTime());
    expect(s.status).toBe("done");
    expect(s.result).toMatchObject({ a: 4.9, b: 2.1, diff: 2.8, verdict: "supports" });
    expect(readExperiments(V)[0]!.result!.text).toContain("n-of-1, 4 weeks");
    expect(welch([1, 2, 3], [1, 2, 3])).toEqual({ t: 0, p: 1 });
    expect(welch([1], [2])).toEqual({ t: null, p: null });
  });
});
