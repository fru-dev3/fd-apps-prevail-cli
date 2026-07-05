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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// ── The gate itself (what the PreToolUse hook calls) ─────────────────────────
export interface GateDecision {
  action: "allow" | "deny";
  reason?: string;
}

export function gateToolCall(vault: string, domain: string, toolName: string, toolInput: unknown): GateDecision {
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
export function actGateSettingsPath(vault: string, domain: string): string {
  const dir = join(homedirSafe(), ".prevail", "act-gate");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(`${vault}\n${domain}`).digest("hex").slice(0, 12);
  const path = join(dir, `${key}.json`);
  const q = (v: string) => `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
  const command = `${q(process.execPath)} act-gate-hook --vault ${q(vault)} --domain ${q(domain)}`;
  const settings = { hooks: { PreToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command }] }] } };
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
export async function runActGateHook(vault: string, domain: string): Promise<void> {
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
    decision = gateToolCall(vault, domain, toolName, toolInput);
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
