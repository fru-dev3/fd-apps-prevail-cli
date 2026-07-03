import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { hostname } from "node:os";

// Atomic single-writer lock for cross-process serialization. Used by the
// schedule + briefing tickers so the TUI and the daemon can't both fire the
// same cron entry in the same minute (#10 from the security audit). Pure
// POSIX — opens a sentinel file with O_CREAT | O_EXCL ('wx' flag in
// node.js terms), which atomically succeeds for exactly one caller.
//
// Stale-lock recovery: if the lock file exists but its owner process is
// dead AND the file is older than STALE_MS, we forcibly take it. This
// covers the case where the daemon was kill -9'd and never released — a
// daemon restart will recover within the staleness window.
//
// MULTI-MACHINE (hub/client on one shared vault over SMB/Tailscale): a PID from
// another machine is meaningless locally — process.kill(pid, 0) would test THIS
// machine's process table, so a foreign PID that happens to collide reads as
// "alive" (never stolen) and one that doesn't reads as "dead" (stolen while the
// remote tick is mid-flight). So the sentinel now records the writer's hostname:
//   - same hostname (or a legacy PID-only sentinel): keep the PID liveness check.
//   - foreign hostname: NEVER PID-check. Treat the lock as live until its mtime
//     crosses the STALE_MS floor, then reclaim it.

const STALE_MS = 5 * 60 * 1000; // 5 minutes — way longer than any real tick

export interface LockHandle {
  release(): void;
}

interface LockSentinel {
  pid: number;
  /** Hostname of the machine that wrote the lock. Absent in legacy sentinels
   *  (which were a bare PID) — those are treated as local-machine format. */
  host?: string;
  /** Epoch-ms the lock was written. Advisory; staleness uses the file mtime. */
  ts?: number;
}

/** Parse a sentinel's contents. Handles both the JSON format and the legacy
 *  bare-PID format (treated as local-machine, no host field). Returns null when
 *  nothing usable can be read. */
function parseSentinel(raw: string): LockSentinel | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Partial<LockSentinel>;
      const pid = typeof o.pid === "number" ? o.pid : NaN;
      return {
        pid,
        host: typeof o.host === "string" && o.host.length > 0 ? o.host : undefined,
        ts: typeof o.ts === "number" ? o.ts : undefined,
      };
    } catch {
      return null;
    }
  }
  // Legacy: a bare PID written by an older prevail. No host → local format.
  const pid = parseInt(text, 10);
  if (!Number.isFinite(pid)) return { pid: NaN };
  return { pid };
}

// Try to acquire a lock at `path`. Returns null if another live process
// already holds it. Writes a JSON sentinel { pid, host, ts } so we can detect
// stale locks — and foreign-machine locks — on the next attempt.
export function tryAcquireLock(path: string): LockHandle | null {
  try {
    // 'wx' = write + exclusive creation. EEXIST if file already exists.
    const fd = openSync(path, "wx");
    try {
      const sentinel: LockSentinel = { pid: process.pid, host: hostname(), ts: Date.now() };
      writeFileSync(fd, JSON.stringify(sentinel));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try { unlinkSync(path); } catch { /* best effort */ }
      },
    };
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== "EEXIST") return null;
    // Existing lock — check if it's stale.
    if (isLockStale(path)) {
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
      // Retry once after clearing the stale lock.
      return tryAcquireLock(path);
    }
    return null;
  }
}

function isLockStale(path: string): boolean {
  let st;
  try {
    st = statSync(path);
  } catch {
    // Race: file was removed between EEXIST and stat. Caller will retry.
    return true;
  }
  // Hard staleness floor: if the lock file is older than STALE_MS, take it
  // regardless of hostname or PID (some platforms / sandboxes disallow
  // kill(pid, 0); a foreign host can't be PID-probed at all).
  if (Date.now() - st.mtimeMs > STALE_MS) return true;

  let sentinel: LockSentinel | null;
  try {
    sentinel = parseSentinel(readFileSync(path, "utf8"));
  } catch {
    return true; // unreadable sentinel within the fresh window → treat as stale
  }
  if (!sentinel) return true;

  // Foreign-machine lock: a PID from another host is meaningless here, so we
  // NEVER PID-probe it. Within the STALE_MS window (checked above) it is
  // considered live and must not be stolen; past the floor the mtime check
  // already reclaimed it. Legacy sentinels have no host and fall through to the
  // local PID check below.
  const local = hostname();
  if (sentinel.host && sentinel.host !== local) {
    return false; // fresh foreign lock → live, do not steal
  }

  // Local (or legacy) sentinel — PID liveness check. kill -0 signals nothing
  // but tests if the process exists and we have permission to signal it. Throws
  // ESRCH if dead. NOTE: we deliberately do NOT treat pid === process.pid as
  // stale — doing so would break legitimate same-process double-acquire. If we
  // crashed with the lock held, the 5-minute mtime floor above recovers it.
  try {
    const pid = sentinel.pid;
    if (!Number.isFinite(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return false; // process is alive — lock is real
  } catch (err) {
    const e = err as { code?: string };
    return e.code === "ESRCH"; // owner is dead → stale
  }
}

// Convenience wrapper: run `fn` under the lock. If the lock can't be
// acquired (another tick is in progress), returns null without running.
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T | null> {
  const lock = tryAcquireLock(path);
  if (!lock) return null;
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// Re-exported for tests that want to assert lock files don't persist.
export function lockExists(path: string): boolean {
  return existsSync(path);
}
