// Jobs: the chief of staff staffs the work. One dispatch decision per message
// (answer, or a job with an owner domain, the domains it reads and tells, a
// team of specialists and an effort), then a run that leaves a record.
//
//   build/_meta/jobs/<job-id>/
//     job.json        the dispatch decision plus status, cost and result
//     steps/<n>-<id>.json   one specialist run: trigger, brief, passes, cost
//     result.json     the typed result
//     filed.jsonl     every write to a domain, with what Undo reverses
//   build/_meta/staffing.jsonl   every Adjust (learned like route corrections)
//
// Rules, in code:
//   - Only the chief of staff (dispatch) and the Planner staff work;
//     specialists never call each other.
//   - Ceilings: no specialist runs with acting tools. A write-vault result is
//     written by code into the owner domain; a draft is stored, never sent.
//     The Operator (act-ask) only names actions: code puts each one through
//     the broker (pause, the autonomy policy, the Compass rules, a mission's
//     ceiling and money); blocked ones stop, the rest wait in the Inbox for a
//     yes unless the policy lets that class run alone. A specialist with a
//     full act ceiling never runs.
//   - A job starts alone only when every step is reversible (read, draft,
//     write-vault with Undo), it fits the user's limits (build/chief-of-staff.md,
//     default $1 and 10 minutes) and the ask does not move money, contact a
//     person, change a location or an identity. Otherwise it is offered.
//   - Budgets (dollars, estimated from characters; minutes, by the clock) stop
//     a run, never only a prompt.
//   - Never-read domains are left out unless the message names them.
//   - Cross-domain writes go through what exists: the decision to the owner's
//     decisions.jsonl, a task to the owner's board, notes to each other
//     domain's updates.jsonl. Each write has a receipt for Undo.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyAction } from "./action-policy.ts";
import { isPaused } from "./autonomy.ts";
import { readChiefOfStaff, chiefOfStaffPath, parseChiefOfStaff } from "./chief-of-staff.ts";
import { bootstrapSources, compassBlock, compassMetaDir, quoteSource, titleFromUserWords } from "./compass.ts";
import { appendDecision, decisionsFile } from "./decisions.ts";
import { goalsBlock, writeVersioned } from "./goals.ts";
import { appendJsonl, domainUpdatesPath, readJsonl } from "./linking.ts";
import { logActivity } from "./activity.ts";
import { missionScopeSlug, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { routableDomains, type RouteRunner } from "./route.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile } from "./vault-session.ts";
import { forDomain, getSpecialist, loadSpecialists, readNotebook, appendNotebook, ceilingRank, type Ceiling, type Specialist } from "./specialists.ts";
import { readMission, type MissionDomain } from "./missions.ts";
import { leadingMentions } from "./members.ts";
import { jobCompass, ruleGate, type JobCompass } from "./compass-align.ts";
import { parseModArgs } from "./cli-args.ts";

export type Effort = "quick" | "standard" | "deep";
export type JobStatus = "proposed" | "running" | "needs-approval" | "done" | "failed" | "stopped";
export type TriggerKind = "chat" | "mention" | "offer" | "playbook" | "schedule" | "event" | "cli";
export const EFFORT_BUDGET: Record<Effort, { usd: number; minutes: number }> = {
  quick: { usd: 0.3, minutes: 4 },
  standard: { usd: 1, minutes: 10 },
  deep: { usd: 3, minutes: 30 },
};

export interface TeamStep { step: number; specialists: string[]; gate?: boolean; brief?: string }
export interface JobResult { type: string; summary: string; page?: string; drafts?: { to: string; subject: string; body: string }[]; verdict?: string }
export interface Job {
  id: string;
  ask: string;
  origin: { kind: TriggerKind; thread?: string; domain: string };
  domains: { owner: string; consulted: string[]; informed: string[] };
  entities: string[];
  team: TeamStep[];
  effort: Effort;
  budget: { usd: number; minutes: number };
  why: string;
  playbook: string | null;
  status: JobStatus;
  startsAlone: boolean;
  askReason?: string;
  created: number;
  started?: number;
  ended?: number;
  cost?: { usd: number; minutes: number; estimated: true };
  progress?: { step: number; specialist: string; pass: number }[];
  result?: JobResult;
  note?: string;
  pid?: number;
  /** A job a mission started: its ceiling (the lowest wins) and money left. */
  mission?: { slug: string; ceiling: Ceiling; budgetLeftUsd: number | null };
  /** Results handed in from outside the job (earlier playbook steps): the team reads them first. */
  inputs?: { name: string; returns: string; body: string }[];
  /** Goals G3: what the job serves, what it may cost, the non-negotiables it touches. */
  compass?: JobCompass;
  /** Specialists Phase 3: what the Operator proposed, each behind the broker. */
  actions?: OperatorAction[];
}

export interface Receipt { n: number; ts: number; domain: string; kind: "decision" | "task" | "note" | "page" | "draft" | "build" | "memory" | "candidate"; file: string; ref: string; text: string; undone?: number }

/** One action the Operator named, and what the broker and the user made of it. */
export interface OperatorAction {
  n: number; text: string; why?: string; undo?: string;
  cls: string; status: "blocked" | "asks" | "running" | "done" | "failed" | "declined";
  reason?: string; act?: string; report?: string; ts: number;
  /** What the egress guard found in it (a money amount...): Allow names it. */
  carries?: string[];
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function jobsRoot(vault: string): string { return join(runtimePath(vault, "_meta"), "jobs"); }
export function jobDir(vault: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(id)) throw new Error(`bad job id: ${id}`);
  return join(jobsRoot(vault), id);
}
const staffingPath = (vault: string) => join(runtimePath(vault, "_meta"), "staffing.jsonl");

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";
const pad = (n: number) => String(n).padStart(2, "0");
export function makeJobId(ask: string, now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${slug(ask)}`;
}

export function saveJob(vault: string, job: Job): void {
  const dir = jobDir(vault, job.id);
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
}

export function readJob(vault: string, id: string): Job | null {
  try { const j = JSON.parse(readText(join(jobDir(vault, id), "job.json"))) as Job; return j && j.id ? j : null; } catch { return null; }
}

/** Jobs newest first. Playbook runs (run.json only) are listed too, with origin playbook. */
export function listJobs(vault: string, limit = 50): Job[] {
  const root = jobsRoot(vault);
  if (!existsSync(root)) return [];
  const out: Job[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const j = readJob(vault, id);
    if (j) { out.push(alive(vault, j)); continue; }
    const run = readText(join(dir, "run.json"));
    if (!run) continue;
    try {
      const r = JSON.parse(run) as { runId: string; playbook: string; goal: string; ok: boolean; note: string };
      const ts = statSync(join(dir, "run.json")).mtimeMs;
      out.push({ id, ask: r.goal, origin: { kind: "playbook", domain: "" }, domains: { owner: "", consulted: [], informed: [] }, entities: [], team: [], effort: "standard", budget: EFFORT_BUDGET.standard, why: r.note, playbook: r.playbook, status: r.ok ? "done" : "failed", startsAlone: true, created: ts, ended: ts });
    } catch { /* not a run */ }
  }
  return out.sort((a, b) => b.created - a.created).slice(0, limit);
}

/** A job marked running whose process is gone is reported as stopped (never left spinning). */
function alive(vault: string, j: Job): Job {
  if (j.status !== "running" || !j.pid) return j;
  try { process.kill(j.pid, 0); return j; } catch { return { ...j, status: "stopped", note: j.note ?? "the run ended without finishing" }; }
}

// ── Dispatch: answer, or a job ──────────────────────────────────────────────

export type Shape = "find" | "plan" | "do" | "understand" | "make" | "act" | "negotiate" | "learn" | "relate" | "reflect";

// A job is something to go and do, not a question to answer. Code reads the
// shape from the opening verb; anything else is answered as an ordinary turn
// (no model call is spent on deciding).
const SHAPES: [Shape, RegExp][] = [
  // Phase 4: the Negotiator, the Tutor, the Liaison and the Confidant.
  ["negotiate", /^(please\s+)?(can you\s+|could you\s+)?(help me\s+)?(negotiate|haggle|get (a|the) better (price|deal|rate)|counter(offer)?|prepare (me )?for (a|the|my) (negotiation|salary talk|raise)|ask for a (raise|discount|lower))\b/i],
  ["learn", /^(please\s+)?(can you\s+|could you\s+)?(teach me|quiz me|help me (learn|study|practice)|make (me )?a (curriculum|lesson plan|study plan)|i want to learn)\b/i],
  ["relate", /^(please\s+)?(can you\s+|could you\s+)?(who (should|do) i (call|check in with|reach out to|catch up with)|who am i (out of touch|neglecting)|(help me )?(keep|stay) in touch|draft (some )?check-?ins?)\b/i],
  ["reflect", /^(please\s+)?(can you\s+|could you\s+)?(help me (think through|reflect on|make sense of)|what patterns? (do you see|are there) in my|reflect (on|with me))\b/i],
  ["find", /^(please\s+)?(can you\s+|could you\s+)?(find|compare|research|look into|shop (for|around)|get (me )?(quotes?|options)|what are the best|which .{3,60} (is|are) (the )?best|best .{3,60} for)\b/i],
  ["plan", /^(please\s+)?(can you\s+|could you\s+)?(plan|make (me )?a plan|map out|lay out the steps|put together a plan|figure out how)\b/i],
  ["do", /^(please\s+)?(can you\s+|could you\s+)?(draft|write (an? )?(email|letter|message|note|request)|prepare (an? )?(email|letter|request)|reach out)\b/i],
  ["understand", /^(please\s+)?(can you\s+|could you\s+)?(analy[sz]e my|go through my|review my|summari[sz]e my)\b/i],
  ["make", /^(please\s+)?(can you\s+|could you\s+)?(build (me )?(a|an)|make (me )?(a|an) (script|tool|site|page|automation|app)|write (a|an) (script|tool|automation)|code (me )?(a|an))\b/i],
  // Doing something in the world: the Operator names the actions, each one asks.
  ["act", /^(please\s+)?(can you\s+|could you\s+)?(book|order|buy|purchase|cancel|renew|sign (me )?up for|pay|schedule|set up (a|an|my))\b/i],
];

export function shapeOf(message: string): Shape | null {
  const t = message.replace(/^\s*(hey|hi|ok|okay)[,\s]+/i, "").trim();
  if (t.split(/\s+/).length < 4) return null;
  for (const [s, re] of SHAPES) if (re.test(t)) return s;
  return null;
}

/**
 * Staffing shapes (built in): find/compare/choose -> Researcher (+ Scout when
 * open-ended), Analyst when money is involved, Steward when it is a decision,
 * Auditor when numbers drive it, Editor to deliver. Plan -> Planner, Steward,
 * Editor (the Skeptic's pre-mortem before the Steward). Do -> Planner then
 * Writer (drafts only). Act -> Planner, Steward, then the Operator, whose
 * actions each go through the broker. Make -> Builder, Auditor.
 * Understand my data -> Analyst and Historian side by side, Editor.
 * Negotiate -> Researcher, Negotiator, Steward. Learn -> Tutor. Keep in
 * touch -> Liaison. Reflect -> Confidant.
 * Specialists that are off are left out.
 */
export function teamFor(shape: Shape, on: Set<string>, opts: { openEnded?: boolean; decision?: boolean; money?: boolean; numbers?: boolean } = {}): TeamStep[] {
  const steps: { specialists: string[]; gate?: boolean }[] = [];
  if (shape === "find") {
    steps.push({ specialists: ["researcher", ...(opts.openEnded !== false ? ["scout"] : [])] });
    if (opts.money) steps.push({ specialists: ["analyst"] });
    if (opts.decision !== false) steps.push({ specialists: ["steward"], gate: true });
    if (opts.numbers || opts.money) steps.push({ specialists: ["auditor"], gate: true });
    steps.push({ specialists: ["editor"] });
  } else if (shape === "plan") {
    // The Skeptic's pre-mortem before the Steward judges the fit.
    steps.push({ specialists: ["planner"] }, { specialists: ["skeptic"] }, { specialists: ["steward"], gate: true }, { specialists: ["editor"] });
  } else if (shape === "act") {
    steps.push({ specialists: ["planner"] }, { specialists: ["steward"], gate: true }, { specialists: ["operator"] });
  } else if (shape === "do") {
    steps.push({ specialists: ["planner"] }, { specialists: ["writer"] });
  } else if (shape === "make") {
    steps.push({ specialists: ["builder"] }, { specialists: ["auditor"], gate: true });
  } else if (shape === "negotiate") {
    // The facts first, then the strategy and its drafts; nothing is sent.
    steps.push({ specialists: ["researcher"] }, { specialists: ["negotiator"] }, { specialists: ["steward"], gate: true });
  } else if (shape === "learn") {
    steps.push({ specialists: ["tutor"] });
  } else if (shape === "relate") {
    steps.push({ specialists: ["liaison"] });
  } else if (shape === "reflect") {
    steps.push({ specialists: ["confidant"] });
  } else {
    // Understand my data: the Analyst counts, the Historian dates; without them the Researcher reads the vault.
    const pair = ["analyst", "historian"].filter((x) => on.has(x));
    steps.push({ specialists: pair.length ? pair : ["researcher"] }, { specialists: ["editor"] });
  }
  return steps
    .map((s) => ({ ...s, specialists: s.specialists.filter((id) => on.has(id)) }))
    .filter((s) => s.specialists.length)
    .map((s, i) => ({ step: i + 1, specialists: s.specialists, ...(s.gate ? { gate: true } : {}) }));
}

export interface DispatchModel { owner?: string; consulted?: string[]; informed?: string[]; entities?: string[]; effort?: Effort; why?: string; open_ended?: boolean; decision?: boolean; money?: boolean; numbers?: boolean }

export function buildDispatchPrompt(message: string, here: string, domains: { slug: string; goals: string[] }[], learned: string[]): { system: string; prompt: string } {
  const system = "You staff jobs for a person's chief of staff. You pick which life domains a job belongs to. Reply with JSON only.";
  const prompt = [
    `The person asked, while in the "${here}" domain:`,
    `"""${message.slice(0, 2000)}"""`,
    "",
    "Their domains (slug: active goal titles):",
    ...domains.map((d) => `- ${d.slug}${d.goals.length ? `: ${d.goals.slice(0, 3).join("; ")}` : ""}`),
    ...(learned.length ? ["", "What they taught you before:", ...learned.map((l) => `- ${l}`)] : []),
    "",
    "Return JSON: {",
    '  "owner": "<one slug: the only domain that writes the outcome>",',
    '  "consulted": ["<slugs whose notes the team should read first, at most 3>"],',
    '  "informed": ["<slugs whose records change because of the outcome and should get a one-line note afterward (for example tax when a cost is deductible), at most 3>"],',
    '  "effort": "quick | standard | deep",',
    '  "open_ended": <true when it helps to look beyond the question>,',
    '  "decision": <true when the person must choose between options>,',
    '  "money": <true when money is involved: prices, costs, budgets>,',
    '  "numbers": <true when numbers drive the answer and should be checked>,',
    '  "why": "<one short line: the shape of the job>" }',
    `Asking inside a domain makes it the default owner${here !== "general" ? ` (${here})` : ""}; pick another only when it clearly fits better.`,
  ].join("\n");
  return { system, prompt };
}

export function parseDispatchReply(raw: string, known: string[]): DispatchModel | null {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(raw.slice(a, b + 1)) as DispatchModel;
    const ok = (s: unknown) => typeof s === "string" && known.includes(s);
    return {
      owner: ok(j.owner) ? j.owner : undefined,
      consulted: (Array.isArray(j.consulted) ? j.consulted : []).filter(ok).slice(0, 3),
      informed: (Array.isArray(j.informed) ? j.informed : []).filter(ok).slice(0, 3),
      effort: j.effort === "quick" || j.effort === "deep" ? j.effort : "standard",
      why: typeof j.why === "string" ? j.why.slice(0, 160) : undefined,
      open_ended: j.open_ended !== false,
      decision: j.decision !== false,
      money: j.money === true,
      numbers: j.numbers === true,
    };
  } catch { return null; }
}

// Asks that move money, contact a person, change where the user lives or who
// they are: the job may research and draft, but it never starts alone.
const ASK_FIRST = /\b(buy|purchase|pay|order|subscribe|sign up|cancel|book|transfer|wire|invest|sell|send|email|text|call|message|reach out|move to|relocate|change my name|apply for)\b/i;

export function askFirstReason(ask: string): string | null {
  const cls = classifyAction(ask);
  if (cls === "financial") return "it involves money";
  if (cls === "external_send") return "it contacts someone";
  if (cls === "irreversible" || cls === "credential") return "it cannot be undone";
  if (ASK_FIRST.test(ask)) return "it touches money, people, location or identity";
  return null;
}

export interface Learned { skip: Map<string, Set<string>>; consult: Map<string, Set<string>>; lines: string[] }

/** What the Adjust log teaches: twice the same correction for an owner domain makes it a rule. */
export function learnedStaffing(vault: string): Learned {
  const rows = readJsonl<{ owner: string; field: string; removed?: string[]; added?: string[] }>(staffingPath(vault));
  const count = new Map<string, number>();
  for (const r of rows) {
    for (const x of r.removed ?? []) if (r.field === "team") count.set(`skip|${r.owner}|${x}`, (count.get(`skip|${r.owner}|${x}`) ?? 0) + 1);
    for (const x of r.added ?? []) if (r.field === "consulted") count.set(`consult|${r.owner}|${x}`, (count.get(`consult|${r.owner}|${x}`) ?? 0) + 1);
  }
  const out: Learned = { skip: new Map(), consult: new Map(), lines: [] };
  for (const [k, n] of count) {
    if (n < 2) continue;
    const [kind, owner, x] = k.split("|") as [string, string, string];
    const map = kind === "skip" ? out.skip : out.consult;
    if (!map.has(owner)) map.set(owner, new Set());
    map.get(owner)!.add(x);
    out.lines.push(kind === "skip" ? `${owner} jobs: skip the ${x}` : `${owner} jobs: read ${x} first`);
  }
  return out;
}

export interface DispatchInput {
  vault: string;
  message: string;
  domain: string;
  thread?: string;
  trigger?: TriggerKind;
  runner?: RouteRunner | null;
  now?: number;
  /** A mission turn: dispatch picks only among what the mission brought in. */
  scope?: MissionScope;
  /** Specialists named on this turn (composer chips, or a group chat's route): one job for all of them. */
  to?: string[];
}
export interface MissionScope { slug: string; name: string; domains: MissionDomain[]; specialists: string[]; apps: string[]; ceiling: Ceiling; budgetLeftUsd: number | null }
/** Something outside the mission's scope: nothing is read until the user says yes. */
export interface BringIn { domains: string[]; never: boolean; why: string }
/** A message that should become a mission: a Start card, never started without a yes. */
export interface MissionDraft { name: string; outcome: string; owner?: string; consulted: string[]; specialists: string[]; target?: string }
export interface Dispatch { kind: "answer" | "job" | "bring-in" | "mission"; job?: Job; confident: boolean; mention?: string; bringIn?: BringIn; mission?: MissionDraft }


// "Start a mission to...", "I'm going to learn...", "plan my trip to...": an
// effort with an outcome and an end. Code reads it; the user always says yes.
const MISSION_START = /^(please\s+)?(let'?s\s+)?(start|begin|create|open|set up)\s+(a|the|my)\s+(mission|project)\b|^(i'?m going to|i am going to|i want to|i'?d like to|help me)\s+(learn|remodel|renovate|buy|build|plan|train for|prepare for|travel to|move to)\b|^plan my (trip|move|wedding|renovation)\b/i;

export function missionDraftFrom(message: string, here: string, known: string[]): MissionDraft | null {
  const t = message.replace(/^\s*(hey|hi|ok|okay)[,\s]+/i, "").trim();
  if (!MISSION_START.test(t)) return null;
  const outcome = t.replace(/^(please\s+)?(let'?s\s+)?(start|begin|create|open|set up)\s+(a|the|my)\s+(mission|project)\s*(to|for|called|named)?\s*:?\s*/i, "").replace(/^(i'?m going to|i am going to|i want to|i'?d like to|help me)\s+/i, "").replace(/[.!?]+$/, "").trim();
  const name = (outcome.split(/[,.;]| by | before | so that /i)[0] ?? outcome).trim().replace(/^\w/, (c) => c.toUpperCase()).slice(0, 60);
  if (!name) return null;
  const verb = /^(\w+)/.exec(outcome.toLowerCase())?.[1] ?? "";
  // The specialists the outcome calls for (the ones not built yet are proposed anyway; the mission says which exist).
  const team = /^(learn|train|prepare)/.test(verb) ? ["tutor", "coach", "researcher"]
    : /^(buy|move)/.test(verb) ? ["researcher", "analyst", "steward", "negotiator"]
    : /^(travel|plan)/.test(verb) ? ["researcher", "planner"]
    : /^build/.test(verb) ? ["builder", "auditor"]
    : /^(remodel|renovate)/.test(verb) ? ["researcher", "analyst", "liaison"] : ["researcher", "planner"];
  const by = /\bby (\d{4}-\d{2}-\d{2})\b/.exec(t)?.[1];
  return { name, outcome: outcome.slice(0, 300), ...(known.includes(here) && here !== "general" ? { owner: here } : {}), consulted: [], specialists: team, ...(by ? { target: by } : {}) };
}

export async function dispatch(i: DispatchInput): Promise<Dispatch> {
  const now = i.now ?? Date.now();
  const message = i.message.trim();
  const sc = i.scope;
  const here = sc ? `mission/${sc.slug}` : (i.domain || "general").toLowerCase();
  const chief = readChiefOfStaff(i.vault);
  const specs = loadSpecialists(i.vault);
  const on = new Set(specs.filter((s) => s.on).map((s) => s.id));
  const known = routableDomains(i.vault).filter((d) => !d.startsWith("_"));
  const never = new Set(chief.neverRead);
  const named = (d: string) => new RegExp(`\\b${d.replace(/-/g, "[- ]")}\\b`, "i").test(message);
  const inScope = new Set(sc?.domains.map((d) => d.slug) ?? []);

  // @Researcher by hand (or "@A @B", or chips): one run of those specialists
  // side by side, owned by this domain (or mission).
  const { names, rest } = leadingMentions(message);
  const find = (n: string) => specs.find((x) => x.on && (x.id === n.toLowerCase() || x.name.toLowerCase() === n.toLowerCase()));
  const hand = [...new Set([...(i.to ?? []), ...names].map(find).filter((s): s is Specialist => !!s))].slice(0, 4);
  if (hand.length) {
    const ask = (names.every((n) => find(n)) ? rest : message).trim() || message;
    const consulted = sc ? sc.domains.filter((d) => d.role !== "informed").map((d) => d.slug) : [];
    const who = hand.map((s) => s.name).join(" and ");
    const job = newJob({ ask, here, thread: i.thread, kind: "mention", owner: here, consulted, informed: [], team: [{ step: 1, specialists: hand.map((s) => s.id) }], effort: "standard", why: `handed to the ${who} by hand`, now });
    // The budget is the tightest of the team's and the user's limits.
    job.budget = { usd: Math.min(...hand.map((s) => s.budget.usd * s.budget.passes), chief.limits.usd), minutes: Math.min(...hand.map((s) => s.budget.minutes), chief.limits.minutes) };
    if (sc) job.mission = { slug: sc.slug, ceiling: sc.ceiling, budgetLeftUsd: sc.budgetLeftUsd };
    decideStart(i.vault, job, specs, chief.limits, true);
    return { kind: "job", job, confident: true, mention: hand[0]!.id };
  }

  // Inside a mission, a domain the message names that the mission did not
  // bring in is never read: the user is asked first (never-read ones always).
  if (sc) {
    const outside = known.filter((d) => !inScope.has(d) && named(d));
    if (outside.length) {
      const nv = outside.some((d) => never.has(d));
      return { kind: "bring-in", confident: true, bringIn: { domains: outside, never: nv, why: `${outside.join(" and ")} ${outside.length === 1 ? "is" : "are"} not in the project ${sc.name}` } };
    }
  } else {
    const draft = missionDraftFrom(message, here, known);
    if (draft) return { kind: "mission", confident: true, mission: draft };
  }

  const shape = shapeOf(message);
  if (!shape) return { kind: "answer", confident: true };

  const learned = learnedStaffing(i.vault);
  let dm: DispatchModel | null = null;
  if (i.runner !== null) {
    const { readDomainGoals } = await import("./goals.ts");
    const pool = known.filter((d) => !never.has(d) || named(d));
    const domains = pool.map((d) => ({ slug: d, goals: [...(inScope.has(d) ? ["(in this project)"] : []), ...readDomainGoals(i.vault, d).filter((g) => g.status === "active").map((g) => g.title)] }));
    const { system, prompt } = buildDispatchPrompt(message, sc ? `the project ${sc.name}` : here, domains, [...chief.learned, ...learned.lines]);
    try {
      const runner = i.runner ?? (await import("./route.ts")).claudeRouteRunner;
      dm = parseDispatchReply(await runner({ system, prompt: sc ? `${prompt}\nThis is a project: prefer the domains marked (in this project); name another only when the job truly needs it.` : prompt, timeoutMs: 40_000 }), known);
    } catch { dm = null; }
  }
  // The model may reach outside the mission. When the job belongs to another
  // domain, that is a question (bring in), not a read; extra domains it would
  // only consult are left out and named on the card.
  let leftOut: string[] = [];
  if (sc && dm) {
    if (dm.owner && !inScope.has(dm.owner)) return { kind: "bring-in", confident: true, bringIn: { domains: [dm.owner], never: never.has(dm.owner), why: dm.why ? `the job belongs to ${dm.owner}: ${dm.why}` : `the job belongs to ${dm.owner}` } };
    leftOut = [...new Set([...(dm.consulted ?? []), ...(dm.informed ?? [])].filter((d) => !inScope.has(d)))];
  }
  // Owner: inside a mission the mission owns the outcome; a domain only for a domain-owned write.
  const owner = sc ? here : dm?.owner ?? (known.includes(here) ? here : "general");
  const keep = (d: string) => d !== owner && (!never.has(d) || named(d)) && (!sc || inScope.has(d));
  const scConsulted = sc ? sc.domains.filter((d) => d.role !== "informed").map((d) => d.slug) : [];
  const scInformed = sc ? sc.domains.filter((d) => d.role === "informed").map((d) => d.slug) : [];
  const consulted = [...new Set([...(sc && dm?.owner ? [dm.owner] : []), ...(dm?.consulted ?? []), ...(sc && !dm ? scConsulted : []), ...(learned.consult.get(owner) ?? [])])].filter(keep).slice(0, 3);
  const informed = [...new Set([...(dm?.informed ?? []), ...scInformed])].filter((d) => keep(d) && !consulted.includes(d)).slice(0, 3);
  // A mission's own specialists staff it when it named any.
  const pool = sc && sc.specialists.length ? new Set([...on].filter((x) => sc.specialists.includes(x) || x === "editor" || x === "steward")) : on;
  const teamOpts = { openEnded: dm?.open_ended, decision: dm?.decision, money: dm?.money, numbers: dm?.numbers };
  let team = teamFor(shape, pool, teamOpts);
  if (!team.length && sc) team = teamFor(shape, on, teamOpts);
  const skip = learned.skip.get(owner);
  if (skip) team = team.map((s) => ({ ...s, specialists: s.specialists.filter((x) => !skip.has(x)) })).filter((s) => s.specialists.length).map((s, n) => ({ ...s, step: n + 1 }));
  if (!team.length) return { kind: "answer", confident: true };
  const effort = dm?.effort ?? "standard";
  const why = `${dm?.why ?? `${shape} job`}${leftOut.length ? ` (left out, not in the project: ${leftOut.join(", ")})` : ""}`;
  const job = newJob({ ask: message, here, thread: i.thread, kind: i.trigger ?? "chat", owner, consulted, informed, team, effort, why, now });
  if (sc) job.mission = { slug: sc.slug, ceiling: sc.ceiling, budgetLeftUsd: sc.budgetLeftUsd };
  // Unsure: the model did not answer, so the domains are a guess (a mission's own scope is not a guess).
  const confident = !!dm || !!sc;
  decideStart(i.vault, job, specs, chief.limits, confident);
  return { kind: "job", job, confident };
}

function newJob(o: { ask: string; here: string; thread?: string; kind: TriggerKind; owner: string; consulted: string[]; informed: string[]; team: TeamStep[]; effort: Effort; why: string; now: number }): Job {
  return {
    id: makeJobId(o.ask, o.now), ask: o.ask, origin: { kind: o.kind, ...(o.thread ? { thread: o.thread } : {}), domain: o.here },
    domains: { owner: o.owner, consulted: o.consulted, informed: o.informed }, entities: [], team: o.team,
    effort: o.effort, budget: { ...EFFORT_BUDGET[o.effort] }, why: o.why, playbook: null, status: "proposed", startsAlone: false, created: o.now,
  };
}

/** May this job start without asking? Sets startsAlone and askReason. */
export function decideStart(vault: string, job: Job, specs: Specialist[], limits: { usd: number; minutes: number }, confident: boolean): void {
  const reasons: string[] = [];
  if (isPaused(vault)) reasons.push("autonomy is paused");
  for (const st of job.team) for (const id of st.specialists) {
    const s = specs.find((x) => x.id === id);
    if (!s || !s.on) reasons.push(`the ${id} is not available`);
    else if (ceilingRank(s.ceiling) > ceilingRank("act-ask")) reasons.push(`the ${s.name} would act`);
    else if (s.outside) reasons.push(`it sends your words to ${s.name}, an outside agent`);
    else if (job.mission && ceilingRank(s.ceiling) > ceilingRank(job.mission.ceiling)) reasons.push(`the ${s.name} goes past this project's ceiling (${job.mission.ceiling})`);
  }
  // Money in a mission: anything that spends asks, and past what is left it says so.
  if (job.mission && job.mission.budgetLeftUsd != null) {
    const amount = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/.exec(job.ask);
    if (amount && Number(amount[1]!.replace(/,/g, "")) > job.mission.budgetLeftUsd) reasons.push(`it is over what is left of the mission's budget ($${job.mission.budgetLeftUsd})`);
  }
  if (job.budget.usd > limits.usd || job.budget.minutes > limits.minutes) reasons.push(`over your limit of $${limits.usd} and ${limits.minutes} minutes`);
  const sensitive = askFirstReason(job.ask);
  if (sensitive) reasons.push(sensitive);
  if (!confident) reasons.push("I am not sure how to staff it");
  // Goals G3: serves, costs and rules on every job. A rule the ask would
  // break (a hard limit, or one already broken) means it never starts alone.
  try {
    const missionGoal = job.mission ? readMissionGoal(vault, job.mission.slug) : undefined;
    const jc = jobCompass(vault, job, missionGoal);
    if (jc.serves.length || jc.costs.length || jc.rules.length) job.compass = jc;
    const rg = ruleGate(vault, job.ask);
    if (rg) reasons.push(rg.reason);
  } catch { /* no Compass */ }
  job.startsAlone = reasons.length === 0;
  job.askReason = reasons.length ? reasons.join("; ") : undefined;
}

