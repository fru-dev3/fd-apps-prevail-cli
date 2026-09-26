// Apps mirror: a live view of the MCP connectors the user already signed into
// in their AI runtimes (Claude Code claude.ai connectors, Codex, Antigravity,
// Gemini CLI), plus model-run sync recipes that pull READ-ONLY data from a
// connector into life domains.
//
// Nothing here changes any runtime's config. We only run list/help commands,
// a tool-discovery launch that is killed before any model call, and (for a
// saved recipe) one headless `claude -p` turn whose tool surface is pinned to
// the recipe's read tools.
//
// Files:
//   <vault>/build/_meta/apps/mirror.json          runtime + connector cache
//   <vault>/build/_meta/apps/drafts/<id>.json     recipe drafts (not saved yet)
//   <vault>/build/_meta/apps/sync/<id>.json       sync checkpoint
//   <vault>/data/apps/<id>/manifest.json          mirror, tools, recipe, domains
//   <vault>/data/domains/<d>/source/apps/<id>/<YYYY-MM-DD>.json   synced records

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { appsContainer, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";

// ── Contract types ────────────────────────────────────────────────────────────

export type RuntimeId = "claude" | "codex" | "gemini" | "agy";
export type ToolKind = "read" | "write" | "send" | "money";
export type MirrorStatus = "connected" | "needs_auth" | "disabled" | "error";
export type Schedule = "daily" | "weekly" | "manual";

export interface MirrorTool {
  name: string;
  full_name: string;
  kind: ToolKind;
  sync_allowed: boolean;
  chat_default: boolean;
}

export interface Recipe {
  prompt: string;
  domains: string[];
  schedule: Schedule;
  read_tools: string[];
  model?: string;
  updated_at?: number;
}

export interface MirrorApp {
  id: string;
  name: string;
  runtime: RuntimeId;
  server: string;
  url?: string;
  command?: string;
  // Added field: "remote" for URL connectors, "stdio" for local servers.
  transport?: "remote" | "stdio";
  status: MirrorStatus;
  status_detail?: string;
  signin_hint: string;
  syncable: boolean;
  tools?: MirrorTool[];
  tools_checked_at?: number;
  domains: string[];
  recipe?: Recipe | null;
  last_sync?: number | null;
  last_error?: string | null;
  records_last_sync?: number;
}

export interface RuntimeInfo {
  runtime: RuntimeId;
  installed: boolean;
  version?: string;
  syncable: boolean;
  signin_hint: string;
  error?: string;
  count: number;
}

export interface MirrorDoc {
  generated_at: number;
  runtimes: RuntimeInfo[];
  apps: MirrorApp[];
}

// ── Process runner (injectable for tests) ─────────────────────────────────────

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean; // binary not found on PATH
  timedOut: boolean;
}

export interface ExecOpts {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  // Resolve early (and kill the child) once a stdout line satisfies this.
  until?: (line: string) => boolean;
}

export type Exec = (bin: string, args: string[], opts: ExecOpts) => Promise<ExecResult>;

export const defaultExec: Exec = (bin, args, opts) =>
  new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: Partial<ExecResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ code: null, stdout, stderr, missing: false, timedOut, ...r });
    };
    const kill = () => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000).unref?.();
    };
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolveP({ code: null, stdout: "", stderr: String(err.message ?? err), missing: err.code === "ENOENT", timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; kill(); finish({}); }, opts.timeoutMs);
    let pending = "";
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      if (opts.until) {
        pending += s;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (opts.until(line)) { kill(); finish({ code: 0 }); return; }
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ missing: e.code === "ENOENT", stderr: stderr || String(e.message) }));
    child.on("close", (code) => finish({ code }));
  });

// The environment for every model-running child: secret-looking vars stripped
// and PREVAIL_INTERNAL=1 so the runtime's prompt-capture hook skips the turn.
async function childEnv(): Promise<NodeJS.ProcessEnv> {
  try {
    const { scrubbedEnv } = await import("./cli-bridge.ts");
    return scrubbedEnv();
  } catch {
    return { ...process.env, PREVAIL_INTERNAL: "1" };
  }
}

// ── Naming ────────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

const CLAUDE_AI_PREFIX = "claude.ai ";

// "claude.ai Acme Notes" -> "Acme Notes"; local names pass through.
export function displayName(server: string): string {
  return server.startsWith(CLAUDE_AI_PREFIX) ? server.slice(CLAUDE_AI_PREFIX.length).trim() : server.trim();
}

export function appIdFor(runtime: RuntimeId, server: string): string {
  const s = slugify(displayName(server));
  return runtime === "claude" ? s : `${runtime}-${s}`;
}

// Claude Code exposes a server's tools as mcp__<key>__<tool>, where the key is
// the server name with every character outside [A-Za-z0-9_-] replaced by "_"
// ("claude.ai Privacy.com" -> "claude_ai_Privacy_com").
export function claudeServerKey(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, "_");
}
export function claudeToolPrefix(server: string): string {
  return `mcp__${claudeServerKey(server)}__`;
}

export function signinHint(runtime: RuntimeId, server: string): string {
  const name = displayName(server);
  if (runtime === "claude") return "https://claude.ai/settings/connectors";
  if (runtime === "codex") return `codex mcp login ${name}`;
  if (runtime === "agy") return `agy mcp enable ${name}`;
  return "gemini mcp list";
}

export function runtimeSigninHint(runtime: RuntimeId): string {
  if (runtime === "claude") return "https://claude.ai/settings/connectors";
  if (runtime === "codex") return "codex mcp login <name>";
  if (runtime === "agy") return "agy mcp enable <name>";
  return "gemini mcp list";
}

// Prevail's own MCP server is never mirrored as an app.
export function isPrevailServer(name: string, command?: string): boolean {
  if (displayName(name).toLowerCase() === "prevail") return true;
  return !!command && /(^|[\s/])prevail(\s|$)/.test(command) && /\bmcp\b/.test(command);
}

// ── Status parsing ────────────────────────────────────────────────────────────

export function normalizeStatus(text: string): MirrorStatus {
  const t = text.toLowerCase();
  if (/disabled/.test(t)) return "disabled";
  if (/needs[ -]?auth|authenticat|not logged in|not_logged_in|notloggedin|login required|unauthori[sz]ed|sign[ -]?in required/.test(t)) return "needs_auth";
  if (/disconnected|not connected|fail|error|timed? ?out|unreachable/.test(t)) return "error";
  if (/connected|enabled|\bok\b|ready|running/.test(t)) return "connected";
  return "error";
}

