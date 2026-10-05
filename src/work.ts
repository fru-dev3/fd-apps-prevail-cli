// Work mode: one queue for everything the user fires at Prevail.
//
// A prompt (dictated or typed, on the desktop, the phone or the CLI) is
// routed (work-router.ts) into goals and tasks. Each task gets:
//   - a destination thread: a desktop transcript (<session>.md, the desktop's
//     own frontmatter) plus its .jsonl twin, in the destination's space, so
//     its history lives with the domain, project, entity or app it is about;
//   - a line on the destination's board, ~owner:ai, whose status follows it;
//   - a staffed job (jobs.ts staffJob): the team and the policies. Work mode
//     is autonomous: a task starts on its own (in queue order, up to the
//     cap) and never asks; the user's standing rules become guards the run
//     keeps to by itself (draft, never send), shown as a plain line. Only the
//     autonomy brake, a rule the ask would break, or bunker mode hold it;
//   - an executor: the engine (the job runs headless in a detached
//     `prevail work run`) or, with Herdr on, an agent in a Herdr tab
//     (herdr-work.ts), whose output is mirrored back into the thread.
//
// The queue is one ordered list of open tasks, newest at the end; the user
// reorders it. Tasks run in parallel up to maxRunning; beyond the cap a task
// that may start waits as "queued" and starts in queue order when a slot frees
// (topUp, after every `work` command, so a finished run starts the next).
// A task that needs the user takes no slot. `work add --hold` parks the
// tasks in the backlog instead: routed and filed, never started, until
// `work start` moves one to the end of the queue.
//
// A finished task stays in the queue, checked, with a one or two sentence
// outcome the engine distils from the result. It never closes itself: it asks
// "Can I close this task?" in its updates (the light back-and-forth) and
// waits for a yes in a follow-up, or `work done` (which also closes its
// Herdr tab). `work followup` appends to a
// task: it goes into the thread, to the agent still at work, or starts the
// task again with it.
//
// Pause, Continue, Stop, re-route and Undo act on one task. A re-route moves
// the thread files and the board line; nothing is ever deleted. A missing
// home (domain, project, entity, app, specialist, machine) is a suggestion
// the user accepts or declines.
//
//   build/_meta/work/prompts/<prompt-id>.json   one prompt and its tasks
//   build/_meta/work/settings.json              Herdr on or off, workspaces, maxRunning
//   build/_meta/work/order.json                 the queue's order: open task ids, first runs first
//   build/_meta/work/herdr.json                 which Herdr workspace each destination is linked to, per machine
//   build/_meta/work/.lock                      one writer at a time

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseModArgs } from "./cli-args.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { boardFile, jobDir, jobView, makeJobId, readJob, readReceipts, runJob, saveJob, selfCommand, staffJob, startJob, stopJob, type DispatchModel, type Job, type MissionScope } from "./jobs.ts";
import { budgetLeft, readMission } from "./missions.ts";
import { runtimePath } from "./path-safety.ts";
import type { RouteRunner } from "./route.ts";
import { makeSessionId, makeTurnId, readThreadTurns, writeThreadTurn } from "./session.ts";
import { appendThreadMarkdown, createThreadMarkdown, threadFiles, threadWriteDir } from "./thread-schedule.ts";
import { gatherContext, neededSpecialists, planTask, type ContextItem } from "./work-assemble.ts";
import { buildCatalog, cleanName, destination, routeWork, type Catalog, type Destination, type RoutedTask, type RouterPlan } from "./work-router.ts";
import { agentKinds, asCatalogMachines, closeHerdr, herdrWorkspaces, closeTask, focusTask, launchTask, machineAddCommand, machines, mirrorTask, pauseHerdr, promptHerdr, renameHerdr, reopenTask, resumeHerdr, addMachine, approveInTerminal, thisMachine, writeMachineRecord, type Machine, type MachineDeps } from "./herdr-work.ts";
import type { Herdr } from "./spaces.ts";

// "backlog": parked as an idea (routed, never started, not in the queue); `work start` moves it to the end of the queue.
export type WorkStatus = "backlog" | "routed" | "queued" | "needs-you" | "running" | "paused" | "done" | "failed" | "closed";
export type Executor = "engine" | "herdr";
// Asks are kept for records from before Work mode became autonomous; nothing sets them now but a machine suggestion.
export type AskKind = "start" | "herdr-workspace" | "keep-close" | "machine-add";
export type Surface = "desktop" | "phone" | "cli";

export interface HerdrRef {
  machine: string;
  workspaceLabel: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  agent?: string;
  createdWorkspace?: boolean;
  /** False when the task reused a domain's own open agent pane (never closed by Prevail). */
  createdTab?: boolean;
  /** The tail of what was last mirrored, to append only what is new. */
  lastRead?: string;
  /** The agent was not ready for its brief yet (a question in its tab); the mirror sends it once the agent is idle. */
  briefPending?: boolean;
  /** Started through Glyph (its session name and Remote Control) rather than `herdr agent start`. */
  glyph?: boolean;
}

export interface WorkTask extends RoutedTask {
  id: string;
  promptId: string;
  status: WorkStatus;
  executor: Executor;
  jobId?: string;
  board?: { space: string; id: string };
  thread: { space: string; session: string };
  ask?: { kind: AskKind; detail: string; command?: string };
  herdr?: HerdrRef;
  /** Which Mac is carrying it now; stale after three minutes without renewal. */
  lease?: { host: string; until: number };
  log: LogEntry[];
  /** Earlier destinations, newest last: Undo goes back one. */
  routes?: (Destination | null)[];
  /** What came of it, in one or two plain sentences (done, failed or held). */
  outcome?: string;
  /** False while a finished task waits, checked, in the queue; true once the user cleared it. */
  cleared?: boolean;
  /** Follow-ups for an engine run still going: they start it again when it ends. */
  pendingFollowups?: string[];
  /** What the vault already knows that the work needs (assembled before it starts; it goes in the brief). */
  context?: ContextItem[];
  /** The question the agent is waiting on, as one plain sentence (status needs-you). Answered by a follow-up. */
  waiting?: string;
  /** The task this one was split from, and the subtasks split from this one: linked both ways, neither closes the other. */
  parentId?: string;
  children?: string[];
  /** True while a planned task waits for the owner's answers before it starts. */
  planning?: boolean;
  /** Every domain the work touches, the owner first (then consulted and informed). */
  domains?: string[];
  /** The apps it involves, by id. */
  apps?: string[];
  /** The light back-and-forth: short plain lines from the task in its own voice and the user's replies, oldest first. Never raw output. */
  updates?: TaskUpdate[];
}

export interface TaskUpdate { ts: number; from: "task" | "you"; text: string; /** A plan's questions, shown as a short list the owner answers in one reply. */ questions?: string[]; /** A subtask this line hands work to: the panel shows it as a link. */ link?: string }

/** `ev` is a short event name; `detail` one line; `more` what a line shows when expanded (a follow-up's words, the tool call behind an activity). */
export interface LogEntry { ts: number; ev: string; detail?: string; more?: string }

export interface WorkPrompt { id: string; ts: number; text: string; surface: Surface; machine: string; source: RouterPlan["source"]; tasks: WorkTask[] }

export interface WorkSettings { herdr: boolean; workspace: string; workspaces: Record<string, string>; /** Tasks running at once; more wait as queued. */ maxRunning: number }
export const DEFAULT_SETTINGS: WorkSettings = { herdr: false, workspace: "Prevail", workspaces: {}, maxRunning: 3 };
export const MAX_RUNNING_LIMIT = 20;

export const LEASE_MS = 3 * 60_000;
export const LEASE_RENEW_MS = 60_000;
const OPEN: WorkStatus[] = ["routed", "queued", "needs-you", "running", "paused"];
/** In the queue: open, still asking (an older record), or finished and not cleared yet. */
export const inQueue = (t: WorkTask) => OPEN.includes(t.status) || !!t.ask || ((t.status === "done" || t.status === "failed") && t.cleared === false);

export interface WorkDeps {
  runner?: RouteRunner | null;
  now?: () => number;
  /** Starts `prevail work <args>` detached (tests record the call instead). */
  spawnSelf?: (args: string[]) => void;
  /** herdr for a machine label ("local" for this Mac); tests pass a fake. */
  herdrFor?: (machine: string) => Herdr;
  /** Runs a job (tests pass a stub). */
  runJob?: (vault: string, id: string) => Promise<Job>;
  machine?: MachineDeps;
  /** Runs osascript with these args (tests record the call; never Terminal for real). */
  terminal?: (osascriptArgs: string[]) => void;
  /** Claude Code's act-gate settings file for a space (tests pass a /tmp path). */
  settingsPath?: (vault: string, space: string) => string;
  /** Whether Glyph is installed on a machine (label; "local" for this Mac). Tests pass a stub. */
  glyph?: (machine: string) => boolean;
  /** Waits between polls (tests pass a no-op). */
  sleep?: (ms: number) => void;
}

// ── Store ───────────────────────────────────────────────────────────────────

export const workDir = (vault: string) => join(runtimePath(vault, "_meta"), "work");
const promptsDir = (vault: string) => join(workDir(vault), "prompts");
const settingsFile = (vault: string) => join(workDir(vault), "settings.json");
const orderFile = (vault: string) => join(workDir(vault), "order.json");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;

const pad = (n: number) => String(n).padStart(2, "0");
export function makePromptId(now = Date.now()): string {
  const d = new Date(now);
  return `w${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(2).toString("hex")}`;
}
const promptOf = (taskId: string) => taskId.replace(/-\d+$/, "");

