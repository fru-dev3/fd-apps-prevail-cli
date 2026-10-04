// The read-only readers behind knowledge sources (knowledge-sources.ts):
// a local folder, a database (SQLite file or Postgres URL) and a web page or
// feed. Each one reads and never writes, enforced here in code:
//
//   folder    every path is resolved to its realpath and must stay inside the
//             realpath of the added folder; symlinks are never followed while
//             walking; only allowlisted text types are read; secret stores
//             (~/.ssh, ~/.prevail, keychains) can never be added.
//   database  SQLite opens with readonly + query_only; Postgres runs every
//             statement in a READ ONLY transaction with a statement timeout.
//             Only one SELECT (or WITH ... SELECT) statement is accepted, with
//             no comments, and every result is capped at a row limit.
//   web       GET only, to the source's own hosts (redirects included).

import { existsSync, lstatSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";

// ── Folder ───────────────────────────────────────────────────────────────────

/** The text types a folder source reads. Anything else is never opened. */
export const FOLDER_TYPES = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".html", ".htm", ".xml", ".org", ".rst", ".log"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"]);
const MAX_WALK = 5000;
const MAX_DEPTH = 8;
export const FILE_CAP = 20_000;

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Places a folder source may never be: the root, the home folder itself and
 *  the secret stores. A child of home (Documents, a project) is fine. */
function forbiddenFolder(real: string): string | null {
  const home = (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })();
  if (real === "/" || real === home) return "that folder is too broad; add the folder that holds the documents";
  for (const s of [".ssh", ".gnupg", ".aws", ".prevail", ".config/gcloud", "Library/Keychains", "Library/Cookies"]) {
    const p = join(home, s);
    if (real === p || real.startsWith(p + sep)) return "that folder holds secrets and can never be a source";
  }
  return null;
}

/** The realpath of a folder a source may read, or an error. */
export function realFolder(raw: string): { path: string } | { error: string } {
  const p = resolve(expandHome(raw.trim()));
  let real: string;
  try { real = realpathSync(p); } catch { return { error: `no folder at ${p}` }; }
  try { if (!statSync(real).isDirectory()) return { error: `${p} is not a folder` }; } catch { return { error: `cannot read ${p}` }; }
  const bad = forbiddenFolder(real);
  return bad ? { error: bad } : { path: real };
}

export interface FolderFile { rel: string; size: number; mtime: number }

/** The readable files under a folder, newest first. Symlinks and dot files are skipped. */
export function walkFolder(root: string, max = MAX_WALK): { files: FolderFile[]; truncated: boolean } {
  const files: FolderFile[] = [];
  let truncated = false;
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || truncated) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const abs = join(dir, n);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) visit(abs, depth + 1); continue; }
      if (!st.isFile() || !FOLDER_TYPES.has(extname(n).toLowerCase())) continue;
      if (files.length >= max) { truncated = true; return; }
      files.push({ rel: abs.slice(root.length + 1), size: st.size, mtime: st.mtimeMs });
    }
  };
  visit(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return { files, truncated };
}

/** A file inside one of the allowed roots, by its realpath, or an error. */
export function confinedFile(root: string, rel: string): { path: string } | { error: string } {
  if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) return { error: "give a file path inside the folder" };
  const want = resolve(root, rel.trim().replace(/^\/+/, ""));
  let real: string;
  try { real = realpathSync(want); } catch { return { error: `no file ${rel}` }; }
  if (!real.startsWith(root + sep)) return { error: `${rel} is outside the folder` };
  if (!FOLDER_TYPES.has(extname(real).toLowerCase())) return { error: `${extname(real) || "that type"} files are not read; text types only` };
  try { if (!statSync(real).isFile()) return { error: `${rel} is not a file` }; } catch { return { error: `cannot read ${rel}` }; }
  return { path: real };
}

export function readFolderFile(root: string, rel: string, cap = FILE_CAP): { text: string; truncated: boolean } | { error: string } {
  const f = confinedFile(root, rel);
  if ("error" in f) return f;
  try {
    const text = readFileSync(f.path, "utf8");
    return { text: text.slice(0, cap), truncated: text.length > cap };
  } catch (e) { return { error: (e as Error).message }; }
}

export function probeFolder(root: string): { ok: boolean; files: number; types: Record<string, number>; truncated: boolean; error?: string } {
  const { files, truncated } = walkFolder(root);
  const types: Record<string, number> = {};
  for (const f of files) { const e = extname(f.rel).toLowerCase(); types[e] = (types[e] ?? 0) + 1; }
  return { ok: files.length > 0, files: files.length, types, truncated, ...(files.length ? {} : { error: "no readable files (text types only)" }) };
}

// ── Database ─────────────────────────────────────────────────────────────────

export type DbEngine = "sqlite" | "postgres";
export const ROW_CAP = 200;
const DB_TIMEOUT_MS = 10_000;

