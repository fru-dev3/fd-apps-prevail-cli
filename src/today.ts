// Today: the daily card. Not a task list: at most three things that matter,
// each with its thread back to a value (or an honest "unlinked"), plus one
// thing falling behind, the nearest decision, your day and a count of what
// else is due.
//
// Candidates: tasks with dates (a promise to a person weighs more than a
// self-imposed date), commitments and waiting-fors, open decisions near their
// deadline, jobs waiting on the user. Score (code, not a model):
//   value weight (Compass rank, rank-order centroid; unlinked 0.15)
//   x urgency (overdue 1, today .9, 3 days .7, a week .5, two weeks .3)
//   x slip risk (how overdue) x leverage (values served) x priority
//   x the learned weight for that domain and kind.
// Rules: at most three; at most one per domain unless it is due today or
// overdue; if the top-ranked value has nothing on the card and a candidate
// serves it, it takes the third place.
//
// The card for a day is written once to build/_meta/today/<date>.json with
// the choices, the reasons and the user's taps. Taps retrain the weights
// (build/_meta/today/weights.json): done and "right list" raise a domain and
// kind, "not important" lowers them. Done on a task also checks it off on its
// board; move puts it on tomorrow. Nothing is deleted.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataRoot, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { parseTasks } from "./tasks.ts";
import { items, readCompass, type CompassItem } from "./compass.ts";
import { listDecisions, openDecision } from "./decision-records.ts";
import { listJobs } from "./jobs.ts";
import { checkinFor, reviewWeek } from "./review.ts";
import { dayOf, weekOf } from "./metrics.ts";
import { parseModArgs } from "./cli-args.ts";

export type ItemKind = "task" | "commitment" | "waiting" | "decision" | "job";
export interface TodayItem {
  key: string;
  kind: ItemKind;
  title: string;
  domain: string;
  due?: string;
  person?: string;
  thread: string[];
  unlinked: boolean;
  why: string;
  score: number;
  ref: { domain: string; id?: string; text?: string; slug?: string; job?: string };
}
export interface TodayCard {
  date: string;
  generated: number;
  calm: number | null;
  items: TodayItem[];
  fallingBehind: { text: string; ref?: TodayItem["ref"] } | null;
  decisionDue: { question: string; due?: string; domain: string; slug: string; recommendation?: string } | null;
  yourDay: { connected: boolean; note: string };
  alsoDue: TodayItem[];
  feedback: { ts: number; key: string; action: string }[];
}

const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };
const todayDir = (vault: string) => join(runtimePath(vault, "_meta"), "today");
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
const label = (slug: string) => slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** Rank-order centroid weights: w_i = (1/n) * sum_{k=i..n} 1/k. */
export function rocWeights(n: number): number[] {
  return Array.from({ length: n }, (_, i) => { let s = 0; for (let k = i + 1; k <= n; k++) s += 1 / k; return s / n; });
}

interface Weights { domain: Record<string, number>; kind: Record<string, number> }
const weightsPath = (vault: string) => join(todayDir(vault), "weights.json");
export function readWeights(vault: string): Weights {
  try { const w = JSON.parse(readText(weightsPath(vault))) as Weights; return { domain: w.domain ?? {}, kind: w.kind ?? {} }; } catch { return { domain: {}, kind: {} }; }
}

/** The thread from a domain up to the user's values: domain > goal > value, through the Compass. */
export function threadsFor(vault: string): { byDomain: Map<string, { goal?: CompassItem; values: CompassItem[] }>; weight: Map<string, number>; topValue?: CompassItem } {
  const doc = readCompass(vault);
  const ok = (x: CompassItem) => x.tokens.status !== "proposed";
  const values = items(doc, "value").filter(ok).sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99));
  const w = rocWeights(values.length);
  const weight = new Map(values.map((v, i) => [v.id, w[i]!]));
  const byDomain = new Map<string, { goal?: CompassItem; values: CompassItem[] }>();
  for (const g of items(doc, "goal").filter(ok)) {
    const st = g.tokens.status ?? "active";
    if (!g.tokens.domain || !["active", "confirmed", "prototyping"].includes(st)) continue;
    const vs = (g.tokens.serves ?? "").split(",").map((id) => values.find((v) => v.id === id)).filter((v): v is CompassItem => !!v);
    if (!byDomain.has(g.tokens.domain)) byDomain.set(g.tokens.domain, { goal: g, values: vs });
  }
  return { byDomain, weight, topValue: values[0] };
}

