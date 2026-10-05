import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CF_EPOCH } from "./app-usage.ts";
import { computeMetrics, glance } from "./metrics.ts";
import { garminEvents, healthEvents, healthLine, newHealthAgg, ouraEvents, plaidEvents, stravaEvents, syncAppleHealth, syncPlaid, syncTimeline, timelineEvents, timelineVisits } from "./source-files.ts";
import { callEvents, isLocalUrl, localThemes, messageEvents, photosEvents, syncCalls, syncPhotos } from "./source-mac.ts";
import {
  calendarMetricEvents, calEventOf, classifyGoogleError, githubEvents, hashWho, headerOf, isJobApplication, mailEvents, readCalendarEvents, readMailHeaders,
  syncCalendar, syncGithub, syncGmail, syncSource, youtubeEvents, type MailHeader, type Runner,
} from "./source-sync.ts";
import { listSources, setConsent } from "./sources.ts";

const ROOT = join("/tmp", `prevail-sources-${process.pid}`);
const V = join(ROOT, "vault");
const HOME = join(ROOT, "home");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m, 0).getTime();

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "entities", "products"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general"), { recursive: true });
  mkdirSync(HOME, { recursive: true });
});

const events = (src: string, root = "events") => {
  const d = join(V, "build", "_meta", root, src);
  if (!existsSync(d)) return [];
  return readdirSync(d).flatMap((f) => readFileSync(join(d, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};

// ── An invented mailbox behind a fake gws ───────────────────────────────────
const SELF = "pat@example.com";
function msg(id: string, thread: string, ts: number, from: string, to: string, subject: string, labels: string[] = ["INBOX"]) {
  return { id, threadId: thread, internalDate: String(ts), labelIds: labels, payload: { headers: [{ name: "From", value: `Someone <${from}>` }, { name: "To", value: to }, { name: "Subject", value: subject }, { name: "Date", value: new Date(ts).toUTCString() }] }, snippet: "BODY TEXT MUST NOT LEAK" };
}
const MAILBOX = [
  msg("m1", "t1", at(28, 9), "sam@foo.example", SELF, "Quote for the deck"),
  msg("m2", "t1", at(28, 10, 30), SELF, "sam@foo.example", "Re: Quote for the deck", ["SENT"]),
  msg("m3", "t1", at(29, 8), "sam@foo.example", SELF, "Re: Quote for the deck"),
  msg("m4", "t2", at(29, 9), SELF, "jobs@boards.greenhouse.io", "Application: Staff Engineer", ["SENT"]),
  msg("m5", "t3", at(29, 9, 5), "no-reply@us.greenhouse.io", SELF, "Thank you for applying to Foo Corp"),
  msg("m6", "t4", at(29, 11), "deals@shop.example", SELF, "50% off", ["INBOX", "CATEGORY_PROMOTIONS"]),
  msg("m7", "t5", at(30, 7), SELF, "lee@bar.example, kim@bar.example", "Plans", ["SENT"]),
];
const fakeGws = (opts: { fail?: string } = {}): Runner => (_cmd, args) => {
  if (opts.fail) return { ok: false, out: JSON.stringify({ error: { code: 401, message: opts.fail } }), err: "" };
  const p = JSON.parse(args[args.indexOf("--params") + 1] ?? "{}");
  if (args[0] === "gmail" && args[2] === "getProfile") return { ok: true, out: JSON.stringify({ emailAddress: SELF }), err: "" };
  if (args[0] === "gmail" && args[3] === "list") return { ok: true, out: JSON.stringify({ messages: MAILBOX.map((m) => ({ id: m.id })) }), err: "" };
  if (args[0] === "gmail" && args[3] === "get") { expect(p.format).toBe("metadata"); return { ok: true, out: JSON.stringify(MAILBOX.find((m) => m.id === p.id)), err: "" }; }
  if (args[0] === "calendar" && args[1] === "calendarList") return { ok: true, out: JSON.stringify({ items: [{ id: "primary", summary: "Work" }, { id: "fam", summary: "Family" }] }), err: "" };
  if (args[0] === "calendar" && args[1] === "events") {
    const items = p.calendarId === "primary" ? [
      { id: "e1", summary: "Standup", start: { dateTime: new Date(at(29, 9)).toISOString() }, end: { dateTime: new Date(at(29, 9, 30)).toISOString() }, attendees: [{ email: SELF, self: true, responseStatus: "accepted" }, { email: "a@x.example" }], description: "SECRET NOTES" },
      { id: "e2", summary: "Late call", start: { dateTime: new Date(at(29, 19)).toISOString() }, end: { dateTime: new Date(at(29, 20)).toISOString() }, attendees: [{ email: SELF, self: true }, { email: "b@x.example" }] },
      { id: "e3", summary: "Deep work", start: { dateTime: new Date(at(30, 9)).toISOString() }, end: { dateTime: new Date(at(30, 11)).toISOString() } },
      { id: "e4", summary: "Declined sync", start: { dateTime: new Date(at(30, 13)).toISOString() }, end: { dateTime: new Date(at(30, 14)).toISOString() }, attendees: [{ email: SELF, self: true, responseStatus: "declined" }, { email: "c@x.example" }] },
      { id: "e5", summary: "Holiday", start: { date: "2026-09-28" }, end: { date: "2026-09-29" } },
    ] : [{ id: "f1", summary: "Recital", start: { dateTime: new Date(at(28, 17)).toISOString() }, end: { dateTime: new Date(at(28, 18, 30)).toISOString() } }];
    return { ok: true, out: JSON.stringify({ items }), err: "" };
  }
  return { ok: false, out: "", err: "unexpected" };
};
const google = { gws: "/bin/gws", accounts: [{ label: "acct-a", env: {} }] };

describe("wave 2: Gmail headers", () => {
  test("headers only, kept on this Mac; events are counts and hashes", async () => {
    const r = await syncGmail(V, { run: fakeGws(), google, now: NOW, host: "mac-a" });
    expect(r.state).toBe("ok");
    const hs = readMailHeaders(V);
    expect(hs).toHaveLength(7);
    expect(JSON.stringify(hs)).not.toContain("BODY TEXT");
    expect(hs.find((h) => h.id === "m2")!.dir).toBe("sent");
    const ev = events("gmail");
    const raw = JSON.stringify(ev);
    for (const bad of ["sam@", "Quote", "greenhouse", "BODY"]) expect(raw).not.toContain(bad);
    const n = (kind: string, day?: string) => ev.filter((e) => e.kind === kind && (!day || e.ts === day)).reduce((a, e) => a + e.n, 0);
    expect(n("email.sent")).toBe(3);
    expect(n("email.received")).toBe(3); // the promotion is not personal mail
    expect(n("email.reply")).toBe(1); // sam answered a thread you wrote in
    expect(ev.find((e) => e.kind === "email.replied").attrs.minutes).toBe(90);
    expect(n("email.job_application")).toBe(2);
    expect(ev.filter((e) => e.kind === "email.person").map((e) => e.project)).toContain(hashWho("lee@bar.example"));
    // A second run fetches nothing new.
    const again = await syncGmail(V, { run: fakeGws(), google, now: NOW, host: "mac-a" });
    expect(again.accounts!["acct-a"]).toContain("0 new");
  });
  test("metrics: emails sent, distinct people a week, reply time, job applications", async () => {
    await syncGmail(V, { run: fakeGws(), google, now: NOW, host: "mac-a" });
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    const g = glance(c, { ids: ["m-emails-sent", "m-email-people", "m-reply-time", "m-job-apps"] });
    const v = Object.fromEntries(g.rows.map((r) => [r.id, r.value]));
    expect(v).toEqual({ "m-emails-sent": 3, "m-email-people": 4, "m-reply-time": 90, "m-job-apps": 2 });
    expect(g.rows.find((r) => r.id === "m-job-apps")!.tier).toBe("inferred");
  });
  test("a failed sign-in is named, never a silent zero", async () => {
    const r = await syncGmail(V, { run: fakeGws({ fail: "disabled_client: The OAuth client was disabled." }), google, now: NOW, host: "mac-a" });
    expect(r.state).toBe("auth-failed");
    expect(r.note).toContain("disabled");
    expect(classifyGoogleError("access_denied: Account Restricted")).toContain("restricted");
  });
  test("job applications: hiring systems and their confirmations only", () => {
    const h = (o: Partial<MailHeader>): MailHeader => ({ id: "x", thread: "t", ts: 1, account: "a", dir: "sent", from: SELF, to: [], cc: [], subject: "", labels: [], ...o });
    expect(isJobApplication(h({ to: ["jobs@boards.greenhouse.io"] }))).toBe(true);
    expect(isJobApplication(h({ to: ["careers@foo.example"] }))).toBe(true);
    expect(isJobApplication(h({ to: ["friend@foo.example"], subject: "my application" }))).toBe(false);
    expect(isJobApplication(h({ dir: "received", from: "x@lever.co", subject: "Application received" }))).toBe(true);
    expect(isJobApplication(h({ dir: "received", from: "x@lever.co", subject: "Weekly newsletter" }))).toBe(false);
    expect(headerOf({ id: "" }, "a", new Set())).toBeNull();
  });
});

describe("wave 2: calendar, GitHub, YouTube", () => {
  test("calendar: meetings, after hours, focus, family; declined and all-day skipped; titles kept on this Mac only", async () => {
    const r = await syncCalendar(V, { run: fakeGws(), google, now: NOW, host: "mac-a" });
    expect(r.state).toBe("ok");
    const cached = readCalendarEvents(V);
    expect(cached.map((e) => e.id).sort()).toEqual(["e1", "e2", "e3", "e4", "e5", "f1"]);
    expect(JSON.stringify(cached)).not.toContain("SECRET NOTES");
    const ev = events("calendar");
    expect(JSON.stringify(ev)).not.toContain("Standup");
    const hours = (k: string) => ev.filter((e) => e.kind === k).reduce((a, e) => a + Number(e.attrs.hours), 0);
    expect(hours("cal.meeting")).toBe(1.5);
    expect(hours("cal.after_hours")).toBe(1);
    expect(hours("cal.focus")).toBe(2);
    expect(hours("cal.family")).toBe(1.5);
    expect(calEventOf({ status: "cancelled", start: { date: "2026-01-01" } }, "a", "c")).toBeNull();
    expect(calendarMetricEvents([], "h", NOW)).toEqual([]);
  });
  test("GitHub through gh: pull requests opened and merged, issues", async () => {
    const items = [{ created_at: "2026-09-28T10:00:00Z", repository_url: "https://api.github.com/repos/foo/bar", pull_request: { merged_at: "2026-09-29T10:00:00Z" } }, { created_at: "2026-09-29T10:00:00Z", repository_url: "https://api.github.com/repos/foo/baz" }];
    const run: Runner = (cmd, args) => (args[0] === "auth" ? { ok: true, out: "Logged in", err: "" } : args.some((a) => a.includes("type:pr")) ? { ok: true, out: JSON.stringify({ items: [items[0]] }), err: "" } : { ok: true, out: JSON.stringify({ items: [items[1]] }), err: "" });
    const r = await syncGithub(V, { run, now: NOW, host: "mac-a" });
    expect(r.state).toBe("ok");
    const kinds = events("github").map((e) => `${e.kind}:${e.project}`).sort();
    expect(kinds).toEqual(["gh.issue_opened:baz", "gh.pr_merged:bar", "gh.pr_opened:bar"]);
    expect(githubEvents([], "h")).toEqual([]);
    expect((await syncGithub(V, { run: () => ({ ok: false, out: "", err: "not logged in" }), now: NOW })).state).toBe("needs-connection");
  });
  test("YouTube: off until consent; with a token from the Keychain, daily rows become events", async () => {
    expect((await syncSource(V, "youtube", { now: NOW })).state).toBe("off");
    setConsent(V, "youtube", true);
    expect((await syncSource(V, "youtube", { now: NOW, secret: () => null })).state).toBe("needs-connection");
    const report = { columnHeaders: [{ name: "day" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "subscribersGained" }, { name: "subscribersLost" }], rows: [["2026-09-29", 120, 300, 5, 1], ["2026-09-30", 80, 200, 2, 0]] };
    const fetcher = (async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("youtubeanalytics") ? report : { items: [{ snippet: { publishedAt: "2026-09-29T15:00:00Z" } }] }) })) as unknown as typeof fetch;
    const r = await syncSource(V, "youtube", { now: NOW, secret: () => "tok", fetch: fetcher, host: "mac-a" });
    expect(r.state).toBe("ok");
    const ev = events("youtube");
    expect(ev.filter((e) => e.kind === "yt.views").reduce((a, e) => a + e.n, 0)).toBe(200);
    expect(ev.filter((e) => e.kind === "yt.subscribers").reduce((a, e) => a + Number(e.attrs.net), 0)).toBe(6);
    expect(ev.filter((e) => e.kind === "yt.published")).toHaveLength(1);
    expect(youtubeEvents({}, [], "h")).toEqual([]);
  });
});

