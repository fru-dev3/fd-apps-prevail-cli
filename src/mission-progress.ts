// Missions MS4: progress without data entry (missions-plan.md).
//
//   match        each active mission's match rules attribute what already
//                happens: calendar events whose title matches become linked
//                events (links.json, source matched) and mission.event events;
//                mail from a matching sender, mission.mail; card charges from
//                a matching merchant, a ledger line (by matched, the charge
//                referenced, counted once). Said in the mission's chat:
//                "practiced 30 min" is a stated session carrying the mission,
//                "paid $120 for lessons" a ledger line.
//   metrics      a mission's metrics are ordinary metrics.md lines with
//                ~mission:<slug>; proposals come from the outcome ("learn":
//                sessions and minutes; lessons from the calendar; "trip": days
//                to departure; "buy": viewings; "build": commits).
//   milestones   a ~check:<metric><op><n> completes itself from the metric's
//                total since the mission started.
//   calendar     link a matched event; create a hold (asks first, never
//                silent) or, with other people, a draft invite (never sent).
//   Compass      a mission linked to a path writes mission: <slug> under that
//                path line; a chosen path with an outcome and a date can start
//                a mission (missions create --from-path).
//   Today        each active mission's next milestone, due tasks and today's
//                linked events are candidates (at most one mission item a day
//                unless something is due).
//   radar        no activity for twice the cadence; a milestone at risk;
//                budget past 80%; the target passed.
//   nudges       spend the same three-a-week budget, at most nudges.per_week
//                per mission, never when muted or paused.
//   review       one line per active mission; more than seven asks to pause some.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activeMissions, createMission, linkEvent, missionDir, missionView, readLinks, readMilestones, readMission, setMission, spend, writeLinks, type Mission } from "./missions.ts";
import { metricsMdPath, readMachineEvents, type MetricEvent } from "./metrics.ts";
import { writeVersioned } from "./goals.ts";
import { parseModArgs } from "./cli-args.ts";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / DAY);
const hit = (pats: string[] | undefined, text: string) => (pats ?? []).some((p) => p && text.toLowerCase().includes(p.toLowerCase()));
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// ── Match: calendar, mail and charges to missions ───────────────────────────

export interface CalLite { id: string; title: string; start: string; end: string; all_day?: boolean; attendees?: number }
export interface MailLite { id: string; thread: string; ts: number; dir: "sent" | "received"; from: string; to: string[]; subject: string }
export interface ChargeLite { date: string; desc: string; usd: number; id?: string }

export interface MatchResult { slug: string; events: number; linked: number; charges: number; mail: number }

/** Attribute what already happens to the active missions. Pure inputs; writes links, ledger and events. */
export function matchMissions(vault: string, i: { now?: number; calendar?: CalLite[]; mail?: MailLite[]; charges?: ChargeLite[]; host?: string }): { results: MatchResult[]; events: MetricEvent[] } {
  const now = i.now ?? Date.now();
  const host = i.host ?? "host";
  const events: MetricEvent[] = [];
  const results: MatchResult[] = [];
  for (const m of activeMissions(vault)) {
    const r: MatchResult = { slug: m.slug, events: 0, linked: 0, charges: 0, mail: 0 };
    const from = m.start || m.created?.slice(0, 10) || ymd(now - 365 * DAY);
    // Calendar: matched events are linked (past and coming) and counted when they happened.
    const links = readLinks(vault, m.slug);
    for (const e of i.calendar ?? []) {
      if (!hit(m.match.calendar, e.title) || e.start.slice(0, 10) < from) continue;
      if (!links.calendar.some((c) => c.event === e.id)) { links.calendar.push({ app: "google-calendar", event: e.id, title: e.title.slice(0, 120), start: e.start, source: "matched" }); r.linked++; }
      const s = Date.parse(e.start); const en = Date.parse(e.end);
      if (s <= now && !e.all_day) { events.push({ ts: ymd(s), src: "missions", kind: "mission.event", n: 1, host, tier: "measured", attrs: { mission: m.slug, hours: en > s ? Math.round(((en - s) / 3_600_000) * 100) / 100 : 0 } }); r.events++; }
    }
    links.calendar.sort((a, b) => a.start.localeCompare(b.start));
    if (r.linked) writeLinks(vault, m.slug, links);
    // Mail from a matching sender (or to one): counted, never read.
    for (const h of i.mail ?? []) {
      const who = h.dir === "received" ? [h.from] : h.to;
      if (!who.some((a) => hit(m.match.email_from, a)) || ymd(h.ts) < from) continue;
      events.push({ ts: ymd(h.ts), src: "missions", kind: h.dir === "received" ? "mission.mail_in" : "mission.mail_out", n: 1, host, tier: "measured", attrs: { mission: m.slug } });
      r.mail++;
    }
    // Card charges from a matching merchant: a ledger line with the charge referenced, once.
    for (const c of i.charges ?? []) {
      if (!hit(m.match.merchants, c.desc) || c.date < from || !(c.usd > 0)) continue;
      const line = m.budget.lines.find((l) => c.desc.toLowerCase().includes(l.label.toLowerCase()) || c.desc.toLowerCase().includes(l.id))?.id ?? m.budget.lines[0]?.id ?? "other";
      const out = spend(vault, m.slug, { line, usd: c.usd, what: c.desc.slice(0, 80), ref: `charge:${c.id ?? hash(`${c.date}|${c.desc}|${c.usd}`)}`, by: "matched" }, Date.parse(`${c.date}T12:00:00`));
      if (out.added) r.charges++;
    }
    results.push(r);
  }
  return { results, events };
}

