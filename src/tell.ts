// Today T6: one place to put anything (today-plan.md, "6. One place to put
// anything"). Tell the chief of staff anything, on any surface (chat, the
// phone, Telegram, the CLI, MCP, an email to yourself), and it is filed by
// code with a receipt and Undo:
//
//   a promise or a waiting-for   the owner's board (commitments.ts)
//   a decision to make           an open decision record (gut call first)
//   a task                       the owner's board, with the date it names
//   a goal, value or rule        a Compass candidate (the weekly review asks)
//   a number (ran 5 km...)       a stated event (metrics learn from it)
//   practice or a spend          the mission it belongs to (MS5 routing)
//   anything else                a note to the owner domain (updates.jsonl,
//                                folded into its memory by the consolidator)
//
// The owner is the domain or mission named on the surface, else an active
// mission the words point at, else the domain whose name or routing keywords
// the text uses, else General. Code only: no model call, so it is instant
// and free. "What am I forgetting?" lists every open loop across the vault.
//
// Receipts: build/_meta/capture/told.jsonl (one line per filing; an undo
// line marks it undone). Undo takes out exactly what was written.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { parseModArgs } from "./cli-args.ts";

export type Surface = "chat" | "cli" | "mcp" | "telegram" | "phone" | "desktop" | "email";
export type ToldKind = "commitment" | "waiting" | "decision" | "task" | "candidate" | "metric" | "practice" | "spend" | "note";
export interface Told { id: string; ts: number; surface: Surface; kind: ToldKind; text: string; domain: string; mission?: string; due?: string; where: string; file?: string; lines?: string[]; ref?: string; undone?: number }

const DAY = 86_400_000;
const captureDir = (vault: string) => join(runtimePath(vault, "_meta"), "capture");
const toldPath = (vault: string) => join(captureDir(vault), "told.jsonl");
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").trim();
const label = (slug: string) => slug.split("-").map((w) => cap(w)).join(" ");

// ── Where it goes ───────────────────────────────────────────────────────────

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "learn", "plan", "trip", "buy", "build", "remodel", "mission", "project", "get", "make", "new", "my", "our", "a", "an", "to", "of", "in", "on"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * The active mission a message points at (Missions MS5 routing): one whose
 * name or outcome words, or calendar match words, the message uses. Only a
 * clear single winner counts; a tie is no answer.
 */
