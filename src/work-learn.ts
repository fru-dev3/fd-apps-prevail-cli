// Work mode learns from every task and uses it next time. No store of its own:
//
//   - the chief of staff's "What I've learned" (build/chief-of-staff.md) holds
//     what the owner taught by hand, as plain lines he can read and edit:
//     where a kind of work goes (a re-route), and the plan answers that hold
//     from one task to the next (budget, preferences);
//   - the staffing log (jobs.ts adjustJob) already teaches specialists, and
//     staffJob applies it through learnedStaffing;
//   - the work records (build/_meta/work/prompts) are the history: recurring
//     work and the sources that answered well are read from them;
//   - the owner domain's journal gets each outcome and correction, which the
//     learn daemon distils into that domain's memory.
//
// What was used shows as one plain line on the task, and "forget that" in a
// reply takes it back out.

import { existsSync } from "node:fs";
import { editLearned, readChiefOfStaff } from "./chief-of-staff.ts";
import { domainDir } from "./decisions.ts";
import { vappendLine } from "./vault-session.ts";
import { v4ContentPath } from "./vault-layout-v4.ts";
import type { ContextItem } from "./work-assemble.ts";
import type { Destination } from "./work-router.ts";
import type { WorkPrompt, WorkTask } from "./work.ts";

type TaskLike = Pick<WorkTask, "name" | "text">;

// ── Words ───────────────────────────────────────────────────────────────────

const STOP = new Set(("a an the and or but for to of in on at by with from about into this that these those it its my me i we our you your " +
  "please can could would should will need want get go do make find look check help tell let know is are be was were what which who how when where why " +
  "there here now just also really very some any all new next up out task reply plan booking call reminder fix comparison review budget summary search " +
  "draft write send email book reserve").split(" "));