function boardFiles(vault: string): { domain: string; file: string }[] {
  const out: { domain: string; file: string }[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const dir = join(dataRoot(vault), "domains", d);
    for (const f of ["memory/tasks.md", "_tasks.md"]) if (existsSync(join(dir, f))) { out.push({ domain: d, file: join(dir, f) }); break; }
  }
  return out;
}

export function candidates(vault: string, date: string): TodayItem[] {
  const { byDomain, weight } = threadsFor(vault);
  const learned = readWeights(vault);
  const out: TodayItem[] = [];
  const valueWeight = (domain: string) => {
    const t = byDomain.get(domain);
    if (!t || !t.values.length) return { w: 0.15, thread: [label(domain)], unlinked: !t, n: 0 };
    return { w: t.values.reduce((a, v) => a + (weight.get(v.id) ?? 0), 0) || 0.15, thread: [label(domain), t.goal!.title, ...t.values.map((v) => v.title)], unlinked: false, n: t.values.length };
  };
  const urgency = (due?: string) => {
    if (!due) return 0.1;
    const d = daysBetween(date, due);
    return d < 0 ? 1 : d === 0 ? 0.9 : d <= 3 ? 0.7 : d <= 7 ? 0.5 : d <= 14 ? 0.3 : 0;
  };
  const score = (domain: string, kind: ItemKind, due: string | undefined, extra = 1) => {
    const v = valueWeight(domain);
    const u = urgency(due);
    if (!u) return null;
    const late = due ? Math.max(0, -daysBetween(date, due)) : 0;
    const slip = due ? Math.min(1, 0.5 + late / 14) : 0.5;
    const leverage = 1 + 0.25 * Math.max(0, v.n - 1);
    const s = v.w * u * slip * leverage * extra * (learned.domain[domain] ?? 1) * (learned.kind[kind] ?? 1);
    return { s: Math.round(s * 10_000) / 10_000, v };
  };
  for (const { domain, file } of boardFiles(vault)) {
    for (const t of parseTasks(readText(file))) {
      if (t.done || t.trashed || t.status === "icebox" || t.status === "done" || !t.due) continue;
      const kind: ItemKind = t.kind === "commitment" ? "commitment" : t.kind === "waiting" ? "waiting" : "task";
      // A promise to a person outranks a self-imposed date.
      const extra = (kind === "commitment" ? 2 : kind === "waiting" ? 1.2 : 1) * (t.priority === "critical" ? 1.4 : t.priority === "high" ? 1.2 : 1);
      const r = score(domain, kind, t.due, extra);
      if (!r) continue;
      const late = -daysBetween(date, t.due);
      const person = t.to ?? t.from;
      out.push({
        key: `task:${domain}:${t.id ?? `t-${createHash("sha1").update(t.text).digest("hex").slice(0, 8)}`}`, kind, title: t.text.replace(/\s+~\S+/g, "").replace(/\s*\([^)]*\)\s*$/, "").slice(0, 140), domain, due: t.due, ...(person ? { person } : {}),
        thread: r.v.thread, unlinked: r.v.unlinked, score: r.s, ref: { domain, ...(t.id ? { id: t.id } : { text: t.text }) },
        why: `${late > 0 ? `${late} day${late === 1 ? "" : "s"} overdue` : late === 0 ? "due today" : `due in ${-late} day${late === -1 ? "" : "s"}`}${kind === "commitment" ? ", a promise to someone" : kind === "waiting" ? ", someone owes you this" : ""}`,
      });
    }
  }
  for (const d of listDecisions(vault)) {
    const r = score(d.domain, "decision", d.due, 1.3);
    if (!r) continue;
    out.push({ key: `decision:${d.domain}:${d.slug}`, kind: "decision", title: `Decide: ${d.question}`, domain: d.domain, due: d.due, thread: r.v.thread, unlinked: r.v.unlinked, score: r.s, ref: { domain: d.domain, slug: d.slug }, why: d.recommendation ? "a recommendation is ready" : "an open decision" });
  }
  for (const j of listJobs(vault, 30)) {
    if (j.status !== "proposed" && j.status !== "needs-approval") continue;
    if (j.created < Date.now() - 14 * 86_400_000) continue;
    const r = score(j.domains.owner || "general", "job", date, 0.6);
    if (!r) continue;
    out.push({ key: `job:${j.id}`, kind: "job", title: `Waiting on you: ${j.ask.slice(0, 100)}`, domain: j.domains.owner || "general", thread: r.v.thread, unlinked: r.v.unlinked, score: r.s, ref: { domain: j.domains.owner || "general", job: j.id }, why: j.askReason ?? j.note ?? "a job asks before it starts" });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The three: by score, at most one per domain unless due today or overdue, and the top value gets a place. */
export function pickThree(all: TodayItem[], date: string, topValue?: string, skip = new Set<string>()): TodayItem[] {
  const pick: TodayItem[] = [];
  const pressing = (x: TodayItem) => !!x.due && daysBetween(date, x.due) <= 0;
  for (const x of all) {
    if (pick.length >= 3) break;
    if (skip.has(x.key)) continue;
    if (!pressing(x) && pick.some((p) => p.domain === x.domain)) continue;
    pick.push(x);
  }
  if (topValue && pick.length === 3 && !pick.some((p) => p.thread.includes(topValue))) {
    const alt = all.find((x) => !skip.has(x.key) && x.thread.includes(topValue) && !pick.includes(x));
    if (alt) pick[2] = alt;
  }
  return pick;
}

const cardPath = (vault: string, date: string) => join(todayDir(vault), `${date}.json`);

export function readCard(vault: string, date: string): TodayCard | null {
  try { return JSON.parse(readText(cardPath(vault, date))) as TodayCard; } catch { return null; }
}

/** The card for a day: composed once, then kept (taps are added to it). refresh recomposes, keeping the taps. */
export function composeToday(vault: string, opts: { now?: number; refresh?: boolean } = {}): TodayCard {
  const now = opts.now ?? Date.now();
  const date = dayOf(now);
  const old = readCard(vault, date);
  if (old && !opts.refresh) return old;
  const { topValue } = threadsFor(vault);
  const feedback = old?.feedback ?? [];
  const handled = new Set(feedback.filter((f) => f.action === "done" || f.action === "move" || f.action === "not-important").map((f) => f.key));
  const all = candidates(vault, date);
  const three = pickThree(all, date, topValue?.title, handled);
  const rest = all.filter((x) => !three.includes(x) && !handled.has(x.key));
  const overdue = rest.filter((x) => x.due && daysBetween(date, x.due) < -7).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))[0];
  const dec = listDecisions(vault)[0];
  const ck = checkinFor(vault, reviewWeek(now, vault)) ?? checkinFor(vault, weekOf(date));
  const card: TodayCard = {
    date, generated: now, calm: ck?.calm ?? null,
    items: three,
    fallingBehind: overdue ? { text: `${overdue.title}: ${overdue.why}`, ref: overdue.ref } : null,
    decisionDue: dec ? { question: dec.question, due: dec.due, domain: dec.domain, slug: dec.slug, ...(dec.recommendation ? { recommendation: dec.recommendation } : {}) } : null,
    yourDay: { connected: false, note: "No calendar is connected yet, so your day is not on the card." },
    alsoDue: rest.filter((x) => x.due && daysBetween(date, x.due) <= 7).slice(0, 12),
    feedback,
  };
  mkdirSync(todayDir(vault), { recursive: true });
  writeFileSync(cardPath(vault, date), `${JSON.stringify(card, null, 2)}\n`);
  return card;
}

