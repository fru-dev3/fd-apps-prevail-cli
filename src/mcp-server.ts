import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { detectClis, runChatTurn } from "./cli-bridge.ts";
import { scanVault, scanApps, type Domain } from "./vault.ts";
import { buildCouncilPanel, runCouncilOneShot } from "./council-runner.ts";
import { classifyAsCouncilWorthy } from "./auto-council.ts";
import { readAutoCouncil, readBunker } from "./config.ts";
import { isLockSet } from "./lock.ts";
import { writeTurnSummary } from "./auto-summary.ts";
import { appendDecision, readDecisions, domainDir, runtimeFile } from "./decisions.ts";
import { buildRecommendations } from "./recommendations.ts";
import { runSurface } from "./surface.ts";
import { readTasks, writeTasks, setTaskStatus, effectiveStatus } from "./tasks.ts";
import { appendTask, runOneLoop, executeAction, DEFAULT_LOOPS, type LoopsConfig } from "./daemon-loops.ts";
import { syncApp } from "./daemon-sync.ts";
import { connectApp } from "./connect-app.ts";
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

// The connected MCP client, captured from initialize's clientInfo.name and
// normalized to a surface slug, so prompts captured over MCP carry their TRUE
// provenance (codex / gemini / claude / antigravity / cursor / …) - not the
// answering CLI or, worse, the domain. One client per stdio process, so a
// module-level value is correct.
let mcpClientSurface = "mcp";

function normalizeClientSurface(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (!n) return "mcp";
  if (n.includes("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  if (n.includes("gemini")) return "gemini";
  if (n.includes("antigravity") || n.includes("agy")) return "antigravity";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("cline")) return "cline";
  if (n.includes("goose")) return "goose";
  if (n.includes("continue")) return "continue";
  if (n.includes("opencode")) return "opencode";
  const slug = n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "mcp";
}

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
      description: "Set the status of an existing task. Identify it by its id (from list_tasks) or, if it has none yet, by its exact text. Status is one of todo | doing | review | blocked | done | icebox.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          id: { type: "string", description: "Task id from list_tasks, or the exact task text." },
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
    {
      name: "list_loops",
      description: "List a domain's standing loops (self-driving routines): id, name, purpose, cadence, autonomy level, and whether enabled.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
      },
    },
    {
      name: "run_loop",
      description: "Run one loop now (by id or name). The loop evaluates the domain's current state and returns proposed next actions; depending on the loop's autonomy it may file tasks or queue approvals. Returns the note + proposed actions + any tasks created.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          loop: { type: "string", description: "Loop id or name (from list_loops)." },
        },
        required: ["domain", "loop"],
      },
    },
    {
      name: "approve_loop_action",
      description: "Execute a loop action that was queued for approval, using Prevail's agent tools. Pass the exact action text from run_loop. Higher-stakes than other tools - only call when the user has approved this action.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          action: { type: "string", description: "The exact action text to execute." },
        },
        required: ["domain", "action"],
      },
    },
    {
      name: "list_apps",
      description: "List the connected apps/connectors (Gmail, GitHub, bank feeds, …) with the life domains they feed and how they connect. These are the data sources Prevail pulls into the vault.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "vault_status",
      description: "Health and privacy status of the vault: passcode lock, Bunker Mode (local-only), and domain count. Check before suggesting anything that depends on network or write access.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sync_app",
      description: "Sync one connected app NOW (by id from list_apps): runs its connector to pull fresh data into the vault. Returns whether it succeeded and how many artifacts were routed.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "App id from list_apps." } },
        required: ["id"],
      },
    },
    {
      name: "connect_app",
      description: "Connect a new app/data source. Prevail's Connection Agent researches the best way to connect it right now (MCP, an official API/CLI, a gateway, or a browser login), scaffolds it into the vault wired to the given domains, and returns a plan with the ONE auth step the user must complete. Higher-stakes: creates vault files and may require the user to authorize.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The app to connect, e.g. \"GitHub\", \"Strava\"." },
          goal: { type: "string", description: "What data it should pull in." },
          domains: { type: "array", items: { type: "string" }, description: "Optional: domains this should feed (informational; the agent also infers)." },
        },
        required: ["name"],
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
    case "initialize": {
      const p = (req.params ?? {}) as { clientInfo?: { name?: string } };
      mcpClientSurface = normalizeClientSurface(p.clientInfo?.name);
      log(`client: ${mcpClientSurface}${p.clientInfo?.name ? ` (${p.clientInfo.name})` : ""}`);
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };
    }
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
    case "list_loops":
      return wrapText(tListLoops(args, vaultPath));
    case "run_loop":
      return wrapText(await tRunLoop(args, vaultPath));
    case "approve_loop_action":
      return wrapText(await tApproveLoopAction(args, vaultPath));
    case "list_apps":
      return wrapText(tListApps(vaultPath));
    case "vault_status":
      return wrapText(tVaultStatus(vaultPath));
    case "sync_app":
      return wrapText(await tSyncApp(args, vaultPath));
    case "connect_app":
      return wrapText(await tConnectApp(args, vaultPath));
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

