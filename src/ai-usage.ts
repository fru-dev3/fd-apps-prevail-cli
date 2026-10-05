// AI usage: every AI tool's own local records, read into one honest ledger.
//
// Each adapter reads one tool's files on THIS machine (CLI and local files
// only: never a sign-in token, never a provider site, never an app's
// encrypted store) and turns them into counts. No prompt, response or tool
// output is kept; the only strings stored are the model id, the project
// folder and the session id, each passed through a secret scan.
//
//   claude       ~/.claude/projects/**.jsonl (message.usage, deduped on
//                message.id + requestId, like ccusage), the per-session
//                cost-state line (Claude's own cost figure), Claude.app's
//                Cowork sessions (same transcript format), and
//                plan-usage-history.json (plan quota)
//   codex        ~/.codex/sessions/**/rollout-*.jsonl (token_usage_record per
//                response, else token_count's last usage; rate limits)
//   opencode     opencode.db (tokens and the cost it reports)
//   hermes       ~/.hermes/state.db sessions (tokens, its cost estimate)
//   antigravity  conversation_summaries.db (sessions, project; no tokens:
//                its conversation DBs are protobuf with no known shape)
//   cursor       agent transcripts (sessions) and ai-code-tracking.db (AI vs
//                human lines per commit); no tokens
//   aionui       aionui-backend.db (messages a day)
//   wispr        Wispr Flow's flow.sqlite InstructHistory (voice commands)
//   glyph        ~/.local/state/glyph/sessions.tsv (sessions per tool)
//
// Output, per host and per month, rewritten each scan for the current and
// the previous month (older months are frozen, so a transcript Claude Code
// has since deleted never takes its tokens with it):
//   build/_meta/events/<tool>/<YYYY-MM>.<host>.jsonl   one line per day,
//     tool, model and project: { ts, src, kind, n, model, project, host,
//     tier, attrs: { in, out, cache_read, cache_write, cache_write_1h,
//     reasoning, sessions, usd_api, usd_reported } }
//   build/_meta/apps/adapters.<host>.json   per tool: last read, records,
//     versions seen, shape (ok | unknown), and the tools seen with no
//     adapter yet
// Per-host files are only written by their own host, so sync never
// conflicts; every reader merges all hosts. The per-file read cache is
// machine-local (~/.prevail/cache/ai-usage/), regenerable from the files.
//
// Three cost numbers: API-equivalent (tokens x the dated price snapshot in
// ai-prices.json, cache priced apart, reasoning inside output), what the tool
// itself reported where it does (Claude's cost-state, opencode, hermes), and
// what is actually paid (the `cost` on the vendor's app record, set by
// `prevail ai plan`). Value multiple = API-equivalent / paid.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { hostSlug } from "./capture.ts";
import { productDir, productWriteDir, runtimePath } from "./path-safety.ts";
import PRICES from "./ai-prices.json" with { type: "json" };
import { redactSecrets } from "./secret-redact.ts";

// ── Prices ──────────────────────────────────────────────────────────────────

export interface Price { in: number; out: number; cr?: number; cw?: number; cw1h?: number }
const MODELS = (PRICES as { models: Record<string, Price> }).models;
export const PRICE_SNAPSHOT = (PRICES as { fetched: string }).fetched;

/** Price for a model id: exact, then without a date or effort suffix, then the longest known prefix. */
export function priceFor(model: string): Price | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  if (MODELS[m]) return MODELS[m]!;
  const bare = m.replace(/-\d{8}$/, "").replace(/-(low|medium|high|xhigh|minimal)$/, "");
  if (MODELS[bare]) return MODELS[bare]!;
  let best: string | null = null;
  for (const k of Object.keys(MODELS)) if (bare.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? MODELS[best]! : null;
}

export interface Tokens { in: number; out: number; cr: number; cw: number; cw1h: number; reasoning: number }

/** API-equivalent USD for one record's tokens, or null when the model is not priced. */
export function apiUsd(model: string, t: Tokens): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const cr = p.cr ?? p.in * 0.1;
  const cw = p.cw ?? p.in * 1.25;
  const cw1h = p.cw1h ?? cw;
  return (t.in * p.in + t.out * p.out + t.cr * cr + t.cw * cw + t.cw1h * cw1h) / 1e6;
}

// ── Records ─────────────────────────────────────────────────────────────────

/** One usage record: a model response (tokens), a session, a prompt, a quota sample or a commit. */
export interface AiRecord {
  k: string;               // dedupe key (hashed)
  ts: number;              // epoch ms
  kind: "ai.tokens" | "ai.session" | "ai.prompt" | "ai.quota" | "ai.code" | "ai.cost_reported";
  model?: string;
  project?: string;
  session?: string;
  t?: Tokens;
  usd?: number;            // a cost the tool itself reported
  n?: number;              // a count (prompts, lines)
  q?: Record<string, number | string>; // quota sample or code split
  surface?: string;        // claude: cli | cowork
}

const h = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// Anything that looks like a credential never lands in the vault (the shared
// masker; a field holding one is dropped whole).
export function scrub(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return redactSecrets(s).count ? "[redacted]" : s;
}

// ── Roots (overridable for tests) ───────────────────────────────────────────

export interface Roots {
  home: string;
  appSupport: string;
  cacheDir: string;
}
export function defaultRoots(): Roots {
  const home = process.env.PREVAIL_AI_HOME || homedir();
  return {
    home,
    appSupport: join(home, "Library", "Application Support"),
    cacheDir: join(process.env.PREVAIL_CONFIG_DIR || join(homedir(), ".prevail"), "cache", "ai-usage"),
  };
}

// ── Per-file read cache ─────────────────────────────────────────────────────