export type Tap = "done" | "move" | "not-important" | "right" | "right-list";

/** One tap on the card. Retrains the weights; done and move also change the task (reversible). */
export function todayFeedback(vault: string, key: string, action: Tap, now = Date.now()): TodayCard {
  const date = dayOf(now);
  const card = readCard(vault, date) ?? composeToday(vault, { now });
  card.feedback.push({ ts: now, key, action });
  const item = [...card.items, ...card.alsoDue].find((x) => x.key === key);
  const w = readWeights(vault);
  const nudge = (map: Record<string, number>, k: string, f: number) => { map[k] = Math.min(2, Math.max(0.3, Math.round((map[k] ?? 1) * f * 1000) / 1000)); };
  if (action === "right-list") { for (const x of card.items) { nudge(w.domain, x.domain, 1.03); nudge(w.kind, x.kind, 1.03); } }
  else if (item) {
    const f = action === "not-important" ? 0.85 : action === "done" || action === "right" ? 1.05 : 1;
    nudge(w.domain, item.domain, f);
    nudge(w.kind, item.kind, f);
    if ((item.ref.id || item.ref.text) && (action === "done" || action === "move")) editTask(vault, item.ref.domain, item.ref, action, date);
  }
  mkdirSync(todayDir(vault), { recursive: true });
  writeFileSync(weightsPath(vault), `${JSON.stringify(w, null, 2)}\n`);
  writeFileSync(cardPath(vault, date), `${JSON.stringify(card, null, 2)}\n`);
  return card;
}