describe("wave 3: connections the user makes", () => {
  test("Plaid: only streams that match an app are kept; unmatched merchants are dropped", async () => {
    setConsent(V, "plaid", true);
    const streams = [
      { stream_id: "s1", merchant_name: "Notion Labs", description: "NOTION LABS INC", frequency: "MONTHLY", average_amount: { amount: 10 }, last_amount: { amount: 10 }, last_date: "2026-09-15", predicted_next_date: "2026-10-15", status: "MATURE", is_active: true, transaction_ids: ["a", "b", "c"] },
      { stream_id: "s2", merchant_name: "Corner Bakery Example", frequency: "WEEKLY", average_amount: { amount: 7 }, last_date: "2026-09-28" },
    ];
    const fetcher = (async () => ({ ok: true, status: 200, json: async () => ({ outflow_streams: streams }) })) as unknown as typeof fetch;
    const r = await syncSource(V, "plaid", { now: NOW, secret: (s) => (s === "prevail-plaid-env" ? "sandbox" : "x"), fetch: fetcher, host: "mac-a" });
    expect(r.state).toBe("ok");
    const ev = events("plaid");
    expect(ev).toHaveLength(1);
    expect(ev[0].project).toBe("notion");
    expect(ev[0].attrs).toMatchObject({ usd: 10, monthly: 10, next: "2026-10-15" });
    expect(JSON.stringify(ev)).not.toContain("Bakery");
    expect(plaidEvents(V, [], "h").events).toEqual([]);
    expect((await syncPlaid(V, { secret: () => null })).state).toBe("needs-connection");
  });
  test("Apple Health: one source wins per day; sleep, steps, workouts, resting heart rate", async () => {
    const agg = newHealthAgg();
    const lines = [
      '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-09-29 08:00:00 -0500" endDate="2026-09-29 09:00:00 -0500" value="4000"/>',
      '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-09-29 08:00:00 -0500" endDate="2026-09-29 09:00:00 -0500" value="4200"/>',
      '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2026-09-29 18:00:00 -0500" endDate="2026-09-29 19:00:00 -0500" value="1000"/>',
      '<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-09-29 23:00:00 -0500" endDate="2026-09-30 03:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>',
      '<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-09-30 03:00:00 -0500" endDate="2026-09-30 06:30:00 -0500" value="HKCategoryValueSleepAnalysisAsleepDeep"/>',
      '<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-09-30 06:30:00 -0500" endDate="2026-09-30 07:00:00 -0500" value="HKCategoryValueSleepAnalysisAwake"/>',
      '<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2026-09-29 00:00:00 -0500" endDate="2026-09-29 23:59:00 -0500" value="58"/>',
      '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="31.5" durationUnit="min" sourceName="Watch" startDate="2026-09-29 06:00:00 -0500" endDate="2026-09-29 06:31:30 -0500">',
    ];
    for (const l of lines) healthLine(agg, l, "2026-01-01");
    const ev = healthEvents(agg, "h");
    const one = (k: string) => ev.find((e) => e.kind === k)!;
    expect(one("health.steps").attrs.steps).toBe(5200);
    expect(one("health.sleep")).toMatchObject({ ts: "2026-09-30", attrs: { hours: 7.5 } });
    expect(one("health.rhr").attrs.bpm).toBe(58);
    expect(one("health.workout").attrs.minutes).toBe(32);
    // Through the inbox and consent.
    setConsent(V, "apple-health", true);
    mkdirSync(join(V, "data", "entities", "products", "apple-health", "inbox"), { recursive: true });
    writeFileSync(join(V, "data", "entities", "products", "apple-health", "inbox", "export.xml"), `<?xml version="1.0"?>\n<HealthData>\n${lines.join("\n")}\n</HealthData>\n`);
    expect((await syncAppleHealth(V, { now: NOW, host: "mac-a" })).state).toBe("ok");
    const c = await computeMetrics(V, { now: NOW, home: HOME });
    expect(glance(c, { ids: ["m-sleep"] }).rows[0]!.value).toBe(7.5);
  });
  test("Timeline: places a day, new places, days away; no coordinates kept", async () => {
    const seg = (s: number, e: number, id: string, ll: string) => ({ startTime: new Date(s).toISOString(), endTime: new Date(e).toISOString(), visit: { topCandidate: { placeId: id, placeLocation: { latLng: ll } } } });
    const j = { semanticSegments: [
      seg(at(26, 20), at(27, 7), "home", "44.9700°, -93.2600°"),
      seg(at(27, 9), at(27, 10), "cafe", "44.9800°, -93.2700°"),
      seg(at(27, 20), at(28, 7), "home", "44.9700°, -93.2600°"),
      seg(at(28, 12), at(28, 18), "canyon", "36.1000°, -112.1100°"),
      seg(at(29, 9), at(29, 12), "cafe", "44.9800°, -93.2700°"),
    ] };
    const visits = timelineVisits(j);
    const ev = timelineEvents(visits, "h");
    const raw = JSON.stringify(ev);
    expect(raw).not.toContain("44.97");
    expect(raw).not.toContain("canyon");
    expect(ev.filter((e) => e.kind === "day.away").map((e) => e.ts)).toEqual(["2026-09-28"]);
    expect(ev.filter((e) => e.kind === "place.new")).toHaveLength(3);
    expect(timelineVisits({ timelineObjects: [{ placeVisit: { location: { placeId: "p", latitudeE7: 449700000, longitudeE7: -932600000 }, duration: { startTimestamp: "2026-09-01T10:00:00Z", endTimestamp: "2026-09-01T11:00:00Z" } } }] })).toHaveLength(1);
    setConsent(V, "timeline", true);
    expect((await syncTimeline(V, { now: NOW })).state).toBe("needs-connection");
  });
  test("Oura, Strava and Garmin shapes", () => {
    expect(ouraEvents([{ day: "2026-09-29", total_sleep_duration: 27000, type: "long_sleep" }, { day: "2026-09-29", total_sleep_duration: 1200, type: "rest" }], [{ day: "2026-09-29", steps: 9000 }], "h").map((e) => [e.kind, e.attrs.hours ?? e.attrs.steps])).toEqual([["health.sleep", 7.5], ["health.steps", 9000]]);
    expect(stravaEvents([{ start_date_local: "2026-09-29T07:00:00Z", moving_time: 1800, distance: 5000 }], "h")[0]!.attrs).toEqual({ minutes: 30, km: 5 });
    expect(garminEvents([{ summarizedActivitiesExport: [{ startTimeLocal: at(29, 7), duration: 2_700_000, distance: 800_000 }] }], "h")[0]!.attrs).toEqual({ minutes: 45, km: 8 });
  });
});

