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
  /** Set when the sensitive-egress guard held the action: the pending record
   *  is KEPT so the user can release it with an explicit --allow-sensitive
   *  re-approval. `categories` are honest labels, never the values. */
  held?: { categories: string[] };
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

// The one principled exception to "writes are never executed inline": sending
// TO THE USER'S OWN inbox on a channel the user explicitly configured (the
// briefing "Send to Gmail" delivery). The standing configuration IS the
// approval, and mailing yourself your own digest contacts nobody else. The
// recipient is ALWAYS the account's own address (read live from `gws auth
// status`), never a caller-supplied address, so this can not be repurposed to
// email third parties. Returns a delivery hook (subject, body) => receipt, or
// null when gws is not installed. `account` follows the same never-guess
// resolution the connector uses (label or config dir; undefined = default).
export function gwsSelfEmailHook(account?: string): ((subject: string, body: string, meta?: import("./briefings.ts").DeliveryMeta) => Promise<string>) | null {
  const gws = resolveGwsBinary();
  if (!gws) return null;
  return async (subject: string, body: string, meta?: import("./briefings.ts").DeliveryMeta) => {
    const env = gwsSpawnEnv(account);
    const st = spawnSync(gws, ["auth", "status"], { encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024 });
    let self = "";
    try { self = String((JSON.parse(st.stdout || "{}") as { user?: unknown }).user ?? "").trim(); } catch { /* fall through */ }
    if (!self || !self.includes("@")) throw new Error("could not determine the connected Gmail address to deliver to");
    // Branded notification: render the markdown through the shared template
    // (header, meta row, rendered body, provenance footer) instead of dumping
    // raw markdown into the email. Plain sends were the "wall of text" bug.
    const { renderNotificationEmail } = await import("./notification-email.ts");
    const rendered = renderNotificationEmail(meta ?? { kind: "notification", name: subject }, body);
    const run = spawnSync(gws, ["gmail", "+send", "--to", self, "--subject", rendered.subject, "--body", rendered.html, "--html"], {
      encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024,
    });
    if (run.error || run.status !== 0) {
      throw new Error(meaningfulStderr(run.stderr || "") || "gws send failed");
    }
    return `sent to ${self}`;
  };
}

// Classify a failed gws invocation into an HONEST, actionable error. The old
// behavior blamed authentication for every non-zero exit, which turned a wrong
// argv or a disabled Google API into a fake "scope not granted" story that
// nobody could act on. Exported for tests.
export function classifyGwsFailure(stdoutText: string, stderrText: string, args: string[], account?: string): string {
  // gws prints "Using keyring backend: keyring" on EVERY run - strip that benign
  // banner so the keychain-failure rule below can't misfire on it.
  const strip = (s: string) => s.replace(/using keyring backend:[^\n]*/gi, "");
  stdoutText = strip(stdoutText);
  stderrText = strip(stderrText);
  const all = `${stdoutText}\n${stderrText}`;
  // 1. gws rejected the command itself - an argv problem, not auth. Return the
  //    CLI's own usage message so the model can immediately self-correct.
  if (/unrecognized subcommand|unexpected argument|invalid value|Usage: gws/i.test(all)) {
    const snip = (stderrText || stdoutText).replace(/\s+/g, " ").trim().slice(0, 400);
    return `gws rejected the command (invalid arguments, NOT an auth problem). Fix the args and retry. CLI said: ${snip}`;
  }
  // 2. The Google API is disabled on the user's OAuth client project. This is a
  //    one-click, one-time fix in the Cloud console - name it precisely, with
  //    the activation URL Google itself provides.
  if (/SERVICE_DISABLED|has not been used in project|accessNotConfigured/i.test(all)) {
    const url = all.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/[a-z0-9.\-]+\/overview\?project=\d+/i)?.[0];
    const svc = args[0] ? cap(args[0]) : "This service";
    return `${svc} is blocked at Google, not by sign-in: the ${svc} API is DISABLED on the Google Cloud project behind your OAuth client. One-time fix: open ${url ?? "the Google Cloud console API library for your project"}, click Enable, wait about a minute, then retry. Every connected account on this machine shares that client, so enabling it fixes all of them.`;
  }
  // 3. The macOS Keychain refused gws in THIS execution context. The same
  //    command works in the user's Terminal, so name the context problem
  //    precisely instead of blaming the account.
  if (/keyring|keychain|errSec|SecKeychain|no such credential|failed to (read|get|load).*(token|credential)/i.test(all)) {
    return (
      `gws could not read its saved token from the macOS Keychain when launched from the app (it works in Terminal, where the Keychain grants access). ` +
      `This is a machine trust setting, not a Google problem: open Keychain Access, find the gws item, and allow access - or re-run 'gws auth login' once from Terminal and approve "Always Allow" when the Keychain prompts.`
    );
  }
  // 4. A genuine permission/scope refusal for this account.
  if (/insufficient.*scope|invalid_scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(all)) {
    return notAuthedMessage(args, account);
  }
  // 4. Unknown: keep the auth guidance but ALWAYS carry the real detail.
  const detail = (meaningfulStderr(stderrText) || stdoutText.replace(/\s+/g, " ").trim()).slice(0, 300);
  const base = notAuthedMessage(args, account);
  return detail ? `${base} (details: ${detail})` : base;
}

