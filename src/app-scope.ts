// Apps as chat scopes: the context blocks a chat turn carries for referenced
// apps and domains, which runtime a turn needs for its apps, which app a tool
// call belongs to, and the per-app access log.
//
// Files:
//   <vault>/data/entities/products/<id>/_log/access.jsonl   one line per MCP call the act-gate
//                                              hook saw for that app (reads too)
//   <vault>/data/entities/products/<id>/_scope/_threads/    the app's own chat threads
//                                              (frontmatter `app: <id>`)
//
// The access log never holds a message body or an unredacted sensitive value:
// each line carries the argument keys plus short, scanned values.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  appDir,
  classifyTool,
  claudeServerKey,
  claudeToolPrefix,
  normalizeStatus,
  readMirrorCache,
  type MirrorApp,
  type RuntimeId,
  type ToolKind,
} from "./apps-mirror.ts";
import type { CliKind } from "./config.ts";
import { findingCategories, scanSensitive } from "./egress-guard.ts";
import { sourceBlockLines, withTrustedSources } from "./trusted-sources.ts";
import { scanLinks } from "./entities.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { boundGoogleAccountLabel } from "./vault.ts";
import { GOOGLE_APP_RE, accountEmail, classifyGwsCommand, googleAccounts } from "./gws-gateway.ts";
import { APP_SCOPE_PREFIX, productFolders, productWriteDir, resolveDomainDir } from "./path-safety.ts";
import { vappendLine, vreadFile } from "./vault-session.ts";

// ── Runtimes ─────────────────────────────────────────────────────────────────

// The chat engine kind that runs each mirror runtime's connectors.
const RUNTIME_CLI: Record<RuntimeId, CliKind> = { claude: "claude", codex: "codex", gemini: "gemini", agy: "antigravity" };
const RUNTIME_LABEL: Record<RuntimeId, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", agy: "Antigravity" };

export function runtimeCli(r: RuntimeId): CliKind {
  return RUNTIME_CLI[r] ?? (r as CliKind);
}

/** The mirrored apps plus trusted sources, from the cache and the vault only
 *  (never spawns a runtime). */
export function mirrorApps(vault: string): MirrorApp[] {
  let apps: MirrorApp[] = [];
  try { apps = readMirrorCache(vault)?.apps ?? []; } catch { apps = []; }
  try { return withTrustedSources(vault, apps); } catch { return apps; }
}

// ── Context blocks ───────────────────────────────────────────────────────────

const clip = (s: string, cap: number) => (s.length <= cap ? s : `${s.slice(0, cap - 1)}…`);

function readCapped(path: string, cap: number): string {
  try { return existsSync(path) ? clip(vreadFile(path).trim(), cap) : ""; } catch { return ""; }
}

export function toolGroups(app: MirrorApp): { reads: string[]; writes: string[]; blocked: string[] } {
  const g = { reads: [] as string[], writes: [] as string[], blocked: [] as string[] };
  for (const t of app.tools ?? []) {
    // Same grouping as the desktop's tool badges: send and money are blocked
    // from sync; in chat every non-read still queues for approval.
    if (t.kind === "read") g.reads.push(t.name);
    else if (t.kind === "write") g.writes.push(t.name);
    else g.blocked.push(t.name);
  }
  return g;
}

/** The exact Claude tool names of the referenced apps' READ tools (as the
 *  mirror classifies them), pre-allowed on the turn: headless Claude refuses
 *  any tool not in --allowedTools, and the act gate's allow is not a grant.
 *  Writes, sends and money tools are never listed; they queue at the gate. */
export function appReadTools(apps: MirrorApp[], ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const app = apps.find((a) => a.id === id);
    if (!app || app.runtime !== "claude" || app.trusted) continue;
    for (const t of app.tools ?? []) {
      if (t.kind === "read" && /^[A-Za-z0-9_-]{1,128}$/.test(t.name)) out.push(`${claudeToolPrefix(app.server)}${t.name}`);
    }
  }
  return [...new Set(out)];
}

