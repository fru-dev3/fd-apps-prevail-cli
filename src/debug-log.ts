// Tiny structured logger. JSON Lines (one object per line) appended to
// ~/.prevail/debug.log. Designed for silent-catch sites that currently
// swallow errors — they can call logDebug() without awaiting and without
// any risk of crashing the chat path. Filesystem failures are eaten on
// purpose; a logger that can crash its caller is worse than no log.
//
// Rotation: when the file crosses 5MB on any write, rotate to .1/.2/.3
// (.4 and beyond are dropped). Three rotations is enough headroom for
// post-mortem on a recent session without unbounded disk growth.
//
// Path: ~/.prevail/debug.log by default. Honors PREVAIL_DATA_DIR (the
// same env var bundledDemoVaultPath() uses) so tests and sandboxed runs
// can redirect without touching the real user dir.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ROTATIONS = 3; // keep debug.log.1, .2, .3

export interface DebugEntry {
  ts: string;
  cat: string;
  msg: string;
  meta?: Record<string, unknown>;
}

function dataDir(): string {
  const override = process.env.PREVAIL_DATA_DIR;
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".prevail");
}

export function debugLogPath(): string {
  return join(dataDir(), "debug.log");
}

// Append a single JSON Lines entry. Synchronous on purpose — the chat
// path can't await this, and the volume is tiny (one line per silent
// catch). Any filesystem failure is swallowed: a logger that can crash
// its caller defeats the entire point of being safer than a bare catch.
export function logDebug(
  category: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  try {
    const dir = dataDir();
    const file = debugLogPath();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    }
    // Rotate BEFORE appending so the entry that pushes us over the
    // threshold ends up in the fresh debug.log (not buried at the end
    // of the bloated .1 archive). Stat is cheap; one check per write
    // is well worth the cleaner semantics.
    rotateIfNeeded(file);
    const fresh = !existsSync(file);
    const entry: DebugEntry = {
      ts: new Date().toISOString(),
      cat: category,
      msg: message,
    };
    if (meta && Object.keys(meta).length > 0) entry.meta = meta;
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(file, line);
    if (fresh) {
      // Lock down on first creation. Best-effort: chmod failures on
      // exotic filesystems (e.g. tmpfs on CI) shouldn't break logging.
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
    }
  } catch {
    // Intentionally silent — see header comment.
  }
}

function rotateIfNeeded(file: string): void {
  try {
    const s = statSync(file);
    if (s.size <= MAX_BYTES) return;
  } catch {
    return;
  }
  // Cascade: drop the oldest, then shift each survivor down by one.
  // We rename oldest-first so we never collide with an existing file
  // mid-cascade (debug.log.3 → unlink; debug.log.2 → .3; .1 → .2;
  // debug.log → .1).
  try {
    const oldest = `${file}.${ROTATIONS + 1}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* best effort */ }
    }
    const tail = `${file}.${ROTATIONS}`;
    if (existsSync(tail)) {
      try { unlinkSync(tail); } catch { /* best effort */ }
    }
    for (let i = ROTATIONS - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      const dst = `${file}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* best effort */ }
      }
    }
    try { renameSync(file, `${file}.1`); } catch { /* best effort */ }
  } catch {
    /* best effort — rotation failure is non-fatal */
  }
}

// Return up to n trailing lines (raw JSON strings, newline-stripped) in
// chronological order — i.e. oldest first, newest last. The doctor
// command pretty-prints them; we return strings (not parsed objects)
// because the file is small enough that re-parsing for display is wasted
// work and lets the caller decide on format.
export function readDebugTail(n = 50): string[] {
  const file = debugLogPath();
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length <= n) return lines;
  return lines.slice(lines.length - n);
}
