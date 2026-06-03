import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";

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

const STALE_MS = 5 * 60 * 1000; // 5 minutes — way longer than any real tick

export interface LockHandle {
  release(): void;
}

// Try to acquire a lock at `path`. Returns null if another live process
// already holds it. Writes the current PID into the file so we can detect
// stale locks on the next attempt.
export function tryAcquireLock(path: string): LockHandle | null {
  try {
    // 'wx' = write + exclusive creation. EEXIST if file already exists.
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, String(process.pid));
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
  // regardless of whether the PID lookup works (some platforms / sandboxes
  // disallow kill(pid, 0)).
  if (Date.now() - st.mtimeMs > STALE_MS) return true;
  // PID liveness check — kill -0 signals nothing but tests if the process
  // exists and we have permission to signal it. Throws ESRCH if dead.
  // NOTE: we deliberately do NOT treat pid === process.pid as stale —
  // doing so would break legitimate same-process double-acquire (the
  // whole point of a lock is to serialize within and across processes
  // alike). If we crashed with the lock held, the 5-minute mtime floor
  // above recovers it on the next attempt.
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = parseInt(raw, 10);
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
