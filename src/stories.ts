// Metrics M5: stories and experiments (metrics-plan.md).
//
//   Monthly mini-recap  one short page a month, numbers written by code with
//                       their tier and the files behind them, against the
//                       month before, and one surprise. General's
//                       memory/reviews/recap-<YYYY-MM>.md.
//   Your Year           the year as a story: AI and building, the most active
//                       hour, places and trips (documentary, shown here as a
//                       celebration, never a target), where the time went,
//                       the values race, AI and tools. In the app and as one
//                       self-contained page in General's
//                       memory/reviews/your-year-<YYYY>.html; aggregates in
//                       build/_meta/metrics/year/<YYYY>.json.
//   Calendar heatmap    one cell a day for a metric (the weekly calm spreads
//                       over its week; focus hours by day).
//   Places map          trip regions on a plain map (region centroids; no
//                       coordinates of the user are stored or read).
//   Patterns            every pair of the user's weekly metrics, lags 0 to 2
//                       weeks, after each metric's first data, with
//                       Benjamini-Hochberg false-discovery control; only the
//                       survivors, in plain words, "a pattern, not proof".
//   Experiments         a promising pattern becomes an n-of-1 experiment:
//                       alternate weeks (A: do more of the input, B: as
//                       usual) for four weeks, scored by code (difference of
//                       means and a Welch t test), then kept or let go.
//
// Privacy, in code: a domain marked local-only, a Compass line marked ~local
// and every local-only source (build/_meta/events-local) are never in a
// story. Stories read the vault; they never send anything anywhere.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { dayOf, metricsDir, weekOf, weekly, type Computed, type MetricDef } from "./metrics.ts";
import { bh, pearson, pValueR } from "./qualitative.ts";
import { parseModArgs } from "./cli-args.ts";

const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
const r1 = (n: number) => Math.round(n * 10) / 10;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");

// ── Privacy ─────────────────────────────────────────────────────────────────

/** Domains the owner keeps local-only: never in a story. */
export function privateDomains(vault: string): Set<string> {
  const out = new Set<string>();
  for (const d of listDomainDirs(vault)) {
    try { const j = JSON.parse(readText(join(resolveDomainDir(vault, d), "manifest.json"))) as { privacy?: { localOnly?: boolean } }; if (j.privacy?.localOnly) out.add(d); } catch { /* no manifest */ }
  }
  return out;
}

/** Story events: never a local-only source, never a private domain. */
function storyEvents(c: Computed, privateDoms: Set<string>) {
  return c.events.filter((e) => !(e.file ?? "").includes("events-local") && !(e.attrs.domain && privateDoms.has(String(e.attrs.domain))));
}

// ── Sums over a span ────────────────────────────────────────────────────────

function sumOf(c: Computed, id: string, from: string, to: string): number {
  return r1((c.points[id] ?? []).filter((p) => p.date >= from && p.date <= to).reduce((a, p) => a + (c.defs.find((d) => d.id === id)?.days ? 1 : p.value), 0));
}
const monthSpan = (m: string) => { const [y, mo] = m.split("-").map(Number); const last = new Date(y!, mo!, 0).getDate(); return [`${m}-01`, `${m}-${String(last).padStart(2, "0")}`] as const; };
const prevMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y!, mo! - 2, 15); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** Prompts per domain per month (prompt projects, whose monthly counts come from the capture), private domains left out. */
export function attentionByMonth(vault: string, year: string, privateDoms: Set<string>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  try {
    const j = JSON.parse(readText(join(runtimePath(vault, "_meta"), "projects.json"))) as { projects?: { domain?: string; monthly?: Record<string, number> }[] };
    for (const p of j.projects ?? []) {
      const d = p.domain || "general";
      if (privateDoms.has(d)) continue;
      for (const [m, n] of Object.entries(p.monthly ?? {})) {
        if (!m.startsWith(year)) continue;
        const row = out.get(m) ?? new Map<string, number>();
        row.set(d, (row.get(d) ?? 0) + n);
        out.set(m, row);
      }
    }
  } catch { /* no prompt projects yet */ }
  return out;
}

// ── The monthly mini-recap ──────────────────────────────────────────────────

const RECAP_IDS = ["m-prompts", "m-ai-spend", "m-commits", "m-shipped", "m-tasks-done", "m-decisions", "m-trips", "m-calm"];
export interface RecapLine { id: string; title: string; tier: string; value: number; prev: number; change: number | null; unit: MetricDef["unit"]; documentary: boolean; from: string }
export interface MonthRecap { month: string; lines: RecapLine[]; surprise: string | null; topDomains: { domain: string; share: number }[]; partial?: boolean; file?: string }

function fmtUnit(v: number, unit: MetricDef["unit"]): string { return unit === "usd" ? money(v) : unit === "hours" ? `${r1(v)} h` : unit === "score" ? String(r1(v)) : int(v); }