/** A database location, with any password split off (it goes to the keychain). */
export function parseDbLocation(raw: string): { engine: DbEngine; location: string; password?: string } | { error: string } {
  const s = raw.trim();
  if (/^postgres(ql)?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return { error: "not a Postgres URL" }; }
    for (const k of u.searchParams.keys()) if (/pass|secret|token|key/i.test(k)) return { error: `the URL carries a "${k}" parameter; give the password separately so it goes to the keychain` };
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    u.password = "";
    if (!u.hostname || u.pathname.length < 2) return { error: "a Postgres URL needs a host and a database name" };
    return { engine: "postgres", location: u.href, ...(password ? { password } : {}) };
  }
  const p = resolve(expandHome(s.replace(/^sqlite:(\/\/)?/i, "")));
  let real: string;
  try { real = realpathSync(p); } catch { return { error: `no database file at ${p}` }; }
  try {
    const fd = openSync(real, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    closeSync(fd);
    if (head.toString("latin1") !== "SQLite format 3\0") return { error: `${basename(real)} is not a SQLite database` };
  } catch { return { error: `cannot read ${p}` }; }
  return { engine: "sqlite", location: real };
}

/** The one statement a database source runs, or why it is refused. Only a
 *  single SELECT or WITH ... SELECT, no comments, no write words. The
 *  connection is read-only as well; this is the second lock. */
export function checkSelect(sql: string): { sql: string } | { error: string } {
  let s = String(sql ?? "").trim().replace(/;\s*$/, "");
  if (!s) return { error: "give a SELECT statement" };
  if (s.length > 4000) return { error: "the statement is too long" };
  if (/--|\/\*|\*\//.test(s)) return { error: "comments are not allowed in a query" };
  // Words inside string literals do not count; everything else must be read words.
  const bare = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (bare.includes(";")) return { error: "one statement only" };
  if (!/^(select|with)\b/i.test(bare)) return { error: "only SELECT statements are allowed" };
  // Write words (a WITH can lead into INSERT, UPDATE or DELETE), then the
  // functions that reach the server's files or other sessions.
  const bad = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|attach|detach|pragma|vacuum|reindex|copy|execute|into)\b/i.exec(bare)
    ?? /\b(pg_\w*file|pg_ls_\w+|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|pg_sleep\w*|nextval|setval|load_extension|readfile|writefile)\s*\(/i.exec(bare);
  if (bad) return { error: `"${bad[1]}" is not allowed; read-only SELECT only` };
  s = s.replace(/\s+/g, " ");
  return { sql: s };
}

export interface QueryResult { columns: string[]; rows: unknown[][]; truncated: boolean }

async function sqliteQuery(path: string, sql: string, cap: number): Promise<QueryResult> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const stmt = db.prepare(`SELECT * FROM (${sql}) LIMIT ${cap + 1}`);
    const rows = stmt.values() as unknown[][];
    const columns = stmt.columnNames;
    return { columns, rows: rows.slice(0, cap), truncated: rows.length > cap };
  } finally { db.close(); }
}

