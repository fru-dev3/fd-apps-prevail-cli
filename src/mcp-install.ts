import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// =============================================================================
// `prevail mcp install --client <X>` - register Prevail as an MCP server in each
// AI CLI's own config, in one shot, no copy-paste. Companion to capture-install.
//
// Every client gets the SAME stdio server (`prevail mcp`), flag-less so it
// follows the saved vault (move-proof). Only the config FILE + FORMAT differ:
//
//   claude       -> `claude mcp add` (its own CLI owns ~/.claude.json)
//   codex        -> ~/.codex/config.toml            [mcp_servers.prevail]
//   gemini       -> ~/.gemini/config/mcp_config.json  { mcpServers.prevail }
//   antigravity  -> ~/.gemini/antigravity-cli/mcp_config.json { mcpServers }
//   cursor       -> ~/.cursor/mcp.json              { mcpServers.prevail }
//
// Idempotent: re-installing overwrites the prevail entry in place and leaves
// every other server untouched.
// =============================================================================

/** The stable command + base args to launch this prevail as an MCP server.
 *  Compiled binary -> [/path/to/prevail]; bun-from-source -> [bun, script]. The
 *  installed desktop app resolves execPath to the bundled sidecar, which is the
 *  stable path we want baked into each client's config. */
function engineCommand(): { command: string; baseArgs: string[] } {
  const exec = process.execPath;
  if (process.argv[1] && /\b(bun|node)$/.test(exec)) {
    return { command: exec, baseArgs: [process.argv[1]] };
  }
  return { command: exec, baseArgs: [] };
}

/** The full MCP args a client invokes: base args + `mcp` + `--unsafe-detach`.
 *  The detach flag bypasses the server's parent-process check, which otherwise
 *  rejects launches whose parent isn't a recognized TTY/IDE (e.g. when a host
 *  validates the server on add, or the desktop tests it). Local stdio is still
 *  token/parent-safe; this just stops false rejections. */
function mcpArgs(): string[] {
  return [...engineCommand().baseArgs, "mcp", "--unsafe-detach"];
}

export type McpClientKind = "claude" | "json" | "toml";

export interface McpClient {
  id: string;
  label: string;
  kind: McpClientKind;
  /** Config file (json/toml clients). Absent for the claude CLI client. */
  file?: string;
  /** Whether the client looks installed on this machine. */
  present: () => boolean;
}

const HOME = homedir();
// Claude Code's own config. User-scope MCP servers live at top-level
// `mcpServers`; local/project-scope under `projects[<path>].mcpServers`.
const CLAUDE_CONFIG = join(HOME, ".claude.json");

export const MCP_CLIENTS: readonly McpClient[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "claude",
    file: CLAUDE_CONFIG,
    present: () => existsSync(join(HOME, ".claude")),
  },
  {
    id: "codex",
    label: "Codex",
    kind: "toml",
    file: join(HOME, ".codex", "config.toml"),
    present: () => existsSync(join(HOME, ".codex")),
  },
  {
    id: "gemini",
    label: "Gemini",
    kind: "json",
    file: join(HOME, ".gemini", "config", "mcp_config.json"),
    present: () => existsSync(join(HOME, ".gemini", "config")),
  },
  {
    id: "antigravity",
    label: "Antigravity",
    kind: "json",
    file: join(HOME, ".gemini", "antigravity-cli", "mcp_config.json"),
    present: () => existsSync(join(HOME, ".gemini", "antigravity-cli")),
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "json",
    file: join(HOME, ".cursor", "mcp.json"),
    present: () => existsSync(join(HOME, ".cursor")),
  },
];

export interface McpClientResult {
  client: string;
  present: boolean;
  registered: boolean;
  file?: string;
  detail?: string;
  error?: string;
}

// ── JSON clients (gemini / antigravity / cursor) ──────────────────────────────
function installJson(file: string): McpClientResult {
  const { command } = engineCommand();
  const base: McpClientResult = { client: "", present: true, registered: false, file };
  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      cfg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (e) {
      return { ...base, error: `existing config is not valid JSON: ${(e as Error).message}` };
    }
  }
  const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
  servers.prevail = { command, args: mcpArgs() };
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  return { ...base, registered: true };
}