export async function missionForText(vault: string, text: string): Promise<{ slug: string; name: string } | null> {
  const m = await import("./missions.ts");
  const said = new Set(words(text));
  const scored = m.activeMissions(vault).map((x) => {
    const ws = new Set([...words(x.name), ...words(x.outcome ?? ""), ...(x.match.calendar ?? []).flatMap(words)]);
    return { slug: x.slug, name: x.name, n: [...ws].filter((w) => said.has(w)).length };
  }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (!scored.length || (scored[1] && scored[1].n === scored[0]!.n)) {
    // Practice or a spend with exactly one active learning mission: that one.
    const act = m.activeMissions(vault);
    if (/\b(practiced|practised|rehearsed|studied|trained)\b/i.test(text)) { const learn = act.filter((x) => /^(learn|train|practice|study)/i.test((x.outcome ?? x.name).trim())); if (learn.length === 1) return { slug: learn[0]!.slug, name: learn[0]!.name }; }
    return null;
  }
  return { slug: scored[0]!.slug, name: scored[0]!.name };
}

/** The domain a message names, by its slug or its routing keywords; General when none. */
export function domainForText(vault: string, text: string): string {
  const t = text.toLowerCase();
  let best: { d: string; n: number } | null = null;
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_") || d === "general") continue;
    let n = new RegExp(`\\b${d.replace(/-/g, "[- ]")}\\b`, "i").test(t) ? 2 : 0;
    try {
      const j = JSON.parse(read(join(resolveDomainDir(vault, d), "manifest.json"))) as { routing?: { keywords?: string[] } };
      for (const k of j.routing?.keywords ?? []) if (String(k).length >= 3 && new RegExp(`\\b${String(k).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) n++;
    } catch { /* no manifest */ }
    if (n && (!best || n > best.n)) best = { d, n };
  }
  return best?.d ?? "general";
}

// ── What it is ──────────────────────────────────────────────────────────────

const TASK = /^(?:please\s+)?(?:remind me to|don'?t let me forget to|add (?:a )?task(?: to)?:?|to-?do:?|todo:?|i need to|i have to|i must|i should)\s+(.{3,200})$/i;
const DECIDE = /^(?:should i|do i|i need to decide(?: whether)?|help me decide(?: whether)?|i'?m torn (?:between|about)|deciding (?:whether|between))\s+(.{3,200}?)\??$/i;
const NOTE = /^(?:note(?: that)?:?|remember(?: that)?:?|fyi:?|for the record:?|jot (?:this )?down:?)\s+(.{3,400})$/i;
/** An explicit "file this" message: what chat files at once (other chat turns are answered as usual). */
export const CAPTURE = /^(?:please\s+)?(?:remind me to|don'?t let me forget to|add (?:a )?task|to-?do:?|todo:?|note(?: that)?:?|remember(?: that)?:?|fyi:?|for the record:?|jot (?:this )?down|tell \w+ (?:that )?)/i;
export const FORGETTING = /\bwhat am i (?:forgetting|missing)\b|\bwhat(?:'s| is) (?:still )?open\b.*\b(loops?|for me)\b|\bopen loops\b/i;

function receipt(vault: string, t: Omit<Told, "id" | "ts">, now: number): Told {
  const r: Told = { id: `t${createHash("sha1").update(`${now}|${t.text}|${Math.random()}`).digest("hex").slice(0, 8)}`, ts: now, ...t };
  mkdirSync(captureDir(vault), { recursive: true });
  appendFileSync(toldPath(vault), `${JSON.stringify(r)}\n`);
  return r;
}

/** Lines a write appended to these files (read before and after). */
function appendedLines(files: string[], fn: () => void): { file: string; lines: string[] }[] {
  const before = new Map(files.map((f) => [f, read(f)]));
  fn();
  return files.map((f) => ({ file: f, lines: read(f).slice(before.get(f)!.length).split("\n").filter((l) => l.trim()) })).filter((x) => x.lines.length);
}

export async function tell(vault: string, raw: string, o: { surface: Surface; domain?: string; mission?: string; thread?: string; now?: number } = { surface: "cli" }): Promise<Told> {
  const now = o.now ?? Date.now();
  const text = clean(raw).slice(0, 600);
  if (text.length < 2) throw new Error("tell me something to file");
  const rel = (p: string) => relative(vault, p);
  const missions = await import("./missions.ts");
  const ms = o.mission ? { slug: missions.missionSlugOf(o.mission), name: missions.readMission(vault, o.mission)?.name ?? o.mission } : !o.domain ? await missionForText(vault, text) : null;
  const domain = o.domain ?? (ms ? missions.ownerOf(missions.readMission(vault, ms.slug)!) ?? "general" : domainForText(vault, text));
  const home = ms ? `_mission-${ms.slug}` : domain;
  const src = `tell:${o.surface}:${now.toString(36)}`;
  const base = { surface: o.surface, text, domain, ...(ms ? { mission: ms.slug } : {}) };
  const where = ms ? `the mission ${ms.name}` : `${label(domain)}`;

  // Practice or a spend said for a mission: its ledger or its metric events.
  if (ms) {
    const mp = await import("./mission-progress.ts");
    const said = await import("./said.ts");
    const m = await import("./metrics.ts");
    const files = [missions.ledgerPath(vault, ms.slug), join(m.eventsRoot(vault), "stated", `${ymd(now).slice(0, 7)}.${m.hostSlug()}.jsonl`)];
    let spent: number | undefined; let stated = 0;
    const got = appendedLines(files, () => { spent = mp.missionSaid(vault, ms.slug, text, o.thread ?? src, now).spent; if (!spent) stated = said.noteSaid(vault, { text, thread: o.thread ?? src, domain: home, now, mission: ms.slug }).stated.length; });
    if (spent || stated) {
      const kind: ToldKind = spent ? "spend" : "practice";
      return receipt(vault, { ...base, kind, where: kind === "spend" ? `${where}'s budget ($${spent})` : `${where}'s progress`, ...(got[0] ? { file: rel(got[0].file), lines: got[0].lines } : {}) }, now);
    }
  }

  // A promise to someone, or something someone owes you.
  const cm = await import("./commitments.ts");
  const told = cm.toldCommitment(text, now);
  if (told) {
    const r = cm.fileCommitment(vault, told, { domain: home, src, now });
    if (r) return receipt(vault, { ...base, kind: r.kind, text: r.text, ...(told.due ? { due: told.due } : {}), where: `${where}'s board, as ${r.kind === "waiting" ? "a waiting-for" : "a promise"}`, ref: r.id }, now);
  }

  // A decision to make: an open record (two weeks unless a date is said).
  const dm = DECIDE.exec(text);
  if (dm) {
    const { openDecision } = await import("./decision-records.ts");
    const due = cm.resolveWhen(text, now) ?? ymd(now + 14 * DAY); // two weeks when none is said
    const q = cap(dm[1]!.replace(/[?.!]+$/, ""));
    const rec = openDecision(vault, { question: /^(whether|between)\b/i.test(q) ? cap(q) : `Should I ${q.charAt(0).toLowerCase()}${q.slice(1)}?`.replace(/\?\?$/, "?"), domain: home, ...(due ? { due } : {}), context: `Told on ${o.surface} on ${ymd(now)}: "${text.slice(0, 200)}"` });
    return receipt(vault, { ...base, kind: "decision", text: rec.question, due: rec.due, where: `${where}'s decisions, due ${rec.due}`, file: rel(rec.file) }, now);
  }

  // A task: on the owner's board with the date it names.
  const tm = TASK.exec(text);
  if (tm) {
    const { boardFile } = await import("./jobs.ts");
    const bf = boardFile(vault, home);
    const due = cm.resolveWhen(tm[1]!, now);
    const what = cap(tm[1]!.replace(/[.!]+$/, "").replace(/\s*\b(by|on|before) (\w+day|tomorrow|today|next week|the end of (the )?(week|month)|\d{4}-\d{2}-\d{2})\s*$/i, "").replace(/\s*\b(tomorrow|today|tonight|next week)\s*$/i, "")).slice(0, 160);
    const id = `t${now.toString(36).slice(-6)}`;
    const line = `- [ ] ${what}${due ? ` @${due}` : ""} +${ymd(now)} ~src:${src} ~id:${id}`;
    const cur = read(bf);
    mkdirSync(join(bf, ".."), { recursive: true });
    writeFileSync(bf, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${line}\n`);
    return receipt(vault, { ...base, kind: "task", text: what, ...(due ? { due } : {}), where: `${where}'s board${due ? `, due ${due}` : ""}`, file: rel(bf), lines: [line], ref: id }, now);
  }

  // A goal, value or rule in the user's own words: a Compass candidate. A number: a stated event.
  const said = await import("./said.ts");
  const cands = said.compassCandidates(text);
  const nums = said.statedNumbers(text);
  if (cands.length || nums.length) {
    const { compassMetaDir } = await import("./compass.ts");
    const m = await import("./metrics.ts");
    const files = [join(compassMetaDir(vault), "proposals.jsonl"), join(m.eventsRoot(vault), "stated", `${ymd(now).slice(0, 7)}.${m.hostSlug()}.jsonl`)];
    const got = appendedLines(files, () => { said.noteSaid(vault, { text, thread: o.thread ?? src, domain: home, now }); });
    const g = got[0];
    if (cands.length) return receipt(vault, { ...base, kind: "candidate", text: cands[0]!.title, where: "your Compass, to confirm in the weekly review", ...(g ? { file: rel(g.file), lines: g.lines } : {}) }, now);
    return receipt(vault, { ...base, kind: "metric", text: `${nums[0]!.what} ${nums[0]!.value} ${nums[0]!.unit}`, where: "your metrics", ...(g ? { file: rel(g.file), lines: g.lines } : {}) }, now);
  }

  // Anything else: a note the owner domain (or mission) keeps.
  const nm = NOTE.exec(text);
  const fact = cap((nm ? nm[1]! : text).slice(0, 400));
  if (ms) {
    const line = missions.logLine(vault, ms.slug, fact, now);
    return receipt(vault, { ...base, kind: "note", text: fact, where: `${where}'s log`, file: rel(join(missions.missionDir(vault, ms.slug), "memory", "log.md")), lines: [line] }, now);
  }
  const { appendJsonl, domainUpdatesPath } = await import("./linking.ts");
  const row = { ts: now, from_domain: "you", thread: src, fact, entities: [] as string[] };
  appendJsonl(domainUpdatesPath(vault, domain), row);
  return receipt(vault, { ...base, kind: "note", text: fact, where: `${where}'s notes`, file: rel(domainUpdatesPath(vault, domain)), lines: [JSON.stringify(row)] }, now);
}

export function readTold(vault: string, limit = 50): Told[] {
  const rows = read(toldPath(vault)).split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as Told & { undo?: string }] : []; } catch { return []; } });
  const undone = new Map(rows.filter((r) => r.undo).map((r) => [r.undo!, r.ts]));
  return rows.filter((r) => !r.undo).map((r) => (undone.has(r.id) ? { ...r, undone: undone.get(r.id) } : r)).reverse().slice(0, limit);
}

