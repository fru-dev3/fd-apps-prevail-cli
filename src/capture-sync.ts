import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { type BatchItem, ingestBatch } from "./capture.ts";
import { runtimePath } from "./path-safety.ts";
import { getAllUserPromptsSince } from "./session.ts";

// =============================================================================
// `prevail capture sync` - the PULL backstop. Where a harness has no submit
// hook (or one wasn't wired), this scrapes its native on-disk transcripts and
// replays the user prompts into <vault>/_meta/prompts.<tool>.jsonl via the same
// ingest keystone - so push and pull converge on one stream, deduped.
//
// Incremental via a CHECKPOINT file (we deliberately avoid the word "cursor" so
// nothing reads as the Cursor editor): per source-file mtime + a high-water ts
// for prevail's sessions.db. A file whose mtime hasn't advanced is skipped, so
// steady-state sync is cheap. Dedup in ingestBatch is the correctness backstop;
// the checkpoint is the efficiency layer.
//
// Validated formats (real transcripts on disk):
//   claude  - ~/.claude/projects/**/<session>.jsonl, type:"user" + STRING content
//   codex   - ~/.codex/sessions/**/rollout-*.jsonl, event_msg/user_message
//   prevail - ~/.prevail/sessions.db (FTS5 messages, role='user')
// Other harnesses are reported as not-yet-supported rather than silently empty.
// =============================================================================

export interface CaptureCheckpoint {
  version: number;
  /** Absolute transcript path → last-seen mtimeMs. */
  files: Record<string, number>;
  /** High-water epoch-ms for prevail's sessions.db export. */
  prevailLastTs: number;
  /** High-water epoch-ms for opencode's message DB export. */
  opencodeLastTs: number;
}

/** Legacy, non-namespaced checkpoint path (pre multi-machine). Kept only so the
 *  migration can seed the per-host file from it. */
function legacyCheckpointPath(vault: string): string {
  return join(runtimePath(vault, "_meta"), "capture_sync_checkpoint.json");
}

/** hostname lowercased and sanitized to [a-z0-9-] so it is a safe filename
 *  segment. Empty/odd hostnames collapse to "host". PREVAIL_HOST_SLUG is a test
 *  seam (os.hostname() is fixed for the process): it lets a test simulate a
 *  second machine sharing the vault. It is sanitized the same way. */
export function hostSlug(): string {
  const raw = process.env.PREVAIL_HOST_SLUG && process.env.PREVAIL_HOST_SLUG.length > 0
    ? process.env.PREVAIL_HOST_SLUG
    : hostname();
  const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "host";
}

/** Per-machine checkpoint path. The checkpoint lives in the SHARED vault but is
 *  keyed by absolute transcript paths — two Macs with the same username would
 *  otherwise overwrite each other's high-water marks and silently MISS prompts.
 *  Namespacing by hostname keeps each machine's marks separate. */
export function checkpointPath(vault: string): string {
  return join(runtimePath(vault, "_meta"), `capture_sync_checkpoint.${hostSlug()}.json`);
}

function parseCheckpoint(raw: string): CaptureCheckpoint | null {
  try {
    const c = JSON.parse(raw) as Partial<CaptureCheckpoint>;
    return {
      version: 1,
      files: c.files && typeof c.files === "object" ? c.files : {},
      opencodeLastTs: typeof c.opencodeLastTs === "number" ? c.opencodeLastTs : 0,
      prevailLastTs: typeof c.prevailLastTs === "number" ? c.prevailLastTs : 0,
    };
  } catch {
    return null;
  }
}

export function readCheckpoint(vault: string): CaptureCheckpoint {
  const fallback: CaptureCheckpoint = {
    version: 1,
    files: {},
    prevailLastTs: 0,
    opencodeLastTs: 0,
  };
  const p = checkpointPath(vault);
  if (existsSync(p)) {
    try {
      return parseCheckpoint(readFileSync(p, "utf8")) ?? fallback;
    } catch {
      return fallback;
    }
  }
  // Migration: first run on this host. If the legacy (non-namespaced) checkpoint
  // exists, seed the per-host file from it, then use ONLY the per-host file going
  // forward. The legacy file is left in place (another older machine may still
  // read it, and we never destroy a checkpoint).
  const legacy = legacyCheckpointPath(vault);
  if (existsSync(legacy)) {
    try {
      const seeded = parseCheckpoint(readFileSync(legacy, "utf8"));
      if (seeded) {
        writeCheckpoint(vault, seeded);
        return seeded;
      }
    } catch {
      /* fall through to fresh fallback */
    }
  }
  return fallback;
}

export function writeCheckpoint(vault: string, cp: CaptureCheckpoint): void {
  const p = checkpointPath(vault);
  try {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, `${JSON.stringify(cp, null, 2)}\n`, "utf8");
  } catch {
    /* best effort - a missed checkpoint just means we re-scan next run (dedup saves us) */
  }
}

