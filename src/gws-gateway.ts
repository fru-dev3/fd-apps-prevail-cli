// gws-gateway — the trust boundary between Prevail's agent and the user's
// authenticated Google Workspace CLI (`gws`). ONE rule: reads run live, writes
// are NEVER executed inline. A write is queued to <vault>/_meta/pending_gws.json
// and only ever runs through runGwsApproved() after the user explicitly approves
// it under "Needs you" in the desktop. Anything we cannot positively classify as
// a read defaults to write (queued), so an unknown command can never slip
// through as a silent live mutation.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveGwsBinary, gwsSpawnEnv, resolveDefaultGwsAccount } from "./calendar-sync.ts";
import { auditAction } from "./action-audit.ts";
import { runtimePath } from "./path-safety.ts";

export interface PendingGws {
  id: string;
  domain: string;
  summary: string;
  args: string[];
  ts: number;
  // The Google account (label or config dir) this command targets. Carried
  // through the approval spine so the approved write runs against the same
  // account the read/queue was scoped to. Undefined = the default profile.
  account?: string;
}

export interface GwsResult {
  ok: boolean;
  output?: string;
  error?: string;
}

// Max bytes we hand back as a tool result. gws can emit very large JSON (a full
// inbox page, a calendar listing); 16KB keeps the model's context bounded.
const MAX_OUTPUT = 16 * 1024;

const NOT_INSTALLED = "Google Workspace CLI (gws) is not installed";

// The account label a call effectively ran as, so an auth error can name it.
// Mirrors gwsSpawnEnv's precedence: an explicit account (chip / model arg) wins;
// otherwise the connected default account; otherwise the literal "default".
function effectiveAccountLabel(account?: string): string {
  const a = (account || "").trim();
  if (a && a.toLowerCase() !== "default") return a;
  return resolveDefaultGwsAccount() ?? "default";
}

// An honest, actionable auth/scope failure that names WHICH Google account and
// WHICH service/permission failed and points the user at the Prevail Google panel
// (NOT claude.ai-specific "/mcp" or "claude mcp" advice). `args` gives the service
// (its first token, e.g. "gmail" / "calendar"); `account` is the target account.
export function notAuthedMessage(args: string[], account?: string): string {
  const svc = args[0] ? cap(args[0]) : "Google";
  const acct = effectiveAccountLabel(account);
  return (
    `${svc} could not authenticate as your "${acct}" Google account. ` +
    `You may be signed in, but a permission (scope) this action needs was not granted for that account. ` +
    `Open the Prevail Google panel, re-authorize the "${acct}" account, and approve ALL requested permissions. ` +
    `If it still fails, that account's Google OAuth client is not enabled for this API.`
  );
}

// The first meaningful stderr line from gws (dropping its keyring/diagnostic
// noise), so a genuinely different failure (bad params, quota) is not hidden
// behind the generic auth guidance. Empty when there's nothing useful to add.
function meaningfulStderr(stderr: string): string {
  for (const raw of (stderr || "").split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/keyring backend/i.test(l) || /^using /i.test(l)) continue;
    return l.slice(0, 160);
  }
  return "";
}

// READ method tokens — operations that only observe state.
const READ_TOKENS = new Set([
  "list", "get", "search", "watch", "query", "export",
]);

// READ helper commands (the `+name` shorthands gws exposes). Any `+helper` NOT
// in this set is treated as a write (default-safe), because helpers can compose
// sends / inserts under the hood.
const READ_HELPERS = new Set([
  "+agenda", "+triage", "+standup-report", "+weekly-digest", "+meeting-prep",
]);

// WRITE method tokens — operations that mutate state. Presence of any of these
// (or any unrecognized `+helper`) forces the command onto the approval path.
const WRITE_TOKENS = new Set([
  "insert", "create", "update", "patch", "delete",
  "batchUpdate", "batchModify", "batchDelete",
  "send", "trash", "untrash", "modify", "append",
  "copy", "move", "clear", "import",
]);

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A short, human description of the command for the approval queue + audit log,
// e.g. "Gmail: messages send" or "Calendar: events delete". Stops at the first
// flag so params/values never leak into the summary.
function summarize(args: string[]): string {
  const svc = args[0] ? cap(args[0]) : "Google Workspace";
  const rest: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const t = args[i] ?? "";
    if (t.startsWith("-")) break;
    rest.push(t.replace(/^\+/, ""));
  }
  return rest.length ? `${svc}: ${rest.join(" ")}` : svc;
}

