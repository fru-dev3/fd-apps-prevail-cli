import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { detectClis, runChatTurn } from "./cli-bridge.ts";
import { scanVault, type Domain } from "./vault.ts";
import { buildCouncilPanel, runCouncilOneShot } from "./council-runner.ts";
import { writeTurnSummary } from "./auto-summary.ts";
import { VERSION } from "./version.ts";

// Minimal MCP server (Model Context Protocol). Speaks JSON-RPC 2.0 over
// stdio — the standard transport every MCP client (Claude Desktop, Cursor,
// Continue, Goose, ChatGPT Desktop with MCP) speaks. No SDK dependency:
// the protocol is small enough that hand-rolling it is cleaner than
// pulling in @modelcontextprotocol/sdk and keeping it pinned.
//
// What we expose: prevAIl's intelligence layer (council, vault domains,
// state, briefings) as MCP tools. The host LLM does the chat UX; we
// provide the parallel-models + vault-aware reasoning.
//
// Stdio rules: stdin lines are JSON-RPC requests, stdout lines are JSON-RPC
// responses. ALL logging goes to stderr (anything on stdout that isn't
// valid JSON-RPC crashes the client). No exceptions.

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

const SERVER_INFO = {
  name: "prevail",
  version: VERSION,
};

const PROTOCOL_VERSION = "2024-11-05";

function log(line: string): void {
  process.stderr.write(`[prevail-mcp] ${line}\n`);
}

function send(msg: JsonRpcRes | { jsonrpc: "2.0"; method: string; params?: unknown }): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

export async function runMcpServer(vaultPath: string): Promise<void> {
  if (!existsSync(vaultPath)) {
    log(`vault not found: ${vaultPath}`);
    process.exit(1);
  }
  log(`starting · vault=${vaultPath}`);

  const tools: McpTool[] = [
    {
      name: "council",
      description:
        "Run a council across Claude, Codex, Gemini, and local Ollama in parallel for a high-stakes question. Returns a synthesized verdict that explicitly surfaces where the panel disagreed. Use for decisions where one model's answer would be a single point of view (financial, medical, career, contract review).",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The question to ask the panel." },
          domain: { type: "string", description: "Life domain context (wealth, health, tax, etc.) — must match a folder in the vault." },
        },
        required: ["prompt", "domain"],
      },
    },
    {
      name: "chat",
      description: "Single-CLI chat turn against the named engine. Faster + cheaper than council for routine questions. Returns the assistant reply as a string.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          domain: { type: "string" },
          cli: { type: "string", description: "claude | codex | gemini | ollama" },
          model: { type: "string", description: "Optional model name; defaults to the CLI's default." },
        },
        required: ["prompt", "domain"],
      },
    },
    {
      name: "list_domains",
      description: "List all life domains in the vault with their open-loop count and last-modified timestamp.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "read_state",
      description: "Read the state.md for a given domain. Returns the raw markdown.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
      },
    },
    {
      name: "read_log",
      description: "Read today's _log/YYYY-MM-DD.md for a domain — the self-curating decision log written by prevAIl after every turn.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          date: { type: "string", description: "Optional YYYY-MM-DD; defaults to today." },
        },
        required: ["domain"],
      },
    },
  ];

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
      const result = await dispatch(req, tools, vaultPath);
      // Notifications have id=null and expect no response.
      if (req.id !== undefined && req.id !== null) {
        send({ jsonrpc: "2.0", id, result });
      }
    } catch (err) {
      const e = err as Error;
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: e.message ?? "tool error" },
      });
    }
  }
}

async function dispatch(req: JsonRpcReq, tools: McpTool[], vaultPath: string): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };
    case "notifications/initialized":
      // Spec-required notification from the client after init. No response.
      return undefined;
    case "tools/list":
      return { tools };
    case "tools/call": {
      const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = p.name ?? "";
      const args = p.arguments ?? {};
      const content = await callTool(name, args, vaultPath);
      return { content };
    }
    case "ping":
      return {};
    default:
      throw new Error(`method not found: ${req.method}`);
  }
}

interface McpContent {
  type: "text";
  text: string;
}

