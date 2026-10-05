// Work mode: one queue for everything the user fires at Prevail.
//
// A prompt (dictated or typed, on the desktop, the phone or the CLI) is
// routed (work-router.ts) into goals and tasks. Each task gets:
//   - a destination thread: a desktop transcript (<session>.md, the desktop's
//     own frontmatter) plus its .jsonl twin, in the destination's space, so
//     its history lives with the domain, project, entity or app it is about;
//   - a line on the destination's board, ~owner:ai, whose status follows it;
//   - a staffed job (jobs.ts staffJob): the team, the policies, and whether it
//     may start alone (decideStart plus the chief of staff's handoff rule;
//     bunker and the code-only router never start alone);
//   - an executor: the engine (the job runs headless in a detached
//     `prevail work run`) or, with Herdr on, an agent in a Herdr tab
//     (herdr-work.ts), whose output is mirrored back into the thread.
//
// Pause, Continue, Stop, re-route and Undo act on one task. A re-route moves
// the thread files and the board line; nothing is ever deleted. A missing
// home (domain, project, entity, app, specialist, machine) is a suggestion
// the user accepts or declines.
//
//   build/_meta/work/prompts/<prompt-id>.json   one prompt and its tasks
//   build/_meta/work/settings.json              Herdr on or off, workspaces
//   build/_meta/work/.lock                      one writer at a time

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readChiefOfStaff } from "./chief-of-staff.ts";
import { parseModArgs } from "./cli-args.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { boardFile, jobDir, jobView, makeJobId, readJob, readReceipts, runJob, saveJob, selfCommand, staffJob, startJob, stopJob, type DispatchModel, type Job, type MissionScope } from "./jobs.ts";
import { budgetLeft, readMission } from "./missions.ts";
import { runtimePath } from "./path-safety.ts";
import type { RouteRunner } from "./route.ts";
import { makeSessionId, makeTurnId, readThreadTurns, writeThreadTurn } from "./session.ts";
import { appendThreadMarkdown, createThreadMarkdown, threadFiles, threadWriteDir } from "./thread-schedule.ts";
import { buildCatalog, destination, routeWork, type Catalog, type Destination, type RoutedTask, type RouterPlan } from "./work-router.ts";
import { agentKinds, asCatalogMachines, closeHerdr, closeTask, launchTask, machineAddCommand, machines, mirrorTask, pauseHerdr, reopenTask, addMachine, thisMachine, writeMachineRecord, type Machine, type MachineDeps } from "./herdr-work.ts";
import type { Herdr } from "./spaces.ts";

export type WorkStatus = "routed" | "needs-you" | "running" | "paused" | "done" | "failed" | "closed";
export type Executor = "engine" | "herdr";
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
  log: { ts: number; ev: string; detail?: string }[];
  /** Earlier destinations, newest last: Undo goes back one. */
  routes?: (Destination | null)[];
}

export interface WorkPrompt { id: string; ts: number; text: string; surface: Surface; machine: string; source: RouterPlan["source"]; tasks: WorkTask[] }

export interface WorkSettings { herdr: boolean; workspace: string; workspaces: Record<string, string> }
export const DEFAULT_SETTINGS: WorkSettings = { herdr: false, workspace: "Prevail", workspaces: {} };

export const LEASE_MS = 3 * 60_000;
export const LEASE_RENEW_MS = 60_000;
const OPEN: WorkStatus[] = ["routed", "needs-you", "running", "paused"];

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
  /** Claude Code's act-gate settings file for a space (tests pass a /tmp path). */
  settingsPath?: (vault: string, space: string) => string;
}

// ── Store ───────────────────────────────────────────────────────────────────

