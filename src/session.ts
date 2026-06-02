import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";

const DATA_DIR = join(homedir(), ".prevail");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const PROMPTS_DIR = join(DATA_DIR, "prompts");
const DB_PATH = join(DATA_DIR, "sessions.db");

let dbInstance: Database | null = null;

// SECURITY: lock files down to user-only access. Session DB + JSONL +
// prompt logs contain everything the operator told the model — including
// any secrets pasted into a prompt. Default umask is 0644 (world-readable
// on macOS / shared machines / cloud-backup tier). 0600 makes them
// owner-only. tryChmod swallows errors because chmod can fail on certain
// network mounts; the data is still written, just less locked down there.
function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* best-effort */
  }
}

function ensureDirs() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    tryChmod(DATA_DIR, 0o700);
  }
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    tryChmod(SESSIONS_DIR, 0o700);
  }
  if (!existsSync(PROMPTS_DIR)) {
    mkdirSync(PROMPTS_DIR, { recursive: true });
    tryChmod(PROMPTS_DIR, 0o700);
  }
}

// Append a human-readable prompt entry to ~/.prevail/prompts/<domain>.md.
// One markdown block per prompt; assistant responses are NOT logged here —
// this file is for what the user is asking, not what the model says back.
function appendPromptFile(msg: PersistedMessage): void {
  if (msg.role !== "user") return;
  try {
    ensureDirs();
    const safe = msg.domain.replace(/[^a-z0-9-_]/gi, "_").toLowerCase();
    const filename = join(PROMPTS_DIR, `${safe}.md`);
    const when = new Date(msg.ts).toISOString();
    const cliTag = msg.cli ? ` · ${msg.cli}${msg.model ? "·" + msg.model : ""}` : "";
    // Header line per entry, then a blockquote of the prompt so multi-line
    // prompts stay readable and don't collide with the next entry.
    const lines = msg.content.split("\n").map((l) => `> ${l}`).join("\n");
    const block = `### ${when}${cliTag} · session ${msg.session_id}\n\n${lines}\n\n`;
    const isNew = !existsSync(filename);
    appendFileSync(filename, block);
    if (isNew) tryChmod(filename, 0o600);
  } catch {}
}

function db(): Database | null {
  if (dbInstance) return dbInstance;
  try {
    ensureDirs();
    const isNew = !existsSync(DB_PATH);
    const d = new Database(DB_PATH);
    if (isNew) tryChmod(DB_PATH, 0o600);
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        domain, session_id, role, content,
        ts UNINDEXED, cli UNINDEXED, model UNINDEXED
      );
    `);
    dbInstance = d;
    return d;
  } catch {
    return null;
  }
}

export interface PersistedMessage {
  domain: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  cli?: string;
  model?: string;
}

export function persistMessage(msg: PersistedMessage): void {
  if (msg.role === "system") return; // don't persist transient system notes
  try {
    ensureDirs();
    const filename = join(SESSIONS_DIR, `${msg.domain}-${msg.session_id}.jsonl`);
    const isNew = !existsSync(filename);
    appendFileSync(filename, JSON.stringify(msg) + "\n");
    if (isNew) tryChmod(filename, 0o600);
    const handle = db();
    if (handle) {
      handle.run(
        `INSERT INTO messages (domain, session_id, role, content, ts, cli, model) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          msg.domain,
          msg.session_id,
          msg.role,
          msg.content,
          msg.ts,
          msg.cli ?? "",
          msg.model ?? "",
        ],
      );
    }
    // Per-domain prompt log — human-readable, prompts only.
    appendPromptFile(msg);
  } catch {}
}

export function promptLogPath(domain: string): string {
  const safe = domain.replace(/[^a-z0-9-_]/gi, "_").toLowerCase();
  return join(PROMPTS_DIR, `${safe}.md`);
}

export interface SearchHit {
  domain: string;
  session_id: string;
  role: string;
  content: string;
  ts: number;
  excerpt: string;
}

export function searchMessages(query: string, limit = 5): SearchHit[] {
  const handle = db();
  if (!handle) return [];
  const q = sanitizeQuery(query);
  if (!q) return [];
  try {
    const rows = handle
      .query<SearchHit, [string, number]>(
        `SELECT domain, session_id, role, content, ts,
                snippet(messages, 3, '«', '»', '…', 16) AS excerpt
         FROM messages
         WHERE content MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(q, limit);
    return rows;
  } catch {
    return [];
  }
}

function sanitizeQuery(raw: string): string {
  // FTS5 has special characters; quote phrases that contain non-alphanumeric chars
  const q = raw.trim();
  if (!q) return "";
  if (/^[\w\s-]+$/.test(q)) return q;
  return `"${q.replace(/"/g, '""')}"`;
}

export interface DomainHistory {
  domain: string;
  message_count: number;
  last_ts: number | null;
  session_count: number;
}

export function getRecentUserPrompts(domain: string, limit = 10): string[] {
  const handle = db();
  if (!handle) return [];
  try {
    const rows = handle
      .query<{ content: string }, [string, number]>(
        `SELECT content FROM messages
         WHERE domain = ? AND role = 'user'
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(domain, limit);
    return rows
      .map((r) => r.content)
      .filter((c) => typeof c === "string" && c.length > 0);
  } catch {
    return [];
  }
}

export function getDomainHistory(domain: string): DomainHistory {
  const empty: DomainHistory = {
    domain,
    message_count: 0,
    last_ts: null,
    session_count: 0,
  };
  const handle = db();
  if (!handle) return empty;
  try {
    const row = handle
      .query<
        {
          message_count: number;
          last_ts: number | null;
          session_count: number;
        },
        [string]
      >(
        `SELECT COUNT(*) AS message_count,
                MAX(ts) AS last_ts,
                COUNT(DISTINCT session_id) AS session_count
         FROM messages
         WHERE domain = ? AND role != 'system'`,
      )
      .get(domain);
    return {
      domain,
      message_count: row?.message_count ?? 0,
      last_ts: row?.last_ts ?? null,
      session_count: row?.session_count ?? 0,
    };
  } catch {
    return empty;
  }
}

export interface UserPromptRecord {
  ts: number;
  content: string;
  session_id: string;
  cli: string;
  model: string;
}

// Returns the user's prompts (role === 'user') for a domain, newest first.
// Prompts only — assistant responses are excluded. Used for the /history view.
export function getUserPromptsForDomain(domain: string, limit = 50): UserPromptRecord[] {
  const handle = db();
  if (!handle) return [];
  try {
    const rows = handle
      .query<
        { ts: number; content: string; session_id: string; cli: string; model: string },
        [string, number]
      >(
        `SELECT ts, content, session_id, cli, model
         FROM messages
         WHERE domain = ? AND role = 'user'
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(domain, limit);
    return rows;
  } catch {
    return [];
  }
}

export function formatRelativeDate(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "1d ago";
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}

export function makeSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
