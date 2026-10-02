// Today T3: the radar (today-plan.md section 3). One falling-behind list, owned
// by the Sentinel, combining rules from every plan, each with its evidence and
// lead time, computed by code:
//
//   What slips       Signal                                          Lead time
//   commitments      due within 3 days with no activity; overdue     3 days
//   waiting-fors     no reply past the person's usual reply time      2 days past normal
//   routines         rolling rate below its normal, two misses        after 2 misses
//   relationships    a Yours person not seen for 2x their own cadence 2x normal
//   goals            a Compass goal whose domain is quiet 6 weeks     6 weeks
//   paths            a chosen path missing its expect: line          weekly check
//   admin deadlines  renewals and trials on app records; renewal,    30, 7, 1 days
//                    tax and document tasks
//   domains          gone cold (no change in 30 days, state kept)    per domain
//   decisions        an open decision past its due; a retro owed     at due
//   missions         added by missions (MS4) through `extra`
//
// build/_meta/radar.json holds the current list. Delivery: Today shows at most
// one; the weekly review lists all; only non-negotiables at risk, overdue
// promises to people and broken capture may spend the interruption budget.
//
// Routines live in build/compass.md ## Routines:
//   - Weekly plan on Sunday ~id:rt-x ~cadence:weekly ~serves:v-x ~metric:m-x
// cadence: daily | weekly | monthly | <n>x-week | <n>d. They come from each
// domain ideal's "Habits and routines" section (the user's words, quoted, as
// proposed lines) and from if-then plans on Compass paths.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { addItem, compassId, items, readCompass, saveCompass, type CompassItem } from "./compass.ts";
import { openCommitments, type HeaderLite } from "./commitments.ts";
import { parseCheck, holds } from "./compass-align.ts";
import { listDecisions } from "./decision-records.ts";
import { metricFor } from "./metric-proposals.ts";
import { parseModArgs } from "./cli-args.ts";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / DAY);
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const live = (x: { tokens: Record<string, string> }) => x.tokens.status !== "proposed" && x.tokens.status !== "dropped";

export type RadarKind = "commitment" | "waiting" | "routine" | "relationship" | "goal" | "path" | "admin" | "domain" | "decision" | "mission" | "rule";
export interface RadarItem {
  key: string; kind: RadarKind; domain: string; mission?: string;
  text: string; evidence: string;
  due?: string;            // when it becomes a regret (the promise, the renewal...)
  severity: number;        // 1 low .. 5 high, for ordering
  interrupt?: "overdue-promise" | "non-negotiable" | "broken-capture";
}
export interface Radar { computed: number; items: RadarItem[] }

// ── Routines ────────────────────────────────────────────────────────────────

/** How many a week a cadence expects (weekly 1, daily 7, 3x-week 3, 5d 1.4, monthly 0.25). */
export function perWeek(cadence: string | undefined): number | null {
  const c = (cadence ?? "").toLowerCase();
  if (c === "daily") return 7;
  if (c === "weekly") return 1;
  if (c === "monthly") return 0.25;
  let m = /^(\d+)x-?week$/.exec(c); if (m) return Number(m[1]);
  m = /^(\d+)d$/.exec(c); if (m) return Math.round((7 / Number(m[1])) * 100) / 100;
  return null;
}

export interface RoutineState { id: string; title: string; cadence: string; metric?: string; last4: number[]; met4: number; normalMet: number | null; slipping: boolean; text: string }

/**
 * A routine's rolling rate from its metric's weekly values (newest last): met
 * weeks of the last four against the eight before (its normal). Slipping when
 * the last two weeks both missed and the rate is under the normal (never
 * streaks; a quiet season is a lower normal, not a failure).
 */
export function routineState(r: { id: string; title: string; cadence: string; metric?: string }, weeks: number[]): RoutineState {
  const need = perWeek(r.cadence) ?? 1;
  const met = (v: number) => (need < 1 ? v > 0 : v >= need * 0.999);
  const last4 = weeks.slice(-4);
  const prior = weeks.slice(-12, -4);
  const met4 = last4.filter(met).length;
  const normalMet = prior.length >= 4 ? Math.round((prior.filter(met).length / prior.length) * 4 * 10) / 10 : null;
  const twoMisses = last4.length >= 2 && !met(last4[last4.length - 1]!) && !met(last4[last4.length - 2]!);
  const slipping = twoMisses && (normalMet == null ? met4 <= 1 : met4 < normalMet);
  const unit = r.cadence === "weekly" ? "weeks" : "weeks on target";
  return { ...r, last4, met4, normalMet, slipping, text: `${r.title}: ${met4} of the last ${last4.length} ${unit}${normalMet != null ? ` (normal ${normalMet})` : ""}` };
}

