// The weekly review card: one card, in chat, on the phone and on Telegram,
// carrying both the Compass check-in and the metrics glance.
//
//   Week of Sep 28                                   calm 3 (normal 4)
//   Moved     what went above your normal
//   Drifted   what went below it, and goals gone quiet
//   Conflict  one conflict with evidence, or none
//   Numbers   the glance (pinned metrics, else the default set)
//   From you  up to three Compass lines heard in chat: Yes / Not now
//   Metrics   up to two metric proposals: Track / Not useful
//   One question from the Compass conversation, when one is waiting
//   How calm was this week? 1-5   (the one recurring tap)
//
// Everything on it is computed by code. The check-in is an event,
// build/_meta/events/checkins/<YYYY-MM>.<host>.jsonl, so it reaches every Mac
// the same way the AI and git events do, and feeds the m-calm metric.

import { listDomainDirs } from "./vault-layout-v4.ts";
import { readTasks } from "./tasks.ts";
import { parseHandoff } from "./agent-contract.ts";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeMetrics, dayOf, eventsRoot, fmt, glance, glanceIds, hostSlug, weekOf, type Glance, type GlanceRow } from "./metrics.ts";
import { items, readCompass } from "./compass.ts";
import { topCandidates, type TopCandidate } from "./said.ts";
import { proposals, type MetricProposal } from "./metric-proposals.ts";
import { nextInterviewQuestion } from "./interview.ts";
import { goalsNeedingWoop } from "./compass.ts";
import { INTERRUPTION_BUDGET, usedThisWeek, waitedForReview } from "./interruptions.ts";
import { resolveDomainDir } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";

export interface Checkin { ts: number; week: string; calm: number; note?: string; host: string }

const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return dayOf(d.getTime()); };