function readMissionGoal(vault: string, slug: string): string | undefined {
  try { return readMission(vault, slug)?.goal || undefined; } catch { return undefined; }
}

// ── Adjust (a correction, logged and learned) ───────────────────────────────

export interface Adjust { owner?: string; consulted?: string[]; informed?: string[]; team?: string[][]; effort?: Effort }

export function adjustJob(vault: string, id: string, a: Adjust, now = Date.now()): Job {
  const job = readJob(vault, id);
  if (!job) throw new Error(`no job ${id}`);
  if (job.status === "running") throw new Error("stop the job before adjusting it");
  const known = new Set(listDomainDirs(vault).filter((d) => !d.startsWith("_")));
  const specs = loadSpecialists(vault);
  const log = (field: string, before: string[], after: string[]) => {
    const removed = before.filter((x) => !after.includes(x));
    const added = after.filter((x) => !before.includes(x));
    if (removed.length || added.length) appendJsonl(staffingPath(vault), { ts: now, job: id, owner: a.owner ?? job.domains.owner, field, removed, added });
  };
  if (a.owner && a.owner !== job.domains.owner) {
    if (!known.has(a.owner)) throw new Error(`unknown domain ${a.owner}`);
    log("owner", [job.domains.owner], [a.owner]);
    job.domains.owner = a.owner;
  }
  for (const k of ["consulted", "informed"] as const) {
    const v = a[k];
    if (!v) continue;
    const next = [...new Set(v)].filter((d) => known.has(d) && d !== job.domains.owner).slice(0, 4);
    log(k, job.domains[k], next);
    job.domains[k] = next;
  }
  if (a.team) {
    const next = a.team.map((ids) => ids.filter((x) => specs.some((s) => s.id === x && s.on))).filter((x) => x.length);
    if (!next.length) throw new Error("a team needs at least one specialist that is on");
    log("team", job.team.flatMap((s) => s.specialists), next.flat());
    job.team = next.map((ids, n) => ({ step: n + 1, specialists: ids, ...(ids.includes("steward") ? { gate: true } : {}) }));
  }
  if (a.effort && a.effort !== job.effort) {
    log("effort", [job.effort], [a.effort]);
    job.effort = a.effort;
    job.budget = { ...EFFORT_BUDGET[a.effort] };
  }
  if (job.status !== "proposed" && job.status !== "needs-approval") job.status = "proposed";
  decideStart(vault, job, specs, readChiefOfStaff(vault).limits, true);
  saveJob(vault, job);
  rememberLessons(vault, now);
  return job;
}