export const APP_INSTRUCTION = "Use this app's tools to get what the user asks for. Reads run; writes and sends are queued for the user's approval.";
export const APP_NO_WORKAROUNDS = "If this app's tools are not available in this conversation, say in one sentence that it needs to be connected, and stop. Do not try other ways to reach it (files, shell, other tools).";

/** One APP CONTEXT block. `app` is the mirror entry, null when the id is not
 *  mirrored. Rebuilt every turn, never persisted. */
export function appChatBlock(vault: string, id: string, app: MirrorApp | null, cap = 4000): string {
  const lines = [`# APP CONTEXT: ${app?.name ?? id}`];
  if (!app) {
    lines.push(`App id ${id} is not in the apps mirror (run: prevail apps refresh), so its tools may not be available on this turn.`);
  } else if (app.trusted && app.trusted_here === false) {
    lines.push(`App id ${app.id}. A trusted source added on another Mac and NOT trusted on this one, so nothing from it is attached on this turn. The user can run \`prevail apps add-source\` here to trust it.`);
  } else if (app.trusted) {
    lines.push(`App id ${app.id}. Status: ${app.status}${app.status_detail && app.status !== "connected" ? ` (${clip(app.status_detail, 120)})` : ""}.`);
    lines.push(...sourceBlockLines(app));
    if (app.integration === "mcp-remote") {
      const g = toolGroups(app);
      lines.push(app.tools?.length ? `Reads: ${g.reads.join(", ") || "none"}\nNot read-only (queued for approval): ${[...g.writes, ...g.blocked].join(", ") || "none"}` : "Tools: none found at the last check.");
    }
  } else {
    lines.push(`App id ${app.id}. Its connector belongs to the ${RUNTIME_LABEL[app.runtime] ?? app.runtime} runtime. Status: ${app.status}${app.status_detail && app.status !== "connected" ? ` (${clip(app.status_detail, 120)})` : ""}.`);
    const g = toolGroups(app);
    if (!app.tools?.length) lines.push("Tools: not discovered yet.");
    else {
      lines.push(`Reads: ${g.reads.join(", ") || "none"}`);
      lines.push(`Writes: ${g.writes.join(", ") || "none"}`);
      lines.push(`Blocked: ${g.blocked.join(", ") || "none"}`);
    }
  }
  let dir = "";
  try { dir = appDir(vault, id); } catch { /* invalid id: no notes */ }
  if (dir) {
    const skill = readCapped(join(dir, "SKILL.md"), 1200);
    const state = readCapped(join(dir, "memory", "state.md"), 800) || readCapped(join(dir, "state.md"), 800);
    if (skill) lines.push("", "## How to operate it (SKILL.md)", skill);
    if (state) lines.push("", "## State", state);
  }
  lines.push("", APP_INSTRUCTION, APP_NO_WORKAROUNDS);
  return clip(lines.join("\n"), cap);
}

/** A compact block from another domain's state, for a cross-domain reference. */
export function refDomainBlock(vault: string, slug: string, cap = 1500): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return "";
  const dir = resolveDomainDir(vault, slug);
  const state = readCapped(join(dir, "memory", "state.md"), cap) || readCapped(join(dir, "state.md"), cap);
  const head = `# REFERENCED DOMAIN: ${slug}`;
  return clip(`${head}\nThe user referenced this domain. Its current state:\n${state || "Nothing is recorded yet."}`, cap + 200);
}

// ── Routing ──────────────────────────────────────────────────────────────────

export interface AppRoutePlan {
  /** Switch the turn to this engine (exactly one runtime owns every referenced app). */
  route?: { runtime: CliKind; reason: string };
  unavailable: { app: string; runtime_needed: CliKind }[];
  needsAuth: { app: string; name: string; signin_url?: string }[];
}

/** Decide where a turn with referenced apps runs. `canRun` says whether an
 *  engine kind is detected and allowed on this turn. Apps missing from the
 *  mirror are ignored here (their block says so). */