/** Run the match over everything this Mac has: calendar events, mail headers, card statements. */
export async function syncMissions(vault: string, now = Date.now()): Promise<MatchResult[]> {
  if (!activeMissions(vault).length) return [];
  const ss = await import("./source-sync.ts");
  const am = await import("./app-money.ts");
  const m = await import("./metrics.ts");
  let calendar: CalLite[] = []; let mail: MailLite[] = []; let charges: ChargeLite[] = [];
  try { calendar = ss.readCalendarEvents(vault); } catch { /* none */ }
  try { mail = ss.readMailHeaders(vault); } catch { /* none */ }
  try { charges = am.cardCharges(vault).map((c) => ({ date: c.date, desc: c.raw || c.merchant, usd: c.usd, id: c.id })); } catch { /* none */ }
  const host = m.hostSlug();
  const r = matchMissions(vault, { now, calendar, mail, charges, host });
  ss.writeSourceEvents(vault, "missions", r.events, host, now);
  return r.results;
}

// ── Said in the mission's chat ──────────────────────────────────────────────

/** "paid $120 for the term fee" in a mission's chat becomes a ledger line (by user, the chat referenced, once). */
export function missionSaid(vault: string, slug: string, text: string, thread: string, now = Date.now()): { spent?: number } {
  const m = readMission(vault, slug);
  if (!m) return {};
  const pay = /\b(paid|spent|bought [^$]{0,40}for)\s+(?:about\s+)?\$\s?([\d,]+(?:\.\d{1,2})?)(?:\s+(?:for|on)\s+([^.!?\n]{2,60}))?/i.exec(text);
  if (!pay) return {};
  const usd = Number(pay[2]!.replace(/,/g, ""));
  if (!(usd > 0)) return {};
  const what = (pay[3] ?? text).trim();
  const line = m.budget.lines.find((l) => what.toLowerCase().includes(l.label.toLowerCase()) || what.toLowerCase().includes(l.id))?.id ?? "other";
  const r = spend(vault, slug, { line, usd, what: what.slice(0, 80), ref: `chat:${thread.slice(0, 40)}:${hash(text)}`, by: "user" }, now);
  return r.added ? { spent: usd } : {};
}

// ── Mission metrics: proposals from the outcome, tracked as ~mission lines ──

export interface MissionMetricProposal { key: string; id: string; title: string; line: string; why: string }

