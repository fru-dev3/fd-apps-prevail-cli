// Qualitative metrics and alignment (metrics plan M4).
//
// What the research allows, and nothing more:
//   - Asked, tiny: the weekly calm 1-5 (review.ts), a quarterly life ladder
//     (now and in five years, 0-10), an optional monthly WHO-5 (off until the
//     user turns it on). All are check-in events under events/checkins/.
//   - Hypotheses, never verdicts: "Heavy week? Emails 2.1x your normal,
//     after-hours meetings up." with yes / no. Answers train per-feature
//     weights (a small perceptron), so a kind of question the user keeps
//     saying no to stops being asked.
//   - Writing and reading themes as trends, in words, from the local-model
//     sources (source-mac.ts), never a mood number.
//   - Proxy promotion: a passive metric is shown as a proxy for a felt state
//     only after it predicts the user's own check-ins (8+ paired weeks,
//     |r| >= 0.4, p < 0.05); retired when it clearly does not.
//   - The Compass: each value's "matters" (its rank) against "lived" (its
//     metrics against enough or the user's own normal); guardrails; input to
//     outcome tests with time lags and false-discovery-rate control ("a
//     pattern, not proof"); seasons that pause metrics (declared in
//     metrics.md under ## Seasons, or automatic on weeks away).
//
// Everything is computed by code from events and the user's answers.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { items, readCompass } from "./compass.ts";
import {
  baseline, dayOf, eventsRoot, fmt, hostSlug, metricsDir, metricsMdPath, readRegistry, series, weekOf, weekly,
  type Computed, type MetricDef,
} from "./metrics.ts";
import { consented } from "./sources.ts";
import { vreadFile } from "./vault-session.ts";

const DAY = 86_400_000;
const addDays = (day: string, n: number) => dayOf(Date.parse(`${day}T12:00:00`) + n * DAY);
const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };
const jsonl = <T>(p: string): T[] => readText(p).split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as T] : []; } catch { return []; } });

// ── Asked: the life ladder and WHO-5 ────────────────────────────────────────

function appendCheckin(vault: string, kind: string, attrs: Record<string, number | string>, now: number): void {
  const host = hostSlug();
  const dir = join(eventsRoot(vault), "checkins");
  mkdirSync(dir, { recursive: true });
  const day = dayOf(now);
  appendFileSync(join(dir, `${day.slice(0, 7)}.${host}.jsonl`), `${JSON.stringify({ ts: day, src: "checkins", kind, n: 1, host, tier: "asked", attrs: { ...attrs, at: now } })}\n`);
}