export interface RawServer {
  name: string;
  url?: string;
  command?: string;
  status: MirrorStatus;
  detail?: string;
}

function isUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim());
}

// `claude mcp list` lines: "<name>: <url-or-command> - <status>". The name ends
// at the first ": " (URLs use "://", never ": "), the status after the last " - ".
export function parseClaudeMcpList(text: string): RawServer[] {
  const out: RawServer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+?): (.+) - (.+)$/);
    if (!m) continue;
    const name = m[1]!.trim();
    const target = m[2]!.trim();
    const statusText = m[3]!.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const status = normalizeStatus(statusText);
    const entry: RawServer = { name, status };
    if (isUrl(target)) entry.url = target.replace(/\s+\((?:HTTP|SSE|http|sse)\)$/, "");
    else entry.command = target;
    if (status !== "connected") entry.detail = statusText;
    out.push(entry);
  }
  return out;
}

// `codex mcp list --json`.
export function parseCodexMcpList(text: string): RawServer[] {
  let arr: unknown;
  try { arr = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: RawServer[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    if (!name) continue;
    const tr = (o.transport && typeof o.transport === "object" ? o.transport : {}) as Record<string, unknown>;
    const url = typeof tr.url === "string" ? tr.url : undefined;
    const cmd = typeof tr.command === "string" ? tr.command : undefined;
    const args = Array.isArray(tr.args) ? tr.args.filter((a): a is string => typeof a === "string") : [];
    const auth = typeof o.auth_status === "string" ? o.auth_status : "";
    let status: MirrorStatus = "connected";
    let detail: string | undefined;
    if (o.enabled === false) {
      status = "disabled";
      detail = typeof o.disabled_reason === "string" && o.disabled_reason ? o.disabled_reason : "disabled";
    } else if (/not_?logged_?in|notloggedin|unauth/i.test(auth)) {
      status = "needs_auth";
      detail = auth;
    }
    const entry: RawServer = { name, status };
    if (url) entry.url = url;
    else if (cmd) entry.command = [cmd, ...args].join(" ");
    if (detail) entry.detail = detail;
    out.push(entry);
  }
  return out;
}

// `agy mcp list` prints a fixed-width table: NAME TYPE STATUS COMMAND/URL.
// Column starts come from the header so names with single spaces survive.
export function parseAgyMcpList(text: string): RawServer[] {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => /^\s*NAME\s+TYPE\s+STATUS\s+/i.test(l));
  if (hi < 0) return [];
  const header = lines[hi]!;
  const cType = header.search(/\bTYPE\b/i);
  const cStatus = header.search(/\bSTATUS\b/i);
  const cTarget = header.search(/\bCOMMAND|\bURL\b/i);
  const out: RawServer[] = [];
  for (const line of lines.slice(hi + 1)) {
    if (!line.trim()) continue;
    let name: string, statusText: string, target: string;
    if (line.length >= cTarget && cType > 0 && cStatus > cType && cTarget > cStatus) {
      name = line.slice(0, cType).trim();
      statusText = line.slice(cStatus, cTarget).trim();
      target = line.slice(cTarget).trim();
    } else {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length < 3) continue;
      name = parts[0]!;
      statusText = parts[2]!;
      target = parts.slice(3).join(" ");
    }
    if (!name) continue;
    const status = normalizeStatus(statusText);
    const entry: RawServer = { name, status };
    if (target) { if (isUrl(target)) entry.url = target; else entry.command = target; }
    if (status !== "connected") entry.detail = statusText;
    out.push(entry);
  }
  return out;
}

// `gemini mcp list`: "<mark> <name>: <target> (<type>) - <status>".
export function parseGeminiMcpList(text: string): RawServer[] {
  const out: RawServer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const m = line.match(/^(.+?): (.+?)(?:\s+\((stdio|sse|http)\))? - (.+)$/i);
    if (!m) continue;
    const name = m[1]!.trim();
    const target = m[2]!.trim();
    const statusText = m[4]!.trim();
    const status = normalizeStatus(statusText);
    const entry: RawServer = { name, status };
    if (isUrl(target)) entry.url = target; else entry.command = target;
    if (status !== "connected") entry.detail = statusText;
    out.push(entry);
  }
  return out;
}

// ── Tool classification ───────────────────────────────────────────────────────

export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const READ_VERBS = new Set([
  "get", "list", "search", "fetch", "read", "query", "find", "describe", "show", "view",
  "lookup", "retrieve", "count", "download", "browse", "inspect", "preview", "explore",
]);
const MUTATING = new Set([
  "send", "create", "delete", "remove", "update", "edit", "post", "publish", "book", "order",
  "pay", "transfer", "purchase", "ride", "checkout", "cancel", "trash", "untrash", "move",
  "upload", "write", "add", "set", "share", "reply", "forward", "label", "unlabel", "spam",
  "unspam", "mark", "unmark", "pause", "unpause", "close", "respond", "merge", "copy", "import",
  "export", "generate", "spawn", "stop", "complete", "authenticate", "auth", "login", "logout",
  "convert", "duplicate", "apply", "approve", "reject", "submit", "run", "execute", "invite",
  "comment", "message", "schedule", "start", "restart", "enable", "disable", "archive",
  "unarchive", "restore", "save", "rename", "assign", "subscribe", "unsubscribe", "like",
  "follow", "unfollow", "play", "queue", "skip", "request", "confirm", "accept", "decline",
  "sign", "refund", "charge", "tip", "withdraw", "deposit", "attach", "detach", "link",
  "unlink", "connect", "disconnect", "reset", "clear", "toggle", "mute", "star", "pin",
  "resolve", "reopen", "lock", "unlock", "grant", "revoke", "invoke", "trigger", "sync",
  "push", "insert", "modify", "patch", "put", "replace", "change", "resize", "remix",
  "donate", "buy", "sell", "reserve", "rsvp", "notify", "draft", "wait", "tag", "untag",
  "upsert", "claim", "redeem", "activate", "deactivate", "open", "install", "uninstall",
]);
const MONEY = new Set([
  "pay", "payment", "payments", "payout", "payouts", "transfer", "purchase", "order", "checkout",
  "book", "ride", "card", "cards", "spend", "refund", "charge", "buy", "sell", "tip", "invoice",
  "withdraw", "deposit", "donate", "money", "reserve", "reservation", "subscribe", "redeem",
]);
const SEND = new Set([
  "send", "reply", "forward", "post", "publish", "share", "invite", "broadcast", "notify",
  "email", "tweet", "respond", "rsvp",
]);
// Secrets a sync must never copy into the vault, even though fetching them is
// technically a read. Card numbers count as money instruments.
const CARD_SECRETS = new Set(["pan", "cvv", "cvc"]);
const OTHER_SECRETS = new Set(["password", "passwords", "secret", "secrets", "credential", "credentials", "ssn", "token", "tokens", "apikey", "otp", "totp"]);

