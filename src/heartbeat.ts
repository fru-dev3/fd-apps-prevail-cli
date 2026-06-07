import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { readManifest, type HeartbeatRoutine } from "./manifest.ts";
import {
  appendHeartbeatRecord,
  budgetBlockReason,
  DEFAULT_HEARTBEAT_TICK_MS,
  DEFAULT_TICK_BUDGET,
  heartbeatLockPath,
  isCronDue,
  nextRunWithin,
  readHeartbeatLog,
  routineRanThisTick,
  tickBucket,
  tickSpend,
  type HeartbeatTickRecord,
  type TickBudget,
} from "./schedule.ts";
import { isSafeEntryName, resolveSafeChild, validateVaultPath } from "./path-safety.ts";
import { tryAcquireLock } from "./file-lock.ts";

// =============================================================================
// Track E5 — Scheduler / heartbeat hardening.
//
// A "heartbeat" is the OS-level wakeup that drives prevAIl's periodic routine
// checks even when the cockpit isn't open. On macOS this is a launchd user
// agent that fires `prevail heartbeat tick` on a calendar interval (and on
// wake from sleep, which is launchd's default replay behavior for missed
// StartCalendarInterval instants). Each tick:
//
//   1. acquires a cross-process file-lock so two ticks never overlap,
//   2. derives which domain routines are DUE (from manifest.heartbeat.routines,
//      with cadence/schedule resolution that also honors SKILL.md frontmatter),
//   3. enforces a per-tick token/$ + routine-count budget, and
//   4. records every decision to <vault>/_log/heartbeat.jsonl, which doubles as
//      the idempotency ledger ("did this routine already run this tick?").
//
// SAFE BY DEFAULT. Installing the agent does NOT enable it — the plist is
// written disabled (RunAtLoad:false) and we never `launchctl load` without an
// explicit operator action. There is no network access here: a tick only reads
// the vault and appends to the local ledger; it does NOT spawn AI engines or
// reach out. Wiring a tick to actually invoke routines is a deliberate future
// step gated behind the same vault-shell opt-in the scheduler already uses.
// =============================================================================

/** launchd label / plist basename. Matches the spec's
 *  ~/Library/LaunchAgents/sh.prevail.heartbeat.plist. */
export const HEARTBEAT_LABEL = "sh.prevail.heartbeat";