describe("wave 4: on this Mac, opt-in, local only", () => {
  test("off by default; with consent the events stay in events-local", async () => {
    expect((await syncSource(V, "photos", { now: NOW })).state).toBe("off");
    expect((await syncSource(V, "messages", { now: NOW })).state).toBe("off");
    setConsent(V, "photos", true);
    const lib = join(HOME, "Pictures", "Foo.photoslibrary", "database");
    mkdirSync(lib, { recursive: true });
    const db = new Database(join(lib, "Photos.sqlite"));
    db.run("CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZDATECREATED REAL, ZLATITUDE REAL, ZLONGITUDE REAL, ZTRASHEDSTATE INTEGER)");
    const cf = (ms: number) => ms / 1000 - CF_EPOCH;
    db.run("INSERT INTO ZASSET VALUES (1, ?, 44.97, -93.26, 0)", [cf(at(29, 10))]);
    db.run("INSERT INTO ZASSET VALUES (2, ?, 44.98, -93.26, 0)", [cf(at(29, 11))]);
    db.run("INSERT INTO ZASSET VALUES (3, ?, 36.10, -112.11, 0)", [cf(at(29, 15))]);
    db.run("INSERT INTO ZASSET VALUES (4, ?, -180, -180, 0)", [cf(at(30, 9))]);
    db.run("INSERT INTO ZASSET VALUES (5, ?, 1, 1, 1)", [cf(at(30, 9))]);
    db.close();
    const r = await syncPhotos(V, { now: NOW, home: HOME, host: "mac-a" });
    expect(r.state).toBe("ok");
    expect(events("photos")).toEqual([]); // never in the synced folder
    const local = events("photos", "events-local");
    expect(local.filter((e) => e.kind === "photo.taken").reduce((a, e) => a + e.n, 0)).toBe(4);
    expect(local.find((e) => e.kind === "photo.places" && e.ts === "2026-09-29").n).toBe(2);
    expect(JSON.stringify(local)).not.toContain("44.9");
    expect(photosEvents([], "h")).toEqual([]);
  });
  test("messages and calls: counts only", async () => {
    const ev = messageEvents([{ d: (at(29, 9) / 1000 - CF_EPOCH) * 1e9, me: 1, h: "+15550100" }, { d: (at(29, 10) / 1000 - CF_EPOCH) * 1e9, me: 0, h: "+15550100" }], "h");
    expect(ev.map((e) => e.kind).sort()).toEqual(["msg.person", "msg.received", "msg.sent"]);
    expect(JSON.stringify(ev)).not.toContain("5550100");
    expect(callEvents([{ d: at(29, 9) / 1000 - CF_EPOCH, dur: 300, out: 1, answered: 1 }], "h")[0]!.attrs).toEqual({ minutes: 5, outgoing: 1, missed: 0 });
    setConsent(V, "calls", true);
    expect(["absent", "needs-fda"]).toContain((await syncCalls(V, { home: HOME })).state);
  });
  test("local model: only this Mac or the user's own network", async () => {
    expect(isLocalUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalUrl("http://100.83.0.5:11434")).toBe(true);
    expect(isLocalUrl("http://mini.local:11434")).toBe(true);
    expect(isLocalUrl("https://api.example.com")).toBe(false);
    expect(isLocalUrl("http://8.8.8.8:11434")).toBe(false);
    await expect(localThemes({ url: "https://api.example.com", model: "m" }, "x", ["a"])).rejects.toThrow();
    const fetcher = (async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ topics: ["AI tools", "Travel!", "x".repeat(60)] }) }) })) as unknown as typeof fetch;
    expect(await localThemes({ url: "http://127.0.0.1:11434", model: "m" }, "domains", ["a.example"], fetcher)).toEqual(["ai tools", "travel"]);
    setConsent(V, "browser-topics", true);
    const none = (async () => { throw new Error("no server"); }) as unknown as typeof fetch;
    expect((await syncSource(V, "browser-topics", { now: NOW, fetch: none, home: HOME })).state).toBe("needs-local-model");
  });
  test("the Sources list shows consent and the last state", async () => {
    await syncSource(V, "github", { run: () => ({ ok: false, out: "", err: "nope" }), now: NOW });
    const rows = listSources(V);
    expect(rows.find((r) => r.id === "github")!.state).toBe("needs-connection");
    expect(rows.find((r) => r.id === "photos")!.state).toBe("off");
    expect(rows.find((r) => r.id === "photos")!.localOnly).toBe(true);
  });
});