/** New lessons from the Adjust log go into "What I've learned" (readable, editable, versioned). */
function rememberLessons(vault: string, now: number): void {
  const lines = learnedStaffing(vault).lines;
  if (!lines.length) return;
  const p = chiefOfStaffPath(vault);
  const text = readText(p);
  const have = new Set(parseChiefOfStaff(text).learned.map((l) => l.toLowerCase()));
  const fresh = lines.filter((l) => !have.has(l.toLowerCase()));
  if (!fresh.length) return;
  let next: string;
  if (/^##\s+What I've learned\s*$/im.test(text)) {
    next = text.replace(/^(##\s+What I've learned\s*\n)/im, `$1${fresh.map((l) => `- ${l}`).join("\n")}\n`);
  } else {
    next = `${text.replace(/\s*$/, "")}\n\n## What I've learned\n${fresh.map((l) => `- ${l}`).join("\n")}\n`;
  }
  writeVersioned(p, next, now);
}

// ── Running a job ───────────────────────────────────────────────────────────

const USD_PER_1K: Record<string, { in: number; out: number }> = {
  claude: { in: 0.003, out: 0.015 }, codex: { in: 0.0025, out: 0.01 }, antigravity: { in: 0.00125, out: 0.005 }, ollama: { in: 0, out: 0 },
};
export function estimateUsd(cli: string, promptChars: number, replyChars: number): number {
  const p = USD_PER_1K[cli] ?? USD_PER_1K.claude!;
  return Math.round(((promptChars / 4000) * p.in + (replyChars / 4000) * p.out) * 1e4) / 1e4;
}

export interface StepOutput {
  summary: string; body: string; sources: string[]; check: { ok: boolean; missing: string[] };
  notebook: string[]; verdict?: string; drafts?: { to: string; subject: string; body: string }[];
  filed?: { decision?: string; task?: { text: string; due?: string }; tasks?: { text: string; due?: string }[]; notes?: Record<string, string> };
  /** Operator: the actions it names (each goes through the broker). */
  actions?: { action: string; why?: string; undo?: string }[];
  /** Skeptic: the pre-mortem. */
  risks?: { risk: string; sign?: string; odds?: string }[];
  /** Interviewer: questions that fill the domain's gaps. */
  questions?: string[];
  /** Coach: Compass lines in the user's own words (proposed, never written), and if-then plans. */
  candidates?: { kind: string; title: string; quote: string }[];
  plans?: { goal?: string; if_then: string }[];
  /** Negotiator: leverage on each side, the first ask and the walk-away point. */
  leverage?: { side: string; what: string; source?: string }[];
  ask?: string; walkAway?: string;
  /** Liaison: who is due a note, and why now. */
  nudges?: { person: string; why: string }[];
  /** Tutor: the curriculum, a quiz with answers, a review date. */
  lessons?: { title: string; steps?: string }[];
  quiz?: { q: string; a: string }[];
  review?: string;
  /** Confidant: patterns, each with the user's own words, and one question. */
  patterns?: { pattern: string; quote: string }[];
  question?: string;
}

export function parseStepOutput(raw: string): StepOutput {
  const text = raw.trim();
  // A reply that is JSON already wins: its body may hold fenced blocks of its own (a Builder's files).
  const fence = text.startsWith("{") ? null : /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const cand = fence ? fence[1]! : text;
  const a = cand.indexOf("{");
  const b = cand.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(cand.slice(a, b + 1)) as Partial<StepOutput> & { check?: { ok?: boolean; missing?: string[] } };
      const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
      return {
        summary: String(j.summary ?? "").slice(0, 400),
        body: String(j.body ?? ""),
        sources: strs(j.sources).slice(0, 40),
        check: { ok: j.check?.ok !== false, missing: strs(j.check?.missing).slice(0, 8) },
        notebook: strs(j.notebook).slice(0, 3),
        ...(typeof j.verdict === "string" ? { verdict: j.verdict.slice(0, 40) } : {}),
        ...(Array.isArray(j.drafts) ? { drafts: (j.drafts as StepOutput["drafts"])!.filter((d) => d && typeof d.body === "string").slice(0, 6).map((d) => ({ to: String(d.to ?? ""), subject: String(d.subject ?? ""), body: String(d.body) })) } : {}),
        ...(j.filed && typeof j.filed === "object" ? { filed: j.filed as StepOutput["filed"] } : {}),
        ...(Array.isArray(j.actions) ? { actions: (j.actions as { action?: unknown; why?: unknown; undo?: unknown }[]).filter((a) => a && typeof a.action === "string" && a.action.trim()).slice(0, 5).map((a) => ({ action: String(a.action).slice(0, 300), ...(typeof a.why === "string" ? { why: a.why.slice(0, 200) } : {}), ...(typeof a.undo === "string" ? { undo: a.undo.slice(0, 200) } : {}) })) } : {}),
        ...(Array.isArray(j.risks) ? { risks: (j.risks as { risk?: unknown; sign?: unknown; odds?: unknown }[]).filter((r) => r && typeof r.risk === "string").slice(0, 8).map((r) => ({ risk: String(r.risk).slice(0, 300), ...(typeof r.sign === "string" ? { sign: r.sign.slice(0, 200) } : {}), ...(typeof r.odds === "string" ? { odds: r.odds.slice(0, 20) } : {}) })) } : {}),
        ...(Array.isArray(j.questions) ? { questions: strs(j.questions).map((q) => q.trim().slice(0, 240)).filter(Boolean).slice(0, 5) } : {}),
        ...(Array.isArray(j.candidates) ? { candidates: (j.candidates as { kind?: unknown; title?: unknown; quote?: unknown }[]).filter((c) => c && typeof c.title === "string" && typeof c.quote === "string").slice(0, 6).map((c) => ({ kind: ["goal", "value", "rule"].includes(String(c.kind)) ? String(c.kind) : "goal", title: String(c.title).slice(0, 120), quote: String(c.quote).slice(0, 400) })) } : {}),
        ...(Array.isArray(j.leverage) ? { leverage: (j.leverage as { side?: unknown; what?: unknown; source?: unknown }[]).filter((x) => x && typeof x.what === "string").slice(0, 8).map((x) => ({ side: String(x.side ?? "").slice(0, 20), what: String(x.what).slice(0, 240), ...(typeof x.source === "string" ? { source: x.source.slice(0, 200) } : {}) })) } : {}),
        ...(typeof (j as { ask?: unknown }).ask === "string" ? { ask: String((j as { ask: string }).ask).slice(0, 240) } : {}),
        ...(typeof (j as { walk_away?: unknown }).walk_away === "string" ? { walkAway: String((j as { walk_away: string }).walk_away).slice(0, 240) } : {}),
        ...(Array.isArray(j.nudges) ? { nudges: (j.nudges as { person?: unknown; why?: unknown }[]).filter((x) => x && typeof x.person === "string" && typeof x.why === "string").slice(0, 5).map((x) => ({ person: String(x.person).slice(0, 80), why: String(x.why).slice(0, 200) })) } : {}),
        ...(Array.isArray(j.lessons) ? { lessons: (j.lessons as { title?: unknown; steps?: unknown }[]).filter((x) => x && typeof x.title === "string").slice(0, 7).map((x) => ({ title: String(x.title).slice(0, 120), ...(typeof x.steps === "string" ? { steps: x.steps.slice(0, 600) } : {}) })) } : {}),
        ...(Array.isArray(j.quiz) ? { quiz: (j.quiz as { q?: unknown; a?: unknown }[]).filter((x) => x && typeof x.q === "string" && typeof x.a === "string").slice(0, 12).map((x) => ({ q: String(x.q).slice(0, 240), a: String(x.a).slice(0, 240) })) } : {}),
        ...(typeof j.review === "string" ? { review: j.review.slice(0, 10) } : {}),
        ...(Array.isArray(j.patterns) ? { patterns: (j.patterns as { pattern?: unknown; quote?: unknown }[]).filter((x) => x && typeof x.pattern === "string" && typeof x.quote === "string").slice(0, 3).map((x) => ({ pattern: String(x.pattern).slice(0, 200), quote: String(x.quote).slice(0, 300) })) } : {}),
        ...(typeof j.question === "string" ? { question: j.question.slice(0, 240) } : {}),
        ...(Array.isArray(j.plans) ? { plans: (j.plans as { goal?: unknown; if_then?: unknown }[]).filter((x) => x && typeof x.if_then === "string").slice(0, 8).map((x) => ({ ...(typeof x.goal === "string" ? { goal: x.goal.slice(0, 120) } : {}), if_then: String(x.if_then).slice(0, 300) })) } : {}),
      };
    } catch { /* fall through: prose */ }
  }
  return { summary: text.split("\n").find((l) => l.trim())?.slice(0, 400) ?? "", body: text, sources: [...text.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0]).slice(0, 40), check: { ok: text.length > 40, missing: [] }, notebook: [] };
}