/** Resolve the LaunchAgents plist path for the current user. */
export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${HEARTBEAT_LABEL}.plist`);
}

// -----------------------------------------------------------------------------
// Cadence resolution.
//
// A routine's `schedule` is either a 5-field cron OR a natural cadence
// ("daily", "weekly", "weekly mon 08:00", "monthly", "hourly"). When the
// routine id maps to a SKILL.md with a `cadence:` frontmatter key, that
// cadence is used as a fallback when the manifest schedule is itself just a
// bare cadence word — so a manifest can say schedule:"weekly" and the SKILL's
// cadence fills in the precise day/time intent. Cron always wins when present.
// -----------------------------------------------------------------------------

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Turn a natural cadence string into a 5-field cron, or return the input
 *  unchanged when it already looks like cron (5 space-separated fields).
 *  Returns null when the cadence is unrecognized. */
export function cadenceToCron(schedule: string): string | null {
  const raw = schedule.trim();
  if (!raw) return null;
  // Already cron? 5 whitespace-separated fields.
  if (raw.split(/\s+/).length === 5) return raw;

  const lower = raw.toLowerCase();
  const tokens = lower.split(/\s+/);
  const head = tokens[0];

  // Optional HH:MM anywhere in the string → minute/hour fields.
  let minute = "0";
  let hour = "8"; // sensible default morning slot
  const timeTok = tokens.find((t) => /^\d{1,2}:\d{2}$/.test(t));
  if (timeTok) {
    const [h, m] = timeTok.split(":");
    const hh = Number(h);
    const mm = Number(m);
    if (Number.isFinite(hh) && hh >= 0 && hh <= 23) hour = String(hh);
    if (Number.isFinite(mm) && mm >= 0 && mm <= 59) minute = String(mm);
  }

  if (head === "hourly") return `${minute} * * * *`;
  if (head === "daily") return `${minute} ${hour} * * *`;
  if (head === "weekly") {
    const dowTok = tokens.find((t) => t in DOW_NAMES);
    const dow = dowTok !== undefined ? DOW_NAMES[dowTok] : 1; // default Monday
    return `${minute} ${hour} * * ${dow}`;
  }
  if (head === "monthly") {
    // First of the month at the resolved time.
    return `${minute} ${hour} 1 * *`;
  }
  return null;
}

/** Read a SKILL.md `cadence:` frontmatter value for a domain routine id, if a
 *  matching SKILL exists. Best-effort: returns null on any miss. The routine
 *  id is expected to match the skill directory name under
 *  <vault>/<domain>/skills/<id>/SKILL.md. */
export function skillCadence(vaultPath: string, domain: string, routineId: string): string | null {
  if (!isSafeEntryName(domain) || !isSafeEntryName(routineId)) return null;
  const file = join(vaultPath, domain, "skills", routineId, "SKILL.md");
  if (!existsSync(file)) return null;
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  // Frontmatter cadence: lives between the leading `---` fences.
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = fm ? fm[1] : raw;
  const m = body.match(/^\s*cadence\s*:\s*(.+?)\s*$/im);
  return m && m[1].trim() ? m[1].trim() : null;
}

/** Resolve a routine to a concrete cron expression, layering SKILL.md cadence
 *  as a fallback when the manifest schedule is a bare cadence word. */
export function resolveRoutineCron(
  vaultPath: string,
  domain: string,
  routine: HeartbeatRoutine,
): string | null {
  const direct = cadenceToCron(routine.schedule);
  // If the manifest schedule resolved to a precise cron AND it carried a
  // day/time (i.e. wasn't a vague "weekly" with defaults), prefer it. To keep
  // this simple and predictable: when the manifest schedule is just a single
  // cadence word with no time/day, let SKILL.md refine it.
  const bareCadence = /^(hourly|daily|weekly|monthly)$/i.test(routine.schedule.trim());
  if (direct && !bareCadence) return direct;
  const sk = skillCadence(vaultPath, domain, routine.id);
  if (sk) {
    const refined = cadenceToCron(sk);
    if (refined) return refined;
  }
  return direct;
}

// -----------------------------------------------------------------------------
// Routine enumeration — pull enabled routines across all domains in the vault.
// -----------------------------------------------------------------------------

export interface ResolvedRoutine {
  domain: string;
  id: string;
  schedule: string;
  cron: string | null;
  enabled: boolean;
}

const NON_DOMAIN_DIRS = new Set([
  "_log",
  "_threads",
  "_journal",
  "_drop",
  "01_prior",
  "skills",
  "apps",
]);

/** Walk every domain's manifest and collect heartbeat routines. A routine is
 *  considered enabled when BOTH the domain heartbeat.enabled is true AND the
 *  routine's own enabled flag is not explicitly false (defaults to true when
 *  omitted, per the schema). */
export function enumerateRoutines(vaultPath: string): ResolvedRoutine[] {
  const v = validateVaultPath(vaultPath);
  if (!v.ok || !existsSync(vaultPath)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(vaultPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: ResolvedRoutine[] = [];
  for (const name of entries) {
    if (NON_DOMAIN_DIRS.has(name)) continue;
    if (!isSafeEntryName(name)) continue;
    if (!resolveSafeChild(vaultPath, name)) continue;
    let manifest;
    try {
      manifest = readManifest(vaultPath, name);
    } catch {
      continue;
    }
    if (!manifest) continue;
    const domainOn = manifest.heartbeat.enabled === true;
    for (const r of manifest.heartbeat.routines) {
      const routineOn = r.enabled !== false; // omitted → true
      out.push({
        domain: name,
        id: r.id,
        schedule: r.schedule,
        cron: resolveRoutineCron(vaultPath, name, r),
        enabled: domainOn && routineOn,
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Status — per-routine lastRun / nextRun, plus whether the OS agent is loaded.
// -----------------------------------------------------------------------------

export interface RoutineStatus {
  domain: string;
  id: string;
  schedule: string;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
}

export interface HeartbeatStatus {
  ok: true;
  /** Whether the launchd agent plist is present AND loaded (launchctl). */
  installed: boolean;
  /** plist exists on disk but isn't necessarily loaded into launchd. */
  plistPresent: boolean;
  /** Whether this platform supports the launchd agent (macOS only). */
  supported: boolean;
  routines: RoutineStatus[];
}

/** Last "ran" timestamp for a routine from the ledger, or null. */
function lastRunFor(records: readonly HeartbeatTickRecord[], routineId: string): number | null {
  let last: number | null = null;
  for (const r of records) {
    if (r.routine === routineId && r.status === "ran") {
      if (last === null || r.ts > last) last = r.ts;
    }
  }
  return last;
}

/** Is the launchd agent loaded? `launchctl list <label>` exits 0 when the job
 *  is loaded. Returns false on non-macOS or any error. */
export function isAgentLoaded(): boolean {
  if (platform() !== "darwin") return false;
  try {
    const r = spawnSync("launchctl", ["list", HEARTBEAT_LABEL], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Build the heartbeat status object for `prevail heartbeat status --json`. */
export function status(vaultPath: string): HeartbeatStatus {
  const supported = platform() === "darwin";
  const plistPresent = existsSync(plistPath());
  const loaded = isAgentLoaded();
  const records = readHeartbeatLog(vaultPath);
  const routines = enumerateRoutines(vaultPath).map<RoutineStatus>((r) => ({
    domain: r.domain,
    id: r.id,
    schedule: r.schedule,
    enabled: r.enabled,
    lastRun: lastRunFor(records, r.id),
    nextRun: r.cron ? nextRunWithin(r.cron) : null,
  }));
  return {
    ok: true,
    installed: plistPresent && loaded,
    plistPresent,
    supported,
    routines,
  };
}

// -----------------------------------------------------------------------------
// Install / uninstall the launchd agent.
// -----------------------------------------------------------------------------

/** Best-effort resolution of the prevail binary the agent should invoke.
 *  Prefers the running executable (the compiled `prevail` binary); falls back
 *  to a bare `prevail` on PATH when running from source. */
function prevailInvocation(): string[] {
  const exec = process.execPath;
  // When running the compiled single-file binary, execPath IS prevail.
  // When running via bun from source, execPath is `bun` and argv[1] is the
  // entry script — reconstruct `bun <script>` so the agent runs the same code.
  if (process.argv[1] && /\b(bun|node)$/.test(exec)) {
    return [exec, process.argv[1]];
  }
  if (exec && existsSync(exec)) return [exec];
  return ["prevail"];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render the launchd plist XML. StartCalendarInterval with only a Minute key
 *  fires hourly at that minute; launchd replays a missed instant on wake from
 *  sleep, which is exactly the "runs on wake" behavior the spec asks for.
 *  RunAtLoad is false and we never auto-load → SAFE / disabled by default. */
export function renderPlist(vaultPath: string, tickMinute = 0): string {
  const argv = [...prevailInvocation(), "heartbeat", "tick", "--vault", vaultPath];
  const programArgs = argv
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const logOut = join(vaultPath, "_log", "heartbeat.out.log");
  const logErr = join(vaultPath, "_log", "heartbeat.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(HEARTBEAT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>${Math.max(0, Math.min(59, Math.floor(tickMinute)))}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logOut)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logErr)}</string>
</dict>
</plist>
`;
}