// ── TOML client (codex) ───────────────────────────────────────────────────────
// No TOML dependency in the engine, so we edit the [mcp_servers.prevail] table
// as text: replace it in place if present (from its header to the next table
// header or EOF), else append. Every other table is left byte-for-byte intact.
function installToml(file: string): McpClientResult {
  const { command } = engineCommand();
  const base: McpClientResult = { client: "", present: true, registered: false, file };
  const argsToml = mcpArgs()
    .map((a) => JSON.stringify(a))
    .join(", ");
  const block = `[mcp_servers.prevail]\ncommand = ${JSON.stringify(command)}\nargs = [${argsToml}]\n`;
  let text = "";
  if (existsSync(file)) {
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }
  const header = "[mcp_servers.prevail]";
  const idx = text.indexOf(header);
  if (idx === -1) {
    const sep =
      text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    text = `${text}${sep}${block}`;
  } else {
    // Replace from the header to the next table header ("\n[") or EOF.
    const after = text.indexOf("\n[", idx + header.length);
    const end = after === -1 ? text.length : after + 1; // keep the leading newline of next table
    text = `${text.slice(0, idx)}${block}${end < text.length ? text.slice(end) : ""}`;
  }
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, "utf8");
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  return { ...base, registered: true };
}

// ── claude client ─────────────────────────────────────────────────────────────
// Detection + the install fallback read/write ~/.claude.json DIRECTLY, never
// spawning `claude`. The desktop app runs with a minimal GUI PATH that usually
// can't find the `claude` binary, so a spawn-based status check would always say
// "not registered" (the bug). File I/O has no such dependency, matching how the
// json/toml clients are detected.
const claudeBase = (): McpClientResult => ({
  client: "claude",
  present: existsSync(join(HOME, ".claude")),
  registered: false,
  file: CLAUDE_CONFIG,
});

/** Is prevail registered in Claude's config at ANY scope? user scope = top-level
 *  mcpServers; local scope = projects[*].mcpServers. Pure file read, no spawn. */
function claudeRegistered(): boolean {
  if (!existsSync(CLAUDE_CONFIG)) return false;
  try {
    const cfg = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf8").trim() || "{}") as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    if (cfg.mcpServers?.prevail) return true;
    return Object.values(cfg.projects ?? {}).some((p) => p?.mcpServers?.prevail);
  } catch {
    return false;
  }
}

/** Write prevail into Claude's USER-scope mcpServers, preserving every other key.
 *  Used as the fallback when the `claude` CLI isn't on the app's PATH. */
