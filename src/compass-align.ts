// Goals G3: alignment and conflicts (goals-plan.md).
//
//   State variables  a small fixed vocabulary, each read from a metric with a
//                    source and a freshness limit (sleep_hours, spend_usd_mo,
//                    checkin.calm ...). The non-negotiables' ~check: predicates
//                    are evaluated against them, in code. Written to
//                    build/_meta/compass/signals.json.
//   The broker       an action that touches a variable a confirmed rule
//                    guards asks first; one that would break a hard limit
//                    (==0, <=0) or a rule already broken is blocked (ruleGate,
//                    called from broker.gateAction). Rules with no variable are
//                    left to the Steward ("judge these yourself").
//   Conflicts        two passes, cached by content hash. Code: resources of
//                    the active paths against Capacity (hours, money, stress),
//                    each path's effects against every other path's needs
//                    (contradiction = interferes, satisfied = enables, shared
//                    = synergy), effects on rule variables against the rules,
//                    and declared value effects. Model (optional): a pair's
//                    relation, where it bites and a resolution, kept only with
//                    a quote. build/_meta/compass/graph.json. A conflict is shown
//                    only with evidence, phrased as a question, and "accepted
//                    tension" is a valid answer (conflicts.jsonl).
//   Jobs             every dispatched job carries serves, costs and rules.
//   Weekly roll-up   matters vs lived, the share of attention each value got
//                    (said vs did), the conflicts, and a Needs You list:
//                    build/_meta/compass/alignment.json.
//
// Path grammar (indented under a path: line in build/compass.md; all optional):
//     hours: 6                       hours a week it takes
//     usd: 300                       dollars a month it takes
//     stress: 2                      stress it adds, 0 to 5
//     needs: home-evenings, cash-buffer      conditions that must stay true
//     effects: away-often, dinners_home_wk-2, cash_months+1   what it changes
//     values: v-peace -1, v-freedom +2       its effect on each value (-2..+2)
// Capacity lines: hours_for_goals_wk: 10 . money_for_goals_mo: 500 . stress_budget: 3

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { compassMetaDir, compassPath, items, readCompass, type CompassDoc, type CompassItem, type CompassPath } from "./compass.ts";
import { resolveDomainDir } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";

// ── State variables ─────────────────────────────────────────────────────────

export interface StateVarDef { id: string; title: string; metric: string | null; agg: "week" | "month" | "year" | "latest-week"; fresh: number; source: string }
export const STATE_VARS: StateVarDef[] = [
  { id: "sleep_hours", title: "Sleep a night", metric: "m-sleep", agg: "latest-week", fresh: 14, source: "Apple Health or Oura" },
  { id: "checkin.calm", title: "Weekly calm", metric: "m-calm", agg: "latest-week", fresh: 21, source: "your weekly check-in" },
  { id: "spend_usd_mo", title: "Spend a month", metric: "m-spend", agg: "month", fresh: 45, source: "card statements or Plaid" },
  { id: "away_days_yr", title: "Days away a year", metric: "m-days-away", agg: "year", fresh: 120, source: "Timeline export" },
  { id: "meeting_hours_wk", title: "Meeting hours a week", metric: "m-meeting-hours", agg: "week", fresh: 14, source: "calendar" },
  { id: "after_hours_wk", title: "After-hours meetings a week", metric: "m-after-hours", agg: "week", fresh: 14, source: "calendar" },
  { id: "family_hours_wk", title: "Family time a week", metric: "m-family-hours", agg: "week", fresh: 14, source: "calendar (inferred)" },
  { id: "workouts_wk", title: "Workouts a week", metric: "m-workouts", agg: "week", fresh: 14, source: "Apple Health, Strava or Garmin" },
  // No source measures these yet: a rule that names one is judged by the Steward.
  { id: "dinners_home_wk", title: "Dinners home a week", metric: null, agg: "week", fresh: 14, source: "not measured yet (calendar and location, or the check-in)" },
  { id: "work_hours_wk", title: "Work hours a week", metric: null, agg: "week", fresh: 14, source: "not measured yet" },
  { id: "new_debt_usd", title: "New debt", metric: null, agg: "month", fresh: 45, source: "not measured yet (Plaid liabilities)" },
  { id: "cash_months", title: "Months of costs in cash", metric: null, agg: "month", fresh: 45, source: "not measured yet (Plaid balances)" },
  { id: "passive_share", title: "Share of costs from passive income", metric: null, agg: "month", fresh: 45, source: "not measured yet (Plaid)" },
];

export interface StateValue { id: string; title: string; value: number | null; source: string; asOf?: string; ageDays?: number; fresh: boolean }
type Points = Record<string, { date: string; value: number }[]>;

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

