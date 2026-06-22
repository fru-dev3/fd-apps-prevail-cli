import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { detectClis, runChatTurn } from "./cli-bridge.ts";
import { scanVault, type Domain } from "./vault.ts";
import { buildCouncilPanel, runCouncilOneShot } from "./council-runner.ts";
import { classifyAsCouncilWorthy } from "./auto-council.ts";
import { readAutoCouncil } from "./config.ts";
import { writeTurnSummary } from "./auto-summary.ts";
import { appendDecision, readDecisions, domainDir, runtimeFile } from "./decisions.ts";
import { buildRecommendations } from "./recommendations.ts";
import { runSurface } from "./surface.ts";
import { readTasks, setTaskStatus, effectiveStatus } from "./tasks.ts";
import { appendTask } from "./daemon-loops.ts";
import { vappendLine } from "./vault-session.ts";
import { VERSION } from "./version.ts";
import { mcpConfigPath, readOrCreateMcpToken } from "./mcp-config.ts";

// Minimal MCP server (Model Context Protocol). Speaks JSON-RPC 2.0 over
// stdio - the standard transport every MCP client (Claude Desktop, Cursor,
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

export interface McpServerOptions {
  // Skip the parent-process safety check. Lets the server boot from cron,
  // launchd, systemd, or any detached parent - the user is explicitly
  // taking responsibility for the trust boundary.
  unsafeDetach?: boolean;
  // MCP-1: require the per-request `_meta.authorization` token. This is a
  // NETWORK control - meaningful only when the server is exposed beyond the
  // local stdio pipe. Over plain stdio the OS process boundary plus
  // verifyParentProcess() already secure the channel, and generic stdio
  // clients (Claude Code, Codex, Gemini CLI) can't attach the token, so
  // requiring it there just breaks them. Default: false (stdio).
  network?: boolean;
}