/** Undo one filing: exactly what it wrote comes out (a decision record moves aside, never deleted). */
export async function undoTold(vault: string, id: string, now = Date.now()): Promise<Told> {
  const r = readTold(vault, 1000).find((x) => x.id === id);
  if (!r) throw new Error(`no filing ${id}`);
  if (r.undone) return r;
  if (r.kind === "commitment" || r.kind === "waiting") (await import("./commitments.ts")).undoCommitment(vault, r.ref!, now);
  else if (r.kind === "decision" && r.file) {
    const abs = join(vault, r.file);
    if (existsSync(abs)) { const to = join(captureDir(vault), "undone", `${now}-${abs.split("/").pop()}`); mkdirSync(join(to, ".."), { recursive: true }); renameSync(abs, to); }
  } else if (r.file && r.lines?.length) {
    const abs = join(vault, r.file);
    const cur = read(abs);
    let next = cur;
    for (const l of r.lines) { const i = next.lastIndexOf(`${l}\n`); next = i >= 0 ? next.slice(0, i) + next.slice(i + l.length + 1) : next.replace(l, ""); }
    if (next !== cur) writeFileSync(abs, next);
  }
  mkdirSync(captureDir(vault), { recursive: true });
  appendFileSync(toldPath(vault), `${JSON.stringify({ ts: now, undo: id })}\n`);
  return { ...r, undone: now };
}

