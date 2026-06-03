import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
