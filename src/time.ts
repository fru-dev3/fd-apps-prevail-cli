// Today T5: time follows values (today-plan.md, "5. Time").
//
// From the calendar events kept on this Mac (build/_meta/calendar/, the
// stored shape the Google reader writes), code:
//   - files each event under a value: a mission's match rule, then a domain's
//     routing keywords, then family words; through the Compass goals that
//     live in that domain, up to the values they serve. The rest "serves
//     nothing named";
//   - a week: hours by value against the value's rank (rank-order centroid
//     shares), meetings, focus and after-hours hours;
//   - next week against capacity (## Capacity meeting_hours_wk, default 20,
//     and hours_for_goals_wk beside the chosen initiatives' hours), warned in
//     advance on the weekly review;
//   - proposals: a protected block in a free weekday slot for each of
//     Today's three and each chosen initiative. A hold on the user's own
//     calendar asks by default (others see busy time); build/chief-of-
//     staff.md `holds: alone` lets them run alone. Declines for meetings that
//     serve nothing are drafts, never sent.
// No calendar on this Mac (Google sign-in down) says so by name.

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { calendarDir, readCalendarEvents, type CalEvent } from "./source-sync.ts";
import { dayOf, weekOf } from "./metrics.ts";
import { parseModArgs } from "./cli-args.ts";

const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const timeDir = (vault: string) => join(runtimePath(vault, "_meta"), "time");
const FAMILY = /\b(family|kids?|son|daughter|wife|husband|partner|mom|dad|parents|date night|dinner at home|school|recital|birthday|anniversary)\b/i;
const FOCUS = /\b(focus|deep work|heads[ -]down|no meetings|maker time|writing block|build time)\b/i;

export interface Classified { value?: string; domain?: string; mission?: string; kind: "mission" | "domain" | "family" | "focus" | "none" }
export interface Lens { missions: { slug: string; patterns: string[]; owner?: string; goal?: string }[]; keywords: { domain: string; words: string[] }[]; domainValues: Map<string, string[]>; goalValues: Map<string, string[]>; familyValue?: string; values: { id: string; title: string; rank: number }[] }

/** What the classifier reads: missions' match rules, domains' routing keywords, the Compass (confirmed lines only). */
export async function lensOf(vault: string): Promise<Lens> {
  const keywords: Lens["keywords"] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    try { const j = JSON.parse(readFileSync(join(resolveDomainDir(vault, d), "manifest.json"), "utf8")) as { routing?: { keywords?: string[] } }; const w = (j.routing?.keywords ?? []).map((x) => String(x).toLowerCase()).filter((x) => x.length >= 3); if (w.length) keywords.push({ domain: d, words: w }); } catch { /* no manifest */ }
  }
  const missions: Lens["missions"] = [];
  try {
    const m = await import("./missions.ts");
    for (const x of m.activeMissions(vault)) missions.push({ slug: x.slug, patterns: (x.match.calendar ?? []).map((p) => p.toLowerCase()), owner: m.ownerOf(x), ...(x.goal ? { goal: x.goal } : {}) });
  } catch { /* no missions */ }
  const domainValues = new Map<string, string[]>();
  const goalValues = new Map<string, string[]>();
  const values: Lens["values"] = [];
  let familyValue: string | undefined;
  try {
    const c = await import("./compass.ts");
    const doc = c.readCompass(vault);
    for (const [i, v] of c.items(doc, "value").filter((x) => !c.isProposed(x)).entries()) {
      values.push({ id: v.id, title: v.title, rank: Number(v.tokens.rank ?? i + 1) });
      if (!familyValue && /family|presence|parent|father|mother|kids|home/i.test(v.title)) familyValue = v.id;
    }
    for (const g of c.items(doc, "goal").filter((x) => !c.isProposed(x))) {
      const vs = (g.tokens.serves ?? "").split(",").filter(Boolean);
      goalValues.set(g.id, vs);
      if (g.tokens.domain) domainValues.set(g.tokens.domain, [...new Set([...(domainValues.get(g.tokens.domain) ?? []), ...vs])]);
    }
  } catch { /* no Compass */ }
  values.sort((a, b) => a.rank - b.rank);
  return { missions, keywords, domainValues, goalValues, ...(familyValue ? { familyValue } : {}), values };
}