// Run a READ-only gws command live and return its stdout. Never used for writes
// — the classifier routes those to the pending queue. Resolves the binary,
// spawns, and maps failures through classifyGwsFailure so the error names the
// REAL cause (bad argv / disabled API / scope / unknown-with-detail). `account`
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
    return { ok: false, error: classifyGwsFailure(run.stdout || "", run.stderr || "", args, account) };
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
export function runGwsApproved(vaultRoot: string, id: string, opts?: { allowSensitive?: boolean }): GwsResult {
  const items = readPendingGws(vaultRoot);
  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "no such pending action" };
  const gws = resolveGwsBinary();
  if (!gws) return { ok: false, error: NOT_INSTALLED };
  // GLOBAL EMAIL GUARDRAIL - enforced HERE, at execution, so approval taps and
  // prompt phrasing can never route mail to a third party. Per the user's
  // policy, an external-recipient send is refused or downgraded to a DRAFT.
  const { applyEmailPolicy, selfAddresses } = require("./email-policy.ts") as typeof import("./email-policy.ts");
  const decision = applyEmailPolicy(item.args);
  if (decision.action === "refuse") {
    const refused: GwsResult = { ok: false, error: decision.reason };
    auditAction(vaultRoot, {
      ts: Date.now(), domain: item.domain, action: item.summary,
      outcome: "blocked_by_email_policy", report: decision.reason,
    });
    removePendingGws(vaultRoot, id);
    return refused;
  }
  // SENSITIVE EGRESS GUARD - the second, independent dial: WHAT the content
  // may contain, after the email policy decided WHO may receive it. Runs on
  // the post-email-policy argv (so a third-party send already downgraded to a
  // draft counts as self and passes: a draft never leaves the account).
  // docs/sensitive-egress-guard.md. Enforced here so every surface - chat,
  // loops, agents, desktop approvals, the CLI - hits the same gate.
  const { applyEgressGuardToGws } = require("./egress-guard.ts") as typeof import("./egress-guard.ts");
  const guard = applyEgressGuardToGws(decision.args, selfAddresses(), opts?.allowSensitive === true);
  let execArgs = decision.args;
  let egressNote = "";
  if (guard.action === "hold") {
    const isGmailSend = (decision.args[0] ?? "").toLowerCase() === "gmail";
    if (isGmailSend && !guard.unscannable) {
      // Gmail's release valve is built in: hold the mail as a DRAFT. Pressing
      // Send in Gmail IS the user's approval of the exact content.
      if (!execArgs.includes("--draft")) execArgs = [...execArgs, "--draft"];
      egressNote = `${guard.reason}. Saved as a DRAFT for you to review and send yourself.\n`;
    } else {
      // No draft equivalent (calendar invite, document share): refuse, keep
      // the pending record, and tell the user exactly how to release it.
      const message = `${guard.reason}. The action was NOT run. To release it exactly as written, re-approve with sensitive info allowed (gws run --id ${id} --allow-sensitive).`;
      auditAction(vaultRoot, {
        ts: Date.now(), domain: item.domain, action: item.summary,
        outcome: "blocked_by_egress_guard", report: message,
      });
      return { ok: false, error: message, held: { categories: guard.categories } };
    }
  }
  // Run against the SAME account the write was queued under (the approval spine
  // preserves it), so an approved send/delete targets the intended account.
  const run = spawnSync(gws, execArgs, {
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
    const note = (decision.action === "draft" ? `${decision.reason}\n` : "") + egressNote;
    result = { ok: true, output: truncate(note + (run.stdout || "")) };
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
