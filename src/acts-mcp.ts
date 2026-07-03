// acts-mcp — the stdio MCP server that exposes Prevail's OWN, vault-scoped
// action primitives to the agent: create_skill, create_loop, remember. This is
// what makes agentic execution MODEL-AGNOSTIC: whichever runtime drives the
// agent (Claude / Codex / Gemini), a "save this as a skill" or "run this every
// Sunday" resolves to PREVAIL's vault (a SKILL.md under the domain, a loop in
// _loops.json, a line in _memory.md) — never the host model's native skill
// folder, cron, or sandbox. The agent is told, in each tool's description and in
// the agent-run frame, to reach for these and nothing host-native.
//
// Every successful call also appends a line to the run's ACTION LEDGER
// (PREVAIL_ACTION_LEDGER, a plaintext JSONL the agent-run process reads back).
// The ledger is the ground truth Prevail reports to the user — an action only
// appears there if the tool actually performed it, so the agent can never
// fabricate a success it didn't do (the trust fix: no more phantom drafts).
//
// Protocol: the same hand-rolled JSON-RPC 2.0 over stdio as gws-mcp.ts /
// mcp-server.ts. stdout is reserved for JSON-RPC frames; ALL logging → stderr.

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { VERSION } from "./version.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { writeDistilledSkill } from "./distill.ts";
import { scanVault, type Domain } from "./vault.ts";
import { generalDir } from "./decisions.ts";

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

const SERVER_INFO = { name: "prevail-acts", version: VERSION };
const PROTOCOL_VERSION = "2024-11-05";

function log(line: string): void {
  process.stderr.write(`[prevail-acts-mcp] ${line}\n`);
}

function send(msg: JsonRpcRes): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── Action ledger ────────────────────────────────────────────────────────
// Append one verified-action record to the run's ledger, if the agent-run
// parent set one. Plaintext JSONL (like pending_gws.json) so the parent reads
// it back with node:fs. Best-effort: a ledger write must never fail a tool.
interface ActionRecord {
  ts: number;
  tool: string;
  ok: boolean;
  detail: string; // human sentence, shown in the "what I actually did" footer
  ref?: string; // path / id the action produced
  queued?: boolean; // true when the action is pending the user's approval
}

function recordAction(rec: ActionRecord): void {
  const ledger = process.env.PREVAIL_ACTION_LEDGER;
  if (!ledger || !ledger.trim()) return;
  try {
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, JSON.stringify(rec) + "\n");
  } catch {
    /* ledger is best-effort */
  }
}

// ── Domain resolution ──────────────────────────────────────────────────────
// Resolve a domain NAME to a Domain (with its on-disk path). Mirrors
// agent-run's findDomain + General synthesis so tools land in the same dirs the
// rest of the engine reads.
function resolveDomain(vaultPath: string, name: string | undefined): Domain {
  const want = (name ?? "").trim();
  if (want && want !== "general" && want !== "__general__") {
    try {
      const found = scanVault(vaultPath).find((d) => d.name === want);
      if (found) return found;
    } catch {
      /* fall through to general */
    }
  }
  const gdir = generalDir(vaultPath);
  try { mkdirSync(gdir, { recursive: true }); } catch { /* best effort */ }
  return { name: "general", path: gdir, hasState: false, openLoopCount: 0, stateMtime: null, skills: [] };
}

// ── Tools ──────────────────────────────────────────────────────────────────
const CREATE_SKILL_DESC =
  "Save a reusable SKILL into THIS Prevail vault (a SKILL.md under the domain's skills/ folder). " +
  "Use this whenever the user asks you to create, save, or remember a skill / procedure / how-to. " +
  "Do NOT write to any host-native skill location (e.g. ~/.claude/skills) — Prevail skills live only in the vault.";

const CREATE_LOOP_DESC =
  "Create a recurring Prevail LOOP (an automation stored in the domain's _loops.json). " +
  "Use this for any 'do X every day/week/month' or scheduled/briefing request (e.g. 'send a briefing every Sunday'). " +
  "cadence must be one of: continuous, daily, weekly, monthly (map 'every Sunday morning' → weekly). " +
  "The loop is created in SUGGEST autonomy: it proposes on its cadence and the user approves — it does not act unattended. " +
  "Do NOT use any host-native scheduler, cron, or CronCreate — Prevail loops are the only durable scheduling here.";

const REMEMBER_DESC =
  "Append a durable fact to THIS domain's long-term memory (_memory.md in the vault). " +
  "Use this to persist something the user wants remembered. Do NOT use a host-native memory/sandbox store.";