/** The code half of the self-check: claims need sources, a verdict needs a verdict. */
export function codeCheck(s: Specialist, o: StepOutput): string[] {
  const miss: string[] = [];
  if (o.body.trim().length < 20 && !(o.drafts?.length)) miss.push("the result is empty");
  if ((s.returns === "findings" || s.returns === "discoveries") && !o.sources.length) miss.push("no sources");
  if (s.returns === "verdict" && !/fit/i.test(o.verdict ?? o.summary)) miss.push("no verdict (fits, fits with changes, does not fit)");
  if (s.returns === "draft" && !(o.drafts?.length)) miss.push("no drafts");
  if (s.returns === "numbers" && !/\d/.test(o.summary + o.body)) miss.push("no numbers");
  if (s.returns === "numbers" && !o.sources.length) miss.push("no sources for the numbers");
  if (s.returns === "timeline" && (o.body.match(/\b(19|20)\d{2}(-\d{2})?\b/g) ?? []).length < 2) miss.push("no dated lines");
  if (s.returns === "verified" && !/\b(verified|flagged)\b/i.test(o.verdict ?? o.summary)) miss.push("no verdict (verified or flagged)");
  if (s.returns === "build" && !buildFiles(o.body).length) miss.push("no files (fenced blocks starting with a path line)");
  if (s.returns === "vault changes" && !(o.filed?.task || o.filed?.tasks?.length || Object.keys(o.filed?.notes ?? {}).length)) miss.push("no changes to file");
  if (s.returns === "action" && !(o.actions?.length)) miss.push("no actions named");
  if (s.returns === "risks" && (o.risks ?? []).filter((r) => r.sign).length < 2) miss.push("fewer than two risks with an early sign");
  if (s.returns === "memory updates" && !(o.questions ?? []).some((q) => q.endsWith("?"))) miss.push("no questions");
  if (s.returns === "goals" && !(o.plans?.length || o.candidates?.length || /\bif\b[\s\S]{2,}?\bthen\b/i.test(o.body))) miss.push("no if-then plan and nothing in the user's words");
  if (s.returns === "repairs" && !(o.filed?.tasks?.length || o.filed?.task) && !/nothing to repair/i.test(o.summary + o.body)) miss.push("no repairs filed and no \"nothing to repair\"");
  if (s.returns === "strategy") {
    if (!(o.leverage ?? []).some((l) => /them|other/i.test(l.side)) || !(o.leverage ?? []).some((l) => /you|user|me|us/i.test(l.side))) miss.push("leverage on both sides");
    if (!o.ask || !o.walkAway) miss.push("a first ask and a walk-away point");
    if (!o.drafts?.length) miss.push("no script or counteroffer draft");
  }
  if (s.returns === "nudges") {
    if (!(o.nudges ?? []).length) miss.push("nobody named");
    if ((o.drafts?.length ?? 0) < (o.nudges ?? []).length) miss.push("a check-in draft for each person");
  }
  if (s.returns === "lessons") {
    const n = (o.lessons ?? []).length;
    if (n < 3 || n > 7) miss.push("three to seven lessons");
    if ((o.quiz ?? []).length < 3) miss.push("a quiz of at least three questions with answers");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.review ?? "")) miss.push("a review date (YYYY-MM-DD)");
  }
  if (s.returns === "reflection") {
    if (!(o.patterns ?? []).length) miss.push("no pattern with the user's own words");
    if (!(o.question ?? "").trim().endsWith("?")) miss.push("one question to sit with");
  }
  return miss;
}

/** Files a Builder wrote: fenced blocks whose first line is "path: <name>". Names are kept to safe relative paths. */
export function buildFiles(body: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const m of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const lines = m[1]!.split("\n");
    const p = /^\s*(?:\/\/|#|<!--)?\s*path:\s*([A-Za-z0-9._/-]{1,120})\s*(?:-->)?\s*$/.exec(lines[0] ?? "")?.[1];
    if (!p || p.includes("..") || p.startsWith("/")) continue;
    out.push({ path: p, text: lines.slice(1).join("\n") });
  }
  return out;
}