export function classify(e: Pick<CalEvent, "title" | "calendar" | "focus">, lens: Lens): Classified {
  const t = e.title.toLowerCase();
  const ms = lens.missions.find((m) => m.patterns.some((p) => p && t.includes(p)));
  if (ms) {
    const v = (ms.goal ? lens.goalValues.get(ms.goal) : undefined)?.[0] ?? (ms.owner ? lens.domainValues.get(ms.owner)?.[0] : undefined);
    return { kind: "mission", mission: ms.slug, ...(ms.owner ? { domain: ms.owner } : {}), ...(v ? { value: v } : {}) };
  }
  const kw = lens.keywords.find((k) => k.words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)));
  if (kw) { const v = lens.domainValues.get(kw.domain)?.[0]; return { kind: "domain", domain: kw.domain, ...(v ? { value: v } : {}) }; }
  if (FAMILY.test(e.title) || /family|home|kids/i.test(e.calendar)) return { kind: "family", ...(lens.familyValue ? { value: lens.familyValue } : {}) };
  if (e.focus || FOCUS.test(e.title)) return { kind: "focus" };
  return { kind: "none" };
}

const hoursOf = (e: CalEvent) => Math.max(0, Math.min(12, (Date.parse(e.end) - Date.parse(e.start)) / 3_600_000));
const counts = (e: CalEvent) => !e.all_day && e.self_response !== "declined" && hoursOf(e) > 0;

export interface Capacity { meetingHours: number; goalHours: number; workHours: number }
export async function capacityFor(vault: string): Promise<Capacity & { initiativeHours: number }> {
  let meeting = 20; let goals = 10; let work = 40; let init = 0;
  try {
    const c = await import("./compass.ts");
    const ca = await import("./compass-align.ts");
    const doc = c.readCompass(vault);
    for (const it of c.items(doc, "capacity")) {
      const m = /^([a-z_]+)\s*:\s*(\d+(?:\.\d+)?)/i.exec(it.title);
      if (!m) continue;
      const k = m[1]!.toLowerCase();
      if (k === "meeting_hours_wk") meeting = Number(m[2]); else if (k === "hours_for_goals_wk") goals = Number(m[2]); else if (k === "work_hours_wk") work = Number(m[2]);
    }
    init = ca.activePaths(doc).reduce((a, p) => a + p.hours, 0);
  } catch { /* defaults */ }
  return { meetingHours: meeting, goalHours: goals, workHours: work, initiativeHours: init };
}

export interface WeekTime {
  week: string; connected: boolean; note?: string;
  hours: number; meetings: number; focus: number; afterHours: number;
  byValue: { id: string; title: string; rank: number; hours: number; share: number; expected: number }[];
  unlinked: number; family: number;
  lines: string[];
}

function inWeek(e: CalEvent, week: string): boolean { return weekOf(dayOf(Date.parse(e.start))) === week; }

export function weekTimeWith(events: CalEvent[], lens: Lens, week: string): WeekTime {
  const evs = events.filter((e) => counts(e) && inWeek(e, week));
  let hours = 0; let meetings = 0; let focus = 0; let after = 0; let unlinked = 0; let family = 0;
  const byV = new Map<string, number>();
  for (const e of evs) {
    const h = hoursOf(e);
    hours += h;
    const d = new Date(Date.parse(e.start));
    if (e.attendees > 0) { meetings += h; const hh = d.getHours() + d.getMinutes() / 60; if (hh < 8 || hh >= 18 || d.getDay() === 0 || d.getDay() === 6) after += h; }
    const c = classify(e, lens);
    if (c.kind === "focus") focus += h;
    if (c.kind === "family") family += h;
    if (c.value) byV.set(c.value, (byV.get(c.value) ?? 0) + h);
    else if (c.kind === "none") unlinked += h;
  }
  const n = lens.values.length;
  const expected = new Map(lens.values.map((v, i) => { let s = 0; for (let k = i + 1; k <= n; k++) s += 1 / k; return [v.id, s / n]; }));
  const byValue = lens.values.map((v) => ({ id: v.id, title: v.title, rank: v.rank, hours: r1(byV.get(v.id) ?? 0), share: Math.round(((byV.get(v.id) ?? 0) / (hours || 1)) * 100), expected: Math.round((expected.get(v.id) ?? 0) * 100) }));
  const lines: string[] = [];
  for (const v of byValue.slice(0, 3)) if (hours > 0 && v.expected - v.share >= 15) lines.push(`You rank ${v.title} ${v.rank === 1 ? "first" : `number ${v.rank}`}; it got ${v.share}% of your calendar hours.`);
  if (hours > 0 && unlinked / hours >= 0.4) lines.push(`${Math.round((unlinked / hours) * 100)}% of the calendar served nothing your Compass names.`);
  return { week, connected: true, hours: r1(hours), meetings: r1(meetings), focus: r1(focus), afterHours: r1(after), byValue, unlinked: r1(unlinked), family: r1(family), lines };
}