async function callTool(name: string, args: Record<string, unknown>, vaultPath: string): Promise<McpContent[]> {
  switch (name) {
    case "council":
      return wrapText(await tCouncil(args, vaultPath));
    case "chat":
      return wrapText(await tChat(args, vaultPath));
    case "list_domains":
      return wrapText(tListDomains(vaultPath));
    case "read_state":
      return wrapText(tReadState(args, vaultPath));
    case "read_log":
      return wrapText(tReadLog(args, vaultPath));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function wrapText(s: string): McpContent[] {
  return [{ type: "text", text: s }];
}

function resolveDomain(vaultPath: string, name: unknown): Domain {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("domain (string) is required");
  }
  const domains = scanVault(vaultPath);
  const found = domains.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`domain "${name}" not found in vault`);
  return found;
}

async function tCouncil(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt is required");
  const domain = resolveDomain(vaultPath, args.domain);
  const clis = await detectClis();
  if (clis.length === 0) throw new Error("no CLIs detected on the daemon host");
  const panel = buildCouncilPanel(clis);
  if (panel.length === 0) throw new Error("council panel empty (check /council config)");
  const r = await runCouncilOneShot({ prompt, cwd: domain.path, panelists: panel, vaultPath });
  // Write to the vault's self-curating log so the MCP-invoked council
  // call is indistinguishable from a TUI/Telegram one when the user
  // greps their history later.
  if (r.verdict && !r.verdict.startsWith("(")) {
    writeTurnSummary({
      domainPath: domain.path,
      userPrompt: prompt,
      assistantReply: r.verdict,
      cliLabel: `Council ⚖ ${r.chairLabel} (via mcp)`,
      ts: Date.now(),
      kind: "council-verdict",
    });
  }
  const panelLines = r.panel.map((p) => {
    const tag = p.model ? `${p.cli.label}·${p.model}` : p.cli.label;
    return `### ${tag}\n${p.reply}`;
  });
  return [
    `# Council verdict`,
    "",
    r.verdict,
    "",
    "---",
    "## Panel responses",
    "",
    ...panelLines,
    "",
    `chair: ${r.chairLabel}${r.degraded ? " · ⚠ degraded (single provider)" : ""}`,
  ].join("\n");
}

async function tChat(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt is required");
  const domain = resolveDomain(vaultPath, args.domain);
  const clis = await detectClis();
  if (clis.length === 0) throw new Error("no CLIs detected");
  const wantKind = typeof args.cli === "string" ? args.cli : "claude";
  const cli = clis.find((c) => c.kind === wantKind) ?? clis[0]!;
  const model = typeof args.model === "string" ? args.model : "";
  const reply = await runChatTurn({
    prompt,
    cwd: domain.path,
    cli,
    model,
    isFirst: true,
    bare: true,
  });
  writeTurnSummary({
    domainPath: domain.path,
    userPrompt: prompt,
    assistantReply: reply,
    cliLabel: model ? `${cli.label}·${model} (via mcp)` : `${cli.label} (via mcp)`,
    ts: Date.now(),
    kind: "chat",
  });
  return reply;
}

function tListDomains(vaultPath: string): string {
  const domains = scanVault(vaultPath);
  if (domains.length === 0) return "no domains in vault";
  const lines = ["domain | open loops | last update", "--- | --- | ---"];
  for (const d of domains) {
    const updated = d.stateMtime ? new Date(d.stateMtime).toISOString().slice(0, 10) : "(no state)";
    lines.push(`${d.name} | ${d.openLoopCount} | ${updated}`);
  }
  return lines.join("\n");
}

function tReadState(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const f = join(domain.path, "state.md");
  if (!existsSync(f)) return `(no state.md for ${domain.name})`;
  return readFileSync(f, "utf8");
}

function tReadLog(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date)
    ? args.date
    : new Date().toISOString().slice(0, 10);
  const f = join(domain.path, "_log", `${date}.md`);
  if (!existsSync(f)) return `(no log for ${domain.name} on ${date})`;
  return readFileSync(f, "utf8");
}

// Async iterator over stdin lines. Bun + Node both support this via the
// stdin readable stream — we just split on newlines and yield each one.
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