function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}\n(cut)` : s; }

/** A job owner's folder key: a mission owner (mission/<slug>) is stored under `_mission-<slug>`. */
export function spaceKey(owner: string): string {
  const ms = missionScopeSlug(owner);
  return ms ? `_mission-${ms}` : owner;
}

/** What the team reads: the Compass, the owner domain (or mission), then each consulted domain. */
export function jobContext(vault: string, job: Job): string {
  const parts: string[] = [];
  const c = compassBlock(vault);
  if (c) parts.push(c);
  const dir = resolveDomainDir(vault, job.domains.owner);
  const isMission = !!missionScopeSlug(job.domains.owner);
  const owner = [
    isMission ? `# OWNER: the project ${job.domains.owner}` : `# OWNER DOMAIN: ${job.domains.owner}`,
    isMission ? clip(readText(join(dir, "mission.md")).replace(/^---\n[\s\S]*?\n---\n?/, ""), 1500) : "",
    clip(readText(join(dir, "ideal-state.md")), 1500),
    clip(readText(join(dir, "memory", "memory.md")), 2500),
    clip(readText(join(dir, "memory", "state.md")), 1500),
    goalsBlock(vault, job.domains.owner),
  ].filter(Boolean).join("\n\n");
  parts.push(owner);
  for (const d of job.domains.consulted) {
    const dd = resolveDomainDir(vault, d);
    const body = clip(readText(join(dd, "memory", "state.md")) || readText(join(dd, "memory", "memory.md")), 1500);
    parts.push(`# CONSULTED DOMAIN: ${d}\n${body || "Nothing recorded yet."}`);
  }
  return parts.join("\n\n---\n\n");
}

export function specialistPrompt(o: { s: Specialist; notes: string; notebook: string[]; job: Job; context: string; prior: { name: string; returns: string; body: string }[]; missing: string[]; brief?: string; facts?: string }): string {
  const { s, job } = o;
  const tells = [...job.domains.consulted, ...job.domains.informed];
  const extra = s.returns === "verdict"
    ? ',\n  "verdict": "fits | fits with changes | does not fit"'
    : s.returns === "verified"
      ? ',\n  "verdict": "verified | flagged"'
    : s.returns === "vault changes"
      ? `,\n  "filed": { "tasks": [{ "text": "<a task for the owner>", "due": "YYYY-MM-DD" }], "notes": { ${tells.map((d) => `"${d}": "<one line this domain should know>"`).join(", ")} } }`
    : s.returns === "page"
      ? `,\n  "filed": { "decision": "<one line the owner should keep as the decision, or omit>", "task": { "text": "<the next step for the user>", "due": "YYYY-MM-DD" }, "notes": { ${tells.map((d) => `"${d}": "<one line this domain should know>"`).join(", ")} } }`
      : s.returns === "draft" ? ',\n  "drafts": [{ "to": "<who>", "subject": "<subject>", "body": "<text>" }]'
      : s.returns === "action" ? ',\n  "actions": [{ "action": "<one concrete step: verb, what, where, amount when money moves>", "why": "<the plan step it carries out>", "undo": "<how to undo it, or: cannot be undone>" }]'
      : s.returns === "risks" ? ',\n  "risks": [{ "risk": "<one way it fails>", "sign": "<the early sign to watch>", "odds": "low | medium | high" }]'
      : s.returns === "memory updates" ? ',\n  "questions": ["<one short question that fills one gap>"]'
      : s.returns === "goals" ? ',\n  "plans": [{ "goal": "<goal id or title>", "if_then": "If <a cue that happens anyway>, then <one small step>." }],\n  "candidates": [{ "kind": "goal | value | rule", "title": "<in the user\'s own words>", "quote": "<their exact words, copied from the notes>" }]'
      : s.returns === "repairs" ? `,\n  "filed": { "tasks": [{ "text": "<one repair: what is broken and the fix>", "due": "YYYY-MM-DD" }] }`
      : s.returns === "strategy" ? ',\n  "leverage": [{ "side": "you | them", "what": "<one source of leverage>", "source": "<where it comes from>" }],\n  "ask": "<the first ask>",\n  "walk_away": "<the walk-away point>",\n  "drafts": [{ "to": "<who>", "subject": "<subject>", "body": "<the opening message or counteroffer>" }]'
      : s.returns === "nudges" ? ',\n  "nudges": [{ "person": "<a person the notes know>", "why": "<why now>" }],\n  "drafts": [{ "to": "<the same person>", "subject": "", "body": "<a short check-in in the user\'s voice>" }]'
      : s.returns === "lessons" ? ',\n  "lessons": [{ "title": "<lesson>", "steps": "<what to do in one sitting>" }],\n  "quiz": [{ "q": "<question on the first lesson>", "a": "<answer>" }],\n  "review": "YYYY-MM-DD"'
      : s.returns === "reflection" ? ',\n  "patterns": [{ "pattern": "<what keeps coming up>", "quote": "<the user\'s exact words, copied from the notes>" }],\n  "question": "<one open question for the user>"' : "";
  return [
    `You are the ${s.name}, one specialist on a team the user's chief of staff put together. You return one result; you never contact anyone, buy anything or change anything.`,
    `## Mandate\n${s.mandate}`,
    `## Method\n${s.method}`,
    `## Never\n${s.never}`,
    s.doneWhen.length ? `## Done when\n${s.doneWhen.map((d) => `- ${d}`).join("\n")}` : "",
    `## The job\n${job.ask}\nYour part: ${o.brief ?? (s.returns === "page" ? "turn the team's results into one page" : `your ${s.returns} for this job`)}.\nOwner domain: ${job.domains.owner}.${job.domains.consulted.length ? ` Also read: ${job.domains.consulted.join(", ")}.` : ""}`,
    o.notes ? `## The user's instructions for you in ${job.domains.owner}\n${o.notes}` : "",
    o.notebook.length ? `## What you learned here before\n${o.notebook.map((l) => `- ${l}`).join("\n")}` : "",
    o.facts ? `## What code already knows (computed, not guessed)\n${o.facts}` : "",
    `## Context (the user's own notes, read only)\n${o.context}`,
    o.prior.length ? `## Results from earlier steps\n${o.prior.map((p) => `### ${p.name} (${p.returns})\n${clip(p.body, 6000)}`).join("\n\n")}` : "",
    o.missing.length ? `## Your last pass missed\n${o.missing.map((m) => `- ${m}`).join("\n")}\nFix these.` : "",
    "## Reply",
    `Return ONLY JSON, no prose around it:\n{ "summary": "<one line: the answer>",\n  "body": "<your result in markdown>",\n  "sources": ["<url or vault file for each claim>"],\n  "check": { "ok": <true if every done-when item is met>, "missing": ["<done-when items not met>"] },\n  "notebook": ["<at most 2 short lessons worth keeping for ${job.domains.owner}, or none>"]${extra} }`,
  ].filter(Boolean).join("\n\n");
}

export interface RunDeps {
  /** An outside agent's call (tests pass a stub; nothing reaches the network). */
  callOutside?: typeof import("./specialists-custom.ts").callOutside;
  detectClis?: typeof import("./cli-bridge.ts").detectClis;
  runChatTurn?: typeof import("./cli-bridge.ts").runChatTurn;
  now?: () => number;
  /** Carries out one action the broker or the user allowed (the Operator's). */
  act?: ActFn;
}
export type ActFn = (vault: string, domain: string, action: string) => Promise<string>;

