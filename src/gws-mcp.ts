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
  "Pass `args` exactly as you would to `gws` (e.g. [\"gmail\",\"+triage\"] or [\"calendar\",\"events\",\"list\",\"--params\",\"{...}\"]). " +
  "READS run immediately and return data. " +
  "WRITES (send, insert, update, delete, modify, trash) are NOT executed - they are queued for the user's explicit approval and run only after the user approves. " +
  "Never try to perform writes another way.";

function tools(): McpTool[] {
  return [
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
function callGoogleWorkspace(
  rawArgs: Record<string, unknown>,
  vaultPath: string,
  defaultDomain: string,
): McpContent[] {
  const argsIn = rawArgs.args;
  if (!Array.isArray(argsIn) || argsIn.some((a) => typeof a !== "string") || argsIn.length === 0) {
    return wrapText("Error: `args` must be a non-empty array of strings (the gws argument vector).");
  }
  const args = argsIn as string[];
  const domain = (typeof rawArgs.domain === "string" && rawArgs.domain.trim())
    ? rawArgs.domain.trim()
    : defaultDomain;

  const { kind, summary } = classifyGwsCommand(args);
  if (kind === "read") {
    const r = runGwsRead(args);
    if (r.ok) return wrapText(r.output ?? "(no output)");
    return wrapText(`Error: ${r.error ?? "gws read failed"}`);
  }
  // Write: queue it. NEVER execute here.
  const rec = addPendingGws(vaultPath, { domain, summary, args });
  return wrapText(
    `Queued for your approval: ${summary}. ` +
    `It will run only after you approve it under Needs you. ` +
    `Command: gws ${args.join(" ")}. (id ${rec.id})`,
  );
}

function dispatch(
  req: JsonRpcReq,
  vaultPath: string,
  defaultDomain: string,
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
      if (name !== "google_workspace") throw new Error(`unknown tool: ${name}`);
      return { content: callGoogleWorkspace(p.arguments ?? {}, vaultPath, defaultDomain) };
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

export async function runGwsMcpServer(vaultPath: string, domain?: string): Promise<void> {
  if (!existsSync(vaultPath)) {
    log(`vault not found: ${vaultPath}`);
    process.exit(1);
  }
  const defaultDomain = (domain && domain.trim()) ? domain.trim() : "general";
  log(`starting · vault=${vaultPath} · domain=${defaultDomain} · stdio`);

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
      const result = dispatch(req, vaultPath, defaultDomain);
      if (req.id !== undefined && req.id !== null) {
        send({ jsonrpc: "2.0", id, result });
      }
    } catch (err) {
      const e = err as Error;
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message ?? "tool error" } });
    }
  }
}