export interface InstallResult {
  ok: boolean;
  installed: string[];
  plist: string;
  /** True when this platform can't host the launchd agent (non-macOS). */
  unsupported?: boolean;
  error?: string;
}

/** Write (or rewrite) the launchd plist for the heartbeat agent. Does NOT load
 *  it into launchd — install is SAFE: the operator must explicitly enable.
 *  `installed` lists the routine ids that the agent will eventually drive (the
 *  enabled ones), satisfying the ENGINE-JSON-API `installed` contract. */
export function install(vaultPath: string): InstallResult {
  const v = validateVaultPath(vaultPath);
  if (!v.ok) {
    return { ok: false, installed: [], plist: plistPath(), error: v.reason };
  }
  const installed = enumerateRoutines(vaultPath)
    .filter((r) => r.enabled)
    .map((r) => r.id);

  if (platform() !== "darwin") {
    // Non-macOS: we can't write a launchd agent. Report unsupported but still
    // surface which routines WOULD be driven, so the engine/UI can show intent.
    return {
      ok: false,
      installed,
      plist: plistPath(),
      unsupported: true,
      error: "launchd agent install is only supported on macOS",
    };
  }

  const file = plistPath();
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderPlist(vaultPath));
    try {
      chmodSync(file, 0o644);
    } catch {
      /* best effort */
    }
  } catch (err) {
    return { ok: false, installed, plist: file, error: (err as Error).message };
  }
  return { ok: true, installed, plist: file };
}

