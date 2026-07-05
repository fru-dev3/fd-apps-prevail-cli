// gws-mcp — a minimal stdio MCP server exposing ONE gated tool,
// `google_workspace`, to Prevail's agent. It fronts the user's authenticated
// `gws` CLI: reads run live and return data, writes are queued for the user's
// explicit approval (and only ever run later through runGwsApproved). The agent
// is taught — in the tool description — that it must never try to perform a
// write another way.
//
// Protocol: the same hand-rolled JSON-RPC 2.0 over stdio as mcp-server.ts
// (initialize -> {protocolVersion, serverInfo, capabilities:{tools:{}}};
// tools/list -> {tools}; tools/call -> {content}; ping). stdout is reserved for
// JSON-RPC frames; ALL logging goes to stderr.

import { existsSync } from "node:fs";
import { VERSION } from "./version.ts";
import { classifyGwsCommand, runGwsRead, addPendingGws } from "./gws-gateway.ts";
import { resolveGwsAccounts } from "./calendar-sync.ts";
import { boundGoogleAccountLabel } from "./vault.ts";
import { runGwsDoctor } from "./gws-doctor.ts";

// Default app-binding lookup (separated so tests can inject a stub).
function defaultBoundLookup(vault: string): string | undefined {
  return boundGoogleAccountLabel(vault);
}

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcRes {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

interface McpContent {
  type: "text";
  text: string;
}

const SERVER_INFO = { name: "prevail-gws", version: VERSION };
const PROTOCOL_VERSION = "2024-11-05";

function log(line: string): void {
  process.stderr.write(`[prevail-gws-mcp] ${line}\n`);
}

function send(msg: JsonRpcRes): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const TOOL_DESCRIPTION =
  "Run Google Workspace operations through the user's authenticated gws CLI (Gmail, Drive, Calendar, Docs, Sheets, Tasks). " +
  "Pass `args` exactly as you would to `gws`. Grammar: helper commands start with '+' (the easiest path); raw API resources use '<service> <resource> <method>'. " +
  "Known-good reads: [\"calendar\",\"+agenda\"] (upcoming events across calendars); [\"calendar\",\"events\",\"list\",\"--calendar-id\",\"primary\"]; [\"calendar\",\"calendarList\",\"list\"]; [\"gmail\",\"+triage\"] (unread inbox summary); [\"gmail\",\"+read\",\"--id\",\"<msgId>\"]. " +
  "Writes look like [\"gmail\",\"+send\",\"--to\",...,\"--subject\",...,\"--body\",...] or [\"calendar\",\"+insert\",...]. " +
  "There is NO '<service> <resource> list' shortcut like [\"calendar\",\"calendars\",\"list\"] - if gws rejects your args it returns its usage text: read it and correct the args, do NOT conclude an auth failure. " +
  "READS run immediately and return data. " +
  "WRITES (send, insert, update, delete, modify, trash) are NOT executed - they are queued for the user's explicit approval and run only after the user approves. " +
  "Never try to perform writes another way.";

function tools(): McpTool[] {
  return [
    {
      name: "google_workspace_doctor",
      description:
        "Self-diagnose the Google connection end to end: for EVERY connected account, reports identity, token health, granted scopes per service, and whether each Google API is enabled on the OAuth project - with the exact remedial action for anything broken. Call this FIRST whenever a google_workspace call fails (or before starting multi-account Google work), instead of retrying blind variations. Read-only, takes no arguments.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "google_workspace",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          args: {
            type: "array",
            items: { type: "string" },
            description: "The gws argument vector, e.g. [\"gmail\",\"+triage\"] or [\"calendar\",\"events\",\"list\",\"--params\",\"{...}\"].",
          },
          domain: {
            type: "string",
            description: "Optional life-domain context for the approval record (defaults to the launch --domain or \"general\").",
          },
          account: {
            type: "string",
            description: "Optional Google account to target: a profile label (e.g. \"work\") or the literal \"default\". Omit to use the account the user selected for this session; if none was selected and exactly one account is connected, that one is used. If none was selected and MULTIPLE accounts are connected, the call is refused with the connected labels - ask the user which account to use and retry with it here. Reads run against it; queued writes run against the same account after approval.",
          },
        },
        required: ["args"],
      },
    },
  ];
}

function wrapText(s: string): McpContent[] {
  return [{ type: "text", text: s }];
}

// The single tool handler: classify, then either run the read live or queue the
// write for approval. Never runs a write inline.
export function callGoogleWorkspace(
  rawArgs: Record<string, unknown>,
  vaultPath: string,
  defaultDomain: string,
  defaultAccount: string | undefined,
  // Injectable so tests can pin the machine's connected-profile state and the
  // app-binding lookup; production callers use the live resolution.
  resolveAccounts: typeof resolveGwsAccounts = resolveGwsAccounts,
  lookupBoundAccount: (vault: string) => string | undefined = defaultBoundLookup,
): McpContent[] {
  const argsIn = rawArgs.args;
  if (!Array.isArray(argsIn) || argsIn.some((a) => typeof a !== "string") || argsIn.length === 0) {
    return wrapText("Error: `args` must be a non-empty array of strings (the gws argument vector).");
  }
  const args = argsIn as string[];
  const domain = (typeof rawArgs.domain === "string" && rawArgs.domain.trim())
    ? rawArgs.domain.trim()
    : defaultDomain;
  // Account precedence: an explicit tool-arg account (the model's per-action
  // override, e.g. a deliberate cross-account send) wins; otherwise the launched
  // --account (the user's chip selection, threaded from the composer) is the
  // authoritative default; otherwise undefined. When it stays undefined, the
  // resolution is strict: exactly one connected account is used automatically
  // (gwsSpawnEnv/resolveDefaultGwsAccount); with several connected the call is
  // refused below rather than guessed, so Prevail never acts as the wrong
  // identity. This is what makes the chip selection binding even when the model
  // passes no `account`.
  let account = (typeof rawArgs.account === "string" && rawArgs.account.trim())
    ? rawArgs.account.trim()
    : defaultAccount;
  // Never guess between identities: when NO account was picked (no tool-arg, no
  // composer chip) and this machine has MORE THAN ONE connected Google account,
  // refuse with the connected labels instead of silently acting as one of them.
  // Machine-agnostic - the labels come from whatever gws profiles exist here.
  // With zero or one account connected the resolution is unambiguous and nothing
  // changes. Applies to reads AND writes (a read against the wrong inbox leaks
  // the wrong person's data; a write is worse). One standing choice does count:
  // the Google APP's account binding (manifest.account) - the user explicitly
  // bound the app to that identity, so headless callers (loop act runs) resolve
  // through it instead of dead-ending where nobody can answer a question.
  if (!account) {
    const res = resolveAccounts();
    if (res.kind === "ambiguous") {
      const bound = lookupBoundAccount(vaultPath);
      if (bound && res.labels.includes(bound)) {
        account = bound;
      } else {
        return wrapText(
          `Error: multiple Google accounts are connected on this machine (${res.labels.join(", ")}) and none was picked, so nothing was run. ` +
          `Ask the user which account to use, then retry with account:"<label>" - or the user can pick account(s) under Modes in the composer, ` +
          `or bind the Google app to an account under its settings (Account identity) to make the choice standing.`,
        );
      }
    }
  }

  const { kind, summary } = classifyGwsCommand(args);
  if (kind === "read") {
    const r = runGwsRead(args, account);
    if (r.ok) return wrapText(r.output ?? "(no output)");
    // Point the agent at self-diagnosis instead of blind retry variations.
    return wrapText(`Error: ${r.error ?? "gws read failed"} (To diagnose all accounts/services at once, call the google_workspace_doctor tool.)`);
  }
  // Write: queue it (with its target account). NEVER execute here.
  const rec = addPendingGws(vaultPath, { domain, summary, args, account });
  // Transparency: if the global email guardrail will refuse or draft this at
  // execution, say so NOW so the model can tell the user honestly.
  let guardNote = "";
  try {
    const { applyEmailPolicy, selfAddresses } = require("./email-policy.ts") as typeof import("./email-policy.ts");
    const d = applyEmailPolicy(args);
    if (d.action !== "allow") guardNote = ` NOTE: ${d.reason}`;
    const { applyEgressGuardToGws } = require("./egress-guard.ts") as typeof import("./egress-guard.ts");
    const g = applyEgressGuardToGws(d.args, selfAddresses());
    if (g.action === "hold") guardNote += ` NOTE: ${g.reason}.`;
  } catch { /* policy check is advisory here; execution enforces */ }
  return wrapText(
    `Queued for your approval: ${summary}. ` +
    `It will run only after you approve it under Needs you. ` +
    `Command: gws ${args.join(" ")}. (id ${rec.id})${guardNote}`,
  );
}

function dispatch(
  req: JsonRpcReq,
  vaultPath: string,
  defaultDomain: string,
  defaultAccount: string | undefined,
): unknown {
  switch (req.method) {
    case "initialize": {
      const p = (req.params ?? {}) as { clientInfo?: { name?: string } };
      log(`client: ${p.clientInfo?.name ?? "(unknown)"}`);
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };
    }
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { tools: tools() };
    case "tools/call": {
      const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = p.name ?? "";
      if (name === "google_workspace_doctor") {
        return { content: wrapText(runGwsDoctor()) };
      }
      if (name !== "google_workspace") throw new Error(`unknown tool: ${name}`);
      const content = callGoogleWorkspace(p.arguments ?? {}, vaultPath, defaultDomain, defaultAccount);
      // Honest failure signaling: an "Error: ..." text result IS a failed call.
      // Setting isError makes the runtime mark the tool_result failed, so the
      // step checklist shows a red step with the reason instead of a green
      // check over an error string.
      const failed = content.some((c) => typeof c.text === "string" && c.text.startsWith("Error:"));
      return failed ? { content, isError: true } : { content };
    }
    case "ping":
      return {};
    default:
      throw new Error(`method not found: ${req.method}`);
  }
}

async function* readStdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

export async function runGwsMcpServer(vaultPath: string, domain?: string, account?: string): Promise<void> {
  if (!existsSync(vaultPath)) {
    log(`vault not found: ${vaultPath}`);
    process.exit(1);
  }
  const defaultDomain = (domain && domain.trim()) ? domain.trim() : "general";
  // The launched --account (the user's chip selection). ANY pick - including the
  // literal "default" - is an explicit choice and is honored verbatim (it
  // bypasses the multi-account "never guess" refusal in callGoogleWorkspace;
  // gwsSpawnEnv maps "default" to the default profile dir). A comma-joined
  // multi-pick targets its first entry by default; the model can override
  // per-action with the `account` tool-arg for cross-account fan-out.
  const rawAccount = (account && account.trim()) ? account.trim() : undefined;
  const defaultAccount = rawAccount ? (rawAccount.split(",")[0]!.trim() || undefined) : undefined;
  log(`starting · vault=${vaultPath} · domain=${defaultDomain} · account=${defaultAccount ?? "(default)"} · stdio`);

  for await (const line of readStdinLines()) {
    let req: JsonRpcReq;
    try {
      req = JSON.parse(line) as JsonRpcReq;
    } catch {
      log(`malformed JSON-RPC: ${line.slice(0, 200)}`);
      continue;
    }
    const id = req.id ?? null;
    try {
      const result = dispatch(req, vaultPath, defaultDomain, defaultAccount);
      if (req.id !== undefined && req.id !== null) {
        send({ jsonrpc: "2.0", id, result });
      }
    } catch (err) {
      const e = err as Error;
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message ?? "tool error" } });
    }
  }
}