export function toldReply(r: Told): string {
  const what: Record<ToldKind, string> = { commitment: "a promise", waiting: "a waiting-for", decision: "a decision to make", task: "a task", candidate: "a line for your Compass", metric: "a number", practice: "practice", spend: "a spend", note: "a note" };
  return `Filed ${what[r.kind]} in ${r.where}.${r.kind === "candidate" ? " I will ask you in the weekly review." : ""}`;
}

// ── What am I forgetting? ───────────────────────────────────────────────────

export interface Forgetting { sections: { title: string; items: { text: string; why: string; domain?: string; due?: string }[] }[]; count: number }

/** Every open loop across the vault, by kind, most urgent first: promises, waiting-fors, decisions, the radar's slips, overdue tasks, what waits for a yes. */
export async function forgetting(vault: string, now = Date.now()): Promise<Forgetting> {
  const today = ymd(now);
  const sections: Forgetting["sections"] = [];
  const cm = await import("./commitments.ts");
  let headers: import("./commitments.ts").HeaderLite[] = [];
  try { headers = (await import("./source-sync.ts")).readMailHeaders(vault) as import("./commitments.ts").HeaderLite[]; } catch { /* none */ }
  const open = cm.openCommitments(vault, now, headers);
  const soon = (d?: string) => !!d && d <= ymd(now + 7 * DAY);
  const promises = open.filter((c) => c.kind === "commitment").sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  sections.push({ title: "Promises you made", items: promises.slice(0, 8).map((c) => ({ text: c.text, why: c.due ? (c.due < today ? `overdue since ${c.due}` : soon(c.due) ? `due ${c.due}` : `by ${c.due}`) : "no date", domain: c.domain, ...(c.due ? { due: c.due } : {}) })) });
  sections.push({ title: "Waiting for others", items: open.filter((c) => c.kind === "waiting").slice(0, 8).map((c) => ({ text: c.text, why: c.due ? `expected ${c.due}` : c.why, domain: c.domain })) });
  try { const d = await import("./decision-records.ts"); sections.push({ title: "Decisions to make", items: d.listDecisions(vault).slice(0, 6).map((r) => ({ text: r.question, why: r.due ? `due ${r.due}` : "open", domain: r.domain, ...(r.due ? { due: r.due } : {}) })) }); } catch { /* none */ }
  try {
    const rd = await import("./radar.ts");
    const r = rd.readRadar(vault, now) ?? (await rd.computeRadar(vault, { now }));
    const slips = r.items.filter((x) => ["goal", "routine", "path", "mission", "relationship", "admin", "rule"].includes(x.kind));
    sections.push({ title: "Slipping", items: slips.slice(0, 8).map((x) => ({ text: x.text, why: x.evidence, domain: x.domain })) });
  } catch { /* no radar */ }
  // Overdue tasks on every board (not commitments: those are above).
  try {
    const { parseTasks } = await import("./tasks.ts");
    const items: Forgetting["sections"][number]["items"] = [];
    for (const d of listDomainDirs(vault)) {
      if (d.startsWith("_")) continue;
      for (const f of ["memory/tasks.md", "_tasks.md"]) for (const t of parseTasks(read(join(resolveDomainDir(vault, d), f)))) {
        if (t.done || !t.due || t.due >= today || t.kind === "commitment" || t.kind === "waiting") continue;
        items.push({ text: t.text, why: `overdue since ${t.due}`, domain: d, due: t.due });
      }
    }
    sections.push({ title: "Overdue tasks", items: items.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "")).slice(0, 8) });
  } catch { /* no boards */ }
  try { const ag = await import("./act-gate.ts"); const n = ag.readPendingActs(vault).length; if (n) sections.push({ title: "Waiting for your yes", items: [{ text: `${n} action${n === 1 ? "" : "s"} in your Inbox`, why: "held until you answer" }] }); } catch { /* none */ }
  const kept = sections.filter((s) => s.items.length);
  return { sections: kept, count: kept.reduce((a, s) => a + s.items.length, 0) };
}