/** Run a job to the end, in this process. Never throws; the record says what happened. */
export async function runJob(vault: string, id: string, deps: RunDeps = {}): Promise<Job> {
  const clock = deps.now ?? Date.now;
  let job = readJob(vault, id);
  if (!job) throw new Error(`no job ${id}`);
  const dir = jobDir(vault, id);
  if (job.status === "done" || job.status === "running") return job;
  const stopFile = join(dir, "stop");
  job.status = "running";
  job.started = clock();
  job.pid = process.pid;
  delete job.note; // a rerun starts clean; the old note was about the earlier run
  job.progress = [];
  saveJob(vault, job);
  logActivity(vault, { type: "job", domain: job.domains.owner, title: `Job: ${job.ask.slice(0, 80)}`, detail: job.why, status: "pending", ref: id });

  const ac = new AbortController();
  const poll = setInterval(() => { if (existsSync(stopFile)) ac.abort(); }, 1000);
  const finish = (status: JobStatus, note?: string): Job => {
    clearInterval(poll);
    const j = readJob(vault, id) ?? job!;
    const merged: Job = { ...job!, status, ended: clock(), ...(note ? { note } : {}), pid: undefined, progress: job!.progress };
    if (j.status === "stopped") merged.status = "stopped";
    saveJob(vault, merged);
    logActivity(vault, { type: "job", domain: merged.domains.owner, title: `Job ${merged.status}: ${merged.ask.slice(0, 80)}`, detail: merged.note ?? merged.result?.summary ?? "", status: merged.status === "done" ? "ok" : "error", ref: id });
    return merged;
  };

  try {
    const { detectClis, runChatTurn } = await import("./cli-bridge.ts");
    const clis = await (deps.detectClis ?? detectClis)();
    const bunker = process.env.PREVAIL_BUNKER === "1";
    const pool = bunker ? clis.filter((c) => c.kind === "ollama") : clis;
    const cli = pool.find((c) => c.kind === "claude") ?? pool[0];
    if (!cli) return finish("failed", "no AI runtime available");
    const turn = deps.runChatTurn ?? runChatTurn;
    const context = jobContext(vault, job);
    const prior: { name: string; returns: string; body: string; out: StepOutput; id: string }[] = (job.inputs ?? []).map((x, i) => ({ ...x, id: `input-${i}`, out: { summary: x.body.split("\n")[0] ?? "", body: x.body, sources: [], check: { ok: true, missing: [] }, notebook: [] } }));
    const handedIn = prior.length;
    let usd = 0;
    const startMs = clock();
    let n = 0;
    type One = { ok: true; sid: string; spec: Specialist; out: StepOutput } | { ok: false; status: JobStatus; note: string };
    // One specialist run: passes until its check passes, its passes run out,
    // or the step's time does. Specialists in one step run side by side and
    // never see each other's work (only earlier steps').
    const runOne = async (st: TeamStep, sid: string, idx: number, stepMs: number): Promise<One> => {
      const base = getSpecialist(vault, sid);
      if (!base || !base.on) return { ok: false, status: "failed", note: `the ${sid} is not available` };
      const { spec, notes } = forDomain(vault, base, job!.domains.owner);
      if (!spec.on) return { ok: false, status: "failed", note: `the ${spec.name} is off in ${job!.domains.owner}` };
      // Ceilings, in code: nothing that acts runs. The Operator (act-ask) runs
      // read-only and only names actions; code gates each one afterwards.
      if (ceilingRank(spec.ceiling) > ceilingRank("act-ask")) return { ok: false, status: "needs-approval", note: `the ${spec.name} would act on its own; that is never allowed` };
      // A mission's ceiling can only tighten: a read-only mission never drafts.
      if (job!.mission && ceilingRank(spec.ceiling) > ceilingRank(job!.mission.ceiling)) return { ok: false, status: "needs-approval", note: `the ${spec.name} goes past the project's ceiling (${job!.mission.ceiling}); raise it on the project's Setup tab to run it` };
      // An outside agent: only the brief leaves, and only on the user's yes for
      // exactly this brief (an engine act in the Inbox). Its reply is quoted data.
      if (spec.outside) {
        const oc = await import("./specialists-custom.ts");
        const { gateEngineAct } = await import("./act-gate.ts");
        const brief = oneLine(st.brief ?? job!.ask, 2000);
        const host = new URL(spec.outside.endpoint).host;
        const q = gateEngineAct(vault, spaceKey(job!.domains.owner), oc.OUTSIDE_TOOL, { job: job!.id, agent: spec.id, brief }, `Send to ${spec.name} (${host}): ${brief}`);
        if (q.state === "declined") return { ok: false, status: "stopped", note: `you said no to sending this to ${spec.name}; nothing was sent` };
        if (q.state !== "allow") return { ok: false, status: "needs-approval", note: `waiting for your yes to send the brief to ${spec.name} (${host}); nothing was sent` };
        const t0 = clock();
        const r = await (deps.callOutside ?? oc.callOutside)(vault, spec, brief, { now: clock(), signal: ac.signal });
        const rec = { id: `${idx}-${sid}`, specialist: sid, domain: job!.domains.owner, trigger: { kind: job!.origin.kind }, brief, status: r.ok ? "done" : "failed", outside: host, passes: [{ n: 1, check: { ok: r.ok, missing: r.ok ? [] : [r.error] }, usd: 0, ms: clock() - t0 }], result: null as null | { type: string; file: string }, notebook: [] as string[], cost: { usd: 0, minutes: Math.round((clock() - t0) / 600) / 100, estimated: true } };
        if (!r.ok) { writeStep(dir, idx, sid, rec); return { ok: false, status: "failed", note: r.error }; }
        const out: StepOutput = { summary: oneLine(r.text.split("\n").find((l) => l.trim()) ?? "", 300), body: oc.quoteOutside(spec, r.text), sources: [`https://${host}`], check: { ok: true, missing: [] }, notebook: [] };
        writeFileSync(join(dir, "steps", `${idx}-${sid}.result.json`), `${JSON.stringify(out, null, 2)}\n`);
        rec.result = { type: spec.returns, file: `steps/${idx}-${sid}.result.json` };
        writeStep(dir, idx, sid, rec);
        return { ok: true, sid, spec, out };
      }
      const notebook = readNotebook(vault, job!.domains.owner, sid);
      const { specialistFacts } = await import("./specialist-facts.ts");
      const facts = await specialistFacts(vault, sid, job!.domains.owner, clock());
      const record = { id: `${idx}-${sid}`, specialist: sid, domain: job!.domains.owner, trigger: { kind: job!.origin.kind, ...(job!.origin.thread ? { thread: job!.origin.thread } : {}) }, brief: st.brief ?? job!.ask, status: "running", passes: [] as { n: number; check: { ok: boolean; missing: string[] }; usd: number; ms: number }[], result: null as null | { type: string; file: string }, notebook: [] as string[], cost: { usd: 0, minutes: 0, estimated: true } };
      let out: StepOutput | null = null;
      let missing: string[] = [];
      const stepEnd = clock() + Math.min(spec.budget.minutes * 60_000, stepMs);
      for (let pass = 1; pass <= spec.budget.passes; pass++) {
        if (ac.signal.aborted) return { ok: false, status: "stopped", note: "stopped by you" };
        const leftMs = stepEnd - clock();
        if (job!.budget.usd - usd <= 0.01 || leftMs < 20_000) {
          if (out) break;
          record.status = "failed"; writeStep(dir, idx, sid, record);
          return { ok: false, status: "failed", note: `budget reached at the ${spec.name} ($${usd.toFixed(2)} of $${job!.budget.usd}, ${Math.round((clock() - startMs) / 60_000)} of ${job!.budget.minutes} minutes)` };
        }
        job!.progress!.push({ step: st.step, specialist: sid, pass });
        saveJob(vault, job!);
        const prompt = specialistPrompt({ s: spec, notes, notebook, job: job!, context, prior, missing, brief: st.brief, facts });
        const t0 = clock();
        const timeout = AbortSignal.timeout(leftMs);
        const signal = AbortSignal.any([ac.signal, timeout]);
        let raw = "";
        try {
          const web = spec.tools.includes("web");
          raw = await turn({ prompt, cwd: resolveDomainDir(vault, job!.domains.owner), cli, model: "", isFirst: true, bare: true, act: false, webAccess: web ? "allow" : "deny", allowTools: [...(web ? ["WebSearch", "WebFetch"] : []), ...(spec.tools.includes("vault-read") ? ["Read", "Grep", "Glob"] : [])], signal, maxOutputChars: 40_000, guard: { localOnly: bunker } });
        } catch (e) { raw = ""; missing = [`the run failed: ${(e as Error).message}`]; }
        if (ac.signal.aborted) return { ok: false, status: "stopped", note: "stopped by you" };
        // A run cut off by its time limit returns no result, never "(cancelled)" as one.
        if (timeout.aborted || raw.trim() === "(cancelled)") { raw = ""; missing = ["time ran out"]; }
        const cost = estimateUsd(cli.kind, prompt.length, raw.length);
        usd += cost;
        const got = raw ? parseStepOutput(raw) : null;
        const miss = got ? [...(got.check.ok ? [] : got.check.missing), ...codeCheck(spec, got)] : (missing.length ? missing : ["no reply"]);
        if (got && (got.body.trim() || got.drafts?.length)) out = got;
        record.passes.push({ n: pass, check: { ok: !miss.length, missing: miss }, usd: cost, ms: clock() - t0 });
        missing = miss;
        if (!miss.length) break;
      }
      record.cost = { usd: Math.round(record.passes.reduce((a, p) => a + p.usd, 0) * 1e4) / 1e4, minutes: Math.round(record.passes.reduce((a, p) => a + p.ms, 0) / 600) / 100, estimated: true };
      if (!out) { record.status = "failed"; writeStep(dir, idx, sid, record); return { ok: false, status: "failed", note: `the ${spec.name} returned nothing usable${missing.length ? `: ${missing.join("; ")}` : ""}` }; }
      writeFileSync(join(dir, "steps", `${idx}-${sid}.result.json`), `${JSON.stringify(out, null, 2)}\n`);
      record.result = { type: spec.returns, file: `steps/${idx}-${sid}.result.json` };
      record.status = missing.length ? "done-with-gaps" : "done";
      record.notebook = appendNotebook(vault, job!.domains.owner, sid, out.notebook);
      writeStep(dir, idx, sid, record);
      return { ok: true, sid, spec, out };
    };
    for (let si = 0; si < job.team.length; si++) {
      const st = job.team[si]!;
      // Time for this step: what is left, keeping about a minute and a half for each later step.
      const later = job.team.length - si - 1;
      const stepMs = Math.max(60_000, (job.budget.minutes - (clock() - startMs) / 60_000 - later * 1.5) * 60_000);
      const runs = await Promise.all(st.specialists.map((sid) => runOne(st, sid, ++n, stepMs)));
      const bad = runs.find((r): r is Extract<One, { ok: false }> => !r.ok);
      if (bad) return finish(bad.status, bad.note);
      for (const r of runs as Extract<One, { ok: true }>[]) {
        prior.push({ name: r.spec.name, returns: r.spec.returns, body: r.out.body + (r.out.sources.length ? `\n\nSources:\n${r.out.sources.map((x) => `- ${x}`).join("\n")}` : ""), out: r.out, id: r.sid });
      }
      // A gate stops the job when the check says it does not fit.
      if (st.gate) {
        const v = prior.filter((p) => st.specialists.includes(p.id)).map((p) => p.out.verdict ?? p.out.summary).join(" ");
        if (/does not fit|doesn't fit|\bflagged\b/i.test(v)) {
          job.result = { type: "verdict", summary: v, verdict: v };
          job.cost = { usd: Math.round(usd * 100) / 100, minutes: Math.round((clock() - startMs) / 600) / 100, estimated: true };
          return finish("needs-approval", `stopped at the gate: ${v}`);
        }
      }
    }
    // The result, and what gets filed.
    if (prior.length === handedIn) return finish("failed", "no specialist ran");
    const last = prior[prior.length - 1]!;
    const verdict = prior.find((p) => p.returns === "verdict")?.out.verdict;
    const drafts = prior.flatMap((p) => p.out.drafts ?? []);
    const result: JobResult = { type: last.returns, summary: last.out.summary || last.out.body.split("\n")[0]!.slice(0, 300), ...(verdict ? { verdict } : {}), ...(drafts.length ? { drafts } : {}) };
    writeFileSync(join(dir, "result.json"), `${JSON.stringify({ ...result, body: last.out.body, sources: last.out.sources }, null, 2)}\n`);
    job.result = result;
    job.cost = { usd: Math.round(usd * 100) / 100, minutes: Math.round((clock() - startMs) / 600) / 100, estimated: true };
    saveJob(vault, job);
    fileResults(vault, job, last, drafts, clock(), prior.slice(handedIn));
    job = readJob(vault, id) ?? job;
    await gateOperator(vault, job, prior.slice(handedIn), deps, clock());
    job = readJob(vault, id) ?? job;
    return finish("done");
  } catch (e) {
    return finish("failed", `error: ${(e as Error).message}`);
  }
}

// ── The Operator's actions, each behind the broker ─────────────────────────

/** The domain an action runs in: a mission's owner domain, or the owner. */
function actDomain(vault: string, owner: string): string {
  const ms = missionScopeSlug(owner);
  if (!ms) return owner;
  try { return readMission(vault, ms)?.domains.find((d) => d.role === "owner")?.slug ?? "general"; } catch { return "general"; }
}

async function defaultAct(vault: string, domain: string, action: string): Promise<string> {
  const { executeAction } = await import("./daemon-loops.ts");
  const { detectClis } = await import("./cli-bridge.ts");
  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === "claude") ?? clis[0];
  if (!cli) throw new Error("no AI runtime available");
  return executeAction({ vaultPath: vault, intervalSec: 0, provider: cli.kind, model: "" }, domain, action);
}

/**
 * Every action the Operator named goes through broker.gateAction (pause, the
 * autonomy policy, the Compass rules, a mission's ceiling and money). Blocked
 * ones stop there; ones that ask wait in the Inbox (the act queue) for a yes;
 * only a class the user's policy lets run alone, with autonomy on auto, runs
 * now. Code decides; the Operator's own words never do.
 */
export async function gateOperator(vault: string, job: Job, ran: { returns: string; out: StepOutput }[], deps: RunDeps = {}, now = Date.now()): Promise<OperatorAction[]> {
  const named = ran.flatMap((x) => (x.returns === "action" ? x.out.actions ?? [] : [])).slice(0, 5);
  if (!named.length) return [];
  const { gateAction } = await import("./broker.ts");
  const { isAuto } = await import("./autonomy.ts");
  const { gateEngineAct, OPERATOR_TOOL } = await import("./act-gate.ts");
  const out: OperatorAction[] = [];
  for (const [i, a] of named.entries()) {
    const n = i + 1;
    const g = gateAction(a.action, { vault, autonomousActs: isAuto(vault), ...(job.mission ? { mission: job.mission } : {}) });
    const base = { n, text: oneLine(a.action, 300), ...(a.why ? { why: oneLine(a.why) } : {}), ...(a.undo ? { undo: oneLine(a.undo) } : {}), cls: g.cls, ts: now };
    if (g.decision === "block") { out.push({ ...base, status: "blocked", reason: g.reason ?? "blocked" }); continue; }
    if (g.decision === "ask") {
      const q = gateEngineAct(vault, spaceKey(job.domains.owner), OPERATOR_TOOL, { job: job.id, n, action: base.text }, `Operator: ${base.text}`);
      if (q.state === "allow") { out.push({ ...base, status: "running", reason: "you approved this exact action" }); continue; }
      const carries = q.id ? (await import("./act-gate.ts")).pendingAct(vault, q.id)?.categories ?? [] : [];
      out.push({ ...base, status: q.state === "declined" ? "declined" : "asks", reason: g.reason ?? "needs your yes", ...(q.id ? { act: q.id } : {}), ...(carries.length ? { carries } : {}) });
      continue;
    }
    out.push({ ...base, status: "running", reason: "your policy lets this run alone" });
  }
  job.actions = out;
  saveJob(vault, job);
  for (const x of out.filter((y) => y.status === "running")) await carryOut(vault, job, x, deps);
  return job.actions;
}