/** Each variable's value from daily metric points (pure, for tests). */
export function stateFromPoints(points: Points, now = Date.now(), avgMetrics = new Set(["m-sleep", "m-calm"])): StateValue[] {
  const today = ymd(now);
  return STATE_VARS.map((v) => {
    if (!v.metric) return { id: v.id, title: v.title, value: null, source: v.source, fresh: false };
    const pts = (points[v.metric] ?? []).filter((p) => p.date <= today).sort((a, b) => a.date.localeCompare(b.date));
    if (!pts.length) return { id: v.id, title: v.title, value: null, source: v.source, fresh: false };
    const last = pts[pts.length - 1]!;
    const window = v.agg === "year" ? 365 : v.agg === "month" ? 30 : 7;
    const from = ymd(Date.parse(`${last.date}T12:00:00Z`) - (window - 1) * DAY);
    const inWin = pts.filter((p) => p.date >= from && p.date <= last.date);
    const sum = inWin.reduce((a, p) => a + p.value, 0);
    const value = avgMetrics.has(v.metric) ? sum / Math.max(1, inWin.length) : sum;
    const age = daysBetween(last.date, today);
    return { id: v.id, title: v.title, value: Math.round(value * 100) / 100, source: v.source, asOf: last.date, ageDays: age, fresh: age <= v.fresh };
  });
}

const signalsPath = (vault: string) => join(compassMetaDir(vault), "signals.json");

/** Read every variable now (computes metrics) and keep them for the broker. */
export async function stateVariables(vault: string, opts: { now?: number; points?: Points } = {}): Promise<StateValue[]> {
  const now = opts.now ?? Date.now();
  let points = opts.points;
  if (!points) {
    try { const m = await import("./metrics.ts"); points = (await m.computeMetrics(vault, { now })).points; } catch { points = {}; }
  }
  const s = stateFromPoints(points, now);
  try { mkdirSync(compassMetaDir(vault), { recursive: true }); writeFileSync(signalsPath(vault), `${JSON.stringify({ computed: now, vars: s }, null, 2)}\n`); } catch { /* read-only vault */ }
  return s;
}

export function readSignals(vault: string): StateValue[] {
  try { return (JSON.parse(readFileSync(signalsPath(vault), "utf8")) as { vars: StateValue[] }).vars ?? []; } catch { return []; }
}

// ── Rules ───────────────────────────────────────────────────────────────────

export interface Check { variable: string; op: ">=" | "<=" | ">" | "<" | "==" | "!="; n: number }
export function parseCheck(s: string | undefined): Check | null {
  const m = /^([a-z][a-z0-9_.]*)(>=|<=|==|!=|>|<|=)(-?\d+(?:\.\d+)?)$/i.exec((s ?? "").trim());
  if (!m) return null;
  return { variable: m[1]!.toLowerCase(), op: (m[2] === "=" ? "==" : m[2]) as Check["op"], n: Number(m[3]) };
}
export function holds(c: Check, v: number): boolean {
  return c.op === ">=" ? v >= c.n : c.op === "<=" ? v <= c.n : c.op === ">" ? v > c.n : c.op === "<" ? v < c.n : c.op === "==" ? v === c.n : v !== c.n;
}
/** Within a tenth of the line, on the right side: worth watching. */
function near(c: Check, v: number): boolean {
  const room = Math.max(Math.abs(c.n) * 0.1, 0.5);
  return (c.op === ">=" || c.op === ">") ? v - c.n < room : (c.op === "<=" || c.op === "<") ? c.n - v < room : false;
}

export interface RuleState { id: string; title: string; check?: string; state: "ok" | "at-risk" | "broken" | "unchecked"; value?: number | null; detail: string }

const live = (x: { tokens: Record<string, string> }) => x.tokens.status !== "proposed" && x.tokens.status !== "dropped";

export function evaluateRules(doc: CompassDoc, vars: StateValue[]): RuleState[] {
  return items(doc, "rule").filter(live).map((r) => {
    const c = parseCheck(r.tokens.check);
    if (!c) return { id: r.id, title: r.title, state: "unchecked" as const, detail: "no check in code; the Steward judges it" };
    const v = vars.find((x) => x.id === c.variable);
    if (!v || v.value == null) return { id: r.id, title: r.title, check: r.tokens.check, state: "unchecked" as const, value: null, detail: `${c.variable}: ${v?.source ?? "not a known variable"}` };
    const stale = !v.fresh ? `, ${v.ageDays} days old` : "";
    const state = !holds(c, v.value) ? "broken" as const : near(c, v.value) ? "at-risk" as const : "ok" as const;
    return { id: r.id, title: r.title, check: r.tokens.check, state, value: v.value, detail: `${c.variable} ${v.value} (needs ${c.op} ${c.n}), from ${v.source}${stale}` };
  });
}

export async function checkRules(vault: string, opts: { now?: number; points?: Points } = {}): Promise<RuleState[]> {
  if (!existsSync(compassPath(vault))) return [];
  return evaluateRules(readCompass(vault), await stateVariables(vault, opts));
}

// Which variables an action touches. Words, not a model: the broker is code.
const ACTION_VARS: [string, RegExp][] = [
  ["new_debt_usd", /\b(loan|borrow|financ(e|ing)|mortgage|credit card|line of credit|take on debt|lease to own|buy now,? pay later)\b/i],
  ["spend_usd_mo", /\b(buy|purchase|pay|order|subscribe|book)\b/i],
  ["away_days_yr", /\b(book (a |the )?(flight|trip|hotel)|travel to|fly to)\b/i],
  ["dinners_home_wk", /\b(dinner|evening|night)\b.*\b(meeting|call|event|session)\b|\b(meeting|call|event|session)\b.*\b(at|after) (6|7|8|9) ?pm\b/i],
  ["work_hours_wk", /\b(overtime|weekend work|work (on|this) (saturday|sunday)|extra hours)\b/i],
  ["sleep_hours", /\b(red-?eye|all-?nighter|(at|by) (4|5) ?am)\b/i],
  ["meeting_hours_wk", /\b(schedule|accept|book) (a |the )?(meeting|call)\b/i],
];
export function varsTouched(action: string): string[] {
  return ACTION_VARS.filter(([, re]) => re.test(action)).map(([v]) => v);
}