export interface UninstallResult {
  ok: boolean;
  removed: boolean;
  plist: string;
  error?: string;
}

/** Unload (best-effort) and remove the launchd plist. */
export function uninstall(): UninstallResult {
  const file = plistPath();
  if (platform() === "darwin" && isAgentLoaded()) {
    try {
      spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
    } catch {
      /* best effort — we still remove the plist below */
    }
  }
  if (!existsSync(file)) return { ok: true, removed: false, plist: file };
  try {
    unlinkSync(file);
  } catch (err) {
    return { ok: false, removed: false, plist: file, error: (err as Error).message };
  }
  return { ok: true, removed: true, plist: file };
}

// -----------------------------------------------------------------------------
// Tick — the periodic check. SAFE: it evaluates due-ness and records decisions
// to the ledger; it does NOT execute AI engines or reach the network. Actual
// routine execution is a future, opt-in step. The value here is the hardening:
// overlap-lock, idempotency, and budget accounting are all enforced now so the
// execution step can be dropped in without re-litigating safety.
// -----------------------------------------------------------------------------

export interface TickRoutineOutcome {
  domain: string;
  id: string;
  status: "ran" | "skipped";
  reason?: string;
}

export interface TickResult {
  ok: boolean;
  /** Tick bucket this run belongs to. */
  tick: number;
  /** null when another tick held the lock (overlap prevented). */
  outcomes: TickRoutineOutcome[] | null;
  skippedLocked?: boolean;
}

export interface TickOptions {
  now?: Date;
  budget?: TickBudget;
  tickMs?: number;
  /**
   * Per-routine estimated cost charged against the tick budget. Until real
   * execution exists, a tick "runs" a routine by recording it; the estimate
   * keeps the budget math meaningful and testable. Defaults to a tiny nominal
   * cost so the routine-count cap is the binding constraint.
   */
  estimateCost?: (r: ResolvedRoutine) => { tokens: number; costUsd: number };
}

/** Run one heartbeat tick. Acquires the per-vault lock, finds due routines,
 *  applies the idempotency + budget guards, and appends ledger records. */
