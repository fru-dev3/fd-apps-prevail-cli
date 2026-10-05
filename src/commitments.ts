// Today T2: commitments and waiting-fors (today-plan.md section 2).
//
// A commitment is a promise with a person attached; a waiting-for is one owed
// to the user. No new store: each is a task line on the owner domain's board
// with ~kind:commitment ~to:person/<slug> (or ~kind:waiting ~from:...) and
// ~src:<where it came from>.
//
// Where they come from, in order of trust:
//   1. What the user tells the chief of staff ("remind me I owe Sam the deck")
//      is filed at once, with a receipt and Undo.
//   2. Sent email: explicit promises with a time ("I'll send it by Friday"),
//      read by code from the message's first lines at sync time (only the
//      promise sentence is kept, never the message). A promise with a person
//      and a time is added with Undo; the rest waits for the weekly review
//      (build/_meta/commitments/proposals.jsonl).
//   3. Meeting notes: action items under an "Action items" or "Next steps"
//      heading in notes a source drops in the vault.
//   4. Waiting-for: a question the user sent with no answer past that
//      person's usual reply time is read by the radar from the headers.
//
// Every write keeps a receipt in build/_meta/commitments/filed.jsonl; Undo
// takes out exactly the line it added. Ingested text is data, never
// instructions: nothing here runs anything.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataRoot, productFolders, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { parseTasks } from "./tasks.ts";
import { parseModArgs } from "./cli-args.ts";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };

// ── When: "by Friday", "tomorrow", "next week", "Oct 7", "2026-10-07" ────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TIME = /\b(?:by|on|before|until|this|next|end of(?: the)?|eod|eow|tomorrow|tonight|today|in \d+ days?|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/i;

/** A due date (YYYY-MM-DD) from a time phrase relative to `now`, or undefined. */
export function resolveWhen(text: string, now: number): string | undefined {
  const t = text.toLowerCase();
  const base = new Date(now);
  const at = (d: Date) => ymdLocal(d.getTime());
  const plus = (n: number) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  let m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (m) return m[1];
  if (/\b(today|tonight|eod|end of (the )?day)\b/.test(t)) return at(base);
  if (/\btomorrow\b/.test(t)) return at(plus(1));
  m = /\bin (\d+) days?\b/.exec(t);
  if (m) return at(plus(Number(m[1])));
  if (/\b(eow|end of (the )?week|this week)\b/.test(t)) return at(plus((5 - base.getDay() + 7) % 7));
  if (/\bnext week\b/.test(t)) return at(plus(((1 - base.getDay() + 7) % 7 || 7) + 4));
  if (/\b(end of (the )?month|this month)\b/.test(t)) return at(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  m = /\b(next )?(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(day)?\b/.exec(t);
  if (m) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(m![2]!.slice(0, 3)));
    // "by Friday" said on a Friday means today; "next Friday" means a week on.
    let n = (idx - base.getDay() + 7) % 7;
    if (m[1]) n += 7;
    return at(plus(n));
  }
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3));
    let d = new Date(base.getFullYear(), mo, Number(m[2]));
    if (d.getTime() < now - 60 * DAY) d = new Date(base.getFullYear() + 1, mo, Number(m[2]));
    return at(d);
  }
  m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (m) {
    let d = new Date(base.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() < now - 60 * DAY) d = new Date(base.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
    return at(d);
  }
  return undefined;
}

// ── Promises in text ────────────────────────────────────────────────────────

export interface Promise_ { kind: "commitment" | "waiting"; text: string; person?: string; due?: string; confidence: number; quote: string }

