// Durable, bounded ledger appends (perf audit §1a/§1c + long-term growth).
//
// The problem this solves, for the whole life of a vault:
//   * DATA LOSS - concurrent writers (hub daemon + desktop + TUI) appending to
//     the same JSONL with no cross-process lock silently clobber each other.
//   * O(n^2) GROWTH - under vault encryption, appending one line rewrites the
//     ENTIRE file (decrypt-all + encrypt-all). Left unbounded, every append
//     gets slower forever as the ledger grows.
//   * UNBOUNDED READS - a "last 50" view that first parses the whole file is
//     O(lifetime), not O(50).
//
// The strategy (archiving + caching, not deletion): keep the LIVE ledger small
// by rolling its older prefix into a monthly archive shard under `_archive/`.
// The live file stays bounded, so appends and tail reads stay fast forever;
// nothing is ever deleted - history lives in the archive and is read only when
// a full-history view asks for it. Every append takes a cross-process lock on
// the `.lock` sibling (NEVER the data file - our lock helper creates and unlinks
// AT the given path).

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tryAcquireLock } from "./file-lock.ts";
import { vappendLine, vreadFile, vwriteFile } from "./vault-session.ts";

// Live ledger stays under ~512 KB: small enough that the encrypted rewrite cost
// per append is trivially bounded, big enough that rotation is rare.
const LIVE_SOFT_MAX = 512 * 1024;
// After rotation, keep this much recent tail live (so "recent activity" views
// and generators still see the last stretch without touching the archive).
const KEEP_TAIL = 128 * 1024;

/** The archive shard a rotation appends into. Monthly granularity keeps the
 *  number of archive files small over years. `month` is injected for tests. */
export function archiveShardPath(logicalPath: string, month: string): string {
  const dir = join(dirname(logicalPath), "_archive");
  const base = basename(logicalPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return join(dir, `${stem}.${month}${ext}`);
}

function monthOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Append one line to a ledger, LOCKED, and roll the prefix into a monthly
 * archive when the live file crosses the soft cap. `now` is injectable so the
 * archive month is deterministic in tests (production passes Date.now()).
 * Best-effort like the ledgers it serves: never throws.
 */
export function appendLedger(logicalPath: string, line: string, now: number): void {
  try {
    mkdirSync(dirname(logicalPath), { recursive: true });
  } catch { /* ignore */ }
  const lock = tryAcquireLock(`${logicalPath}.lock`);
  try {
    vappendLine(logicalPath, line.endsWith("\n") ? line : `${line}\n`);
    // Rotate only when we can cheaply tell the file is large. statSync is on the
    // ciphertext for an encrypted vault, which is a fine size proxy.
    let size = 0;
    try { size = statSync(logicalPath).size; } catch { size = 0; }
    if (size > LIVE_SOFT_MAX) rotatePrefixLocked(logicalPath, now);
  } finally {
    lock?.release();
  }
}

// Move the older prefix (everything but the last KEEP_TAIL bytes, snapped to a
// record boundary) into the current month's archive shard, and shrink the live
// file to the tail. Caller already holds the lock.
function rotatePrefixLocked(logicalPath: string, now: number): void {
  let text: string;
  try { text = vreadFile(logicalPath); } catch { return; }
  const buf = Buffer.from(text, "utf8");
  let cut = Math.max(0, buf.length - KEEP_TAIL);
  while (cut > 0 && buf[cut - 1] !== 0x0a) cut--; // never split a record
  if (cut <= 0) return;
  const archive = archiveShardPath(logicalPath, monthOf(now));
  try { mkdirSync(dirname(archive), { recursive: true }); } catch { /* ignore */ }
  vappendLine(archive, buf.slice(0, cut).toString("utf8"));
  vwriteFile(logicalPath, buf.slice(cut).toString("utf8"));
}

/** Parse the LIVE ledger's newest `limit` entries without walking history.
 *  Bounded by construction: the live file is kept small by rotation, so this
 *  is O(live), not O(lifetime). Bad lines are skipped. */
export function readLedgerTail<T>(logicalPath: string, limit: number): T[] {
  if (!existsSync(logicalPath)) return [];
  let text: string;
  try { text = vreadFile(logicalPath); } catch { return []; }
  const lines = text.split("\n").filter((l) => l.trim());
  const out: T[] = [];
  for (const l of lines.slice(-limit)) {
    try { out.push(JSON.parse(l) as T); } catch { /* skip */ }
  }
  return out;
}

/** Every archive shard for a ledger, oldest first (by filename month). */
export function archiveShards(logicalPath: string): string[] {
  const dir = join(dirname(logicalPath), "_archive");
  if (!existsSync(dir)) return [];
  const base = basename(logicalPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((f) => f.startsWith(`${stem}.`) && f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f));
}

/** Full history: every archive shard (oldest first) THEN the live tail. Only
 *  for history views that genuinely need everything; hot paths use the tail. */
export function readLedgerAll<T>(logicalPath: string): T[] {
  const out: T[] = [];
  const files = [...archiveShards(logicalPath), logicalPath];
  for (const f of files) {
    if (!existsSync(f)) continue;
    let text: string;
    try { text = vreadFile(f); } catch { continue; }
    for (const l of text.split("\n")) {
      const t = l.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as T); } catch { /* skip */ }
    }
  }
  return out;
}
