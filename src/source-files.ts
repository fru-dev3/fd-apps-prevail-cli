// Wave 3 sources (metrics plan M3): connections the user makes on purpose.
// Each one is off until turned on (sources.ts) and reads only what its
// consent screen says.
//
//   - plaid: recurring charges (/transactions/recurring/get) with keys the
//     user put in this Mac's Keychain; only streams that match an app record
//     are kept (apps plan decision 3), as money.recurring events.
//   - apple-health: an Apple Health export dropped in
//     data/apps/apple-health/inbox/ (export.zip or export.xml): daily steps,
//     sleep, workouts, resting heart rate. One source per day wins (the iPhone
//     and the Watch both record steps).
//   - timeline: a Google Maps Timeline export dropped in
//     data/apps/timeline/inbox/: places per day, new places, days away from
//     home. Coordinates are used in memory and dropped; places are hashes.
//   - oura, strava: personal tokens in the Keychain; garmin: an export file.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { buildMatcher } from "./app-map.ts";
import { dayOf, hostSlug, type MetricEvent } from "./metrics.ts";
import { appsContainer } from "./path-safety.ts";
import { sourceDef } from "./sources.ts";
import { EventBag, keychainSecret, registerReaders, writeSourceEvents, type SyncOpts, type SyncResult } from "./source-sync.ts";

const DAY = 86_400_000;
const inboxOf = (vault: string, app: string) => join(appsContainer(vault), app, "inbox");

/** Files in an app's inbox, newest first. */
function inboxFiles(vault: string, app: string, re: RegExp): string[] {
  const dir = inboxOf(vault, app);
  let fs: string[] = [];
  try { fs = readdirSync(dir).filter((f) => re.test(f)); } catch { return []; }
  return fs.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

// ── Plaid recurring ─────────────────────────────────────────────────────────

export interface PlaidStream { stream_id: string; merchant_name?: string | null; description?: string; frequency?: string; average_amount?: { amount?: number }; last_amount?: { amount?: number }; first_date?: string; last_date?: string; predicted_next_date?: string | null; status?: string; is_active?: boolean; transaction_ids?: string[] }

const PER_MONTH: Record<string, number> = { WEEKLY: 52 / 12, BIWEEKLY: 26 / 12, SEMI_MONTHLY: 2, MONTHLY: 1, ANNUALLY: 1 / 12, YEARLY: 1 / 12 };

/** Outflow streams matched to apps, as money.recurring events (ts = last charge). Unmatched streams are dropped. */
export function plaidEvents(vault: string, streams: PlaidStream[], host: string): { events: MetricEvent[]; matched: number; dropped: number } {
  const m = buildMatcher(vault);
  const out: MetricEvent[] = [];
  let dropped = 0;
  for (const s of streams) {
    const app = m.match("merchant", s.merchant_name || s.description || "");
    if (!app || !s.last_date) { dropped++; continue; }
    const last = Math.abs(Number(s.last_amount?.amount ?? 0));
    const avg = Math.abs(Number(s.average_amount?.amount ?? last));
    const f = (s.frequency ?? "MONTHLY").toUpperCase();
    out.push({ ts: s.last_date, src: "plaid", kind: "money.recurring", n: Math.max(1, s.transaction_ids?.length ?? 1), project: app, host, tier: "measured", attrs: { usd: last, avg, monthly: Math.round(avg * (PER_MONTH[f] ?? 1) * 100) / 100, frequency: f.toLowerCase(), ...(s.predicted_next_date ? { next: s.predicted_next_date } : {}), ...(s.first_date ? { first: s.first_date } : {}), status: (s.status ?? "").toLowerCase(), active: s.is_active === false ? 0 : 1, stream: createHash("sha256").update(s.stream_id).digest("hex").slice(0, 12) } });
  }
  return { events: out, matched: out.length, dropped };
}

export async function syncPlaid(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const sec = opts.secret ?? ((s: string) => keychainSecret(s, opts.run));
  const [id, secret, token] = [sec("prevail-plaid-client-id"), sec("prevail-plaid-secret"), sec("prevail-plaid-access-token")];
  if (!id || !secret || !token) return { state: "needs-connection", note: sourceDef("plaid")!.connect };
  const env = sec("prevail-plaid-env") ?? "production";
  const f = opts.fetch ?? fetch;
  const r = await f(`https://${env}.plaid.com/transactions/recurring/get`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: id, secret, access_token: token }) });
  if (!r.ok) return { state: r.status === 400 || r.status === 401 ? "auth-failed" : "failed", note: `Plaid answered ${r.status}` };
  const j = (await r.json()) as { outflow_streams?: PlaidStream[] };
  const host = opts.host ?? hostSlug();
  const { events, matched, dropped } = plaidEvents(vault, j.outflow_streams ?? [], host);
  return { state: "ok", events: writeSourceEvents(vault, "plaid", events, host, opts.now ?? Date.now()), note: `${matched} recurring charges matched to apps; ${dropped} not kept` };
}