export function tick(vaultPath: string, opts: TickOptions = {}): TickResult {
  const now = opts.now ?? new Date();
  const tickMs = opts.tickMs ?? DEFAULT_HEARTBEAT_TICK_MS;
  const budget = opts.budget ?? DEFAULT_TICK_BUDGET;
  const bucket = tickBucket(now.getTime(), tickMs);
  const estimate = opts.estimateCost ?? (() => ({ tokens: 0, costUsd: 0 }));

  // The lock + ledger both live in <vault>/_log; ensure it exists first so
  // tryAcquireLock's O_CREAT|O_EXCL open doesn't fail with ENOENT on a vault
  // that hasn't logged anything yet (mis-read as "lock held" → tick never
  // runs). _log/ is an agent-writable zone.
  const lockFile = heartbeatLockPath(vaultPath);
  const logParent = dirname(lockFile);
  if (!existsSync(logParent)) {
    try {
      mkdirSync(logParent, { recursive: true });
    } catch {
      /* best effort — tryAcquireLock will report the real failure */
    }
  }
  const lock = tryAcquireLock(lockFile);
  if (!lock) {
    return { ok: true, tick: bucket, outcomes: null, skippedLocked: true };
  }
  try {
    const records = readHeartbeatLog(vaultPath);
    const outcomes: TickRoutineOutcome[] = [];
    for (const r of enumerateRoutines(vaultPath)) {
      if (!r.enabled) continue;
      if (!r.cron) continue;
      if (!isCronDue(r.cron, now)) continue;

      // Idempotency: skip if this routine already ran in this tick bucket.
      if (routineRanThisTick(records, r.id, bucket)) {
        outcomes.push({ domain: r.domain, id: r.id, status: "skipped", reason: "already-ran-this-tick" });
        continue;
      }

      // Budget: refuse once the tick's token/$/routine caps are crossed.
      const spent = tickSpend(records, bucket);
      const cost = estimate(r);
      const block = budgetBlockReason(spent, budget, cost);
      if (block) {
        const rec: HeartbeatTickRecord = {
          ts: now.getTime(),
          domain: r.domain,
          routine: r.id,
          tick: bucket,
          status: "skipped",
          reason: block,
        };
        appendHeartbeatRecord(vaultPath, rec);
        records.push(rec);
        outcomes.push({ domain: r.domain, id: r.id, status: "skipped", reason: block });
        continue;
      }

      // "Run" — for now this records the run (and its accounted cost). The
      // actual engine invocation is a deliberate future step (no network /
      // no auto-execute by default).
      const rec: HeartbeatTickRecord = {
        ts: now.getTime(),
        domain: r.domain,
        routine: r.id,
        tick: bucket,
        status: "ran",
        tokens: cost.tokens,
        cost_usd: cost.costUsd,
      };
      appendHeartbeatRecord(vaultPath, rec);
      records.push(rec);
      outcomes.push({ domain: r.domain, id: r.id, status: "ran" });
    }
    return { ok: true, tick: bucket, outcomes };
  } finally {
    lock.release();
  }
}

// -----------------------------------------------------------------------------
// Exported JSON handlers (ENGINE-JSON-API.md):
//   prevail heartbeat install --json  → { ok, installed: [...] }
//   prevail heartbeat status  --json  → { ok, installed, routines: [...] }
// These return plain objects; the index.tsx command layer prints them.
// -----------------------------------------------------------------------------

/** Handler for `heartbeat install`. Returns the contract JSON object. */
export function handleInstall(vaultPath: string): { ok: boolean; installed: string[]; plist?: string; error?: string; unsupported?: boolean } {
  const r = install(vaultPath);
  const out: { ok: boolean; installed: string[]; plist?: string; error?: string; unsupported?: boolean } = {
    ok: r.ok,
    installed: r.installed,
    plist: r.plist,
  };
  if (r.error) out.error = r.error;
  if (r.unsupported) out.unsupported = r.unsupported;
  return out;
}

/** Handler for `heartbeat status`. Returns the contract JSON object. */
export function handleStatus(vaultPath: string): HeartbeatStatus {
  return status(vaultPath);
}