interface FileState { size: number; mtime: number; offset: number; recs: AiRecord[]; version?: string; shape?: "ok" | "unknown"; meta?: Record<string, string> }
interface ToolCache { v: number; files: Record<string, FileState> }
const CACHE_V = 3; // 3: a session's project is its Claude Code project folder

function loadCache(roots: Roots, tool: string): ToolCache {
  try {
    const c = JSON.parse(readFileSync(join(roots.cacheDir, `${tool}.json`), "utf8")) as ToolCache;
    if (c.v === CACHE_V && c.files) return c;
  } catch { /* fresh */ }
  return { v: CACHE_V, files: {} };
}
function saveCache(roots: Roots, tool: string, c: ToolCache): void {
  mkdirSync(roots.cacheDir, { recursive: true });
  const p = join(roots.cacheDir, `${tool}.json`);
  writeFileSync(`${p}.tmp`, JSON.stringify(c));
  renameSync(`${p}.tmp`, p);
}

function walk(root: string, match: (name: string) => boolean, depth = 8, out: string[] = []): string[] {
  if (depth < 0) return out;
  let es: import("node:fs").Dirent[] = [];
  try { es = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, match, depth - 1, out);
    else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

/** Read the bytes of `path` from `offset` up to its last newline; returns the text and the new offset. */
function readFrom(path: string, offset: number, size: number): { text: string; next: number } {
  if (size <= offset) return { text: "", next: offset };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    const last = buf.lastIndexOf(0x0a, got - 1);
    if (last < 0) return { text: "", next: offset };
    return { text: buf.subarray(0, last + 1).toString("utf8"), next: offset + last + 1 };
  } finally { closeSync(fd); }
}

/**
 * Incremental JSONL scan: only new bytes of grown files are parsed; a file
 * that shrank (rewritten) is read again from the start. Files that vanished
 * keep their records (Claude Code deletes transcripts after 30 days; the
 * tokens were already read).
 */
function scanJsonl(cache: ToolCache, files: string[], parse: (text: string, st: FileState, path: string) => void): number {
  let read = 0;
  for (const p of files) {
    let s: import("node:fs").Stats;
    try { s = statSync(p); } catch { continue; }
    let st = cache.files[p];
    if (st && st.size === s.size && st.mtime === s.mtimeMs) continue;
    if (!st || s.size < st.offset) st = cache.files[p] = { size: 0, mtime: 0, offset: 0, recs: [] };
    const { text, next } = readFrom(p, st.offset, s.size);
    if (text) parse(text, st, p);
    st.offset = next; st.size = s.size; st.mtime = s.mtimeMs;
    read++;
  }
  return read;
}

/** Open a SQLite file read-only from a private copy (with its WAL), so a live app is never touched. */
function withDb<T>(path: string, fn: (db: Database) => T): T | null {
  if (!existsSync(path)) return null;
  const tmp = join(tmpdir(), `prevail-ai-${process.pid}-${basename(path)}`);
  try {
    copyFileSync(path, tmp);
    for (const x of ["-wal", "-shm"]) { if (existsSync(path + x)) copyFileSync(path + x, tmp + x); else rmSync(tmp + x, { force: true }); }
    // Our own private copy: opened writable because a WAL database cannot be
    // opened read-only without its shared-memory file. The original is never opened.
    const db = new Database(tmp);
    try { return fn(db); } finally { db.close(); }
  } catch { return null; } finally {
    for (const x of ["", "-wal", "-shm"]) rmSync(tmp + x, { force: true });
  }
}

// ── Adapters ────────────────────────────────────────────────────────────────

export interface AdapterResult {
  tool: string;
  records: AiRecord[];
  health: { present: boolean; files: number; read: number; versions: string[]; shape: "ok" | "unknown" | "absent"; note?: string };
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** A SQLite datetime ("2026-10-02 10:30:05.23+00:00", "... +00:00") or epoch number, as epoch ms. */
export function sqlTime(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v ?? "").trim().replace(" ", "T").replace(/\s*([+-]\d\d:\d\d)$/, "$1");
  return Date.parse(s) || 0;
}

// Claude Code files each session under projects/<folder>, the launch folder
// with every non-alphanumeric character turned into "-". That folder is the
// project (as ccusage counts it): subagent transcripts and sessions that
// changed directory still belong to it.
const encodeFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function claudeLines(text: string, st: FileState, surface: string, folder: string): void {
  for (const line of text.split("\n")) {
    if (!line || (!line.includes('"usage"') && !line.includes('"cost-state"'))) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.version === "string") st.version = e.version;
    if (typeof e.cwd === "string" && e.cwd && !(st.meta ??= {}).cwd && encodeFolder(e.cwd) === folder) st.meta.cwd = e.cwd;
    if (e.type === "cost-state") {
      const usd = num(e.totalCostUSD);
      const sid = String(e.sessionId ?? "");
      // The line is rewritten as a session goes on: one record per session, the latest wins.
      st.recs = st.recs.filter((r) => !(r.kind === "ai.cost_reported" && r.session === sid));
      st.recs.push({ k: h(`cost:${sid}`), ts: Date.parse(String(e.startTime ?? "")) || 0, kind: "ai.cost_reported", session: sid, usd, surface });
      continue;
    }
    if (e.type !== "assistant") continue;
    const m = e.message as Record<string, unknown> | undefined;
    const u = m?.usage as Record<string, unknown> | undefined;
    if (!m || !u) continue;
    if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") { st.shape = "unknown"; continue; }
    if (st.shape !== "unknown") st.shape = "ok";
    const cc = u.cache_creation as Record<string, unknown> | undefined;
    const cwAll = num(u.cache_creation_input_tokens);
    const cw1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
    const det = u.output_tokens_details as Record<string, unknown> | undefined;
    st.recs.push({
      k: h(`${String(m.id ?? "")}:${String(e.requestId ?? "")}`),
      ts: Date.parse(String(e.timestamp ?? "")) || 0,
      kind: "ai.tokens",
      model: String(m.model ?? ""),
      project: scrub(st.meta?.cwd ?? `@${folder}`),
      session: scrub(String(e.sessionId ?? "")),
      t: { in: num(u.input_tokens), out: num(u.output_tokens), cr: num(u.cache_read_input_tokens), cw: Math.max(0, cwAll - cw1h), cw1h, reasoning: det ? num(det.thinking_tokens) : 0 },
      surface,
    });
  }
}