export const workDir = (vault: string) => join(runtimePath(vault, "_meta"), "work");
const promptsDir = (vault: string) => join(workDir(vault), "prompts");
const settingsFile = (vault: string) => join(workDir(vault), "settings.json");
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
    writeAtomic(settingsFile(vault), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export const note = (t: WorkTask, ev: string, detail: string | undefined, now: number) => { t.log.push({ ts: now, ev, ...(detail ? { detail: detail.slice(0, 300) } : {}) }); if (t.log.length > 200) t.log.splice(0, t.log.length - 200); };
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

const BOARD_STATUS: Partial<Record<WorkStatus, string>> = { running: "doing", paused: "blocked", "needs-you": "review" };

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
    let x = l.replace(/\s+~status:\S+/g, "").replace(/^(\s*- )\[[ xX]\]/, `$1[${t.status === "done" ? "x" : " "}]`);
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
  const staffed = staffJob({
    vault, message: t.text, here: owner, owner, shape: t.shape, dm, scope, thread: t.thread.session, trigger: "work", now,
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

/** May it start now? The job's own rule, the handoff setting, and never in bunker or on a guess. */
function startsAlone(vault: string, job: Job | null): { yes: boolean; why: string } {
  if (!job) return { yes: false, why: "no specialist team fits this task" };
  if (process.env.PREVAIL_BUNKER === "1") return { yes: false, why: "bunker mode never starts work alone" };
  const h = readChiefOfStaff(vault).handoff;
  if (h !== "auto") return { yes: false, why: h === "offer" ? "you asked to be offered every job first" : "handoff is off" };
  return job.startsAlone ? { yes: true, why: "" } : { yes: false, why: job.askReason ?? "it needs your yes" };
}

// ── Add ─────────────────────────────────────────────────────────────────────

export interface AddOptions { surface?: Surface; machine?: string; agentKind?: string; deps?: WorkDeps }

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
  const id = makePromptId(now);
  const prompt: WorkPrompt = { id, ts: now, text: body, surface: o.surface ?? "cli", machine: cat.here, source: plan.source, tasks: [] };
  const chief = readChiefOfStaff(vault);
  let n = 0;
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
    // A specialist the work needs is made at once only when the user lets jobs start alone (draft ceiling at most); otherwise it waits as a suggestion.
    for (const s of t.suggestions) {
      if (s.kind !== "specialist" || s.state !== "open" || chief.handoff !== "auto" || process.env.PREVAIL_BUNKER === "1") continue;
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
    const machine = ms.find((m) => m.label === t.machine);
    if (t.executor === "herdr" && machine && (machine.herdr === "missing" || machine.herdr === "disabled")) {
      t.status = "needs-you";
      t.ask = { kind: "machine-add", detail: `${machine.label} is not a saved Herdr machine here`, command: machineAddCommand(machine.label) };
    } else {
      const s = startsAlone(vault, job);
      if (!s.yes) { t.status = "needs-you"; t.ask = { kind: "start", detail: s.why }; }
    }
    prompt.tasks.push(t);
  }
  withWorkLock(vault, () => savePrompt(vault, prompt));
  for (const t of prompt.tasks) {
    if (t.status === "routed") { try { await startTask(vault, t.id, { deps }); } catch (e) { updateTask(vault, t.id, (x) => { x.status = "needs-you"; x.ask = { kind: "start", detail: (e as Error).message }; }); } }
    else syncBoard(vault, t);
  }
  return readPrompt(vault, id) ?? prompt;
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
  if (t.executor === "herdr") {
    // Opening a tab and starting an agent takes a while: the detached run does it.
    const next = updateTask(vault, id, (x) => { x.status = "running"; delete x.ask; note(x, "starting", "in Herdr", now); });
    syncBoard(vault, next);
    (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "run", id]);
    return next;
  }
  if (!t.jobId || !readJob(vault, t.jobId)) throw new Error("this task has no job to run; re-route it first");
  startJob(vault, t.jobId, { detached: false });
  const next = updateTask(vault, id, (x) => { x.status = "running"; delete x.ask; note(x, "started", "the engine runs it", now); });
  syncBoard(vault, next);
  (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "run", id]);
  return next;
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
export async function runTask(vault: string, id: string, deps: WorkDeps = {}, o: { createWorkspace?: boolean; workspace?: string; reopen?: boolean } = {}): Promise<WorkTask> {
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
  const t = updateTask(vault, id, (x) => {
    appendTurn(vault, x, "assistant", text, "prevail", clock());
    // A pause or stop the user asked for while it ran stands.
    if (x.status === "running") {
      x.status = job.status === "done" ? "done" : job.status === "needs-approval" ? "needs-you" : job.status === "stopped" ? "paused" : "failed";
      if (x.status === "needs-you") x.ask = { kind: "start", detail: job.note ?? "it is waiting for your yes" };
    }
    note(x, `job ${job.status}`, job.note ?? job.result?.summary, clock());
  });
  syncBoard(vault, t);
  return t;
}

export function pauseTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  if (!OPEN.includes(r.task.status)) throw new Error(`a ${r.task.status} task cannot be paused`);
  if (r.task.executor === "engine" && r.task.jobId && readJob(vault, r.task.jobId)?.status === "running") stopJob(vault, r.task.jobId);
  if (r.task.executor === "herdr" && r.task.herdr?.agent) { try { pauseHerdr(r.task, deps); } catch { /* the agent is gone */ } }
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
  if (r.task.executor === "herdr" && r.task.herdr?.agent) { try { pauseHerdr(r.task, deps); } catch { /* not open */ } }
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
    updateTask(vault, id, (x) => { if (x.machine !== here) { note(x, "moved", `${x.machine} to ${here}`, now); x.machine = here; } delete x.lease; x.status = "routed"; note(x, "continued", undefined, now); });
    if (t0.executor === "herdr") return { ok: true, task: reopenTask(vault, id, deps) };
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
  if (r.task.status === "running" && r.task.executor === "engine") throw new Error("pause the task before re-routing it");
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
  const herdrOpen = r.task.executor === "herdr" && !!r.task.herdr?.tabId;
  const wasRunning = r.task.status === "running";
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
    }
    if (c.agentKind && c.agentKind !== x.agentKind) { note(x, "agent kind", `${x.agentKind} to ${c.agentKind}`, now); x.agentKind = c.agentKind; }
    if (c.machine && c.machine !== x.machine) { note(x, "machine", `${x.machine} to ${c.machine}`, now); x.machine = c.machine; }
    if (herdrOpen) { delete x.herdr; if (wasRunning) x.status = "routed"; }
    // Restaff for the new home (the old job stays as its record).
    if (x.status !== "running") {
      const job = staffTask(vault, x, "model", now);
      if (job) x.jobId = job.id;
      const machine = ms.find((m) => m.label === x.machine);
      if (x.executor === "herdr" && machine && machine.herdr !== "local" && machine.herdr !== "saved") { x.status = "needs-you"; x.ask = { kind: "machine-add", detail: `${machine.label} is not a saved Herdr machine here`, command: machineAddCommand(machine.label) }; }
      else if (x.status === "routed" || x.status === "needs-you") {
        const s = startsAlone(vault, job);
        if (wasRunning && herdrOpen && s.yes) x.status = "routed";
        else { x.status = "needs-you"; x.ask = { kind: "start", detail: s.yes ? "re-routed; start it in its new home?" : s.why }; }
      }
    }
  });
  syncBoard(vault, t);
  if (t.status === "routed" && wasRunning) return startTask(vault, id, { deps });
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