/** What a mission like this one usually counts, from the outcome's verb, as metrics.md lines. */
export function missionMetricProposals(m: Mission): MissionMetricProposal[] {
  const verb = /^(\w+)/.exec(m.outcome.toLowerCase() || m.name.toLowerCase())?.[1] ?? "";
  const s = m.slug.slice(0, 40);
  const P = (suffix: string, title: string, tokens: string, from: string, why: string): MissionMetricProposal => ({ key: `${s}:${suffix}`, id: `m-${s}-${suffix}`, title, line: `- ${title} ~id:m-${s}-${suffix} ~per:week ${tokens} ~mission:${m.slug}\n  from: ${from}`, why });
  const lessons = (m.match.calendar ?? []).length ? [P("events", `${m.name}: calendar sessions`, "~unit:count ~tier:measured ~src:missions ~kind:mission.event", "calendar events that match the project", "the lessons or sessions on your calendar")] : [];
  if (/^(learn|train|practice|practise|prepare|study)/.test(verb) || /\b(learn|practice|lessons?)\b/i.test(m.outcome)) {
    return [
      P("sessions", `${m.name}: practice sessions`, "~unit:count ~tier:asked ~src:stated ~kind:stated.practiced", "\"practiced 30 min\" said in the project's chat", "sessions, from what you say in the project's chat"),
      P("minutes", `${m.name}: practice minutes`, "~unit:minutes ~tier:asked ~src:stated ~kind:stated.practiced ~value:value", "the minutes in \"practiced 30 min\"", "minutes a week, from the same lines"),
      ...lessons,
    ];
  }
  if (/^(travel|plan|visit|trip|go)/.test(verb)) return [...lessons, P("mail", `${m.name}: booking mail`, "~unit:count ~tier:measured ~src:missions ~kind:mission.mail_in", "mail from the project's senders (airlines, hotels)", "confirmations from the places you booked")];
  if (/^(buy|find|move)/.test(verb)) return [...lessons, P("viewings", `${m.name}: viewings`, "~unit:count ~tier:measured ~src:missions ~kind:mission.event", "calendar events that match the project", "viewings on your calendar")];
  if (/^(build|ship|make|write)/.test(verb)) return [P("commits", `${m.name}: commits`, "~unit:count ~tier:measured ~src:git ~kind:git.commit", "commits in the project's repos", "commits, from git")];
  return lessons;
}

/** Track a proposal: its line goes under ## Tracking in metrics.md (once), and the mission lists it. */
export function trackMissionMetric(vault: string, slug: string, key: string, now = Date.now()): string {
  const m = readMission(vault, slug);
  if (!m) throw new Error(`no project ${slug}`);
  const p = missionMetricProposals(m).find((x) => x.key === key);
  if (!p) throw new Error(`no proposal ${key}`);
  const file = metricsMdPath(vault);
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "# Metrics\n\n## Pinned\n\n## Tracking\n";
  if (!cur.includes(`~id:${p.id} `)) {
    const next = /^## Tracking\s*$/m.test(cur) ? cur.replace(/^(## Tracking\s*\n)/m, `$1${p.line}\n`) : `${cur.replace(/\s*$/, "\n")}\n## Tracking\n${p.line}\n`;
    mkdirSync(join(file, ".."), { recursive: true });
    writeVersioned(file, next, now);
  }
  if (!m.metrics.includes(p.id)) setMission(vault, slug, { metrics: [...m.metrics, p.id] }, now);
  return p.id;
}

/** A metric's total since the mission started, from computed points (for milestone ~check). */
export function totalSince(points: Record<string, { date: string; value: number }[]>, metric: string, from: string): number | null {
  const pts = points[metric];
  if (!pts) return null;
  return Math.round(pts.filter((p) => p.date >= from).reduce((a, p) => a + p.value, 0) * 100) / 100;
}

/**
 * Routines a mission built that should outlive it (drafted for the close-out):
 * anything the mission's events show at least once a week over its last four
 * weeks ("Practice sessions: about 3 a week").
 */
export function routineDrafts(vault: string, slug: string, now = Date.now()): string[] {
  const from = ymd(now - 28 * DAY);
  const by = new Map<string, number>();
  for (const e of readMachineEvents(vault, from).events) if (e.attrs.mission === slug) by.set(e.kind, (by.get(e.kind) ?? 0) + e.n);
  const NAME: Record<string, string> = { "stated.practiced": "Practice sessions", "mission.event": "Sessions on the calendar" };
  return [...by].filter(([k, n]) => n >= 4 && NAME[k]).map(([k, n]) => `${NAME[k]}: about ${Math.round(n / 4)} a week`);
}