async function carryOut(vault: string, job: Job, x: OperatorAction, deps: RunDeps): Promise<void> {
  try {
    const report = await (deps.act ?? defaultAct)(vault, actDomain(vault, job.domains.owner), x.text);
    x.status = "done"; x.report = oneLine(report || "done", 600);
    const { recordSpend } = await import("./autonomy.ts");
    const { parseAmountUsd } = await import("./broker.ts");
    if (x.cls === "financial") { const amt = parseAmountUsd(x.text); if (amt) recordSpend(vault, amt); }
    if (job.mission && x.cls === "financial") {
      const amt = (await import("./broker.ts")).parseAmountUsd(x.text);
      if (amt) { try { (await import("./missions.ts")).spend(vault, job.mission.slug, { line: "other", usd: amt, what: x.text.slice(0, 120), ref: `job:${job.id}:${x.n}`, by: "mission" }); } catch { /* no budget line */ } }
    }
  } catch (e) { x.status = "failed"; x.report = (e as Error).message.slice(0, 300); }
  x.ts = Date.now();
  saveJob(vault, job);
  logActivity(vault, { type: "job", domain: job.domains.owner, title: `Operator ${x.status}: ${x.text.slice(0, 80)}`, detail: x.report ?? "", status: x.status === "done" ? "ok" : "error", ref: job.id });
}

/**
 * The user answered one action (Allow in the Inbox, or Run on the job card):
 * it runs only when its exact approval is there (a grant, consumed now) and
 * the broker does not block it (pause, never, a hard rule). Decline marks it.
 */
export async function actOnAction(vault: string, id: string, n: number, o: { decline?: boolean; deps?: RunDeps } = {}): Promise<OperatorAction> {
  const job = readJob(vault, id);
  if (!job) throw new Error(`no job ${id}`);
  const x = job.actions?.find((a) => a.n === n);
  if (!x) throw new Error(`no action ${n} in job ${id}`);
  if (o.decline) { if (x.status === "asks") { x.status = "declined"; x.ts = Date.now(); saveJob(vault, job); } return x; }
  if (x.status !== "asks") return x;
  const { gateAction } = await import("./broker.ts");
  const g = gateAction(x.text, { vault, autonomousActs: true, ...(job.mission ? { mission: job.mission } : {}) });
  if (g.decision === "block") { x.status = "blocked"; x.reason = g.reason; saveJob(vault, job); return x; }
  const { gateEngineAct, OPERATOR_TOOL } = await import("./act-gate.ts");
  const q = gateEngineAct(vault, spaceKey(job.domains.owner), OPERATOR_TOOL, { job: job.id, n, action: x.text }, `Operator: ${x.text}`);
  if (q.state === "declined") { x.status = "declined"; saveJob(vault, job); return x; }
  if (q.state !== "allow") return x; // still waiting for the yes
  x.status = "running";
  saveJob(vault, job);
  await carryOut(vault, job, x, o.deps ?? {});
  return x;
}