function tools(): McpTool[] {
  return [
    {
      name: "create_skill",
      description: CREATE_SKILL_DESC,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short skill name, e.g. 'format my emails'. Becomes the SKILL.md frontmatter name + slug." },
          instructions: { type: "string", description: "The full skill body: the step-by-step instructions/procedure this skill encodes (markdown)." },
          description: { type: "string", description: "Optional one-line summary of when to use this skill." },
          domain: { type: "string", description: "Optional domain to save into (defaults to the launch --domain or 'general')." },
        },
        required: ["name", "instructions"],
      },
    },
    {
      name: "create_loop",
      description: CREATE_LOOP_DESC,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short loop name, e.g. 'Sunday wealth briefing'." },
          purpose: { type: "string", description: "One sentence: what this loop is for / what it should accomplish on each run." },
          cadence: { type: "string", description: "continuous | daily | weekly | monthly. Map 'every Sunday morning' → weekly." },
          action: { type: "string", description: "Optional: the concrete action the loop should take each run, e.g. 'draft and send a wealth-posture briefing email'." },
          domain: { type: "string", description: "Optional domain to create the loop in (defaults to the launch --domain or 'general')." },
        },
        required: ["name", "purpose", "cadence"],
      },
    },
    {
      name: "remember",
      description: REMEMBER_DESC,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact to remember (one line)." },
          domain: { type: "string", description: "Optional domain (defaults to the launch --domain or 'general')." },
        },
        required: ["text"],
      },
    },
  ];
}

function wrapText(s: string): McpContent[] {
  return [{ type: "text", text: s }];
}

function ymd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const CADENCES = new Set(["continuous", "daily", "weekly", "monthly"]);

// Coerce a free-form cadence phrase to the loop enum. Anything unrecognized
// (e.g. "every Sunday morning") falls back to weekly — the safest recurring
// default — rather than silently dropping the schedule.
function coerceCadence(raw: string): string {
  const c = raw.trim().toLowerCase();
  if (CADENCES.has(c)) return c;
  // A named weekday (e.g. "every Sunday morning") or "week" means weekly — check
  // this BEFORE daily so the word "morning" alongside "Sunday" doesn't win.
  if (/sunday|monday|tuesday|wednesday|thursday|friday|saturday|week/.test(c)) return "weekly";
  if (/month|quarter|year/.test(c)) return "monthly";
  if (/hour|continu|realtime|real-time|constant/.test(c)) return "continuous";
  if (/daily|every day|each day|morning|nightly|每/.test(c)) return "daily";
  return "weekly";
}

function doCreateSkill(rawArgs: Record<string, unknown>, vaultPath: string, defaultDomain: string): McpContent[] {
  const name = typeof rawArgs.name === "string" ? rawArgs.name.trim() : "";
  const instructions = typeof rawArgs.instructions === "string" ? rawArgs.instructions.trim() : "";
  const desc = typeof rawArgs.description === "string" ? rawArgs.description.trim() : "";
  if (!name || !instructions) {
    return wrapText("Error: create_skill needs both `name` and `instructions`.");
  }
  const domain = resolveDomain(vaultPath, (typeof rawArgs.domain === "string" && rawArgs.domain.trim()) ? rawArgs.domain : defaultDomain);
  // Build a SKILL.md body with frontmatter so writeDistilledSkill can slug it.
  const body = [
    "---",
    `name: ${name}`,
    `description: ${desc || name}`,
    "---",
    "",
    instructions,
    "",
  ].join("\n");
  const res = writeDistilledSkill(domain, body);
  if (res.ok) {
    recordAction({ ts: Date.now(), tool: "create_skill", ok: true, detail: `Created skill "${name}" in ${domain.name} (skills/${res.slug}/SKILL.md)`, ref: res.path });
    return wrapText(`Created skill "${name}" in domain ${domain.name}. Saved to ${res.path}.`);
  }
  recordAction({ ts: Date.now(), tool: "create_skill", ok: false, detail: `Could not create skill "${name}": ${res.message}` });
  return wrapText(`Could not create skill "${name}": ${res.message}`);
}