export function calendarConnected(vault: string): boolean {
  try { return readdirSync(calendarDir(vault)).some((f) => f.startsWith("events.") && f.endsWith(".json")); } catch { return false; }
}
const NOT_CONNECTED = "No calendar is connected on this Mac (Google sign-in), so time by value waits for it.";

export async function weekTime(vault: string, o: { now?: number; next?: boolean } = {}): Promise<WeekTime> {
  const now = o.now ?? Date.now();
  const week = weekOf(dayOf(now + (o.next ? 7 * DAY : 0)));
  if (!calendarConnected(vault)) return { week, connected: false, note: NOT_CONNECTED, hours: 0, meetings: 0, focus: 0, afterHours: 0, byValue: [], unlinked: 0, family: 0, lines: [] };
  return weekTimeWith(readCalendarEvents(vault), await lensOf(vault), week);
}

/** Next week against capacity: a warning before the week starts, or null. */
export function capacityWarning(next: WeekTime, cap: Capacity & { initiativeHours: number }): string | null {
  if (!next.connected) return null;
  const free = cap.workHours - next.meetings;
  const need = Math.max(cap.goalHours, cap.initiativeHours);
  if (next.meetings > cap.meetingHours) return `Next week has ${next.meetings} hours of meetings, over your ${cap.meetingHours}; that leaves ${Math.max(0, r1(free))} of ${cap.workHours} hours for everything else.`;
  if (free < need) return `Next week leaves ${Math.max(0, r1(free))} free hours; your goals and initiatives want ${need}.`;
  return null;
}

// ── Protected blocks (holds) and drafted declines ───────────────────────────

export interface Hold { id: string; title: string; start: string; end: string; for: string; status: "ask" | "created" | "declined" | "failed"; note?: string; ts: number }
export interface DeclineDraft { id: string; event: string; title: string; start: string; to: string; body: string; ts: number }
const holdsPath = (vault: string) => join(timeDir(vault), "holds.jsonl");
const declinesPath = (vault: string) => join(timeDir(vault), "declines.jsonl");

function lastById<T extends { id: string }>(p: string): T[] {
  const by = new Map<string, T>();
  try { for (const l of readFileSync(p, "utf8").split("\n")) { try { if (l.trim()) { const x = JSON.parse(l) as T; by.set(x.id, { ...by.get(x.id), ...x }); } } catch { /* torn */ } } } catch { /* none */ }
  return [...by.values()];
}
export const readHolds = (vault: string) => lastById<Hold>(holdsPath(vault));
export const readDeclines = (vault: string) => lastById<DeclineDraft>(declinesPath(vault));
function append(p: string, row: unknown) { mkdirSync(join(p, ".."), { recursive: true }); appendFileSync(p, `${JSON.stringify(row)}\n`); }

/** The first free hour-long weekday slot (9:00 to 17:00) in a week, not overlapping any event or earlier hold. */
export function freeSlot(events: CalEvent[], taken: { start: string; end: string }[], week: string, hours = 1.5, now = 0): { start: string; end: string } | null {
  const busy = [...events.filter(counts), ...taken].map((e) => [Date.parse(e.start), Date.parse(e.end)] as const);
  const monday = new Date(`${week}T00:00:00`);
  for (let d = 0; d < 5; d++) for (let h = 9; h + hours <= 17; h += 0.5) {
    const s = new Date(monday); s.setDate(monday.getDate() + d); s.setHours(Math.floor(h), (h % 1) * 60, 0, 0);
    const st = s.getTime(); const en = st + hours * 3_600_000;
    if (st < now) continue;
    if (busy.some(([a, b]) => st < b && en > a)) continue;
    return { start: s.toISOString(), end: new Date(en).toISOString() };
  }
  return null;
}