const CADENCE: [RegExp, string][] = [
  [/\b(daily|every day|each day|every morning|every evening|each morning|each night|nightly)\b/i, "daily"],
  [/\b(\d) ?(?:x|times) (?:a|per) week\b/i, "$1x-week"],
  [/\b(weekly|every week|each week|once a week|(on|every) (sun|mon|tues|wednes|thurs|fri|satur)days?)\b/i, "weekly"],
  [/\b(monthly|every month|each month|once a month)\b/i, "monthly"],
];

/** Routine candidates from each domain ideal's "Habits and routines" (sentences with a cadence), in the user's words. */
export function routineCandidates(vault: string): { title: string; cadence: string; quote: string; from: string; metric?: string }[] {
  const out: { title: string; cadence: string; quote: string; from: string; metric?: string }[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const file = join(dataRoot(vault), "domains", d, "ideal-state.md");
    const text = readText(file);
    const m = /^##\s+Habits and routines\s*$/im.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index + m[0].length);
    const body = rest.slice(0, /^##\s/m.exec(rest)?.index ?? rest.length);
    for (const s of body.split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^[-*]\s+/, "").trim()).filter((x) => x.length >= 10 && x.length <= 200)) {
      const hit = CADENCE.find(([re]) => re.test(s));
      if (!hit) continue;
      const cadence = s.replace(hit[0], hit[1]).match(/\b(daily|weekly|monthly|\dx-week)\b/)?.[1] ?? "weekly";
      const metric = metricFor(s);
      out.push({ title: s.replace(/[.!]+$/, "").slice(0, 90), cadence, quote: s, from: `data/domains/${d}/ideal-state.md`, ...(metric ? { metric } : {}) });
    }
  }
  return out;
}

/** Add the candidates to the Compass as proposed Routines lines (quoted; nothing counts until confirmed). */
export function bootstrapRoutines(vault: string, now = Date.now()): { added: string[] } {
  const doc = readCompass(vault);
  const have = new Set(items(doc, "routine").map((r) => r.title.toLowerCase()));
  const added: string[] = [];
  for (const c of routineCandidates(vault)) {
    if (have.has(c.title.toLowerCase())) continue;
    const id = compassId("routine", c.title);
    const it: CompassItem = { kind: "routine", id, title: c.title, done: null, tokens: { cadence: c.cadence, ...(c.metric ? { metric: c.metric } : {}), status: "proposed" }, flags: [], fields: [{ key: "words", value: JSON.stringify(c.quote) }, { key: "from", value: c.from }], paths: [], raw: [] };
    addItem(doc, it);
    have.add(c.title.toLowerCase());
    added.push(id);
  }
  if (added.length) saveCompass(vault, doc, added.map((id) => ({ id, from: "none", to: "proposed", reason: "drafted from a domain's Habits and routines", by: "bootstrap" as const })), now);
  return { added };
}

// ── The radar ───────────────────────────────────────────────────────────────

export interface RadarInputs {
  now?: number;
  headers?: HeaderLite[];
  /** Weekly values by metric id, oldest first (from computeMetrics). */
  weekly?: (metric: string) => number[];
  /** Missions and anything else that adds its own rules (MS4). */
  extra?: RadarItem[];
}

/** Each person's usual reply time from the user's own threads (median hours), keyed by address. */
function replyHours(hs: HeaderLite[]): Map<string, number> {
  const by = new Map<string, number[]>();
  const threads = new Map<string, HeaderLite[]>();
  for (const h of hs) (threads.get(h.thread) ?? threads.set(h.thread, []).get(h.thread)!).push(h);
  for (const t of threads.values()) {
    t.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < t.length; i++) if (t[i - 1]!.dir === "sent" && t[i]!.dir === "received") {
      const who = t[i]!.from;
      (by.get(who) ?? by.set(who, []).get(who)!).push((t[i]!.ts - t[i - 1]!.ts) / 3_600_000);
    }
  }
  const out = new Map<string, number>();
  for (const [k, v] of by) { const s = v.sort((a, b) => a - b); out.set(k, s[Math.floor(s.length / 2)]!); }
  return out;
}