function writeClaudeUserServer(): McpClientResult {
  const { command } = engineCommand();
  const base = claudeBase();
  let cfg: Record<string, unknown> = {};
  if (existsSync(CLAUDE_CONFIG)) {
    try {
      cfg = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf8").trim() || "{}") as Record<string, unknown>;
    } catch (e) {
      return { ...base, error: `~/.claude.json is not valid JSON: ${(e as Error).message}` };
    }
  }
  const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
  servers.prevail = { command, args: mcpArgs() };
  try {
    writeFileSync(CLAUDE_CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  return { ...base, registered: true };
}

/** Strip prevail from Claude's config at every scope (top-level + each project).
 *  The file-level companion to `claude mcp remove`, so removal works without the
 *  CLI on PATH. */
function removeClaudeServer(): void {
  if (!existsSync(CLAUDE_CONFIG)) return;
  try {
    const cfg = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf8").trim() || "{}") as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    let changed = false;
    if (cfg.mcpServers?.prevail) {
      delete cfg.mcpServers.prevail;
      changed = true;
    }
    for (const p of Object.values(cfg.projects ?? {})) {
      if (p?.mcpServers?.prevail) {
        delete p.mcpServers.prevail;
        changed = true;
      }
    }
    if (changed) writeFileSync(CLAUDE_CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

function installClaude(): McpClientResult {
  const { command, baseArgs } = engineCommand();
  const run = (args: string[]) =>
    spawnSync("claude", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10000 });
  // Prefer the CLI at USER scope (global, vault-move-proof, not tied to the cwd
  // the engine happened to run in). Best-effort remove first so re-install
  // refreshes. If `claude` isn't reachable (GUI PATH) or fails, write the file.
  run(["mcp", "remove", "prevail", "-s", "user"]);
  const r = run(["mcp", "add", "prevail", "-s", "user", "--", command, ...baseArgs, "mcp", "--unsafe-detach"]);
  if (r.error || r.status !== 0) return writeClaudeUserServer();
  return { ...claudeBase(), registered: true };
}

function installOne(c: McpClient): McpClientResult {
  if (c.kind === "claude") return { ...installClaude(), client: c.id };
  if (!c.file)
    return { client: c.id, present: c.present(), registered: false, error: "no config path" };
  const r = c.kind === "json" ? installJson(c.file) : installToml(c.file);
  return { ...r, client: c.id, present: c.present() };
}

// ── uninstall ─────────────────────────────────────────────────────────────────
function uninstallOne(c: McpClient): McpClientResult {
  const base: McpClientResult = {
    client: c.id,
    present: c.present(),
    registered: false,
    file: c.file,
  };
  if (c.kind === "claude") {
    // Try the CLI (covers any scope it tracks), then strip the file directly so
    // removal works even without `claude` on PATH.
    spawnSync("claude", ["mcp", "remove", "prevail", "-s", "user"], { stdio: "ignore" });
    removeClaudeServer();
    return { ...base, detail: "removed from ~/.claude.json" };
  }
  if (!c.file || !existsSync(c.file)) return { ...base, detail: "no config to edit" };
  try {
    if (c.kind === "json") {
      const cfg = JSON.parse(readFileSync(c.file, "utf8")) as Record<string, unknown>;
      const servers = cfg.mcpServers as Record<string, unknown> | undefined;
      if (servers && "prevail" in servers) {
        delete servers.prevail;
        writeFileSync(c.file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
      }
    } else {
      const text = readFileSync(c.file, "utf8");
      const header = "[mcp_servers.prevail]";
      const idx = text.indexOf(header);
      if (idx !== -1) {
        const after = text.indexOf("\n[", idx + header.length);
        const end = after === -1 ? text.length : after + 1;
        writeFileSync(
          c.file,
          `${text.slice(0, idx)}${end < text.length ? text.slice(end) : ""}`,
          "utf8",
        );
      }
    }
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  return { ...base, detail: "removed" };
}

// ── status (pure read) ────────────────────────────────────────────────────────
function statusOne(c: McpClient): McpClientResult {
  const base: McpClientResult = {
    client: c.id,
    present: c.present(),
    registered: false,
    file: c.file,
  };
  if (c.kind === "claude") {
    return { ...base, registered: claudeRegistered() };
  }
  if (!c.file || !existsSync(c.file)) return base;
  try {
    const text = readFileSync(c.file, "utf8");
    const registered =
      c.kind === "json"
        ? !!(JSON.parse(text || "{}") as { mcpServers?: Record<string, unknown> }).mcpServers
            ?.prevail
        : text.includes("[mcp_servers.prevail]");
    return { ...base, registered };
  } catch {
    return base;
  }
}

// ── orchestration + JSON handlers ─────────────────────────────────────────────
export interface McpInstallResult {
  ok: boolean;
  clients: McpClientResult[];
}

function pick(clients?: string[]): { list: McpClient[]; forced: boolean } {
  if (clients && clients.length) {
    const want = new Set(clients.map((c) => c.toLowerCase()));
    return { list: MCP_CLIENTS.filter((c) => want.has(c.id)), forced: true };
  }
  return { list: MCP_CLIENTS.filter((c) => c.present()), forced: false };
}

export function install(clients?: string[]): McpInstallResult {
  const { list } = pick(clients);
  const results = list.map(installOne);
  return { ok: results.every((r) => !r.error), clients: results };
}

export function uninstall(clients?: string[]): McpInstallResult {
  const { list } = pick(clients);
  const results = list.map(uninstallOne);
  return { ok: results.every((r) => !r.error), clients: results };
}

/** Status across EVERY known client (not just present ones), for the UI. */
export function status(): McpInstallResult {
  const results = MCP_CLIENTS.map(statusOne);
  return { ok: true, clients: results };
}