/**
 * Propose protected blocks for next week: one for each of Today's three and
 * each chosen initiative with hours. Each is a hold that asks (or runs alone
 * when the owner said so). Declines are drafted for next week's meetings
 * that serve nothing named. Proposing twice does not double anything.
 */
export async function proposeTime(vault: string, o: { now?: number; write?: (h: Hold) => Promise<{ ok: boolean; error?: string }> } = {}): Promise<{ holds: Hold[]; declines: DeclineDraft[] }> {
  const now = o.now ?? Date.now();
  if (!calendarConnected(vault)) return { holds: [], declines: [] };
  const week = weekOf(dayOf(now + 7 * DAY));
  const events = readCalendarEvents(vault);
  const lens = await lensOf(vault);
  const have = readHolds(vault);
  const wants: { for: string; title: string; hours: number }[] = [];
  try { const t = await import("./today.ts"); for (const x of t.composeToday(vault, { now }).items) wants.push({ for: `today:${x.key}`, title: `Focus: ${x.title}`.slice(0, 120), hours: 1.5 }); } catch { /* no card */ }
  try { const ca = await import("./compass-align.ts"); const c = await import("./compass.ts"); for (const p of ca.activePaths(c.readCompass(vault)).filter((x) => x.hours > 0)) wants.push({ for: `initiative:${p.id}`, title: `${p.title} (${p.goalTitle})`.slice(0, 120), hours: Math.min(3, Math.max(1, p.hours / 2)) }); } catch { /* no Compass */ }
  const alone = holdsAlone(vault);
  const made: Hold[] = [];
  const taken = have.filter((h) => h.status !== "declined" && weekOf(dayOf(Date.parse(h.start))) === week).map((h) => ({ start: h.start, end: h.end }));
  for (const w of wants) {
    if (have.some((h) => h.for === w.for && weekOf(dayOf(Date.parse(h.start))) === week)) continue;
    const slot = freeSlot(events, taken, week, w.hours, now);
    if (!slot) continue;
    taken.push(slot);
    const h: Hold = { id: `hold-${hash(`${w.for}|${week}`)}`, title: w.title, ...slot, for: w.for, status: "ask", ts: now };
    append(holdsPath(vault), h);
    made.push(alone ? await approveHold(vault, h.id, o.write, now) : h);
  }
  const drafted = readDeclines(vault);
  const declines: DeclineDraft[] = [];
  for (const e of events.filter((x) => counts(x) && inWeek(x, week) && x.attendees > 0 && hoursOf(x) >= 0.5)) {
    if (classify(e, lens).kind !== "none" || drafted.some((d) => d.event === e.id)) continue;
    const when = new Date(Date.parse(e.start)).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const d: DeclineDraft = { id: `decline-${hash(e.id)}`, event: e.id, title: e.title, start: e.start, to: "the organizer", body: `Hi, I can't make "${e.title}" on ${when}. Could you send the notes or the decision afterwards? Thank you.`, ts: now };
    append(declinesPath(vault), d);
    declines.push(d);
  }
  return { holds: made, declines };
}

/** chief-of-staff.md frontmatter `holds: alone` lets holds on the user's own calendar run alone (default: ask). */
export function holdsAlone(vault: string): boolean {
  try { const t = readFileSync(join(vault, "build", "chief-of-staff.md"), "utf8"); return /^---\n[\s\S]*?^holds:\s*alone\s*$/m.test(t); } catch { return false; }
}

/** The user's yes on a hold: tentative, on their own calendar (the calendar writer). */
export async function approveHold(vault: string, id: string, write?: (h: Hold) => Promise<{ ok: boolean; error?: string }>, now = Date.now()): Promise<Hold> {
  const h = readHolds(vault).find((x) => x.id === id);
  if (!h) throw new Error(`no hold ${id}`);
  if (h.status !== "ask") return h;
  const w = write ?? (async (x: Hold) => (await import("./mission-progress.ts")).gwsHold({ id: x.id, title: x.title, start: x.start, end: x.end, attendees: [], status: "ask", ts: now }));
  const r = await w(h);
  const next: Hold = r.ok ? { ...h, status: "created", ts: now } : { ...h, status: "ask", note: `not created: ${r.error ?? "the calendar could not be reached"}`, ts: now };
  append(holdsPath(vault), next);
  return next;
}