export function computeRadarSync(vault: string, i: RadarInputs = {}): Radar {
  const now = i.now ?? Date.now();
  const today = ymd(now);
  const hs = i.headers ?? [];
  const out: RadarItem[] = [];
  // Commitments and waiting-fors on the boards.
  for (const c of openCommitments(vault, now, hs)) {
    if (!c.slipping) continue;
    const overdue = !!c.due && c.due < today;
    out.push({ key: `commitment:${c.domain}:${c.id ?? c.text.slice(0, 40)}`, kind: c.kind === "waiting" ? "waiting" : "commitment", domain: c.domain, text: c.text, evidence: `${c.why}${c.person ? `, ${c.kind === "waiting" ? "from" : "to"} ${c.person.replace(/^person\//, "")}` : ""}`, ...(c.due ? { due: c.due } : {}), severity: overdue ? (c.kind === "commitment" ? 5 : 3) : 4, ...(overdue && c.kind === "commitment" && c.person ? { interrupt: "overdue-promise" as const } : {}) });
  }
  // Waiting-fors from mail: a question with no answer past that person's normal, plus two days.
  const normal = replyHours(hs);
  const threads = new Map<string, HeaderLite[]>();
  for (const h of hs) (threads.get(h.thread) ?? threads.set(h.thread, []).get(h.thread)!).push(h);
  for (const t of threads.values()) {
    t.sort((a, b) => a.ts - b.ts);
    const last = t[t.length - 1]!;
    if (last.dir !== "sent" || !last.asks || !last.to[0] || last.ts < now - 45 * DAY) continue;
    const usualH = normal.get(last.to[0]) ?? 72;
    const waitedH = (now - last.ts) / 3_600_000;
    if (waitedH < usualH + 48) continue;
    out.push({ key: `waiting:mail:${last.thread}`, kind: "waiting", domain: "general", text: `An answer from ${last.to[0].split("@")[0]} on "${last.subject.slice(0, 80)}"`, evidence: `asked ${Math.round(waitedH / 24)} days ago; they usually answer in ${usualH < 48 ? `${Math.round(usualH)} hours` : `${Math.round(usualH / 24)} days`}`, severity: 3 });
  }
  // Routines (confirmed lines with a metric).
  const doc = readCompass(vault);
  if (i.weekly) {
    for (const r of items(doc, "routine").filter(live)) {
      if (!r.tokens.metric || !perWeek(r.tokens.cadence)) continue;
      const st = routineState({ id: r.id, title: r.title, cadence: r.tokens.cadence!, metric: r.tokens.metric }, i.weekly(r.tokens.metric));
      if (st.slipping) out.push({ key: `routine:${r.id}`, kind: "routine", domain: "general", text: r.title, evidence: st.text, severity: 3 });
    }
  }
  // Paths: a chosen path whose expect: line is a metric predicate it is missing (last four weeks' average).
  if (i.weekly) {
    for (const g of items(doc, "goal").filter(live)) for (const p of g.paths.filter((x) => x.tokens.status === "chosen")) {
      for (const f of p.fields.filter((x) => x.key === "expect")) for (const part of f.value.split(/[;,]/)) {
        const c = parseCheck(part.trim().replace(/\s+/g, ""));
        if (!c || !c.variable.startsWith("m-")) continue;
        const w = i.weekly(c.variable).slice(-4);
        if (w.length < 2) continue;
        const avg = w.reduce((a, b) => a + b, 0) / w.length;
        if (!holds(c, avg)) out.push({ key: `path:${p.id}:${c.variable}`, kind: "path", domain: g.tokens.domain ?? "general", text: `${p.title} is missing what you expected`, evidence: `${c.variable} averages ${Math.round(avg * 10) / 10} a week over ${w.length} weeks; expected ${c.op} ${c.n}`, severity: 3 });
      }
    }
  }
  // Goals gone quiet six weeks (the domain they live in).
  for (const g of items(doc, "goal").filter(live)) {
    const st = g.tokens.status ?? "active";
    if (!["active", "confirmed", "prototyping"].includes(st) || !g.tokens.domain) continue;
    const last = lastTouched(vault, g.tokens.domain);
    if (last && last < now - 42 * DAY) out.push({ key: `goal:${g.id}`, kind: "goal", domain: g.tokens.domain, text: `${g.title} has gone quiet`, evidence: `nothing in ${g.tokens.domain} since ${ymd(last)}`, severity: 2 });
  }
  // Relationships: a Yours person not seen for twice their own cadence.
  for (const p of relationships(vault, now, hs)) out.push(p);
  // Admin deadlines: renewals and trials on app records, and dated renewal-like tasks.
  for (const a of adminDeadlines(vault, now)) out.push(a);
  // Domains gone cold: a domain with a state but no change for 30 days (the watcher's rule).
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const dir = resolveDomainDir(vault, d);
    if (!existsSync(join(dir, "memory", "state.md"))) continue;
    const last = lastTouched(vault, d);
    if (last && last < now - 30 * DAY && last > now - 365 * DAY) out.push({ key: `domain:${d}`, kind: "domain", domain: d, text: `${label(d)} has gone cold`, evidence: `no chat, task or note since ${ymd(last)}`, severity: 1 });
  }
  // Decisions: past due and still open, or a retro owed.
  for (const r of decisionRows(vault)) {
    if (r.status !== "decided" && r.due && r.due < today) out.push({ key: `decision:${r.domain}:${r.slug}`, kind: "decision", domain: r.domain, text: `Decide: ${r.question}`, evidence: `due ${r.due}, still open`, due: r.due, severity: 3 });
    if (r.status === "decided" && r.retroDue && r.retroDue <= today && !r.retroRight) out.push({ key: `retro:${r.domain}:${r.slug}`, kind: "decision", domain: r.domain, text: `How did "${r.question}" turn out?`, evidence: `the 90-day retro was due ${r.retroDue}`, severity: 1 });
  }
  out.push(...(i.extra ?? []));
  const seen = new Set<string>();
  const items_ = out.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true))).sort((a, b) => b.severity - a.severity || (a.due ?? "9").localeCompare(b.due ?? "9"));
  return { computed: now, items: items_ };
}