function doCreateLoop(rawArgs: Record<string, unknown>, vaultPath: string, defaultDomain: string): McpContent[] {
  const name = typeof rawArgs.name === "string" ? rawArgs.name.trim() : "";
  const purpose = typeof rawArgs.purpose === "string" ? rawArgs.purpose.trim() : "";
  const cadenceRaw = typeof rawArgs.cadence === "string" ? rawArgs.cadence : "";
  const action = typeof rawArgs.action === "string" ? rawArgs.action.trim() : "";
  if (!name || !purpose || !cadenceRaw.trim()) {
    return wrapText("Error: create_loop needs `name`, `purpose`, and `cadence`.");
  }
  const domain = resolveDomain(vaultPath, (typeof rawArgs.domain === "string" && rawArgs.domain.trim()) ? rawArgs.domain : defaultDomain);
  const cadence = coerceCadence(cadenceRaw);
  const loopsPath = join(domain.path, "_loops.json");
  // Read the existing loops doc (if any) so we append rather than clobber.
  let doc: { schema: 1; desiredState: string; loops: unknown[] } = { schema: 1, desiredState: "", loops: [] };
  try {
    const raw = vreadFile(loopsPath);
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as { schema?: 1; desiredState?: string; loops?: unknown[] };
      if (Array.isArray(parsed.loops)) doc = { schema: 1, desiredState: parsed.desiredState ?? "", loops: parsed.loops };
    }
  } catch {
    /* no/invalid existing doc — start fresh */
  }
  const id = shortId("loop");
  const loop = {
    id,
    name,
    purpose,
    type: "open" as const,
    signals: [] as string[],
    condition: "",
    // SUGGEST: the loop proposes on its cadence; the user approves each run. It
    // never acts unattended — the honest default for something the agent set up.
    autonomy: "suggest" as const,
    cadence,
    evaluation: "The intent is being made real over time.",
    actions: action ? [action] : ([] as string[]),
    status: "active" as const,
    enabled: true,
    lastRunTs: null as number | null,
    createdTs: Date.now(),
  };
  try {
    mkdirSync(domain.path, { recursive: true });
    vwriteFile(loopsPath, JSON.stringify({ ...doc, loops: [loop, ...doc.loops] }, null, 2));
  } catch (err) {
    recordAction({ ts: Date.now(), tool: "create_loop", ok: false, detail: `Could not create loop "${name}": ${(err as Error).message}` });
    return wrapText(`Could not create loop "${name}": ${(err as Error).message}`);
  }
  recordAction({ ts: Date.now(), tool: "create_loop", ok: true, detail: `Created ${cadence} loop "${name}" in ${domain.name} (proposes on its cadence, you approve each run)`, ref: id });
  return wrapText(
    `Created a ${cadence} loop "${name}" (id ${id}) in domain ${domain.name}. ` +
    `It runs in SUGGEST mode: on its cadence it proposes the action for your approval — it will not act unattended. ` +
    `Refine or arm it under Work → Automations.`,
  );
}

function doRemember(rawArgs: Record<string, unknown>, vaultPath: string, defaultDomain: string): McpContent[] {
  const text = typeof rawArgs.text === "string" ? rawArgs.text.trim() : "";
  if (!text) return wrapText("Error: remember needs `text`.");
  const domain = resolveDomain(vaultPath, (typeof rawArgs.domain === "string" && rawArgs.domain.trim()) ? rawArgs.domain : defaultDomain);
  const memPath = join(domain.path, "_memory.md");
  let cur = "";
  try { cur = vreadFile(memPath); } catch { /* new file */ }
  if (!cur.trim()) cur = `# Long-term memory (${domain.name})\n\n`;
  const body = cur.endsWith("\n") ? cur : `${cur}\n`;
  try {
    mkdirSync(domain.path, { recursive: true });
    vwriteFile(memPath, `${body}- ${text}  ·(${ymd()})\n`);
  } catch (err) {
    recordAction({ ts: Date.now(), tool: "remember", ok: false, detail: `Could not save to memory: ${(err as Error).message}` });
    return wrapText(`Could not save to memory: ${(err as Error).message}`);
  }
  recordAction({ ts: Date.now(), tool: "remember", ok: true, detail: `Saved a fact to ${domain.name} long-term memory`, ref: memPath });
  return wrapText(`Remembered in ${domain.name}: ${text}`);
}

function dispatch(req: JsonRpcReq, vaultPath: string, defaultDomain: string): unknown {
  switch (req.method) {
    case "initialize": {
      const p = (req.params ?? {}) as { clientInfo?: { name?: string } };
      log(`client: ${p.clientInfo?.name ?? "(unknown)"}`);
      return { protocolVersion: PROTOCOL_VERSION, serverInfo: SERVER_INFO, capabilities: { tools: {} } };
    }
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { tools: tools() };
    case "tools/call": {
      const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = p.name ?? "";
      const a = p.arguments ?? {};
      if (name === "create_skill") return { content: doCreateSkill(a, vaultPath, defaultDomain) };
      if (name === "create_loop") return { content: doCreateLoop(a, vaultPath, defaultDomain) };
      if (name === "remember") return { content: doRemember(a, vaultPath, defaultDomain) };
      throw new Error(`unknown tool: ${name}`);
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

export async function runActsMcpServer(vaultPath: string, domain?: string): Promise<void> {
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