export function forgettingText(f: Forgetting): string {
  if (!f.count) return "Nothing open that I can find: no promises due, no one you are waiting on, no decision due, nothing slipping.";
  return [`${f.count} open loop${f.count === 1 ? "" : "s"}:`, ...f.sections.flatMap((s) => [`${s.title}:`, ...s.items.map((x) => `- ${x.text} (${x.why}${x.domain ? `, ${label(x.domain)}` : ""})`)])].join("\n");
}

// ── Email to yourself ───────────────────────────────────────────────────────

/** Mail you sent to yourself with a subject that starts "tell:", "note:", "todo:" or "remind me": filed once each (headers only). */
export async function tellFromMail(vault: string, now = Date.now()): Promise<Told[]> {
  let hs: { id: string; dir: string; from: string; to: string[]; subject: string; ts: number }[] = [];
  try { hs = (await import("./source-sync.ts")).readMailHeaders(vault) as typeof hs; } catch { return []; }
  const seenPath = join(captureDir(vault), "mail-seen.json");
  let seen: string[] = [];
  try { seen = JSON.parse(read(seenPath)) as string[]; } catch { /* none */ }
  const out: Told[] = [];
  const addr = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();
  for (const h of hs) {
    if (h.dir !== "sent" || seen.includes(h.id) || now - h.ts > 14 * DAY) continue;
    const self = addr(h.from);
    if (!h.to.some((t) => addr(t) === self)) continue;
    const m = /^\s*(?:tell|note|todo|to do|remind me)\s*:?\s*(.+)$/i.exec(h.subject);
    if (!m) continue;
    const body = /^remind me/i.test(h.subject.trim()) ? h.subject.trim() : /^(todo|to do)/i.test(h.subject.trim()) ? `todo: ${m[1]}` : m[1]!;
    try { out.push(await tell(vault, body, { surface: "email", now })); } catch { /* skip */ }
    seen.push(h.id);
  }
  mkdirSync(captureDir(vault), { recursive: true });
  writeFileSync(seenPath, JSON.stringify(seen.slice(-2000)));
  return out;
}

// ── CLI: prevail tell <text> [--domain d] [--mission m] [--surface s] | tell undo <id> | tell list | forgetting ──

export async function tellCommand(argv: string[], vault: string, sub0?: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    if (sub0 === "forgetting") { const f = await forgetting(vault); if (args.json) out(f); else console.log(forgettingText(f)); return 0; }
    const first = args.pos[0];
    if (first === "undo") { const r = await undoTold(vault, args.pos[1] ?? ""); if (args.json) out({ ok: true, told: r }); else console.log(`Undone: ${r.text}`); return 0; }
    if (first === "list") { const l = readTold(vault, Number(args.get("limit") ?? 20) || 20); if (args.json) out(l); else for (const r of l) console.log(`${r.undone ? "undone " : ""}${r.kind.padEnd(10)} ${r.where}: ${r.text}`); return 0; }
    if (first === "mail") { const r = await tellFromMail(vault); if (args.json) out(r); else console.log(`${r.length} filed from mail to yourself`); return 0; }
    const text = args.pos.join(" ") || args.get("text") || "";
    if (!text.trim()) return fail("usage: prevail tell <anything> [--domain d] [--mission m] [--surface s] | tell undo <id> | tell list | tell mail | forgetting");
    const surface = (["chat", "cli", "mcp", "telegram", "phone", "desktop", "email"].includes(args.get("surface") ?? "") ? args.get("surface") : "cli") as Surface;
    const r = await tell(vault, text, { surface, ...(args.get("domain") ? { domain: args.get("domain") } : {}), ...(args.get("mission") ? { mission: args.get("mission") } : {}) });
    if (args.json) out({ ok: true, told: r, reply: toldReply(r) }); else console.log(toldReply(r));
    return 0;
  } catch (e) { return fail((e as Error).message); }
}