const label = (slug: string) => slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

function decisionRows(vault: string) {
  try { return listDecisions(vault, { all: true }); } catch { return []; }
}

/** The last time anything the user did touched a domain (threads, board, notes, decisions). */
export function lastTouched(vault: string, domain: string): number {
  const dir = resolveDomainDir(vault, domain);
  let t = 0;
  for (const rel of ["memory/threads", "memory/tasks.md", "_tasks.md", "memory/updates.jsonl", "memory/decisions.jsonl", "memory/memory.md", "source/goals.md"]) {
    try { t = Math.max(t, statSync(join(dir, rel)).mtimeMs); } catch { /* absent */ }
  }
  return t;
}

/** Yours people from the entity index: contact days are mentions in the user's words and mail with them. */
export function relationships(vault: string, now: number, hs: HeaderLite[] = []): RadarItem[] {
  const out: RadarItem[] = [];
  let idx: { entities?: { id: string; name: string; kind: string; relation?: string; home_domain?: string; mentions?: { ts: number }[] }[] } = {};
  try { idx = JSON.parse(readText(join(runtimePath(vault, "_meta"), "entities", "index.json"))); } catch { return out; }
  for (const e of idx.entities ?? []) {
    if (e.kind !== "person" || e.relation !== "yours") continue;
    const tokens = e.id.replace(/^person\//, "").split("-").filter((x) => x.length >= 2);
    const dayset = new Set<string>((e.mentions ?? []).map((m) => ymd(m.ts)));
    for (const h of hs) if ([h.from, ...h.to].some((a) => tokens.every((x) => a.includes(x)))) dayset.add(ymd(h.ts));
    const ds = [...dayset].sort();
    if (ds.length < 3) continue;
    const gaps = ds.slice(1).map((d, i) => days(ds[i]!, d)).sort((a, b) => a - b);
    const usual = Math.max(3, gaps[Math.floor(gaps.length / 2)]!);
    const since = days(ds[ds.length - 1]!, ymd(now));
    if (since >= Math.max(14, usual * 2)) out.push({ key: `relationship:${e.id}`, kind: "relationship", domain: e.home_domain ?? "general", text: `${e.name}: ${since} days since you were last in touch`, evidence: `your normal with them is about every ${usual} days (${ds.length} times seen)`, severity: 2 });
  }
  return out;
}

const ADMIN = /\b(renew(al)?|expir(es|y|ation)|insurance|tax(es)?|registration|passport|license|licence|permit|deadline|filing|premium|policy)\b/i;
/** Renewals and trials on app records, and dated admin tasks, at 30, 7 and 1 days. */
export function adminDeadlines(vault: string, now: number): RadarItem[] {
  const out: RadarItem[] = [];
  const today = ymd(now);
  const lead = (due: string) => { const d = days(today, due); return d < 0 ? null : d <= 1 ? 5 : d <= 7 ? 4 : d <= 30 ? 2 : null; };
  const apps = join(dataRoot(vault), "apps");
  if (existsSync(apps)) for (const a of readdirSync(apps)) {
    if (a.startsWith("_")) continue;
    try {
      const m = JSON.parse(readText(join(apps, a, "manifest.json"))) as { name?: string; renewal?: { next: string }; trial?: { ends: string } };
      for (const [what, due] of [["renews", m.renewal?.next], ["trial ends", m.trial?.ends]] as const) {
        if (!due) continue;
        const sev = lead(due);
        if (sev) out.push({ key: `admin:app:${a}:${what}`, kind: "admin", domain: "general", text: `${m.name ?? a} ${what} ${due}`, evidence: `from the ${a} record (${days(today, due)} days)`, due, severity: sev });
      }
    } catch { /* no manifest */ }
  }
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    for (const f of ["memory/tasks.md", "_tasks.md"]) {
      for (const l of readText(join(dataRoot(vault), "domains", d, f)).split("\n")) {
        const m = /^\s*- \[ \]\s+(.*?)\s@(\d{4}-\d{2}-\d{2})/.exec(l);
        if (!m || !ADMIN.test(m[1]!) || /~kind:(commitment|waiting)/.test(l)) continue;
        const sev = lead(m[2]!);
        const id = /~id:(\S+)/.exec(l)?.[1];
        if (sev) out.push({ key: `admin:task:${d}:${id ?? m[1]!.slice(0, 40)}`, kind: "admin", domain: d, text: m[1]!.replace(/\s+[~+]\S+/g, "").slice(0, 120), evidence: `due ${m[2]} (${days(today, m[2]!)} days)`, due: m[2], severity: sev });
      }
    }
  }
  return out;
}

