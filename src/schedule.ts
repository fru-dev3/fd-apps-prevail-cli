import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireLock } from "./file-lock.ts";

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  last_run: number | null;
  created_at: number;
}

export interface ScheduleFile {
  schedules: ScheduleEntry[];
}

function scheduleFilePath(vaultPath: string): string {
  return join(vaultPath, ".schedule.json");
}

export function loadSchedules(vaultPath: string): ScheduleEntry[] {
  const f = scheduleFilePath(vaultPath);
  if (!existsSync(f)) return [];
  try {
    const raw = readFileSync(f, "utf8");
    const parsed = JSON.parse(raw) as ScheduleFile;
    return Array.isArray(parsed.schedules) ? parsed.schedules : [];
  } catch {
    return [];
  }
}

export function saveSchedules(vaultPath: string, schedules: ScheduleEntry[]): void {
  const f = scheduleFilePath(vaultPath);
  const body: ScheduleFile = { schedules };
  writeFileSync(f, JSON.stringify(body, null, 2));
}

export function makeScheduleId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (step > 0 && value % step === 0) return true;
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b) return true;
    } else {
      const n = Number(part);
      if (Number.isFinite(n) && n === value) return true;
    }
  }
  return false;
}

// Standard 5-field cron: minute hour day-of-month month day-of-week
export function isCronDue(cron: string, now: Date = new Date()): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  return (
    fieldMatches(m, now.getMinutes()) &&
    fieldMatches(h, now.getHours()) &&
    fieldMatches(dom, now.getDate()) &&
    fieldMatches(mon, now.getMonth() + 1) &&
    fieldMatches(dow, now.getDay())
  );
}

export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // try to evaluate against now — if no exception, the field syntax is valid enough
  try {
    isCronDue(cron, new Date());
    return true;
  } catch {
    return false;
  }
}

export interface RunResult {
  id: string;
  ts: number;
  exit: number | null;
  ok: boolean;
}

// SECURITY: vault schedules execute arbitrary shell. If the vault is synced
// from another machine (Tailscale, Dropbox, iCloud) or written to by another
// agent (Paperclip, OpenClaw), a malicious .schedule.json entry would RCE the
// operator. We gate the shell-out behind an explicit env opt-in so the
// dangerous path is never the default. Run `PREVAIL_ALLOW_VAULT_SHELL=1
// prevail daemon` (or the same env in the TUI shell) to enable.
function vaultShellAllowed(): boolean {
  return process.env.PREVAIL_ALLOW_VAULT_SHELL === "1";
}

export function runSchedule(entry: ScheduleEntry, vaultPath: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const ts = Date.now();
    if (!vaultShellAllowed()) {
      // Refuse — log the attempt loudly but don't execute. Honoring this
      // refusal is the difference between "schedule didn't fire" (annoying)
      // and "any agent on any machine I sync with can RCE me" (a breach).
      console.error(
        `[prevail][schedule] refused to execute ${entry.id} — vault shell is disabled.\n` +
          `  command: ${entry.command.slice(0, 200)}\n` +
          `  set PREVAIL_ALLOW_VAULT_SHELL=1 to allow vault-driven shell schedules.`,
      );
      resolve({ id: entry.id, ts, exit: null, ok: false });
      return;
    }
    try {
      const child = spawn("sh", ["-c", entry.command], {
        cwd: vaultPath,
        env: { ...process.env, PREVAIL_VAULT: vaultPath, PREVAIL_SCHEDULE_ID: entry.id },
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => resolve({ id: entry.id, ts, exit: null, ok: false }));
      child.on("exit", (code) => resolve({ id: entry.id, ts, exit: code, ok: code === 0 }));
      child.unref();
      // Treat fire-and-forget detach as success once we've spawned without an immediate error
      setTimeout(() => resolve({ id: entry.id, ts, exit: null, ok: true }), 100);
    } catch {
      resolve({ id: entry.id, ts, exit: null, ok: false });
    }
  });
}