/** The user's answer to what the card asks: yes or no (start, a new workspace, a machine), or keep, close, reopen. */
export async function answerTask(vault: string, id: string, reply: string, o: { workspace?: string; deps?: WorkDeps } = {}): Promise<WorkTask> {
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
    const t = updateTask(vault, id, (x) => { delete x.ask; x.status = "closed"; note(x, "not started", undefined, now); });
    syncBoard(vault, t);
    return t;
  }
  if (ask.kind === "herdr-workspace") {
    if (a === "no") {
      // Without a workspace the engine runs it, if the user starts it.
      const t = updateTask(vault, id, (x) => { x.executor = "engine"; x.status = "needs-you"; x.ask = { kind: "start", detail: "no Herdr workspace; run it with the engine?" }; note(x, "no workspace", undefined, now); });
      return t;
    }
    // The user's yes to this workspace: the detached run creates it, then opens the tab.
    const t = updateTask(vault, id, (x) => { x.status = "running"; delete x.ask; note(x, "workspace yes", o.workspace, now); });
    (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "run", id, "--create-workspace", ...(o.workspace ? ["--workspace", o.workspace] : [])]);
    return t;
  }
  if (ask.kind === "keep-close") return a === "yes" ? updateTask(vault, id, (x) => { delete x.ask; note(x, "kept", undefined, now); }) : closeTask(vault, id, deps);
  // machine-add: no means run it here instead.
  if (a === "no") return routeTask(vault, id, { machine: hereLabel(vault, deps) }, deps);
  throw new Error("add the machine with: prevail work machine-add --label <label> --target <ssh target> --yes");
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
  if (view === "backlog") {
    const tasks = prompts.flatMap((p) => p.tasks.map((t) => ({ ...t, prompt: { id: p.id, ts: p.ts, text: oneLine(p.text, 200), surface: p.surface } })));
    return { ok: true, view, tasks };
  }
  return { ok: true, view, prompts: prompts.filter((p) => p.tasks.some((t) => OPEN.includes(t.status) || !!t.ask)) };
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