export const quarterOf = (day: string) => `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;

interface CheckinEvent { ts: string; kind: string; attrs: Record<string, number | string> }
export function readCheckinEvents(vault: string, kind?: string): CheckinEvent[] {
  const dir = join(eventsRoot(vault), "checkins");
  let fs: string[] = [];
  try { fs = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return fs.flatMap((f) => jsonl<CheckinEvent>(join(dir, f))).filter((e) => !kind || e.kind === kind).sort((a, b) => a.ts.localeCompare(b.ts));
}

/** The quarterly life ladder (Cantril): where you stand now and where you expect to be in five years, 0 to 10. */
export function recordLadder(vault: string, nowScore: number, futureScore: number, now = Date.now()): { quarter: string } {
  for (const v of [nowScore, futureScore]) if (!Number.isInteger(v) || v < 0 || v > 10) throw new Error("the ladder is a whole number from 0 to 10");
  const quarter = quarterOf(dayOf(now));
  appendCheckin(vault, "checkin.ladder", { now: nowScore, future: futureScore, quarter }, now);
  return { quarter };
}

/** WHO-5: five items 0-5 over the last two weeks; the score is their sum times four (0-100). Only the score is kept. */
export function recordWho5(vault: string, answers: number[], now = Date.now()): { score: number } {
  if (answers.length !== 5 || answers.some((a) => !Number.isInteger(a) || a < 0 || a > 5)) throw new Error("WHO-5 takes five whole numbers from 0 to 5");
  if (!who5Enabled(vault)) throw new Error("WHO-5 is off; turn it on with: prevail metrics who5 on");
  const score = answers.reduce((a, b) => a + b, 0) * 4;
  appendCheckin(vault, "checkin.who5", { score, month: dayOf(now).slice(0, 7) }, now);
  return { score };
}

const settingsPath = (vault: string) => join(metricsDir(vault), "asked.json");
export function who5Enabled(vault: string): boolean { try { return !!(JSON.parse(readFileSync(settingsPath(vault), "utf8")) as { who5?: boolean }).who5; } catch { return false; } }
export function setWho5(vault: string, on: boolean): void {
  mkdirSync(metricsDir(vault), { recursive: true });
  writeFileSync(settingsPath(vault), `${JSON.stringify({ who5: on, ts: new Date().toISOString() })}\n`);
}

export const WHO5_ITEMS = [
  "I have felt cheerful and in good spirits",
  "I have felt calm and relaxed",
  "I have felt active and vigorous",
  "I woke up feeling fresh and rested",
  "My daily life has been filled with things that interest me",
];

/** What to ask on the review card: the ladder once a quarter; WHO-5 once a month when on. Never daily. */
export function askedDue(vault: string, now = Date.now()): { ladder: boolean; who5: boolean } {
  const day = dayOf(now);
  const ladder = !readCheckinEvents(vault, "checkin.ladder").some((e) => quarterOf(e.ts) === quarterOf(day));
  const who5 = who5Enabled(vault) && !readCheckinEvents(vault, "checkin.who5").some((e) => e.ts.slice(0, 7) === day.slice(0, 7));
  return { ladder, who5 };
}

// ── Seasons ─────────────────────────────────────────────────────────────────

export interface Season { id: string; title: string; from: string; to: string; pauses: string[] | "all"; auto?: boolean }

// What a week away pauses: work-shaped metrics, never the loved ones (documentary already).
const AWAY_PAUSES = ["m-commits", "m-ai-commits", "m-coding-days", "m-shipped", "m-ai-spend", "m-ai-tokens", "m-ai-sessions", "m-prompts", "m-emails-sent", "m-email-replies", "m-reply-time", "m-meeting-hours", "m-focus-hours", "m-after-hours", "m-tasks-done", "m-prs-merged", "m-screen-minutes", "m-web-visits"];

/** Seasons: lines under ## Seasons in metrics.md, plus weeks with three or more days away (Timeline) or trip days. */
export function seasons(vault: string, c?: Computed): Season[] {
  const out: Season[] = [];
  let inSeasons = false;
  for (const l of readText(metricsMdPath(vault)).split("\n")) {
    if (/^##\s+/.test(l)) { inSeasons = /^##\s+seasons\b/i.test(l); continue; }
    if (!inSeasons || !/^- \S/.test(l)) continue;
    const t: Record<string, string> = {};
    for (const m of l.matchAll(/~([a-z][a-z0-9_-]*):(\S+)/g)) t[m[1]!] = m[2]!;
    if (!t.from || !/^\d{4}-\d{2}-\d{2}$/.test(t.from)) continue;
    out.push({ id: t.id ?? `s-${t.from}`, title: l.replace(/^-\s+/, "").replace(/\s+~\S+/g, "").trim(), from: t.from, to: t.to && /^\d{4}-\d{2}-\d{2}$/.test(t.to) ? t.to : t.from, pauses: t.pauses ? t.pauses.split(",") : "all" });
  }
  if (c) {
    const away = new Map<string, Set<string>>();
    for (const e of c.events) if (e.kind === "day.away" || e.kind === "trip.activity") { const w = weekOf(e.ts); (away.get(w) ?? away.set(w, new Set()).get(w)!).add(e.ts); }
    for (const [w, ds] of away) if (ds.size >= 3) out.push({ id: `s-away-${w}`, title: "Away", from: w, to: addDays(w, 6), pauses: AWAY_PAUSES, auto: true });
  }
  return out;
}

/** Is this metric paused in this week by a season? */
export function pausedBy(ss: Season[], metric: MetricDef | string, week: string): Season | null {
  const id = typeof metric === "string" ? metric : metric.id;
  const end = addDays(week, 6);
  return ss.find((s) => s.from <= end && s.to >= week && (s.pauses === "all" ? !(typeof metric !== "string" && metric.documentary) : s.pauses.includes(id))) ?? null;
}

// ── Hypotheses with yes / no that train ─────────────────────────────────────

export interface Hypothesis { key: string; kind: string; week: string; text: string; evidence: { metric: string; title: string; value: number; normal: { lo: number; hi: number }; z: number }[]; score: number }

// Each kind: the felt state it asks about and the metrics whose rise (+1) or fall (-1) suggests it.
const KINDS: { kind: string; ask: string; features: [string, 1 | -1][] }[] = [
  { kind: "heavy-week", ask: "Heavy week?", features: [["m-emails-sent", 1], ["m-meeting-hours", 1], ["m-after-hours", 1], ["m-ai-spend", 1], ["m-prompts", 1], ["m-screen-minutes", 1]] },
  { kind: "running-hot", ask: "Running hot?", features: [["m-after-hours", 1], ["m-sleep", -1], ["m-screen-minutes", 1], ["m-reply-time", -1]] },
  { kind: "creative-streak", ask: "A creative streak?", features: [["m-shipped", 1], ["m-commits", 1], ["m-videos", 1], ["m-prs-merged", 1]] },
  { kind: "pulling-back", ask: "Pulling back from people?", features: [["m-email-people", -1], ["m-messages", -1], ["m-calls", -1]] },
];

const weightsPath = (vault: string) => join(metricsDir(vault), "hypothesis-weights.json");
const answersPath = (vault: string) => join(metricsDir(vault), "hypotheses.jsonl");
type Weights = Record<string, Record<string, number>>;
export function readWeights(vault: string): Weights { try { return JSON.parse(readFileSync(weightsPath(vault), "utf8")) as Weights; } catch { return {}; } }

const SHOW_AT = 1.2;

/**
 * This week's hypotheses: features are each metric's distance outside the
 * user's normal (in band widths), signed so that "more of the state" is
 * positive; the score is the learned weighted sum. Paused metrics are left
 * out. At most one is shown (the strongest over SHOW_AT).
 */
export function hypotheses(vault: string, c: Computed, week = weekOf(addDays(dayOf(c.ts), -7))): Hypothesis[] {
  const ss = seasons(vault, c);
  const w = readWeights(vault);
  const answered = new Set(jsonl<{ key: string }>(answersPath(vault)).map((a) => a.key));
  const out: Hypothesis[] = [];
  for (const k of KINDS) {
    const ev: Hypothesis["evidence"] = [];
    let score = 0;
    for (const [id, sign] of k.features) {
      const m = c.defs.find((d) => d.id === id);
      if (!m || pausedBy(ss, m, week)) continue;
      const byWeek = weekly(c.points[id] ?? [], m.days, m.avg);
      if (!byWeek.size) continue;
      const b = baseline(byWeek, week);
      if (b.learning) continue;
      const v = byWeek.get(week) ?? 0;
      const spread = Math.max(b.hi - b.lo, b.median * 0.25, 1e-9);
      const z = sign * (v > b.hi ? (v - b.hi) / spread : v < b.lo ? (v - b.lo) / spread : 0);
      if (z <= 0) continue;
      const wt = w[k.kind]?.[id] ?? 1;
      score += wt * Math.min(z, 3);
      ev.push({ metric: id, title: m.title, value: v, normal: { lo: b.lo, hi: b.hi }, z: Math.round(z * 100) / 100 });
    }
    if (ev.length < 2 && !(ev.length === 1 && ev[0]!.z >= 2)) continue;
    const key = `${k.kind}:${week}`;
    if (answered.has(key)) continue;
    const m0 = (e: Hypothesis["evidence"][0]) => { const unit = c.defs.find((d) => d.id === e.metric)!.unit; const mid = (e.normal.lo + e.normal.hi) / 2; const x = mid >= 1 ? e.value / mid : Infinity; const ratio = e.value > e.normal.hi && x <= 20 ? `${Math.round(x * 10) / 10}x your normal` : `${fmt(e.value, unit)}, normal ${fmt(e.normal.lo, unit)} to ${fmt(e.normal.hi, unit)}`; return `${e.title} ${ratio}`; };
    out.push({ key, kind: k.kind, week, score: Math.round(score * 100) / 100, evidence: ev, text: `${k.ask} ${ev.slice(0, 3).map(m0).join("; ")}.` });
  }
  return out.filter((h) => h.score >= SHOW_AT).sort((a, b) => b.score - a.score);
}

/** The user's answer trains the weights of the features that raised it, and becomes an asked event. */
export function answerHypothesis(vault: string, h: Hypothesis, yes: boolean, now = Date.now()): Weights {
  const w = readWeights(vault);
  const kw = (w[h.kind] ??= {});
  const lr = 0.25;
  for (const e of h.evidence) kw[e.metric] = Math.max(0.1, Math.min(3, Math.round(((kw[e.metric] ?? 1) + (yes ? lr : -lr) * Math.min(e.z, 2)) * 1000) / 1000));
  mkdirSync(metricsDir(vault), { recursive: true });
  writeFileSync(`${weightsPath(vault)}.tmp`, `${JSON.stringify(w, null, 2)}\n`);
  renameSync(`${weightsPath(vault)}.tmp`, weightsPath(vault));
  appendFileSync(answersPath(vault), `${JSON.stringify({ ts: now, key: h.key, kind: h.kind, week: h.week, answer: yes ? "yes" : "no", features: Object.fromEntries(h.evidence.map((e) => [e.metric, e.z])) })}\n`);
  appendCheckin(vault, "checkin.hypothesis", { kind: h.kind, yes: yes ? 1 : 0, week: h.week }, now);
  return w;
}

// ── Themes as trends (words, from a local model) ────────────────────────────

export interface ThemeTrend { kind: "writing" | "reading"; month: string; topics: string[]; new: string[]; gone: string[]; steady: string[]; state: string }

export function themeTrends(c: Computed, vault: string): ThemeTrend[] {
  const out: ThemeTrend[] = [];
  for (const [kind, ev, src] of [["writing", "theme.writing", "writing-themes"], ["reading", "theme.reading", "browser-topics"]] as const) {
    const by = new Map<string, string[]>();
    for (const e of c.events) if (e.kind === ev && e.project) { const m = e.ts.slice(0, 7); (by.get(m) ?? by.set(m, []).get(m)!).push(e.project); }
    const months = [...by.keys()].sort();
    const cur = months.at(-1);
    if (!cur) { out.push({ kind, month: "", topics: [], new: [], gone: [], steady: [], state: consented(vault, src) ? "waiting for a local model and a month of data" : `off: turn on ${src === "browser-topics" ? "Browsing topics" : "Writing themes"} in Sources` }); continue; }
    const now = by.get(cur)!;
    const prev = new Set(months.length > 1 ? by.get(months.at(-2)!)! : []);
    out.push({ kind, month: cur, topics: now, new: now.filter((t) => !prev.has(t)), gone: [...prev].filter((t) => !now.includes(t)), steady: now.filter((t) => prev.has(t)), state: "a pattern, in words; never a mood score" });
  }
  return out;
}

// ── Statistics: correlation, its p-value, Benjamini-Hochberg ────────────────

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx; const dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Regularized incomplete beta through a continued fraction (Numerical Recipes), for the t distribution.
function betacf(a: number, b: number, x: number): number {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = Math.abs(d) < 1e-30 ? 1e-30 : d; d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; d = Math.abs(d) < 1e-30 ? 1e-30 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; d = Math.abs(d) < 1e-30 ? 1e-30 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c; d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value for a Pearson r on n pairs (t test with n-2 degrees of freedom). */
export function pValueR(r: number, n: number): number {
  if (n < 3) return 1;
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2;
  const t = (r * Math.sqrt(df)) / Math.sqrt(1 - r * r);
  return ibeta(df / 2, 0.5, df / (df + t * t));
}
/** Benjamini-Hochberg: which of these p-values survive at false-discovery rate q. */
export function bh(ps: number[], q = 0.1): boolean[] {
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let k = -1;
  idx.forEach(([p], r) => { if (p <= ((r + 1) / ps.length) * q) k = r; });
  const keep = new Array(ps.length).fill(false);
  for (let r = 0; r <= k; r++) keep[idx[r]![1]] = true;
  return keep;
}

/**
 * Complete weeks from the metric's first week with data (before it, a zero
 * means "no source yet", not "none"), leaving out weeks a season pauses.
 */
function weeklySeries(c: Computed, id: string, count: number, ss: Season[]): Map<string, number> {
  const m = c.defs.find((d) => d.id === id);
  const out = new Map<string, number>();
  const pts = c.points[id] ?? [];
  if (!m || !pts.length) return out;
  const first = weekOf(pts[0]!.date);
  const thisWeek = weekOf(dayOf(c.ts));
  for (const p of series(c, id, "week", count)) if (p.date >= first && p.date < thisWeek && !pausedBy(ss, m, p.date)) out.set(p.date, p.value);
  return out;
}

// ── Proxy promotion ─────────────────────────────────────────────────────────

export interface Proxy { proxy: string; felt: string; weeks: number; r: number | null; p: number | null; status: "hidden" | "promoted" | "retired"; text: string }
const PROXY_PAIRS: [string, string][] = [["m-sleep", "m-calm"], ["m-after-hours", "m-calm"], ["m-screen-minutes", "m-calm"], ["m-email-people", "m-calm"], ["m-workouts", "m-calm"], ["m-meeting-hours", "m-calm"], ["m-new-places", "m-calm"], ["m-steps", "m-calm"]];

/** A passive proxy is shown only after it predicts the user's own check-ins; until then it stays hidden. */
export function proxies(vault: string, c: Computed): Proxy[] {
  const ss = seasons(vault, c);
  const out: Proxy[] = [];
  for (const [proxy, felt] of PROXY_PAIRS) {
    const f = c.defs.find((d) => d.id === felt);
    const pm = c.defs.find((d) => d.id === proxy);
    if (!f || !pm) continue;
    const fs = new Map([...weeklySeries(c, felt, 52, [])].filter(([, v]) => v > 0));
    const ps = weeklySeries(c, proxy, 52, ss);
    const weeks = [...fs.keys()].filter((w) => ps.has(w));
    const r = pearson(weeks.map((w) => ps.get(w)!), weeks.map((w) => fs.get(w)!));
    const p = r === null ? null : pValueR(r, weeks.length);
    const status: Proxy["status"] = r !== null && weeks.length >= 8 && Math.abs(r) >= 0.4 && p !== null && p < 0.05 ? "promoted" : r !== null && weeks.length >= 16 && Math.abs(r) < 0.1 ? "retired" : "hidden";
    const rr = r === null ? null : Math.round(r * 100) / 100;
    out.push({ proxy, felt, weeks: weeks.length, r: rr, p: p === null ? null : Math.round(p * 1000) / 1000, status,
      text: status === "promoted" ? `${pm.title} tracks your ${f.title.toLowerCase()} (r ${rr}, ${weeks.length} weeks). A pattern, not proof.` : status === "retired" ? `${pm.title} does not track your ${f.title.toLowerCase()} (${weeks.length} weeks); retired.` : `${pm.title}: hidden until it predicts your check-ins (${weeks.length} of 8 weeks paired).` });
  }
  mkdirSync(metricsDir(vault), { recursive: true });
  writeFileSync(join(metricsDir(vault), "proxies.json"), `${JSON.stringify({ ts: c.ts, proxies: out }, null, 2)}\n`);
  return out;
}

// ── Input to outcome, with lags ─────────────────────────────────────────────

export interface LagTest { input: string; outcome: string; weeks: number; best_lag: number | null; r: number | null; p: number | null; verdict: "moves it" | "no evidence yet" | "too early" | "does not move it"; text: string }
const DEFAULT_PAIRS: [string, string][] = [["m-job-apps", "m-email-replies"], ["m-videos", "m-subscribers"], ["m-sleep", "m-calm"], ["m-commits", "m-shipped"], ["m-focus-hours", "m-shipped"], ["m-workouts", "m-calm"]];

/** Does the input move the outcome 0 to 4 weeks later? Every lag of every pair is one test; Benjamini-Hochberg at q 0.1 decides. */
export function lagTests(vault: string, c: Computed): LagTest[] {
  const ss = seasons(vault, c);
  const declared: [string, string][] = [];
  for (const [id, r] of readRegistry(vault)) if (r.tokens.moves) for (const o of r.tokens.moves.split(",")) declared.push([id, o]);
  const pairs = [...declared, ...DEFAULT_PAIRS.filter(([a, b]) => !declared.some(([x, y]) => x === a && y === b))].filter(([a, b]) => c.defs.some((d) => d.id === a) && c.defs.some((d) => d.id === b));
  const tests: { pair: number; lag: number; r: number; p: number; n: number }[] = [];
  const weeksOf: number[] = [];
  pairs.forEach(([a, b], i) => {
    const xa = weeklySeries(c, a, 52, ss);
    const yb = weeklySeries(c, b, 52, ss);
    const ws = [...xa.keys()];
    let n0 = 0;
    for (let lag = 0; lag <= 4; lag++) {
      const xs: number[] = []; const ys: number[] = [];
      for (const w of ws) { const y = yb.get(addDays(w, 7 * lag)); if (y !== undefined) { xs.push(xa.get(w)!); ys.push(y); } }
      if (lag === 0) n0 = xs.length;
      const r = pearson(xs, ys);
      if (r !== null && xs.length >= 12) tests.push({ pair: i, lag, r, p: pValueR(r, xs.length), n: xs.length });
    }
    weeksOf[i] = n0;
  });
  const keep = bh(tests.map((t) => t.p), 0.1);
  return pairs.map(([a, b], i) => {
    const ta = tests.map((t, j) => ({ ...t, keep: keep[j]! })).filter((t) => t.pair === i);
    const best = ta.filter((t) => t.keep && t.r > 0).sort((x, y) => x.p - y.p)[0];
    const ti = (id: string) => c.defs.find((d) => d.id === id)!.title;
    const weeks = weeksOf[i] ?? 0;
    if (!ta.length) return { input: a, outcome: b, weeks, best_lag: null, r: null, p: null, verdict: "too early" as const, text: `${ti(a)} and ${ti(b)}: too early (needs 12 weeks of both; ${weeks} so far).` };
    if (best) return { input: a, outcome: b, weeks, best_lag: best.lag, r: Math.round(best.r * 100) / 100, p: Math.round(best.p * 1000) / 1000, verdict: "moves it" as const, text: `More ${ti(a).toLowerCase()} goes with more ${ti(b).toLowerCase()} ${best.lag ? `${best.lag} week${best.lag === 1 ? "" : "s"} later` : "the same week"} (r ${Math.round(best.r * 100) / 100}, ${best.n} weeks). A pattern, not proof.` };
    const strongest = [...ta].sort((x, y) => Math.abs(y.r) - Math.abs(x.r))[0]!;
    const verdict = weeks >= 26 && Math.abs(strongest.r) < 0.15 ? "does not move it" as const : "no evidence yet" as const;
    return { input: a, outcome: b, weeks, best_lag: null, r: Math.round(strongest.r * 100) / 100, p: Math.round(strongest.p * 1000) / 1000, verdict, text: verdict === "does not move it" ? `${ti(a)} does not move ${ti(b).toLowerCase()} in ${weeks} weeks; swap the input.` : `${ti(a)} and ${ti(b)}: no evidence yet after controlling for chance (${ta.length} lags tested).` };
  });
}

// ── The Compass: matters vs lived, guardrails ───────────────────────────────

export interface LivedMetric { id: string; title: string; value: number; score: number; basis: string; paused?: string }
export interface ValueLived { id: string; title: string; rank: number; matters: number; lived: number | null; metrics: LivedMetric[]; checkin?: number; unmeasured: boolean }

/**
 * Each value's matters (its rank: the top value 5, the fifth and below 1)
 * against lived (1 to 5 from the metrics that serve it over the last four
 * weeks: against ~enough when set, else against the user's own normal; calm
 * counts for values that name peace or calm). Documentary metrics are records
 * and never score.
 */
export function mattersVsLived(vault: string, c: Computed): ValueLived[] {
  const doc = readCompass(vault);
  const values = items(doc, "value").filter((v) => v.tokens.status !== "proposed" && v.tokens.status !== "dropped").sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99));
  const goals = items(doc, "goal");
  const reg = readRegistry(vault);
  const ss = seasons(vault, c);
  const week = weekOf(dayOf(c.ts));
  const calm = series(c, "m-calm", "week", 4).filter((p) => p.value > 0);
  return values.map((v, i) => {
    // Metrics that serve this value directly, or a goal that serves it.
    const servingGoals = new Set(goals.filter((g) => (g.tokens.serves ?? "").split(",").includes(v.id)).map((g) => g.id));
    const ms: LivedMetric[] = [];
    for (const [id, r] of reg) {
      if (r.status === "retired") continue;
      const serves = (r.tokens.serves ?? "").split(",");
      if (!serves.includes(v.id) && !serves.some((s) => servingGoals.has(s))) continue;
      const m = c.defs.find((d) => d.id === id);
      if (!m || m.documentary || r.tokens.mode === "documentary") continue;
      const p = pausedBy(ss, m, week);
      const recent = series(c, id, "week", 5).slice(0, 4).map((x) => x.value);
      const v4 = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
      const enough = Number(r.tokens.enough);
      let score: number; let basis: string;
      if (Number.isFinite(enough) && enough > 0) { score = Math.max(1, Math.min(5, Math.round((v4 / enough) * 5 * 10) / 10)); basis = `${fmt(v4, m.unit)} a week against an enough of ${fmt(enough, m.unit)}`; }
      else {
        const b = baseline(weekly(c.points[id] ?? [], m.days, m.avg), week);
        if (b.learning) continue;
        score = v4 < b.lo ? 2 : v4 > b.hi ? 4 : 3;
        basis = `${fmt(v4, m.unit)} a week, your normal ${fmt(b.lo, m.unit)} to ${fmt(b.hi, m.unit)}`;
      }
      ms.push({ id, title: m.title, value: Math.round(v4 * 100) / 100, score, basis, ...(p ? { paused: p.title } : {}) });
    }
    const counted = ms.filter((m) => !m.paused);
    const calmCounts = /peace|calm|serenity|rest|balance/i.test(v.title) && calm.length >= 2;
    const calmScore = calmCounts ? calm.reduce((a, p) => a + p.value, 0) / calm.length : undefined;
    const parts = [...counted.map((m) => m.score), ...(calmScore !== undefined ? [calmScore] : [])];
    const lived = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 10) / 10 : null;
    return { id: v.id, title: v.title, rank: i + 1, matters: Math.max(1, 5 - i), lived, metrics: ms, ...(calmScore !== undefined ? { checkin: Math.round(calmScore * 10) / 10 } : {}), unmeasured: lived === null };
  });
}

export interface Guardrail { metric: string; title: string; guard: string; guard_title: string; state: "holding" | "slipping" | "learning"; text: string }

/** Every target has a guardrail from another value: is the guard holding this week? Lower than normal is slipping (calm, sleep, dinners home). */
export function guardrails(vault: string, c: Computed): Guardrail[] {
  const out: Guardrail[] = [];
  const week = weekOf(addDays(dayOf(c.ts), -7));
  for (const [id, r] of readRegistry(vault)) {
    if (!r.tokens.guard || r.status === "retired") continue;
    const m = c.defs.find((d) => d.id === id);
    const g = c.defs.find((d) => d.id === r.tokens.guard);
    if (!m || !g) continue;
    const by = weekly(c.points[g.id] ?? [], g.days, g.avg);
    const b = baseline(by, week);
    const v = by.get(week) ?? 0;
    const state: Guardrail["state"] = b.learning ? "learning" : v < b.lo ? "slipping" : "holding";
    out.push({ metric: id, title: m.title, guard: g.id, guard_title: g.title, state, text: state === "learning" ? `${g.title} guards ${m.title}; learning its normal.` : state === "slipping" ? `${m.title} is guarded by ${g.title}, and ${g.title} slipped to ${fmt(v, g.unit)} (normal ${fmt(b.lo, g.unit)} to ${fmt(b.hi, g.unit)}).` : `${g.title} is holding while you push ${m.title}.` });
  }
  return out;
}

export function hasCompass(vault: string): boolean { return existsSync(join(vault, "build", "compass.md")); }