/** Check a task off (with a closed date) or put it on tomorrow, by its id (or its text), editing only that line. */
function editTask(vault: string, domain: string, ref: { id?: string; text?: string }, action: "done" | "move", date: string): void {
  const dir = resolveDomainDir(vault, domain);
  const file = [join(dir, "memory", "tasks.md"), join(dir, "_tasks.md")].find((f) => existsSync(f));
  if (!file) return;
  const tomorrow = dayOf(new Date(`${date}T12:00:00`).getTime() + 86_400_000);
  const lines = readText(file).split("\n").map((l) => {
    if (!/^\s*- \[ \]/.test(l)) return l;
    if (ref.id ? !l.includes(`~id:${ref.id}`) : parseTasks(l)[0]?.text !== ref.text) return l;
    if (action === "done") return `${l.replace("- [ ]", "- [x]")} ~closed:${date}`;
    return / @\d{4}-\d{2}-\d{2}/.test(l) ? l.replace(/ @\d{4}-\d{2}-\d{2}/, ` @${tomorrow}`) : `${l} @${tomorrow}`;
  });
  vwriteFile(file, lines.join("\n"));
}

/** How the card did: per day, the three items and how many the user marked right or done. */
export function todayStats(vault: string, days = 14, now = Date.now()): { date: string; items: number; right: number; notImportant: number; rightList: boolean }[] {
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = dayOf(now - i * 86_400_000);
    const c = readCard(vault, date);
    if (!c) continue;
    const keys = new Set(c.items.map((x) => x.key));
    const right = new Set(c.feedback.filter((f) => keys.has(f.key) && (f.action === "done" || f.action === "right")).map((f) => f.key)).size;
    const rightList = c.feedback.some((f) => f.action === "right-list");
    out.push({ date, items: c.items.length, right: rightList ? c.items.length : right, notImportant: c.feedback.filter((f) => f.action === "not-important").length, rightList });
  }
  return out;
}