export function readCheckins(vault: string): Checkin[] {
  const out: Checkin[] = [];
  const dir = join(eventsRoot(vault), "checkins");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      try { const e = JSON.parse(l) as { ts: string; kind?: string; attrs: { calm: number; week: string; at: number; note?: string }; host: string }; if (e.kind && e.kind !== "checkin.calm") continue; out.push({ ts: e.attrs.at, week: e.attrs.week, calm: e.attrs.calm, ...(e.attrs.note ? { note: e.attrs.note } : {}), host: e.host }); } catch { /* blank or torn */ }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The check-in for a week: the latest answer wins. */
export function checkinFor(vault: string, week: string): Checkin | null {
  return readCheckins(vault).filter((c) => c.week === week).at(-1) ?? null;
}

/** Record the weekly 1-5 (and an optional note). */
export function checkin(vault: string, calm: number, note?: string, now = Date.now(), week?: string): Checkin {
  if (!Number.isInteger(calm) || calm < 1 || calm > 5) throw new Error("calm is a whole number from 1 to 5");
  const w = week ?? reviewWeek(now);
  const host = hostSlug();
  const dir = join(eventsRoot(vault), "checkins");
  mkdirSync(dir, { recursive: true });
  const day = dayOf(now);
  const clean = note?.replace(/\s+/g, " ").trim().slice(0, 280);
  appendFileSync(join(dir, `${day.slice(0, 7)}.${host}.jsonl`), `${JSON.stringify({ ts: day, src: "checkins", kind: "checkin.calm", n: 1, host, tier: "asked", attrs: { calm, week: w, at: now, ...(clean ? { note: clean } : {}) } })}\n`);
  return { ts: now, week: w, calm, ...(clean ? { note: clean } : {}), host };
}

/** Which week the card reviews: this week from Friday on; on Monday to Thursday, last week until it has a check-in. */
export function reviewWeek(now: number, vault?: string): string {
  const today = dayOf(now);
  const week = weekOf(today);
  const dow = (new Date(`${today}T12:00:00`).getDay() + 6) % 7; // Mon 0 .. Sun 6
  if (dow >= 4) return week;
  const last = addDays(week, -7);
  if (vault && !checkinFor(vault, last)) return last;
  return vault ? week : last;
}

export interface ReviewCard {
  week: string;
  through: string;
  due: boolean;
  checkin: Checkin | null;
  calmNormal: number | null;
  lines: { moved: string[]; drifted: string[]; conflict: string };
  /** Goals G3: the conflict behind the line (its key, to accept it, and the evidence). */
  conflict?: { key: string; evidence: string[] } | null;
  glance: GlanceRow[];
  surprise: string | null;
  candidates: TopCandidate[];
  metricProposals: MetricProposal[];
  question: { id: string; text: string } | null;
  woop: { id: string; title: string }[];
  waited: { kind: string; text: string }[];
  interruptions: { used: number; budget: number };
  /** One line about the stack (apps plan A4): what needs you, else what is in use. */
  apps: string | null;
  /** Apps A5: the quarterly export reminder (off unless turned on) and the stack diff waiting for a yes. */
  exportReminder?: string | null;
  stackDiff?: string | null;
  /** Metrics M4: the quarterly ladder and the optional monthly WHO-5 when due; one hypothesis to answer yes or no; guards slipping. */
  asked: { ladder: boolean; who5: boolean };
  hypothesis: { key: string; text: string } | null;
  guardrails: string[];
  /** Today T2: promises found in sent mail or notes that were not sure enough to file alone (Yes files one). */
  commitments?: { src: string; text: string; due?: string; person?: string; quote: string }[];
  /** Missions MS4: one line per active mission. */
  missions?: string[];
  /** Agent mesh: handoffs between domains still open, the chief of staff watching the boards. */
  handoffs?: string | null;
  /** Today T3: everything falling behind (the radar), most urgent first. */
  radar?: { key: string; kind: string; text: string; evidence: string; due?: string }[];
  /** Goals G4: each chosen initiative against its expectations, with the explanation and a proposed change; the quarterly review when owed. */
  initiatives?: { id: string; title: string; state: string; explanation: string; proposal: string }[];
  quarterly?: boolean;
  /** Metrics M5: the running n-of-1 experiment's arm this week. */
  experiment?: { id: string; arm: "A" | "B"; text: string } | null;
  /** Today T5: this week's calendar by value, next week against capacity, holds that ask, drafted declines. */
  time?: Awaited<ReturnType<typeof import("./time.ts").timeReview>> | null;
}

/** When the user last did anything in a domain: a chat, a task change, a note from another domain. */
export function lastActivity(vault: string, domain: string): number {
  const dir = resolveDomainDir(vault, domain);
  let t = 0;
  for (const rel of ["memory/threads", "memory/tasks.md", "_tasks.md", "memory/updates.jsonl", "memory/decisions.jsonl"]) {
    try { t = Math.max(t, statSync(join(dir, rel)).mtimeMs); } catch { /* absent */ }
  }
  return t;
}

/** Goals in the Compass whose domain has had no activity for six weeks. */
function quietGoals(vault: string, now: number): string[] {
  const out: string[] = [];
  const since = now - 42 * 86_400_000;
  for (const g of items(readCompass(vault), "goal")) {
    const st = g.tokens.status ?? "active";
    if (!["active", "confirmed", "prototyping"].includes(st) || !g.tokens.domain) continue;
    if (lastActivity(vault, g.tokens.domain) < since) out.push(`${g.title}: nothing in ${g.tokens.domain} for six weeks`);
  }
  return out.slice(0, 2);
}

export async function weeklyReview(vault: string, opts: { now?: number; week?: string } = {}): Promise<ReviewCard> {
  const now = opts.now ?? Date.now();
  const week = opts.week ? weekOf(opts.week) : reviewWeek(now, vault);
  const c = await computeMetrics(vault, { now });
  const q = await import("./qualitative.ts");
  const ss = q.seasons(vault, c);
  const g: Glance = glance(c, { week, ids: glanceIds(vault), paused: (id, w) => q.pausedBy(ss, c.defs.find((d) => d.id === id) ?? id, w)?.title ?? null });
  const moved: string[] = [];
  const drifted: string[] = [];
  for (const r of g.rows) {
    if (r.documentary || r.normal.learning || r.paused) continue;
    if (r.value > r.normal.hi) moved.push(`${r.title} ${fmt(r.value, r.unit)}, above your normal of ${fmt(r.normal.lo, r.unit)} to ${fmt(r.normal.hi, r.unit)}`);
    else if (r.value < r.normal.lo) drifted.push(`${r.title} ${fmt(r.value, r.unit)}, below your normal of ${fmt(r.normal.lo, r.unit)} to ${fmt(r.normal.hi, r.unit)}`);
  }
  drifted.push(...quietGoals(vault, now));
  const ck = checkinFor(vault, week);
  const calms = readCheckins(vault).filter((x) => x.week < week).slice(-8).map((x) => x.calm).sort((a, b) => a - b);
  const calmNormal = calms.length >= 3 ? calms[Math.floor(calms.length / 2)]! : null;
  const dow = (new Date(`${dayOf(now)}T12:00:00`).getDay() + 6) % 7;
  // Goals G3: the conflict line is the strongest open conflict with evidence (code pass; the model pass runs from the Compass page or `prevail compass conflicts --model`).
  let conflict: { text: string; key?: string; evidence?: string[] } = { text: "No conflict with evidence this week." };
  try {
    const ca = await import("./compass-align.ts");
    await ca.computeGraph(vault, { now, vars: await ca.stateVariables(vault, { now, points: c.points }) });
    conflict = ca.conflictLine(vault);
  } catch { /* no Compass */ }
  return {
    week,
    through: g.through,
    due: !ck && (week < weekOf(dayOf(now)) || dow >= 4),
    checkin: ck,
    calmNormal,
    lines: {
      moved: moved.slice(0, 3),
      drifted: drifted.slice(0, 3),
      conflict: conflict.text,
    },
    conflict: conflict.key ? { key: conflict.key, evidence: conflict.evidence ?? [] } : null,
    glance: g.rows,
    surprise: g.surprise,
    candidates: topCandidates(vault, 3),
    metricProposals: proposals(vault, c, 2),
    question: nextInterviewQuestion(vault),
    woop: goalsNeedingWoop(vault).slice(0, 1).map((x) => ({ id: x.id, title: x.title })),
    waited: waitedForReview(vault, week).map((w) => ({ kind: w.kind, text: w.text })),
    interruptions: { used: usedThisWeek(vault, now), budget: INTERRUPTION_BUDGET },
    apps: await appsLine(vault, now),
    // Apps A5: the quarterly export reminder, only when the user turned it on.
    exportReminder: await (async () => { try { return (await import("./ai-imports.ts")).exportReminderLine(vault, now); } catch { return null; } })(),
    stackDiff: await (async () => { try { const d = (await import("./stack-said.ts")).readStackDiff(vault); return d && !d.accepted && d.items.length ? `${d.items.length} change${d.items.length === 1 ? "" : "s"} to your stated tool stack (said vs used, ${d.month})` : null; } catch { return null; } })(),
    commitments: await commitmentLines(vault),
    radar: await radarLines(vault, now),
    missions: await (async () => { try { return (await import("./mission-progress.ts")).missionReviewLines(vault, now); } catch { return []; } })(),
    handoffs: handoffLine(vault),
    ...(await initiativeLines(vault, now)),
    experiment: await (async () => { try { return (await import("./stories.ts")).experimentThisWeek(vault, now); } catch { return null; } })(),
    time: await (async () => { try { return await (await import("./time.ts")).timeReview(vault, now); } catch { return null; } })(),
    ...(await qualitativeLines(vault, c, week, now)),
  };
}

/** Open "From <domain>:" tasks across every board: who handed what to whom. */
export function handoffLine(vault: string): string | null {
  try {
    const pairs = new Map<string, number>();
    for (const d of listDomainDirs(vault)) {
      for (const t of readTasks(resolveDomainDir(vault, d))) {
        if (t.done || t.trashed) continue;
        const h = parseHandoff(t.text);
        if (h) pairs.set(`${h.from} to ${d}`, (pairs.get(`${h.from} to ${d}`) ?? 0) + 1);
      }
    }
    if (!pairs.size) return null;
    const n = [...pairs.values()].reduce((a, b) => a + b, 0);
    return `${n} handoff${n === 1 ? "" : "s"} between domains still open: ${[...pairs].map(([k, v]) => `${k}${v > 1 ? ` (${v})` : ""}`).join(", ")}.`;
  } catch { return null; }
}

async function qualitativeLines(vault: string, c: Awaited<ReturnType<typeof computeMetrics>>, week: string, now: number): Promise<Pick<ReviewCard, "asked" | "hypothesis" | "guardrails">> {
  try {
    const q = await import("./qualitative.ts");
    const h = q.hypotheses(vault, c, week)[0];
    return { asked: q.askedDue(vault, now), hypothesis: h ? { key: h.key, text: h.text } : null, guardrails: q.guardrails(vault, c).filter((g) => g.state === "slipping").map((g) => g.text).slice(0, 2) };
  } catch { return { asked: { ladder: false, who5: false }, hypothesis: null, guardrails: [] }; }
}

async function initiativeLines(vault: string, now: number): Promise<Pick<ReviewCard, "initiatives" | "quarterly">> {
  try {
    const p = await import("./paths.ts");
    const checks = await p.checkPaths(vault, now);
    return { initiatives: checks.map((c) => ({ id: c.id, title: c.title, state: c.state, explanation: c.explanation, proposal: c.proposal })), quarterly: p.quarterlyDue(vault, now) };
  } catch { return { initiatives: [], quarterly: false }; }
}

async function radarLines(vault: string, now: number): Promise<NonNullable<ReviewCard["radar"]>> {
  try { const r = await import("./radar.ts"); const x = r.readRadar(vault, now) ?? (await r.computeRadar(vault, { now })); return x.items.slice(0, 12).map((i) => ({ key: i.key, kind: i.kind, text: i.text, evidence: i.evidence, ...(i.due ? { due: i.due } : {}) })); } catch { return []; }
}

async function commitmentLines(vault: string): Promise<NonNullable<ReviewCard["commitments"]>> {
  try { return (await import("./commitments.ts")).openProposals(vault).slice(0, 3).map((p) => ({ src: p.src, text: p.text, ...(p.due ? { due: p.due } : {}), ...(p.person ? { person: p.person } : {}), quote: p.quote })); } catch { return []; }
}

async function appsLine(vault: string, now: number): Promise<string | null> {
  try {
    const d = await import("./app-doctor.ts");
    const stack = d.buildStack(vault, { now });
    if (!stack.apps.length) return null;
    return d.weeklyLine(d.visibleCards(d.detectCards(stack, now), d.readAnswers(vault), now), stack);
  } catch { return null; }
}

const weekLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The card as plain text (Telegram, the CLI). */
export function reviewText(r: ReviewCard): string {
  const out = [`Week of ${weekLabel(r.week)}${r.checkin ? `, calm ${r.checkin.calm}${r.calmNormal ? ` (normal ${r.calmNormal})` : ""}` : ""}`];
  out.push(r.lines.moved.length ? `Moved: ${r.lines.moved.join("; ")}` : "Moved: nothing past your normal.");
  out.push(r.lines.drifted.length ? `Drifted: ${r.lines.drifted.join("; ")}` : "Drifted: nothing below your normal.");
  out.push(`Conflict: ${r.lines.conflict}${r.conflict?.evidence.length ? ` (${r.conflict.evidence.join("; ")})` : ""}`);
  for (const row of r.glance) out.push(row.documentary ? `${row.title}: ${row.record ?? "a record, no target"}` : `${row.title}: ${fmt(row.value, row.unit)} (${row.normal.learning ? "learning your normal" : `normal ${fmt(row.normal.lo, row.unit)} to ${fmt(row.normal.hi, row.unit)}`})`);
  if (r.surprise) out.push(`One surprise: ${r.surprise}`);
  for (const c of r.candidates) out.push(`You said: "${c.quote}". Make "${c.title}" a ${c.kind === "rule" ? "rule" : c.kind}? (${c.count} time${c.count === 1 ? "" : "s"})`);
  for (const p of r.metricProposals) out.push(`New metric? ${p.title}: ${p.why}`);
  for (const c of r.commitments ?? []) out.push(`A promise? "${c.quote}" Track "${c.text}"${c.due ? ` by ${c.due}` : ""}? (prevail commitments answer ${c.src} yes)`);
  if (r.woop[0]) out.push(`Your goal "${r.woop[0].title}" needs its plan: say "continue my Compass" in chat.`);
  else if (r.question) out.push(`One question: ${r.question.text}`);
  if (r.apps) out.push(r.apps);
  for (const g of r.guardrails ?? []) out.push(`Guardrail: ${g}`);
  if (r.hypothesis) out.push(`${r.hypothesis.text} Reply yes or no.`);
  if (r.asked?.ladder) out.push("Once a quarter: on a ladder from 0 (worst possible life) to 10 (best possible), where do you stand now, and where in five years?");
  if (r.asked?.who5) out.push("This month's WHO-5 is waiting (five quick questions about the last two weeks).");
  for (const m of r.missions ?? []) out.push(`Project: ${m}`);
  if (r.handoffs) out.push(`Handoffs: ${r.handoffs}`);
  for (const x of r.initiatives ?? []) out.push(`Initiative: ${x.explanation}${x.proposal ? ` ${x.proposal}` : ""}`);
  if (r.experiment) out.push(`Experiment: ${r.experiment.text}`);
  if (r.time) {
    if (!r.time.thisWeek.connected) out.push(`Time: ${r.time.thisWeek.note}`);
    else { out.push(`Time: ${r.time.thisWeek.hours} h on the calendar, ${r.time.thisWeek.meetings} in meetings, ${r.time.thisWeek.focus} focus.`); for (const l of r.time.thisWeek.lines) out.push(`- ${l}`); }
    if (r.time.warning) out.push(r.time.warning);
    if (r.time.holds.length) out.push(`${r.time.holds.length} protected block${r.time.holds.length === 1 ? "" : "s"} for next week wait for your yes.`);
  }
  if (r.quarterly) out.push("The quarterly initiative review is due: keep, switch or drop each one (prevail compass paths review).");
  if (r.radar?.length) { out.push("Falling behind:"); for (const x of r.radar) out.push(`- ${x.text} (${x.evidence})`); }
  for (const w of r.waited) out.push(`Waited for this review: ${w.text}`);
  out.push(r.checkin ? `You said calm ${r.checkin.calm} this week.` : "How calm was this week? Reply 1 to 5 (on Telegram: /calm 4).");
  return out.join("\n");
}

export async function reviewCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "week";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    if (sub === "week") { const r = await weeklyReview(vault, { week: args.get("week") }); if (args.json) out(r); else console.log(reviewText(r)); return 0; }
    if (sub === "checkin") {
      const c = checkin(vault, Number(args.pos[1]), args.get("note"), Date.now(), args.get("week"));
      if (args.json) out({ ok: true, checkin: c }); else console.log(`Calm ${c.calm} for the week of ${c.week}.`);
      return 0;
    }
    if (sub === "ladder") {
      const q = await import("./qualitative.ts");
      const r = q.recordLadder(vault, Number(args.pos[1]), Number(args.pos[2]));
      if (args.json) out({ ok: true, ...r }); else console.log(`Ladder recorded for ${r.quarter}.`);
      return 0;
    }
    if (sub === "who5") {
      const q = await import("./qualitative.ts");
      if (args.pos[1] === "on" || args.pos[1] === "off") { q.setWho5(vault, args.pos[1] === "on"); if (args.json) out({ ok: true, who5: args.pos[1] === "on" }); else console.log(`WHO-5 ${args.pos[1]}.`); return 0; }
      const r = q.recordWho5(vault, args.pos.slice(1, 6).map(Number));
      if (args.json) out({ ok: true, ...r }); else console.log(`WHO-5 score ${r.score} of 100.`);
      return 0;
    }
    if (sub === "hypothesis") {
      const q = await import("./qualitative.ts");
      const ans = args.pos[2];
      if (ans !== "yes" && ans !== "no") return fail("usage: prevail review hypothesis <key> yes|no");
      const c = await computeMetrics(vault);
      const key = args.pos[1] ?? "";
      const h = q.hypotheses(vault, c, key.split(":")[1]).find((x) => x.key === key);
      if (!h) return fail(`no open hypothesis ${key}`);
      q.answerHypothesis(vault, h, ans === "yes");
      if (args.json) out({ ok: true }); else console.log("Noted; that teaches what to ask.");
      return 0;
    }
    if (sub === "candidate") {
      const { answerCandidate } = await import("./said.ts");
      const ans = args.pos[2] === "yes" ? "yes" : args.pos[2] === "no" ? "no" : null;
      if (!ans) return fail("usage: prevail review candidate <key> yes|no");
      const r = answerCandidate(vault, args.pos[1] ?? "", ans);
      if (args.json) out({ ok: true, ...r }); else console.log(r.added ? `Added ${r.added} to your Compass.` : "Not now.");
      return 0;
    }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail review week [--week YYYY-MM-DD] | checkin <1-5> [--note text] | candidate <key> yes|no | ladder <now 0-10> <in five years 0-10> | who5 on|off | who5 <a> <b> <c> <d> <e> | hypothesis <key> yes|no [--json]");
}