// Record an MCP prompt in the domain's intent ledger so it shows up in the
// journal + feeds the distiller. `surface` carries the true MCP-client identity
// (codex / gemini / …) so the journal labels it by where it came from, not the
// answering CLI or the domain. Best-effort, never fatal.
function logMcpIntent(domain: Domain, prompt: string, cli: string, model: string, ts: number): void {
  try {
    const rec = JSON.stringify({
      kind: "intent",
      ts,
      source: "mcp",
      surface: mcpClientSurface,
      domain: domain.name,
      cli,
      model: model || null,
      message: prompt,
    });
    vappendLine(join(domain.path, "_intents.jsonl"), `${rec}\n`);
  } catch {
    /* intent logging is best-effort */
  }
}

async function tCouncil(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt is required");
  const domain = resolveDomain(vaultPath, args.domain);
  // Log the prompt up front with its MCP-client provenance (covers both a direct
  // `council` call and an auto-council escalation from `chat`).
  logMcpIntent(domain, prompt, "council", "", Date.now());
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
      cliLabel: `Council ⚖ ${r.chairLabel} (via ${mcpClientSurface})`,
      ts: Date.now(),
      kind: "council-verdict",
    });
  }
  const panelLines = r.panel.map((p) => {
    const tag = p.model ? `${p.cli.label}·${p.model}` : p.cli.label;
    return `### ${tag}\n${p.reply}`;
  });
  // Each panelist's FULL response comes first, then the synthesized verdict, so
  // the caller sees what every council member actually said before the summary.
  // Tell the host LLM to show this in order (don't collapse the panel away).
  return [
    `# Council`,
    "",
    "_Show the user each panel response below, then the verdict - do not omit the individual answers._",
    "",
    "## What each council member said",
    "",
    ...panelLines,
    "",
    "---",
    "",
    "## Verdict",
    "",
    r.verdict,
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
    cliLabel: `${model ? `${cli.label}·${model}` : cli.label} (via ${mcpClientSurface})`,
    ts,
    kind: "chat",
  });
  // Append an intent so the distiller + journal pick up MCP-driven chats too,
  // tagged with the calling client (codex / gemini / …). The escalation path
  // logs via tCouncil instead, so this runs only on the direct-chat path.
  logMcpIntent(domain, prompt, cli.kind, model, ts);
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
  const ref = String(args.id ?? "").trim();
  const status = String(args.status ?? "").trim();
  if (!ref || !status) throw new Error("id and status are required");
  const dir = domainDir(vaultPath, domain.name);
  // Prefer an id match (cheap, exact). Loop/appendTask-created tasks have no id
  // until a desktop write normalizes them, so fall back to an exact-text match
  // and write (which assigns ids), so a follow-up update can use the id.
  if (setTaskStatus(dir, ref, status)) return `Task ${ref} in ${domain.name} set to "${status}".`;
  const tasks = readTasks(dir);
  const want = ref.toLowerCase();
  let found = false;
  for (const t of tasks) {
    if (!found && t.text.trim().toLowerCase() === want) {
      t.status = status;
      t.done = status === "done";
      found = true;
    }
  }
  if (found) {
    writeTasks(dir, tasks);
    return `Task "${ref}" in ${domain.name} set to "${status}".`;
  }
  return `No task matching "${ref}" (by id or text) in ${domain.name}.`;
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

// ── loops (self-driving routines) ────────────────────────────────────────────

function loopsCfg(vaultPath: string, providerKind: string): LoopsConfig {
  return { vaultPath, intervalSec: DEFAULT_LOOPS.intervalSec, provider: providerKind || DEFAULT_LOOPS.provider, model: "" };
}

function tListLoops(args: Record<string, unknown>, vaultPath: string): string {
  const domain = resolveDomain(vaultPath, args.domain);
  let f = join(domain.path, "_loops.json");
  if (!existsSync(f)) f = join(domainDir(vaultPath, domain.name), "_loops.json");
  if (!existsSync(f)) return `(no loops defined for ${domain.name})`;
  let loops: Array<Record<string, unknown>> = [];
  try {
    const doc = JSON.parse(readFileSync(f, "utf8")) as { loops?: Array<Record<string, unknown>> };
    loops = Array.isArray(doc.loops) ? doc.loops : [];
  } catch {
    return `(could not read loops for ${domain.name})`;
  }
  if (!loops.length) return `(no loops defined for ${domain.name})`;
  const lines = loops.map((l) => {
    const state = l.enabled === false ? "disabled" : (l.status ?? "active");
    return `- (${l.id}) ${l.name}  [${l.cadence}, autonomy:${l.autonomy ?? "suggest"}, ${state}]\n  ${l.purpose ?? ""}`;
  });
  return `# Loops - ${domain.name} (${loops.length})\n${lines.join("\n")}`;
}