const USAGE = "usage: prevail work add [--file -|<path>] [--text t] [--surface desktop|phone|cli] [--machine m] [--agent kind] [--no-model] | list [--view queue|backlog] | show <id> | route <task> [--dest kind:id] [--undo] [--agent kind] [--machine m] | pause <task> | continue <task> [--yes] | start <task> | stop <task> | accept <task> <n> | decline <task> <n> | answer <task> yes|no|keep|close|reopen [--workspace label] | settings [--herdr on|off] [--workspace label] | machines | machine-add --label l --target t --yes | run <task> | mirror <task>  [--json]";

export async function workCommand(argv: string[], vault: string, deps: WorkDeps = {}): Promise<number> {
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
      const p = await addWork(vault, text, { surface, machine: args.get("machine"), agentKind: args.get("agent"), deps: { ...deps, ...(args.has("no-model") ? { runner: null } : {}) } });
      return say({ ok: true, prompt: p }, p.tasks.map((t) => `${t.id}  ${t.status.padEnd(9)} ${t.dest ? `${t.dest.kind}:${t.dest.id}` : "unrouted"}  ${t.text}`).join("\n"));
    }
    if (sub === "list") {
      const view = args.get("view") === "backlog" ? "backlog" : "queue";
      const l = listWork(vault, view);
      const rows = ("tasks" in l ? l.tasks : (l.prompts ?? []).flatMap((p) => p.tasks)) ?? [];
      return say(l, rows.map((t) => `${t.id}  ${t.status.padEnd(9)} ${t.dest ? `${t.dest.kind}:${t.dest.id}` : "unrouted"}  ${t.text}`).join("\n") || "nothing in the queue");
    }
    if (sub === "show") { const v = showWork(vault, id); if (!v) return fail(`no task or prompt ${id}`); return say(v, JSON.stringify(v, null, 2)); }
    if (sub === "route") {
      const t = await routeTask(vault, id, { dest: args.get("dest"), undo: args.has("undo"), agentKind: args.get("agent"), machine: args.get("machine") }, deps);
      return say({ ok: true, task: t }, `${t.id} -> ${t.dest ? `${t.dest.kind}:${t.dest.id}` : "General"} (${t.status})`);
    }
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
    if (sub === "answer") { const t = await answerTask(vault, id, args.pos[2] ?? args.get("reply") ?? "", { workspace: args.get("workspace"), deps }); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
    if (sub === "settings") {
      const patch: Partial<WorkSettings> = {};
      const h = args.get("herdr");
      if (h !== undefined) { if (h !== "on" && h !== "off") return fail("--herdr is on or off"); patch.herdr = h === "on"; }
      if (args.get("workspace")) patch.workspace = args.get("workspace")!;
      const s = Object.keys(patch).length ? writeSettings(vault, patch) : readSettings(vault);
      return say({ ok: true, settings: s }, `herdr ${s.herdr ? "on" : "off"}; workspace ${s.workspace}`);
    }
    if (sub === "machines") {
      const ms = machines(vault, md);
      return say({ ok: true, current: ms.find((m) => m.current)?.label ?? null, machines: ms, agentKinds: agentKinds(md.herdr) }, ms.map((m) => `${m.current ? "*" : " "} ${m.label.padEnd(20)} ${m.herdr}${m.role ? ` ${m.role}` : ""}`).join("\n"));
    }
    if (sub === "machine-add") {
      const label = args.get("label") ?? "";
      const target = args.get("target") ?? "";
      if (!args.has("yes")) return fail(`confirm with --yes: ${machineAddCommand(label || "<label>", target || "<ssh target>")}`);
      const r = addMachine(label, target, md.herdr);
      return say({ ok: true, ...r }, r.output);
    }
    if (sub === "run") { const t = await runTask(vault, id, deps, { createWorkspace: args.has("create-workspace"), workspace: args.get("workspace"), reopen: args.has("reopen") }); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
    if (sub === "mirror") { const t = await mirrorTask(vault, id, deps); return say({ ok: true, task: t }, `${t.id}: ${t.status}`); }
  } catch (e) { return fail((e as Error).message); }
  return fail(USAGE);
}
