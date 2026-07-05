// Per-host ledger sharding (G4): kills the split-brain that a two-way file sync
// (mutagen) creates for append-only JSONL. When the hub Mac and an interactive
// client both append to the SAME `<ledger>.jsonl`, the sync sees a whole-file
// conflict and keeps ONE side - silently dropping the other's lines. A local
// file lock does not help: it is an OS construct on one machine and cannot
// coordinate across the sync.
//
// Fix: each machine appends to ITS OWN shard `<ledger>.<host>.jsonl`. No file
// ever has two writers, so the sync only ever moves whole files that a single
// machine owns - no interleaving, no lost lines. Readers merge every shard
// (plus any legacy single-file ledger) back into one time-ordered stream.
//
// The shard suffix is os.hostname(), sanitized. Machine-agnostic: whatever the
// two (or three) machines are called, each gets its own lane automatically.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";

// A stable, filesystem-safe host token. Injectable for tests.
export function hostToken(host: string = hostname()): string {
  const t = (host || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t || "unknown";
}

/** The path THIS machine appends to for a given logical ledger path.
 *  `<dir>/<name>.jsonl` -> `<dir>/<name>.<host>.jsonl`. */
export function shardPathFor(logicalPath: string, host?: string): string {
  const dir = dirname(logicalPath);
  const base = basename(logicalPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return join(dir, `${stem}.${hostToken(host)}${ext}`);
}

/** Every shard (all hosts) plus the legacy single file, for a logical ledger.
 *  Order: legacy first, then shards sorted by host, so a merge that sorts by a
 *  timestamp field stays stable and back-compatible. */
export function shardPaths(logicalPath: string): string[] {
  const dir = dirname(logicalPath);
  const base = basename(logicalPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const out: string[] = [];
  if (existsSync(logicalPath)) out.push(logicalPath); // legacy pre-sharding file
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { entries = []; }
  const prefix = `${stem}.`;
  const shards = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext) && f !== base)
    .sort()
    .map((f) => join(dir, f));
  out.push(...shards);
  return out;
}

/** Read + concatenate every shard's text for a logical ledger. `decode` lets a
 *  caller apply per-file decryption (vault-session's reader); default is plain
 *  UTF-8. Missing/unreadable shards are skipped. */
export function readAllShards(logicalPath: string, decode: (path: string) => string = plainRead): string {
  return shardPaths(logicalPath).map((p) => { try { return decode(p); } catch { return ""; } }).filter(Boolean).join("");
}

function plainRead(path: string): string {
  try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}