export function classifyTool(bare: string): { kind: ToolKind; sync_allowed: boolean; chat_default: boolean } {
  const words = toolWords(bare);
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  let kind: ToolKind;
  if (has(CARD_SECRETS)) kind = "money";
  else if (has(OTHER_SECRETS)) kind = "write";
  else if (has(READ_VERBS) && !has(MUTATING)) kind = "read";
  else if (has(MONEY)) kind = "money";
  else if (has(SEND) || words[0] === "message" || words[0] === "comment"
    || (words.includes("comment") && words.some((w) => w === "create" || w === "add" || w === "post"))) kind = "send";
  else kind = "write";
  return { kind, sync_allowed: kind === "read", chat_default: kind === "read" || kind === "write" };
}

export function buildTool(fullName: string, bare: string): MirrorTool {
  return { name: bare, full_name: fullName, ...classifyTool(bare) };
}

// Claude Code tool names for one server, from the full tool list. Longest
// prefix wins so "Foo" never claims "Foo Rides" tools (the "__" separator
// already prevents that, this is belt and braces).
export function claudeToolsForServer(allTools: string[], server: string): MirrorTool[] {
  const prefix = claudeToolPrefix(server);
  return allTools
    .filter((t) => t.startsWith(prefix) && t.length > prefix.length)
    .map((t) => buildTool(t, t.slice(prefix.length)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ClaudeInit {
  tools: string[];
  servers: { name: string; status: string }[];
}

export function parseClaudeInitLine(line: string): ClaudeInit | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.type !== "system" || r.subtype !== "init") return null;
  const tools = Array.isArray(r.tools) ? r.tools.filter((t): t is string => typeof t === "string") : [];
  const servers = Array.isArray(r.mcp_servers)
    ? r.mcp_servers
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({ name: String(s.name ?? ""), status: String(s.status ?? "") }))
        .filter((s) => s.name)
    : [];
  return { tools, servers };
}

export function findClaudeInit(stdout: string): ClaudeInit | null {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const r = parseClaudeInitLine(t);
    if (r) return r;
  }
  return null;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function metaAppsDir(vault: string): string {
  return join(runtimePath(vault, "_meta"), "apps");
}
export function mirrorCachePath(vault: string): string {
  return join(metaAppsDir(vault), "mirror.json");
}
export function draftPath(vault: string, id: string): string {
  return join(metaAppsDir(vault), "drafts", `${safeId(id)}.json`);
}
export function checkpointPath(vault: string, id: string): string {
  return join(metaAppsDir(vault), "sync", `${safeId(id)}.json`);
}
export function appDir(vault: string, id: string): string {
  return join(appsContainer(vault), safeId(id));
}

function safeId(id: string): string {
  const s = slugify(id);
  if (!s || s.startsWith("_")) throw new Error(`invalid app id "${id}"`);
  return s;
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(vreadFile(path));
  } catch {
    return null;
  }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  vwriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ── Runtime listing ───────────────────────────────────────────────────────────

export interface MirrorDeps {
  exec?: Exec;
  now?: () => number;
}

const LIST_TIMEOUT = 90_000;
const VERSION_TIMEOUT = 15_000;

async function version(exec: Exec, bin: string): Promise<{ installed: boolean; version?: string; error?: string }> {
  const r = await exec(bin, ["--version"], { timeoutMs: VERSION_TIMEOUT });
  if (r.missing) return { installed: false };
  const v = (r.stdout || r.stderr).trim().split("\n")[0]?.trim();
  if (r.code !== 0 && !v) return { installed: true, error: r.timedOut ? "version check timed out" : "version check failed" };
  return { installed: true, version: v || undefined };
}

function toApp(runtime: RuntimeId, raw: RawServer): MirrorApp {
  const app: MirrorApp = {
    id: appIdFor(runtime, raw.name),
    name: displayName(raw.name),
    runtime,
    server: raw.name,
    transport: raw.url ? "remote" : "stdio",
    status: raw.status,
    signin_hint: signinHint(runtime, raw.name),
    syncable: runtime === "claude",
    domains: [],
  };
  if (raw.url) app.url = raw.url;
  if (raw.command) app.command = raw.command;
  if (raw.detail) app.status_detail = raw.detail;
  return app;
}

interface RuntimeScan { info: RuntimeInfo; apps: MirrorApp[] }