// ── Calendar holds and drafts ───────────────────────────────────────────────

export interface PendingEvent { id: string; title: string; start: string; end?: string; attendees: string[]; status: "ask" | "draft" | "created" | "declined"; note?: string; ts: number }
const pendingPath = (vault: string, slug: string) => join(missionDir(vault, slug), "memory", "calendar-pending.jsonl");

export function readPending(vault: string, slug: string): PendingEvent[] {
  const by = new Map<string, PendingEvent>();
  try { for (const l of readFileSync(pendingPath(vault, slug), "utf8").split("\n")) { if (!l.trim()) continue; const e = JSON.parse(l) as PendingEvent; by.set(e.id, { ...by.get(e.id), ...e }); } } catch { /* none */ }
  return [...by.values()];
}

/**
 * Create an event for a mission. A hold on the user's own calendar asks first
 * (it is reversible and free, but others see busy time); with other people it
 * is a draft invite and never sent by Prevail. Nothing touches a calendar here.
 */
export function createEvent(vault: string, slug: string, e: { title: string; start: string; end?: string; attendees?: string[]; milestone?: string }, now = Date.now()): PendingEvent {
  if (Number.isNaN(Date.parse(e.start))) throw new Error(`start must be a date or time, not "${e.start}"`);
  const p: PendingEvent = { id: `pending-${hash(`${slug}|${e.title}|${e.start}`)}`, title: e.title.slice(0, 120), start: e.start, ...(e.end ? { end: e.end } : {}), attendees: (e.attendees ?? []).slice(0, 20), status: e.attendees?.length ? "draft" : "ask", ts: now };
  mkdirSync(join(pendingPath(vault, slug), ".."), { recursive: true });
  appendFileSync(pendingPath(vault, slug), `${JSON.stringify(p)}\n`);
  linkEvent(vault, slug, { event: p.id, title: p.title, start: p.start, kind: p.status === "draft" ? "draft invite" : "hold", create: true, ...(e.milestone ? { milestone: e.milestone } : {}) }, now);
  return p;
}

/**
 * The user's yes on a hold: put it on their own calendar (tentative). Runs the
 * injected writer (the gws CLI by default); a draft with other people is
 * never created. When the calendar cannot be reached it stays waiting.
 */
export async function approveEvent(vault: string, slug: string, id: string, write?: (e: PendingEvent) => Promise<{ ok: boolean; id?: string; error?: string }>, now = Date.now()): Promise<PendingEvent> {
  const p = readPending(vault, slug).find((x) => x.id === id);
  if (!p) throw new Error(`no pending event ${id}`);
  if (p.status === "draft") throw new Error("an event with other people stays a draft; send the invite yourself");
  if (p.status !== "ask") return p;
  const r = await (write ?? gwsHold)(p);
  const next: PendingEvent = r.ok ? { ...p, status: "created", ts: now, ...(r.id ? { note: `calendar event ${r.id}` } : {}) } : { ...p, ts: now, note: `not created: ${r.error ?? "the calendar could not be reached"}` };
  appendFileSync(pendingPath(vault, slug), `${JSON.stringify(next)}\n`);
  if (r.ok && r.id) { const l = readLinks(vault, slug); const c = l.calendar.find((x) => x.event === id); if (c) { c.event = r.id; writeLinks(vault, slug, l); } }
  return next;
}

/** A tentative hold on the user's own primary calendar through the gws CLI (Today T5 holds use it too). */
export async function gwsHold(e: PendingEvent): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const cs = await import("./calendar-sync.ts");
    const gws = cs.resolveGwsBinary();
    if (!gws) return { ok: false, error: "no Google calendar is connected on this Mac" };
    const end = e.end ?? new Date(Date.parse(e.start) + 3_600_000).toISOString();
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(gws, ["calendar", "events", "insert", "--params", JSON.stringify({ calendarId: "primary" }), "--json", JSON.stringify({ summary: e.title, start: { dateTime: new Date(e.start).toISOString() }, end: { dateTime: new Date(end).toISOString() }, status: "tentative", transparency: "opaque" })], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "the calendar refused").slice(0, 160) };
    try { return { ok: true, id: String((JSON.parse(r.stdout) as { id?: string }).id ?? "") || undefined }; } catch { return { ok: true }; }
  } catch (err) { return { ok: false, error: String(err).slice(0, 160) }; }
}