async function tRunLoop(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const domain = resolveDomain(vaultPath, args.domain);
  const loopRef = String(args.loop ?? "").trim();
  if (!loopRef) throw new Error("loop (id or name) is required");
  const clis = await detectClis();
  if (clis.length === 0) throw new Error("no CLIs detected");
  const r = await runOneLoop(loopsCfg(vaultPath, clis[0]!.kind), domain.name, loopRef);
  if (!r.ok) return `Loop run failed: ${r.error ?? "unknown error"}`;
  const acts = r.actions.length ? r.actions.map((a) => `- [${a.disposition}] ${a.text}`).join("\n") : "(no actions proposed)";
  const tasks = r.tasksCreated.length ? `\n\n## Tasks created\n${r.tasksCreated.map((t) => `- ${t}`).join("\n")}` : "";
  return `# Loop "${r.loop}" - ${domain.name}${r.done ? " (closed: condition met)" : ""}\n${r.note}\n\n## Proposed actions\n${acts}${tasks}`;
}

async function tApproveLoopAction(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const domain = resolveDomain(vaultPath, args.domain);
  const action = String(args.action ?? "").trim();
  if (!action) throw new Error("action is required");
  const clis = await detectClis();
  if (clis.length === 0) throw new Error("no CLIs detected");
  const result = await executeAction(loopsCfg(vaultPath, clis[0]!.kind), domain.name, action);
  return result || "(action executed)";
}

// ── apps + vault status ──────────────────────────────────────────────────────

function tListApps(vaultPath: string): string {
  const apps = scanApps(vaultPath);
  if (!apps.length) return "(no apps connected)";
  const lines = apps.map((a) => {
    const doms = a.domains?.length ? `  ->  ${a.domains.join(", ")}` : "";
    const tag = a.community ? " [community]" : "";
    return `- (${a.id}) ${a.title}${doms}${tag}\n  ${a.description ?? ""}`;
  });
  return `# Apps (${apps.length})\n${lines.join("\n")}`;
}

function tVaultStatus(vaultPath: string): string {
  const locked = isLockSet();
  const bunker = readBunker();
  const domains = scanVault(vaultPath);
  return [
    "# Vault status",
    `path: ${vaultPath}`,
    `passcode lock: ${locked ? "set" : "none"}`,
    `bunker mode: ${bunker ? "ON (local-only, no cloud/network)" : "off"}`,
    `domains: ${domains.length}`,
  ].join("\n");
}

async function tSyncApp(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error("id is required (see list_apps)");
  const r = await syncApp({ vaultPath, tickSec: 60, maxRunsPerTick: 1 }, id);
  if (r.ok) return `Synced ${id}: ${r.artifacts ?? 0} artifact(s) routed into the vault.`;
  return `Sync of ${id} failed: ${r.error ?? "unknown error"}`;
}

async function tConnectApp(args: Record<string, unknown>, vaultPath: string): Promise<string> {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("name is required");
  const goal = typeof args.goal === "string" ? args.goal : "";
  const res = await connectApp({ vaultPath, name, goal });
  if (!res.ok) return `Could not connect ${name}: ${res.error ?? "unknown error"}`;
  const p = res.plan ?? {};
  const integration = typeof p.integration === "string" ? p.integration : "manual";
  const why = typeof p.why === "string" ? p.why : "";
  const step = (p.auth_step && typeof p.auth_step === "object") ? (p.auth_step as Record<string, unknown>) : {};
  const stepKind = typeof step.kind === "string" ? step.kind : "none";
  const stepInstr = typeof step.instruction === "string" ? step.instruction : "";
  const lines = [
    `# Connected ${(p.title as string) || name}`,
    `method: ${integration}${why ? ` - ${why}` : ""}`,
  ];
  if (res.verified === true) lines.push(`verified: yes${res.proof ? ` (${res.proof})` : ""}`);
  else if (res.verified === false) lines.push(`verified: no${res.proof ? ` (${res.proof})` : ""}`);
  if (stepKind && stepKind !== "none" && stepInstr) {
    lines.push("", `## Action needed (${stepKind})`, stepInstr);
  } else {
    lines.push("", "No further action needed.");
  }
  return lines.join("\n");
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