export function declineHold(vault: string, id: string, now = Date.now()): Hold {
  const h = readHolds(vault).find((x) => x.id === id);
  if (!h) throw new Error(`no hold ${id}`);
  const next: Hold = { ...h, status: "declined", ts: now };
  append(holdsPath(vault), next);
  return next;
}

/** Today's "Your day" line from the calendar: meetings, focus, after six. */
export function dayLine(vault: string, now = Date.now()): { connected: boolean; note: string } {
  if (!calendarConnected(vault)) return { connected: false, note: "No calendar is connected yet, so your day is not on the card." };
  const today = dayOf(now);
  const evs = readCalendarEvents(vault).filter((e) => counts(e) && dayOf(Date.parse(e.start)) === today);
  const meets = evs.filter((e) => e.attendees > 0);
  const focus = evs.filter((e) => e.focus || FOCUS.test(e.title));
  const late = evs.filter((e) => new Date(Date.parse(e.end)).getHours() >= 18 || new Date(Date.parse(e.start)).getHours() >= 18);
  const hm = (iso: string) => new Date(Date.parse(iso)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "").toLowerCase();
  const bits = [meets.length ? `${meets.length} meeting${meets.length === 1 ? "" : "s"} (${r1(meets.reduce((a, e) => a + hoursOf(e), 0))} h)` : "no meetings", ...focus.slice(0, 1).map((f) => `focus ${hm(f.start)} to ${hm(f.end)}`), late.length ? `${late.length} after 6 pm` : "nothing after 6 pm"];
  return { connected: true, note: bits.join(" · ") };
}

/** The weekly review's time block: this week by value, next week against capacity, what waits. */
export async function timeReview(vault: string, now = Date.now()) {
  // From Friday, next week's protected blocks and drafted declines are proposed (once each).
  if ((new Date(now).getDay() + 6) % 7 >= 4) { try { await proposeTime(vault, { now }); } catch { /* the calendar is not readable */ } }
  const thisWeek = await weekTime(vault, { now });
  const next = await weekTime(vault, { now, next: true });
  const warning = capacityWarning(next, await capacityFor(vault));
  return { thisWeek, warning, holds: readHolds(vault).filter((h) => h.status === "ask"), declines: readDeclines(vault).filter((d) => Date.parse(d.start) > now).slice(0, 5) };
}

export async function timeCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "week";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    if (sub === "week") { const w = await weekTime(vault, { next: args.has("next") }); if (args.json) out(w); else console.log(w.connected ? `${w.week}: ${w.hours} h, meetings ${w.meetings} h, focus ${w.focus} h\n${w.lines.join("\n")}` : w.note); return 0; }
    if (sub === "review") { const r = await timeReview(vault); if (args.json) out(r); else console.log(r.warning ?? "No capacity warning for next week."); return 0; }
    if (sub === "propose") { const r = await proposeTime(vault); if (args.json) out(r); else console.log(`${r.holds.length} holds, ${r.declines.length} declines drafted`); return 0; }
    if (sub === "holds") { const h = readHolds(vault); if (args.json) out(h); else for (const x of h) console.log(`${x.status.padEnd(8)} ${x.start} ${x.title}`); return 0; }
    if (sub === "declines") { const d = readDeclines(vault); if (args.json) out(d); else for (const x of d) console.log(`${x.start} ${x.title}: ${x.body}`); return 0; }
    if (sub === "hold") {
      const act = args.pos[1]; const id = args.pos[2] ?? "";
      if (act === "approve") { const h = await approveHold(vault, id); if (args.json) out({ ok: h.status === "created", hold: h }); else console.log(`${h.status}${h.note ? `: ${h.note}` : ""}`); return 0; }
      if (act === "decline") { const h = declineHold(vault, id); if (args.json) out({ ok: true, hold: h }); return 0; }
    }
    if (sub === "day") { const d = dayLine(vault); if (args.json) out(d); else console.log(d.note); return 0; }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail time week [--next] | review | propose | holds | declines | hold approve|decline <id> | day [--json]");
}