export function claudeAdapter(roots: Roots, cache: ToolCache): AdapterResult {
  const cli = join(roots.home, ".claude", "projects");
  const cowork = join(roots.appSupport, "Claude", "local-agent-mode-sessions");
  const cliFiles = walk(cli, (n) => n.endsWith(".jsonl"), 3);
  const coworkFiles = walk(cowork, (n) => n.endsWith(".jsonl"), 9).filter((p) => p.includes(`${join(".claude", "projects")}`));
  const present = existsSync(cli) || existsSync(cowork);
  const folderOf = (p: string) => { const parts = p.split("/"); const i = parts.lastIndexOf("projects"); return i >= 0 ? parts[i + 1] ?? "" : ""; };
  let read = scanJsonl(cache, cliFiles, (text, st, p) => claudeLines(text, st, "cli", folderOf(p)));
  read += scanJsonl(cache, coworkFiles, (text, st, p) => claudeLines(text, st, "cowork", folderOf(p)));
  // A project folder whose own path never appeared in a file (a subagent's
  // transcript, say) takes the path some other file in that folder showed.
  const known = new Map<string, string>();
  for (const st of Object.values(cache.files)) if (st.meta?.cwd) known.set(encodeFolder(st.meta.cwd), st.meta.cwd);
  const records: AiRecord[] = [];
  const versions = new Set<string>();
  let unknown = 0;
  for (const st of Object.values(cache.files)) {
    for (const r of st.recs) {
      if (r.project?.startsWith("@")) { const f = r.project.slice(1); records.push({ ...r, project: known.get(f) ?? f }); }
      else records.push(r);
    }
    if (st.version) versions.add(st.version);
    if (st.shape === "unknown") unknown++;
  }
  // Plan quota: the app's own 5-hour and 7-day usage samples.
  const plan = join(roots.appSupport, "Claude", "plan-usage-history.json");
  try {
    const d = JSON.parse(readFileSync(plan, "utf8")) as { samples?: { t: number; u?: Record<string, number> }[] };
    for (const s of d.samples ?? []) {
      if (typeof s.t !== "number" || !s.u) continue;
      records.push({ k: h(`plan:${s.t}`), ts: s.t, kind: "ai.quota", q: { five_hour_pct: num(s.u.fh), seven_day_pct: num(s.u.sd) } });
    }
  } catch { /* no Claude.app */ }
  return {
    tool: "claude", records,
    health: { present, files: cliFiles.length + coworkFiles.length, read, versions: [...versions].sort().slice(-5), shape: !present ? "absent" : unknown ? "unknown" : "ok", ...(unknown ? { note: `${unknown} transcript(s) had usage in a shape this reader does not know` } : {}) },
  };
}

function codexLines(text: string, st: FileState): void {
  const meta = (st.meta ??= {});
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const ts = Date.parse(String(e.timestamp ?? "")) || 0;
    if (e.type === "session_meta") {
      meta.cwd = String(p.cwd ?? ""); meta.session = String(p.id ?? p.session_id ?? "");
      if (typeof p.cli_version === "string") st.version = p.cli_version;
    } else if (e.type === "turn_context") {
      if (typeof p.model === "string") meta.model = p.model;
      if (typeof p.cwd === "string") meta.cwd = p.cwd;
    } else if (e.type === "token_usage_record") {
      const u = p.usage as Record<string, unknown> | undefined;
      if (!u || typeof u.input_tokens !== "number") { st.shape = "unknown"; continue; }
      meta.records = "1";
      st.shape = "ok";
      st.recs.push(codexRec(`${String(p.response_id ?? "")}:${String(p.turn_id ?? "")}`, ts, meta, u));
    } else if (e.type === "event_msg" && p.type === "token_count") {
      const info = p.info as Record<string, unknown> | null;
      const rl = p.rate_limits as Record<string, unknown> | undefined;
      if (rl) {
        const pr = rl.primary as Record<string, unknown> | undefined;
        const se = rl.secondary as Record<string, unknown> | undefined;
        st.recs.push({ k: h(`q:${st.offset}:${ts}`), ts, kind: "ai.quota", q: { five_hour_pct: num(pr?.used_percent), seven_day_pct: num(se?.used_percent), plan: String(rl.plan_type ?? "") } });
      }
      // Older rollouts have no token_usage_record: use each count's `last`
      // usage (never the cumulative total). Newer ones count records only.
      const last = info?.last_token_usage as Record<string, unknown> | undefined;
      if (last && meta.records !== "1" && typeof last.input_tokens === "number") {
        st.shape = st.shape ?? "ok";
        st.recs.push(codexRec(`tc:${meta.session}:${ts}:${num(last.total_tokens)}`, ts, meta, last));
      }
    }
  }
  // A file that switched to records part way keeps only one kind for its turns.
  if (meta.records === "1") st.recs = st.recs.filter((r) => r.kind !== "ai.tokens" || !r.k.startsWith("tc"));
}
function codexRec(key: string, ts: number, meta: Record<string, string>, u: Record<string, unknown>): AiRecord {
  const input = num(u.input_tokens), cached = num(u.cached_input_tokens);
  return {
    k: key.startsWith("tc:") ? `tc${h(key)}` : h(key), ts, kind: "ai.tokens",
    model: meta.model ?? "", project: scrub(meta.cwd ?? ""), session: scrub(meta.session ?? ""),
    // OpenAI counts cached input inside input_tokens; reasoning inside output.
    t: { in: Math.max(0, input - cached), out: num(u.output_tokens), cr: cached, cw: num(u.cache_write_input_tokens), cw1h: 0, reasoning: num(u.reasoning_output_tokens) },
  };
}