/** The words a task is about, lower case, in order, without filler. */
export function topicWords(s: string): string[] {
  return [...new Set(s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

function similar(a: TaskLike, b: TaskLike): boolean {
  if (a.name && b.name && a.name.toLowerCase() === b.name.toLowerCase()) return true;
  const x = new Set(topicWords(a.text));
  const y = new Set(topicWords(b.text));
  if (!x.size || !y.size) return false;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / new Set([...x, ...y]).size >= 0.6;
}

// ── Routing corrections ─────────────────────────────────────────────────────

const ROUTE_RE = /^Work about "([^"]{2,80})" goes to (domain|project|folder|entity|event|app):(\S+)/;

/** The words a routing lesson keys on: the task's name, else the first words of the ask. */
function routeKey(t: TaskLike): string {
  const w = topicWords(t.name || "");
  return (w.length ? w : topicWords(t.text).slice(0, 3)).join(" ");
}

/** The owner moved a task: next time work like it goes there. Replaces an older lesson for the same words. */
export function learnRoute(vault: string, t: TaskLike, to: Destination, now = Date.now()): string | null {
  const key = routeKey(t);
  if (!key) return null;
  const line = `Work about "${key}" goes to ${to.kind}:${to.id} (you moved it there)`;
  try {
    editLearned(vault, { add: [line], drop: (l) => ROUTE_RE.exec(l)?.[1] === key && l !== line }, now);
    journalLesson(vault, to.owner, `The owner moved the task "${t.name || t.text}" to ${to.label}; work like it goes there.`, now);
  } catch { return null; }
  return line;
}

/** The owner undid a move: the lesson it taught goes. */
export function unlearnRoute(vault: string, t: TaskLike, from: Destination, now = Date.now()): void {
  const key = routeKey(t);
  if (!key) return;
  try { editLearned(vault, { drop: (l) => { const m = ROUTE_RE.exec(l); return !!m && m[1] === key && m[2] === from.kind && m[3] === from.id; } }, now); } catch { /* best effort */ }
}

/** The routing lesson that fits a new task (every word of the lesson in its name or ask), newest first. */
export function routeLessonFor(lessons: string[], t: TaskLike): { line: string; kind: string; id: string } | null {
  const words = new Set(topicWords(`${t.name ?? ""} ${t.text}`));
  for (const line of [...lessons].reverse()) {
    const m = ROUTE_RE.exec(line);
    if (m && m[1]!.split(" ").every((w) => words.has(w))) return { line, kind: m[2]!, id: m[3]! };
  }
  return null;
}

// ── Plan answers ────────────────────────────────────────────────────────────

export type PlanKind = "travel" | "purchase" | "health" | "other";
export type Topic = "where" | "when" | "budget" | "why" | "prefs";
/** Answers that hold from one task to the next; where, when and what for belong to one task only. */
const STABLE: Topic[] = ["budget", "prefs"];
const KIND_WORD: Record<PlanKind, string> = { travel: "Travel", purchase: "Purchase", health: "Health", other: "Other" };
const ANSWER_RE = /^(Travel|Purchase|Health|Other) plans, (budget|preferences): (.+)$/;

const BUDGET_SAID = /(\$|€|£|\busd\b|\beur\b|\bbudget\b|\bunder \d|\bat most\b|\bup to \d|\bmax(?:imum)?\b|\d[\d,.]*\s*(?:k\b|dollars|euros|pounds|tops))/i;
const WHEN_SAID = /\b(today|tomorrow|tonight|week|weekend|month|year|days?|nights?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|spring|summer|autumn|fall|winter)\b/i;
const PREFS_SAID = /\b(prefer|avoid|aisle|window|always|never|only|must|no |not |vegetarian|vegan|quiet|direct|nonstop|non-stop|train|walkable|allerg\w*)\b/i;
const WHY_SAID = /\b(rest|relax|work|family|friends|see|visit|celebrate|business|holiday|for (?:my|our|the|a))\b/i;

/** What a question asks about, by its words. */
export function topicOf(q: string): Topic | null {
  if (/\b(budget|spend|cost|price|how much|afford)\b/i.test(q)) return "budget";
  if (/\b(avoid|prefer|preference|must include|habit|seat|anything I should)\b/i.test(q)) return "prefs";
  if (/\b(when|how long|dates?|by what)\b/i.test(q)) return "when";
  if (/\b(where|which (?:cities|places|city|place))\b/i.test(q)) return "where";
  if (/\b(what is it for|what for|purpose|why|occasion)\b/i.test(q)) return "why";
  return null;
}

/** One reply to a plan's questions, split by topic: line by line when it answers each in turn, else by its words. */
export function answersFrom(questions: string[], reply: string): Partial<Record<Topic, string>> {
  const out: Partial<Record<Topic, string>> = {};
  const lines = reply.split(/\n+/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  if (lines.length === questions.length && lines.length > 1) {
    questions.forEach((q, i) => { const tp = topicOf(q); if (tp && !out[tp]) out[tp] = lines[i]!; });
    return out;
  }
  const add = (tp: Topic, s: string) => { out[tp] = out[tp] ? `${out[tp]}, ${s}` : s; };
  for (const raw of reply.split(/[\n;]+|,(?!\d{3}\b)|\.(?:\s|$)/)) {
    const s = raw.trim().replace(/[.!]+$/, "");
    if (!s) continue;
    if (BUDGET_SAID.test(s)) add("budget", s);
    else if (PREFS_SAID.test(s)) add("prefs", s);
    else if (WHEN_SAID.test(s)) add("when", s);
    else if (WHY_SAID.test(s)) add("why", s);
    else if (!out.where) add("where", s);
  }
  return out;
}

/** The owner answered a plan: the answers that hold next time become lessons (a newer answer replaces the older). */
export function learnAnswers(vault: string, kind: PlanKind, questions: string[], reply: string, now = Date.now()): string[] {
  const a = answersFrom(questions, reply);
  const lines: string[] = [];
  for (const tp of STABLE) {
    const v = a[tp]?.replace(/\s+/g, " ").trim().slice(0, 160);
    if (v) lines.push(`${KIND_WORD[kind]} plans, ${tp === "budget" ? "budget" : "preferences"}: ${v}`);
  }
  if (!lines.length) return [];
  const heads = new Set(lines.map((l) => l.slice(0, l.indexOf(":"))));
  try { editLearned(vault, { add: lines, drop: (l) => ANSWER_RE.test(l) && heads.has(l.slice(0, l.indexOf(":"))) && !lines.includes(l) }, now); } catch { return []; }
  return lines;
}

export interface KnownAnswer { topic: Topic; text: string; line: string }

/** What the owner said before for plans of this kind. */
export function knownAnswers(lessons: string[], kind: PlanKind): KnownAnswer[] {
  const out: KnownAnswer[] = [];
  for (const line of lessons) {
    const m = ANSWER_RE.exec(line);
    if (m && m[1] === KIND_WORD[kind]) out.push({ topic: m[2] === "budget" ? "budget" : "prefs", text: m[3]!, line });
  }
  return out;
}

// ── Recurring work ──────────────────────────────────────────────────────────

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export interface Recurring { count: number; weekday?: string; last: WorkTask; ids: string[]; /** How it ended the last time it ended. */ outcome?: string }

/** Work the owner has asked for at least twice before (and not told it to forget), with the latest time first. */
export function recurringMatch(prompts: WorkPrompt[], t: TaskLike, now = Date.now()): Recurring | null {
  const hits: { task: WorkTask; ts: number }[] = [];
  for (const p of prompts) for (const x of p.tasks) if (!x.learnOff && p.ts < now && similar(t, x)) hits.push({ task: x, ts: p.ts });
  hits.sort((a, b) => b.ts - a.ts);
  // An occasion is a day: asking again the same day (a retry, a rewording) is not recurring work.
  const occasions = new Set(hits.map((h) => new Date(h.ts).toDateString())).size;
  if (occasions < 2) return null;
  const days = new Set(hits.map((h) => new Date(h.ts).getDay()));
  const day = days.size === 1 ? DAYS[[...days][0]!] : undefined;
  const outcome = hits.find((h) => h.task.outcome)?.task.outcome;
  return { count: occasions, ...(day ? { weekday: day } : {}), last: hits[0]!.task, ids: hits.map((h) => h.task.id), ...(outcome ? { outcome } : {}) };
}

// ── Sources that answered well ──────────────────────────────────────────────

/** A context line's source, without the detail: "Money notes", "past trip", "home city". */
export const sourceKey = (label: string) => label.replace(/^(?:Your |From your )/i, "").split(/[:,]/)[0]!.trim().toLowerCase();

/** How often each source was in a task that ended done, from the history. */
export function sourceRank(prompts: WorkPrompt[]): Map<string, number> {
  const rank = new Map<string, number>();
  for (const p of prompts) for (const t of p.tasks) {
    if (t.status !== "done" || t.learnOff) continue;
    for (const c of t.context ?? []) { const k = sourceKey(c.label); rank.set(k, (rank.get(k) ?? 0) + 1); }
  }
  return rank;
}

/** The context with the sources that answered well before first (stable otherwise). */
export function rankContext(ctx: ContextItem[], rank: Map<string, number>): ContextItem[] {
  return ctx.map((c, i) => ({ c, i, n: rank.get(sourceKey(c.label)) ?? 0 })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.c);
}

// ── Domain memory ───────────────────────────────────────────────────────────

/** One line in the domain's journal, which the learn daemon distils into its memory. Best effort. */
export function journalLesson(vault: string, domain: string | undefined, text: string, now = Date.now()): void {
  try {
    const d = (domain ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(d) || d === "general") return;
    const dir = domainDir(vault, d);
    if (!existsSync(dir)) return;
    vappendLine(v4ContentPath(dir, ".system/journal.jsonl", "_intents.jsonl"), `${JSON.stringify({ kind: "reply", ts: now, source: "work", domain: d, raw: text.replace(/\s+/g, " ").trim().slice(0, 600) })}\n`);
  } catch { /* learning never breaks the task */ }
}

// ── What was used, and forgetting it ────────────────────────────────────────

export const lessons = (vault: string): string[] => { try { return readChiefOfStaff(vault).learned; } catch { return []; } };

/** "forget that", "please forget it", "forget what you learned". */
export const isForget = (text: string) => /^\s*(?:ok(?:ay)?[, ]+)?(?:please\s+)?(?:forget|unlearn|drop)\s+(?:that|this|it|what you (?:learned|learnt))\b/i.test(text) && text.split(/\s+/).length <= 10;

/**
 * Take back what a task used: its lessons leave "What I've learned", and the
 * past tasks it was recognised from no longer teach. Returns what went, as plain words.
 */
export function forgetLearned(vault: string, used: string[], now = Date.now()): string[] {
  const drop = new Set(used.filter((l) => ROUTE_RE.test(l) || ANSWER_RE.test(l)));
  if (!drop.size) return [];
  try { return editLearned(vault, { drop: (l) => drop.has(l) }, now); } catch { return []; }
}

/** A lesson as the owner would say it. */
export function plainLesson(line: string): string {
  const r = ROUTE_RE.exec(line);
  if (r) return `${r[1]} goes to ${r[3]}`;
  const a = ANSWER_RE.exec(line);
  if (a) return a[3]!;
  return line;
}