async function postgresQuery(url: string, password: string | undefined, sql: string, cap: number): Promise<QueryResult> {
  const { SQL } = await import("bun");
  const u = new URL(url);
  if (password) u.password = encodeURIComponent(password);
  const db = new SQL(u.href, { max: 1, idleTimeout: 5, connectionTimeout: 10 });
  try {
    const rows = await db.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${DB_TIMEOUT_MS}`);
      return tx.unsafe(`SELECT * FROM (${sql}) AS q LIMIT ${cap + 1}`);
    }) as Record<string, unknown>[];
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.slice(0, cap).map((r) => columns.map((c) => r[c])), truncated: rows.length > cap };
  } finally { await db.close().catch(() => {}); }
}

/** Run one checked SELECT, read-only, capped at `cap` rows. */
export async function dbQuery(engine: DbEngine, location: string, sql: string, opts: { password?: string; cap?: number } = {}): Promise<QueryResult> {
  const c = checkSelect(sql);
  if ("error" in c) throw new Error(c.error);
  const cap = Math.max(1, Math.min(opts.cap ?? ROW_CAP, ROW_CAP));
  return engine === "sqlite" ? sqliteQuery(location, c.sql, cap) : postgresQuery(location, opts.password, c.sql, cap);
}

/** The tables (and views) with their columns. Read-only catalog queries. */
export async function dbTables(engine: DbEngine, location: string, opts: { password?: string } = {}): Promise<{ name: string; columns: string[] }[]> {
  if (engine === "sqlite") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(location, { readonly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 100").values() as unknown[][]).map((r) => String(r[0]));
      return names.map((n) => ({ name: n, columns: (db.prepare(`SELECT name FROM pragma_table_info(?)`).values(n) as unknown[][]).map((r) => String(r[0])) }));
    } finally { db.close(); }
  }
  const r = await dbQuery(engine, location, "SELECT table_schema || '.' || table_name AS t, string_agg(column_name, ',' ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY 1 ORDER BY 1", { ...opts, cap: 100 });
  return r.rows.map((row) => ({ name: String(row[0]), columns: String(row[1] ?? "").split(",").filter(Boolean) }));
}

// ── Web ──────────────────────────────────────────────────────────────────────

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const PAGE_CAP = 400_000;

export interface PageProbe { status: number | null; title?: string; isFeed: boolean; feed?: string; mcp?: string }

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();

const looksLikeFeed = (type: string, body: string) => /(rss|atom)\+xml|application\/xml|text\/xml/i.test(type) || /^\s*(<\?xml[^>]*>\s*)?<(rss|feed)\b/i.test(body);

/** A page's title, whether it is a feed, the feed it links, and an MCP
 *  endpoint it advertises (a line like "MCP: https://host/mcp"). */
export async function probePage(url: string, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<PageProbe> {
  const f = opts.fetch ?? fetch;
  try {
    const r = await f(url, { method: "GET", headers: { accept: "text/html, application/rss+xml, application/atom+xml, */*" }, redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const type = r.headers.get("content-type") ?? "";
    const body = r.ok ? (await r.text()).slice(0, PAGE_CAP) : "";
    if (!r.ok) await r.body?.cancel().catch(() => {});
    const out: PageProbe = { status: r.status, isFeed: false };
    if (!body) return out;
    if (looksLikeFeed(type, body)) {
      out.isFeed = true;
      out.title = parseFeed(body).title;
      return out;
    }
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    if (t) out.title = decode(t).replace(/\s+/g, " ").slice(0, 120);
    const link = /<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i.exec(body)?.[0];
    const href = link ? /href=["']([^"']+)["']/i.exec(link)?.[1] : undefined;
    if (href) { try { out.feed = new URL(decode(href), url).href; } catch { /* bad href */ } }
    const mcp = /\bMCP\b[^\n<]{0,40}?(https:\/\/[^\s"'<>)]+\/mcp)\b/i.exec(body)?.[1];
    if (mcp) out.mcp = mcp;
    return out;
  } catch { return { status: null, isFeed: false }; }
}

export interface FeedItem { title: string; link?: string; date?: string }

/** RSS 2.0 and Atom items, newest as listed. A regex reader, enough for titles, links and dates. */
export function parseFeed(xml: string, max = 20): { title?: string; items: FeedItem[] } {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks.slice(0, max)) {
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(b)?.[1] ?? "");
    const link = /<link[^>]*href=["']([^"']+)["']/i.exec(b)?.[1] ?? /<link>([\s\S]*?)<\/link>/i.exec(b)?.[1];
    const date = /<(pubDate|updated|published|dc:date)>([\s\S]*?)<\/\1>/i.exec(b)?.[2];
    if (title) items.push({ title: title.slice(0, 200), ...(link ? { link: decode(link) } : {}), ...(date ? { date: decode(date) } : {}) });
  }
  const head = xml.replace(/<(item|entry)\b[\s\S]*$/i, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return { ...(title ? { title: decode(title).slice(0, 120) } : {}), items };
}

/** Readable text from HTML: scripts, styles and tags out, whitespace folded. */
export function htmlText(html: string, cap: number): string {
  return decode(html.replace(/<(script|style|noscript|svg|nav|footer)\b[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, cap);
}

/** GET one URL on an allowed host and return readable text (a feed as a list). */
export async function readWeb(url: string, hosts: string[], opts: { fetch?: Fetch; timeoutMs?: number; cap?: number; signal?: AbortSignal } = {}): Promise<{ text: string; url: string }> {
  const f = opts.fetch ?? fetch;
  const cap = opts.cap ?? FILE_CAP;
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("https only");
  if (!hosts.includes(u.host.toLowerCase())) throw new Error(`${u.host} is not this source's site`);
  const r = await f(u.href, { method: "GET", headers: { accept: "text/html, text/plain, application/json, application/rss+xml, application/atom+xml, */*" }, redirect: "follow", signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 10_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  const final = (() => { try { return new URL(r.url || u.href); } catch { return u; } })();
  if (!hosts.includes(final.host.toLowerCase())) { await r.body?.cancel().catch(() => {}); throw new Error(`redirected off the source's site to ${final.host}`); }
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`HTTP ${r.status}`); }
  const type = r.headers.get("content-type") ?? "";
  const body = (await r.text()).slice(0, PAGE_CAP);
  if (looksLikeFeed(type, body)) {
    const feed = parseFeed(body);
    return { url: final.href, text: [feed.title ? `Feed: ${feed.title}` : "", ...feed.items.map((i) => `- ${i.date ? `${i.date}: ` : ""}${i.title}${i.link ? ` (${i.link})` : ""}`)].filter(Boolean).join("\n").slice(0, cap) };
  }
  return { url: final.href, text: /html/i.test(type) || /^\s*</.test(body) ? htmlText(body, cap) : body.slice(0, cap) };
}

/** Whether a path names an existing directory (after ~ expansion). */
export function isDirPath(raw: string): boolean {
  try { return statSync(resolve(expandHome(raw.trim()))).isDirectory(); } catch { return false; }
}
export const pathExists = (raw: string) => existsSync(resolve(expandHome(raw.trim())));