// Classify a gws invocation as a read or a write. Write wins on any ambiguity:
// a recognized write token, an unrecognized `+helper`, or no recognizable method
// token at all all resolve to "write" so nothing mutating runs without approval.
export function classifyGwsCommand(args: string[]): { kind: "read" | "write"; summary: string } {
  const summary = summarize(args);
  let sawRead = false;
  for (const raw of args) {
    if (!raw) continue;
    if (raw.startsWith("+")) {
      // A helper: a known read helper is a read; any other helper is a write.
      if (READ_HELPERS.has(raw)) sawRead = true;
      else return { kind: "write", summary };
      continue;
    }
    if (WRITE_TOKENS.has(raw)) return { kind: "write", summary };
    if (READ_TOKENS.has(raw)) sawRead = true;
  }
  // Only a positively recognized read is a read; otherwise default to write.
  return { kind: sawRead ? "read" : "write", summary };
}

function truncate(out: string): string {
  if (out.length <= MAX_OUTPUT) return out;
  return out.slice(0, MAX_OUTPUT) + "\n…(output truncated)";
}

// Run a READ-only gws command live and return its stdout. Never used for writes
// — the classifier routes those to the pending queue. Resolves the binary,
// spawns, and maps spawn failure / non-zero exit to a friendly error. `account`
// (label or config dir) targets a specific Google account; undefined = default.
export function runGwsRead(args: string[], account?: string): GwsResult {
  const gws = resolveGwsBinary();
  if (!gws) return { ok: false, error: NOT_INSTALLED };
  const run = spawnSync(gws, args, {
    encoding: "utf8",
    env: gwsSpawnEnv(account),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) return { ok: false, error: notAuthedMessage(args, account) };
  if (run.status !== 0) {
    const detail = meaningfulStderr(run.stderr || "");
    const base = notAuthedMessage(args, account);
    return { ok: false, error: detail ? `${base} (details: ${detail})` : base };
  }
  return { ok: true, output: truncate(run.stdout || "") };
}

// ── pending store (plaintext; read by the desktop) ──────────────────────────

function pendingPath(vaultRoot: string): string {
  return join(runtimePath(vaultRoot, "_meta"), "pending_gws.json");
}

export function readPendingGws(vaultRoot: string): PendingGws[] {
  const p = pendingPath(vaultRoot);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is PendingGws =>
      !!x && typeof x === "object" && typeof (x as PendingGws).id === "string" && Array.isArray((x as PendingGws).args));
  } catch {
    return [];
  }
}

function writePending(vaultRoot: string, items: PendingGws[]): void {
  const dir = runtimePath(vaultRoot, "_meta");
  mkdirSync(dir, { recursive: true });
  // PLAINTEXT via node:fs on purpose — the desktop reads this file directly to
  // render the approval queue, so it must not be vault-encrypted.
  writeFileSync(pendingPath(vaultRoot), JSON.stringify(items, null, 2));
}

function shortId(): string {
  return `gws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addPendingGws(
  vaultRoot: string,
  entry: { domain: string; summary: string; args: string[]; account?: string },
): PendingGws {
  const items = readPendingGws(vaultRoot);
  const rec: PendingGws = {
    id: shortId(),
    domain: entry.domain,
    summary: entry.summary,
    args: entry.args,
    ts: Date.now(),
    ...(entry.account && entry.account.trim() ? { account: entry.account.trim() } : {}),
  };
  items.push(rec);
  writePending(vaultRoot, items);
  return rec;
}

export function removePendingGws(vaultRoot: string, id: string): void {
  const items = readPendingGws(vaultRoot);
  const next = items.filter((i) => i.id !== id);
  if (next.length !== items.length) writePending(vaultRoot, next);
}

// Execute an APPROVED write. This is the ONLY path that actually runs a gws
// write: load the queued item by id, run the exact command the user approved,
// append an audit record, drop it from the queue, and return the result. A
// missing id is a no-op error (never runs anything).
export function runGwsApproved(vaultRoot: string, id: string): GwsResult {
  const items = readPendingGws(vaultRoot);
  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "no such pending action" };
  const gws = resolveGwsBinary();
  if (!gws) return { ok: false, error: NOT_INSTALLED };
  // Run against the SAME account the write was queued under (the approval spine
  // preserves it), so an approved send/delete targets the intended account.
  const run = spawnSync(gws, item.args, {
    encoding: "utf8",
    env: gwsSpawnEnv(item.account),
    maxBuffer: 16 * 1024 * 1024,
  });
  let result: GwsResult;
  if (run.error) {
    result = { ok: false, error: notAuthedMessage(item.args, item.account) };
  } else if (run.status !== 0) {
    const detail = meaningfulStderr(run.stderr || "");
    const base = notAuthedMessage(item.args, item.account);
    result = { ok: false, error: detail ? `${base} (details: ${detail})` : base };
  } else {
    result = { ok: true, output: truncate(run.stdout || "") };
  }
  // Durable, redacted record of the approved write and its outcome.
  auditAction(vaultRoot, {
    ts: Date.now(),
    domain: item.domain || "general",
    action: `gws ${item.args.join(" ")}`,
    outcome: result.ok ? "executed" : "error",
    report: item.summary,
  });
  // The action was approved and attempted; clear it from the queue either way.
  removePendingGws(vaultRoot, id);
  return result;
}
