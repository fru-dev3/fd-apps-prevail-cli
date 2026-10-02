import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  baseline, CATALOG, computeMetrics, glance, glanceIds, glanceMarkdown, listMetrics, readRegistry, rhythm, scanGit, series,
  spendEvents, taskEvents, tripEvents, watchEvents, weekOf, weekly,
} from "./metrics.ts";
import { runPlaybook } from "./orchestrator.ts";
import { tMetricSeries, tReadMetrics } from "./mcp-server.ts";

const ROOT = join("/tmp", `prevail-metrics-${process.pid}`);
const V = join(ROOT, "vault");
const HOME = join(ROOT, "home");
const REPOS = join(ROOT, "repos");
const dom = (d: string) => join(V, "data", "domains", d);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// Wednesday 2026-09-30, noon local: the week of Monday 2026-09-28.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();

function g(repo: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: join(HOME, ".gitconfig"), ...env } });
}

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(HOME, { recursive: true });
  for (const d of ["general", "health", "content"]) mkdirSync(join(dom(d), "memory"), { recursive: true });
  // Task boards: two dated done tasks this week, one last week, one undated.
  writeFileSync(join(dom("health"), "memory", "tasks.md"), [
    "- [x] Book the foo checkup ~closed:2026-09-29", "- [x] Renew the bar card +closed-2026-09-30",
    "- [x] Old foo chore ~closed:2026-09-22", "- [x] Undated bar thing", "- [ ] Open foo task"].join("\n"));
  writeFileSync(join(dom("general"), "_loops_runtime.json"), JSON.stringify({ schema: 1, loops: { a: { history: [{ ts: new Date(2026, 8, 29, 7).getTime() }, { ts: new Date(2026, 8, 30, 7).getTime() }] } } }));
  writeFileSync(join(dom("general"), "memory", "decisions.jsonl"), `${JSON.stringify({ ts: new Date(2026, 8, 29, 9).getTime(), kind: "council", prompt: "a private question about foo" })}\n`);
  // A trip atlas and a watch-history scrape (invented).
  mkdirSync(join(dom("content"), "memory", "skills", "foo-atlas"), { recursive: true });
  writeFileSync(join(dom("content"), "memory", "skills", "foo-atlas", "trips.json"), JSON.stringify({ scan_date: "2026-09-25", trips: [
    { date: "2026-09-12", kind: "trip", verdict: "OK", activity: "Hike", region: "Foo Valley · USA" },
    { date: "2026-08-02", kind: "trip", verdict: "OK", activity: "Ride", region: "Bar Coast" },
    { date: "2026-09-13", kind: "other", verdict: "EMPTY", activity: "x", region: "y" },
    { date: "1255-04-26", kind: "trip", verdict: "OK", date_suspect: true },
  ] }));
  const raw = join(dom("content"), "source", "files", "watch-history", "raw");
  mkdirSync(join(raw, "2026-09-29"), { recursive: true });
  mkdirSync(join(raw, "2026-09-30"), { recursive: true });
  writeFileSync(join(raw, "2026-09-29", "in_foo.json"), JSON.stringify({ meta: {}, videos: [{ video_id: "v1", title: "A foo talk", duration_s: 600 }, { video_id: "v2", title: "Bar", duration_s: 1200 }] }));
  writeFileSync(join(raw, "2026-09-30", "in_foo.json"), JSON.stringify({ meta: {}, videos: [{ video_id: "v2", title: "Bar", duration_s: 1200 }, { video_id: "v3", title: "Baz", duration_s: 300 }] }));
  // Card statements (invented merchants).
  mkdirSync(join(V, "data", "apps", "Foo Card"), { recursive: true });
  writeFileSync(join(V, "data", "apps", "Foo Card", "activity.CSV"), [
    "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
    "09/29/2026,09/30/2026,FOO GROCER,Groceries,Sale,-20.50,",
    "09/29/2026,09/30/2026,BAR CAFE,Food & Drink,Sale,-4.25,",
    "09/30/2026,09/30/2026,PAYMENT THANK YOU,,Payment,100.00,"].join("\n"));
  mkdirSync(join(V, "data", "apps", "Bar Card"), { recursive: true });
  writeFileSync(join(V, "data", "apps", "Bar Card", "export.csv"), ["Date,Description,Amount", "09/30/2026,BAZ AIRLINES,68.87", "09/30/2026,ONLINE PAYMENT,-500.00"].join("\n"));
  // AI events from two Macs.
  const ai = join(V, "build", "_meta", "events", "claude");
  mkdirSync(ai, { recursive: true });
  writeFileSync(join(ai, "2026-09.mac-a.jsonl"), [
    { ts: "2026-09-29", src: "claude", kind: "ai.tokens", n: 3, host: "mac-a", tier: "measured", attrs: { in: 10, out: 20, usd_api: 1.5 } },
    { ts: "2026-09-21", src: "claude", kind: "ai.tokens", n: 1, host: "mac-a", tier: "measured", attrs: { in: 1, out: 1, usd_api: 0.25 } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(ai, "2026-09.mac-b.jsonl"), `${JSON.stringify({ ts: "2026-09-30", src: "claude", kind: "ai.tokens", n: 2, host: "mac-b", tier: "measured", attrs: { in: 5, out: 5, usd_api: 0.75 } })}\n`);
  // One repo with two of my commits this week (one AI co-authored), someone else's commit and a tag.
  const repo = join(REPOS, "foo-app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(HOME, ".gitconfig"), "[user]\n  email = sam@example.com\n  name = Sam Rivera\n");
  g(repo, ["init", "-q"]);
  const commit = (msg: string, when: string, email = "sam@example.com") => {
    writeFileSync(join(repo, "f.txt"), `${msg}\n`);
    g(repo, ["add", "."]);
    g(repo, ["-c", `user.email=${email}`, "-c", "user.name=X", "commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  };
  commit("alpha change", "2026-09-29T10:00:00+0000");
  commit("beta change\n\nCo-Authored-By: Claude Foo <noreply@anthropic.com>", "2026-09-30T22:00:00+0000");
  commit("gamma change", "2026-09-30T23:00:00+0000", "other@example.com");
  g(repo, ["tag", "-a", "v1.0.0", "-m", "Release v1.0.0"], { GIT_COMMITTER_DATE: "2026-09-30T23:30:00+0000" });
}

describe("sources, counted exactly", () => {
  test("task boards: dated done lines only, undated ones reported", () => {
    seed();
    const t = taskEvents(V);
    expect(t.events.map((e) => e.ts).sort()).toEqual(["2026-09-22", "2026-09-29", "2026-09-30"]);
    expect(t.info.note).toBe("1 done tasks carry no date and are not counted");
  });

  test("trips, watch history and card spend", () => {
    seed();
    expect(tripEvents(V).events.map((e) => e.ts).sort()).toEqual(["2026-08-02", "2026-09-12"]);
    const w = watchEvents(V).events;
    expect(w.map((e) => [e.ts, e.n, e.attrs.minutes])).toEqual([["2026-09-29", 2, 30], ["2026-09-30", 1, 5]]);
    const s = spendEvents(V);
    const total = s.events.reduce((a, e) => a + Number(e.attrs.usd), 0);
    expect(Math.round(total * 100) / 100).toBe(93.62);
    expect(s.events.map((e) => e.project).sort()).toEqual(["food & drink", "groceries", "uncategorized"]);
    // Merchant names are read and dropped.
    expect(JSON.stringify(s.events)).not.toContain("GROCER");
  });

  test("git: my commits and tags per day, AI co-authors counted, written per host", () => {
    seed();
    const r = scanGit(V, { roots: [REPOS], host: "mac-a", now: NOW, backfill: true, identities: ["sam@example.com"] });
    expect(r.repos).toBe(1);
    const file = join(V, "build", "_meta", "events", "git", "2026-09.mac-a.jsonl");
    const ev = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const commits = ev.filter((e) => e.kind === "git.commit");
    expect(commits.map((e) => [e.ts, e.n, e.attrs.ai ?? 0])).toEqual([["2026-09-29", 1, 0], ["2026-09-30", 1, 1]]);
    expect(commits[1].attrs.hours).toBe("22");
    expect(ev.filter((e) => e.kind === "git.tag").map((e) => [e.ts, e.n])).toEqual([["2026-09-30", 1]]);
    // No commit message ever lands in an event.
    expect(readFileSync(file, "utf8")).not.toMatch(/alpha|beta|gamma|change/);
  }, { timeout: 20_000 } as never);
});

describe("metrics, baselines and the glance", () => {
  test("weeks start on Monday; a baseline learns for four weeks", () => {
    expect(weekOf("2026-10-04")).toBe("2026-09-28");
    expect(weekOf("2026-09-28")).toBe("2026-09-28");
    const w = new Map([["2026-08-31", 2], ["2026-09-07", 4], ["2026-09-14", 6]]);
    expect(baseline(w, "2026-09-21")).toMatchObject({ weeks: 3, learning: true, learningWeeksLeft: 1, median: 4 });
    const full = new Map([["2026-08-03", 1], ["2026-08-10", 2], ["2026-08-17", 3], ["2026-08-24", 4], ["2026-08-31", 5]]);
    expect(baseline(full, "2026-09-07")).toMatchObject({ weeks: 5, learning: false, median: 3, lo: 2, hi: 4 });
  });

  test("compute merges every host and every vault source; the glance carries tiers, coverage and the files behind each number", async () => {
    seed();
    scanGit(V, { roots: [REPOS], host: "mac-a", now: NOW, backfill: true, identities: ["sam@example.com"] });
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const wk = (id: string) => weekly(c.points[id] ?? []).get("2026-09-28") ?? 0;
    expect(wk("m-ai-spend")).toBe(2.25); // 1.5 from one Mac, 0.75 from the other
    expect(wk("m-commits")).toBe(2);
    expect(wk("m-ai-commits")).toBe(1);
    expect(wk("m-shipped")).toBe(1);
    expect(wk("m-tasks-done")).toBe(2);
    expect(wk("m-loop-runs")).toBe(2);
    expect(wk("m-decisions")).toBe(1);
    expect(wk("m-watch-minutes")).toBe(35);
    expect(weekly(c.points["m-coding-days"] ?? [], true).get("2026-09-28")).toBe(2);
    // Files on disk: daily points, the source registry, metrics.md once.
    expect(readdirSync(join(V, "build", "_meta", "metrics"))).toContain("m-ai-spend.jsonl");
    expect(JSON.parse(readFileSync(join(V, "build", "_meta", "sources.json"), "utf8")).sources.find((s: { id: string }) => s.id === "ai").hosts.sort()).toEqual(["mac-a", "mac-b"]);
    expect(readRegistry(V).get("m-trips")).toEqual({ status: "tracking", tokens: { id: "m-trips", per: "month", unit: "count", tier: "measured", mode: "documentary", show: "hidden" } });

    const gl = glance(c);
    expect(gl.week).toBe("2026-09-28");
    const row = (id: string) => gl.rows.find((r) => r.id === id)!;
    expect(row("m-ai-spend")).toMatchObject({ value: 2.25, tier: "measured", documentary: false });
    expect(row("m-ai-spend").coverage).toContain("2 Macs (mac-a, mac-b)");
    expect(row("m-ai-spend").citations.map((x) => x.file).sort()).toEqual(["build/_meta/events/claude/2026-09.mac-a.jsonl", "build/_meta/events/claude/2026-09.mac-b.jsonl"]);
    expect(row("m-ai-spend").normal.learning).toBe(true);
    expect(row("m-shipped").tier).toBe("derived");
    // Trips are a record, never a target: no count, the latest trip and its file.
    expect(row("m-trips")).toMatchObject({ documentary: true, record: "Latest: Hike, Foo Valley · USA on 2026-09-12" });
    expect(row("m-trips").citations[0]!.file).toBe("data/domains/content/memory/skills/foo-atlas/trips.json");
    const md = glanceMarkdown(gl);
    expect(md).toContain("**AI spend**: $2.25, learning your normal");
    expect(md).toContain("Measured; 2 Macs");
    expect(md).toContain("a record, no target");
    // Series and the rhythm plot.
    expect(series(c, "m-commits", "week", 2)).toEqual([{ date: "2026-09-21", value: 0 }, { date: "2026-09-28", value: 2 }]);
    expect(rhythm(c, 30).filter((d) => d.kind === "commit").map((d) => [d.day, d.hour])).toEqual([["2026-09-29", 10], ["2026-09-30", 22]]);
    expect(listMetrics(c, V).length).toBe(CATALOG.length);
    // Pinning in metrics.md decides what the glance shows.
    expect(glanceIds(V)).toEqual(["m-ai-spend", "m-shipped", "m-commits", "m-tasks-done", "m-prompts", "m-trips"]);
    const md0 = readFileSync(join(V, "build", "metrics.md"), "utf8");
    writeFileSync(join(V, "build", "metrics.md"), md0.replace("## Pinned\n", "## Pinned\n\n- Watch time ~id:m-watch-minutes ~per:week\n- Not a metric ~id:m-nope\n"));
    expect(glanceIds(V)).toEqual(["m-watch-minutes"]);
    expect(glance(c, { ids: glanceIds(V) }).rows.map((r) => r.id)).toEqual(["m-watch-minutes"]);
  }, { timeout: 30_000 } as never);

  test("a quiet week against a steady normal is the surprise", async () => {
    seed();
    const ai = join(V, "build", "_meta", "events", "claude");
    const lines = [];
    for (const day of ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]) lines.push({ ts: day, src: "claude", kind: "ai.tokens", n: 1, host: "mac-a", tier: "measured", attrs: { usd_api: 10 } });
    writeFileSync(join(ai, "2026-08.mac-a.jsonl"), lines.filter((l) => l.ts < "2026-09").map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(ai, "2026-09.mac-a.jsonl"), [...lines.filter((l) => l.ts >= "2026-09"), { ts: "2026-09-29", src: "claude", kind: "ai.tokens", n: 1, host: "mac-a", tier: "measured", attrs: { usd_api: 60 } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    rmSync(join(ai, "2026-09.mac-b.jsonl"));
    const gl = glance(await computeMetrics(V, { now: NOW, home: HOME }));
    expect(gl.surprise).toBe("AI spend: $60.00 this week, above your normal of $10.00 to $10.00.");
  });

  test("MCP read_metrics and metric_series", async () => {
    seed();
    expect(await tReadMetrics({}, V)).toContain("## This week in numbers");
    expect(JSON.parse(await tReadMetrics({ format: "list" }, V)).length).toBe(CATALOG.length);
    expect(JSON.parse(await tMetricSeries({ id: "m-tasks-done", per: "week", count: 3 }, V)).points.length).toBe(3);
    expect(await tMetricSeries({ id: "nope" }, V)).toContain("Unknown metric");
  }, { timeout: 30_000 } as never);

  test("a playbook's glance step writes the numbers and adds them to the review page", async () => {
    seed();
    mkdirSync(join(dom("general"), "memory", "reviews"), { recursive: true });
    const review = join(dom("general"), "memory", "reviews", "week.md");
    writeFileSync(review, "# Weekly review\n\nWhat moved: foo.\n");
    const r = await runPlaybook("g1", { id: "w", name: "W", goal: "numbers", steps: [{ kind: "glance", domain: "general", output: "memory/reviews/numbers.md", appendTo: "memory/reviews/week.md" }] }, { vault: V, provider: "claude", model: "", autonomousActs: true });
    expect(r.steps[0]).toMatchObject({ ok: true, decision: "auto" });
    expect(existsSync(join(dom("general"), "memory", "reviews", "numbers.md"))).toBe(true);
    const body = readFileSync(review, "utf8");
    expect(body.startsWith("# Weekly review\n\nWhat moved: foo.\n\n## This week in numbers")).toBe(true);
    // A second run does not add the numbers twice.
    await runPlaybook("g2", { id: "w", name: "W", goal: "numbers", steps: [{ kind: "glance", domain: "general", output: "memory/reviews/numbers.md", appendTo: "memory/reviews/week.md" }] }, { vault: V, provider: "claude", model: "", autonomousActs: true });
    expect(readFileSync(review, "utf8").match(/This week in numbers/g)?.length).toBe(1);
  }, { timeout: 30_000 } as never);
});
