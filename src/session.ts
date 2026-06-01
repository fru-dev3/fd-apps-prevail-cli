import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

const DATA_DIR = join(homedir(), ".aireadyu");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const DB_PATH = join(DATA_DIR, "sessions.db");

let dbInstance: Database | null = null;

function ensureDirs() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function db(): Database | null {
  if (dbInstance) return dbInstance;
  try {
    ensureDirs();
    const d = new Database(DB_PATH);
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
    appendFileSync(filename, JSON.stringify(msg) + "\n");
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
  } catch {}
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