export function monthRecap(vault: string, c: Computed, month: string, privateDoms = privateDomains(vault)): MonthRecap {
  const [from, to] = monthSpan(month);
  const [pf, pt] = monthSpan(prevMonth(month));
  const lines: RecapLine[] = [];
  for (const id of RECAP_IDS) {
    const d = c.defs.find((x) => x.id === id);
    if (!d) continue;
    const pts = c.points[id] ?? [];
    const avg = (a: string, b: string) => { const xs = pts.filter((p) => p.date >= a && p.date <= b).map((p) => p.value); return xs.length ? r1(xs.reduce((s, x) => s + x, 0) / xs.length) : 0; };
    const value = d.avg ? avg(from, to) : sumOf(c, id, from, to);
    const prev = d.avg ? avg(pf, pt) : sumOf(c, id, pf, pt);
    if (!value && !prev) continue;
    lines.push({ id, title: d.title, tier: d.tier, value, prev, change: pct(value, prev), unit: d.unit, documentary: !!d.documentary, from: d.from });
  }
  // A surprise needs a real base on both sides, and a finished month.
  const partial = to >= dayOf(c.ts);
  const sur = partial ? undefined : lines.filter((l) => !l.documentary && l.change != null && Math.abs(l.change) >= 50 && l.prev >= 5 && l.value >= 5).sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))[0];
  const surprise = sur ? `${sur.title} ${sur.change! > 0 ? "rose" : "fell"} ${Math.abs(sur.change!)}% against the month before (${fmtUnit(sur.prev, sur.unit)} to ${fmtUnit(sur.value, sur.unit)}).` : null;
  const att = attentionByMonth(vault, month.slice(0, 4), privateDoms).get(month) ?? new Map<string, number>();
  const tot = [...att.values()].reduce((a, b) => a + b, 0) || 1;
  const topDomains = [...att.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([domain, n]) => ({ domain, share: Math.round((n / tot) * 100) }));
  return { month, lines, surprise, topDomains, ...(partial ? { partial: true } : {}) };
}

const TIER_WORD: Record<string, string> = { measured: "Measured", derived: "Derived", inferred: "Inferred", asked: "Asked" };
const monthName = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });

export function recapMarkdown(r: MonthRecap): string {
  const out = [`# ${monthName(r.month)}, in short`, "", `Written by code from your own records; every number keeps its tier.${r.partial ? " The month is not over yet." : ""}`, ""];
  if (!r.lines.length) out.push("Nothing was recorded this month yet.");
  for (const l of r.lines) out.push(`- ${l.title}: ${l.documentary ? `${fmtUnit(l.value, l.unit)}, a record` : fmtUnit(l.value, l.unit)}${!l.documentary && !r.partial && l.change != null && l.prev >= 5 ? ` (${l.change >= 0 ? "+" : ""}${l.change}% on the month before)` : ""}. ${TIER_WORD[l.tier] ?? l.tier}, from ${l.from}.`);
  if (r.topDomains.length) out.push("", `Where your prompts went: ${r.topDomains.map((d) => `${d.domain} ${d.share}%`).join(", ")}.`);
  if (r.surprise) out.push("", `One surprise: ${r.surprise}`);
  return `${out.join("\n")}\n`;
}

export function writeRecap(vault: string, r: MonthRecap): string {
  const dir = join(resolveDomainDir(vault, "general"), "memory", "reviews");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `recap-${r.month}.md`);
  writeFileSync(file, recapMarkdown(r));
  return file.slice(vault.length + 1);
}

// ── Calendar heatmap and places ─────────────────────────────────────────────

/** One value a day for a year. A weekly check-in (calm) spreads over its week. */
export function heatmap(c: Computed, id: string, year: string): { date: string; value: number }[] {
  const d = c.defs.find((x) => x.id === id);
  if (!d) return [];
  const pts = (c.points[id] ?? []).filter((p) => p.date.startsWith(year));
  if (id === "m-calm") {
    const w = weekly(c.points[id] ?? [], false, true);
    const out: { date: string; value: number }[] = [];
    for (let t = new Date(`${year}-01-01T12:00:00`).getTime(); new Date(t).getFullYear() === Number(year); t += 86_400_000) {
      const v = w.get(weekOf(dayOf(t)));
      if (v != null) out.push({ date: dayOf(t), value: v });
    }
    return out;
  }
  return pts.map((p) => ({ date: p.date, value: d.days ? 1 : p.value }));
}

// Rough centroids (latitude, longitude) for places a trip region names. A
// region is "State · Country" or "Country"; unknown ones are listed, not drawn.
const US: Record<string, [number, number]> = {
  alabama: [32.8, -86.8], alaska: [64.2, -150], arizona: [34.3, -111.7], arkansas: [34.9, -92.4], california: [37.2, -119.5], colorado: [39, -105.5], connecticut: [41.6, -72.7], delaware: [39, -75.5], florida: [28.6, -82.4], georgia: [32.7, -83.4], hawaii: [20.8, -156.3], idaho: [44.4, -114.6], illinois: [40, -89.2], indiana: [39.9, -86.3], iowa: [42.1, -93.5], kansas: [38.5, -98.4], kentucky: [37.5, -85.3], louisiana: [31.1, -92], maine: [45.4, -69.2], maryland: [39, -76.8], massachusetts: [42.3, -71.8], michigan: [44.3, -85.4], minnesota: [46.3, -94.3], mississippi: [32.7, -89.7], missouri: [38.4, -92.5], montana: [47, -109.6], nebraska: [41.5, -99.8], nevada: [39.3, -116.6], "new hampshire": [43.7, -71.6], "new jersey": [40.2, -74.7], "new mexico": [34.4, -106.1], "new york": [42.9, -75.5], "north carolina": [35.6, -79.4], "north dakota": [47.5, -100.5], ohio: [40.3, -82.8], oklahoma: [35.6, -97.5], oregon: [43.9, -120.6], pennsylvania: [40.9, -77.8], "rhode island": [41.7, -71.5], "south carolina": [33.9, -80.9], "south dakota": [44.4, -100.2], tennessee: [35.9, -86.4], texas: [31.5, -99.3], utah: [39.3, -111.7], vermont: [44.1, -72.7], virginia: [37.5, -78.9], washington: [47.4, -120.5], "west virginia": [38.6, -80.6], wisconsin: [44.6, -89.9], wyoming: [43, -107.6],
};
const COUNTRIES: Record<string, [number, number]> = {
  usa: [39.8, -98.6], canada: [56, -96], mexico: [23.6, -102.5], brazil: [-10.8, -52.9], argentina: [-34, -64], peru: [-9.2, -75], colombia: [4, -73], chile: [-35.7, -71.5],
  "united kingdom": [54, -2], uk: [54, -2], ireland: [53.2, -8], france: [46.6, 2.3], spain: [40.3, -3.7], portugal: [39.6, -8], germany: [51.1, 10.4], italy: [42.8, 12.6], netherlands: [52.2, 5.3], belgium: [50.6, 4.6], switzerland: [46.8, 8.2], austria: [47.6, 14.1], greece: [39.1, 22.9], norway: [61.4, 9], sweden: [62, 15], denmark: [56, 10], finland: [64, 26], iceland: [65, -18.6], poland: [52, 19.4], turkey: [39, 35.2],
  egypt: [26.8, 30.8], morocco: [31.8, -7.1], kenya: [0.2, 37.9], "south africa": [-30.6, 22.9], nigeria: [9.1, 8.7], ghana: [7.9, -1], cameroon: [5.7, 12.4], ethiopia: [9.1, 40.5], tanzania: [-6.4, 34.9],
  india: [22.4, 79], china: [35.9, 104.2], japan: [36.2, 138.3], "south korea": [36.5, 127.9], thailand: [15.9, 100.9], vietnam: [14.1, 108.3], indonesia: [-0.8, 113.9], singapore: [1.35, 103.8], "united arab emirates": [23.4, 53.8], uae: [23.4, 53.8], israel: [31, 34.8], jordan: [31.2, 36.5],
  australia: [-25.3, 133.8], "new zealand": [-41, 174],
};
export interface Place { region: string; place: string; country: string; trips: number; lat?: number; lon?: number }