/**
 * The non-negotiables, as a gate. An action that would break a hard limit
 * (a rule of the form x==0 or x<=0, like no new debt) or push a rule that is
 * already broken is blocked; any other action touching a rule's variable asks.
 * Unconfirmed lines never gate anything.
 */
export function ruleGate(vault: string, action: string): { decision: "block" | "ask"; reason: string; rule: string } | null {
  if (!existsSync(compassPath(vault))) return null;
  const touched = varsTouched(action);
  if (!touched.length) return null;
  const doc = readCompass(vault);
  const state = evaluateRules(doc, readSignals(vault));
  let ask: { decision: "ask"; reason: string; rule: string } | null = null;
  for (const r of items(doc, "rule").filter(live)) {
    const c = parseCheck(r.tokens.check);
    if (!c || !touched.includes(c.variable)) continue;
    const hard = (c.op === "==" || c.op === "<=" || c.op === "<") && c.n <= 0;
    const st = state.find((x) => x.id === r.id);
    if (hard || st?.state === "broken") return { decision: "block", reason: `it would break your non-negotiable "${r.title}"${st?.state === "broken" ? ` (already broken: ${st.detail})` : ""}`, rule: r.id };
    ask ??= { decision: "ask", reason: `it touches your non-negotiable "${r.title}"${st && st.value != null ? ` (${st.detail})` : ""}`, rule: r.id };
  }
  return ask;
}

// ── Paths and conflicts (the code pass) ─────────────────────────────────────

export interface PathModel { id: string; title: string; goal: string; goalTitle: string; status: string; hours: number; usd: number; stress: number; needs: string[]; effects: string[]; deltas: { variable: string; delta: number }[]; values: { id: string; effect: number }[] }

const field = (x: { fields: { key: string; value: string }[] }, k: string) => x.fields.find((f) => f.key.toLowerCase() === k)?.value;
const num = (s: string | undefined) => { const n = Number(String(s ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : 0; };
const tags = (s: string | undefined) => (s ?? "").split(/[,;]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean);

export function pathModel(p: CompassPath, g: CompassItem): PathModel {
  const effects: string[] = [];
  const deltas: PathModel["deltas"] = [];
  for (const t of tags(field(p, "effects"))) {
    const d = /^([a-z][a-z0-9_.]*)([+-]\d+(?:\.\d+)?)$/.exec(t);
    if (d) deltas.push({ variable: d[1]!, delta: Number(d[2]) }); else effects.push(t);
  }
  const values = (field(p, "values") ?? "").split(",").map((x) => /^\s*([a-z][a-z0-9-]*)\s*([+-]?\d)\s*$/i.exec(x)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ id: m[1]!.toLowerCase(), effect: Math.max(-2, Math.min(2, Number(m[2]))) }));
  return { id: p.id, title: p.title, goal: g.id, goalTitle: g.title, status: p.tokens.status ?? "proposed", hours: num(field(p, "hours")), usd: num(field(p, "usd")), stress: num(field(p, "stress")), needs: tags(field(p, "needs")), effects, deltas, values };
}

/** Paths that count: chosen and in trial (the user's), from goals that are live. */
export function activePaths(doc: CompassDoc, include: string[] = ["chosen", "trial"]): PathModel[] {
  const out: PathModel[] = [];
  for (const g of items(doc, "goal").filter(live)) {
    const st = g.tokens.status ?? "active";
    if (["achieved", "released", "paused"].includes(st)) continue;
    for (const p of g.paths) { const m = pathModel(p, g); if (include.includes(m.status)) out.push(m); }
  }
  return out;
}

export function capacityOf(doc: CompassDoc): { hours?: number; usd?: number; stress?: number } {
  const out: { hours?: number; usd?: number; stress?: number } = {};
  for (const c of items(doc, "capacity")) {
    const m = /^([a-z_]+)\s*:\s*(-?\d+(?:\.\d+)?)/i.exec(c.title);
    if (!m) continue;
    const k = m[1]!.toLowerCase();
    if (k.startsWith("hours")) out.hours = Number(m[2]); else if (k.startsWith("money") || k.startsWith("usd")) out.usd = Number(m[2]); else if (k.startsWith("stress")) out.stress = Number(m[2]);
  }
  return out;
}