// ── Apple Health export ─────────────────────────────────────────────────────

const ATTR = (line: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(line)?.[1];
const healthDay = (s: string) => /^(\d{4}-\d{2}-\d{2})/.exec(s)?.[1] ?? "";
const healthMs = (s: string) => Date.parse(s.replace(" ", "T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"));

export interface HealthAgg { steps: Map<string, Map<string, number>>; sleep: Map<string, Map<string, number>>; rhr: Map<string, number[]>; workouts: Map<string, { n: number; minutes: number }> }
export const newHealthAgg = (): HealthAgg => ({ steps: new Map(), sleep: new Map(), rhr: new Map(), workouts: new Map() });

/** One line of export.xml into the running totals (per day and source, so one source can win). */
export function healthLine(agg: HealthAgg, line: string, sinceDay: string): void {
  if (line.includes("<Record ")) {
    const type = ATTR(line, "type") ?? "";
    const start = ATTR(line, "startDate") ?? "";
    const day = healthDay(start);
    if (!day || day < sinceDay) return;
    const src = ATTR(line, "sourceName") ?? "?";
    const add = (m: Map<string, Map<string, number>>, d: string, v: number) => { const by = m.get(d) ?? new Map<string, number>(); by.set(src, (by.get(src) ?? 0) + v); m.set(d, by); };
    if (type === "HKQuantityTypeIdentifierStepCount") add(agg.steps, day, Number(ATTR(line, "value") ?? 0));
    else if (type === "HKCategoryTypeIdentifierSleepAnalysis" && /Asleep/.test(ATTR(line, "value") ?? "")) {
      const end = ATTR(line, "endDate") ?? "";
      const h = (healthMs(end) - healthMs(start)) / 3_600_000;
      if (h > 0 && h < 16) add(agg.sleep, healthDay(end), h);
    } else if (type === "HKQuantityTypeIdentifierRestingHeartRate") { const v = Number(ATTR(line, "value")); if (v > 20 && v < 200) (agg.rhr.get(day) ?? agg.rhr.set(day, []).get(day)!).push(v); }
  } else if (line.includes("<Workout ")) {
    const day = healthDay(ATTR(line, "startDate") ?? "");
    if (!day || day < sinceDay) return;
    let min = Number(ATTR(line, "duration") ?? 0);
    if ((ATTR(line, "durationUnit") ?? "min") === "s") min /= 60;
    const w = agg.workouts.get(day) ?? { n: 0, minutes: 0 };
    w.n++; w.minutes += min;
    agg.workouts.set(day, w);
  }
}

export function healthEvents(agg: HealthAgg, host: string): MetricEvent[] {
  const bag = new EventBag("apple-health", host);
  const best = (m: Map<string, number>) => Math.max(0, ...m.values());
  for (const [d, by] of agg.steps) bag.add(d, "health.steps", { attrs: { steps: Math.round(best(by)) } });
  for (const [d, by] of agg.sleep) bag.add(d, "health.sleep", { attrs: { hours: Math.round(best(by) * 100) / 100 } });
  for (const [d, vs] of agg.rhr) bag.add(d, "health.rhr", { attrs: { bpm: Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) } });
  for (const [d, w] of agg.workouts) bag.add(d, "health.workout", { n: w.n, attrs: { minutes: Math.round(w.minutes) } });
  return bag.events();
}

async function eachLine(file: string, fn: (l: string) => void): Promise<void> {
  if (file.endsWith(".zip")) {
    const p = spawn("unzip", ["-p", file, "*export.xml"], { stdio: ["ignore", "pipe", "ignore"] });
    for await (const l of createInterface({ input: p.stdout })) fn(l);
    return;
  }
  for await (const l of createInterface({ input: createReadStream(file, { encoding: "utf8" }) })) fn(l);
}

export async function syncAppleHealth(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const file = inboxFiles(vault, "apple-health", /\.(zip|xml)$/i)[0];
  if (!file) return { state: "needs-connection", note: sourceDef("apple-health")!.connect };
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const agg = newHealthAgg();
  await eachLine(file, (l) => healthLine(agg, l, dayOf(now - (opts.backfill ? 3650 : 400) * DAY)));
  const events = healthEvents(agg, host);
  return { state: "ok", events: writeSourceEvents(vault, "apple-health", events, host, now), note: `read ${file.split("/").pop()}` };
}