/** Recursively collect *.jsonl files under a root (depth-limited, defensive). */
function walkJsonl(root: string, depth = 6): string[] {
  const out: string[] = [];
  if (depth < 0 || !existsSync(root)) return out;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(full, depth - 1));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Per-source scan results. An extractor reads the filesystem and returns the new
// prompts plus the file mtimes it consumed; the driver writes + checkpoints.
// -----------------------------------------------------------------------------

interface ScanResult {
  present: boolean;
  items: BatchItem[];
  filesScanned: number;
  touched: Record<string, number>;
  detail?: string;
}

/** Only return files whose mtime advanced past the checkpoint. */
function changedFiles(files: string[], cp: CaptureCheckpoint): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  for (const path of files) {
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if ((cp.files[path] ?? 0) >= mtime) continue;
    out.push({ path, mtime });
  }
  return out;
}

// ── claude ────────────────────────────────────────────────────────────────────
function scanClaude(cp: CaptureCheckpoint): ScanResult {
  const root = join(homedir(), ".claude", "projects");
  const present = existsSync(root);
  const res: ScanResult = { present, items: [], filesScanned: 0, touched: {} };
  if (!present) return res;
  for (const { path, mtime } of changedFiles(walkJsonl(root), cp)) {
    res.filesScanned++;
    res.touched[path] = mtime;
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (r.type !== "user") continue;
      const msg = r.message as { role?: string; content?: unknown } | undefined;
      // Typed prompts have STRING content; tool-results have array content.
      if (!msg || msg.role !== "user" || typeof msg.content !== "string") continue;
      const text = msg.content.trim();
      // Skip slash-command echoes / injected command output.
      if (!text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
      res.items.push({
        prompt: text,
        session: typeof r.sessionId === "string" ? r.sessionId : undefined,
        cwd: typeof r.cwd === "string" ? r.cwd : undefined,
        epochMs: typeof r.timestamp === "string" ? Date.parse(r.timestamp) || undefined : undefined,
      });
    }
  }
  return res;
}

// ── codex ───────────────────────────────────────────────────────────────────
function scanCodex(cp: CaptureCheckpoint): ScanResult {
  const root = join(homedir(), ".codex", "sessions");
  const present = existsSync(root);
  const res: ScanResult = { present, items: [], filesScanned: 0, touched: {} };
  if (!present) return res;
  for (const { path, mtime } of changedFiles(walkJsonl(root), cp)) {
    res.filesScanned++;
    res.touched[path] = mtime;
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let session: string | undefined;
    let cwd: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = r.payload as Record<string, unknown> | undefined;
      if (r.type === "session_meta" && payload) {
        if (typeof payload.id === "string") session = payload.id;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        continue;
      }
      // The real typed turn is event_msg/user_message; response_item messages
      // carry injected <environment_context> noise, so we skip those.
      if (
        r.type === "event_msg" &&
        payload?.type === "user_message" &&
        typeof payload.message === "string"
      ) {
        const text = payload.message.trim();
        if (!text) continue;
        res.items.push({
          prompt: text,
          session,
          cwd,
          epochMs:
            typeof r.timestamp === "string" ? Date.parse(r.timestamp) || undefined : undefined,
        });
      }
    }
  }
  return res;
}

// ── prevail (sessions.db) ─────────────────────────────────────────────────────
function scanPrevail(cp: CaptureCheckpoint): { res: ScanResult; newLastTs: number } {
  const dbPath = join(homedir(), ".prevail", "sessions.db");
  const present = existsSync(dbPath);
  const res: ScanResult = { present, items: [], filesScanned: present ? 1 : 0, touched: {} };
  if (!present) return { res, newLastTs: cp.prevailLastTs };
  let newLastTs = cp.prevailLastTs;
  for (const row of getAllUserPromptsSince(cp.prevailLastTs)) {
    const text = (row.content ?? "").trim();
    if (text) {
      res.items.push({ prompt: text, session: row.session_id, cwd: "", epochMs: row.ts });
    }
    if (row.ts > newLastTs) newLastTs = row.ts;
  }
  return { res, newLastTs };
}