export async function runMcpServer(
  vaultPath: string,
  opts: McpServerOptions = {},
): Promise<void> {
  if (!existsSync(vaultPath)) {
    log(`vault not found: ${vaultPath}`);
    process.exit(1);
  }

  // Parent-process verification. Refuse to run when the parent isn't a
  // TTY and isn't a known IDE / MCP-host binary - the typical case for
  // "something unexpected started the server" (cron, launchd, an
  // attacker-controlled wrapper). The user can override with
  // --unsafe-detach when they actually want a detached launch.
  if (!opts.unsafeDetach) {
    const verdict = verifyParentProcess();
    if (!verdict.ok) {
      log(verdict.message);
      process.exit(1);
    }
  }

  // Read (or create) the persisted auth token. Only ENFORCED in network mode
  // (see McpServerOptions.network); over stdio the token is not required so
  // generic stdio clients work out of the box.
  const requireToken = !!opts.network;
  const token = readOrCreateMcpToken();

  log(`starting · vault=${vaultPath}${requireToken ? " · network (token required)" : " · stdio"}`);

  const tools: McpTool[] = [
    {
      name: "council",
      description:
        "Run a council across Claude, Codex, Antigravity, and local Ollama in parallel for a high-stakes question. Returns a synthesized verdict that explicitly surfaces where the panel disagreed. Use for decisions where one model's answer would be a single point of view (financial, medical, career, contract review).",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The question to ask the panel." },
          domain: { type: "string", description: "Life domain context (wealth, health, tax, etc.) - must match a folder in the vault." },
        },
        required: ["prompt", "domain"],
      },
    },
    {
      name: "chat",
      description: "Single-CLI chat turn against the named engine. Faster + cheaper than council for routine questions. Returns the assistant reply as a string. Note: when the user has auto-council set to \"auto\" for the domain, a high-stakes judgment call is automatically escalated to the full council and you receive the council verdict instead.",
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
      description: "Read today's _log/YYYY-MM-DD.md for a domain - the self-curating decision log written by prevAIl after every turn.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          date: { type: "string", description: "Optional YYYY-MM-DD; defaults to today." },
        },
        required: ["domain"],
      },
    },
    {
      name: "read_intents",
      description: "Read the intent ledger for a domain - the chronological record of what the user actually asked (their prompts), newest first. Use to understand recent context and recurring themes before answering.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          limit: { type: "number", description: "Max records (default 30)." },
        },
        required: ["domain"],
      },
    },
    {
      name: "read_decisions",
      description: "Read the decision log for a domain - past decisions and council verdicts with their rationale, newest first. Use to avoid re-litigating settled questions and to stay consistent with prior reasoning.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          limit: { type: "number", description: "Max records (default 20)." },
        },
        required: ["domain"],
      },
    },
    {
      name: "read_recommendations",
      description: "Prevail's proactive recommendations across the whole vault - gaps to close, models to switch, apps to connect, context to improve. Returns a prioritized list.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "read_surface",
      description: "Proactively surfaced questions and high-leverage next actions for a domain, inferred from its state, decisions, and memory. Use to suggest what the user should tackle next.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
      },
    },
    {
      name: "read_memory",
      description: "Read Prevail's learned knowledge: the durable per-domain MEMORY.md when a domain is given, otherwise the vault-wide omega.md (cross-domain lessons). This is the distilled long-term context, not raw chat history.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", description: "Optional; omit for vault-wide omega." } },
      },
    },
    {
      name: "list_tasks",
      description: "List the tasks for a domain with their status (todo | doing | review | blocked | done | icebox), due dates, and priority.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
      },
    },
    {
      name: "add_task",
      description: "Add a task to a domain's task list. Use after a decision or council verdict to capture the concrete next step. Returns whether it was added (false if a duplicate already exists).",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          text: { type: "string", description: "The task, phrased as a doable action." },
          due: { type: "string", description: "Optional due date YYYY-MM-DD." },
          priority: { type: "string", description: "Optional: high | critical." },
        },
        required: ["domain", "text"],
      },
    },
    {
      name: "update_task",
      description: "Set the status of an existing task by its id (get ids from list_tasks). Status is one of todo | doing | review | blocked | done | icebox.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          id: { type: "string" },
          status: { type: "string" },
        },
        required: ["domain", "id", "status"],
      },
    },
    {
      name: "log_decision",
      description: "Record a decision and its rationale to the domain's decision log, so future turns (and the user) can see what was decided and why. Use when a choice is made, not for routine answers.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          decision: { type: "string", description: "The decision reached." },
          rationale: { type: "string", description: "Why - the reasoning behind it." },
        },
        required: ["domain", "decision"],
      },
    },
  ];

  // Print the token-discovery hint once, on stderr, so a human launching the
  // server in network mode can find their token. Never on stdout - that
  // channel is reserved for valid JSON-RPC frames. Skipped over stdio (no
  // token is required there).
  if (requireToken) {
    log(`send your token in _meta.authorization. Token: prevail-<...> (${mcpConfigPath()})`);
  }

  for await (const line of readStdinLines()) {
    let req: JsonRpcReq;
    try {
      req = JSON.parse(line) as JsonRpcReq;
    } catch {
      log(`malformed JSON-RPC: ${line.slice(0, 200)}`);
      continue;
    }
    const id = req.id ?? null;
    // Auth check - only in network mode, and initialize is always exempt
    // (it's the handshake). Over stdio (requireToken=false) the token is not
    // required, so generic stdio clients work without attaching `_meta`.
    if (requireToken && req.method !== "initialize" && !isAuthorized(req, token)) {
      if (req.id !== undefined && req.id !== null) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message:
              "unauthorized - prevail MCP requires a valid token; see ~/.prevail/mcp.json",
          },
        });
      }
      continue;
    }
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

// Pull the bearer token off a JSON-RPC request and verify it against the
// persisted server token in constant time. Accepts either MCP's
// `_meta.authorization` convention or a top-level `authorization` field
// (some clients put it there). Both must be `prevail-<hex>`.
function isAuthorized(req: JsonRpcReq, expectedToken: string): boolean {
  const params = (req.params ?? {}) as Record<string, unknown> & {
    _meta?: Record<string, unknown>;
  };
  const fromMeta = typeof params._meta?.authorization === "string"
    ? (params._meta!.authorization as string)
    : null;
  const fromTop = typeof params.authorization === "string"
    ? (params.authorization as string)
    : null;
  const raw = fromMeta ?? fromTop;
  if (!raw) return false;
  const prefix = "prevail-";
  if (!raw.startsWith(prefix)) return false;
  const presented = raw.slice(prefix.length);
  // timingSafeEqual requires equal length - guard up front so we never
  // throw + leak timing via the catch path.
  if (presented.length !== expectedToken.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(presented, "utf8"),
      Buffer.from(expectedToken, "utf8"),
    );
  } catch {
    return false;
  }
}

// Inspect process.ppid to confirm the parent is something we expect to
// see launching a stdio MCP server (a TTY-attached shell, an IDE/agent
// binary, a known MCP host). Anything else gets refused unless the user
// passed --unsafe-detach. The check is conservative on purpose: a false
// positive (refusing a legitimate launch) is cheaper than a false
// negative (silently serving cron / a random daemon).
interface ParentVerdict {
  ok: boolean;
  message: string;
}