const radarPath = (vault: string) => join(runtimePath(vault, "_meta"), "radar.json");

/** Compute with every source this Mac has (metrics, mail headers, missions) and keep it. */
export async function computeRadar(vault: string, opts: { now?: number } = {}): Promise<Radar> {
  const now = opts.now ?? Date.now();
  let headers: HeaderLite[] = [];
  try { headers = (await import("./source-sync.ts")).readMailHeaders(vault) as HeaderLite[]; } catch { /* none */ }
  let weekly: ((m: string) => number[]) | undefined;
  try {
    const m = await import("./metrics.ts");
    const c = await m.computeMetrics(vault, { now });
    weekly = (id) => { const def = c.defs.find((d) => d.id === id); const w = m.weekly(c.points[id] ?? [], def?.days, def?.avg); return [...w.keys()].sort().slice(0, -1).map((k) => w.get(k) ?? 0); };
  } catch { /* no metrics */ }
  const r = computeRadarSync(vault, { now, headers, weekly, extra: [] });
  try { mkdirSync(runtimePath(vault, "_meta"), { recursive: true }); writeFileSync(radarPath(vault), `${JSON.stringify(r, null, 2)}\n`); } catch { /* read-only */ }
  return r;
}

/** The kept radar, if it is from the last six hours. */
export function readRadar(vault: string, now = Date.now()): Radar | null {
  try { const r = JSON.parse(readText(radarPath(vault))) as Radar; return now - r.computed < 6 * 3_600_000 ? r : null; } catch { return null; }
}

/** Spend the interruption budget only on what may interrupt. Returns what was sent. */
export async function radarInterrupts(vault: string, r: Radar, now = Date.now()): Promise<{ key: string; ok: boolean; why?: string }[]> {
  const { tryInterrupt } = await import("./interruptions.ts");
  const out: { key: string; ok: boolean; why?: string }[] = [];
  for (const x of r.items.filter((y) => y.interrupt)) {
    const t = tryInterrupt(vault, { kind: x.interrupt!, text: `${x.text} (${x.evidence})`, key: x.key }, now);
    out.push({ key: x.key, ok: t.ok, ...(t.why ? { why: t.why } : {}) });
  }
  return out;
}

export async function radarCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "show";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "show") { const r = (!args.has("refresh") && readRadar(vault)) || (await computeRadar(vault)); if (args.json) out(r); else { if (!r.items.length) console.log("Nothing slipping."); for (const x of r.items) console.log(`[${x.kind}] ${x.text}  (${x.evidence})`); } return 0; }
  if (sub === "routines") {
    if (args.pos[1] === "bootstrap") { const r = bootstrapRoutines(vault); if (args.json) out(r); else console.log(`Drafted ${r.added.length} routines as proposed lines; confirm them on the Compass page.`); return 0; }
    const c = routineCandidates(vault); if (args.json) out(c); else for (const x of c) console.log(`${x.cadence.padEnd(8)} ${x.title}  (${x.from})`); return 0;
  }
  console.error("usage: prevail radar show [--refresh] | routines [bootstrap] [--json]");
  return 1;
}