async function scanRuntime(
  runtime: RuntimeId,
  exec: Exec,
  vault: string,
  listArgs: string[],
  parse: (text: string) => RawServer[],
): Promise<RuntimeScan> {
  const bin = runtime;
  const info: RuntimeInfo = { runtime, installed: false, syncable: runtime === "claude", signin_hint: runtimeSigninHint(runtime), count: 0 };
  const v = await version(exec, bin);
  info.installed = v.installed;
  if (v.version) info.version = v.version;
  if (!v.installed) return { info, apps: [] };
  // cwd = vault root: claude reports connector status per project.
  const r = await exec(bin, listArgs, { cwd: vault, timeoutMs: LIST_TIMEOUT });
  if (r.missing) { info.installed = false; return { info, apps: [] }; }
  const raws = parse(r.stdout);
  if (r.timedOut) info.error = "listing MCP servers timed out";
  else if (r.code !== 0 && raws.length === 0) info.error = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code}`;
  const seen = new Set<string>();
  const apps: MirrorApp[] = [];
  for (const raw of raws) {
    if (isPrevailServer(raw.name, raw.command)) continue;
    const app = toApp(runtime, raw);
    if (seen.has(app.id)) continue;
    seen.add(app.id);
    apps.push(app);
  }
  info.count = apps.length;
  return { info, apps };
}

// Tool discovery for every claude connector in one launch: read the stream
// until the init line (it lists every MCP tool) and kill the process before any
// model call is made.
export async function discoverClaudeTools(vault: string, exec: Exec): Promise<ClaudeInit | null> {
  const env = await childEnv();
  const r = await exec(
    "claude",
    ["-p", "ok", "--output-format", "stream-json", "--verbose", "--tools", "", "--model", "claude-haiku-4-5", "--no-session-persistence"],
    { cwd: vault, timeoutMs: 120_000, env, until: (l) => l.includes('"subtype":"init"') },
  );
  return findClaudeInit(r.stdout);
}

// ── Cache + manifest merge ────────────────────────────────────────────────────

export function readMirrorCache(vault: string): MirrorDoc | null {
  const o = readJson(mirrorCachePath(vault));
  if (!o || typeof o !== "object") return null;
  const d = o as MirrorDoc;
  if (!Array.isArray(d.apps) || !Array.isArray(d.runtimes)) return null;
  return d;
}

interface ManifestView {
  raw: Record<string, unknown>;
  domains: string[];
  recipe: Recipe | null;
  tools?: MirrorTool[];
  tools_checked_at?: number;
}

export function readAppManifest(vault: string, id: string): ManifestView | null {
  let p: string;
  try { p = join(appDir(vault, id), "manifest.json"); } catch { return null; }
  const o = readJson(p);
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const raw = o as Record<string, unknown>;
  const domains = Array.isArray(raw.domains) ? raw.domains.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase()) : [];
  const recipe = coerceRecipe(raw.recipe);
  const tools = Array.isArray(raw.tools) ? raw.tools.map(coerceTool).filter((t): t is MirrorTool => !!t) : undefined;
  const tca = typeof raw.tools_checked_at === "number" ? raw.tools_checked_at : undefined;
  return { raw, domains, recipe, tools, tools_checked_at: tca };
}

function coerceTool(v: unknown): MirrorTool | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.full_name !== "string") return null;
  // Re-classify from the name: the stored kind is informative, never trusted
  // to widen what a sync may call.
  return buildTool(o.full_name, o.name);
}

export function coerceRecipe(v: unknown): Recipe | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) return null;
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean) : []);
  const schedule: Schedule = o.schedule === "weekly" || o.schedule === "manual" ? o.schedule : "daily";
  const r: Recipe = { prompt, domains: strs(o.domains).map((d) => d.toLowerCase()), schedule, read_tools: strs(o.read_tools) };
  if (typeof o.model === "string" && o.model.trim()) r.model = o.model.trim();
  if (typeof o.updated_at === "number") r.updated_at = o.updated_at;
  return r;
}

export interface Checkpoint {
  last_sync: number | null;
  last_attempt?: number | null;
  last_error: string | null;
  records: number;
  runs: { ts: number; ok: boolean; records: number; error?: string; files?: number }[];
}

export function readCheckpoint(vault: string, id: string): Checkpoint {
  const o = readJson(checkpointPath(vault, id)) as Partial<Checkpoint> | null;
  return {
    last_sync: typeof o?.last_sync === "number" ? o.last_sync : null,
    last_attempt: typeof o?.last_attempt === "number" ? o.last_attempt : null,
    last_error: typeof o?.last_error === "string" ? o.last_error : null,
    records: typeof o?.records === "number" ? o.records : 0,
    runs: Array.isArray(o?.runs) ? o!.runs!.slice(-10) : [],
  };
}

export function mergeApp(vault: string, base: MirrorApp): MirrorApp {
  const app: MirrorApp = { ...base };
  const man = readAppManifest(vault, app.id);
  if (man) {
    if (man.tools && man.tools.length) {
      app.tools = man.tools;
      if (man.tools_checked_at) app.tools_checked_at = man.tools_checked_at;
    }
    app.recipe = man.recipe;
    app.domains = man.recipe?.domains.length ? man.recipe.domains : man.domains;
  } else {
    app.recipe = null;
  }
  const cp = readCheckpoint(vault, app.id);
  app.last_sync = cp.last_sync;
  app.last_error = cp.last_error;
  if (cp.last_sync) app.records_last_sync = cp.records;
  return app;
}

// ── Public: refresh / list / tools ────────────────────────────────────────────

export async function refreshMirror(vault: string, opts: { tools?: boolean } & MirrorDeps = {}): Promise<MirrorDoc> {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const prev = readMirrorCache(vault);
  const [claude, codex, gemini, agy, init] = await Promise.all([
    scanRuntime("claude", exec, vault, ["mcp", "list"], parseClaudeMcpList),
    scanRuntime("codex", exec, vault, ["mcp", "list", "--json"], parseCodexMcpList),
    scanRuntime("gemini", exec, vault, ["mcp", "list"], parseGeminiMcpList),
    scanRuntime("agy", exec, vault, ["mcp", "list"], parseAgyMcpList),
    opts.tools ? discoverClaudeTools(vault, exec).catch(() => null) : Promise.resolve(null),
  ]);
  // If `claude mcp list` failed but the init line came back, fall back to its
  // server list (no URLs, but names + status).
  if (init && claude.info.installed && claude.apps.length === 0) {
    for (const s of init.servers) {
      if (isPrevailServer(s.name)) continue;
      claude.apps.push(toApp("claude", { name: s.name, status: normalizeStatus(s.status), detail: s.status }));
    }
    claude.info.count = claude.apps.length;
  }
  const ts = now();
  const prevById = new Map((prev?.apps ?? []).map((a) => [a.id, a]));
  const apps: MirrorApp[] = [];
  for (const a of [...claude.apps, ...codex.apps, ...gemini.apps, ...agy.apps]) {
    const old = prevById.get(a.id);
    if (old?.tools) { a.tools = old.tools; if (old.tools_checked_at) a.tools_checked_at = old.tools_checked_at; }
    if (init && a.runtime === "claude") {
      const tools = claudeToolsForServer(init.tools, a.server);
      if (tools.length) {
        a.tools = tools;
        a.tools_checked_at = ts;
        writeManifestPatch(vault, a, { tools, tools_checked_at: ts });
      }
    }
    apps.push(a);
  }
  const base: MirrorDoc = { generated_at: ts, runtimes: [claude.info, codex.info, gemini.info, agy.info], apps };
  writeJson(mirrorCachePath(vault), base);
  return { ...base, apps: base.apps.map((a) => mergeApp(vault, a)) };
}

export async function listMirror(vault: string, deps: MirrorDeps = {}): Promise<MirrorDoc> {
  const cache = readMirrorCache(vault);
  if (!cache) return refreshMirror(vault, deps);
  return { ...cache, apps: cache.apps.map((a) => mergeApp(vault, a)) };
}

export async function findApp(vault: string, id: string, deps: MirrorDeps = {}): Promise<MirrorApp | null> {
  const doc = await listMirror(vault, deps);
  return doc.apps.find((a) => a.id === id) ?? null;
}

// Rediscover tools for one app (claude runtime); other runtimes are mirror-only
// and have no headless tool listing we can call safely.
export async function appTools(vault: string, id: string, deps: MirrorDeps = {}): Promise<MirrorApp> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const app = await findApp(vault, id, deps);
  if (!app) throw new Error(`no mirrored app "${id}" (run: prevail apps refresh)`);
  if (app.runtime !== "claude") return app;
  const init = await discoverClaudeTools(vault, exec);
  if (!init) throw new Error("tool discovery failed: claude did not report its tool list");
  const tools = claudeToolsForServer(init.tools, app.server);
  const ts = now();
  if (tools.length) {
    writeManifestPatch(vault, app, { tools, tools_checked_at: ts });
    const cache = readMirrorCache(vault);
    if (cache) {
      const c = cache.apps.find((a) => a.id === id);
      if (c) { c.tools = tools; c.tools_checked_at = ts; writeJson(mirrorCachePath(vault), cache); }
    }
  }
  return mergeApp(vault, { ...app, ...(tools.length ? { tools, tools_checked_at: ts } : {}) });
}

// Merge a patch into data/apps/<id>/manifest.json, keeping the existing shape
// (id, name/title, description, domains, integration, connection) and adding
// `mirror`, `tools`, `recipe`.
export function writeManifestPatch(vault: string, app: MirrorApp, patch: Record<string, unknown>): void {
  const dir = appDir(vault, app.id);
  const path = join(dir, "manifest.json");
  const cur = (readJson(path) ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...(typeof cur === "object" && !Array.isArray(cur) ? cur : {}) };
  next.id ??= app.id;
  next.name ??= app.name;
  next.title ??= app.name;
  next.description ??= `${app.name} connector, mirrored from ${runtimeLabel(app.runtime)}.`;
  if (!Array.isArray(next.domains)) next.domains = [];
  next.integration ??= "mcp";
  const mirror: Record<string, unknown> = { runtime: app.runtime, server: app.server };
  if (app.url) mirror.url = app.url;
  next.mirror = mirror;
  Object.assign(next, patch);
  mkdirSync(dir, { recursive: true });
  writeJson(path, next);
}

function runtimeLabel(r: RuntimeId): string {
  return r === "claude" ? "Claude Code" : r === "codex" ? "Codex" : r === "agy" ? "Antigravity" : "Gemini CLI";
}

// ── Domains ───────────────────────────────────────────────────────────────────

export function vaultDomains(vault: string): string[] {
  try { return listDomainDirs(vault).map((d) => d.toLowerCase()).sort(); } catch { return []; }
}

function readIdeal(vault: string, domain: string, cap: number): string {
  try {
    const p = join(resolveDomainDir(vault, domain), "ideal-state.md");
    if (!existsSync(p)) return "";
    return vreadFile(p).trim().slice(0, cap);
  } catch {
    return "";
  }
}

// ── JSON extraction from model output ─────────────────────────────────────────

// Pull the first balanced JSON object out of a model reply (tolerates code
// fences and prose around it).
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string) => {
    try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  if (fence) { const f = tryParse(fence[1]!.trim()); if (f) return f; }
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { const v = tryParse(text.slice(start, i + 1)); if (v) return v; break; }
      }
    }
  }
  return null;
}

// `claude -p --output-format json` wraps the reply: {type:"result", result, is_error}.
export function unwrapClaudeJson(stdout: string): { text: string; isError: boolean } {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o.type === "result") return { text: typeof o.result === "string" ? o.result : "", isError: o.is_error === true };
    } catch { /* keep looking */ }
  }
  return { text: stdout, isError: false };
}

// ── Recipes ───────────────────────────────────────────────────────────────────

export const SYNC_MODEL = "claude-haiku-4-5";

export async function defaultDraftModel(): Promise<string> {
  try {
    const { defaultModelFor } = await import("./cli-bridge.ts");
    return defaultModelFor("claude") || "opus";
  } catch {
    return "opus";
  }
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,120}$/;

export function readTools(app: MirrorApp): MirrorTool[] {
  return (app.tools ?? []).filter((t) => t.sync_allowed);
}

export function buildDraftPrompt(vault: string, app: MirrorApp): string {
  const domains = vaultDomains(vault);
  const focus = app.domains.filter((d) => domains.includes(d));
  const tools = readTools(app);
  const parts: string[] = [
    `You design a data sync recipe for the "${app.name}" connector in a personal life-OS vault.`,
    `A recipe is run on a schedule by a small model that may call ONLY the read tools listed below, then returns JSON records that are filed into one or more life domains.`,
    `READ TOOLS (bare names):\n${tools.map((t) => `- ${t.name}`).join("\n") || "(none)"}`,
    `LIFE DOMAINS in this vault: ${domains.join(", ") || "(none)"}`,
  ];
  let budget = 12_000;
  const ordered = [...focus, ...domains.filter((d) => !focus.includes(d))];
  const ideals: string[] = [];
  for (const d of ordered) {
    const cap = focus.includes(d) ? 1500 : 300;
    const txt = readIdeal(vault, d, Math.min(cap, budget));
    if (!txt) continue;
    ideals.push(`## ${d}\n${txt}`);
    budget -= txt.length;
    if (budget <= 200) break;
  }
  if (ideals.length) parts.push(`DOMAIN IDEAL STATES (what each domain is trying to achieve):\n${ideals.join("\n\n")}`);
  parts.push(
    [
      "Pick the 1 to 3 domains this connector's data serves best, the read tools needed, and a schedule.",
      "Write the recipe prompt as direct instructions to the sync model: what to fetch (bounded, e.g. the last 7 days or the 50 most recent items), and which fields to keep per record. Never ask for secrets such as full card numbers or passwords.",
      "Return ONLY strict JSON, no prose, no code fence:",
      '{"prompt":"...","domains":["..."],"schedule":"daily|weekly|manual","read_tools":["bare_tool_name"]}',
      "Use only domain names and tool names from the lists above. Do not use em dashes.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

// Keep only what validates: known domains, read tools of this app.
export function sanitizeRecipe(input: Recipe, app: MirrorApp, domains: string[]): Recipe {
  const reads = new Map(readTools(app).map((t) => [t.name, t.name] as const));
  for (const t of readTools(app)) reads.set(t.full_name, t.name);
  const out: Recipe = {
    prompt: input.prompt.replace(/\s*\u2014\s*/g, ", "),
    domains: [...new Set(input.domains.map((d) => d.toLowerCase()).filter((d) => domains.includes(d)))],
    schedule: input.schedule,
    read_tools: [...new Set(input.read_tools.map((t) => reads.get(t)).filter((t): t is string => !!t))],
  };
  if (input.model && MODEL_RE.test(input.model)) out.model = input.model;
  return out;
}

export async function draftRecipe(
  vault: string,
  id: string,
  opts: { model?: string } & MirrorDeps = {},
): Promise<{ id: string; recipe: Recipe; model: string }> {
  const exec = opts.exec ?? defaultExec;
  const app = await findApp(vault, id, opts);
  if (!app) throw new Error(`no mirrored app "${id}" (run: prevail apps refresh)`);
  if (!app.syncable) throw new Error(`${app.name} is mirror-only (${runtimeLabel(app.runtime)} has no safe per-tool allowlist)`);
  if (!readTools(app).length) throw new Error(`no read tools known for ${app.name} (run: prevail apps refresh --tools)`);
  const model = opts.model?.trim() || (await defaultDraftModel());
  if (!MODEL_RE.test(model)) throw new Error(`invalid model id "${model}"`);
  const prompt = buildDraftPrompt(vault, app);
  const r = await exec(
    "claude",
    ["-p", prompt, "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
    { cwd: vault, timeoutMs: 5 * 60_000, env: await childEnv() },
  );
  if (r.missing) throw new Error("the claude CLI is not installed");
  if (r.timedOut) throw new Error("recipe draft timed out");
  const { text, isError } = unwrapClaudeJson(r.stdout);
  if (isError) throw new Error(`model error: ${text.slice(0, 200)}`);
  const parsed = coerceRecipe(extractJsonObject(text));
  if (!parsed) throw new Error("the model did not return a recipe JSON object");
  const recipe = sanitizeRecipe(parsed, app, vaultDomains(vault));
  if (!recipe.read_tools.length) recipe.read_tools = readTools(app).map((t) => t.name);
  writeJson(draftPath(vault, app.id), { id: app.id, recipe, model, drafted_at: (opts.now ?? Date.now)() });
  return { id: app.id, recipe, model };
}

export interface SaveRecipeInput {
  fromDraft?: boolean;
  prompt?: string;
  domains?: string[];
  schedule?: string;
  readTools?: string[];
  model?: string;
}

export async function saveRecipe(vault: string, id: string, input: SaveRecipeInput, deps: MirrorDeps = {}): Promise<MirrorApp> {
  const app = await findApp(vault, id, deps);
  if (!app) throw new Error(`no mirrored app "${id}" (run: prevail apps refresh)`);
  if (!app.syncable) throw new Error(`${app.name} is mirror-only; recipes run on claude connectors only`);
  let base: Partial<Recipe> = app.recipe ?? {};
  if (input.fromDraft) {
    const d = readJson(draftPath(vault, app.id)) as { recipe?: unknown } | null;
    const dr = coerceRecipe(d?.recipe);
    if (!dr) throw new Error(`no draft for "${app.id}" (run: prevail apps recipe draft ${app.id})`);
    base = dr;
  }
  const prompt = (input.prompt ?? base.prompt ?? "").trim();
  if (!prompt) throw new Error("recipe prompt is empty");
  const schedule = input.schedule ?? base.schedule ?? "daily";
  if (schedule !== "daily" && schedule !== "weekly" && schedule !== "manual") throw new Error(`invalid schedule "${schedule}" (daily|weekly|manual)`);
  const known = vaultDomains(vault);
  const domains = [...new Set((input.domains ?? base.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!domains.length) throw new Error("recipe needs at least one domain");
  const unknown = domains.filter((d) => !known.includes(d));
  if (unknown.length) throw new Error(`unknown domain(s): ${unknown.join(", ")}`);
  const reads = readTools(app);
  if (!reads.length) throw new Error(`no read tools known for ${app.name} (run: prevail apps refresh --tools)`);
  const byAny = new Map<string, string>();
  for (const t of reads) { byAny.set(t.name, t.name); byAny.set(t.full_name, t.name); }
  const wanted = input.readTools ?? base.read_tools ?? [];
  const bad = wanted.filter((t) => !byAny.has(t));
  if (bad.length) throw new Error(`not read tools of ${app.name}: ${bad.join(", ")}`);
  const read_tools = [...new Set(wanted.map((t) => byAny.get(t)!))];
  if (!read_tools.length) throw new Error("recipe needs at least one read tool");
  const recipe: Recipe = { prompt, domains, schedule, read_tools, updated_at: (deps.now ?? Date.now)() };
  const model = input.model ?? base.model;
  if (model) {
    if (!MODEL_RE.test(model)) throw new Error(`invalid model id "${model}"`);
    recipe.model = model;
  }
  writeManifestPatch(vault, app, { recipe, domains, tools: app.tools ?? [], ...(app.tools_checked_at ? { tools_checked_at: app.tools_checked_at } : {}) });
  return mergeApp(vault, app);
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export function localDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function buildSyncPrompt(app: MirrorApp, recipe: Recipe): string {
  return [
    `You are a read-only data sync for the "${app.name}" connector.`,
    `Task:\n${recipe.prompt}`,
    `You may call only these tools: ${recipe.read_tools.join(", ")}. Never try to change, send, book, buy or delete anything.`,
    "Never include secrets (full card numbers, security codes, passwords, tokens) in the output.",
    "Return ONLY strict JSON, no prose and no code fence, in exactly this shape:",
    '{"records":[{...one flat object per item, concise fields...}],"summary":"one or two sentences"}',
    "At most 200 records. If there is nothing to report, return an empty records array with a summary saying so.",
  ].join("\n\n");
}

// Argv for a recipe run. Built-in tools are all off (--tools ""), the recipe's
// read tools are pre-approved, every other tool of this server and every other
// known server is denied, and dontAsk mode refuses anything not pre-approved.
export function buildSyncArgs(app: MirrorApp, recipe: Recipe, otherServers: string[], prompt: string): string[] {
  const tools = app.tools ?? [];
  const allowSet = new Set(recipe.read_tools);
  const allowed = tools.filter((t) => t.sync_allowed && allowSet.has(t.name)).map((t) => t.full_name);
  const denied = tools.filter((t) => !allowed.includes(t.full_name)).map((t) => t.full_name);
  const serverDenies = [...new Set([...otherServers, "prevail"])]
    .filter((s) => s !== app.server)
    .map((s) => `mcp__${claudeServerKey(s)}`);
  const model = recipe.model && MODEL_RE.test(recipe.model) ? recipe.model : SYNC_MODEL;
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "json",
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--allowedTools", allowed.join(","),
  ];
  const deny = [...denied, ...serverDenies, "Bash", "Write", "Edit", "WebFetch", "WebSearch", "NotebookEdit", "Task"];
  args.push("--disallowedTools", deny.join(","));
  return args;
}

export interface SyncResult { ok: boolean; id: string; records: number; files: string[]; error?: string }

export async function syncMirrorApp(vault: string, id: string, deps: MirrorDeps = {}): Promise<SyncResult> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const started = now();
  const fail = (error: string, record = true): SyncResult => {
    if (record) recordRun(vault, id, { ts: started, ok: false, records: 0, error });
    return { ok: false, id, records: 0, files: [], error };
  };
  let doc: MirrorDoc;
  try { doc = await listMirror(vault, deps); } catch (e) { return fail(`mirror unavailable: ${(e as Error).message}`, false); }
  const app = doc.apps.find((a) => a.id === id);
  if (!app) return fail(`no mirrored app "${id}"`, false);
  if (!app.syncable) return fail(`${app.name} is mirror-only (${runtimeLabel(app.runtime)} has no safe per-tool allowlist)`);
  if (!app.recipe) return fail(`no recipe saved for ${app.name}`);
  if (app.status !== "connected") return fail(`${app.name} is ${app.status.replace("_", " ")} in Claude Code (sign in at ${app.signin_hint}, then prevail apps refresh)`);
  const recipe = app.recipe;
  const readNames = new Set(readTools(app).map((t) => t.name));
  const toolsOk = recipe.read_tools.filter((t) => readNames.has(t));
  if (!toolsOk.length) return fail("none of the recipe's read tools are available (run: prevail apps refresh --tools)");
  const known = vaultDomains(vault);
  const domains = recipe.domains.filter((d) => known.includes(d));
  if (!domains.length) return fail("the recipe's domains no longer exist");
  const effective: Recipe = { ...recipe, read_tools: toolsOk };
  const others = doc.apps.filter((a) => a.runtime === "claude" && a.id !== app.id).map((a) => a.server);
  const args = buildSyncArgs(app, effective, others, buildSyncPrompt(app, effective));
  const r = await exec("claude", args, { cwd: vault, timeoutMs: 10 * 60_000, env: await childEnv() });
  if (r.missing) return fail("the claude CLI is not installed");
  if (r.timedOut) return fail("sync timed out after 10 minutes");
  const { text, isError } = unwrapClaudeJson(r.stdout);
  if (isError) return fail(`model error: ${text.slice(0, 200)}`);
  if (r.code !== 0 && !text.trim()) return fail(`claude exited ${r.code}: ${(r.stderr || "").trim().slice(0, 200)}`);
  const obj = extractJsonObject(text);
  if (!obj || !Array.isArray(obj.records)) return fail("the sync did not return a JSON records array");
  const records = (obj.records as unknown[]).filter((x) => x && typeof x === "object").slice(0, 500);
  const summary = typeof obj.summary === "string" ? obj.summary.slice(0, 1000) : "";
  const ts = now();
  const date = localDate(ts);
  const files: string[] = [];
  const payload = { app: app.id, name: app.name, synced_at: ts, summary, records };
  for (const d of domains) {
    const dir = join(resolveDomainDir(vault, d), "source", "apps", app.id);
    const file = join(dir, `${date}.json`);
    mkdirSync(dir, { recursive: true });
    vwriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
    files.push(file);
  }
  recordRun(vault, id, { ts, ok: true, records: records.length, files: files.length });
  return { ok: true, id, records: records.length, files };
}

function recordRun(vault: string, id: string, run: Checkpoint["runs"][number]): void {
  try {
    const cp = readCheckpoint(vault, id);
    cp.last_attempt = run.ts;
    if (run.ok) {
      cp.last_sync = run.ts;
      cp.last_error = null;
      cp.records = run.records;
    } else {
      cp.last_error = run.error ?? "sync failed";
    }
    cp.runs = [...cp.runs, run].slice(-10);
    writeJson(checkpointPath(vault, id), cp);
  } catch { /* a checkpoint failure never masks the sync result */ }
}

const HOUR = 3_600_000;
export function isDue(schedule: Schedule, cp: Pick<Checkpoint, "last_sync" | "last_attempt" | "last_error">, now: number): boolean {
  if (schedule === "manual") return false;
  // A failed attempt waits an hour before the next try.
  if (cp.last_error && cp.last_attempt != null && now - cp.last_attempt < HOUR) return false;
  if (cp.last_sync == null) return true;
  const age = now - cp.last_sync;
  return schedule === "daily" ? age >= 23 * HOUR : age >= 6.5 * 24 * HOUR;
}

// Run every due recipe. Uses the cached mirror only (never the slow listing),
// so the daemon can call it every tick.
export async function syncDue(vault: string, deps: MirrorDeps = {}): Promise<{ ran: { id: string; ok: boolean; records: number; error?: string }[] }> {
  const now = deps.now ?? Date.now;
  const cache = readMirrorCache(vault);
  if (!cache) return { ran: [] };
  const ran: { id: string; ok: boolean; records: number; error?: string }[] = [];
  for (const base of cache.apps) {
    if (!base.syncable) continue;
    const app = mergeApp(vault, base);
    if (!app.recipe) continue;
    if (!isDue(app.recipe.schedule, readCheckpoint(vault, app.id), now())) continue;
    try {
      const r = await syncMirrorApp(vault, app.id, deps);
      ran.push({ id: app.id, ok: r.ok, records: r.records, ...(r.error ? { error: r.error } : {}) });
    } catch (e) {
      ran.push({ id: app.id, ok: false, records: 0, error: (e as Error).message });
    }
  }
  return { ran };
}

// ── Archive ───────────────────────────────────────────────────────────────────

// An app folder is SCAFFOLD ONLY (never produced data) when every entry is:
//   - one of the scaffold files below (state.md / MEMORY.md at most 2 KB, since
//     a larger one carries real notes), connection-status.json only while it
//     records no success, _intents.jsonl only when empty;
//   - skills/ whose files are all markdown (a skill with code is a built
//     connector, kept);
//   - _threads/, _journal/, _scope/ or any other directory holding no files;
//   - dotfiles (.DS_Store, AppleDouble "._x").
// Anything else (data/, auth/, CSVs, backups, ledgers, non-empty threads) means
// the app holds real material and stays.
const SCAFFOLD_FILES = new Set(["manifest.json", "SKILL.md", "soul.md", "connection.md", "QUICKSTART.md", "PROMPTS.md", "open-loops.md"]);
const SMALL_FILES = new Set(["state.md", "MEMORY.md"]);
const SMALL_CAP = 2048;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 12) { out.push(d); return; }
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

export function scaffoldOnly(dir: string): { scaffold: boolean; why: string } {
  let ents: import("node:fs").Dirent[];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch (e) { return { scaffold: false, why: `unreadable: ${(e as Error).message}` }; }
  const seen: string[] = [];
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      const files = filesUnder(p).filter((f) => !f.split("/").pop()!.startsWith("."));
      if (e.name === "skills") {
        const code = files.find((f) => !f.toLowerCase().endsWith(".md"));
        if (code) return { scaffold: false, why: "skills/ contains code" };
        if (files.length) seen.push("skills/");
        continue;
      }
      if (files.length) return { scaffold: false, why: `${e.name}/ has files` };
      continue;
    }
    if (!e.isFile()) return { scaffold: false, why: `${e.name} is not a regular file` };
    if (SCAFFOLD_FILES.has(e.name)) { seen.push(e.name); continue; }
    let size = 0;
    try { size = statSync(p).size; } catch { /* treat as 0 */ }
    if (SMALL_FILES.has(e.name)) {
      if (size > SMALL_CAP) return { scaffold: false, why: `${e.name} has content` };
      seen.push(e.name);
      continue;
    }
    if (e.name === "_intents.jsonl") {
      if (size > 0) return { scaffold: false, why: "_intents.jsonl has entries" };
      continue;
    }
    if (e.name === "connection-status.json") {
      const o = readJson(p) as Record<string, unknown> | null;
      if (o && (typeof o.lastSuccessTs === "number" || o.status === "connected")) return { scaffold: false, why: "connection has synced before" };
      seen.push(e.name);
      continue;
    }
    return { scaffold: false, why: `${e.name} is data` };
  }
  return { scaffold: true, why: seen.length ? `scaffold only (${seen.join(", ")})` : "empty folder" };
}

export interface ArchiveResult {
  candidates: { id: string; reason: string }[];
  moved: { id: string; from: string; to: string }[];
}

export function archiveCandidates(vault: string, mirroredIds: Set<string>): { id: string; reason: string }[] {
  const root = appsContainer(vault);
  if (!existsSync(root)) return [];
  const out: { id: string; reason: string }[] = [];
  let ents: import("node:fs").Dirent[] = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
    if (mirroredIds.has(e.name)) continue;
    const s = scaffoldOnly(join(root, e.name));
    if (!s.scaffold) continue;
    out.push({ id: e.name, reason: `${s.why}; never synced; not a mirrored connector` });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function archiveApps(vault: string, mirroredIds: Set<string>, apply: boolean, now: number = Date.now()): ArchiveResult {
  const candidates = archiveCandidates(vault, mirroredIds);
  const moved: ArchiveResult["moved"] = [];
  if (!apply || !candidates.length) return { candidates, moved };
  const root = appsContainer(vault);
  const arch = join(root, "_archive");
  mkdirSync(arch, { recursive: true });
  const index = join(arch, "INDEX.md");
  if (!existsSync(index)) vwriteFile(index, "# Archived apps\n\nApp folders moved here by `prevail apps archive`. Move one back to data/apps/ to restore it.\n\n");
  const date = localDate(now);
  for (const c of candidates) {
    const from = join(root, c.id);
    let to = join(arch, c.id);
    for (let n = 2; existsSync(to); n++) to = join(arch, `${c.id}-${n}`);
    try {
      renameSync(from, to);
    } catch {
      continue;
    }
    moved.push({ id: c.id, from, to });
    try { appendFileSync(index, `- ${date} \`${c.id}\`${to.endsWith(`/${c.id}`) ? "" : ` (as ${to.split("/").pop()})`}: ${c.reason}\n`); } catch { /* index is best effort */ }
  }
  return { candidates, moved };
}

// ── Domain context: the latest synced file per app ────────────────────────────

// A compact "Synced app data" block for a domain's chat and agent context: the
// newest <domain>/source/apps/<id>/<date>.json per app, size-capped. Empty
// string when the domain has no synced app data.
export function syncedAppsContext(domainDir: string, cap = 6000): string {
  const root = join(domainDir, "source", "apps");
  let apps: string[] = [];
  try { apps = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name).sort(); } catch { return ""; }
  if (!apps.length) return "";
  const per = Math.max(600, Math.floor(cap / apps.length));
  const blocks: string[] = [];
  let used = 0;
  for (const id of apps) {
    let files: string[] = [];
    try { files = readdirSync(join(root, id)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { continue; }
    const latest = files[files.length - 1];
    if (!latest) continue;
    let body = "";
    try {
      const raw = vreadFile(join(root, id, latest));
      try {
        const o = JSON.parse(raw) as { summary?: string; records?: unknown[] };
        const recs = Array.isArray(o.records) ? o.records : [];
        body = `${o.summary ? `${o.summary}\n` : ""}${recs.length} record(s): ${JSON.stringify(recs)}`;
      } catch {
        body = raw;
      }
    } catch { continue; }
    if (body.length > per) body = `${body.slice(0, per)} ...(truncated)`;
    const block = `### ${id} (${latest.replace(/\.json$/, "")}, source/apps/${id}/${latest})\n${body}`;
    if (used + block.length > cap) break;
    blocks.push(block);
    used += block.length;
  }
  if (!blocks.length) return "";
  return `# SYNCED APP DATA (latest pull per connected app, read-only)\n\n${blocks.join("\n\n")}`;
}

// Read-only helper for callers that just need the mirror ids (archive, MCP).
export function mirroredIds(doc: MirrorDoc): Set<string> {
  return new Set(doc.apps.map((a) => a.id));
}