export function codexAdapter(roots: Roots, cache: ToolCache): AdapterResult {
  const dir = join(roots.home, ".codex", "sessions");
  const all = walk(dir, (n) => n.startsWith("rollout-"), 5);
  const files = all.filter((p) => p.endsWith(".jsonl"));
  const compressed = all.length - files.length;
  // A rewritten file starts over; a file's own records are re-derived from it.
  const read = scanJsonl(cache, files, (text, st) => codexLines(text, st));
  const records: AiRecord[] = [];
  const versions = new Set<string>();
  for (const st of Object.values(cache.files)) { records.push(...st.recs); if (st.version) versions.add(st.version); }
  const present = existsSync(dir);
  return {
    tool: "codex", records,
    health: { present, files: files.length, read, versions: [...versions].sort().slice(-5), shape: present ? "ok" : "absent", ...(compressed ? { note: `${compressed} compressed session file(s) not read yet` } : {}) },
  };
}

export function opencodeAdapter(roots: Roots): AdapterResult {
  const p = join(roots.home, ".local", "share", "opencode", "opencode.db");
  const records: AiRecord[] = [];
  const ok = withDb(p, (db) => {
    for (const row of db.query("select id, data from message").all() as { id: string; data: string }[]) {
      let d: Record<string, unknown>;
      try { d = JSON.parse(row.data); } catch { continue; }
      if (d.role !== "assistant") continue;
      const t = d.tokens as Record<string, unknown> | undefined;
      const c = (t?.cache ?? {}) as Record<string, unknown>;
      const time = d.time as Record<string, unknown> | undefined;
      const path = d.path as Record<string, unknown> | undefined;
      records.push({
        k: h(`oc:${row.id}`), ts: num(time?.created), kind: "ai.tokens", model: String(d.modelID ?? ""),
        project: scrub(String(path?.cwd ?? "")), session: scrub(String(d.sessionID ?? "")),
        t: { in: num(t?.input), out: num(t?.output), cr: num(c.read), cw: num(c.write), cw1h: 0, reasoning: num(t?.reasoning) },
        usd: num(d.cost),
      });
    }
    return true;
  });
  return { tool: "opencode", records, health: { present: existsSync(p), files: existsSync(p) ? 1 : 0, read: ok ? 1 : 0, versions: [], shape: !existsSync(p) ? "absent" : ok ? "ok" : "unknown" } };
}

export function hermesAdapter(roots: Roots): AdapterResult {
  const p = join(roots.home, ".hermes", "state.db");
  const records: AiRecord[] = [];
  const ok = withDb(p, (db) => {
    for (const r of db.query("select id, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, estimated_cost_usd, actual_cost_usd from sessions").all() as Record<string, unknown>[]) {
      const ts = Math.round(num(r.started_at) * 1000);
      records.push({ k: h(`hs:${r.id}`), ts, kind: "ai.session", session: scrub(String(r.id)), project: scrub(String(r.cwd ?? "")), n: 1 });
      records.push({
        k: h(`ht:${r.id}`), ts, kind: "ai.tokens", model: String(r.model ?? ""), project: scrub(String(r.cwd ?? "")), session: scrub(String(r.id)),
        t: { in: num(r.input_tokens), out: num(r.output_tokens), cr: num(r.cache_read_tokens), cw: num(r.cache_write_tokens), cw1h: 0, reasoning: num(r.reasoning_tokens) },
        usd: num(r.actual_cost_usd) || num(r.estimated_cost_usd),
      });
    }
    return true;
  });
  return { tool: "hermes", records, health: { present: existsSync(p), files: existsSync(p) ? 1 : 0, read: ok ? 1 : 0, versions: [], shape: !existsSync(p) ? "absent" : ok ? "ok" : "unknown" } };
}