const KNOWN_PARENT_HINTS = [
  "vscode",
  "Code Helper",
  "Code.app",
  "cursor",
  "Cursor.app",
  "jetbrains",
  "intellij",
  "claude",
  "Claude",
  "ides",
  // Common MCP host launchers - Goose, Continue, Cline, mcp-cli, the
  // official @modelcontextprotocol/inspector + sdk.
  "goose",
  "continue",
  "cline",
  "mcp",
];

function verifyParentProcess(): ParentVerdict {
  // A TTY-attached stdin is the easy path: the user typed `prevail mcp`
  // themselves. We don't need to know who the parent is in that case.
  if (process.stdin.isTTY === true) {
    return { ok: true, message: "tty parent" };
  }
  const ppid = process.ppid;
  if (typeof ppid !== "number" || ppid <= 0) {
    return {
      ok: false,
      message:
        "prevail mcp refuses to run from detached / unknown parent (no ppid available). " +
        "If you're sure this is intentional, pass --unsafe-detach.",
    };
  }
  let cmd = "";
  try {
    // ps is portable across macOS + Linux; argv-array form so prompt
    // content / paths with spaces can never be interpreted as shell.
    const proc = Bun.spawnSync({
      cmd: ["ps", "-o", "command=", "-p", String(ppid)],
      stdout: "pipe",
      stderr: "pipe",
    });
    cmd = (proc.stdout?.toString() ?? "").trim();
  } catch {
    cmd = "";
  }
  const lower = cmd.toLowerCase();
  for (const hint of KNOWN_PARENT_HINTS) {
    if (cmd.includes(hint) || lower.includes(hint.toLowerCase())) {
      return { ok: true, message: `known parent: ${cmd}` };
    }
  }
  return {
    ok: false,
    message:
      `prevail mcp refuses to run from detached / unknown parent ` +
      `(PID ${ppid}, command ${cmd || "<unknown>"}). ` +
      `If you're sure this is intentional, pass --unsafe-detach.`,
  };
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
    case "read_intents":
      return wrapText(tReadIntents(args, vaultPath));
    case "read_decisions":
      return wrapText(tReadDecisions(args, vaultPath));
    case "read_recommendations":
      return wrapText(tReadRecommendations(vaultPath));
    case "read_surface":
      return wrapText(await tReadSurface(args, vaultPath));
    case "read_memory":
      return wrapText(tReadMemory(args, vaultPath));
    case "list_tasks":
      return wrapText(tListTasks(args, vaultPath));
    case "add_task":
      return wrapText(tAddTask(args, vaultPath));
    case "update_task":
      return wrapText(tUpdateTask(args, vaultPath));
    case "log_decision":
      return wrapText(tLogDecision(args, vaultPath));
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

  // Auto-council: when the domain is set to "auto", classify the prompt the same
  // way the preview chat / TUI does. A judgment call is routed to the full
  // council (which saves its verdict), so escalation fires identically whether
  // the user typed it in Prevail or a host LLM called prevail.chat over MCP. The
  // classifier fails safe to "don't escalate", so a flaky call just chats.
  if (readAutoCouncil(domain.name) === "auto") {
    let worthy = false;
    try {
      worthy = await classifyAsCouncilWorthy({ cwd: domain.path, cli, userPrompt: prompt });
    } catch {
      worthy = false;
    }
    if (worthy) {
      return await tCouncil({ prompt, domain: domain.name }, vaultPath);
    }
  }

  const reply = await runChatTurn({
    prompt,
    cwd: domain.path,
    cli,
    model,
    isFirst: true,
    bare: true,
  });
  const ts = Date.now();
  writeTurnSummary({
    domainPath: domain.path,
    userPrompt: prompt,
    assistantReply: reply,
    cliLabel: model ? `${cli.label}·${model} (via mcp)` : `${cli.label} (via mcp)`,
    ts,
    kind: "chat",
  });
  // Append an intent so the distiller picks up MCP-driven chats too - the same
  // self-learning loop the desktop and Telegram feed. Best-effort, never fatal.
  try {
    const rec = JSON.stringify({
      kind: "intent",
      ts,
      source: "mcp",
      domain: domain.name,
      cli: cli.kind,
      model: model || null,
      message: prompt,
    });
    vappendLine(join(domain.path, "_intents.jsonl"), `${rec}\n`);
  } catch { /* intent logging is best-effort */ }
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

// ── intelligence reads (intents / decisions / recommendations / surface / memory)

function tReadIntents(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 30;
  const f = runtimeFile(vaultPath, domain.name, "_intents.jsonl");
  if (!existsSync(f)) return `(no intents recorded for ${domain.name})`;
  const rows: string[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as Record<string, unknown>;
      if (v.kind !== "intent") continue;
      const msg = String(v.message ?? v.prompt ?? "").replace(/\n/g, " ").trim();
      if (!msg) continue;
      const when = typeof v.ts === "number" ? new Date(v.ts).toISOString().slice(0, 16).replace("T", " ") : "";
      const via = typeof v.cli === "string" ? ` · ${v.cli}` : "";
      rows.push(`- ${when}${via}: ${msg}`);
    } catch {
      /* skip malformed line */
    }
  }
  rows.reverse(); // newest first
  const shown = rows.slice(0, limit);
  return shown.length ? `# Intents - ${domain.name} (${shown.length})\n${shown.join("\n")}` : `(no intents recorded for ${domain.name})`;
}