export function tickAndRunDue(vaultPath: string, now: Date = new Date()): ScheduleEntry[] {
  // SECURITY/CORRECTNESS: cross-process lock so the TUI's tick loop and the
  // daemon's tick loop can't both fire the same schedule in the same minute.
  // The lock file lives next to .schedule.json so it's per-vault — multiple
  // vaults can be running side-by-side without contention.
  const lock = tryAcquireLock(scheduleFilePath(vaultPath) + ".lock");
  if (!lock) return [];
  try {
    const schedules = loadSchedules(vaultPath);
    const fired: ScheduleEntry[] = [];
    let mutated = false;
    for (const s of schedules) {
      if (!s.enabled) continue;
      const minuteStart = Math.floor(now.getTime() / 60000) * 60000;
      if (s.last_run && s.last_run >= minuteStart) continue;
      if (!isCronDue(s.cron, now)) continue;
      fired.push(s);
      s.last_run = now.getTime();
      mutated = true;
      void runSchedule(s, vaultPath);
    }
    if (mutated) saveSchedules(vaultPath, schedules);
    return fired;
  } finally {
    lock.release();
  }
}

export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dow] = parts;
  if (m === "*" && h === "*") return "every minute";
  if (h === "*" && m !== "*") return `every hour at :${m.padStart(2, "0")}`;
  if (dom === "*" && mon === "*" && dow === "*") return `daily at ${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (dom === "*" && mon === "*") return `${dowLabel(dow)} at ${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (dow === "*" && mon === "*") return `day ${dom} of every month at ${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  return cron;
}

function dowLabel(dow: string): string {
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  if (/^\d$/.test(dow)) return names[Number(dow)] ?? dow;
  return dow;
}

export interface NextRunGuess {
  cron: string;
  nextMs: number | null;
}

// Approximate "next run" by walking forward minute-by-minute up to 7 days
export function nextRunWithin(cron: string, daysAhead = 7, from: Date = new Date()): number | null {
  const limit = daysAhead * 24 * 60;
  const start = new Date(from);
  start.setSeconds(0, 0);
  for (let i = 1; i <= limit; i++) {
    const t = new Date(start.getTime() + i * 60000);
    if (isCronDue(cron, t)) return t.getTime();
  }
  return null;
}

// =============================================================================
// Heartbeat tick primitives (ADDITIVE — Track E5).
//
// The heartbeat scheduler (src/heartbeat.ts) drives a periodic "tick" that
// checks which domain routines are due and (eventually) runs them. The shared
// concerns — a durable per-vault ledger, an idempotent "did this tick already
// fire this job" guard, and a per-job token/$ budget cap — live HERE because
// schedule.ts already owns the cron evaluator and the cross-process file-lock
// that a tick must reuse. heartbeat.ts composes these; it does not reimplement
// them.
//
// The ledger is a JSONL file at <vault>/_log/heartbeat.jsonl. _log/ is an
// agent-writable zone (see manifest.ts IMMUTABLE_ZONE_PREFIXES — _log is NOT
// listed), so appending here honors the write-permission contract. Append-only
// JSONL is crash-safe (a torn final line is simply skipped on read) and matches
// the _threads/<id>.jsonl convention in ENGINE-JSON-API.md.
// =============================================================================

/** A single heartbeat ledger record. One line of _log/heartbeat.jsonl. */
export interface HeartbeatTickRecord {
  /** Epoch ms when the record was written. */
  ts: number;
  /** Domain key the routine belongs to. */
  domain: string;
  /** Routine id (matches manifest.heartbeat.routines[].id). */
  routine: string;
  /**
   * Tick bucket this record belongs to — Math.floor(ts / tickMs). Two ticks
   * inside the same bucket are treated as "the same tick" for idempotency,
   * which guards against launchd firing twice on wake or a manual `tick`
   * overlapping the scheduled one.
   */
  tick: number;
  /** "ran" once executed, "skipped" when the budget/idempotency guard blocked it. */
  status: "ran" | "skipped";
  /** Optional reason when skipped (e.g. "already-ran-this-tick", "budget-exceeded"). */
  reason?: string;
  /** Tokens this run was accounted (best-effort; 0 when unknown). */
  tokens?: number;
  /** USD this run was accounted (best-effort; 0 when unknown). */
  cost_usd?: number;
}

/** Default tick window in ms. launchd StartCalendarInterval fires at most once
 *  per scheduled instant, but wake-from-sleep can replay a missed instant — a
 *  generous bucket means a replayed tick collapses into the original. 30 min. */
export const DEFAULT_HEARTBEAT_TICK_MS = 30 * 60 * 1000;

/** Per-tick budget caps. A tick refuses to run further routines once either
 *  cap is crossed. Both are SAFE defaults (small) — the operator raises them
 *  deliberately. tokens=0 / cost=0 would disable all runs, so the guards treat
 *  a non-positive cap as "unlimited" to avoid an accidental hard-off. */
export interface TickBudget {
  maxTokens: number;
  maxCostUsd: number;
  /** Max routines a single tick may run, independent of token/$ accounting. */
  maxRoutines: number;
}

export const DEFAULT_TICK_BUDGET: TickBudget = {
  maxTokens: 50_000,
  maxCostUsd: 0.5,
  maxRoutines: 8,
};

function logDir(vaultPath: string): string {
  return join(vaultPath, "_log");
}

export function heartbeatLogPath(vaultPath: string): string {
  return join(logDir(vaultPath), "heartbeat.jsonl");
}

/** Lock path a heartbeat tick acquires to prevent overlapping ticks. Lives
 *  next to the ledger so it's per-vault (matching the .schedule.json.lock
 *  convention used by tickAndRunDue). */
export function heartbeatLockPath(vaultPath: string): string {
  return heartbeatLogPath(vaultPath) + ".lock";
}

/** Append one record to the ledger. Creates _log/ if absent. Best-effort:
 *  a write failure is swallowed rather than crashing a tick (the ledger is an
 *  audit aid, not the source of truth). */
export function appendHeartbeatRecord(vaultPath: string, rec: HeartbeatTickRecord): void {
  try {
    const dir = logDir(vaultPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(heartbeatLogPath(vaultPath), JSON.stringify(rec) + "\n");
  } catch {
    /* ledger is best-effort */
  }
}

/** Read the ledger, skipping any malformed/torn lines. Newest-last (append
 *  order). Returns [] when the file is absent or unreadable. */
export function readHeartbeatLog(vaultPath: string): HeartbeatTickRecord[] {
  const file = heartbeatLogPath(vaultPath);
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: HeartbeatTickRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as HeartbeatTickRecord;
      if (r && typeof r.ts === "number" && typeof r.routine === "string") out.push(r);
    } catch {
      /* torn / partial final line — skip */
    }
  }
  return out;
}

/** Compute the tick bucket for a timestamp. Stable across processes so the
 *  daemon, the TUI, and a manual `tick` all agree on "the same tick". */
export function tickBucket(ts: number, tickMs: number = DEFAULT_HEARTBEAT_TICK_MS): number {
  const w = tickMs > 0 ? tickMs : DEFAULT_HEARTBEAT_TICK_MS;
  return Math.floor(ts / w);
}

/** Idempotency guard: has this routine already RUN in the given tick bucket?
 *  Only "ran" records count — a prior "skipped" must not block a later retry
 *  within the same tick (e.g. budget freed up). */
export function routineRanThisTick(
  records: readonly HeartbeatTickRecord[],
  routine: string,
  tick: number,
): boolean {
  return records.some((r) => r.routine === routine && r.tick === tick && r.status === "ran");
}

export interface BudgetState {
  tokens: number;
  costUsd: number;
  routines: number;
}

/** Sum the spend already recorded against a tick bucket — the running total a
 *  tick checks before launching the next routine. Only "ran" records spend
 *  budget. */
export function tickSpend(records: readonly HeartbeatTickRecord[], tick: number): BudgetState {
  let tokens = 0;
  let costUsd = 0;
  let routines = 0;
  for (const r of records) {
    if (r.tick !== tick || r.status !== "ran") continue;
    tokens += typeof r.tokens === "number" ? r.tokens : 0;
    costUsd += typeof r.cost_usd === "number" ? r.cost_usd : 0;
    routines += 1;
  }
  return { tokens, costUsd, routines };
}

/** Decide whether a routine costing (tokens, costUsd) may run given the
 *  budget already spent this tick. A non-positive cap means "unlimited" for
 *  that dimension. Returns the blocking reason, or null when allowed. */
export function budgetBlockReason(
  spent: BudgetState,
  budget: TickBudget,
  cost: { tokens: number; costUsd: number },
): string | null {
  if (budget.maxRoutines > 0 && spent.routines >= budget.maxRoutines) {
    return "routine-cap-reached";
  }
  if (budget.maxTokens > 0 && spent.tokens + cost.tokens > budget.maxTokens) {
    return "token-budget-exceeded";
  }
  if (budget.maxCostUsd > 0 && spent.costUsd + cost.costUsd > budget.maxCostUsd) {
    return "cost-budget-exceeded";
  }
  return null;
}