// ── Google Maps Timeline export ─────────────────────────────────────────────

interface Visit { start: number; end: number; place: string; lat: number; lng: number }

const parseLatLng = (s: string): [number, number] | null => { const m = /(-?\d+(?:\.\d+)?)°?,\s*(-?\d+(?:\.\d+)?)°?/.exec(s ?? ""); return m ? [Number(m[1]), Number(m[2])] : null; };

/** Visits from either Timeline export shape (on-device semanticSegments, or Takeout timelineObjects). */
export function timelineVisits(j: Record<string, unknown>): Visit[] {
  const out: Visit[] = [];
  for (const s of (j.semanticSegments as Record<string, unknown>[] | undefined) ?? []) {
    const v = s.visit as { topCandidate?: { placeId?: string; placeLocation?: { latLng?: string } } } | undefined;
    const ll = parseLatLng(v?.topCandidate?.placeLocation?.latLng ?? "");
    if (!v || !ll) continue;
    out.push({ start: Date.parse(String(s.startTime)), end: Date.parse(String(s.endTime)), place: v.topCandidate?.placeId ?? `${ll[0].toFixed(3)},${ll[1].toFixed(3)}`, lat: ll[0], lng: ll[1] });
  }
  for (const o of (j.timelineObjects as Record<string, unknown>[] | undefined) ?? []) {
    const pv = o.placeVisit as { location?: { placeId?: string; latitudeE7?: number; longitudeE7?: number }; duration?: { startTimestamp?: string; endTimestamp?: string } } | undefined;
    if (!pv?.location?.latitudeE7) continue;
    const lat = pv.location.latitudeE7 / 1e7; const lng = (pv.location.longitudeE7 ?? 0) / 1e7;
    out.push({ start: Date.parse(pv.duration?.startTimestamp ?? ""), end: Date.parse(pv.duration?.endTimestamp ?? ""), place: pv.location.placeId ?? `${lat.toFixed(3)},${lng.toFixed(3)}`, lat, lng });
  }
  return out.filter((v) => v.start > 0).sort((a, b) => a.start - b.start);
}

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/** Places per day (hashed), first-ever places, and days with no visit within 50 km of home (the place most often visited overnight). */
export function timelineEvents(visits: Visit[], host: string): MetricEvent[] {
  const bag = new EventBag("timeline", host, "derived");
  const night = new Map<string, number>();
  for (const v of visits) { const d = new Date(v.start); const e = new Date(v.end); if (d.getDate() !== e.getDate() || d.getHours() < 4) night.set(v.place, (night.get(v.place) ?? 0) + 1); }
  const homeId = [...night.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const home = visits.find((v) => v.place === homeId);
  const seen = new Set<string>();
  const byDay = new Map<string, Visit[]>();
  for (const v of visits) (byDay.get(dayOf(v.start)) ?? byDay.set(dayOf(v.start), []).get(dayOf(v.start))!).push(v);
  const hash = (p: string) => createHash("sha256").update(`prevail-place:${p}`).digest("hex").slice(0, 10);
  for (const [day, vs] of byDay) {
    const places = new Set(vs.map((v) => v.place));
    bag.add(day, "place.visit", { n: places.size });
    for (const p of places) if (!seen.has(p)) { seen.add(p); bag.add(day, "place.new", { project: hash(p) }); }
    if (home && vs.every((v) => km(v, home) > 50)) bag.add(day, "day.away");
  }
  return bag.events();
}

export async function syncTimeline(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const files = inboxFiles(vault, "timeline", /\.json$/i);
  if (!files.length) return { state: "needs-connection", note: sourceDef("timeline")!.connect };
  const visits: Visit[] = [];
  for (const f of files) { try { visits.push(...timelineVisits(JSON.parse(readFileSync(f, "utf8")))); } catch { /* not a timeline file */ } }
  const uniq = [...new Map(visits.map((v) => [`${v.start}\t${v.place}`, v])).values()].sort((a, b) => a.start - b.start);
  const host = opts.host ?? hostSlug();
  return { state: "ok", events: writeSourceEvents(vault, "timeline", timelineEvents(uniq, host), host, opts.now ?? Date.now()), note: `${uniq.length} visits from ${files.length} files` };
}

// ── Oura, Strava (tokens) and Garmin (export) ───────────────────────────────

export function ouraEvents(sleep: { day?: string; total_sleep_duration?: number; type?: string }[], activity: { day?: string; steps?: number }[], host: string): MetricEvent[] {
  const bag = new EventBag("oura", host);
  for (const s of sleep) if (s.day && s.total_sleep_duration && s.type !== "rest") bag.add(s.day, "health.sleep", { attrs: { hours: Math.round((s.total_sleep_duration / 3600) * 100) / 100 } });
  for (const a of activity) if (a.day && a.steps) bag.add(a.day, "health.steps", { attrs: { steps: a.steps } });
  return bag.events();
}

export async function syncOura(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const token = (opts.secret ?? ((s: string) => keychainSecret(s, opts.run)))("prevail-oura");
  if (!token) return { state: "needs-connection", note: sourceDef("oura")!.connect };
  const now = opts.now ?? Date.now();
  const q = `start_date=${dayOf(now - (opts.backfill ? 365 : 90) * DAY)}&end_date=${dayOf(now)}`;
  const f = opts.fetch ?? fetch;
  const get = async (p: string) => { const r = await f(`https://api.ouraring.com/v2/usercollection/${p}?${q}`, { headers: { Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`Oura answered ${r.status}`); return ((await r.json()) as { data?: unknown[] }).data ?? []; };
  const host = opts.host ?? hostSlug();
  const events = ouraEvents(await get("sleep") as never[], await get("daily_activity") as never[], host);
  return { state: "ok", events: writeSourceEvents(vault, "oura", events, host, now) };
}

export function stravaEvents(acts: { start_date_local?: string; moving_time?: number; distance?: number; sport_type?: string; type?: string }[], host: string): MetricEvent[] {
  const bag = new EventBag("strava", host);
  for (const a of acts) { const d = (a.start_date_local ?? "").slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) bag.add(d, "health.workout", { attrs: { minutes: Math.round((a.moving_time ?? 0) / 60), km: Math.round((a.distance ?? 0) / 100) / 10 } }); }
  return bag.events();
}

export async function syncStrava(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const token = (opts.secret ?? ((s: string) => keychainSecret(s, opts.run)))("prevail-strava");
  if (!token) return { state: "needs-connection", note: sourceDef("strava")!.connect };
  const now = opts.now ?? Date.now();
  const after = Math.floor((now - (opts.backfill ? 365 : 90) * DAY) / 1000);
  const f = opts.fetch ?? fetch;
  const acts: Parameters<typeof stravaEvents>[0] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await f(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { state: r.status === 401 ? "auth-failed" : "failed", note: `Strava answered ${r.status}` };
    const batch = (await r.json()) as typeof acts;
    acts.push(...batch);
    if (batch.length < 100) break;
  }
  const host = opts.host ?? hostSlug();
  return { state: "ok", events: writeSourceEvents(vault, "strava", stravaEvents(acts, host), host, now) };
}

/** Garmin Connect's export: summarizedActivitiesExport rows (startTimeLocal ms, duration ms, distance cm). */
export function garminEvents(j: unknown, host: string): MetricEvent[] {
  const bag = new EventBag("garmin", host);
  const rows = (Array.isArray(j) ? j : [j]).flatMap((x) => ((x as { summarizedActivitiesExport?: unknown[] })?.summarizedActivitiesExport ?? []) as { startTimeLocal?: number; duration?: number; distance?: number }[]);
  for (const a of rows) if (a.startTimeLocal) bag.add(dayOf(a.startTimeLocal), "health.workout", { attrs: { minutes: Math.round((a.duration ?? 0) / 60_000), km: Math.round((a.distance ?? 0) / 10_000) / 10 } });
  return bag.events();
}

export async function syncGarmin(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const files = inboxFiles(vault, "garmin-connect", /\.json$/i);
  if (!files.length) return { state: "needs-connection", note: sourceDef("garmin")!.connect };
  const host = opts.host ?? hostSlug();
  const events = files.flatMap((f) => { try { return garminEvents(JSON.parse(readFileSync(f, "utf8")), host); } catch { return []; } });
  return { state: "ok", events: writeSourceEvents(vault, "garmin", events, host, opts.now ?? Date.now()) };
}

export function register(): void {
  registerReaders({ plaid: syncPlaid, "apple-health": syncAppleHealth, timeline: syncTimeline, oura: syncOura, strava: syncStrava, garmin: syncGarmin });
}

/** Make a source's inbox folder (the consent flow shows where to drop the export). */
export function ensureInbox(vault: string, app: string): string { const d = inboxOf(vault, app); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }
