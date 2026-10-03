// Domain scope for MCP sessions (agent mesh, Steps 2 and 4).
//
// A session declares its domain (PREVAIL_DOMAIN over stdio, the endpoint path
// on the hub) and gets that domain's permissions, checked here in code before
// any tool runs:
// - its own domain's tools, with `domain` forced to its own;
// - a few read-only tools about the whole vault (the domain list, the Compass);
// - add_task into ANOTHER domain only as a handoff ("From <domain>: ...");
// - nothing else. The chief of staff's home (General) sees everything.

import { formatHandoff } from "./agent-contract.ts";
import { isDomainFolderName } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";

export const CHIEF_SCOPE = "general";

/** Tools a domain session runs against its own domain only. */
const OWN = new Set([
  "council", "chat", "read_state", "read_log", "read_intents", "read_decisions", "check_alignment",
  "tell", "hand_off", "read_surface", "read_memory", "list_tasks", "update_task", "log_decision",
  "list_loops", "run_loop",
]);
/** Read-only tools any domain may call. */
const OPEN = new Set(["list_domains", "list_specialists", "read_compass", "list_playbooks"]);

export type ScopeVerdict = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** The scope a session declared, or null for an unscoped (owner's own) session. */
export function scopeFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const d = (env.PREVAIL_DOMAIN ?? "").trim().toLowerCase();
  return d || null;
}

export function validScope(vault: string, scope: string): boolean {
  return isDomainFolderName(scope) && listDomainDirs(vault).includes(scope);
}

export function toolAllowed(scope: string | null, name: string): boolean {
  if (!scope || scope === CHIEF_SCOPE) return true;
  return OWN.has(name) || OPEN.has(name) || name === "add_task";
}

export function scopedTools<T extends { name: string }>(scope: string | null, tools: T[]): T[] {
  return tools.filter((t) => toolAllowed(scope, t.name));
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Check one tool call against the session's scope and return the arguments it
 * may run with. Never widens: a scoped call can only lose freedom here.
 */
export function scopeToolCall(vault: string, scope: string | null, name: string, args: Record<string, unknown>): ScopeVerdict {
  if (!scope || scope === CHIEF_SCOPE) return { ok: true, args };
  if (!validScope(vault, scope)) return { ok: false, error: `unknown scope "${scope}": PREVAIL_DOMAIN must name a domain in this vault` };
  if (!toolAllowed(scope, name)) return { ok: false, error: `${name} is not open to the ${scope} agent; ask the chief of staff (General)` };
  if (OPEN.has(name)) return { ok: true, args };
  const asked = str(args.domain).toLowerCase();
  if (name === "add_task" && asked && asked !== scope) {
    if (!listDomainDirs(vault).includes(asked)) return { ok: false, error: `no domain "${asked}"` };
    try {
      const text = formatHandoff({ from: scope, event: str(args.text), amount: str(args.amount) || undefined, date: str(args.date) || undefined, source: str(args.source) || undefined });
      return { ok: true, args: { ...args, domain: asked, text } };
    } catch (e) {
      return { ok: false, error: `handoff refused: ${(e as Error).message}` };
    }
  }
  if (asked && asked !== scope) return { ok: false, error: `the ${scope} agent reads and writes only ${scope}; for ${asked}, hand off with add_task` };
  if (str(args.mission)) return { ok: false, error: `the ${scope} agent cannot act inside a project; ask the chief of staff` };
  return { ok: true, args: { ...args, domain: scope } };
}