// ── opencode (opencode.db) ────────────────────────────────────────────────────
// Messages live in a SQLite db: a `message` row (role:"user") joined to its
// `part` rows (type:"text") that hold the prompt text. Incremental on the
// message time_created high-water mark.
function scanOpencode(cp: CaptureCheckpoint): { res: ScanResult; newLastTs: number } {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const present = existsSync(dbPath);
  const res: ScanResult = { present, items: [], filesScanned: present ? 1 : 0, touched: {} };
  if (!present) return { res, newLastTs: cp.opencodeLastTs };
  let newLastTs = cp.opencodeLastTs;
  try {
    // NOT readonly: opencode runs its db in WAL mode, which bun:sqlite can't
    // open read-only (it needs to touch the -shm file). We only ever SELECT,
    // so this connection behaves as a plain WAL reader and never mutates data.
    const db = new Database(dbPath);
    try {
      const rows = db
        .query<{ session_id: string; time_created: number; data: string }, [number]>(
          `SELECT m.session_id, m.time_created, p.data
             FROM part p JOIN message m ON p.message_id = m.id
            WHERE m.data LIKE '%"role":"user"%'
              AND p.data LIKE '%"type":"text"%'
              AND m.time_created > ?
            ORDER BY m.time_created ASC
            LIMIT 5000`,
        )
        .all(cp.opencodeLastTs);
      for (const row of rows) {
        let text = "";
        try {
          text = (JSON.parse(row.data) as { text?: string }).text ?? "";
        } catch {
          continue;
        }
        text = text.trim();
        if (text) {
          res.items.push({
            prompt: text,
            session: row.session_id,
            cwd: "",
            epochMs: row.time_created,
          });
        }
        if (row.time_created > newLastTs) newLastTs = row.time_created;
      }
    } finally {
      db.close();
    }
  } catch {
    /* db locked / schema drift: best-effort, leave high-water unchanged */
  }
  return { res, newLastTs };
}

// ── antigravity (history.jsonl) ───────────────────────────────────────────────
// The Antigravity CLI logs each submitted prompt as a JSONL record with a
// `display` field. mtime-gated like the other file sources.
function scanAntigravity(cp: CaptureCheckpoint): ScanResult {
  const file = join(homedir(), ".gemini", "antigravity-cli", "history.jsonl");
  const present = existsSync(file);
  const res: ScanResult = { present, items: [], filesScanned: 0, touched: {} };
  if (!present) return res;
  for (const { path, mtime } of changedFiles([file], cp)) {
    res.filesScanned++;
    res.touched[path] = mtime;
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const l of raw.split("\n").filter((x) => x.trim())) {
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(l) as Record<string, unknown>;
      } catch {
        continue;
      }
      const text = typeof r.display === "string" ? r.display.trim() : "";
      if (text) res.items.push({ prompt: text, session: "antigravity", cwd: "" });
    }
  }
  return res;
}

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

export interface SourceReport {
  tool: string;
  present: boolean;
  filesScanned: number;
  found: number;
  written: number;
  skipped: number;
  detail?: string;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  sources: SourceReport[];
}

/** Tools we know about but don't yet have a validated extractor for. Reported
 *  honestly so the operator/UI never mistakes "no extractor" for "no prompts". */
const UNSUPPORTED: { tool: string; detect: () => boolean; detail: string }[] = [
  {
    tool: "gemini",
    detect: () => existsSync(join(homedir(), ".gemini", "config")),
    detail: "Gemini CLI does not persist chat transcripts locally",
  },
  { tool: "openclaw", detect: () => false, detail: "no transcript source" },
  { tool: "hermes", detect: () => false, detail: "no transcript source" },
  { tool: "pi", detect: () => false, detail: "transcript format not yet supported" },
];

function runSource(vault: string, tool: string, scan: ScanResult): SourceReport {
  const batch = ingestBatch(vault, tool, scan.items);
  return {
    tool,
    present: scan.present,
    filesScanned: scan.filesScanned,
    found: scan.items.length,
    written: batch.written,
    skipped: batch.skipped,
    detail: scan.detail,
    error: batch.error,
  };
}

/** Run a full pull-sync across every source. Idempotent; safe to run on a timer. */
export function sync(vault: string): SyncResult {
  const cp = readCheckpoint(vault);
  const sources: SourceReport[] = [];

  const claude = scanClaude(cp);
  sources.push(runSource(vault, "claude", claude));
  Object.assign(cp.files, claude.touched);

  const codex = scanCodex(cp);
  sources.push(runSource(vault, "codex", codex));
  Object.assign(cp.files, codex.touched);

  const prevail = scanPrevail(cp);
  sources.push(runSource(vault, "prevail", prevail.res));
  cp.prevailLastTs = prevail.newLastTs;

  const opencode = scanOpencode(cp);
  sources.push(runSource(vault, "opencode", opencode.res));
  cp.opencodeLastTs = opencode.newLastTs;

  const antigravity = scanAntigravity(cp);
  sources.push(runSource(vault, "antigravity", antigravity));
  Object.assign(cp.files, antigravity.touched);

  for (const u of UNSUPPORTED) {
    let present = false;
    try {
      present = u.detect();
    } catch {
      /* ignore */
    }
    sources.push({
      tool: u.tool,
      present,
      filesScanned: 0,
      found: 0,
      written: 0,
      skipped: 0,
      detail: u.detail,
    });
  }

  writeCheckpoint(vault, cp);
  return { ok: sources.every((s) => !s.error), sources };
}

export function handleSync(vault: string): SyncResult {
  return sync(vault);
}