function writeAtomic(p: string, text: string): void {
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

/** One writer at a time across processes (the desktop, the phone, a detached run). */
export function withWorkLock<T>(vault: string, fn: () => T): T {
  mkdirSync(workDir(vault), { recursive: true });
  const path = join(workDir(vault), ".lock");
  let lock = tryAcquireLock(path);
  for (let i = 0; !lock && i < 150; i++) { Bun.sleepSync(20); lock = tryAcquireLock(path); }
  if (!lock) throw new Error("the work queue is busy; try again");
  try { return fn(); } finally { lock.release(); }
}

export function readPrompt(vault: string, id: string): WorkPrompt | null {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(readFileSync(join(promptsDir(vault), `${id}.json`), "utf8")) as WorkPrompt; } catch { return null; }
}
function savePrompt(vault: string, p: WorkPrompt): void { writeAtomic(join(promptsDir(vault), `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`); }

export function listPrompts(vault: string): WorkPrompt[] {
  const dir = promptsDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readPrompt(vault, f.slice(0, -5))).filter((p): p is WorkPrompt => !!p).sort((a, b) => b.ts - a.ts);
}

export function readTask(vault: string, id: string): { prompt: WorkPrompt; task: WorkTask } | null {
  const prompt = readPrompt(vault, promptOf(id));
  const task = prompt?.tasks.find((t) => t.id === id);
  return prompt && task ? { prompt, task } : null;
}

/** Change one task under the lock; the prompt is re-read first, so concurrent writers never lose each other's changes. */
export function updateTask(vault: string, id: string, fn: (t: WorkTask, p: WorkPrompt) => void): WorkTask {
  return withWorkLock(vault, () => {
    const r = readTask(vault, id);
    if (!r) throw new Error(`no task ${id}`);
    fn(r.task, r.prompt);
    savePrompt(vault, r.prompt);
    return r.task;
  });
}