function tReadDecisions(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 20;
  const recs = readDecisions(vaultPath, domain.name, limit);
  if (!recs.length) return `(no decisions logged for ${domain.name})`;
  const blocks = recs.map((r) => {
    const when = typeof r.ts === "number" ? new Date(r.ts).toISOString().slice(0, 10) : "";
    const what = r.verdict || r.prompt || r.type;
    const fb = r.feedback ? ` (feedback: ${r.feedback.rating})` : "";
    return `## ${when} · ${r.type}${fb}\n${what}`;
  });
  return `# Decisions - ${domain.name}\n\n${blocks.join("\n\n")}`;
}

function tReadRecommendations(vaultPath: string): string {
  const recs = buildRecommendations(vaultPath);
  if (!recs.length) return "(no recommendations right now)";
  return ["# Recommendations", "", ...recs.map((r) => `## ${r.title}  [${r.category}]\n${r.detail}`)].join("\n");
}

async function tReadSurface(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const domain = resolveDomain(vaultPath, args.domain);
  const res = await runSurface({ vaultPath, domain: domain.name });
  const q = res.questions.length ? res.questions.map((x) => `- ${x}`).join("\n") : "(none)";
  const a = res.actions.length ? res.actions.map((x) => `- ${x}`).join("\n") : "(none)";
  return `# Surface - ${domain.name}\n\n## Open questions\n${q}\n\n## Next actions\n${a}`;
}

function tReadMemory(args: Record<string, unknown>, vaultPath: string): string {
  const name = typeof args.domain === "string" && args.domain.trim() ? args.domain : null;
  if (name) {
    const domain = resolveDomain(vaultPath, name);
    const f = join(domainDir(vaultPath, domain.name), "MEMORY.md");
    if (!existsSync(f)) return `(no learned MEMORY.md for ${domain.name} yet)`;
    return readFileSync(f, "utf8");
  }
  const f = join(vaultPath, "omega.md");
  if (!existsSync(f)) return "(no omega.md yet - vault-wide learned memory is empty)";
  return readFileSync(f, "utf8");
}

// ── task management ────────────────────────────────────────────────────────────

function tListTasks(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const tasks = readTasks(domainDir(vaultPath, domain.name)).filter((t) => !t.trashed);
  if (!tasks.length) return `(no tasks for ${domain.name})`;
  const lines = tasks.map((t) => {
    const due = t.due ? ` @${t.due}` : "";
    const prio = t.priority ? ` ~${t.priority}` : "";
    return `- [${effectiveStatus(t)}] (${t.id ?? "?"}) ${t.text}${due}${prio}`;
  });
  return `# Tasks - ${domain.name} (${tasks.length})\n${lines.join("\n")}`;
}

function tAddTask(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("text is required");
  const due = typeof args.due === "string" ? args.due : undefined;
  const priority = typeof args.priority === "string" ? args.priority : undefined;
  const added = appendTask(domainDir(vaultPath, domain.name), text, { due, priority });
  return added
    ? `Added to ${domain.name}: "${text}".`
    : `Not added - a task like "${text}" already exists in ${domain.name}.`;
}

function tUpdateTask(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const id = String(args.id ?? "").trim();
  const status = String(args.status ?? "").trim();
  if (!id || !status) throw new Error("id and status are required");
  const ok = setTaskStatus(domainDir(vaultPath, domain.name), id, status);
  return ok ? `Task ${id} in ${domain.name} set to "${status}".` : `No task with id ${id} in ${domain.name}.`;
}

function tLogDecision(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  const decision = String(args.decision ?? "").trim();
  if (!decision) throw new Error("decision is required");
  const rationale = typeof args.rationale === "string" ? args.rationale.trim() : "";
  const rec = appendDecision(vaultPath, domain.name, {
    type: "decision",
    verdict: decision,
    prompt: rationale || undefined,
    source: "mcp",
  });
  return `Logged decision ${rec.id} in ${domain.name}.`;
}

// Async iterator over stdin lines. Bun + Node both support this via the
// stdin readable stream - we just split on newlines and yield each one.
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