export function planAppRouting(ids: string[], apps: MirrorApp[], current: CliKind, canRun: (k: CliKind) => boolean): AppRoutePlan {
  const plan: AppRoutePlan = { unavailable: [], needsAuth: [] };
  // Web and links sources need no runtime connector: their block is the context.
  const known = ids.map((id) => apps.find((a) => a.id === id)).filter((a): a is MirrorApp => !!a && !(a.trusted && (a.integration !== "mcp-remote" || a.trusted_here === false)));
  for (const a of known) {
    if (a.status === "needs_auth") {
      const hint = (a.signin_hint ?? "").trim();
      plan.needsAuth.push({ app: a.id, name: a.name, ...(/^https?:\/\//i.test(hint) ? { signin_url: hint } : {}) });
    }
  }
  const lacking = known.filter((a) => runtimeCli(a.runtime) !== current);
  if (!lacking.length) return plan;
  const owners = [...new Set(known.map((a) => runtimeCli(a.runtime)))];
  if (owners.length === 1 && canRun(owners[0]!)) {
    const names = known.map((a) => a.name).join(", ");
    plan.route = { runtime: owners[0]!, reason: `${names} ${known.length > 1 ? "are" : "is"} connected through ${RUNTIME_LABEL[known[0]!.runtime] ?? owners[0]}` };
    return plan;
  }
  for (const a of lacking) plan.unavailable.push({ app: a.id, runtime_needed: runtimeCli(a.runtime) });
  return plan;
}

/** Referenced Claude connectors the live init event says are not usable.
 *  Pending servers are still starting and are skipped. */
export function initAppProblems(ids: string[], apps: MirrorApp[], init: { servers: { name: string; status: string }[] }): {
  needsAuth: { app: string; name: string; status: string; signin_url?: string }[];
  unavailable: { app: string; reason: string }[];
} {
  const out = { needsAuth: [] as { app: string; name: string; status: string; signin_url?: string }[], unavailable: [] as { app: string; reason: string }[] };
  for (const id of ids) {
    const app = apps.find((a) => a.id === id);
    if (!app || app.runtime !== "claude" || app.trusted) continue;
    const srv = init.servers.find((x) => x.name === app.server || claudeServerKey(x.name) === claudeServerKey(app.server));
    if (!srv) {
      out.unavailable.push({ app: id, reason: `${app.name} did not load in this Claude session, so its tools are not available. Check it is connected in Claude.` });
      continue;
    }
    if (/pending/i.test(srv.status) || normalizeStatus(srv.status) === "connected") continue;
    const hint = (app.signin_hint ?? "").trim();
    out.needsAuth.push({ app: id, name: app.name, status: srv.status, ...(/^https?:\/\//i.test(hint) ? { signin_url: hint } : {}) });
  }
  return out;
}

// ── Tool -> app ──────────────────────────────────────────────────────────────

/** The app a streamed tool call belongs to: an MCP tool name
 *  mcp__<server key>__<tool> whose server key is a mirrored Claude connector. */
export function appForTool(apps: MirrorApp[], toolName: string): { app: MirrorApp; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const cut = rest.indexOf("__");
  if (cut <= 0) return null;
  const key = rest.slice(0, cut);
  const app = apps.find((a) => a.runtime === "claude" && claudeServerKey(a.server) === key);
  return app ? { app, tool: rest.slice(cut + 2) } : null;
}

// ── The access log ───────────────────────────────────────────────────────────

export type AccessKind = "read" | "write" | "blocked";
export type AccessOutcome = "ran" | "queued" | "denied" | "declined";

export interface AccessLine {
  ts: number;
  tool: string;
  access: AccessKind;
  outcome: AccessOutcome;
  thread?: string;
  domain?: string;
  entity?: string;
  /** Google tool calls only: the account it ran as (a gws label or email;
   *  "claude" for Claude's own one-account connector). Local only. */
  account?: string;
  summary: string;
}

const accessKind = (k: ToolKind): AccessKind => (k === "read" ? "read" : k === "write" ? "write" : "blocked");

/** The app a tool belongs to, its short name, and its access class: the one
 *  classifier the access log and chat tool events share. A trusted source's
 *  tools carry their probed read classification. */
export function appToolAccess(apps: MirrorApp[], toolName: string): { app: MirrorApp; tool: string; access: AccessKind } | null {
  const hit = appForTool(apps, toolName);
  if (!hit) return null;
  return { ...hit, access: accessKind(hit.app.tools?.find((t) => t.name === hit.tool)?.kind ?? classifyTool(hit.tool).kind) };
}

// Keys whose values are message or document bodies: only their length is kept.
const BODY_KEY = /^(body|content|contents|text|html|message|markdown|md|description|notes?|comment|raw|data|payload|attachments?)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const VALUE_CAP = 60;
const MAX_KEYS = 12;

function redactValue(s: string): string {
  // Scan the (bounded) whole value BEFORE clipping, so a sensitive value that
  // straddles the clip point is still caught and nothing of it is written.
  const scanned = s.slice(0, 4000);
  const labels = findingCategories(scanSensitive(scanned));
  if (EMAIL_RE.test(scanned)) labels.unshift("an email address");
  if (labels.length) return labels.map((l) => `[${l}]`).join(" ");
  return clip(s.replace(/\s+/g, " ").trim(), VALUE_CAP);
}

/** The argument keys plus short, redacted values. Never a full body. */
export function summarizeArgs(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object" || Array.isArray(input)) return redactValue(typeof input === "string" ? input : JSON.stringify(input) ?? "");
  const entries = Object.entries(input as Record<string, unknown>);
  const parts: string[] = [];
  for (const [k, v] of entries.slice(0, MAX_KEYS)) {
    const key = k.replace(/[^\w.-]/g, "").slice(0, 40) || "?";
    const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
    parts.push(`${key}=${BODY_KEY.test(key) && s.length ? `[${s.length} chars]` : redactValue(s)}`);
  }
  if (entries.length > MAX_KEYS) parts.push(`+${entries.length - MAX_KEYS} more`);
  return parts.join(", ");
}

export function accessLogPath(vault: string, id: string): string {
  return join(appDir(vault, id), "_log", "access.jsonl");
}

/** Append one access line for a tool call, when the tool maps to a mirrored
 *  app. Returns the app id it logged under, or null. Never throws. */
export function recordAppAccess(
  vault: string,
  toolName: string,
  toolInput: unknown,
  outcome: AccessOutcome,
  ctx: {
    thread?: string; domain?: string; entity?: string; googleAccount?: string; now?: number; apps?: MirrorApp[];
    /** Label -> email (tests inject; default reads the gws profiles). */
    toEmail?: (account: string) => string;
    /** The default account's email for an "all" write (tests inject). */
    writeDefault?: () => string | undefined;
  } = {},
): string | null {
  try {
    const apps = ctx.apps ?? mirrorApps(vault);
    let hit: { appId: string; tool: string; access: AccessKind } | null = null;
    let account: string | undefined;
    if (toolName === GWS_TOOL) {
      // Prevail's google_workspace connector: logged under the Google app whose
      // chat this is, else the mirrored app named for the gws service.
      const input = (toolInput ?? {}) as { args?: unknown; account?: unknown };
      const args = Array.isArray(input.args) ? input.args.filter((x): x is string => typeof x === "string") : [];
      const scoped = ctx.domain?.startsWith(APP_SCOPE_PREFIX) ? ctx.domain.slice(APP_SCOPE_PREFIX.length) : "";
      const svc = (args[0] ?? "").toLowerCase();
      const appId = GOOGLE_APP_RE.test(scoped) ? scoped : svc ? apps.find((a) => a.id.toLowerCase().includes(svc))?.id : undefined;
      if (!appId || !args.length) return null;
      hit = { appId, tool: "google_workspace", access: classifyGwsCommand(args).kind };
      // The account the connector actually targets (gws-mcp's rules), as an email.
      const argAcct = typeof input.account === "string" ? input.account.trim() : "";
      const picks = (ctx.googleAccount ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const all = picks[0]?.toLowerCase() === "all";
      let target: string | undefined;
      if (hit.access === "write" && all) {
        target = (ctx.writeDefault ?? (() => googleAccounts(appId, { bound: boundGoogleAccountLabel(vault) }).find((a) => a.default && a.via === "gws")?.id))();
      } else if (hit.access === "write" && picks.length === 1) target = picks[0];
      else target = argAcct || (all ? undefined : picks[0]);
      target ||= "default";
      account = (ctx.toEmail ?? ((a: string) => accountEmail(a)))(target);
    } else {
      const h = appToolAccess(apps, toolName);
      if (!h) return null;
      hit = { appId: h.app.id, tool: h.tool, access: h.access };
      if (GOOGLE_APP_RE.test(h.app.id)) account = "claude";
    }
    const line: AccessLine = {
      ts: ctx.now ?? Date.now(),
      tool: hit.tool,
      access: hit.access,
      outcome,
      ...(ctx.thread ? { thread: ctx.thread } : {}),
      ...(ctx.domain ? { domain: ctx.domain } : {}),
      ...(ctx.entity ? { entity: ctx.entity } : {}),
      ...(account ? { account: account.slice(0, 256) } : {}),
      summary: summarizeArgs(toolInput),
    };
    const path = join(productWriteDir(vault, hit.appId), "_log", "access.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    // One write of one short line (O_APPEND); the lock covers the encrypted
    // vault's read-modify-write append.
    const lock = tryAcquireLock(`${path}.lock`);
    try { vappendLine(path, `${JSON.stringify(line)}\n`); } finally { lock?.release(); }
    return hit.appId;
  } catch {
    return null;
  }
}

const GWS_TOOL = "mcp__google_workspace__google_workspace";

export interface AccessFilter { app?: string; domain?: string; entity?: string; thread?: string; account?: string; limit?: number }

/** Matching access lines, newest first, each with its `app`. */
export function readAccessLog(vault: string, f: AccessFilter = {}): (AccessLine & { app: string })[] {
  let ids: string[] = [];
  if (f.app) ids = [f.app];
  else {
    ids = productFolders(vault).map((f) => f.id);
  }
  const out: (AccessLine & { app: string })[] = [];
  for (const id of ids) {
    let raw = "";
    try {
      const p = accessLogPath(vault, id);
      if (!existsSync(p)) continue;
      raw = vreadFile(p);
    } catch { continue; }
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue;
      let o: AccessLine;
      try { o = JSON.parse(l) as AccessLine; } catch { continue; }
      if (typeof o?.ts !== "number" || typeof o.tool !== "string") continue;
      if (f.domain && o.domain !== f.domain) continue;
      if (f.entity && o.entity !== f.entity) continue;
      if (f.thread && o.thread !== f.thread) continue;
      if (f.account && o.account !== f.account) continue;
      out.push({ ...o, app: id });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, f.limit && f.limit > 0 ? f.limit : 200);
}

// ── App chat threads ─────────────────────────────────────────────────────────

export interface AppThread { slug: string; title: string; updated: number; turns: number }

/** The app's own chat threads (data/entities/products/<id>/_scope), newest first. */
export function appThreads(vault: string, id: string): AppThread[] {
  const scope = `_app-${id}`;
  const out: AppThread[] = [];
  for (const [rel, f] of Object.entries(scanLinks(vault).cache.files)) {
    if (f.domain !== scope || f.source !== "thread") continue;
    out.push({ slug: rel.split("/").pop()!.replace(/\.md$/, ""), title: f.title, updated: f.ts, turns: f.turns ?? 0 });
  }
  return out.sort((a, b) => b.updated - a.updated);
}