// Two conditions that cannot both hold. "x" and "no-x"; "home-x" and "away-x";
// and a few that mean being somewhere else.
const OPPOSITE: [string, string][] = [["away-often", "home-evenings"], ["away-often", "home-most-nights"], ["away-often", "present-on-land"], ["travel-often", "present-on-land"], ["travel-often", "home-most-nights"], ["long-hours", "home-evenings"], ["long-hours", "rest"], ["relocate", "stay-put"], ["spend-savings", "cash-buffer"], ["new-debt", "debt-free"]];
export function opposed(a: string, b: string): boolean {
  if (a === `no-${b}` || b === `no-${a}` || a === `not-${b}` || b === `not-${a}`) return true;
  const [pa, ra] = [/^(home|away)-(.+)$/.exec(a), /^(home|away)-(.+)$/.exec(b)];
  if (pa && ra && pa[2] === ra[2] && pa[1] !== ra[1]) return true;
  return OPPOSITE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export type Rel = "interferes" | "enables" | "synergy" | "competes" | "breaks";
export interface Edge { from: string; to: string; rel: Rel; weight: number; when?: string; evidence: string[]; confidence: number; asserted_by: "code" | "model" }
export interface Conflict { key: string; kind: "resource" | "presence" | "rule" | "value" | "model"; a: string; b: string; aTitle: string; bTitle: string; question: string; evidence: string[]; confidence: number; asserted_by: "code" | "model" }

const ckey = (kind: string, ids: string[]) => `${kind}:${[...ids].sort().join("|")}`;

/**
 * The code pass over the Compass. Pure: the same file and signals give the
 * same conflicts and synergies.
 */
export function detect(doc: CompassDoc, vars: StateValue[] = []): { conflicts: Conflict[]; edges: Edge[] } {
  const paths = activePaths(doc);
  const conflicts: Conflict[] = [];
  const edges: Edge[] = [];
  const cap = capacityOf(doc);
  const values = new Map(items(doc, "value").filter(live).map((v) => [v.id, v.title]));
  // 1. Resources against capacity.
  const res: [keyof typeof cap, "hours" | "usd" | "stress", string, string][] = [["hours", "hours", "hours a week", "hours_for_goals_wk"], ["usd", "usd", "dollars a month", "money_for_goals_mo"], ["stress", "stress", "stress", "stress_budget"]];
  for (const [ck, pk, unit, capName] of res) {
    const limit = cap[ck];
    const using = paths.filter((p) => p[pk] > 0);
    const total = using.reduce((a, p) => a + p[pk], 0);
    if (limit == null || using.length < 2 || total <= limit) continue;
    using.sort((a, b) => b[pk] - a[pk]);
    const [a, b] = [using[0]!, using[1]!];
    conflicts.push({ key: ckey("resource", [a.id, b.id, pk]), kind: "resource", a: a.id, b: b.id, aTitle: a.title, bTitle: b.title, confidence: 0.9, asserted_by: "code",
      evidence: [...using.map((p) => `${p.title}: ${p[pk]} ${unit}`), `Your capacity: ${capName} ${limit}; together ${Math.round(total * 10) / 10}`],
      question: `${using.map((p) => p.title).join(" and ")} together take ${Math.round(total * 10) / 10} ${unit}; your capacity is ${limit}. Keep all, trim one, or accept the tension?` });
    edges.push({ from: a.id, to: b.id, rel: "competes", weight: -1, when: `${unit} over ${limit}`, evidence: [`together ${total} ${unit}`], confidence: 0.9, asserted_by: "code" });
  }
  // 2. Effects against needs (presence, money, any condition).
  for (const a of paths) for (const b of paths) {
    if (a.id === b.id) continue;
    for (const e of a.effects) for (const n of b.needs) {
      if (opposed(e, n)) {
        const k = ckey("presence", [a.id, b.id]);
        if (!conflicts.some((c) => c.key === k)) conflicts.push({ key: k, kind: "presence", a: a.id, b: b.id, aTitle: a.title, bTitle: b.title, confidence: 0.8, asserted_by: "code", evidence: [`${a.title} means ${e.replace(/-/g, " ")}`, `${b.title} needs ${n.replace(/-/g, " ")}`], question: `${a.title} means ${e.replace(/-/g, " ")}, but ${b.title} needs ${n.replace(/-/g, " ")}. Do them in sequence, change one, or accept the tension?` });
        edges.push({ from: a.id, to: b.id, rel: "interferes", weight: -1, when: `${e} vs ${n}`, evidence: [e, n], confidence: 0.8, asserted_by: "code" });
      } else if (e === n) {
        edges.push({ from: a.id, to: b.id, rel: "enables", weight: 1, evidence: [`${a.title} gives ${e}, which ${b.title} needs`], confidence: 0.8, asserted_by: "code" });
      }
    }
    if (a.id < b.id) {
      const shared = a.effects.filter((x) => b.effects.includes(x)).concat(a.values.filter((x) => x.effect > 0 && b.values.some((y) => y.id === x.id && y.effect > 0)).map((x) => `+${values.get(x.id) ?? x.id}`));
      if (shared.length) edges.push({ from: a.id, to: b.id, rel: "synergy", weight: 1, evidence: shared, confidence: 0.7, asserted_by: "code" });
    }
  }
  // 3. Effects on a rule's variable against the rule.
  for (const r of items(doc, "rule").filter(live)) {
    const c = parseCheck(r.tokens.check);
    if (!c) continue;
    const cur = vars.find((v) => v.id === c.variable)?.value ?? null;
    for (const p of paths) {
      for (const d of p.deltas.filter((x) => x.variable === c.variable)) {
        const after = cur == null ? null : cur + d.delta;
        const wrongWay = ((c.op === ">=" || c.op === ">") && d.delta < 0) || ((c.op === "<=" || c.op === "<" || c.op === "==") && d.delta > 0);
        const breaks = after != null ? !holds(c, after) : wrongWay;
        if (!breaks) continue;
        conflicts.push({ key: ckey("rule", [p.id, r.id]), kind: "rule", a: p.id, b: r.id, aTitle: p.title, bTitle: r.title, confidence: after != null ? 0.9 : 0.6, asserted_by: "code",
          evidence: [`${p.title} changes ${c.variable} by ${d.delta > 0 ? "+" : ""}${d.delta}`, cur != null ? `now ${cur}, after ${after}; the rule needs ${c.op} ${c.n}` : `the rule needs ${c.op} ${c.n} (no reading yet)`],
          question: `${p.title} would break "${r.title}". See options: change the path, or is the rule not as hard as written?` });
        edges.push({ from: p.id, to: r.id, rel: "breaks", weight: -2, when: `${c.variable} ${c.op} ${c.n}`, evidence: [`${c.variable} ${d.delta}`], confidence: 0.8, asserted_by: "code" });
      }
    }
  }
  // 4. Declared value effects: a path that costs a value another path (or the goal it serves) is for.
  for (const p of paths) {
    for (const v of p.values.filter((x) => x.effect <= -1 && values.has(x.id))) {
      const helper = paths.find((q) => q.id !== p.id && q.values.some((y) => y.id === v.id && y.effect > 0));
      const goalServes = items(doc, "goal").some((g) => g.id === p.goal && (g.tokens.serves ?? "").split(",").includes(v.id));
      if (!helper && !goalServes && v.effect > -2) continue;
      const other = helper ? { id: helper.id, title: helper.title } : { id: v.id, title: values.get(v.id)! };
      conflicts.push({ key: ckey("value", [p.id, other.id, v.id]), kind: "value", a: p.id, b: other.id, aTitle: p.title, bTitle: other.title, confidence: 0.7, asserted_by: "code",
        evidence: [`${p.title}: ${values.get(v.id)} ${v.effect}`, ...(helper ? [`${helper.title}: ${values.get(v.id)} +${helper.values.find((y) => y.id === v.id)!.effect}`] : goalServes ? [`${p.goalTitle} is meant to serve ${values.get(v.id)}`] : [])],
        question: helper ? `${p.title} costs ${values.get(v.id)} while ${helper.title} builds it. Worth keeping both, or swap one?` : `${p.title} costs ${values.get(v.id)}${goalServes ? `, the value its own goal is for` : ""}. Is there a path that gets there without that?` });
      edges.push({ from: p.id, to: v.id, rel: "interferes", weight: v.effect, evidence: [`${values.get(v.id)} ${v.effect}`], confidence: 0.7, asserted_by: "code" });
    }
  }
  return { conflicts, edges };
}

// ── The model pass (optional), cached by content hash ───────────────────────

export type Runner = (prompt: string) => Promise<string>;

export function pairPrompt(a: { id: string; title: string; text: string }, b: { id: string; title: string; text: string }): string {
  return [
    "Two parts of one person's Compass (their own words). Is there a real tension or a synergy between them?",
    `A (${a.id}): ${a.title}\n${a.text}`,
    `B (${b.id}): ${b.title}\n${b.text}`,
    'Reply with JSON only: { "relation": "++" | "+" | "0" | "-" | "--", "when": "<the boundary condition where it bites, or empty>", "evidence": "<a short quote from A or B that shows it>", "resolution": "<one way to weaken the tension, or empty>" }',
    "Answer 0 unless the words themselves show it. Never invent facts about the person.",
  ].join("\n\n");
}

const graphPath = (vault: string) => join(compassMetaDir(vault), "graph.json");
interface GraphFile { computed: number; hash: string; edges: Edge[]; conflicts: Conflict[]; model: Record<string, { rel: string; when?: string; evidence?: string; resolution?: string }> }

export function readGraph(vault: string): GraphFile | null {
  try { return JSON.parse(readFileSync(graphPath(vault), "utf8")) as GraphFile; } catch { return null; }
}

/**
 * A model's evidence counts only when it quotes the file: every "quoted"
 * fragment it gives (8+ characters) must appear verbatim; evidence with no
 * quote marks must appear whole.
 */
export function quotedInFile(evidence: string | undefined, file: string): boolean {
  if (!evidence?.trim()) return false;
  const low = file.toLowerCase().replace(/[“”]/g, '"');
  const frags = [...evidence.replace(/[“”]/g, '"').matchAll(/"([^"]{8,})"/g)].map((m) => m[1]!.trim().toLowerCase());
  if (frags.length) return frags.every((f) => low.includes(f));
  return low.includes(evidence.trim().toLowerCase().slice(0, 80));
}

const itemText = (it: CompassItem) => [it.title, ...it.fields.map((f) => `${f.key}: ${f.value}`), ...it.paths.map((p) => `path: ${p.title}`)].join("\n").slice(0, 600);

/**
 * Detect conflicts. The code pass always runs; with a runner the model looks
 * at each pair of live goals (at most 15 pairs), and a pair's answer is reused
 * while neither text changes. A model edge counts only with a quote that is in
 * the file.
 */
export async function computeGraph(vault: string, opts: { now?: number; runner?: Runner | null; vars?: StateValue[] } = {}): Promise<GraphFile> {
  const now = opts.now ?? Date.now();
  const raw = existsSync(compassPath(vault)) ? readFileSync(compassPath(vault), "utf8") : "";
  const doc = readCompass(vault);
  const vars = opts.vars ?? readSignals(vault);
  const hash = createHash("sha1").update(raw).update(JSON.stringify(vars.map((v) => [v.id, v.value]))).digest("hex").slice(0, 16);
  const prev = readGraph(vault);
  const { conflicts, edges } = detect(doc, vars);
  const model: GraphFile["model"] = { ...(prev?.model ?? {}) };
  // Cached answers keep counting without a runner; a runner fills in new pairs.
  if (opts.runner || Object.keys(model).length) {
    const goals = items(doc, "goal").filter(live).filter((g) => !["achieved", "released"].includes(g.tokens.status ?? "active"));
    let pairs = 0;
    for (let i = 0; i < goals.length && pairs < 15; i++) for (let j = i + 1; j < goals.length && pairs < 15; j++) {
      const a = goals[i]!; const b = goals[j]!;
      const k = createHash("sha1").update(itemText(a)).update("\n--\n").update(itemText(b)).digest("hex").slice(0, 16);
      pairs++;
      if (!model[k]) {
        if (!opts.runner) continue;
        try {
          const r = await opts.runner!(pairPrompt({ id: a.id, title: a.title, text: itemText(a) }, { id: b.id, title: b.title, text: itemText(b) }));
          const j0 = r.indexOf("{"); const j1 = r.lastIndexOf("}");
          const o = JSON.parse(r.slice(j0, j1 + 1)) as { relation?: string; when?: string; evidence?: string; resolution?: string };
          model[k] = { rel: String(o.relation ?? "0"), ...(o.when ? { when: String(o.when).slice(0, 200) } : {}), ...(o.evidence ? { evidence: String(o.evidence).slice(0, 240) } : {}), ...(o.resolution ? { resolution: String(o.resolution).slice(0, 240) } : {}) };
        } catch { continue; }
      }
      const m = model[k]!;
      const quoted = quotedInFile(m.evidence, raw);
      if (!quoted) continue; // no quote, no conflict
      if (m.rel === "-" || m.rel === "--") {
        const tidy = (x?: string) => (x ?? "").trim().replace(/[.\s]+$/, "").replace(/^(when|if)\s+/i, "").replace(/^\w/, (ch) => ch.toLowerCase());
        const when = tidy(m.when);
        const ev = /"/.test(m.evidence!) ? m.evidence! : `"${m.evidence}"`;
        conflicts.push({ key: ckey("model", [a.id, b.id]), kind: "model", a: a.id, b: b.id, aTitle: a.title, bTitle: b.title, confidence: m.rel === "--" ? 0.7 : 0.5, asserted_by: "model", evidence: [ev, ...(when ? [`when ${when}`] : [])], question: `${a.title} and ${b.title} may pull against each other${when ? ` when ${when}` : ""}.${m.resolution ? ` One way: ${tidy(m.resolution).replace(/^\w/, (ch) => ch.toUpperCase())}.` : ""} Is that real for you?` });
        edges.push({ from: a.id, to: b.id, rel: "interferes", weight: m.rel === "--" ? -2 : -1, ...(m.when ? { when: m.when } : {}), evidence: [m.evidence!], confidence: 0.5, asserted_by: "model" });
      } else if (m.rel === "+" || m.rel === "++") {
        edges.push({ from: a.id, to: b.id, rel: "synergy", weight: m.rel === "++" ? 2 : 1, evidence: [m.evidence!], confidence: 0.5, asserted_by: "model" });
      }
    }
  }
  const g: GraphFile = { computed: now, hash, edges, conflicts, model };
  try { mkdirSync(compassMetaDir(vault), { recursive: true }); writeFileSync(graphPath(vault), `${JSON.stringify(g, null, 2)}\n`); } catch { /* read-only */ }
  return g;
}

// Answers: a conflict can stay open, be an accepted tension, or be resolved.
const answersPath = (vault: string) => join(compassMetaDir(vault), "conflicts.jsonl");
export type ConflictAnswer = "accepted" | "resolved" | "reopen";
export function answerConflict(vault: string, key: string, answer: ConflictAnswer, note = "", now = Date.now()): void {
  mkdirSync(compassMetaDir(vault), { recursive: true });
  appendFileSync(answersPath(vault), `${JSON.stringify({ ts: now, key, answer, ...(note ? { note: note.slice(0, 300) } : {}) })}\n`);
}
export function conflictAnswers(vault: string): Map<string, ConflictAnswer> {
  const m = new Map<string, ConflictAnswer>();
  try { for (const l of readFileSync(answersPath(vault), "utf8").split("\n")) { if (!l.trim()) continue; const r = JSON.parse(l) as { key: string; answer: ConflictAnswer }; m.set(r.key, r.answer); } } catch { /* none */ }
  return m;
}
/** Open conflicts, strongest first (accepted and resolved ones are kept out). */
export function openConflicts(vault: string, g = readGraph(vault)): Conflict[] {
  const ans = conflictAnswers(vault);
  return (g?.conflicts ?? []).filter((c) => { const a = ans.get(c.key); return !a || a === "reopen"; }).sort((a, b) => b.confidence - a.confidence);
}

// ── Jobs: serves, costs, rules ──────────────────────────────────────────────

export interface JobCompass { serves: { id: string; title: string }[]; costs: { id: string; title: string; why: string }[]; rules: { id: string; title: string; state: RuleState["state"] }[] }

/**
 * What a job serves (the Compass goal that lives in its owner domain, and the
 * values that goal serves), what it may cost (values the graph says that
 * goal's paths interfere with) and the rules it touches (by the words of the
 * ask), with their state.
 */
export function jobCompass(vault: string, job: { ask: string; domains: { owner: string; consulted: string[] } }, missionGoal?: string): JobCompass {
  const out: JobCompass = { serves: [], costs: [], rules: [] };
  if (!existsSync(compassPath(vault))) return out;
  const doc = readCompass(vault);
  const values = new Map(items(doc, "value").filter(live).map((v) => [v.id, v.title]));
  const goals = items(doc, "goal").filter(live).filter((g) => (missionGoal ? g.id === missionGoal : g.tokens.domain === job.domains.owner) && !["released", "achieved"].includes(g.tokens.status ?? "active"));
  for (const g of goals.slice(0, 2)) {
    out.serves.push({ id: g.id, title: g.title });
    for (const v of (g.tokens.serves ?? "").split(",").filter((x) => values.has(x))) if (!out.serves.some((s) => s.id === v)) out.serves.push({ id: v, title: values.get(v)! });
  }
  const g = readGraph(vault);
  const mine = new Set(goals.flatMap((x) => [x.id, ...x.paths.map((p) => p.id)]));
  for (const e of g?.edges ?? []) {
    if (!mine.has(e.from) || (e.rel !== "interferes" && e.rel !== "breaks")) continue;
    const t = values.get(e.to) ?? items(doc, "rule").find((r) => r.id === e.to)?.title;
    if (t && !out.costs.some((c) => c.id === e.to)) out.costs.push({ id: e.to, title: t, why: e.evidence[0] ?? e.when ?? "" });
  }
  const touched = varsTouched(job.ask);
  const state = evaluateRules(doc, readSignals(vault));
  for (const r of items(doc, "rule").filter(live)) {
    const c = parseCheck(r.tokens.check);
    if (c && touched.includes(c.variable)) out.rules.push({ id: r.id, title: r.title, state: state.find((x) => x.id === r.id)?.state ?? "unchecked" });
  }
  return out;
}

// ── The weekly roll-up and Needs You ────────────────────────────────────────

export interface Rollup {
  week: string; computed: number;
  values: { id: string; title: string; rank: number; matters: number; lived: number | null; attention: number; unmeasured: boolean }[];
  saidVsDid: string[];
  conflicts: Conflict[];
  rules: RuleState[];
  needsYou: { kind: "conflict" | "rule" | "stalled" | "woop"; key: string; text: string }[];
}

/** How much of the last 28 days' activity happened in a domain (threads, tasks, notes touched). */
export function attentionByDomain(vault: string, domains: string[], now = Date.now()): Map<string, number> {
  const since = now - 28 * DAY;
  const out = new Map<string, number>();
  for (const d of domains) {
    const dir = resolveDomainDir(vault, d);
    let n = 0;
    for (const rel of ["memory/threads", "memory/tasks.md", "_tasks.md", "memory/updates.jsonl", "memory/decisions.jsonl", "memory/touches.jsonl", "memory/memory.md"]) {
      try { if (statSync(join(dir, rel)).mtimeMs >= since) n++; } catch { /* absent */ }
    }
    try { for (const l of readFileSync(join(dir, "memory", "touches.jsonl"), "utf8").split("\n").slice(-400)) { try { if ((JSON.parse(l) as { ts: number }).ts >= since) n++; } catch { /* torn */ } } } catch { /* none */ }
    out.set(d, n);
  }
  return out;
}

export async function alignmentRollup(vault: string, opts: { now?: number; runner?: Runner | null } = {}): Promise<Rollup> {
  const now = opts.now ?? Date.now();
  const m = await import("./metrics.ts");
  const q = await import("./qualitative.ts");
  const c = await m.computeMetrics(vault, { now });
  const vars = await stateVariables(vault, { now, points: c.points });
  const graph = await computeGraph(vault, { now, runner: opts.runner ?? null, vars });
  const doc = readCompass(vault);
  const lived = q.mattersVsLived(vault, c);
  // Attention: each value's share of the activity in the domains its goals live in.
  const goals = items(doc, "goal").filter(live);
  const byValue = new Map<string, Set<string>>();
  for (const g of goals) for (const v of (g.tokens.serves ?? "").split(",").filter(Boolean)) if (g.tokens.domain) (byValue.get(v) ?? byValue.set(v, new Set()).get(v)!).add(g.tokens.domain);
  const allDomains = [...new Set([...byValue.values()].flatMap((s) => [...s]))];
  const att = attentionByDomain(vault, allDomains, now);
  const total = [...att.values()].reduce((a, b) => a + b, 0) || 1;
  const values = lived.map((v) => ({ id: v.id, title: v.title, rank: v.rank, matters: v.matters, lived: v.lived, unmeasured: v.unmeasured, attention: Math.round(([...(byValue.get(v.id) ?? [])].reduce((a, d) => a + (att.get(d) ?? 0), 0) / total) * 100) }));
  const saidVsDid: string[] = [];
  for (const v of values.slice(0, 3)) if (allDomains.length && v.attention < 10) saidVsDid.push(`You rank ${v.title} ${v.rank === 1 ? "first" : `number ${v.rank}`}; it touched ${v.attention}% of this month's activity.`);
  for (const v of values) if (v.lived != null && v.matters - v.lived >= 2) saidVsDid.push(`${v.title} matters ${v.matters} of 5 and was lived ${v.lived} of 5.`);
  const rules = evaluateRules(doc, vars);
  const conflicts = openConflicts(vault, graph);
  const needsYou: Rollup["needsYou"] = [];
  for (const r of rules.filter((x) => x.state === "broken" || x.state === "at-risk")) needsYou.push({ kind: "rule", key: `rule:${r.id}`, text: `${r.title}: ${r.state === "broken" ? "broken" : "at risk"} (${r.detail})` });
  for (const k of conflicts.slice(0, 3)) needsYou.push({ kind: "conflict", key: k.key, text: k.question });
  try {
    const { lastActivity } = await import("./review.ts");
    for (const g of goals.filter((x) => ["active", "confirmed", "prototyping"].includes(x.tokens.status ?? "active") && x.tokens.domain)) {
      if (lastActivity(vault, g.tokens.domain!) < now - 42 * DAY) needsYou.push({ kind: "stalled", key: `stalled:${g.id}`, text: `${g.title}: quiet for six weeks. Keep, pause or let go?` });
    }
  } catch { /* review not loaded */ }
  try { const { goalsNeedingWoop } = await import("./compass.ts"); for (const g of goalsNeedingWoop(vault).slice(0, 2)) needsYou.push({ kind: "woop", key: `woop:${g.id}`, text: `${g.title} needs its plan before it goes active.` }); } catch { /* none */ }
  const r: Rollup = { week: m.weekOf(m.dayOf(now)), computed: now, values, saidVsDid: saidVsDid.slice(0, 4), conflicts, rules, needsYou };
  try { writeFileSync(join(compassMetaDir(vault), "alignment.json"), `${JSON.stringify(r, null, 2)}\n`); } catch { /* read-only */ }
  return r;
}

export function readRollup(vault: string): Rollup | null {
  try { return JSON.parse(readFileSync(join(compassMetaDir(vault), "alignment.json"), "utf8")) as Rollup; } catch { return null; }
}

/** The one line the weekly card carries: the strongest open conflict, with evidence, as a question. */
export function conflictLine(vault: string): { text: string; key?: string; evidence?: string[] } {
  const c = openConflicts(vault)[0];
  if (!c) return { text: "No conflict with evidence this week." };
  return { text: c.question, key: c.key, evidence: c.evidence };
}

// ── CLI: prevail compass rules|signals|conflicts|conflict <key> accept|resolved|reopen|align ──

export async function alignCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const runner = async (): Promise<Runner | null> => {
    if (!args.has("model")) return null;
    const { detectClis, runChatTurn, defaultModelFor } = await import("./cli-bridge.ts");
    const clis = await detectClis();
    const cli = clis.find((c) => c.kind === "claude") ?? clis[0];
    if (!cli) return null;
    const cwd = resolveDomainDir(vault, "general");
    return (prompt) => runChatTurn({ prompt, cwd, cli, model: defaultModelFor(cli.kind), isFirst: true, bare: true });
  };
  if (sub === "signals") { const s = await stateVariables(vault); if (args.json) out(s); else for (const v of s) console.log(`${v.id.padEnd(18)} ${v.value ?? "-"}  ${v.source}${v.asOf ? `, ${v.asOf}` : ""}`); return 0; }
  if (sub === "rules") { const r = await checkRules(vault); if (args.json) out(r); else for (const x of r) console.log(`${x.state.padEnd(9)} ${x.title}  (${x.detail})`); return 0; }
  if (sub === "conflicts") { const g = await computeGraph(vault, { runner: await runner() }); const open = openConflicts(vault, g); if (args.json) out({ open, edges: g.edges, all: g.conflicts.length }); else for (const c of open) console.log(`${c.kind.padEnd(9)} ${c.question}\n          ${c.evidence.join("; ")}`); return 0; }
  if (sub === "conflict") {
    const key = args.pos[1] ?? ""; const said = args.pos[2] === "accept" ? "accepted" : args.pos[2];
    if (!key || !["accepted", "resolved", "reopen"].includes(said ?? "")) { console.error("usage: prevail compass conflict <key> accept|resolved|reopen"); return 1; }
    answerConflict(vault, key, said as ConflictAnswer, args.get("note") ?? "");
    if (args.json) out({ ok: true }); else console.log("Noted.");
    return 0;
  }
  if (sub === "align") { const r = await alignmentRollup(vault, { runner: await runner() }); if (args.json) out(r); else { for (const v of r.values) console.log(`${v.title.padEnd(24)} matters ${v.matters} lived ${v.lived ?? "-"} attention ${v.attention}%`); for (const l of r.saidVsDid) console.log(l); for (const n of r.needsYou) console.log(`Needs you: ${n.text}`); } return 0; }
  console.error("usage: prevail compass signals|rules|conflicts [--model]|conflict <key> accept|resolved|reopen|align [--model] [--json]");
  return 1;
}