/** Trip regions with how many trips each and, when known, a centroid to draw. Continent labels and notes in parentheses are ignored. */
export function places(trips: { date: string; region: string }[], year?: string): Place[] {
  const by = new Map<string, Place>();
  for (const t of trips) {
    if (year && !t.date.startsWith(year)) continue;
    const clean = t.region.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
    if (!clean || clean === "—") continue;
    const parts = clean.split("·").map((s) => s.trim()).filter(Boolean);
    const place = parts[0] ?? clean;
    const country = (parts.length > 1 ? parts[parts.length - 1]! : parts[0]!).replace(/^(Africa|Europe|Asia|Oceania|Americas)$/i, parts[0] ?? "");
    const key = `${place.toLowerCase()}|${country.toLowerCase()}`;
    const p = by.get(key) ?? { region: clean, place, country, trips: 0 };
    p.trips++;
    const ll = /^usa?$/i.test(country) ? US[place.toLowerCase()] ?? COUNTRIES.usa : COUNTRIES[place.toLowerCase()] ?? COUNTRIES[country.toLowerCase()];
    if (ll) { p.lat = ll[0]; p.lon = ll[1]; }
    by.set(key, p);
  }
  return [...by.values()].sort((a, b) => b.trips - a.trips);
}

// ── Your Year ───────────────────────────────────────────────────────────────

export interface YearStory {
  year: string; through: string; computed: number;
  ai: { prompts: number; usd: number; tokens: number; sessions: number; peak: { month: string; share: number } | null; byTool: { tool: string; usd: number; tokens: number }[] };
  building: { commits: number; aiCommits: number; repos: number; shipped: number; codingDays: number };
  hour: number | null;
  exploration: { trips: number; places: Place[]; countries: number; photoDays: number; newPlaces: number; daysAway: number };
  time: { domain: string; share: number }[];
  values: { id: string; title: string; rank: number; months: { month: string; share: number }[] }[];
  race: { month: string; order: string[] }[];
  months: MonthRecap[];
  tools: { app: string; days: number }[];
  heat: { calm: { date: string; value: number }[]; focus: { date: string; value: number }[]; prompts: { date: string; value: number }[] };
  notes: string[];
}