// ── The Compass: path links, and missions from paths ────────────────────────

/** Write mission: <slug> under the path line the mission carries out (versioned, logged). */
export async function linkPath(vault: string, slug: string, pathId: string, now = Date.now()): Promise<boolean> {
  const c = await import("./compass.ts");
  const doc = c.readCompass(vault);
  const f = c.findById(doc, pathId);
  if (!f.path || !f.parent) throw new Error(`no path ${pathId} in the Compass`);
  const cur = f.path.fields.find((x) => x.key === "mission");
  if (cur?.value === slug) return false;
  if (cur) cur.value = slug; else f.path.fields.push({ key: "mission", value: slug });
  f.parent.dirty = true;
  c.saveCompass(vault, doc, [{ id: pathId, from: "path", to: `project ${slug}`, reason: "the project carries out this path", by: "user" }], now);
  return true;
}

/** A chosen path with an outcome and a date can start a mission (the user's yes is the call). */
export async function missionFromPath(vault: string, pathId: string, now = Date.now()) {
  const c = await import("./compass.ts");
  const doc = c.readCompass(vault);
  const f = c.findById(doc, pathId);
  if (!f.path || !f.parent) throw new Error(`no path ${pathId} in the Compass`);
  const g = f.parent;
  const target = f.path.tokens.until ?? g.tokens.due;
  const view = createMission(vault, { name: f.path.title, outcome: `${f.path.title}, toward ${g.title}`, ...(target ? { target } : {}), ...(g.tokens.domain ? { domains: [{ slug: g.tokens.domain, role: "owner" as const }] } : {}), goal: g.id, path: pathId, from: `compass path ${pathId}`, now });
  await linkPath(vault, view.slug, pathId, now);
  return missionView(vault, view.slug, now)!;
}

// ── Today, the radar, nudges and the review ─────────────────────────────────

export interface MissionTodayItem { key: string; slug: string; name: string; title: string; due?: string; why: string; kind: "milestone" | "task" | "event"; serves: string[]; goal?: string }

/** Candidates for Today: each active mission's next milestone (within a week or overdue), its due tasks, today's linked events. */
export function missionToday(vault: string, date: string): MissionTodayItem[] {
  const out: MissionTodayItem[] = [];
  for (const m of activeMissions(vault)) {
    const base = { slug: m.slug, name: m.name, serves: m.serves, ...(m.goal ? { goal: m.goal } : {}) };
    const next = readMilestones(vault, m.slug).filter((x) => !x.done && x.due).sort((a, b) => a.due!.localeCompare(b.due!))[0];
    if (next && days(date, next.due!) <= 7) out.push({ ...base, key: `mission:${m.slug}:${next.id}`, kind: "milestone", title: `${m.name}: ${next.title}`, due: next.due, why: days(date, next.due!) < 0 ? `milestone ${-days(date, next.due!)} days late` : `milestone due ${days(date, next.due!) === 0 ? "today" : `in ${days(date, next.due!)} days`}` });
    for (const l of (existsSync(join(missionDir(vault, m.slug), "memory", "tasks.md")) ? readFileSync(join(missionDir(vault, m.slug), "memory", "tasks.md"), "utf8") : "").split("\n")) {
      const t = /^\s*- \[ \]\s+(.*?)\s@(\d{4}-\d{2}-\d{2})/.exec(l);
      if (!t || days(date, t[2]!) > 3) continue;
      out.push({ ...base, key: `mission:${m.slug}:task:${/~id:(\S+)/.exec(l)?.[1] ?? hash(t[1]!)}`, kind: "task", title: `${m.name}: ${t[1]!.replace(/\s+[~+]\S+/g, "")}`, due: t[2], why: days(date, t[2]!) < 0 ? `${-days(date, t[2]!)} days overdue` : "due soon" });
    }
    for (const e of readLinks(vault, m.slug).calendar.filter((c) => c.start.slice(0, 10) === date)) out.push({ ...base, key: `mission:${m.slug}:event:${e.event}`, kind: "event", title: `${m.name}: ${e.title} at ${e.start.slice(11, 16) || "today"}`, due: date, why: "on your calendar today" });
  }
  return out;
}

