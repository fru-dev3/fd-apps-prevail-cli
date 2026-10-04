// sources-mcp: the stdio MCP server that gives the agent read-only access to
// the user's knowledge sources (knowledge-sources.ts): list_sources,
// read_source and query_database. Injected on engine turns (agent-mcp.ts) when
// this Mac trusts at least one source. Every limit is enforced by the readers
// (source-readers.ts), never by this server's descriptions.
//
// Protocol: the same hand-rolled JSON-RPC 2.0 over stdio as acts-mcp.ts.
// stdout is reserved for JSON-RPC frames; all logging goes to stderr.

import { existsSync } from "node:fs";
import { VERSION } from "./version.ts";
import { SOURCE_TOOLS, sourceToolCall } from "./knowledge-sources.ts";

interface JsonRpcReq { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: unknown }

const log = (line: string) => process.stderr.write(`[prevail-sources-mcp] ${line}\n`);
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

export async function sourcesMcpDispatch(req: JsonRpcReq, vault: string): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return { protocolVersion: "2024-11-05", serverInfo: { name: "prevail-sources", version: VERSION }, capabilities: { tools: {} } };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { tools: SOURCE_TOOLS };
    case "tools/call": {
      const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = p.name ?? "";
      if (!SOURCE_TOOLS.some((t) => t.name === name)) throw new Error(`unknown tool: ${name}`);
      return { content: [{ type: "text", text: await sourceToolCall(vault, name, p.arguments ?? {}) }] };
    }
    case "ping":
      return {};
    default:
      throw new Error(`method not found: ${req.method}`);
  }
}

export async function runSourcesMcpServer(vault: string): Promise<void> {
  if (!existsSync(vault)) { log(`vault not found: ${vault}`); process.exit(1); }
  log(`starting · vault=${vault} · stdio`);
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = async (line: string) => {
    let req: JsonRpcReq;
    try { req = JSON.parse(line) as JsonRpcReq; } catch { log(`malformed JSON-RPC: ${line.slice(0, 200)}`); return; }
    const id = req.id ?? null;
    try {
      const result = await sourcesMcpDispatch(req, vault);
      if (req.id !== undefined && req.id !== null) send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message ?? "tool error" } });
    }
  };
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) await handle(line);
    }
  }
  if (buffer.trim()) await handle(buffer.trim());
}