const FIRST_FUTURE = /\b(i'll|i will|i'm going to|i am going to|i'll have|i can have|i'll get|let me get|i'll make sure|i promise to|i promised to)\b/i;
const HEDGE = /\b(might|maybe|perhaps|possibly|probably|try to|hope to|hopefully|if i can|if possible|if you (want|like|need)|would love to|should be able to|i'll see|i'll think|i'll let you know if)\b/i;
const NOT = /\b(won't|will not|can't|cannot|not going to)\b/i;
const CONDITIONAL = /^\s*(if|when|once|unless)\b/i;
const VERB = /\b(send|share|get|have|finish|draft|write|review|call|email|reply|follow up|look into|check|book|pay|sign|submit|deliver|introduce|set up|schedule|fix|update|prepare|bring|return|forward|confirm|order|file|upload|ship|read|test)\b/i;

const sentences = (text: string) => text.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 400);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Explicit promises the user made in their own text (a sent email, a chat).
 * A promise is a first-person future with an action verb, no hedge, no
 * negation, not conditional. Confidence: 0.9 with a time and a person, 0.7
 * with a time, 0.5 otherwise. `to` is the person the text went to, if known.
 */
export function findPromises(text: string, now: number, to?: string): Promise_[] {
  const out: Promise_[] = [];
  for (const s of sentences(text)) {
    if (!FIRST_FUTURE.test(s) || !VERB.test(s) || HEDGE.test(s) || NOT.test(s) || CONDITIONAL.test(s) || /\?$/.test(s)) continue;
    const due = TIME.test(s) ? resolveWhen(s, now) : undefined;
    const what = s.replace(/^.*?\b(i'll|i will|i'm going to|i am going to|i'll have|i can have|i'll get|let me get|i'll make sure|i promise to|i promised to)\b\s*/i, "").replace(/[.!]+$/, "");
    if (what.split(/\s+/).length < 2) continue;
    out.push({ kind: "commitment", text: cap(what).slice(0, 160), ...(to ? { person: to } : {}), ...(due ? { due } : {}), confidence: due && to ? 0.9 : due ? 0.7 : 0.5, quote: s.slice(0, 240) });
  }
  return out;
}

// What the user tells the chief of staff: "remind me I owe Sam the deck by Friday".
// Names are capitalized words, so these are case-sensitive except the lead-in.
const NAME = "([A-Z][\\w'-]+(?: [A-Z][\\w'-]+)?)";
const TOLD: [Promise_["kind"], RegExp][] = [
  ["commitment", new RegExp(`\\b[Rr]emind me (?:that )?I owe ${NAME} (.+)`)],
  ["commitment", new RegExp(`\\bI promised ${NAME} (?:that )?(?:I'd|I would|I will|I'll|to) (.+)`)],
  ["commitment", new RegExp(`\\bI told ${NAME} (?:that )?(?:I'd|I would|I will|I'll) (.+)`)],
  ["commitment", new RegExp(`^I owe ${NAME} (.+)`)],
  ["waiting", new RegExp(`\\b${NAME} owes me (.+)`)],
  ["waiting", new RegExp(`\\b(?:I'm |I am )?[Ww]aiting (?:on|for) ${NAME} (?:to |for )?(.+)`)],
  ["waiting", new RegExp(`\\b${NAME} (?:said|promised) (?:she|he|they)(?:'d| would| will|'ll) (.+)`)],
];
const NOT_A_NAME = new Set(["I", "You", "We", "They", "He", "She", "It", "The", "This", "That", "My", "Our", "Me", "Remind", "Please"]);

export function personSlug(name: string): string { return `person/${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`; }

/** A commitment or waiting-for the user said to the chief of staff, or null. Code only. */
export function toldCommitment(text: string, now: number): Promise_ | null {
  const t = text.trim().replace(/\s+/g, " ");
  for (const [kind, re] of TOLD) {
    const m = re.exec(t);
    if (!m || NOT_A_NAME.has(m[1]!.split(" ")[0]!)) continue;
    let what = m[2]!.replace(/[.!?]+$/, "").trim();
    const due = TIME.test(what) ? resolveWhen(what, now) : undefined;
    what = what.replace(/\s*\b(by|on|before|until) (\w+day|tomorrow|today|tonight|next week|the end of (the )?(week|month)|end of (the )?(week|month)|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2})\s*$/i, "").replace(/\s*\b(tomorrow|today|tonight|next week|this week)\s*$/i, "").trim();
    if (what.length < 3) continue;
    const name = m[1]!;
    return { kind, text: kind === "commitment" ? cap(`${/^(send|give|get|share|call|email|pay|return|bring|introduce|reply|write|draft)\b/i.test(what) ? what : `${what} for ${name}`}`).slice(0, 160) : cap(`${what} from ${name}`).slice(0, 160), person: personSlug(name), ...(due ? { due } : {}), confidence: 0.95, quote: t.slice(0, 240) };
  }
  return null;
}

/** Action items in meeting notes: under an "Action items" / "Next steps" / "To do" heading. */
export function meetingItems(md: string, now: number, self: string[] = ["me", "i", "myself"]): Promise_[] {
  const out: Promise_[] = [];
  let inSection = false;
  for (const line of md.split("\n")) {
    const h = /^#{1,4}\s+(.*)$/.exec(line) ?? /^\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (h) { inSection = /\b(action items?|next steps|to-?dos?|follow[- ]ups?)\b/i.test(h[1]!); continue; }
    if (!inSection) continue;
    const it = /^\s*[-*]\s+(?:\[ \]\s+)?(.+)$/.exec(line);
    if (!it) continue;
    const body = it[1]!.trim();
    const who = /^@?([A-Za-z][\w'-]*(?: [A-Z][\w'-]+)?)\s*[:–-]\s+(.+)$/.exec(body);
    const due = TIME.test(body) ? resolveWhen(body, now) : undefined;
    if (who && !self.includes(who[1]!.toLowerCase())) out.push({ kind: "waiting", text: cap(`${who[2]!.replace(/[.]+$/, "")} from ${who[1]}`).slice(0, 160), person: personSlug(who[1]!), ...(due ? { due } : {}), confidence: 0.7, quote: body.slice(0, 240) });
    else out.push({ kind: "commitment", text: cap((who ? who[2]! : body).replace(/[.]+$/, "")).slice(0, 160), ...(due ? { due } : {}), confidence: 0.7, quote: body.slice(0, 240) });
  }
  return out;
}

// ── Filing, with receipts and Undo ──────────────────────────────────────────

export const commitmentsDir = (vault: string) => join(runtimePath(vault, "_meta"), "commitments");
const filedPath = (vault: string) => join(commitmentsDir(vault), "filed.jsonl");
const proposalsPath = (vault: string) => join(commitmentsDir(vault), "proposals.jsonl");

export interface FiledReceipt { ts: number; id: string; domain: string; file: string; kind: Promise_["kind"]; text: string; src: string; undone?: number }

function boardOf(vault: string, domain: string): string {
  const dir = resolveDomainDir(vault, domain);
  return existsSync(join(dir, "memory")) || !existsSync(join(dir, "_tasks.md")) ? join(dir, "memory", "tasks.md") : join(dir, "_tasks.md");
}

const readJsonl = <T>(p: string): T[] => { try { return readFileSync(p, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as T] : []; } catch { return []; } }); } catch { return []; } };