export interface MissionRadarItem { key: string; kind: "mission"; domain: string; mission: string; text: string; evidence: string; due?: string; severity: number }

const CADENCE_DAYS: Record<string, number> = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };

/** The radar's mission rules: gone quiet, a milestone at risk, budget past 80%, the target passed. */
export function missionRadar(vault: string, now = Date.now()): MissionRadarItem[] {
  const out: MissionRadarItem[] = [];
  const today = ymd(now);
  for (const m of activeMissions(vault)) {
    const v = missionView(vault, m.slug, now);
    if (!v) continue;
    const owner = m.domains.find((d) => d.role === "owner")?.slug ?? "general";
    const base = { kind: "mission" as const, domain: owner, mission: m.slug };
    const dir = missionDir(vault, m.slug);
    let last = 0;
    for (const rel of ["memory/log.md", "memory/threads", "memory/ledger.jsonl", "milestones.md", "memory/tasks.md", "links.json"]) { try { last = Math.max(last, statSync(join(dir, rel)).mtimeMs); } catch { /* absent */ } }
    const every = CADENCE_DAYS[m.cadence] ?? 7;
    if (last && now - last > 2 * every * DAY) out.push({ ...base, key: `mission:${m.slug}:quiet`, text: `${m.name} has gone quiet`, evidence: `nothing since ${ymd(last)}; its rhythm is ${m.cadence}`, severity: 2 });
    const p = v.progress;
    if (p.days.total > 0 && p.milestones.total > 0) {
      const leftShare = 1 - p.milestones.share;
      const timeLeft = Math.max(0, p.days.left) / p.days.total;
      if (leftShare - timeLeft > 0.34 && p.days.left >= 0) out.push({ ...base, key: `mission:${m.slug}:pace`, text: `${m.name}: milestones behind the calendar`, evidence: `${Math.round(p.milestones.share * 100)}% of the milestones done with ${Math.round(timeLeft * 100)}% of the time left`, severity: 3 });
    }
    for (const o of p.milestones.overdue) out.push({ ...base, key: `mission:${m.slug}:${o.id}`, text: `${m.name}: ${o.title} is late`, evidence: `due ${o.due}`, due: o.due, severity: 3 });
    if (p.budget.planned && p.budget.used / p.budget.planned >= 0.8) out.push({ ...base, key: `mission:${m.slug}:budget`, text: `${m.name}: ${Math.round((p.budget.used / p.budget.planned) * 100)}% of the budget used`, evidence: `$${p.budget.used} of $${p.budget.planned}`, severity: p.budget.used > p.budget.planned ? 4 : 2 });
    if (m.target && m.target < today) out.push({ ...base, key: `mission:${m.slug}:target`, text: `${m.name} passed its target (${m.target}): extend, complete or pause?`, evidence: `target ${m.target}`, due: m.target, severity: 3 });
  }
  return out;
}

/** Mission nudges: at most per_week each, inside the global three a week; never muted or paused ones. */
export async function missionNudges(vault: string, items: MissionRadarItem[], now = Date.now()): Promise<{ key: string; ok: boolean; why?: string }[]> {
  const { tryInterrupt, readInterruptions } = await import("./interruptions.ts");
  const { weekOf, dayOf } = await import("./metrics.ts");
  const out: { key: string; ok: boolean; why?: string }[] = [];
  const week = weekOf(dayOf(now));
  for (const x of items.filter((i) => i.severity >= 3)) {
    const m = readMission(vault, x.mission);
    if (!m || m.status !== "active" || m.nudges.muted) continue;
    const sent = readInterruptions(vault).filter((r) => r.sent && r.kind === "mission-nudge" && (r.key ?? "").startsWith(`mission:${m.slug}:`) && weekOf(dayOf(r.ts)) === week).length;
    if (sent >= Math.max(0, m.nudges.per_week)) { out.push({ key: x.key, ok: false, why: "this project's nudges this week are used" }); continue; }
    const t = tryInterrupt(vault, { kind: "mission-nudge", text: `${x.text} (${x.evidence})`, key: x.key }, now);
    out.push({ key: x.key, ok: t.ok, ...(t.why ? { why: t.why } : {}) });
  }
  return out;
}