export function readSettings(vault: string): WorkSettings {
  try { const j = JSON.parse(readFileSync(settingsFile(vault), "utf8")) as Partial<WorkSettings>; return { ...DEFAULT_SETTINGS, ...j, workspaces: { ...(j.workspaces ?? {}) } }; } catch { return { ...DEFAULT_SETTINGS, workspaces: {} }; }
}
export function writeSettings(vault: string, patch: Partial<WorkSettings>): WorkSettings {
  return withWorkLock(vault, () => {
    const next = { ...readSettings(vault), ...patch };
    if (typeof next.workspace !== "string" || !next.workspace.trim() || next.workspace.length > 60) throw new Error("a workspace label is 1 to 60 characters");
    if (!Number.isInteger(next.maxRunning) || next.maxRunning < 1 || next.maxRunning > MAX_RUNNING_LIMIT) throw new Error(`max running is a whole number from 1 to ${MAX_RUNNING_LIMIT}`);
    writeAtomic(settingsFile(vault), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

// ── Order ───────────────────────────────────────────────────────────────────

export function readOrder(vault: string): string[] {
  try { const j = JSON.parse(readFileSync(orderFile(vault), "utf8")) as unknown; return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
/** Call under the work lock. */
function writeOrder(vault: string, ids: string[]): void { writeAtomic(orderFile(vault), `${JSON.stringify(ids, null, 2)}\n`); }

/** Open tasks in queue order: the saved order first, then any task it does not name yet, oldest first. */
// A finished task stays in the queue, checked, until the user clears it.
export function queueTasks(vault: string, prompts: WorkPrompt[] = listPrompts(vault)): { task: WorkTask; prompt: WorkPrompt }[] {
  const rank = new Map(readOrder(vault).map((id, i) => [id, i]));
  const open = [...prompts].sort((a, b) => a.ts - b.ts).flatMap((p) => p.tasks.filter(inQueue).map((task) => ({ task, prompt: p })));
  return open.map((x, i) => ({ x, k: rank.get(x.task.id) ?? rank.size + i })).sort((a, b) => a.k - b.k).map((y) => y.x);
}

export interface ReorderTo { before?: string; after?: string; index?: number }

/** Move one open task in the queue; returns the new order. Reordering changes which queued task starts next. */
export function reorderTask(vault: string, id: string, to: ReorderTo): string[] {
  return withWorkLock(vault, () => {
    const ids = queueTasks(vault).map((x) => x.task.id);
    const from = ids.indexOf(id);
    if (from < 0) throw new Error(`${id} is not in the queue`);
    ids.splice(from, 1);
    let at: number;
    const ref = to.before ?? to.after;
    if (ref !== undefined) {
      const i = ids.indexOf(ref);
      if (i < 0) throw new Error(`${ref} is not in the queue`);
      at = to.before !== undefined ? i : i + 1;
    } else if (to.index !== undefined && Number.isInteger(to.index) && to.index >= 0) at = Math.min(to.index, ids.length);
    else throw new Error("say where: --before <id>, --after <id> or --to <index>");
    ids.splice(at, 0, id);
    writeOrder(vault, ids);
    return ids;
  });
}

const runningCount = (vault: string) => listPrompts(vault).reduce((n, p) => n + p.tasks.filter((t) => t.status === "running").length, 0);

/** Start queued tasks in queue order while there is a free slot. Safe to call any time; returns the ids it started. */
export async function topUp(vault: string, deps: WorkDeps = {}): Promise<string[]> {
  const started: string[] = [];
  for (const { task } of queueTasks(vault)) {
    if (task.status !== "queued") continue;
    try {
      const t = await startTask(vault, task.id, { deps });
      // Still queued: no slot, and nothing after it may jump ahead.
      if (t.status === "queued") break;
      if (t.status === "running") started.push(t.id);
    } catch (e) {
      const t = updateTask(vault, task.id, (x) => { finish(x, "failed", "It could not start."); note(x, "could not start", (e as Error).message, Date.now()); });
      syncBoard(vault, t);
    }
  }
  return started;
}

export const note = (t: WorkTask, ev: string, detail: string | undefined, now: number, more?: string) => { t.log.push({ ts: now, ev, ...(detail ? { detail: detail.slice(0, 300) } : {}), ...(more ? { more: more.slice(0, 2000) } : {}) }); if (t.log.length > 200) t.log.splice(0, t.log.length - 200); };

/** One line in the task's back-and-forth, at a meaningful moment only; the same line twice in a row is said once. */
export function addUpdate(t: WorkTask, from: TaskUpdate["from"], text: string, now = Date.now(), questions?: string[], link?: string): void {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!line) return;
  const u = (t.updates ??= []);
  const last = u[u.length - 1];
  if (last?.from === from && last.text === line) return;
  u.push({ ts: now, from, text: line, ...(questions?.length ? { questions: questions.map((q) => q.trim().slice(0, 200)).filter(Boolean) } : {}), ...(link ? { link } : {}) });
  if (u.length > 60) u.splice(0, u.length - 60);
}
export const CLOSE_QUESTION = "Can I close this task?";
export const WORKING_LINE = "Working on it, nothing needed from you.";

/**
 * Finished (done or failed), checked in the queue with what came of it. It
 * never closes itself: a finished task says what came of it, asks whether it
 * can close, and waits for the user's yes (or a tick).
 */
export function finish(t: WorkTask, status: "done" | "failed", outcome?: string, now = Date.now()): void {
  // Done means a result exists: an agent that only stopped is asked about, never marked done.
  if (status === "done" && !(outcome ?? t.outcome ?? "").replace(/^done\.?$/i, "").trim()) {
    t.status = "needs-you";
    t.waiting = "It stopped without a result. Should it try again, or do something else?";
    delete t.ask;
    addUpdate(t, "task", t.waiting, now);
    return;
  }
  const was = t.status;
  t.status = status;
  t.cleared = false;
  delete t.ask;
  if (outcome) t.outcome = outcome;
  if (was === status) return;
  if (status === "done") { const what = (t.outcome ?? "").replace(/^done[:.]?\s*/i, "").trim(); addUpdate(t, "task", what ? `Done: ${what}` : "Done.", now); }
  else addUpdate(t, "task", t.outcome || "I could not finish it.", now);
  addUpdate(t, "task", CLOSE_QUESTION, now);
}

/** A clear yes to "Can I close this task?" ("close it", "go ahead", "yes"); anything else is a follow-up. */
export function isCloseYes(text: string): boolean {
  const s = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.split(" ").length > 8) return false;
  if (/\b(don'?t|do not|not|no|wait|keep|but|until|and then)\b/.test(s)) return false;
  if (s === "close" || /\bclose (it|this|that|the task|this task|this one)\b/.test(s)) return true;
  const core = s.replace(/\b(please|thanks|thank you|ok|okay|sure|yes|yeah|yep|go ahead|done|all good|that's it|thats it|that's all|thats all|you can|it's done|its done|perfect|great)\b/g, "").trim();
  return core === "" && s.length > 0;
}

// ── The outcome: one or two plain sentences ────────────────────────────────

/** The result in one or two plain sentences, by code: markdown off, the summary paragraph, two sentences. */
export function plainOutcome(text: string): string {
  let lines = text.replace(/\r/g, "").replace(/```[\s\S]*?```/g, "").split("\n")
    // Tool calls and tables are the work, not what came of it.
    .filter((l) => !/^\s*[\u23fa\u25cf]/.test(l) && !/^\s*\|/.test(l) && !/^\s*[-=_*]{3,}\s*$/.test(l))
    .map((l) => l.replace(/^\s*(?:#+|>|[-*\u2022]|\d+[.)])\s*/, "").replace(/[*_`]+/g, "").trim());
  // An agent ends with its summary: what follows a "Summary" line, else the last paragraph that says something.
  const at = lines.map((l) => /^(?:summary|in short|result|outcome)\b\s*[:.]?/i.test(l)).lastIndexOf(true);
  if (at >= 0) lines = [lines[at]!.replace(/^(?:summary|in short|result|outcome)\b\s*[:.]?\s*/i, ""), ...lines.slice(at + 1)];
  const paras = lines.join("\n").split(/\n{2,}/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!paras.length) return "";
  const pick = at >= 0 ? paras[0]! : [...paras].reverse().find((p) => p.split(" ").length >= 4) ?? paras[paras.length - 1]!;
  const two = pick.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const out = two.replace(/\s*[\u2014\u2013]\s*/g, ", ").trim();
  return out.length > 240 ? `${out.slice(0, 239).replace(/\s+\S*$/, "")}\u2026` : out;
}

/** The outcome the model distils from the result (one or two sentences), else code's. Never throws. */
export async function distilOutcome(text: string, deps: WorkDeps = {}): Promise<string> {
  const body = text.trim();
  if (!body) return "";
  const byCode = plainOutcome(body);
  if (deps.runner === null || process.env.PREVAIL_BUNKER === "1") return byCode;
  try {
    const runner = deps.runner ?? (await import("./route.ts")).claudeRouteRunner;
    const raw = await runner({
      system: "You write the outcome line on a finished task card. One or two short plain sentences saying what was done and anything left for the user. No preamble, no markdown, no em dashes, no lists.",
      prompt: body.slice(-6000), timeoutMs: 30_000, maxChars: 600,
    });
    const line = raw.replace(/\s+/g, " ").replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/^["']|["']$/g, "").trim();
    return line && line.length <= 400 && !line.startsWith("{") ? line : byCode;
  } catch { return byCode; }
}

// ── Guards: the user's standing rules, kept by the run, shown as one line ──

/** A job's guards as one plain line (never a question). */
export function guardLine(guards: string[] | undefined): string | null {
  if (!guards?.length) return null;
  const out = new Set<string>();
  for (const g of guards) {
    if (/contacts someone|outside agent/.test(g)) out.add("drafts only, nothing is sent");
    else if (/money|budget|limit/.test(g)) out.add("nothing is paid or bought");
    else if (/undone|identity|location|people/.test(g)) out.add("it stops before anything that cannot be undone");
    else if (/approval gate|would act/.test(g)) out.add("actions wait for your approval");
  }
  return out.size ? `Your rules apply: ${[...out].join("; ")}.` : null;
}
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim().slice(0, n);
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function defaultSpawnSelf(vault: string): (args: string[]) => void {
  return (args) => {
    const [bin, ...pre] = selfCommand();
    spawn(bin!, [...pre, "--vault", vault, ...args], { detached: true, stdio: "ignore", env: process.env }).unref();
  };
}

// ── Thread and board ────────────────────────────────────────────────────────

/** Append one turn to the task's thread: the desktop transcript and its .jsonl twin. */
export function appendTurn(vault: string, t: WorkTask, role: "user" | "assistant", content: string, cli = "prevail", now = Date.now()): void {
  const { space, session } = t.thread;
  appendThreadMarkdown(vault, space, session, [{ role, content, ...(role === "assistant" ? { cli } : {}) }]);
  const prior = readThreadTurns(vault, space, session);
  writeThreadTurn(vault, space, session, { id: makeTurnId(), parentId: prior[prior.length - 1]?.id ?? null, role, cli: role === "assistant" ? cli : "", model: "", content, ts: now });
}

function createThread(vault: string, t: WorkTask, now: number): void {
  const { space, session } = t.thread;
  createThreadMarkdown(vault, space, session, {
    title: oneLine(t.text, 80), turns: [{ role: "user", content: t.text }], now,
    ...(t.dest?.entity ? { entity: t.dest.entity } : {}), ...(t.dest?.kind === "app" ? { app: t.dest.id } : {}),
  });
  writeThreadTurn(vault, space, session, { id: makeTurnId(), parentId: null, role: "user", cli: "", model: "", content: t.text, ts: now });
}

// A closed task is checked off as dropped (closeout.ts does the same), so it leaves the open board; Continue reopens it.
const BOARD_STATUS: Partial<Record<WorkStatus, string>> = { running: "doing", paused: "blocked", "needs-you": "review", closed: "dropped" };

function addBoardLine(vault: string, t: WorkTask, tid: string, now: number): void {
  const bf = boardFile(vault, t.thread.space);
  const cur = existsSync(bf) ? readFileSync(bf, "utf8") : "";
  const line = `- [ ] ${oneLine(t.text, 160)} +${ymd(now)} ~src:work:${t.id} ~owner:ai ~id:${tid}`;
  mkdirSync(join(bf, ".."), { recursive: true });
  writeFileSync(bf, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${line}\n`);
  t.board = { space: t.thread.space, id: tid };
}

/** Set the board line's box and status token to follow the task. */
export function syncBoard(vault: string, t: WorkTask): void {
  if (!t.board) return;
  const bf = boardFile(vault, t.board.space);
  if (!existsSync(bf)) return;
  const cur = readFileSync(bf, "utf8");
  const tag = `~id:${t.board.id}`;
  const next = cur.split("\n").map((l) => {
    if (!l.includes(tag) || !/^\s*- \[[ xX]\]/.test(l)) return l;
    let x = l.replace(/\s+~status:\S+/g, "").replace(/^(\s*- )\[[ xX]\]/, `$1[${t.status === "done" || t.status === "closed" ? "x" : " "}]`);
    const st = BOARD_STATUS[t.status];
    if (st) x = x.replace(` ${tag}`, ` ~status:${st} ${tag}`);
    return x;
  }).join("\n");
  if (next !== cur) writeFileSync(bf, next);
}

/** Take the board line out of one board (it is re-added on the new one). */
function takeBoardLine(vault: string, t: WorkTask): string | null {
  if (!t.board) return null;
  const bf = boardFile(vault, t.board.space);
  if (!existsSync(bf)) return null;
  const lines = readFileSync(bf, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`~id:${t.board!.id}`));
  if (i < 0) return null;
  const [line] = lines.splice(i, 1);
  writeFileSync(bf, lines.join("\n"));
  return line ?? null;
}

// ── Staffing ────────────────────────────────────────────────────────────────

function missionScope(vault: string, slug: string): MissionScope | undefined {
  const m = readMission(vault, slug);
  if (!m) return undefined;
  return { slug: m.slug, name: m.name, domains: m.domains, specialists: m.specialists, apps: m.apps, ceiling: m.ceiling, budgetLeftUsd: budgetLeft(vault, m) };
}

/** A job for the task through jobs.ts: the same team, policies and start rule as any job. */
export function staffTask(vault: string, t: WorkTask, source: RouterPlan["source"], now: number): Job | null {
  const d = t.dest;
  const ms = d && (d.kind === "project" || d.kind === "folder") ? /^mission\/(.+)$/.exec(d.owner)?.[1] : undefined;
  const scope = ms ? missionScope(vault, ms) : undefined;
  const owner = d?.owner ?? "general";
  const dm: DispatchModel = { owner, effort: t.effort, why: d?.why || `${t.shape} job`, open_ended: t.flags.open_ended, decision: t.flags.decision, money: t.flags.money, numbers: t.flags.numbers };
  const known = t.context?.length ? `\n\nWhat Prevail already knows (use it; do not ask for it):\n${t.context.map((c) => `- ${c.text}`).join("\n")}` : "";
  const staffed = staffJob({
    vault, message: `${t.text}${known}`, here: owner, owner, shape: t.shape, dm, scope, thread: t.thread.session, trigger: "work", now,
    extra: t.specialists, entities: d?.entity ? [d.entity] : [],
    // Only an agent in a Herdr tab carries an agent kind; the engine runs its own runtime.
    ...(t.executor === "herdr" ? { agentKind: t.agentKind } : {}),
    confident: source === "model" && !!d && d.confidence >= 0.5,
  });
  if (!staffed) return null;
  // A job id is per second: two tasks routed in the same second need their own.
  let id = staffed.job.id;
  for (let i = 2; existsSync(jobDir(vault, id)); i++) id = `${staffed.job.id.slice(0, 110)}-${i}`;
  staffed.job.id = id;
  saveJob(vault, staffed.job);
  return staffed.job;
}

/**
 * May it start now? Work mode never asks: a task starts unless bunker mode,
 * the autonomy brake or a rule the ask would break holds it (decideStart keeps
 * only those for the "work" trigger). `why` is a plain sentence for the card.
 */
function startsAlone(t: WorkTask, job: Job | null): { yes: boolean; why: string } {
  if (process.env.PREVAIL_BUNKER === "1") return { yes: false, why: "Held: bunker mode is on, so work waits." };
  // An agent in a Herdr tab does the work itself; the engine needs a team.
  if (!job) return t.executor === "herdr" ? { yes: true, why: "" } : { yes: false, why: "No specialist here does this kind of work yet." };
  if (job.startsAlone) return { yes: true, why: "" };
  return { yes: false, why: /autonomy is paused/.test(job.askReason ?? "") ? "Held: autonomy is paused." : "Held: it would break one of your rules." };
}

// ── Add ─────────────────────────────────────────────────────────────────────

export interface AddOptions {
  surface?: Surface; machine?: string; agentKind?: string;
  /** Park the tasks in the backlog: routed, never started. */ hold?: boolean;
  /** Add the tasks to this prompt (more tasks for the same work) instead of a new one. */ into?: string;
  deps?: WorkDeps;
}

/** A task entering the queue: queued to start in turn, never asked about. A Mac Herdr cannot reach runs it here instead. */
function gateTask(vault: string, t: WorkTask, ms: Machine[], job: Job | null, now = Date.now()): void {
  delete t.ask;
  const machine = ms.find((m) => m.label === t.machine);
  const here = ms.find((m) => m.current)?.label;
  if (t.executor === "herdr" && machine && (machine.herdr === "missing" || machine.herdr === "disabled") && here) {
    note(t, "moved", `${machine.label} is not connected, so it runs on ${here}`, now);
    t.machine = here;
  }
  const g = guardLine(job?.guards);
  if (g && !t.log.some((l) => l.ev === "guard")) note(t, "guard", g, now);
  const s = startsAlone(t, job);
  if (s.yes) { t.status = "queued"; delete t.outcome; }
  else if (!job && t.executor === "engine") finish(t, "failed", s.why);
  else { t.status = "paused"; t.outcome = s.why; note(t, "held", s.why, now); }
}

function catalogFor(vault: string, deps: WorkDeps = {}): { cat: Catalog; ms: Machine[] } {
  const md = { ...deps.machine, ...(deps.herdrFor ? { herdr: deps.herdrFor("local") } : {}) };
  const me = thisMachine(vault, md);
  let ms: Machine[] = [];
  try { ms = machines(vault, md); } catch { ms = []; }
  if (!ms.length) ms = [{ id: "local", label: me.label, current: true, herdr: "local" }];
  const lastMachine: Record<string, string> = {};
  for (const p of listPrompts(vault).slice(0, 50).reverse()) for (const t of p.tasks) lastMachine[t.thread.space] = t.machine;
  const cat = buildCatalog(vault, { here: me.label, machines: asCatalogMachines(ms), agentKinds: agentKinds(md.herdr), lastMachine, roots: me.roots });
  return { cat, ms };
}

/** Route one prompt into tasks, file each one, and start what may start alone. */
export async function addWork(vault: string, text: string, o: AddOptions = {}): Promise<WorkPrompt> {
  const deps = o.deps ?? {};
  const clock = deps.now ?? Date.now;
  const body = text.replace(/\r/g, "").trim();
  if (!body) throw new Error("say what to work on");
  if (body.length > 20_000) throw new Error("that prompt is too long (20,000 characters at most)");
  const { cat, ms } = catalogFor(vault, deps);
  const plan = await routeWork(vault, body, { catalog: cat, ...(deps.runner !== undefined ? { runner: deps.runner } : {}) });
  const settings = readSettings(vault);
  const now = clock();
  const into = o.into ? readPrompt(vault, o.into) : null;
  if (o.into && !into) throw new Error(`no work ${o.into}`);
  const id = into?.id ?? makePromptId(now);
  const prompt: WorkPrompt = { id, ts: now, text: body, surface: o.surface ?? "cli", machine: cat.here, source: plan.source, tasks: [] };
  // Numbering goes on after the work's own tasks.
  let n = into ? Math.max(0, ...into.tasks.map((t) => Number(/-(\d+)$/.exec(t.id)?.[1] ?? 0))) : 0;
  for (const g of plan.goals) for (const r of g.tasks) {
    n++;
    const t: WorkTask = {
      ...r,
      ...(o.agentKind && cat.agentKinds.includes(o.agentKind) ? { agentKind: o.agentKind } : {}),
      ...(o.machine && ms.some((m) => m.label === o.machine) ? { machine: o.machine } : {}),
      id: `${id}-${n}`, promptId: id, status: "routed", executor: settings.herdr ? "herdr" : "engine",
      thread: { space: r.dest?.space ?? "general", session: makeSessionId() }, log: [],
    };
    note(t, "routed", r.dest ? `${r.dest.kind} ${r.dest.label}${r.dest.why ? `: ${r.dest.why}` : ""}` : "no destination", now);
    // Assemble before dispatch: the specialists the work needs and what the vault already knows that it will need.
    t.specialists = neededSpecialists(vault, t);
    const ctx = gatherContext(vault, t);
    // Plan before doing: a task that spends money or time, or touches health, first asks what only the owner knows.
    const prep = o.hold ? null : planTask(vault, t);
    if (prep) ctx.push(...prep.found);
    if (ctx.length) t.context = ctx;
    // A specialist the work needs is made at once (draft ceiling at most): Work mode does not stop to ask.
    for (const s of t.suggestions) {
      if (s.kind !== "specialist" || s.state !== "open" || process.env.PREVAIL_BUNKER === "1") continue;
      try {
        const made = await makeSpecialist(vault, s.name, s.why || `Help with: ${t.text}`, s.draft, clock());
        s.state = "accepted";
        t.specialists = [...new Set([...t.specialists, made])];
        note(t, "specialist made", made, now);
      } catch (e) { note(t, "specialist not made", (e as Error).message, now); }
    }
    createThread(vault, t, now);
    addBoardLine(vault, t, `w${(now + n).toString(36).slice(-6)}`, now);
    const job = staffTask(vault, t, plan.source, now);
    if (job) t.jobId = job.id;
    // Every domain it touches (the owner first, then consulted and informed) and the apps it involves: the panel's pills.
    const touched = [...new Set([t.dest?.owner ?? "general", ...(job?.domains.consulted ?? []), ...(job?.domains.informed ?? [])])].filter((x) => /^[a-z0-9][a-z0-9-]*$/.test(x));
    if (touched.length || prep?.domains.length) t.domains = [...new Set([...touched, ...(prep?.domains ?? [])])];
    if (t.dest?.kind === "app") t.apps = [t.dest.id];
    if (o.hold) { t.status = "backlog"; note(t, "parked", "in the backlog until it is moved to the queue", now); }
    else if (prep) {
      t.status = "needs-you"; t.planning = true; t.waiting = "A few questions before I start.";
      note(t, "planning", prep.questions.join(" "), now);
      addUpdate(t, "task", prep.say, now, prep.questions);
    }
    // It waits its turn behind what is already queued.
    else gateTask(vault, t, ms, job, now);
    prompt.tasks.push(t);
  }
  // New tasks go to the end of the queue; parked ones stay out of it. Added to earlier work, they join its prompt.
  withWorkLock(vault, () => {
    const ids = queueTasks(vault).map((x) => x.task.id);
    if (into) { const cur = readPrompt(vault, id) ?? into; cur.tasks.push(...prompt.tasks); savePrompt(vault, cur); }
    else savePrompt(vault, prompt);
    writeOrder(vault, [...ids, ...prompt.tasks.filter((t) => t.status !== "backlog").map((t) => t.id)]);
  });
  for (const t of prompt.tasks) if (t.status !== "queued") syncBoard(vault, t);
  await topUp(vault, deps);
  const saved = readPrompt(vault, id);
  // Added to earlier work: the answer is the new tasks, under that work's id.
  return saved ? (into ? { ...saved, tasks: saved.tasks.filter((t) => prompt.tasks.some((x) => x.id === t.id)) } : saved) : prompt;
}

async function makeSpecialist(vault: string, name: string, mandate: string, draft: unknown, now: number): Promise<string> {
  const { createSpecialist } = await import("./specialists-custom.ts");
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  // Clamped: a specialist made from Work mode reads, writes the vault or drafts; it never acts.
  const ceiling = ["read", "write-vault", "draft"].includes(String(d.ceiling)) ? String(d.ceiling) : "draft";
  const r = await createSpecialist(vault, { ...d, endpoint: undefined, name, mandate: typeof d.mandate === "string" && d.mandate.trim() ? d.mandate : mandate, ceiling }, { now });
  return r.spec.id;
}

// ── Start, run, pause, continue, stop ───────────────────────────────────────

/** Start one task now (the user's yes, or a task that may start alone). */
export async function startTask(vault: string, id: string, o: { deps?: WorkDeps } = {}): Promise<WorkTask> {
  const deps = o.deps ?? {};
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const t = r.task;
  if (t.status === "running") return t;
  if (t.status === "backlog") return queueFromBacklog(vault, id, deps);
  if (t.executor === "engine" && (!t.jobId || !readJob(vault, t.jobId))) throw new Error("this task has no job to run; re-route it first");
  // Take a slot, or wait as queued: the count and the claim happen under one lock, so two starters never overfill.
  let claimed = false;
  const next = withWorkLock(vault, () => {
    const cur = readTask(vault, id);
    if (!cur) throw new Error(`no task ${id}`);
    const x = cur.task;
    if (x.status === "running") return x;
    delete x.ask;
    if (runningCount(vault) >= readSettings(vault).maxRunning) {
      if (x.status !== "queued") { x.status = "queued"; note(x, "queued", "waiting for a free slot", now); savePrompt(vault, cur.prompt); }
      return x;
    }
    x.status = "running";
    claimed = true;
    note(x, x.executor === "herdr" ? "starting" : "started", x.executor === "herdr" ? "in Herdr" : "the engine runs it", now);
    addUpdate(x, "task", WORKING_LINE, now);
    savePrompt(vault, cur.prompt);
    return x;
  });
  syncBoard(vault, next);
  if (!claimed) return next;
  // Opening a Herdr tab and starting an agent takes a while: the detached run does it, as it runs an engine job.
  if (next.executor === "engine") startJob(vault, next.jobId!, { detached: false });
  (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "run", id]);
  return next;
}

/** Move a parked task to the end of the queue, where it starts in turn (or asks first, as a new task would). */
async function queueFromBacklog(vault: string, id: string, deps: WorkDeps): Promise<WorkTask> {
  const now = (deps.now ?? Date.now)();
  let ms: Machine[] = [];
  try { ms = machines(vault, { ...deps.machine, ...(deps.herdrFor ? { herdr: deps.herdrFor("local") } : {}) }); } catch { ms = []; }
  const t = withWorkLock(vault, () => {
    const cur = readTask(vault, id);
    if (!cur) throw new Error(`no task ${id}`);
    const x = cur.task;
    if (x.status !== "backlog") return x;
    const ids = queueTasks(vault).map((q) => q.task.id);
    gateTask(vault, x, ms, x.jobId ? readJob(vault, x.jobId) : null, now);
    note(x, "moved to the queue", undefined, now);
    savePrompt(vault, cur.prompt);
    writeOrder(vault, [...ids.filter((q) => q !== id), id]);
    return x;
  });
  syncBoard(vault, t);
  await topUp(vault, deps);
  return readTask(vault, id)?.task ?? t;
}

export function hereLabel(vault: string, deps: WorkDeps): string { return thisMachine(vault, deps.machine).label; }

/** Hold the task's lease for this Mac, renewed while `fn` runs. */
export async function withLease<T>(vault: string, id: string, deps: WorkDeps, fn: () => Promise<T>): Promise<T> {
  const host = hereLabel(vault, deps);
  const clock = deps.now ?? Date.now;
  const renew = () => { try { updateTask(vault, id, (x) => { x.lease = { host, until: clock() + LEASE_MS }; }); } catch { /* gone */ } };
  renew();
  const timer = setInterval(renew, LEASE_RENEW_MS);
  try { return await fn(); } finally {
    clearInterval(timer);
    try { updateTask(vault, id, (x) => { if (x.lease?.host === host) delete x.lease; }); } catch { /* gone */ }
  }
}

/** The detached run: the job to its end, its result into the thread, the status onto the card and the board. */
export async function runTask(vault: string, id: string, deps: WorkDeps = {}, o: { reopen?: boolean } = {}): Promise<WorkTask> {
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  if (r.task.executor === "herdr") return launchTask(vault, id, deps, o);
  const jobId = r.task.jobId;
  if (!jobId) throw new Error("this task has no job");
  const clock = deps.now ?? Date.now;
  const job = await withLease(vault, id, deps, () => (deps.runJob ?? ((v, j) => runJob(v, j)))(vault, jobId));
  const filed = readReceipts(vault, jobId).filter((x) => !x.undone).map((x) => `- ${x.text} (${x.file})`);
  let body = "";
  try { body = (JSON.parse(readFileSync(join(jobDir(vault, jobId), "result.json"), "utf8")) as { body?: string }).body ?? ""; } catch { /* no result */ }
  const text = job.status === "done"
    ? [job.result?.summary ?? "", body, filed.length ? `Filed:\n${filed.join("\n")}` : ""].filter(Boolean).join("\n\n")
    : `The job ${job.status === "stopped" ? "stopped" : job.status === "needs-approval" ? "is waiting for you" : "failed"}${job.note ? `: ${job.note}` : "."}`;
  // The job's own summary is the best source; the full text when it has none.
  const outcome = job.status === "done" ? await distilOutcome(job.result?.summary || text, deps) : "";
  let rerun = false;
  const t = updateTask(vault, id, (x) => {
    appendTurn(vault, x, "assistant", text, "prevail", clock());
    // A pause or stop the user asked for while it ran stands.
    if (x.status === "running") {
      // Follow-ups that came in while it ran: it goes again with them.
      if (job.status === "done" && x.pendingFollowups?.length) rerun = true;
      else if (job.status === "done") finish(x, "done", outcome || "Done.", clock());
      // An action the user's rules hold for approval: a plain line, never a question here.
      else if (job.status === "needs-approval") { x.status = "paused"; x.outcome = "Stopped before an action your rules keep for your approval."; addUpdate(x, "task", x.outcome, clock()); }
      else if (job.status === "stopped") x.status = "paused";
      else finish(x, "failed", "It did not finish.", clock());
    }
    note(x, job.status === "done" ? "done" : `job ${job.status}`, job.note ?? job.result?.summary, clock());
  });
  syncBoard(vault, t);
  if (rerun) return rerunWithFollowups(vault, id, deps);
  return t;
}

export function pauseTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  if (!OPEN.includes(r.task.status)) throw new Error(`a ${r.task.status} task cannot be paused`);
  if (r.task.executor === "engine" && r.task.jobId && readJob(vault, r.task.jobId)?.status === "running") stopJob(vault, r.task.jobId);
  if (r.task.executor === "herdr" && r.task.herdr?.agent) { try { pauseHerdr(vault, r.task, deps); } catch { /* the agent is gone */ } }
  const t = updateTask(vault, id, (x) => { x.status = "paused"; note(x, "paused", undefined, now); });
  syncBoard(vault, t);
  return t;
}

/** Stop for good (the card shows it closed; Continue can still pick it up). */
export function stopTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  if (r.task.jobId && readJob(vault, r.task.jobId)) { try { stopJob(vault, r.task.jobId); } catch { /* gone */ } }
  if (r.task.executor === "herdr" && r.task.herdr?.agent) { try { pauseHerdr(vault, r.task, deps); } catch { /* not open */ } }
  const t = updateTask(vault, id, (x) => { x.status = "closed"; delete x.ask; note(x, "stopped", undefined, now); });
  syncBoard(vault, t);
  return t;
}

/** A job for what is left: the team's remaining steps, with the finished steps' results handed in. */
export function remainingJob(vault: string, jobId: string, now = Date.now()): Job | null {
  const v = jobView(vault, jobId);
  if (!v) return null;
  const done = new Map<string, { name: string; returns: string; body: string }>();
  for (const s of v.steps as { specialist: string; status: string; result?: { type: string; file: string } | null }[]) {
    if (!s.result || (s.status !== "done" && s.status !== "done-with-gaps")) continue;
    try { const out = JSON.parse(readFileSync(join(jobDir(vault, jobId), s.result.file), "utf8")) as { body?: string }; done.set(s.specialist, { name: s.specialist, returns: s.result.type, body: out.body ?? "" }); } catch { /* unreadable */ }
  }
  const left = v.job.team.filter((st) => !st.specialists.every((x) => done.has(x)));
  if (!left.length) return null;
  const base = makeJobId(v.job.ask, now);
  let id = `${base.slice(0, 100)}-cont`;
  for (let i = 2; existsSync(jobDir(vault, id)); i++) id = `${base.slice(0, 100)}-cont${i}`;
  const job: Job = { ...v.job, id, status: "proposed", created: now, team: left.map((st, n) => ({ ...st, step: n + 1 })), inputs: [...(v.job.inputs ?? []), ...done.values()] };
  for (const k of ["started", "ended", "cost", "progress", "result", "note", "pid", "actions"] as const) delete job[k];
  saveJob(vault, job);
  return job;
}

export interface ContinueResult { ok: boolean; task?: WorkTask; error?: string; lease?: WorkTask["lease"] }

/** Continue a paused (or stopped, or stuck) task on this Mac. A live lease elsewhere is only taken on a yes. */
export async function continueTask(vault: string, id: string, o: { yes?: boolean; deps?: WorkDeps } = {}): Promise<ContinueResult> {
  const deps = o.deps ?? {};
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const here = hereLabel(vault, deps);
  const lease = r.task.lease;
  if (lease && lease.host !== here && lease.until > now && !o.yes) return { ok: false, error: `${lease.host} is working on it; continue here anyway?`, lease };
  if (r.task.status === "running" && lease?.host === here && lease.until > now) return { ok: true, task: r.task };
  const t0 = r.task;
  if (t0.executor === "engine" && t0.jobId) {
    const j = readJob(vault, t0.jobId);
    // Taking over from another Mac: its run sees the stop file in the shared vault and ends.
    if (j?.status === "running") stopJob(vault, t0.jobId);
    const next = j && (j.status === "stopped" || j.status === "failed" || j.status === "running") ? remainingJob(vault, t0.jobId, now) : null;
    updateTask(vault, id, (x) => {
      if (next) { note(x, "continued", `remaining steps as job ${next.id}`, now); x.jobId = next.id; }
      else note(x, "continued", undefined, now);
      if (x.machine !== here) { note(x, "moved", `${x.machine} to ${here}`, now); x.machine = here; }
      delete x.lease;
      x.status = "routed";
    });
  } else {
    // A Herdr task on the same Mac with its agent still there goes on in its tab; otherwise it reopens here with its history.
    if (t0.executor === "herdr" && t0.machine === here && t0.herdr?.agent && resumeHerdr(vault, id, deps)) return { ok: true, task: readTask(vault, id)!.task };
    updateTask(vault, id, (x) => { if (x.machine !== here) { note(x, "moved", `${x.machine} to ${here}`, now); x.machine = here; } delete x.lease; x.status = "routed"; note(x, "continued", undefined, now); });
    if (t0.executor === "herdr") {
      if (t0.herdr?.tabId && t0.machine !== here) { try { closeHerdr(vault, t0, deps); } catch { /* that Mac is away */ } }
      updateTask(vault, id, (x) => { if (x.herdr) delete x.herdr.tabId; });
      return { ok: true, task: reopenTask(vault, id, deps) };
    }
  }
  return { ok: true, task: await startTask(vault, id, { deps }) };
}

// ── Route, Undo, re-route ───────────────────────────────────────────────────

function moveThread(vault: string, t: WorkTask, to: Destination | null, now: number): void {
  const space = to?.space ?? "general";
  if (space === t.thread.space) { retag(vault, t, to); return; }
  const dir = threadWriteDir(vault, space);
  mkdirSync(dir, { recursive: true });
  for (const f of threadFiles(vault, t.thread.space, t.thread.session)) {
    const target = join(dir, f.split("/").pop()!);
    if (!existsSync(target)) renameSync(f, target);
  }
  const line = takeBoardLine(vault, t);
  t.thread = { space, session: t.thread.session };
  if (line && t.board) {
    const bf = boardFile(vault, space);
    const cur = existsSync(bf) ? readFileSync(bf, "utf8") : "";
    mkdirSync(join(bf, ".."), { recursive: true });
    writeFileSync(bf, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${line}\n`);
    t.board = { space, id: t.board.id };
  }
  retag(vault, t, to);
  void now;
}

/** Point the transcript's frontmatter at the new home (domain, entity, app). */
function retag(vault: string, t: WorkTask, to: Destination | null): void {
  const md = threadFiles(vault, t.thread.space, t.thread.session).find((f) => f.endsWith(".md"));
  if (!md) return;
  const raw = readFileSync(md, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!fm) return;
  const space = to?.space ?? "general";
  let meta = fm[1]!.split("\n").filter((l) => !/^(entity|app):/.test(l)).map((l) => (/^domain:/.test(l) ? `domain: ${space === "general" ? "" : space}` : l));
  if (to?.entity) meta.push(`entity: ${to.entity}`);
  if (to?.kind === "app") meta.push(`app: ${to.id}`);
  meta = meta.filter((l, i, a) => a.indexOf(l) === i);
  writeFileSync(md, `---\n${meta.join("\n")}\n---\n${raw.slice(fm[0].length)}`);
}

export interface RouteChange { dest?: string; undo?: boolean; agentKind?: string; machine?: string }

/** Re-route a task: a new destination, Undo (back one), or a new agent kind or machine. Moves, never deletes. */
export async function routeTask(vault: string, id: string, c: RouteChange, deps: WorkDeps = {}): Promise<WorkTask> {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const { cat, ms } = catalogFor(vault, deps);
  let to: Destination | null | undefined;
  if (c.undo) {
    const prev = r.task.routes ?? [];
    to = prev.length ? prev[prev.length - 1]! : destination(cat, "domain", "general", { confidence: 1, why: "undone: back to General" });
  } else if (c.dest) {
    const m = /^(domain|project|folder|entity|event|app):(.+)$/.exec(c.dest.trim());
    if (!m) throw new Error("a destination is kind:id, e.g. domain:money or project:<slug>");
    to = destination(cat, m[1]!, m[2]!, { confidence: 1, why: "you routed it" });
    if (!to) throw new Error(`no ${m[1]} ${m[2]}`);
  }
  if (c.agentKind && !cat.agentKinds.includes(c.agentKind)) throw new Error(`unknown agent kind ${c.agentKind}`);
  if (c.machine && !ms.some((m) => m.label === c.machine)) throw new Error(`unknown machine ${c.machine}`);
  const picked = c.machine ? ms.find((m) => m.label === c.machine) : undefined;
  if (picked && r.task.executor === "herdr" && picked.herdr !== "local" && picked.herdr !== "saved") throw new Error(`${picked.label} is not connected`);
  const herdrOpen = r.task.executor === "herdr" && !!r.task.herdr?.tabId;
  const wasRunning = r.task.status === "running";
  // A run in the engine stops here and starts again in its new home.
  if (wasRunning && r.task.executor === "engine" && r.task.jobId && readJob(vault, r.task.jobId)?.status === "running") { try { stopJob(vault, r.task.jobId); } catch { /* gone */ } }
  // A new agent kind or machine for an open Herdr tab: close it there, open it in the new place.
  if (herdrOpen && (to !== undefined || (c.agentKind && c.agentKind !== r.task.agentKind) || (c.machine && c.machine !== r.task.machine))) {
    try { closeHerdr(vault, r.task, deps); } catch { /* already gone */ }
  }
  const t = updateTask(vault, id, (x) => {
    if (to !== undefined) {
      if (c.undo) x.routes = (x.routes ?? []).slice(0, -1);
      else x.routes = [...(x.routes ?? []), x.dest];
      moveThread(vault, x, to, now);
      note(x, c.undo ? "route undone" : "re-routed", to ? `${to.kind} ${to.label}` : "General", now);
      x.dest = to;
      const ctx = gatherContext(vault, x);
      if (ctx.length) x.context = ctx; else delete x.context;
    }
    if (c.agentKind && c.agentKind !== x.agentKind) { note(x, "agent kind", `${x.agentKind} to ${c.agentKind}`, now); x.agentKind = c.agentKind; }
    if (c.machine && c.machine !== x.machine) { note(x, "machine", `${x.machine} to ${c.machine}`, now); x.machine = c.machine; }
    if (herdrOpen) delete x.herdr;
    if (wasRunning && (herdrOpen || x.executor === "engine")) x.status = "routed";
    // Restaff for the new home (the old job stays as its record), and start again on its own when it was on its way.
    if (x.status !== "running") {
      const job = staffTask(vault, x, "model", now);
      if (job) x.jobId = job.id;
      if (x.status === "routed" || x.status === "needs-you" || x.status === "queued") gateTask(vault, x, ms, job, now);
    }
  });
  syncBoard(vault, t);
  if (t.status === "queued") { await topUp(vault, deps); return readTask(vault, id)?.task ?? t; }
  return t;
}

// ── Suggestions and answers ─────────────────────────────────────────────────

export interface AcceptResult { task: WorkTask; made?: string; open?: string; command?: string }

/** Accept suggestion n (1-based): make the missing home and route the task there. */
export async function acceptSuggestion(vault: string, id: string, n: number, deps: WorkDeps = {}): Promise<AcceptResult> {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const s = r.task.suggestions[n - 1];
  if (!s) throw new Error(`no suggestion ${n} on ${id}`);
  if (s.state !== "open") throw new Error(`suggestion ${n} is already ${s.state}`);
  const draft = (s.draft && typeof s.draft === "object" ? s.draft : {}) as Record<string, unknown>;
  const mark = (extra?: (x: WorkTask) => void) => updateTask(vault, id, (x) => { x.suggestions[n - 1]!.state = "accepted"; note(x, "accepted", `${s.kind} ${s.name}`, now); extra?.(x); });
  if (s.kind === "domain") {
    const { scaffoldDomain } = await import("./domain-scaffold.ts");
    const res = scaffoldDomain(vault, s.name);
    if (!res.ok && !/already exists/.test(res.message)) throw new Error(res.message);
    const slug = s.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    mark();
    return { task: await routeTask(vault, id, { dest: `domain:${slug}` }, deps), made: `domain ${slug}` };
  }
  if (s.kind === "project") {
    const { createMission } = await import("./missions.ts");
    const owner = r.task.dest?.kind === "domain" && r.task.dest.id !== "general" ? [{ slug: r.task.dest.id, role: "owner" as const }] : [];
    const m = createMission(vault, { name: s.name, outcome: typeof draft.outcome === "string" ? draft.outcome : r.task.goal, domains: owner, from: "work", now });
    mark();
    return { task: await routeTask(vault, id, { dest: `project:${m.slug}` }, deps), made: m.id };
  }
  if (s.kind === "entity") {
    const { createFromObjectDraft, DRAFT_KINDS } = await import("./ia.ts");
    const kind = (DRAFT_KINDS as string[]).includes(String(draft.kind)) ? String(draft.kind) : "person";
    const e = createFromObjectDraft(vault, kind, { ...draft, name: s.name }, now);
    mark();
    return { task: await routeTask(vault, id, { dest: `${kind === "event" ? "event" : "entity"}:${e.id}` }, deps), made: e.id };
  }
  if (s.kind === "specialist") {
    const made = await makeSpecialist(vault, s.name, s.why || `Help with: ${r.task.text}`, s.draft, now);
    const t = mark((x) => {
      x.specialists = [...new Set([...x.specialists, made])];
      if (x.status !== "running") { const job = staffTask(vault, x, "model", now); if (job) x.jobId = job.id; }
    });
    return { task: t, made: `specialist ${made}` };
  }
  if (s.kind === "app") return { task: mark(), open: "apps" };
  // A machine: adding it is the user's own command, with an SSH target they type.
  const command = machineAddCommand(s.name);
  return { task: mark((x) => { x.ask = { kind: "machine-add", detail: `save ${s.name} in Herdr`, command }; if (x.status !== "running") x.status = "needs-you"; }), command };
}

export function declineSuggestion(vault: string, id: string, n: number, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  return updateTask(vault, id, (x) => {
    const s = x.suggestions[n - 1];
    if (!s) throw new Error(`no suggestion ${n} on ${id}`);
    s.state = "declined";
    note(x, "declined", `${s.kind} ${s.name}`, now);
  });
}

/** An answer to what an older record asks (Work mode asks nothing now): yes or no, or keep, close, reopen. */
export async function answerTask(vault: string, id: string, reply: string, o: { deps?: WorkDeps } = {}): Promise<WorkTask> {
  const deps = o.deps ?? {};
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const a = reply.trim().toLowerCase();
  if (a === "keep") return updateTask(vault, id, (x) => { delete x.ask; note(x, "kept", undefined, now); });
  if (a === "close") return closeTask(vault, id, deps);
  if (a === "reopen") return reopenTask(vault, id, deps);
  if (a !== "yes" && a !== "no") throw new Error("answer yes, no, keep, close or reopen");
  const ask = r.task.ask;
  if (!ask) throw new Error("nothing is waiting for an answer on this task");
  if (ask.kind === "start") {
    if (a === "yes") return startTask(vault, id, { deps });
    // Not now also shuts a Herdr tab an unfinished launch left open.
    if (r.task.herdr?.tabId) { try { closeHerdr(vault, r.task, deps); } catch { /* already gone */ } }
    const t = updateTask(vault, id, (x) => { delete x.ask; x.status = "closed"; if (x.herdr?.tabId) { delete x.herdr.tabId; delete x.herdr.paneId; delete x.herdr.agent; } note(x, "not started", undefined, now); });
    syncBoard(vault, t);
    return t;
  }
  // An older record's workspace question: the workspace is found or made by itself now.
  if (ask.kind === "herdr-workspace") return a === "yes" ? startTask(vault, id, { deps }) : stopTask(vault, id, deps);
  if (ask.kind === "keep-close") return a === "yes" ? updateTask(vault, id, (x) => { delete x.ask; note(x, "kept", undefined, now); }) : closeTask(vault, id, deps);
  // machine-add: no means run it here instead.
  if (a === "no") return routeTask(vault, id, { machine: hereLabel(vault, deps) }, deps);
  throw new Error("add the machine with: prevail work machine-add --label <label> --target <ssh target> --yes");
}

// ── Check off, follow up, rename, focus ─────────────────────────────────────

/** The user checked it off: done, out of the queue, its Herdr tab closed. The task and its history stay. */
export function doneTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  if (r.task.jobId && readJob(vault, r.task.jobId)?.status === "running") { try { stopJob(vault, r.task.jobId); } catch { /* gone */ } }
  if (r.task.executor === "herdr" && r.task.herdr?.tabId) { try { closeHerdr(vault, r.task, deps); } catch { /* already closed */ } }
  const t = updateTask(vault, id, (x) => {
    x.status = "done";
    x.cleared = true;
    delete x.ask;
    delete x.pendingFollowups;
    if (x.herdr) { delete x.herdr.tabId; delete x.herdr.paneId; delete x.herdr.agent; delete x.herdr.briefPending; }
    note(x, "checked off", undefined, now);
  });
  syncBoard(vault, t);
  return t;
}

/** The task's ask with every follow-up so far, for a run that starts again. */
const withFollowups = (t: WorkTask) => [t.text, ...t.log.filter((l) => l.ev === "follow-up" && l.more).map((l) => `Follow-up: ${l.more}`)].join("\n\n");

/** Start a task again (a follow-up on finished work): a fresh job, or a fresh launch in Herdr with the history. */
export async function rerunWithFollowups(vault: string, id: string, deps: WorkDeps = {}): Promise<WorkTask> {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  updateTask(vault, id, (x) => {
    delete x.pendingFollowups; delete x.outcome; delete x.cleared; delete x.ask;
    if (x.executor === "engine") { const job = staffTask(vault, { ...x, text: withFollowups(x) }, r.prompt.source, now); if (job) x.jobId = job.id; }
    else if (x.herdr) { delete x.herdr.agent; delete x.herdr.briefPending; }
    x.status = "routed";
    note(x, "again", "with your follow-up", now);
  });
  return startTask(vault, id, { deps });
}

export interface FollowupJudgement { kind: "same" | "rename" | "new"; name?: string }

/** Is a follow-up the same work (maybe under a truer name), or a different piece of work? The model says; code keeps it. */
export async function judgeFollowup(t: Pick<WorkTask, "name" | "text">, text: string, deps: WorkDeps = {}): Promise<FollowupJudgement> {
  if (deps.runner === null || process.env.PREVAIL_BUNKER === "1") return { kind: "same" };
  try {
    const runner = deps.runner ?? (await import("./route.ts")).claudeRouteRunner;
    const raw = await runner({
      system: [
        "A task already has a short name. The user just followed up on it. Decide:",
        '- "same": the follow-up clarifies or continues the task and the name still fits;',
        '- "rename": same task, but the work shifted so the name no longer fits: give a new name;',
        '- "new": the follow-up is really a different piece of work: give that work its own name.',
        "A name is 2 to 4 words, Title Case, at most 28 characters, a noun phrase (\"Landlord Reply\", \"Dinner Spots\").",
        'Reply with ONLY JSON: {"kind":"same|rename|new","name":"<name, for rename or new>"}',
      ].join("\n"),
      prompt: `Task name: ${t.name ?? ""}\nTask: ${t.text}\nFollow-up: ${text.slice(0, 2000)}`,
      timeoutMs: 20_000, maxChars: 400,
    });
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { kind?: string; name?: string };
    const name = j.name ? cleanName(j.name) : null;
    if (j.kind === "rename" && name && name !== t.name) return { kind: "rename", name };
    if (j.kind === "new") return { kind: "new", ...(name ? { name } : {}) };
  } catch { /* keep it */ }
  return { kind: "same" };
}

/** Give a task a new short name, everywhere: the card, and its Herdr tab, pane and agent. */
export function renameTask(vault: string, id: string, name: string, deps: WorkDeps = {}): WorkTask {
  const clean = cleanName(name);
  if (!clean) throw new Error("a name is 1 to 4 words, at most 28 characters");
  const now = (deps.now ?? Date.now)();
  const t = updateTask(vault, id, (x) => { if (x.name !== clean) { x.name = clean; note(x, "renamed", `Renamed to ${clean}`, now); } });
  if (t.executor === "herdr" && t.herdr?.tabId) { try { renameHerdr(vault, t, deps); } catch { /* the tab is gone */ } }
  return t;
}

export interface FollowupResult { ok: true; task: WorkTask; added?: WorkTask[]; renamed?: string; closed?: boolean }

/**
 * A follow-up or clarification on a task. It goes into the task's record and
 * its thread, then: to the agent still at work in Herdr; noted for an engine
 * run still going (it runs again with it when it ends); or it starts the
 * finished task again with it. A follow-up that is really other work (or
 * `asTask`) becomes a new task in the same work, with its own name. A shift in
 * the work renames the task everywhere.
 */
export async function followUp(vault: string, id: string, text: string, o: { asTask?: boolean; deps?: WorkDeps } = {}): Promise<FollowupResult> {
  const deps = o.deps ?? {};
  const now = (deps.now ?? Date.now)();
  const body = text.replace(/\r/g, "").trim();
  if (!body) throw new Error("say what to add");
  if (body.length > 8_000) throw new Error("that follow-up is too long (8,000 characters at most)");
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  // The answers to a plan's questions: into what it knows (and so the brief), then it starts.
  if (!o.asTask && r.task.planning && r.task.status === "needs-you") {
    updateTask(vault, id, (x) => {
      appendTurn(vault, x, "user", body, "prevail", now); note(x, "follow-up", undefined, now, body); addUpdate(x, "you", body, now);
      x.context = [...(x.context ?? []), { label: "Your answers to the plan", text: `The user answered the plan's questions: ${body}` }];
      delete x.planning; delete x.waiting;
    });
    return { ok: true, task: await rerunWithFollowups(vault, id, deps) };
  }
  // The yes to "Can I close this task?": it closes now (its Herdr tab too). Only a finished task closes on a word.
  if (!o.asTask && (r.task.status === "done" || r.task.status === "failed") && !r.task.cleared && isCloseYes(body)) {
    updateTask(vault, id, (x) => addUpdate(x, "you", body, now));
    return { ok: true, task: doneTask(vault, id, deps), closed: true };
  }
  const j: FollowupJudgement = o.asTask ? { kind: "new" } : await judgeFollowup(r.task, body, deps);
  if (j.kind === "new") {
    const p = await addWork(vault, body, { into: r.prompt.id, surface: r.prompt.surface, deps });
    if (j.name && p.tasks.length === 1) renameTask(vault, p.tasks[0]!.id, j.name, deps);
    // The parent stays as it was (status, tab, back-and-forth); the subtask links back to it.
    for (const c of p.tasks) updateTask(vault, c.id, (x) => { x.parentId = id; });
    const t = updateTask(vault, id, (x) => {
      const nm = j.name ?? p.tasks[0]?.name ?? "new task";
      x.children = [...new Set([...(x.children ?? []), ...p.tasks.map((c) => c.id)])];
      note(x, "split", `Became its own task: ${nm}`, now, body); addUpdate(x, "you", body, now); addUpdate(x, "task", `That is its own task now: ${nm}.`, now, undefined, p.tasks[0]?.id);
    });
    return { ok: true, task: t, added: p.tasks.map((x) => readTask(vault, x.id)?.task ?? x) };
  }
  updateTask(vault, id, (x) => { appendTurn(vault, x, "user", body, "prevail", now); note(x, "follow-up", undefined, now, body); addUpdate(x, "you", body, now); });
  if (j.kind === "rename" && j.name) renameTask(vault, id, j.name, deps);
  const t = readTask(vault, id)!.task;
  const done = (task: WorkTask): FollowupResult => ({ ok: true, task, ...(j.kind === "rename" ? { renamed: j.name } : {}) });
  if (t.executor === "herdr" && t.herdr?.agent && !t.herdr.briefPending && promptHerdr(vault, t, body, deps)) {
    // Every follow-up gets an answer at once; the result follows as its own update.
    if (t.status === "running") return done(updateTask(vault, id, (x) => addUpdate(x, "task", "On it: looking into that now.", now)));
    // Finished, its tab still open: the same agent goes on with it.
    const back = updateTask(vault, id, (x) => { x.status = "running"; delete x.outcome; delete x.cleared; delete x.ask; note(x, "again", "with your follow-up", now); addUpdate(x, "task", WORKING_LINE, now); });
    syncBoard(vault, back);
    (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "mirror", id]);
    return done(back);
  }
  if (t.executor === "engine" && t.status === "running") {
    return done(updateTask(vault, id, (x) => { x.pendingFollowups = [...(x.pendingFollowups ?? []), body]; note(x, "noted", "It goes in when this run ends", now); addUpdate(x, "task", "Noted: I will work that in as soon as this step ends.", now); }));
  }
  if (t.status === "queued" || t.status === "routed" || t.status === "backlog") return done(updateTask(vault, id, (x) => addUpdate(x, "task", "Noted: I will use that when it starts.", now)));
  return done(await rerunWithFollowups(vault, id, deps));
}

// ── Views ───────────────────────────────────────────────────────────────────

/** Bring a task whose engine run ended without saying so up to date (a run killed with its machine). */
function settle(vault: string, p: WorkPrompt, now: number): WorkPrompt {
  let changed = false;
  for (const t of p.tasks) {
    if (t.status !== "running" || t.executor !== "engine" || !t.jobId) continue;
    if (t.lease && t.lease.until > now) continue;
    const j = jobView(vault, t.jobId)?.job;
    if (!j || j.status === "running" || j.status === "proposed") continue;
    t.status = j.status === "done" ? "done" : j.status === "needs-approval" ? "needs-you" : j.status === "stopped" ? "paused" : "failed";
    note(t, `job ${j.status}`, j.note, now);
    changed = true;
  }
  if (changed) { try { withWorkLock(vault, () => { const cur = readPrompt(vault, p.id); if (cur) { for (const t of p.tasks) { const i = cur.tasks.findIndex((x) => x.id === t.id); if (i >= 0 && cur.tasks[i]!.status === "running") cur.tasks[i] = t; } savePrompt(vault, cur); } }); } catch { /* next time */ } }
  return p;
}

export function listWork(vault: string, view: "queue" | "backlog" = "queue", now = Date.now()) {
  const prompts = listPrompts(vault).map((p) => settle(vault, p, now));
  // The prompt rides along with each task, clipped; the clip says so.
  const clip = (x: string) => { const one = x.replace(/\s+/g, " ").trim(); return one.length > 200 ? `${oneLine(one, 199).trimEnd()}\u2026` : oneLine(one); };
  const withPrompt = (t: WorkTask, p: WorkPrompt) => ({ ...t, prompt: { id: p.id, ts: p.ts, text: clip(p.text), surface: p.surface } });
  if (view === "backlog") return { ok: true, view, tasks: prompts.flatMap((p) => p.tasks.map((t) => withPrompt(t, p))) };
  // The queue: open tasks, flat, in the user's order. `prompts` stays for older desktops.
  const tasks = queueTasks(vault, prompts).map(({ task, prompt }) => withPrompt(task, prompt));
  return { ok: true, view, tasks, maxRunning: readSettings(vault).maxRunning, prompts: prompts.filter((p) => p.tasks.some(inQueue)) };
}

export function showWork(vault: string, id: string) {
  const r = readTask(vault, id);
  if (!r) {
    const p = readPrompt(vault, id);
    if (!p) return null;
    return { ok: true, prompt: p };
  }
  const t = r.task;
  const md = threadFiles(vault, t.thread.space, t.thread.session).find((f) => f.endsWith(".md"));
  return {
    ok: true, prompt: r.prompt, task: t,
    job: t.jobId ? jobView(vault, t.jobId) : null,
    thread: { ...t.thread, file: md ? relative(vault, md) : null, turns: readThreadTurns(vault, t.thread.space, t.thread.session).length },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = "usage: prevail work add [--file -|<path>] [--text t] [--surface desktop|phone|cli] [--machine m] [--agent kind] [--hold] [--into <work id>] [--no-model] | done <task> | followup <task> [--file -|--text t] [--as-task] | rename <task> --name n | focus <task> | list [--view queue|backlog] | reorder <task> --before <id>|--after <id>|--to <index> | show <id> | route <task> [--dest kind:id] [--undo] [--agent kind] [--machine m] | pause <task> | continue <task> [--yes] | start <task> | stop <task> | accept <task> <n> | decline <task> <n> | answer <task> yes|no|keep|close|reopen [--workspace label] | settings [--herdr on|off] [--workspace label] [--max-running n] | machines | workspaces [--machine m] | machine-add --label l --target t --yes | machine-approve --label l --target t --yes | run <task> | mirror <task>  [--json]";

export async function workCommand(argv: string[], vault: string, deps: WorkDeps = {}): Promise<number> {
  const sub = parseModArgs(argv).pos[0] ?? "list";
  // The list tops the queue up first (a safety net); every command that can free a slot or queue a task tops it up after,
  // so a detached `work run` or `work mirror` that finishes starts the next queued task.
  const top = async () => { try { await topUp(vault, deps); } catch { /* the next command tries again */ } };
  if (sub === "list") await top();
  const code = await workSub(argv, vault, deps);
  if (!["list", "show", "machines", "workspaces"].includes(sub)) await top();
  return code;
}

async function workSub(argv: string[], vault: string, deps: WorkDeps): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (args.json) out({ ok: false, error: msg }); else console.error(msg); return 1; };
  const say = (v: unknown, text: string) => { if (args.json) out(v); else console.log(text); return 0; };
  const id = args.pos[1] ?? "";
  const md = { ...deps.machine, ...(deps.herdrFor ? { herdr: deps.herdrFor("local") } : {}) };
  // This Mac's record, so the others know it (at most every ten minutes).
  try { writeMachineRecord(vault, md); } catch { /* read-only vault */ }
  try {
    if (sub === "add") {
      const file = args.get("file");
      const text = file === "-" ? await new Response(Bun.stdin.stream()).text() : file ? readFileSync(file, "utf8") : args.get("text") ?? args.pos.slice(1).join(" ");
      const surface = (["desktop", "phone", "cli"] as const).find((s) => s === args.get("surface")) ?? "cli";
      const p = await addWork(vault, text, { surface, machine: args.get("machine"), agentKind: args.get("agent"), hold: args.has("hold"), into: args.get("into"), deps: { ...deps, ...(args.has("no-model") ? { runner: null } : {}) } });
      return say({ ok: true, prompt: p }, p.tasks.map((t) => `${t.id}  ${t.status.padEnd(9)} ${t.dest ? `${t.dest.kind}:${t.dest.id}` : "unrouted"}  ${t.text}`).join("\n"));
    }
    if (sub === "list") {
      const view = args.get("view") === "backlog" ? "backlog" : "queue";
      const l = listWork(vault, view);
      return say(l, l.tasks.map((t) => `${t.id}  ${t.status.padEnd(9)} ${t.dest ? `${t.dest.kind}:${t.dest.id}` : "unrouted"}  ${t.text}`).join("\n") || "nothing in the queue");
    }
    if (sub === "reorder") {
      const to = args.get("to");
      const order = reorderTask(vault, id, { before: args.get("before"), after: args.get("after"), index: to === undefined ? undefined : Number(to) });
      return say({ ok: true, order }, order.join("\n"));
    }
    if (sub === "show") { const v = showWork(vault, id); if (!v) return fail(`no task or prompt ${id}`); return say(v, JSON.stringify(v, null, 2)); }
    if (sub === "route") {
      const t = await routeTask(vault, id, { dest: args.get("dest"), undo: args.has("undo"), agentKind: args.get("agent"), machine: args.get("machine") }, deps);
      return say({ ok: true, task: t }, `${t.id} -> ${t.dest ? `${t.dest.kind}:${t.dest.id}` : "General"} (${t.status})`);
    }
    if (sub === "done") { const t = doneTask(vault, id, deps); return say({ ok: true, task: t }, `${t.id}: done`); }
    if (sub === "followup") {
      const file = args.get("file");
      const text = file === "-" ? await new Response(Bun.stdin.stream()).text() : args.get("text") ?? args.pos.slice(2).join(" ");
      const r = await followUp(vault, id, text, { asTask: args.has("as-task"), deps: { ...deps, ...(args.has("no-model") ? { runner: null } : {}) } });
      return say(r, r.added ? `new task: ${r.added.map((t) => t.id).join(", ")}` : `${r.task.id}: ${r.task.status}`);
    }
    if (sub === "rename") { const t = renameTask(vault, id, args.get("name") ?? args.pos.slice(2).join(" "), deps); return say({ ok: true, task: t }, `${t.id}: ${t.name}`); }
    if (sub === "focus") { const t = focusTask(vault, id, deps); return say({ ok: true, task: t }, `${t.id}: focused`); }
    if (sub === "pause") { const t = pauseTask(vault, id, deps); return say({ ok: true, task: t }, `${t.id}: paused`); }
    if (sub === "stop") { const t = stopTask(vault, id, deps); return say({ ok: true, task: t }, `${t.id}: closed`); }
    if (sub === "start") { const t = await startTask(vault, id, { deps }); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
    if (sub === "continue") {
      const r = await continueTask(vault, id, { yes: args.has("yes"), deps });
      if (!r.ok) { if (args.json) out(r); else console.error(r.error); return 1; }
      return say(r, `${r.task!.id}: ${r.task!.status}`);
    }
    if (sub === "accept") { const r = await acceptSuggestion(vault, id, Number(args.pos[2] ?? args.get("n")), deps); return say({ ok: true, ...r }, r.command ? `run: ${r.command}` : `${r.task.id}: ${r.made ?? r.open ?? "accepted"}`); }
    if (sub === "decline") { const t = declineSuggestion(vault, id, Number(args.pos[2] ?? args.get("n")), deps); return say({ ok: true, task: t }, `${t.id}: declined`); }
    if (sub === "answer") { const t = await answerTask(vault, id, args.pos[2] ?? args.get("reply") ?? "", { deps }); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
    if (sub === "settings") {
      const patch: Partial<WorkSettings> = {};
      const h = args.get("herdr");
      if (h !== undefined) { if (h !== "on" && h !== "off") return fail("--herdr is on or off"); patch.herdr = h === "on"; }
      if (args.get("workspace")) patch.workspace = args.get("workspace")!;
      const mr = args.get("max-running");
      if (mr !== undefined) { const n = Number(mr); if (!Number.isInteger(n) || n < 1 || n > MAX_RUNNING_LIMIT) return fail(`--max-running is a whole number from 1 to ${MAX_RUNNING_LIMIT}`); patch.maxRunning = n; }
      const s = Object.keys(patch).length ? writeSettings(vault, patch) : readSettings(vault);
      return say({ ok: true, settings: s }, `herdr ${s.herdr ? "on" : "off"}; workspace ${s.workspace}; ${s.maxRunning} at once`);
    }
    if (sub === "machines") {
      const ms = machines(vault, md);
      return say({ ok: true, current: ms.find((m) => m.current)?.label ?? null, machines: ms, agentKinds: agentKinds(md.herdr) }, ms.map((m) => `${m.current ? "*" : " "} ${m.label.padEnd(20)} ${m.herdr}${m.role ? ` ${m.role}` : ""}`).join("\n"));
    }
    if (sub === "workspaces") {
      const label = args.get("machine") ?? hereLabel(vault, deps);
      const ws = herdrWorkspaces(vault, label, deps);
      return say({ ok: true, machine: label, workspaces: ws }, ws.join("\n"));
    }
    if (sub === "machine-add") {
      const label = args.get("label") ?? "";
      const target = args.get("target") ?? "";
      if (!args.has("yes")) return fail(`confirm with --yes: ${machineAddCommand(label || "<label>", target || "<ssh target>")}`);
      const r = addMachine(label, target, md.herdr);
      // Needs approval is an answer, not a failure: the desktop offers to open Terminal for it.
      return say(r, r.ok ? r.output : `${r.error}: ${r.command.join(" ")}`);
    }
    if (sub === "machine-approve") {
      const label = args.get("label") ?? "";
      const target = args.get("target") ?? "";
      if (!args.has("yes")) return fail(`confirm with --yes: opens Terminal running ${machineAddCommand(label || "<label>", target || "<ssh target>")}`);
      const r = approveInTerminal(label, target, deps.terminal);
      return say(r, `opened Terminal: ${r.command.join(" ")}`);
    }
    if (sub === "run") { const t = await runTask(vault, id, deps, { reopen: args.has("reopen") }); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
    if (sub === "mirror") { const t = await mirrorTask(vault, id, deps); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
  } catch (e) { return fail((e as Error).message); }
  return fail(USAGE);
}