export function antigravityAdapter(roots: Roots): AdapterResult {
  const records: AiRecord[] = [];
  let present = false, ok = false;
  for (const dir of ["antigravity-cli", "antigravity"]) {
    const p = join(roots.home, ".gemini", dir, "conversation_summaries.db");
    if (!existsSync(p)) continue;
    present = true;
    ok = !!withDb(p, (db) => {
      for (const r of db.query("select conversation_id, workspace_uris, last_user_input_time, last_modified_time from conversation_summaries").all() as Record<string, unknown>[]) {
        // An unset time is stored as year 1; fall back to the last change.
        const asked = sqlTime(r.last_user_input_time);
        const ts = asked > Date.UTC(2000, 0, 1) ? asked : sqlTime(r.last_modified_time);
        let ws = "";
        try { ws = String((JSON.parse(String(r.workspace_uris ?? "[]")) as string[])[0] ?? "").replace(/^file:\/\//, ""); } catch { /* none */ }
        records.push({ k: h(`ag:${r.conversation_id}`), ts, kind: "ai.session", project: scrub(decodeURIComponent(ws)), session: scrub(String(r.conversation_id)), n: 1, surface: dir === "antigravity" ? "app" : "cli" });
      }
      return true;
    }) || ok;
  }
  return { tool: "antigravity", records, health: { present, files: records.length, read: ok ? 1 : 0, versions: [], shape: !present ? "absent" : ok ? "ok" : "unknown", note: "sessions only: token counts sit in protobuf conversation DBs with no known shape" } };
}

export function cursorAdapter(roots: Roots): AdapterResult {
  const records: AiRecord[] = [];
  const base = join(roots.home, ".cursor");
  const transcripts = walk(join(base, "projects"), (n) => n.endsWith(".jsonl"), 4).filter((p) => p.includes("agent-transcripts"));
  for (const p of transcripts) {
    try { const s = statSync(p); records.push({ k: h(`cu:${p}`), ts: s.mtimeMs, kind: "ai.session", session: scrub(basename(p, ".jsonl")), project: scrub(basename(dirname(dirname(p)))), n: 1 }); } catch { /* gone */ }
  }
  const db = join(base, "ai-tracking", "ai-code-tracking.db");
  const ok = withDb(db, (d) => {
    for (const r of d.query("select commitHash, scoredAt, linesAdded, tabLinesAdded, composerLinesAdded, humanLinesAdded from scored_commits").all() as Record<string, unknown>[]) {
      records.push({ k: h(`cc:${r.commitHash}`), ts: num(r.scoredAt), kind: "ai.code", q: { ai_lines: num(r.tabLinesAdded) + num(r.composerLinesAdded), human_lines: num(r.humanLinesAdded), lines: num(r.linesAdded) } });
    }
    return true;
  });
  const present = existsSync(base);
  return { tool: "cursor", records, health: { present, files: transcripts.length + (existsSync(db) ? 1 : 0), read: ok ? 1 : 0, versions: [], shape: !present ? "absent" : "ok", note: "sessions and AI vs human lines; Cursor keeps no reliable token counts" } };
}

export function aionuiAdapter(roots: Roots): AdapterResult {
  const p = join(roots.appSupport, "AionUi", "aionui", "aionui-backend.db");
  const records: AiRecord[] = [];
  let note: string | undefined;
  const ok = withDb(p, (db) => {
    const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
    const msg = tables.find((t) => /^messages?$/i.test(t));
    if (!msg) { note = `no messages table (tables: ${tables.slice(0, 8).join(", ")})`; return false; }
    const cols = (db.query(`pragma table_info(${msg})`).all() as { name: string }[]).map((c) => c.name);
    const tcol = cols.find((c) => /created_?at|^time|timestamp/i.test(c));
    const role = cols.find((c) => /^position$/i.test(c)) ?? cols.find((c) => /^role$/i.test(c));
    const id = cols.find((c) => /^id$/i.test(c)) ?? "rowid";
    if (!tcol) { note = "messages table has no time column"; return false; }
    const where = role === "position" ? " where position = 'right'" : role ? ` where ${role} = 'user'` : "";
    for (const r of db.query(`select ${id} as id, ${tcol} as t from ${msg}${where}`).all() as { id: unknown; t: unknown }[]) {
      const ts = typeof r.t === "number" ? (r.t < 1e12 ? r.t * 1000 : r.t) : Date.parse(String(r.t)) || 0;
      records.push({ k: h(`ai:${r.id}`), ts, kind: "ai.prompt", n: 1 });
    }
    return true;
  });
  return { tool: "aionui", records, health: { present: existsSync(p), files: existsSync(p) ? 1 : 0, read: ok ? 1 : 0, versions: [], shape: !existsSync(p) ? "absent" : ok ? "ok" : "unknown", ...(note ? { note } : {}) } };
}

export function wisprAdapter(roots: Roots): AdapterResult {
  const p = join(roots.appSupport, "Wispr Flow", "flow.sqlite");
  const records: AiRecord[] = [];
  const ok = withDb(p, (db) => {
    // Dictations (History) and voice commands to its assistant (InstructHistory).
    for (const r of db.query("select transcriptEntityId as id, timestamp as t from History").all() as { id: string; t: string }[]) {
      records.push({ k: h(`wd:${r.id}`), ts: sqlTime(r.t), kind: "ai.prompt", n: 1, surface: "dictation" });
    }
    for (const r of db.query("select id, createdAt as t from InstructHistory").all() as { id: string; t: string }[]) {
      records.push({ k: h(`wi:${r.id}`), ts: sqlTime(r.t), kind: "ai.prompt", n: 1, surface: "command" });
    }
    return true;
  });
  return { tool: "wispr", records, health: { present: existsSync(p), files: existsSync(p) ? 1 : 0, read: ok ? 1 : 0, versions: [], shape: !existsSync(p) ? "absent" : ok ? "ok" : "unknown", note: "voice dictations and commands, counts only (no text)" } };
}

export function glyphAdapter(roots: Roots): AdapterResult {
  const p = join(roots.home, ".local", "state", "glyph", "sessions.tsv");
  const records: AiRecord[] = [];
  let raw = "";
  try { raw = readFileSync(p, "utf8"); } catch { /* absent */ }
  for (const line of raw.split("\n")) {
    const [t, tool, name, cwd] = line.split("\t");
    const ts = Date.parse(t ?? "");
    if (!ts || !tool) continue;
    records.push({ k: h(`gl:${line}`), ts, kind: "ai.session", model: tool, project: scrub(cwd), session: scrub(name), n: 1 });
  }
  return { tool: "glyph", records, health: { present: !!raw, files: raw ? 1 : 0, read: raw ? 1 : 0, versions: [], shape: raw ? "ok" : "absent", note: "sessions launched through glyph, by tool (stored in the model field)" } };
}

// ── New-tool detection ──────────────────────────────────────────────────────

export const ADAPTED = ["claude", "codex", "opencode", "hermes", "antigravity", "cursor", "aionui", "wispr", "glyph"] as const;

// AI tools Prevail knows by binary name or data folder, with no adapter yet.
const KNOWN: { tool: string; bins: string[]; dirs: string[] }[] = [
  { tool: "gemini", bins: ["gemini"], dirs: [".gemini/tmp"] },
  { tool: "copilot", bins: ["copilot"], dirs: [".copilot/session-state"] },
  { tool: "grok", bins: ["grok"], dirs: [".grok/sessions"] },
  { tool: "vibe", bins: ["vibe"], dirs: [".vibe"] },
  { tool: "amp", bins: ["amp"], dirs: [".local/share/amp"] },
  { tool: "goose", bins: ["goose"], dirs: [".local/share/goose"] },
  { tool: "ollama", bins: ["ollama"], dirs: [".ollama"] },
  { tool: "aider", bins: ["aider"], dirs: [] },
  { tool: "kiro", bins: ["kiro", "kiro-cli"], dirs: [".kiro"] },
  { tool: "droid", bins: ["droid"], dirs: [".factory"] },
  { tool: "qwen", bins: ["qwen"], dirs: [".qwen"] },
  { tool: "kilo", bins: ["kilo", "kilocode"], dirs: [".kilocode"] },
  { tool: "crush", bins: ["crush"], dirs: [".local/share/crush"] },
  { tool: "llm", bins: ["llm"], dirs: ["Library/Application Support/io.datasette.llm"] },
  { tool: "pi", bins: ["pi"], dirs: [".pi"] },
  { tool: "lmstudio", bins: ["lms"], dirs: [".lmstudio"] },
  { tool: "warp", bins: [], dirs: [".warp"] },
];

/** Tools seen on this machine (a binary on PATH or a data folder) that no adapter reads. */
export function detectNewTools(roots: Roots, pathEnv = process.env.PATH ?? ""): { tool: string; via: string }[] {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const out: { tool: string; via: string }[] = [];
  for (const k of KNOWN) {
    const bin = k.bins.find((b) => dirs.some((d) => existsSync(join(d, b))));
    const dir = k.dirs.find((d) => existsSync(join(roots.home, d)));
    if (bin || dir) out.push({ tool: k.tool, via: bin ? `binary ${bin}` : `folder ~/${dir}` });
  }
  return out;
}

// ── Scan: adapters -> per-host month files ─────────────────────────────────

export interface AiEvent {
  ts: string;              // the day, YYYY-MM-DD (local)
  src: string;
  kind: AiRecord["kind"];
  n: number;
  model?: string;
  project?: string;
  host: string;
  tier: "measured" | "derived";
  attrs: Record<string, number | string>;
}

const dayOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const MIN_TS = Date.UTC(2000, 0, 1);
const tokTotal = (r: AiRecord) => (r.t ? r.t.in + r.t.out + r.t.cr + r.t.cw + r.t.cw1h : 0);

/**
 * Fold one tool's records into daily events, deduped on their key. Claude
 * Code writes one line per content block of a response, each carrying the
 * usage so far, and copies earlier lines into resumed sessions: of the
 * records sharing a key, the one with the most tokens (the complete count)
 * is kept, as ccusage does.
 */
export function toEvents(tool: string, records: AiRecord[], host: string): AiEvent[] {
  const best = new Map<string, AiRecord>();
  for (const r of records) {
    // A record with no usable time (zero, or a bad conversion) is dropped,
    // so it can never land in a "0-12-31" month file.
    if (!r.ts || r.ts < MIN_TS) continue;
    const had = best.get(r.k);
    if (!had || tokTotal(r) > tokTotal(had)) best.set(r.k, r);
  }
  const by = new Map<string, AiEvent & { _s: Set<string> }>();
  for (const r of best.values()) {
    const day = dayOf(r.ts);
    const key = `${day}\t${r.kind}\t${r.model ?? ""}\t${r.project ?? ""}\t${r.surface ?? ""}`;
    let e = by.get(key);
    if (!e) {
      e = { ts: day, src: tool, kind: r.kind, n: 0, host, tier: r.kind === "ai.cost_reported" ? "derived" : "measured", attrs: {}, _s: new Set() };
      if (r.model) e.model = r.model;
      if (r.project) e.project = r.project;
      if (r.surface) e.attrs.surface = r.surface;
      by.set(key, e);
    }
    e.n += r.n ?? 1;
    if (r.session) e._s.add(r.session);
    const a = e.attrs;
    const add = (k: string, v: number) => { a[k] = Math.round(((a[k] as number | undefined) ?? 0) * 1e6 + v * 1e6) / 1e6; };
    if (r.t) {
      add("in", r.t.in); add("out", r.t.out); add("cache_read", r.t.cr); add("cache_write", r.t.cw); add("cache_write_1h", r.t.cw1h); add("reasoning", r.t.reasoning);
      const usd = apiUsd(r.model ?? "", r.t);
      if (usd === null) add("unpriced_tokens", r.t.in + r.t.out + r.t.cr + r.t.cw + r.t.cw1h);
      else add("usd_api", usd);
    }
    if (typeof r.usd === "number") add("usd_reported", r.usd);
    if (r.q) for (const [k, v] of Object.entries(r.q)) {
      if (typeof v === "number") a[k] = r.kind === "ai.quota" ? Math.max(num(a[k]), v) : num(a[k]) + v;
      else a[k] = v;
    }
  }
  return [...by.values()].map(({ _s, ...e }) => (_s.size ? { ...e, attrs: { ...e.attrs, sessions: _s.size } } : e));
}

export function eventsDir(vault: string): string {
  return join(runtimePath(vault, "_meta"), "events");
}

export interface ScanReport {
  host: string;
  months: string[];
  tools: Record<string, AdapterResult["health"] & { events: number }>;
  unadapted: { tool: string; via: string }[];
  ms: number;
}

const monthOf = (day: string) => day.slice(0, 7);
function monthsToWrite(now: number): string[] {
  const d = new Date(now);
  const cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return [`${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`, cur];
}

/**
 * Run every adapter on this machine and rewrite this host's event files for
 * the current and previous month. Older months stay as written. Returns what
 * each adapter saw; also written to build/_meta/apps/adapters.<host>.json so
 * an unknown shape shows up as a health problem, never as silent zeros.
 */
export function scanAiUsage(vault: string, opts: { roots?: Roots; now?: number; host?: string; only?: string[]; backfill?: boolean } = {}): ScanReport {
  const t0 = Date.now();
  const roots = opts.roots ?? defaultRoots();
  const host = opts.host ?? hostSlug();
  const months = monthsToWrite(opts.now ?? Date.now());
  const report: ScanReport = { host, months, tools: {}, unadapted: [], ms: 0 };
  const run: [string, () => AdapterResult][] = [
    ["claude", () => { const c = loadCache(roots, "claude"); const r = claudeAdapter(roots, c); saveCache(roots, "claude", c); return r; }],
    ["codex", () => { const c = loadCache(roots, "codex"); const r = codexAdapter(roots, c); saveCache(roots, "codex", c); return r; }],
    ["opencode", () => opencodeAdapter(roots)],
    ["hermes", () => hermesAdapter(roots)],
    ["antigravity", () => antigravityAdapter(roots)],
    ["cursor", () => cursorAdapter(roots)],
    ["aionui", () => aionuiAdapter(roots)],
    ["wispr", () => wisprAdapter(roots)],
    ["glyph", () => glyphAdapter(roots)],
  ];
  for (const [tool, fn] of run) {
    if (opts.only && !opts.only.includes(tool)) continue;
    let res: AdapterResult;
    try { res = fn(); } catch (e) {
      report.tools[tool] = { present: true, files: 0, read: 0, versions: [], shape: "unknown", note: `adapter failed: ${String(e).slice(0, 160)}`, events: 0 };
      continue;
    }
    const events = toEvents(tool, res.records, host);
    let written = 0;
    if (res.health.present) {
      const dir = join(eventsDir(vault), tool);
      // A backfill also writes older months this host has no file for yet
      // (older months are otherwise frozen as written).
      const want = new Set(months);
      if (opts.backfill) for (const e of events) if (!existsSync(join(dir, `${monthOf(e.ts)}.${host}.jsonl`))) want.add(monthOf(e.ts));
      for (const m of want) {
        const rows = events.filter((e) => monthOf(e.ts) === m);
        const file = join(dir, `${m}.${host}.jsonl`);
        if (!rows.length && !existsSync(file)) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${file}.tmp`, rows.map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : ""));
        renameSync(`${file}.tmp`, file);
        written += rows.length;
      }
    }
    report.tools[tool] = { ...res.health, events: written };
  }
  report.unadapted = detectNewTools(roots);
  report.ms = Date.now() - t0;
  try {
    const dir = join(runtimePath(vault, "_meta"), "apps");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `adapters.${host}.json`), `${JSON.stringify({ ts: new Date().toISOString(), price_snapshot: PRICE_SNAPSHOT, ...report }, null, 2)}\n`);
  } catch { /* health is best-effort */ }
  return report;
}

// ── Reading: every host's events, one honest report ─────────────────────────

export function readAiEvents(vault: string, month: string): AiEvent[] {
  const root = eventsDir(vault);
  const out: AiEvent[] = [];
  let tools: string[] = [];
  try { tools = readdirSync(root); } catch { return out; }
  for (const tool of tools) {
    let files: string[] = [];
    try { files = readdirSync(join(root, tool)).filter((f) => f.startsWith(`${month}.`) && f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      let raw = "";
      try { raw = readFileSync(join(root, tool, f), "utf8"); } catch { continue; }
      for (const l of raw.split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
    }
  }
  return out;
}

// Which vendor's app record carries what you pay for a tool.
export const VENDOR: Record<string, string> = { claude: "anthropic", codex: "openai", antigravity: "google", opencode: "opencode", cursor: "cursor", hermes: "hermes", aionui: "aionui", wispr: "wispr-flow" };

export interface PlanCost { app: string; amount: number; period: "month" | "year"; monthly: number; source: string }
export function readPlanCost(vault: string, app: string): PlanCost | null {
  try {
    const m = JSON.parse(readFileSync(join(productDir(vault, app), "manifest.json"), "utf8")) as { cost?: { amount?: number; period?: string; source?: string } };
    const c = m.cost;
    if (!c || typeof c.amount !== "number" || c.amount < 0) return null;
    const period = c.period === "year" ? "year" : "month";
    return { app, amount: c.amount, period, monthly: period === "year" ? c.amount / 12 : c.amount, source: c.source ?? "stated" };
  } catch { return null; }
}

/** Record what a vendor's plan costs on its app record (creating the folder if needed). Other fields are kept. */
export function setPlanCost(vault: string, app: string, amount: number, period: "month" | "year"): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(app)) throw new Error(`not an app id: ${app}`);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) throw new Error("amount must be between 0 and 100000");
  const dir = productWriteDir(vault, app);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "manifest.json");
  let m: Record<string, unknown> = {};
  try { m = JSON.parse(readFileSync(join(productDir(vault, app), "manifest.json"), "utf8")); } catch { m = { id: app, name: app, integration: "manual", domains: [] }; }
  m.cost = { amount, period, source: "stated", set: new Date().toISOString().slice(0, 10) };
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  return p;
}

export interface Bucket { key: string; n: number; tokens: number; in: number; out: number; cache_read: number; cache_write: number; usd_api: number; usd_reported: number; unpriced_tokens: number; sessions: number }

export interface AiUsageReport {
  month: string;
  hosts: string[];
  price_snapshot: string;
  total: Bucket;
  by_tool: (Bucket & { paid_monthly?: number; paid_source?: string; value_multiple?: number; quota?: Record<string, number | string>; prompts?: number; code?: Record<string, number> })[];
  by_model: Bucket[];
  by_project: Bucket[];
  by_day: Bucket[];
  paid_monthly: number | null;
  value_multiple: number | null;
  labels: Record<string, string>;
}

function bucket(key: string): Bucket {
  return { key, n: 0, tokens: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, usd_api: 0, usd_reported: 0, unpriced_tokens: 0, sessions: 0 };
}
function addTo(b: Bucket, e: AiEvent): void {
  const a = e.attrs;
  b.n += e.n;
  b.in += num(a.in); b.out += num(a.out); b.cache_read += num(a.cache_read); b.cache_write += num(a.cache_write) + num(a.cache_write_1h);
  b.tokens = b.in + b.out + b.cache_read + b.cache_write;
  b.usd_api += num(a.usd_api); b.usd_reported += num(a.usd_reported); b.unpriced_tokens += num(a.unpriced_tokens);
  b.sessions += num(a.sessions);
}
const r2 = (b: Bucket): Bucket => ({ ...b, usd_api: Math.round(b.usd_api * 100) / 100, usd_reported: Math.round(b.usd_reported * 100) / 100 });

/** This month's AI usage across every host: tokens, the three cost numbers, by tool, model, project and day. */
export function aiUsageReport(vault: string, month: string, opts: { tool?: string } = {}): AiUsageReport {
  const events = readAiEvents(vault, month).filter((e) => !opts.tool || e.src === opts.tool);
  const hosts = [...new Set(events.map((e) => e.host))].sort();
  const total = bucket("total");
  const maps = { tool: new Map<string, Bucket>(), model: new Map<string, Bucket>(), project: new Map<string, Bucket>(), day: new Map<string, Bucket>() };
  const get = (m: Map<string, Bucket>, k: string) => { let b = m.get(k); if (!b) m.set(k, (b = bucket(k))); return b; };
  const quota = new Map<string, Record<string, number | string>>();
  const prompts = new Map<string, number>();
  const code = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (e.kind === "ai.tokens") {
      addTo(total, e); addTo(get(maps.tool, e.src), e); addTo(get(maps.model, e.model || "(unknown)"), e);
      addTo(get(maps.project, `${e.src}:${e.project || "(none)"}`), e); addTo(get(maps.day, e.ts), e);
    } else if (e.kind === "ai.cost_reported") {
      total.usd_reported += num(e.attrs.usd_reported); get(maps.tool, e.src).usd_reported += num(e.attrs.usd_reported);
    } else if (e.kind === "ai.session") {
      get(maps.tool, e.src).sessions += e.n;
    } else if (e.kind === "ai.prompt") {
      prompts.set(e.src, (prompts.get(e.src) ?? 0) + e.n);
    } else if (e.kind === "ai.quota") {
      const q = quota.get(e.src) ?? {};
      for (const [k, v] of Object.entries(e.attrs)) q[k] = typeof v === "number" ? Math.max(num(q[k]), v) : v;
      quota.set(e.src, q);
    } else if (e.kind === "ai.code") {
      const c = code.get(e.src) ?? {};
      for (const [k, v] of Object.entries(e.attrs)) if (typeof v === "number") c[k] = (c[k] ?? 0) + v;
      code.set(e.src, c);
    }
  }
  // Tokens a tool reported on a session that also has a cost-state line count once.
  for (const t of [...prompts.keys(), ...quota.keys(), ...code.keys()]) get(maps.tool, t);
  const sorted = (m: Map<string, Bucket>) => [...m.values()].map(r2).sort((a, b) => b.usd_api - a.usd_api || b.n - a.n);
  let paidTotal = 0, anyPaid = false;
  const by_tool = sorted(maps.tool).map((b) => {
    const plan = VENDOR[b.key] ? readPlanCost(vault, VENDOR[b.key]!) : null;
    if (plan) { paidTotal += plan.monthly; anyPaid = true; }
    return {
      ...b,
      ...(plan ? { paid_monthly: Math.round(plan.monthly * 100) / 100, paid_source: `${plan.app} app record (${plan.source})`, ...(plan.monthly > 0 ? { value_multiple: Math.round((b.usd_api / plan.monthly) * 10) / 10 } : {}) } : {}),
      ...(quota.get(b.key) ? { quota: quota.get(b.key) } : {}),
      ...(prompts.get(b.key) ? { prompts: prompts.get(b.key) } : {}),
      ...(code.get(b.key) ? { code: code.get(b.key) } : {}),
    };
  });
  const t = r2(total);
  return {
    month, hosts, price_snapshot: PRICE_SNAPSHOT, total: t, by_tool,
    by_model: sorted(maps.model), by_project: sorted(maps.project).slice(0, 50),
    by_day: [...maps.day.values()].map(r2).sort((a, b) => a.key.localeCompare(b.key)),
    paid_monthly: anyPaid ? Math.round(paidTotal * 100) / 100 : null,
    value_multiple: anyPaid && paidTotal > 0 ? Math.round((t.usd_api / paidTotal) * 10) / 10 : null,
    labels: {
      tokens: "measured: the tools' own local records, deduped",
      usd_api: `derived: tokens x list prices (snapshot ${PRICE_SNAPSHOT}); what this use would cost on the API`,
      usd_reported: "measured where a tool reports its own figure (Claude cost-state, opencode, hermes)",
      paid: "what you pay, from the vendor's app record; unknown until set or until bank data is connected",
    },
  };
}
