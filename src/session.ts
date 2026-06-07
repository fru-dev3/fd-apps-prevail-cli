import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";

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
    // Sidecar metadata keyed by the FTS rowid. FTS5 virtual tables don't
    // accept ALTER TABLE ADD COLUMN ("virtual tables may not be altered"),
    // so framework + lens live in a regular table joined on rowid. The
    // CREATE IF NOT EXISTS form is idempotent — re-running on an upgraded
    // db is a no-op. Old rows that predate this table simply return NULL
    // on the LEFT JOIN, which is the desired "no metadata captured" state.
    d.exec(`
      CREATE TABLE IF NOT EXISTS messages_ext (
        rowid INTEGER PRIMARY KEY,
        framework TEXT,
        lens TEXT
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
  // Display labels (e.g. "BLUF", "CONTRARIAN") captured at SEND TIME.
  // Persisted to the messages_ext sidecar table so future recall, replay,
  // and the vault decision-log learning loop know which lens of attack
  // and which response structure shaped each turn.
  framework?: string;
  lens?: string;
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
      // Sidecar write — only when at least one tag is present, to avoid
      // bloating the sidecar with NULL/NULL rows for the (overwhelming)
      // case where no framework or lens is active. Reads use LEFT JOIN
      // so missing rows naturally read as no metadata.
      if (msg.framework || msg.lens) {
        try {
          handle.run(
            `INSERT INTO messages_ext (rowid, framework, lens) VALUES (last_insert_rowid(), ?, ?)`,
            [msg.framework ?? null, msg.lens ?? null],
          );
        } catch {
          /* best-effort — schema mismatch shouldn't break chat */
        }
      }
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

// ---------------------------------------------------------------------------
// JSONL chat threads — the source of truth (VAULT-SPEC §2/§4).
//
// Per the frozen contract, chat is persisted append-only to
// <vault>/<domain>/_threads/<sessionId>.jsonl, ONE JSON object per line, in
// a Pi-style branchable shape: { id, parentId, role, cli, model, content, ts }.
// The id/parentId pair lets a transcript branch (regenerate a turn off an
// earlier node) without rewriting history — every node names its parent.
//
// The existing ~/.prevail/sessions.db FTS index (persistMessage above) stays
// as a rebuildable, LOCAL-only index. SQLite must never live in the synced
// vault (VAULT-SPEC §4), so the JSONL in the vault is canonical and the .db
// outside it is a cache that can be regenerated from these files.
// ---------------------------------------------------------------------------

// One persisted chat turn line. Mirrors the Pi-style branchable node shape
// named in the E6 contract. `parentId` is null for the first turn in a thread
// (or for a turn deliberately rooted to start a new branch).
export interface ThreadTurn {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  cli: string;
  model: string;
  content: string;
  ts: number;
}

// Generate a thread-node id. Distinct prefix from makeSessionId so a node id
// can never be mistaken for a session id at a glance in a JSONL dump.
export function makeTurnId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Path to a domain's JSONL thread file inside the vault. Lives under the
// agent-writable _threads/ zone (VAULT-SPEC §3).
export function threadJsonlPath(vaultPath: string, domain: string, sessionId: string): string {
  return join(vaultPath, domain, "_threads", `${sessionId}.jsonl`);
}

function threadsDir(vaultPath: string, domain: string): string {
  return join(vaultPath, domain, "_threads");
}

// Append a turn to <domain>/_threads/<sessionId>.jsonl, creating the
// _threads dir on first write. This is the canonical persistence path; the
// SQLite index is written separately via persistMessage so the two layers
// stay decoupled and the index stays rebuildable. The sessionId (= thread
// file name) is threaded explicitly so one domain can hold many independent
// threads.
//
// `system` turns are persisted here (unlike the FTS index, which drops them)
// because a JSONL transcript should be a faithful, replayable record of the
// thread — branch points need every node, including system notes.
export function writeThreadTurn(
  vaultPath: string,
  domain: string,
  sessionId: string,
  turn: ThreadTurn,
): void {
  try {
    const dir = threadsDir(vaultPath, domain);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const file = threadJsonlPath(vaultPath, domain, sessionId);
    const isNew = !existsSync(file);
    appendFileSync(file, JSON.stringify(turn) + "\n");
    // SECURITY: thread transcripts contain the full conversation including
    // anything the operator pasted. Lock to owner-only on first create, same
    // posture as the sessions.db / prompt logs above.
    if (isNew) tryChmod(file, 0o600);
  } catch {}
}

// Read back a JSONL thread file as ThreadTurn[] (oldest → newest = file
// order). Malformed lines are skipped rather than throwing so one bad line
// can't poison the whole transcript. Returns [] if the file is absent.
export function readThreadTurns(
  vaultPath: string,
  domain: string,
  sessionId: string,
): ThreadTurn[] {
  const file = threadJsonlPath(vaultPath, domain, sessionId);
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: ThreadTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<ThreadTurn>;
      if (
        typeof obj.id === "string" &&
        typeof obj.role === "string" &&
        typeof obj.content === "string"
      ) {
        out.push({
          id: obj.id,
          parentId: typeof obj.parentId === "string" ? obj.parentId : null,
          role: obj.role as ThreadTurn["role"],
          cli: typeof obj.cli === "string" ? obj.cli : "",
          model: typeof obj.model === "string" ? obj.model : "",
          content: obj.content,
          ts: typeof obj.ts === "number" ? obj.ts : 0,
        });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Back-compat: import desktop-style _threads/<slug>.md transcripts into JSONL.
//
// The original desktop app wrote human-readable markdown threads with blocks
// like:
//
//     ## User
//     what's my net worth?
//
//     ## Assistant
//     Up 4.2% this month …
//
// This parses those "## Speaker" blocks into ThreadTurn lines and writes a
// sibling <slug>.jsonl so the JSONL source-of-truth covers legacy history.
// Lazy / idempotent: it only converts a <slug>.md when no <slug>.jsonl
// already exists, so re-running is a no-op and a freshly-written JSONL thread
// is never clobbered by its (possibly stale) markdown export.
// ---------------------------------------------------------------------------

// Map a markdown "## Speaker" heading to a ThreadTurn role. Unknown speakers
// (a custom persona name, etc.) are treated as assistant so the content is
// preserved rather than dropped.
function roleFromSpeaker(speaker: string): ThreadTurn["role"] {
  const s = speaker.trim().toLowerCase();
  if (s === "user" || s === "you" || s === "me" || s === "human") return "user";
  if (s === "system" || s === "note") return "system";
  return "assistant";
}

// Parse the "## Speaker" blocks of a desktop markdown thread into turns.
// Exported for testing — the parse is pure (no I/O).
export function parseDesktopThreadMarkdown(md: string): ThreadTurn[] {
  const lines = md.split("\n");
  const turns: ThreadTurn[] = [];
  let curRole: ThreadTurn["role"] | null = null;
  let buf: string[] = [];
  let parentId: string | null = null;

  const flush = () => {
    if (curRole === null) {
      buf = [];
      return;
    }
    const content = buf.join("\n").trim();
    buf = [];
    if (!content) {
      curRole = null;
      return;
    }
    const id = makeTurnId();
    turns.push({
      id,
      parentId,
      role: curRole,
      cli: "",
      model: "",
      content,
      ts: 0, // legacy markdown carried no per-turn timestamp
    });
    parentId = id; // linear chain — each imported turn parents the next
    curRole = null;
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      curRole = roleFromSpeaker(m[1]);
      continue;
    }
    if (curRole !== null) buf.push(line);
  }
  flush();
  return turns;
}

// Result of an import pass over a domain's _threads dir.
export interface ThreadImportResult {
  imported: string[]; // session ids (slugs) newly converted to JSONL
  skipped: string[]; // slugs that already had a .jsonl (left untouched)
}

// Convert any desktop-style <slug>.md threads in <domain>/_threads/ that lack
// a sibling <slug>.jsonl. Idempotent and safe to call lazily before reading a
// thread. Returns which slugs were imported vs skipped.
export function importDesktopThreads(
  vaultPath: string,
  domain: string,
): ThreadImportResult {
  const result: ThreadImportResult = { imported: [], skipped: [] };
  const dir = threadsDir(vaultPath, domain);
  if (!existsSync(dir)) return result;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -".md".length);
    if (!slug) continue;
    const jsonlPath = threadJsonlPath(vaultPath, domain, slug);
    if (existsSync(jsonlPath)) {
      result.skipped.push(slug);
      continue;
    }
    let md = "";
    try {
      md = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const turns = parseDesktopThreadMarkdown(md);
    if (turns.length === 0) {
      result.skipped.push(slug);
      continue;
    }
    for (const turn of turns) {
      writeThreadTurn(vaultPath, domain, slug, turn);
    }
    result.imported.push(slug);
  }
  return result;
}