/** The card as plain text (Telegram, the CLI). */
export function todayText(c: TodayCard): string {
  const d = new Date(`${c.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const out = [`Today, ${d}${c.calm ? `   calm ${c.calm}` : ""}`, "", "WHAT MATTERS TODAY"];
  if (!c.items.length) out.push("Nothing with a date is pressing. A good day to move a goal.");
  c.items.forEach((x, i) => { out.push(`${i + 1}  ${x.title}${x.due ? `   (${x.why})` : ""}`); out.push(`   ${x.unlinked ? "unlinked" : x.thread.join(" > ")}`); });
  if (c.fallingBehind) out.push("", "FALLING BEHIND", `   ${c.fallingBehind.text}`);
  if (c.decisionDue) out.push("", "DECISION DUE", `   ${c.decisionDue.question}${c.decisionDue.due ? `, due ${c.decisionDue.due}` : ""}${c.decisionDue.recommendation ? ". Recommendation ready." : ""}`);
  out.push("", "YOUR DAY", `   ${c.yourDay.note}`);
  if (c.alsoDue.length) out.push("", `ALSO DUE (${c.alsoDue.length})`);
  return out.join("\n");
}

export async function todayCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "show";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    if (sub === "show") { const c = composeToday(vault, { refresh: args.has("refresh") }); if (args.json) out(c); else console.log(todayText(c)); return 0; }
    if (sub === "tap") {
      const a = args.pos[2] as Tap;
      if (!["done", "move", "not-important", "right", "right-list"].includes(a)) { console.error("usage: prevail today tap <key> done|move|not-important|right|right-list"); return 1; }
      const c = todayFeedback(vault, args.pos[1] ?? "", a);
      if (args.json) out(c); else console.log("Noted.");
      return 0;
    }
    if (sub === "fold-open-loops") {
      const plan = planOpenLoopsFold(vault);
      if (!args.has("apply")) { if (args.json) out(plan); else for (const l of plan) console.log(`${l.domain.padEnd(12)} ${l.action.padEnd(9)} ${l.text.slice(0, 90)}${l.due ? ` @${l.due}` : ""}`); return 0; }
      const r = applyOpenLoopsFold(vault, plan);
      if (args.json) out(r); else console.log(`${r.tasks} tasks, ${r.decisions} decisions, ${r.duplicates} already on a board; ${r.backups.length} files kept as backups`);
      return 0;
    }
    if (sub === "stats") { const s = todayStats(vault, Number(args.get("days") ?? 14) || 14); if (args.json) out(s); else for (const x of s) console.log(`${x.date} ${x.right}/${x.items} right`); return 0; }
  } catch (e) { if (args.json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message); return 1; }
  console.error("usage: prevail today show [--refresh] | tap <key> <done|move|not-important|right|right-list> | stats [--json]");
  return 1;
}

// ── Folding the scattered open-loops files into boards and decisions ────────
//
// memory/open-loops.md was an early, free-form list per domain. Each open line
// becomes a task on the domain's board (a waiting-for when it says so, an open
// decision record when it says [DECIDE]), unless the board already has the same
// task. Dates in the past keep their date in the text instead of becoming an
// overdue flood. The old file stays beside the board as
// open-loops.md.pre-today-<date>; nothing is deleted.

export interface LoopLine { domain: string; line: string; text: string; action: "task" | "waiting" | "decision" | "duplicate"; due?: string; priority?: string; like?: string }

const contentWords = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4));
function similar(a: string, b: string): number {
  const x = contentWords(a), y = contentWords(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

export function cleanLoop(line: string): { text: string; date?: string; waiting: boolean; decide: boolean; urgent: boolean } {
  let t = line.replace(/^- \[ \]\s*/, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
  const waiting = /\b(PENDING|AWAITING|awaiting|waiting on|waiting for)\b/.test(t);
  const decide = /^\[DECIDE\]/i.test(t);
  const urgent = /^(URGENT|NOW|OVERDUE|Overdue)\b/.test(t);
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t)?.[1];
  t = t.replace(/^(?:By\s+)?~?\d{4}-\d{2}-\d{2}(?:\/\d{2})?\s*[\u2014\u2013-]\s*/, "")
    .replace(/^(?:\[[A-Z]+\]|URGENT|NOW|OVERDUE|Overdue|Stale|PENDING|AWAITING[^\u2014\u2013-]*|[A-Z][a-z]{2}(?:\u2013[A-Z][a-z]{2})? \d{4}|Before [^\u2014\u2013-]+)\s*[\u2014\u2013-]\s*/, "")
    .replace(/\s*[\u2014]\s*/g, ", ").replace(/\s+\u2013\s+/g, ", ").replace(/\s+/g, " ").trim();
  if (t.length > 240) { const cut = t.slice(0, 240); const dot = cut.lastIndexOf(". "); t = `${dot > 80 ? cut.slice(0, dot + 1) : `${cut.trim()}...`} (more in the open-loops backup)`; }
  return { text: t.charAt(0).toUpperCase() + t.slice(1), date, waiting, decide, urgent };
}

export function planOpenLoopsFold(vault: string, now = Date.now()): LoopLine[] {
  const out: LoopLine[] = [];
  const today = dayOf(now);
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const dir = join(dataRoot(vault), "domains", d);
    const f = join(dir, "memory", "open-loops.md");
    if (!existsSync(f)) continue;
    const board = [join(dir, "memory", "tasks.md"), join(dir, "_tasks.md")].find((p) => existsSync(p));
    const open = board ? parseTasks(readText(board)).filter((t) => !t.done).map((t) => t.text) : [];
    for (const line of readText(f).split("\n")) {
      if (!/^- \[ \]\s+\S/.test(line)) continue;
      const c = cleanLoop(line);
      const like = open.find((t) => similar(c.text, t) >= 0.5);
      const recent = c.date && daysBetween(today, c.date) >= -14;
      out.push({
        domain: d, line, text: !recent && c.date && !c.text.includes(c.date) ? `${c.text} (was ${c.date})` : c.text,
        action: like ? "duplicate" : c.decide ? "decision" : c.waiting ? "waiting" : "task",
        ...(recent ? { due: c.date } : {}), ...(c.urgent ? { priority: "high" } : {}), ...(like ? { like } : {}),
      });
    }
  }
  return out;
}

export function applyOpenLoopsFold(vault: string, plan: LoopLine[], now = Date.now()): { tasks: number; decisions: number; duplicates: number; backups: string[] } {
  const day = dayOf(now);
  const res = { tasks: 0, decisions: 0, duplicates: 0, backups: [] as string[] };
  const byDomain = new Map<string, LoopLine[]>();
  for (const l of plan) (byDomain.get(l.domain) ?? byDomain.set(l.domain, []).get(l.domain)!).push(l);
  for (const [d, lines] of byDomain) {
    const dir = join(dataRoot(vault), "domains", d);
    const board = existsSync(join(dir, "memory")) ? join(dir, "memory", "tasks.md") : join(dir, "_tasks.md");
    const add: string[] = [];
    lines.forEach((l, i) => {
      if (l.action === "duplicate") { res.duplicates++; return; }
      if (l.action === "decision") {
        openDecision(vault, { question: l.text.replace(/\s*\(was [^)]*\)$/, ""), domain: d, due: l.due, context: `From the open-loops list (${day}).` });
        res.decisions++;
        return;
      }
      const id = `ol${(now + i).toString(36).slice(-5)}`;
      add.push(`- [ ] ${l.text}${l.due ? ` @${l.due}` : ""} +${day} ~src:open-loops${l.priority ? ` ~priority:${l.priority}` : ""}${l.action === "waiting" ? " ~kind:waiting" : ""} ~id:${id}`);
      res.tasks++;
    });
    if (add.length) {
      const cur = readText(board);
      vwriteFile(board, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${add.join("\n")}\n`);
    }
    const src = join(dir, "memory", "open-loops.md");
    const backup = `${src}.pre-today-${day}`;
    if (existsSync(src) && !existsSync(backup)) { renameSync(src, backup); res.backups.push(backup); }
  }
  return res;
}