/** Every ~src already on any board (so nothing is filed twice). */
export function filedSources(vault: string): Set<string> {
  const out = new Set<string>();
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    for (const f of ["memory/tasks.md", "_tasks.md"]) for (const t of parseTasks(readText(join(dataRoot(vault), "domains", d, f)))) if (t.source) out.add(t.source);
  }
  for (const r of readJsonl<FiledReceipt>(filedPath(vault))) out.add(r.src);
  return out;
}

/** Put one commitment or waiting-for on a board. Returns its receipt, or null when that source is already filed. */
export function fileCommitment(vault: string, p: Promise_, o: { domain: string; src: string; now?: number }): FiledReceipt | null {
  const now = o.now ?? Date.now();
  if (filedSources(vault).has(o.src)) return null;
  const id = `c${createHash("sha1").update(`${o.src}\n${p.text}`).digest("hex").slice(0, 7)}`;
  const file = boardOf(vault, o.domain);
  const cur = readText(file);
  const person = p.person ? (p.kind === "waiting" ? ` ~from:${p.person}` : ` ~to:${p.person}`) : "";
  const line = `- [ ] ${p.text.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ")}${p.due ? ` @${p.due}` : ""} +${ymdLocal(now)} ~src:${o.src} ~id:${id} ~kind:${p.kind}${person}`;
  mkdirSync(join(file, ".."), { recursive: true });
  vwriteFile(file, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${line}\n`);
  const r: FiledReceipt = { ts: now, id, domain: o.domain, file, kind: p.kind, text: p.text, src: o.src };
  mkdirSync(commitmentsDir(vault), { recursive: true });
  appendFileSync(filedPath(vault), `${JSON.stringify(r)}\n`);
  return r;
}

export function readFiled(vault: string): FiledReceipt[] {
  const rows = readJsonl<FiledReceipt & { undo?: string }>(filedPath(vault));
  const undone = new Map(rows.filter((r) => r.undo).map((r) => [r.undo!, r.ts]));
  return rows.filter((r) => !r.undo).map((r) => (undone.has(r.id) ? { ...r, undone: undone.get(r.id) } : r));
}

/** Undo: take out exactly the line that was added (found by its id). */
export function undoCommitment(vault: string, id: string, now = Date.now()): boolean {
  const r = readFiled(vault).find((x) => x.id === id && !x.undone);
  if (!r) return false;
  const cur = readText(r.file);
  const next = cur.split("\n").filter((l) => !l.includes(`~id:${id}`)).join("\n");
  if (next !== cur) vwriteFile(r.file, next);
  appendFileSync(filedPath(vault), `${JSON.stringify({ ts: now, undo: id })}\n`);
  return true;
}

export function propose(vault: string, p: Promise_, src: string, now = Date.now()): void {
  if (readJsonl<{ src: string }>(proposalsPath(vault)).some((x) => x.src === src) || filedSources(vault).has(src)) return;
  mkdirSync(commitmentsDir(vault), { recursive: true });
  appendFileSync(proposalsPath(vault), `${JSON.stringify({ ts: now, src, ...p, status: "proposed" })}\n`);
}

export function openProposals(vault: string): (Promise_ & { ts: number; src: string })[] {
  const rows = readJsonl<Promise_ & { ts: number; src: string; status: string }>(proposalsPath(vault));
  const answered = new Set(rows.filter((r) => r.status !== "proposed").map((r) => r.src));
  return rows.filter((r) => r.status === "proposed" && !answered.has(r.src));
}

export function answerProposal(vault: string, src: string, yes: boolean, domain = "general", now = Date.now()): FiledReceipt | null {
  const p = openProposals(vault).find((x) => x.src === src);
  if (!p) throw new Error(`no open proposal ${src}`);
  appendFileSync(proposalsPath(vault), `${JSON.stringify({ ts: now, src, status: yes ? "accepted" : "dismissed" })}\n`);
  return yes ? fileCommitment(vault, p, { domain, src, now }) : null;
}

// ── From chat (filed at once) ───────────────────────────────────────────────

/** A message to the chief of staff that is a commitment: filed now, with a receipt. */
export function noteCommitment(vault: string, i: { text: string; domain: string; thread: string; now?: number }): FiledReceipt | null {
  const now = i.now ?? Date.now();
  const p = toldCommitment(i.text, now);
  if (!p) return null;
  const domain = i.domain && !i.domain.startsWith("_") ? i.domain : "general";
  return fileCommitment(vault, p, { domain, src: `chat:${i.thread.slice(0, 40)}:${createHash("sha1").update(i.text).digest("hex").slice(0, 6)}`, now });
}

// ── From sent mail (headers kept on this Mac; the promise sentence only) ────

export interface HeaderLite { id: string; thread: string; ts: number; dir: "sent" | "received"; from: string; to: string[]; subject: string; promises?: Promise_[]; asks?: boolean }

const threadHash = (t: string) => createHash("sha1").update(t).digest("hex").slice(0, 10);

/** The person a sent message went to, as a slug from the address (the vault's person entity when one matches). */
export function personOfAddress(addr: string): string | undefined {
  const local = (addr.split("@")[0] ?? "").toLowerCase();
  if (!local || /^(no-?reply|info|support|hello|team|admin|billing|sales|contact|jobs|careers)\b/.test(local)) return undefined;
  const name = local.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim();
  return name.length >= 2 ? personSlug(name) : undefined;
}

/**
 * Promises in the last 30 days of sent mail. Confidence 0.9 (a person and a
 * time) are filed on the general board with Undo; the rest are proposed for
 * the weekly review. Returns what happened.
 */
export function commitmentsFromMail(vault: string, headers: HeaderLite[], now = Date.now()): { filed: FiledReceipt[]; proposed: number } {
  const res = { filed: [] as FiledReceipt[], proposed: 0 };
  for (const h of headers) {
    if (h.dir !== "sent" || !h.promises?.length || h.ts < now - 30 * DAY) continue;
    h.promises.forEach((p, n) => {
      const src = `gmail:${threadHash(h.thread)}:${n}`;
      const person = p.person ?? (h.to[0] ? personOfAddress(h.to[0]) : undefined);
      const full: Promise_ = { ...p, ...(person ? { person } : {}), confidence: p.due && person ? Math.max(p.confidence, 0.9) : p.confidence };
      if (full.confidence >= 0.9 && full.due && full.due >= ymdLocal(now - 7 * DAY)) { const r = fileCommitment(vault, full, { domain: "general", src, now }); if (r) res.filed.push(r); }
      else { propose(vault, full, src, now); res.proposed++; }
    });
  }
  return res;
}

// ── From meeting notes dropped in the vault ─────────────────────────────────

/** Notes files: data/entities/products/<id>/meetings/*.md and data/domains/<d>/source/meetings/*.md, the last 30 days. */
export function meetingFiles(vault: string, now = Date.now()): { file: string; domain: string; mtime: number }[] {
  const out: { file: string; domain: string; mtime: number }[] = [];
  const scan = (dir: string, domain: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const p = join(dir, f);
      try { const t = statSync(p).mtimeMs; if (t >= now - 30 * DAY) out.push({ file: p, domain, mtime: t }); } catch { /* unreadable */ }
    }
  };
  for (const { dir } of productFolders(vault)) scan(join(dir, "meetings"), "general");
  for (const d of listDomainDirs(vault)) if (!d.startsWith("_")) scan(join(dataRoot(vault), "domains", d, "source", "meetings"), d);
  return out;
}

export function commitmentsFromMeetings(vault: string, now = Date.now()): { filed: FiledReceipt[]; proposed: number; files: number } {
  const res = { filed: [] as FiledReceipt[], proposed: 0, files: 0 };
  for (const m of meetingFiles(vault, now)) {
    res.files++;
    meetingItems(readText(m.file), m.mtime).forEach((p, n) => {
      const src = `meeting:${threadHash(m.file)}:${n}`;
      if (p.kind === "commitment" && p.due) { const r = fileCommitment(vault, p, { domain: m.domain, src, now }); if (r) res.filed.push(r); }
      else { propose(vault, p, src, now); res.proposed++; }
    });
  }
  return res;
}

// ── One pass over every source (the capture sync calls this; the CLI too) ───

export async function scanCommitments(vault: string, now = Date.now()): Promise<{ mail: { filed: number; proposed: number; headers: number; state: string }; meetings: { filed: number; proposed: number; files: number } }> {
  let headers: HeaderLite[] = [];
  let state = "not connected";
  try {
    const ss = await import("./source-sync.ts");
    headers = ss.readMailHeaders(vault) as HeaderLite[];
    state = headers.length ? "ok" : "not connected: no sent mail headers on this Mac (Google sign-in)";
  } catch { /* none */ }
  const mail = commitmentsFromMail(vault, headers, now);
  const meet = commitmentsFromMeetings(vault, now);
  return { mail: { filed: mail.filed.length, proposed: mail.proposed, headers: headers.length, state }, meetings: { filed: meet.filed.length, proposed: meet.proposed, files: meet.files } };
}

// ── Open commitments, and whether each is slipping ──────────────────────────

export interface OpenCommitment { domain: string; id?: string; text: string; kind: "commitment" | "waiting"; person?: string; due?: string; added?: string; src?: string; activity: boolean; slipping: boolean; why: string }

/**
 * Every open commitment and waiting-for. A promise due within three days with
 * no activity since it was made (no mail to that person, no job about it, the
 * line unchanged) is slipping; an overdue one is slipping.
 */
export function openCommitments(vault: string, now = Date.now(), headers: HeaderLite[] = []): OpenCommitment[] {
  const today = ymdLocal(now);
  const hs = headers;
  const out: OpenCommitment[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    for (const f of ["memory/tasks.md", "_tasks.md"]) {
      const file = join(dataRoot(vault), "domains", d, f);
      if (!existsSync(file)) continue;
      for (const t of parseTasks(readText(file))) {
        if (t.done || t.trashed || (t.kind !== "commitment" && t.kind !== "waiting")) continue;
        const person = t.to ?? t.from;
        const since = t.added ? Date.parse(`${t.added}T00:00:00`) : now - 30 * DAY;
        const tokens = person ? person.replace(/^person\//, "").split("-").filter((x) => x.length >= 2) : [];
        const mailed = !!person && (hs ?? []).some((h) => h.ts >= since && (t.kind === "commitment" ? h.dir === "sent" && h.to.some((a) => tokens.every((x) => a.includes(x))) : h.dir === "received" && tokens.every((x) => h.from.includes(x))));
        const days = t.due ? Math.round((Date.parse(`${t.due}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / DAY) : null;
        const slipping = days !== null && (days < 0 || (days <= 3 && !mailed));
        out.push({ domain: d, ...(t.id ? { id: t.id } : {}), text: t.text, kind: t.kind as "commitment" | "waiting", ...(person ? { person } : {}), ...(t.due ? { due: t.due } : {}), ...(t.added ? { added: t.added } : {}), ...(t.source ? { src: t.source } : {}), activity: mailed, slipping,
          why: days === null ? "no date" : days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : slipping ? `due in ${days} day${days === 1 ? "" : "s"}, nothing done on it yet` : `due in ${days} day${days === 1 ? "" : "s"}` });
      }
    }
  }
  return out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
}