function writeStep(dir: string, n: number, sid: string, record: unknown): void {
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "steps", `${n}-${sid}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

// ── Filing: one write per domain, each with a receipt ───────────────────────

export function boardFile(vault: string, domain: string): string {
  const dir = resolveDomainDir(vault, domain);
  if (existsSync(join(dir, "memory"))) return join(dir, "memory", "tasks.md");
  return join(dir, "_tasks.md");
}

export function readReceipts(vault: string, id: string): Receipt[] {
  return readJsonl<Receipt>(join(jobDir(vault, id), "filed.jsonl"));
}

function writeReceipts(vault: string, id: string, rows: Receipt[]): void {
  writeFileSync(join(jobDir(vault, id), "filed.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").replace(/\s*\u2014\s*/g, ", ").trim().slice(0, n);

function fileResults(vault: string, job: Job, last: { returns: string; out: StepOutput }, drafts: NonNullable<JobResult["drafts"]>, now: number, all: { returns: string; out: StepOutput }[] = [last]): void {
  const rows: Receipt[] = [];
  const rel = (p: string) => relative(vault, p);
  const owner = job.domains.owner;
  const add = (r: Omit<Receipt, "n" | "ts">) => rows.push({ n: rows.length + 1, ts: now, ...r });
  const day = new Date(now).toISOString().slice(0, 10);
  // The page (write-vault, written by code into the owner domain).
  if (last.returns === "page") {
    const p = join(resolveDomainDir(vault, owner), "memory", "briefs", `${day}-${slug(job.ask)}.md`);
    mkdirSync(join(p, ".."), { recursive: true });
    const src = last.out.sources.length ? `\n\n## Sources\n${last.out.sources.map((s) => `- ${s}`).join("\n")}\n` : "\n";
    writeFileSync(p, `# ${oneLine(job.ask, 120)}\n\nMade by your chief of staff's team on ${day} (job ${job.id}).\n\n${last.out.body.trim()}${src}`);
    add({ domain: owner, kind: "page", file: rel(p), ref: rel(p), text: "page saved" });
    job.result = { ...job.result!, page: rel(p) };
    saveJob(vault, job);
  }
  if (drafts.length) {
    const p = join(jobDir(vault, job.id), "drafts.md");
    writeFileSync(p, drafts.map((d) => `## To: ${d.to}\nSubject: ${d.subject}\n\n${d.body}\n`).join("\n"));
    add({ domain: owner, kind: "draft", file: rel(p), ref: rel(p), text: `${drafts.length} draft${drafts.length === 1 ? "" : "s"}, not sent` });
  }
  // A Builder's files wait in the job folder; nothing runs or installs.
  for (const b of all.filter((x) => x.returns === "build")) {
    for (const bf of buildFiles(b.out.body)) {
      const p = join(jobDir(vault, job.id), "build", bf.path);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, bf.text);
      add({ domain: owner, kind: "build", file: rel(p), ref: rel(p), text: `file ${bf.path}, waiting for you (nothing ran)` });
    }
  }
  // The page's filing, plus a Clerk's: tasks for the owner and notes for the domains the job tells.
  const clerk = all.filter((x) => x.returns === "vault changes" || x.returns === "repairs").map((x) => x.out.filed ?? {});
  const f: NonNullable<StepOutput["filed"]> = { ...(last.out.filed ?? {}) };
  for (const c of clerk) { f.tasks = [...(f.tasks ?? []), ...(c.task ? [c.task] : []), ...(c.tasks ?? [])]; f.notes = { ...(c.notes ?? {}), ...(f.notes ?? {}) }; }
  if (f?.decision && oneLine(f.decision)) {
    const d = appendDecision(vault, spaceKey(owner), { type: "job_result", prompt: job.ask, verdict: oneLine(f.decision, 400), source: "job", job: job.id, ts: now });
    add({ domain: owner, kind: "decision", file: rel(decisionsFile(vault, spaceKey(owner))), ref: d.id, text: `decision logged: ${oneLine(f.decision, 120)}` });
  }
  const tasks = [...(f.task ? [f.task] : []), ...(f.tasks ?? [])].filter((t) => t?.text && oneLine(t.text)).slice(0, 6);
  const bf = boardFile(vault, owner);
  tasks.forEach((t, i) => {
    const tid = `j${(now + i).toString(36).slice(-6)}`;
    const due = t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? ` @${t.due}` : "";
    const cur = readText(bf);
    if (parseTaskTexts(cur).has(oneLine(t.text, 160).toLowerCase())) return; // never filed twice
    const line = `- [ ] ${oneLine(t.text, 160)}${due} +${day} ~src:job:${job.id.slice(0, 40)} ~id:${tid}`;
    mkdirSync(join(bf, ".."), { recursive: true });
    writeFileSync(bf, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${line}\n`);
    add({ domain: owner, kind: "task", file: rel(bf), ref: tid, text: `task: ${oneLine(t.text, 100)}${due ? `, by ${t.due}` : ""}` });
  });
  const allowed = new Set([...job.domains.consulted, ...job.domains.informed]);
  for (const [d, fact] of Object.entries(f?.notes ?? {})) {
    if (!allowed.has(d) || typeof fact !== "string" || !oneLine(fact)) continue;
    appendJsonl(domainUpdatesPath(vault, d), { ts: now, from_domain: owner, thread: `job:${job.id}`, fact: oneLine(fact), entities: [] });
    add({ domain: d, kind: "note", file: rel(domainUpdatesPath(vault, d)), ref: `job:${job.id}`, text: `note: ${oneLine(fact, 120)}` });
  }
  // The Tutor's lesson plan, written by code into the owner's memory/lessons/
  // (write-vault, its ceiling). A review date becomes a task. Undo moves both.
  for (const t of all.filter((x) => x.returns === "lessons" && (x.out.lessons ?? []).length)) {
    const o = t.out;
    const p = join(resolveDomainDir(vault, owner), "memory", "lessons", `${day}-${slug(job.ask)}.md`);
    mkdirSync(join(p, ".."), { recursive: true });
    const quiz = (o.quiz ?? []).map((q, i) => `${i + 1}. ${oneLine(q.q, 240)}\n   Answer: ${oneLine(q.a, 240)}`).join("\n");
    writeFileSync(p, `# ${oneLine(job.ask, 120)}\n\nA lesson plan from the Tutor on ${day} (job ${job.id}).\n\n## Lessons\n${(o.lessons ?? []).map((l, i) => `${i + 1}. ${oneLine(l.title, 120)}${l.steps ? `\n   ${oneLine(l.steps, 600)}` : ""}`).join("\n")}\n\n## Quiz\n${quiz}\n${o.review ? `\n## Review\n${o.review}\n` : ""}`);
    add({ domain: owner, kind: "page", file: rel(p), ref: rel(p), text: `lesson plan: ${(o.lessons ?? []).length} lessons, ${(o.quiz ?? []).length} quiz questions` });
    if (o.review && /^\d{4}-\d{2}-\d{2}$/.test(o.review) && !tasks.some((x) => /^Review:/.test(x.text))) {
      const tid = `j${(now + 97).toString(36).slice(-6)}`;
      const cur = readText(bf);
      const text = `Review: ${oneLine(job.ask, 100)}`;
      if (!parseTaskTexts(cur).has(text.toLowerCase())) {
        mkdirSync(join(bf, ".."), { recursive: true });
        writeFileSync(bf, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}- [ ] ${text} @${o.review} +${day} ~src:job:${job.id.slice(0, 40)} ~id:${tid}\n`);
        add({ domain: owner, kind: "task", file: rel(bf), ref: tid, text: `task: ${text}, by ${o.review}` });
      }
    }
  }
  // The Interviewer's questions wait in the owner's memory until answered.
  const questions = all.flatMap((x) => (x.returns === "memory updates" ? x.out.questions ?? [] : [])).map((q) => oneLine(q, 240)).filter((q) => q.endsWith("?")).slice(0, 5);
  if (questions.length) {
    const mem = join(resolveDomainDir(vault, owner), "memory", "memory.md");
    const cur = readText(mem);
    const fresh = questions.filter((q) => !cur.includes(q));
    if (fresh.length) {
      const block = `\n## Questions to ask you (${day})\n${fresh.map((q) => `- ${q}`).join("\n")}\n`;
      mkdirSync(join(mem, ".."), { recursive: true });
      writeFileSync(mem, `${cur.replace(/\s*$/, "\n")}${block}`);
      add({ domain: owner, kind: "memory", file: rel(mem), ref: block, text: `${fresh.length} question${fresh.length === 1 ? "" : "s"} to ask you, in memory` });
    }
  }
  // The Coach proposes Compass lines only in the user's own words: the quote
  // must be found verbatim in their notes and the title must use their words.
  // They wait for the weekly review's Yes; the Compass is never written here.
  const cands = all.flatMap((x) => (x.returns === "goals" ? x.out.candidates ?? [] : []));
  if (cands.length) {
    const ctx = jobContext(vault, job);
    const sources = [...bootstrapSources(vault), { path: "job context", text: ctx }];
    const pp = join(compassMetaDir(vault), "proposals.jsonl");
    for (const c of cands.slice(0, 3)) {
      if (!quoteSource(c.quote, sources) || !titleFromUserWords(c.title, sources)) continue;
      const row = JSON.stringify({ ts: now, src: "coach", kind: c.kind, title: oneLine(c.title, 120), text: oneLine(c.quote, 400), source: { thread: `job:${job.id}`, domain: owner }, confidence: 0.6, status: "candidate" });
      mkdirSync(join(pp, ".."), { recursive: true });
      appendFileSync(pp, `${row}\n`);
      add({ domain: "compass", kind: "candidate", file: rel(pp), ref: row, text: `proposed for your Compass: ${oneLine(c.title, 80)} (waits for your yes)` });
    }
  }
  if (rows.length) writeReceipts(vault, job.id, rows);
}

/** Open task texts on a board, lower-cased, so a filing never doubles a line. */
function parseTaskTexts(board: string): Set<string> {
  return new Set(board.split("\n").map((l) => /^\s*- \[ \]\s+(.*)$/.exec(l)?.[1]).filter((x): x is string => !!x).map((x) => x.replace(/\s+[~@+]\S+/g, "").trim().toLowerCase()));
}

/** Undo one filed write. Nothing is deleted: a page moves into the job's own folder. */
export function undoFiled(vault: string, id: string, n: number, now = Date.now()): Receipt {
  const rows = readReceipts(vault, id);
  const r = rows.find((x) => x.n === n);
  if (!r) throw new Error(`no filed line ${n} in job ${id}`);
  if (r.undone) return r;
  const abs = join(vault, r.file);
  if (r.kind === "page" || r.kind === "build") {
    if (existsSync(abs)) { const to = join(jobDir(vault, id), "undone", r.file.split("/").pop()!); mkdirSync(join(to, ".."), { recursive: true }); renameSync(abs, to); }
  } else if (r.kind === "task") {
    const lines = readText(abs).split("\n");
    writeFileSync(abs, lines.filter((l) => !l.includes(`~id:${r.ref}`)).join("\n"));
  } else if (r.kind === "memory") {
    // Take out exactly the block it wrote, nothing else.
    const cur = readText(abs);
    if (cur.includes(r.ref)) writeFileSync(abs, cur.replace(r.ref, ""));
  } else if (r.kind === "candidate") {
    writeFileSync(abs, readText(abs).split("\n").filter((l) => l !== r.ref).join("\n"));
  } else if (r.kind === "decision" || r.kind === "note") {
    const lines = readText(abs).split("\n");
    const keep = lines.filter((l) => {
      if (!l.trim()) return true;
      try { const j = JSON.parse(l) as { id?: string; thread?: string; ts?: number }; return r.kind === "decision" ? j.id !== r.ref : !(j.thread === r.ref && j.ts === r.ts); } catch { return true; }
    });
    writeFileSync(abs, keep.join("\n"));
  }
  r.undone = now;
  writeReceipts(vault, id, rows);
  return r;
}

// ── Starting and stopping ───────────────────────────────────────────────────

/** The command that runs this engine again (compiled binary, or bun + script). */
export function selfCommand(): string[] {
  const a1 = process.argv[1] ?? "";
  if (/\.(ts|tsx|js|mjs)$/.test(a1) && existsSync(a1)) return [process.execPath, a1];
  return [process.execPath];
}

/** Run the job in its own process, so it survives the chat turn that started it. */
export function startDetached(vault: string, id: string): number | undefined {
  const [bin, ...pre] = selfCommand();
  const child = spawn(bin!, [...pre, "--vault", vault, "job", "run", id], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return child.pid;
}

export function stopJob(vault: string, id: string): Job {
  const job = readJob(vault, id);
  if (!job) throw new Error(`no job ${id}`);
  writeFileSync(join(jobDir(vault, id), "stop"), String(Date.now()));
  if (job.status === "running" && job.pid) { try { process.kill(job.pid, "SIGTERM"); } catch { /* gone */ } }
  if (job.status === "running" || job.status === "proposed" || job.status === "needs-approval") {
    job.status = "stopped";
    job.ended = Date.now();
    job.note = "stopped by you";
    job.pid = undefined;
    saveJob(vault, job);
  }
  return job;
}

/** Start a proposed job the user approved (or that may start alone). */
export function startJob(vault: string, id: string, opts: { detached?: boolean } = {}): Job {
  const job = readJob(vault, id);
  if (!job) throw new Error(`no job ${id}`);
  if (job.status !== "proposed" && job.status !== "needs-approval" && job.status !== "stopped" && job.status !== "failed") return job;
  // The user's yes covers money and people only for research and drafts:
  // nothing in a job acts, so starting it is safe. A paused autonomy still wins.
  if (isPaused(vault)) throw new Error("autonomy is paused");
  try { const sf = join(jobDir(vault, id), "stop"); if (existsSync(sf)) renameSync(sf, `${sf}.${Date.now()}`); } catch { /* none */ }
  job.status = "proposed";
  saveJob(vault, job);
  // The child marks itself running with its own pid; writing here after the
  // spawn could overwrite that.
  if (opts.detached !== false) startDetached(vault, id);
  return job;
}

/** A job as the app shows it: the record, the step records and the filed list. */
export function jobView(vault: string, id: string) {
  const job = readJob(vault, id);
  if (!job) return null;
  const dir = jobDir(vault, id);
  const steps = existsSync(join(dir, "steps")) ? readdirSync(join(dir, "steps")).filter((f) => /^\d+-[a-z-]+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => { try { return JSON.parse(readText(join(dir, "steps", f))); } catch { return null; } }).filter(Boolean) : [];
  let body = "";
  try { body = (JSON.parse(readText(join(dir, "result.json"))) as { body?: string }).body ?? ""; } catch { /* none yet */ }
  return { job: alive(vault, job), steps, filed: readReceipts(vault, id), body };
}

// ── CLI: prevail job dispatch|start|run|show|list|stop|adjust|undo ──────────

export async function jobCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (args.json) out({ ok: false, error: msg }); else console.error(msg); return 1; };
  try {
    if (sub === "dispatch" || sub === "new") {
      const message = args.pos.slice(1).join(" ") || args.get("message") || "";
      if (!message.trim()) return fail("usage: prevail job dispatch <message> --domain <d> [--start] [--json]");
      const d = await dispatch({ vault, message, domain: args.get("domain") ?? "general", trigger: "cli", ...(args.has("no-model") ? { runner: null } : {}) });
      if (d.job) {
        saveJob(vault, d.job);
        if (args.has("start") && (d.job.startsAlone || args.has("yes"))) startJob(vault, d.job.id);
      }
      if (args.json) out({ ok: true, ...d, job: d.job ? readJob(vault, d.job.id) : null });
      else console.log(d.kind === "answer" ? "An ordinary answer; no job." : `Job ${d.job!.id}: owner ${d.job!.domains.owner}, team ${d.job!.team.map((s) => s.specialists.join(" + ")).join(" > ")}, ${d.job!.startsAlone ? "may start alone" : `asks first (${d.job!.askReason})`}`);
      return 0;
    }
    if (sub === "run") { const j = await runJob(vault, args.pos[1] ?? ""); if (args.json) out(j); else console.log(`${j.status}: ${j.result?.summary ?? j.note ?? ""}`); return j.status === "done" ? 0 : 1; }
    if (sub === "start") { const j = startJob(vault, args.pos[1] ?? "", { detached: !args.has("wait") }); if (args.has("wait")) { const r = await runJob(vault, j.id); if (args.json) out(r); else console.log(`${r.status}: ${r.result?.summary ?? r.note ?? ""}`); return 0; } if (args.json) out(j); else console.log(`started ${j.id}`); return 0; }
    if (sub === "show") { const v = jobView(vault, args.pos[1] ?? ""); if (!v) return fail(`no job ${args.pos[1] ?? ""}`); if (args.json) out(v); else console.log(JSON.stringify(v, null, 2)); return 0; }
    if (sub === "list") { const l = listJobs(vault, Number(args.get("limit") ?? 50) || 50); if (args.json) out(l); else for (const j of l) console.log(`${j.status.padEnd(14)} ${j.id}  ${j.domains.owner}`); return 0; }
    if (sub === "stop") { const j = stopJob(vault, args.pos[1] ?? ""); if (args.json) out(j); else console.log(`${j.id}: ${j.status}`); return 0; }
    if (sub === "act") {
      const jid = args.pos[1] ?? "";
      const n = Number(args.pos[2] ?? args.get("n"));
      // From the job card: Allow (the user's yes, naming what it carries) or Deny,
      // answered in the same queue the Inbox reads. Allow runs in its own process.
      if (args.has("approve") || args.has("deny")) {
        const j = readJob(vault, jid);
        const x = j?.actions?.find((a) => a.n === n);
        if (!j || !x) return fail(`no action ${n} in job ${jid}`);
        const ag = await import("./act-gate.ts");
        if (args.has("deny")) { if (x.act) ag.denyPendingAct(vault, x.act); const d = await actOnAction(vault, jid, n, { decline: true }); if (args.json) out({ ok: true, action: d }); else console.log(`declined: ${d.text}`); return 0; }
        if (x.status !== "asks") return fail(`action ${n} is ${x.status}`);
        if (x.act && ag.pendingAct(vault, x.act)) { const r = ag.approvePendingAct(vault, x.act, true); if (!r.ok) return fail(r.error ?? "not approved"); }
        const [bin, ...pre] = selfCommand();
        spawn(bin!, [...pre, "--vault", vault, "job", "act", jid, String(n)], { detached: true, stdio: "ignore", env: process.env }).unref();
        if (args.json) out({ ok: true, action: { ...x, status: "running" } }); else console.log(`running: ${x.text}`);
        return 0;
      }
      const x = await actOnAction(vault, jid, n, { decline: args.has("decline") });
      if (args.json) out({ ok: true, action: x }); else console.log(`${x.status}: ${x.text}${x.report ? ` (${x.report})` : ""}`);
      return 0;
    }
    if (sub === "undo") { const r = undoFiled(vault, args.pos[1] ?? "", Number(args.pos[2] ?? args.get("n"))); if (args.json) out({ ok: true, receipt: r }); else console.log(`undone: ${r.text}`); return 0; }
    if (sub === "adjust") {
      const list = (k: string) => (args.get(k) === undefined ? undefined : args.get(k)!.split(",").map((s) => s.trim()).filter(Boolean));
      const team = args.get("team")?.split(">").map((s) => s.split(/[+,]/).map((x) => x.trim().toLowerCase()).filter(Boolean));
      const effort = args.get("effort") as Effort | undefined;
      const j = adjustJob(vault, args.pos[1] ?? "", { owner: args.get("owner"), consulted: list("consulted"), informed: list("informed"), team, effort: effort && EFFORT_BUDGET[effort] ? effort : undefined });
      if (args.json) out(j); else console.log(`adjusted ${j.id}`);
      return 0;
    }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail job dispatch <msg> --domain d [--start] | start <id> [--wait] | run <id> | show <id> | list | stop <id> | act <id> <n> [--decline] | adjust <id> [--owner d] [--consulted a,b] [--informed a,b] [--team a+b>c] [--effort quick|standard|deep] | undo <id> <n> [--json]");
}