/** The weekly review's line per active mission (and a question when there are too many). */
export function missionReviewLines(vault: string, now = Date.now()): string[] {
  const ms = activeMissions(vault);
  const lines = ms.map((m) => {
    const v = missionView(vault, m.slug, now)!;
    const p = v.progress;
    return `${m.name}: day ${p.days.day} of ${p.days.total}, ${p.milestones.done} of ${p.milestones.total} milestones${p.budget.planned ? `, $${p.budget.used} of $${p.budget.planned}` : ""}${p.milestones.next ? `; next: ${p.milestones.next.title}${p.milestones.next.due ? ` by ${p.milestones.next.due}` : ""}` : ""}.`;
  });
  if (ms.length > 7) lines.push(`${ms.length} projects are active. Pause some?`);
  return lines;
}

// ── CLI: prevail missions sync|metrics|track|event-create|event-approve|link-path|from-path ──

export async function progressCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (args.json) out({ ok: false, error: msg }); else console.error(msg); return 1; };
  const slug = args.pos[1] ?? "";
  try {
    if (sub === "sync") { const r = await syncMissions(vault); if (args.json) out(r); else for (const x of r) console.log(`${x.slug}: ${x.linked} events linked, ${x.events} counted, ${x.mail} mails, ${x.charges} charges`); return 0; }
    if (sub === "metrics") { const m = readMission(vault, slug); if (!m) return fail(`no project ${slug}`); const p = missionMetricProposals(m); if (args.json) out(p); else for (const x of p) console.log(`${x.key}  ${x.title}: ${x.why}`); return 0; }
    if (sub === "track") { const id = trackMissionMetric(vault, slug, args.pos[2] ?? ""); if (args.json) out({ ok: true, id }); else console.log(`Tracking ${id}`); return 0; }
    if (sub === "event-create") { const e = createEvent(vault, slug, { title: args.get("title") ?? "", start: args.get("start") ?? "", end: args.get("end"), attendees: args.get("attendees")?.split(",").map((x) => x.trim()).filter(Boolean), milestone: args.get("milestone") }); if (args.json) out(e); else console.log(e.status === "draft" ? "Drafted the invite (with other people it is never sent by Prevail)." : "A hold waits for your yes."); return 0; }
    if (sub === "event-approve") { const e = await approveEvent(vault, slug, args.pos[2] ?? ""); if (args.json) out(e); else console.log(e.status === "created" ? "On your calendar." : e.note ?? e.status); return 0; }
    if (sub === "events-pending") { const p = readPending(vault, slug); if (args.json) out(p); else for (const e of p) console.log(`${e.status.padEnd(8)} ${e.start} ${e.title}`); return 0; }
    if (sub === "link-path") { const ok = await linkPath(vault, slug, args.pos[2] ?? ""); if (args.json) out({ ok: true, changed: ok }); else console.log(ok ? "Linked." : "Already linked."); return 0; }
    if (sub === "from-path") { const v = await missionFromPath(vault, args.pos[1] ?? ""); if (args.json) out(v); else console.log(`Started ${v.id}`); return 0; }
    if (sub === "radar") { const r = missionRadar(vault); if (args.json) out(r); else for (const x of r) console.log(`${x.text} (${x.evidence})`); return 0; }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail projects sync | metrics <slug> | track <slug> <key> | event-create <slug> --title T --start ISO [--end ISO] [--attendees a,b] | event-approve <slug> <id> | events-pending <slug> | link-path <slug> <path-id> | from-path <path-id> | radar [--json]");
}