// ── CLI: prevail commitments list|scan|proposals|answer|undo|note ───────────

export async function commitmentsCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    if (sub === "list") { const l = openCommitments(vault, Date.now(), (await import("./source-sync.ts")).readMailHeaders(vault) as HeaderLite[]); if (args.json) out(l); else for (const c of l) console.log(`${(c.due ?? "no date").padEnd(10)} ${c.kind === "waiting" ? "waiting" : "promise"} ${c.slipping ? "SLIPPING " : ""}${c.text}${c.person ? ` (${c.person})` : ""}`); return 0; }
    if (sub === "scan") { const r = await scanCommitments(vault); if (args.json) out(r); else console.log(`mail: ${r.mail.state}; ${r.mail.filed} filed, ${r.mail.proposed} for the review. meetings: ${r.meetings.files} notes, ${r.meetings.filed} filed, ${r.meetings.proposed} for the review.`); return 0; }
    if (sub === "proposals") { const p = openProposals(vault); if (args.json) out(p); else for (const x of p) console.log(`${x.src}  ${x.text}${x.due ? ` @${x.due}` : ""}  "${x.quote}"`); return 0; }
    if (sub === "answer") { const r = answerProposal(vault, args.pos[1] ?? "", args.pos[2] === "yes", args.get("domain") ?? "general"); if (args.json) out({ ok: true, filed: r }); else console.log(r ? `Filed on ${r.domain}'s board.` : "Not now."); return 0; }
    if (sub === "undo") { const ok = undoCommitment(vault, args.pos[1] ?? ""); if (args.json) out({ ok }); else console.log(ok ? "Undone." : "Nothing to undo."); return ok ? 0 : 1; }
    if (sub === "note") { const r = noteCommitment(vault, { text: args.pos.slice(1).join(" "), domain: args.get("domain") ?? "general", thread: args.get("thread") ?? "cli" }); if (args.json) out({ ok: true, filed: r }); else console.log(r ? `Filed: ${r.text}` : "That did not read as a promise."); return 0; }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail commitments list | scan | proposals | answer <src> yes|no [--domain d] | undo <id> | note <text> [--domain d] [--json]");
}