export async function yearStory(vault: string, c: Computed, year = String(new Date(c.ts).getFullYear())): Promise<YearStory> {
  const priv = privateDomains(vault);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const ev = storyEvents(c, priv).filter((e) => e.ts >= from && e.ts <= to);
  const ai = ev.filter((e) => e.kind === "ai.tokens");
  const tok = (e: (typeof ev)[number]) => ["in", "out", "cache_read", "cache_write", "cache_write_1h"].reduce((a, k) => a + Number(e.attrs[k] ?? 0), 0);
  const byTool = new Map<string, { usd: number; tokens: number }>();
  const byMonth = new Map<string, number>();
  for (const e of ai) {
    const t = byTool.get(e.src) ?? { usd: 0, tokens: 0 };
    t.usd += Number(e.attrs.usd_api ?? 0); t.tokens += tok(e); byTool.set(e.src, t);
    byMonth.set(e.ts.slice(0, 7), (byMonth.get(e.ts.slice(0, 7)) ?? 0) + Number(e.attrs.usd_api ?? 0));
  }
  const usd = [...byTool.values()].reduce((a, t) => a + t.usd, 0);
  const peakM = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  const commits = ev.filter((e) => e.kind === "git.commit");
  // The most active hour: prompts and commits by hour of day.
  const hours = new Array(24).fill(0) as number[];
  for (const t of c.times) { const d = new Date(t); if (String(d.getFullYear()) === year) hours[d.getHours()]!++; }
  for (const h of c.commitHours) if (h.day.startsWith(year) && h.hour >= 0 && h.hour < 24) hours[h.hour]!++;
  const peakHour = hours.some((n) => n > 0) ? hours.indexOf(Math.max(...hours)) : null;
  const pl = places(c.trips, year);
  const att = attentionByMonth(vault, year, priv);
  const tot = new Map<string, number>();
  for (const row of att.values()) for (const [d, n] of row) tot.set(d, (tot.get(d) ?? 0) + n);
  const all = [...tot.values()].reduce((a, b) => a + b, 0) || 1;
  const time = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, n]) => ({ domain, share: Math.round((n / all) * 100) }));
  // The values race: each confirmed value's share of each month's attention, through the domains its goals live in.
  const values: YearStory["values"] = [];
  try {
    const cm = await import("./compass.ts");
    const doc = cm.readCompass(vault);
    const goals = cm.items(doc, "goal").filter((g) => !cm.isProposed(g) && !g.flags.includes("local") && g.tokens.domain && !priv.has(g.tokens.domain));
    for (const [i, v] of cm.items(doc, "value").filter((x) => !cm.isProposed(x) && !x.flags.includes("local")).entries()) {
      const doms = new Set(goals.filter((g) => (g.tokens.serves ?? "").split(",").includes(v.id)).map((g) => g.tokens.domain!));
      const months = [...att.keys()].sort().map((m) => { const row = att.get(m)!; const s = [...row.values()].reduce((a, b) => a + b, 0) || 1; return { month: m, share: Math.round(([...doms].reduce((a, d) => a + (row.get(d) ?? 0), 0) / s) * 100) }; });
      values.push({ id: v.id, title: v.title, rank: Number(v.tokens.rank ?? i + 1), months });
    }
  } catch { /* no Compass */ }
  const monthsSorted = [...new Set([...att.keys(), ...[...byMonth.keys()]])].filter((m) => m.startsWith(year)).sort();
  const race = monthsSorted.map((m) => ({ month: m, order: [...values].sort((a, b) => (b.months.find((x) => x.month === m)?.share ?? 0) - (a.months.find((x) => x.month === m)?.share ?? 0)).map((v) => v.id) }));
  // AI and tools: the apps used on the most days.
  const appDays = new Map<string, Set<string>>();
  // A bundle id reads as its last part ("com.example.TextEdit" is TextEdit).
  const appName = (id: string) => { const last = id.includes(".") ? id.split(".").pop() ?? id : id; return last.replace(/^./, (c) => c.toUpperCase()); };
  for (const e of ev.filter((x) => (x.kind === "app.focus" || x.kind === "app.last_used") && x.project)) { const n = appName(e.project!); (appDays.get(n) ?? appDays.set(n, new Set()).get(n)!).add(e.ts); }
  const tools = [...appDays.entries()].map(([app, d]) => ({ app, days: d.size })).sort((a, b) => b.days - a.days).slice(0, 8);
  const curMonth = dayOf(c.ts).slice(0, 7);
  const months = monthsSorted.filter((m) => m <= curMonth).map((m) => monthRecap(vault, c, m, priv));
  const notes: string[] = [];
  if (!values.length) notes.push("The values race needs your confirmed Compass values.");
  else if (values.every((v) => v.months.every((m) => m.share === 0))) notes.push("The values race needs your Compass goals to name the domain each lives in.");
  if (!pl.some((p) => p.lat != null) && pl.length) notes.push("Some trip regions have no place on the map yet.");
  if (!c.trips.length) notes.push("No trips in the trip atlas.");
  return {
    year, through: dayOf(Math.min(c.ts, new Date(`${to}T23:59:59`).getTime())), computed: c.ts,
    ai: { prompts: sumOf(c, "m-prompts", from, to), usd: Math.round(usd * 100) / 100, tokens: [...byTool.values()].reduce((a, t) => a + t.tokens, 0), sessions: sumOf(c, "m-ai-sessions", from, to), peak: peakM && usd ? { month: peakM[0], share: Math.round((peakM[1] / usd) * 100) } : null, byTool: [...byTool.entries()].map(([tool, t]) => ({ tool, usd: Math.round(t.usd * 100) / 100, tokens: t.tokens })).sort((a, b) => b.usd - a.usd) },
    building: { commits: commits.reduce((a, e) => a + e.n, 0), aiCommits: commits.reduce((a, e) => a + Number(e.attrs.ai ?? 0), 0), repos: new Set(commits.map((e) => e.project)).size, shipped: sumOf(c, "m-shipped", from, to), codingDays: new Set(commits.map((e) => e.ts)).size },
    hour: peakHour,
    exploration: { trips: c.trips.filter((t) => t.date.startsWith(year)).length, places: pl, countries: new Set(pl.map((p) => p.country.toLowerCase())).size, photoDays: sumOf(c, "m-photo-days", from, to), newPlaces: sumOf(c, "m-new-places", from, to), daysAway: sumOf(c, "m-days-away", from, to) },
    time, values, race, months, tools,
    heat: { calm: heatmap(c, "m-calm", year), focus: heatmap(c, "m-focus-hours", year), prompts: heatmap(c, "m-prompts", year) },
    notes,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;

/** A year grid: 53 weeks by 7 days, darker green for more. */
export function heatSvg(cells: { date: string; value: number }[], year: string, label: string): string {
  const max = Math.max(1, ...cells.map((c) => c.value));
  const by = new Map(cells.map((c) => [c.date, c.value]));
  const first = new Date(`${year}-01-01T12:00:00`);
  const off = (first.getDay() + 6) % 7;
  const rects: string[] = [];
  for (let i = 0; i < 366; i++) {
    const d = new Date(first.getTime() + i * 86_400_000);
    if (String(d.getFullYear()) !== year) break;
    const v = by.get(dayOf(d.getTime()));
    const k = i + off;
    const op = v == null ? 0.08 : 0.2 + 0.8 * (v / max);
    rects.push(`<rect x="${Math.floor(k / 7) * 11}" y="${(k % 7) * 11}" width="9" height="9" rx="2" fill="#008000" fill-opacity="${op.toFixed(2)}"><title>${dayOf(d.getTime())}${v != null ? `: ${r1(v)}` : ""}</title></rect>`);
  }
  return `<svg viewBox="0 0 ${54 * 11} ${7 * 11}" role="img" aria-label="${esc(label)}" class="heat">${rects.join("")}</svg>`;
}

/** Places on a plain equirectangular map (a graticule, no basemap). */
export function placesSvg(ps: Place[]): string {
  const W = 720; const H = 360;
  const x = (lon: number) => ((lon + 180) / 360) * W;
  const y = (lat: number) => ((90 - lat) / 180) * H;
  const max = Math.max(1, ...ps.map((p) => p.trips));
  const grid = [-120, -60, 0, 60, 120].map((l) => `<line x1="${x(l)}" y1="0" x2="${x(l)}" y2="${H}" />`).join("") + [-60, -30, 0, 30, 60].map((l) => `<line x1="0" y1="${y(l)}" x2="${W}" y2="${y(l)}" />`).join("");
  const dots = ps.filter((p) => p.lat != null).map((p) => `<circle cx="${x(p.lon!).toFixed(1)}" cy="${y(p.lat!).toFixed(1)}" r="${(3 + 9 * Math.sqrt(p.trips / max)).toFixed(1)}" fill="#008000" fill-opacity="0.55"><title>${esc(p.region)}: ${p.trips} trip${p.trips === 1 ? "" : "s"}</title></circle>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Places you went" class="map"><rect width="${W}" height="${H}" rx="8" class="sea" /><g class="grid">${grid}</g>${dots}</svg>`;
}

/** The self-contained Your Year page (inline styles and pictures, no network). */
export function yearHtml(s: YearStory): string {
  const stat = (n: string, l: string) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  const bars = (rows: { label: string; v: number; note?: string }[]) => `<div class="bars">${rows.map((r) => `<div class="bar"><span class="bl">${esc(r.label)}</span><span class="bt"><span style="width:${Math.max(2, r.v)}%"></span></span><span class="bv">${esc(r.note ?? `${r.v}%`)}</span></div>`).join("")}</div>`;
  const firstValue = [...s.values].sort((a, b) => a.rank - b.rank)[0];
  const race = s.values.length && s.race.length ? `<table class="race"><tr><th></th>${s.race.map((r) => `<th>${esc(new Date(`${r.month}-15T12:00:00`).toLocaleDateString("en-US", { month: "short" }))}</th>`).join("")}</tr>${s.values.map((v) => `<tr><td>${esc(v.title)}</td>${s.race.map((r) => `<td>${r.order.indexOf(v.id) + 1}</td>`).join("")}</tr>`).join("")}</table>` : "<p class=\"muted\">The values race appears once your Compass values are confirmed and your goals name the domains they live in.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(s.year)}, your year</title>
<style>
:root{--bg:#ffffff;--fg:#141414;--muted:#6b6b6b;--line:#e6e6e6;--accent:#008000;--soft:#e8f3e8}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f0e;--fg:#f2f2f2;--muted:#9a9a9a;--line:#262826;--soft:#13261a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:44px;line-height:1.1;margin:0 0 6px;letter-spacing:-0.02em}h2{font-size:24px;margin:48px 0 12px}
.muted{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:20px}
.stat{border:1px solid var(--line);border-radius:12px;padding:14px}.n{font-size:28px;font-weight:700;color:var(--accent)}.l{color:var(--muted);font-size:14px}
.bars{display:grid;gap:8px}.bar{display:grid;grid-template-columns:140px 1fr 70px;gap:10px;align-items:center}.bt{background:var(--soft);border-radius:6px;height:12px;overflow:hidden}.bt span{display:block;height:100%;background:var(--accent)}.bv{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
svg{width:100%;height:auto}.sea{fill:var(--soft)}.grid line{stroke:var(--line);stroke-width:1}
table.race{border-collapse:collapse;width:100%;font-size:14px}table.race td,table.race th{border-bottom:1px solid var(--line);padding:6px;text-align:center}table.race td:first-child{text-align:left}
footer{margin-top:60px;color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>${esc(s.year)}, your year</h1><p class="muted">Through ${esc(s.through)}. Written by code from your own records, on your Mac. Nothing here was sent anywhere; places and photos are a record, never a target.</p>
<div class="stats">
${stat(int(s.ai.prompts), "prompts you wrote to AI tools")}
${stat(money(s.ai.usd), `in tokens at API prices${s.ai.peak ? `, ${s.ai.peak.share}% in ${new Date(`${s.ai.peak.month}-15T12:00:00`).toLocaleDateString("en-US", { month: "long" })}` : ""}`)}
${stat(int(s.building.repos), `repos touched, ${int(s.building.shipped)} shipped`)}
${stat(int(s.building.commits), `commits, ${int(s.building.aiCommits)} with an AI co-author`)}
${s.hour != null ? stat(hourLabel(s.hour), "your most active hour") : ""}
${stat(int(s.exploration.trips), `trips, ${s.exploration.places.length} places, ${s.exploration.countries} countr${s.exploration.countries === 1 ? "y" : "ies"}`)}
</div>
<h2>Where your time went</h2>${s.time.length ? bars(s.time.map((t) => ({ label: t.domain, v: t.share }))) : "<p class=\"muted\">No prompt projects yet.</p>"}
<h2>Your values, month by month</h2>${firstValue ? `<p>You said ${esc(firstValue.title)} comes first. Here is where it ranked in your attention, month by month.</p>` : ""}${race}
<h2>Places</h2>${placesSvg(s.exploration.places)}${s.exploration.places.length ? `<p class="muted">${esc(s.exploration.places.slice(0, 8).map((p) => `${p.region} (${p.trips})`).join(", "))}</p>` : ""}
<h2>Your days</h2><p class="muted">Prompts by day</p>${heatSvg(s.heat.prompts, s.year, "Prompts by day")}${s.heat.calm.length ? `<p class="muted">Weekly calm</p>${heatSvg(s.heat.calm, s.year, "Weekly calm")}` : ""}
<h2>AI and tools</h2>${s.ai.byTool.length ? bars(s.ai.byTool.slice(0, 6).map((t) => ({ label: t.tool, v: s.ai.usd ? Math.round((t.usd / s.ai.usd) * 100) : 0, note: money(t.usd) }))) : "<p class=\"muted\">No AI tool records yet.</p>"}${s.tools.length ? `<p class="muted">Apps you used on the most days: ${esc(s.tools.map((t) => `${t.app} (${t.days})`).join(", "))}</p>` : ""}
<h2>Month by month</h2>${s.months.map((m) => `<p><strong>${esc(new Date(`${m.month}-15T12:00:00`).toLocaleDateString("en-US", { month: "long" }))}</strong>: ${esc(m.lines.filter((l) => !l.documentary).slice(0, 4).map((l) => `${l.title} ${fmtUnit(l.value, l.unit)}`).join(", ") || "nothing recorded")}${m.surprise ? `. ${esc(m.surprise)}` : ""}</p>`).join("")}
${s.notes.length ? `<p class="muted">${esc(s.notes.join(" "))}</p>` : ""}
<footer>Made by Prevail from the files in your vault.</footer>
</main></body></html>
`;
}

export function writeYear(vault: string, s: YearStory): { html: string; json: string } {
  const dir = join(resolveDomainDir(vault, "general"), "memory", "reviews");
  mkdirSync(dir, { recursive: true });
  const html = join(dir, `your-year-${s.year}.html`);
  writeFileSync(html, yearHtml(s));
  const ydir = join(metricsDir(vault), "year");
  mkdirSync(ydir, { recursive: true });
  const json = join(ydir, `${s.year}.json`);
  writeFileSync(json, `${JSON.stringify(s, null, 2)}\n`);
  return { html: html.slice(vault.length + 1), json: json.slice(vault.length + 1) };
}

/** The hub's daily pass: last month's recap once, and the year page through December. */
export async function storiesPass(vault: string, c: Computed): Promise<{ recap?: string; year?: string }> {
  const out: { recap?: string; year?: string } = {};
  const m = prevMonth(dayOf(c.ts).slice(0, 7));
  const recapFile = join(resolveDomainDir(vault, "general"), "memory", "reviews", `recap-${m}.md`);
  if (!existsSync(recapFile)) out.recap = writeRecap(vault, monthRecap(vault, c, m));
  const d = new Date(c.ts);
  if (d.getMonth() === 11) {
    const f = join(resolveDomainDir(vault, "general"), "memory", "reviews", `your-year-${d.getFullYear()}.html`);
    let age = Infinity;
    try { age = c.ts - statSync(f).mtimeMs; } catch { /* none yet */ }
    if (age > 7 * 86_400_000) out.year = writeYear(vault, await yearStory(vault, c)).html;
  }
  return out;
}

// ── Patterns with false-discovery control ───────────────────────────────────

/** "Commits" reads as "commits"; "AI spend" keeps its capitals. */
const lc = (t: string) => t.replace(/^[A-Z][a-z]/, (m) => m.toLowerCase());

export interface Pattern { key: string; a: string; b: string; aTitle: string; bTitle: string; lag: number; r: number; p: number; weeks: number; text: string }

/** Weekly series of a metric from its first week with data, the last (partial) week left out. */
function weeklySeries(c: Computed, d: MetricDef): Map<string, number> {
  const w = weekly(c.points[d.id] ?? [], d.days, d.avg);
  const keys = [...w.keys()].sort();
  if (!keys.length) return new Map();
  const cur = weekOf(dayOf(c.ts));
  const out = new Map<string, number>();
  for (let t = new Date(`${keys[0]}T12:00:00`).getTime(); dayOf(t) < cur; t += 7 * 86_400_000) out.set(dayOf(t), w.get(dayOf(t)) ?? 0);
  return out;
}

/**
 * Every pair of metrics (at most `max` with the most weeks of data), lags 0
 * to 2 weeks (a leads b), only weeks after both started; Benjamini-Hochberg
 * at q across all the tests; survivors with |r| >= 0.4, in plain words.
 */
export function patterns(c: Computed, o: { q?: number; max?: number; minWeeks?: number } = {}): { tests: number; found: Pattern[] } {
  const minW = o.minWeeks ?? 8;
  const series = c.defs.filter((d) => !d.documentary).map((d) => ({ d, s: weeklySeries(c, d) })).filter((x) => x.s.size >= minW && [...x.s.values()].some((v) => v !== 0))
    .sort((a, b) => b.s.size - a.s.size).slice(0, o.max ?? 20);
  const tests: { a: typeof series[number]; b: typeof series[number]; lag: number; r: number; n: number; p: number }[] = [];
  // Two metrics read from the same events move together by definition (AI spend and tokens; commits and AI-assisted commits): never a pattern.
  const sameEvents = (x: MetricDef, y: MetricDef) => x.kinds.some((k) => y.kinds.includes(k));
  for (const a of series) for (const b of series) {
    if (a === b || sameEvents(a.d, b.d)) continue;
    for (const lag of [0, 1, 2]) {
      if (lag === 0 && a.d.id > b.d.id) continue; // a same-week pair is tested once
      const xs: number[] = []; const ys: number[] = [];
      for (const [w, v] of a.s) { const t = dayOf(new Date(`${w}T12:00:00`).getTime() + lag * 7 * 86_400_000); if (b.s.has(t)) { xs.push(v); ys.push(b.s.get(t)!); } }
      if (xs.length < minW) continue;
      const r = pearson(xs, ys);
      if (r == null) continue;
      tests.push({ a, b, lag, r, n: xs.length, p: pValueR(r, xs.length) });
    }
  }
  const keep = bh(tests.map((t) => t.p), o.q ?? 0.1);
  const found = tests.filter((t, i) => keep[i] && Math.abs(t.r) >= 0.4).sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 12).map((t) => {
    const when = t.lag === 0 ? "in the same week" : t.lag === 1 ? "the week after" : "two weeks after";
    const dir = t.r > 0 ? "more" : "less";
    return { key: `${t.a.d.id}>${t.b.d.id}@${t.lag}`, a: t.a.d.id, b: t.b.d.id, aTitle: t.a.d.title, bTitle: t.b.d.title, lag: t.lag, r: Math.round(t.r * 100) / 100, p: Math.round(t.p * 10000) / 10000, weeks: t.n,
      text: `Weeks with more ${lc(t.a.d.title)} go with ${dir} ${lc(t.b.d.title)} ${when} (r ${Math.round(t.r * 100) / 100} over ${t.n} weeks, chance controlled across ${tests.length} tests). A pattern, not proof.` };
  });
  return { tests: tests.length, found };
}

// ── n-of-1 experiments ──────────────────────────────────────────────────────

export interface Experiment {
  id: string; ts: number; status: "proposed" | "running" | "done" | "stopped";
  input: string; outcome: string; inputTitle: string; outcomeTitle: string;
  hypothesis: string; instruction: string; start: string; weeks: { week: string; arm: "A" | "B" }[];
  result?: { a: number; b: number; diff: number; t: number | null; p: number | null; verdict: "supports" | "no difference" | "too few weeks" | "against"; text: string };
}
const expPath = (vault: string) => join(metricsDir(vault), "experiments.jsonl");

export function readExperiments(vault: string): Experiment[] {
  const by = new Map<string, Experiment>();
  for (const l of readText(expPath(vault)).split("\n")) { try { if (l.trim()) { const e = JSON.parse(l) as Experiment; by.set(e.id, e); } } catch { /* torn */ } }
  return [...by.values()].sort((a, b) => b.ts - a.ts);
}
function saveExperiment(vault: string, e: Experiment): Experiment {
  mkdirSync(metricsDir(vault), { recursive: true });
  appendFileSync(expPath(vault), `${JSON.stringify(e)}\n`);
  return e;
}

const nextMonday = (day: string) => { const w = weekOf(day); const d = new Date(`${w}T12:00:00`); d.setDate(d.getDate() + 7); return dayOf(d.getTime()); };

/** Propose a four-week alternating experiment from a pattern (or any input and outcome metric). */
export function proposeExperiment(vault: string, c: Computed, o: { input: string; outcome: string; instruction?: string; weeks?: number; now?: number }): Experiment {
  const di = c.defs.find((d) => d.id === o.input);
  const doo = c.defs.find((d) => d.id === o.outcome);
  if (!di || !doo) throw new Error("an experiment needs two known metrics");
  if (readExperiments(vault).some((e) => e.status === "running")) throw new Error("one experiment at a time: finish or stop the running one first");
  const now = o.now ?? Date.now();
  const start = nextMonday(dayOf(now));
  const n = Math.max(4, Math.min(8, o.weeks ?? 4));
  const weeks = Array.from({ length: n }, (_, i) => ({ week: dayOf(new Date(`${start}T12:00:00`).getTime() + i * 7 * 86_400_000), arm: (i % 2 === 0 ? "A" : "B") as "A" | "B" }));
  return saveExperiment(vault, {
    id: `exp-${now.toString(36)}`, ts: now, status: "proposed", input: di.id, outcome: doo.id, inputTitle: di.title, outcomeTitle: doo.title,
    hypothesis: `More ${lc(di.title)} changes ${lc(doo.title)}.`,
    instruction: (o.instruction ?? `On A weeks, aim for more ${lc(di.title)} than usual; on B weeks, as usual.`).slice(0, 240),
    start, weeks,
  });
}

export function setExperiment(vault: string, id: string, status: "running" | "stopped", now = Date.now()): Experiment {
  const e = readExperiments(vault).find((x) => x.id === id);
  if (!e) throw new Error(`no experiment ${id}`);
  if (status === "running" && e.status !== "proposed") throw new Error(`experiment ${id} is ${e.status}`);
  return saveExperiment(vault, { ...e, status, ts: now });
}

/** This week's arm of the running experiment, for the review card. */
export function experimentThisWeek(vault: string, now = Date.now()): { id: string; arm: "A" | "B"; text: string } | null {
  const e = readExperiments(vault).find((x) => x.status === "running");
  if (!e) return null;
  const w = e.weeks.find((x) => x.week === weekOf(dayOf(now)));
  if (!w) return null;
  return { id: e.id, arm: w.arm, text: w.arm === "A" ? `An A week: ${e.instruction.replace(/^On A weeks,?\s*/i, "")}` : `A B week: ${lc(e.inputTitle)} as usual.` };
}

/** Welch's t and a two-sided p (normal approximation for the t distribution's tail, with df). */
export function welch(a: number[], b: number[]): { t: number | null; p: number | null } {
  if (a.length < 2 || b.length < 2) return { t: null, p: null };
  const m = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const v = (x: number[]) => { const mu = m(x); return x.reduce((s, y) => s + (y - mu) ** 2, 0) / (x.length - 1); };
  const se = Math.sqrt(v(a) / a.length + v(b) / b.length);
  if (!se) return { t: m(a) === m(b) ? 0 : null, p: m(a) === m(b) ? 1 : null };
  const t = (m(a) - m(b)) / se;
  const df = (v(a) / a.length + v(b) / b.length) ** 2 / ((v(a) / a.length) ** 2 / (a.length - 1) + (v(b) / b.length) ** 2 / (b.length - 1));
  // Two-sided p from the t distribution (regularized incomplete beta via a continued fraction).
  const x = df / (df + t * t);
  const p = Math.min(1, Math.max(0, ibeta(x, df / 2, 0.5)));
  return { t: Math.round(t * 100) / 100, p: Math.round(p * 10000) / 10000 };
}
function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b + lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = i / 2;
    let num: number;
    if (i === 0) num = 1;
    else if (i % 2 === 0) num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d; f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  return front * (f - 1);
}
function lgamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z; const x = z; let tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Score an experiment from the outcome's weekly values in A and B weeks. */
export function scoreExperiment(vault: string, c: Computed, id: string, now = Date.now()): Experiment {
  const e = readExperiments(vault).find((x) => x.id === id);
  if (!e) throw new Error(`no experiment ${id}`);
  const d = c.defs.find((x) => x.id === e.outcome);
  if (!d) throw new Error(`no metric ${e.outcome}`);
  const w = weekly(c.points[d.id] ?? [], d.days, d.avg);
  const cur = weekOf(dayOf(now));
  const done = e.weeks.filter((x) => x.week < cur);
  const a = done.filter((x) => x.arm === "A").map((x) => w.get(x.week) ?? 0);
  const b = done.filter((x) => x.arm === "B").map((x) => w.get(x.week) ?? 0);
  const mean = (x: number[]) => (x.length ? r1(x.reduce((s, v) => s + v, 0) / x.length) : 0);
  const { t, p } = welch(a, b);
  const diff = r1(mean(a) - mean(b));
  const verdict: NonNullable<Experiment["result"]>["verdict"] = a.length < 2 || b.length < 2 ? "too few weeks" : p != null && p < 0.1 ? (diff > 0 ? "supports" : "against") : "no difference";
  const text = verdict === "too few weeks"
    ? `${a.length + b.length} of ${e.weeks.length} weeks are done; it needs at least two of each.`
    : `In A weeks ${lc(e.outcomeTitle)} averaged ${mean(a)}, in B weeks ${mean(b)} (${diff >= 0 ? "+" : ""}${diff}). ${verdict === "supports" ? "That supports the idea, for you, over these weeks." : verdict === "against" ? "It moved the other way." : "No difference you can tell from chance yet."} n-of-1, ${a.length + b.length} weeks.`;
  const status: Experiment["status"] = done.length >= e.weeks.length ? "done" : e.status;
  return saveExperiment(vault, { ...e, status, ts: now, result: { a: mean(a), b: mean(b), diff, t, p, verdict, text } });
}

// ── CLI: prevail metrics year|recap|heatmap|places|patterns|experiment ──────

export async function storiesCommand(sub: string, argv: string[], vault: string, c: Computed): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    const year = args.get("year") ?? String(new Date(c.ts).getFullYear());
    if (sub === "year") {
      const s = await yearStory(vault, c, year);
      if (args.has("write")) { const w = writeYear(vault, s); if (args.json) out({ ok: true, ...w, story: s }); else console.log(`Wrote ${w.html}`); return 0; }
      if (args.json) out(s); else console.log(`${s.year}: ${s.ai.prompts} prompts, ${money(s.ai.usd)} in tokens, ${s.building.repos} repos, ${s.exploration.trips} trips`);
      return 0;
    }
    if (sub === "recap") {
      const m = args.get("month") ?? prevMonth(dayOf(c.ts).slice(0, 7));
      const r = monthRecap(vault, c, m);
      if (args.has("write")) r.file = writeRecap(vault, r);
      if (args.json) out(r); else process.stdout.write(recapMarkdown(r));
      return 0;
    }
    if (sub === "heatmap") { const h = heatmap(c, args.pos[1] ?? "m-prompts", year); if (args.json) out(h); else console.log(`${h.length} days`); return 0; }
    if (sub === "places") { const p = places(c.trips, args.has("all") ? undefined : year); if (args.json) out(p); else for (const x of p) console.log(`${String(x.trips).padStart(4)} ${x.region}`); return 0; }
    if (sub === "patterns") {
      const r = patterns(c);
      mkdirSync(metricsDir(vault), { recursive: true });
      writeFileSync(join(metricsDir(vault), "patterns.json"), `${JSON.stringify({ ts: c.ts, ...r }, null, 2)}\n`);
      if (args.json) out(r); else { console.log(`${r.tests} tests, ${r.found.length} survive`); for (const x of r.found) console.log(`- ${x.text}`); }
      return 0;
    }
    if (sub === "experiment" || sub === "experiments") {
      const act = sub === "experiments" ? "list" : args.pos[1] ?? "list";
      if (act === "list") { const l = readExperiments(vault); if (args.json) out({ experiments: l, thisWeek: experimentThisWeek(vault) }); else for (const e of l) console.log(`${e.status.padEnd(9)} ${e.id} ${e.hypothesis}${e.result ? ` -> ${e.result.text}` : ""}`); return 0; }
      if (act === "propose") {
        let input = args.get("input"); let outcome = args.get("outcome");
        const key = args.pos[2];
        if (key && !input) { const m = /^(m-[a-z0-9-]+)>(m-[a-z0-9-]+)/.exec(key); if (!m) return fail("usage: prevail metrics experiment propose <pattern-key> | --input m-x --outcome m-y"); input = m[1]; outcome = m[2]; }
        const e = proposeExperiment(vault, c, { input: input ?? "", outcome: outcome ?? "", instruction: args.get("instruction") });
        if (args.json) out({ ok: true, experiment: e }); else console.log(`Proposed ${e.id}: ${e.instruction} Starts ${e.start}.`);
        return 0;
      }
      if (act === "start" || act === "stop") { const e = setExperiment(vault, args.pos[2] ?? "", act === "start" ? "running" : "stopped"); if (args.json) out({ ok: true, experiment: e }); else console.log(`${e.id}: ${e.status}`); return 0; }
      if (act === "score") { const e = scoreExperiment(vault, c, args.pos[2] ?? ""); if (args.json) out({ ok: true, experiment: e }); else console.log(e.result?.text ?? ""); return 0; }
      return fail("usage: prevail metrics experiment list | propose <pattern-key> | start|stop|score <id>");
    }
  } catch (e) { return fail((e as Error).message); }
  return fail("unknown");
}

export const STORY_SUBCOMMANDS = ["year", "recap", "heatmap", "places", "patterns", "experiment", "experiments"];
