// Agent-facing MCP servers — the MCP servers Prevail's AI agent (the claude CLI)
// is allowed to use on agentic runs. This is distinct from the ingestion MCP
// registry: these are tools the AGENT calls live (e.g. the Composio gateway,
// which fronts 1000+ apps over one OAuth connection).
//
// The config is a Claude-Code-compatible `.mcp.json` at the vault root (single
// source of truth, travels with the vault backup). cli-bridge passes it to
// claude via `--mcp-config` ONLY on the agentic `act` path and ONLY once the
// servers are authorized, so a default chat turn is byte-for-byte unchanged and
// a headless run never blocks on an un-authorized OAuth server.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The hosted Composio gateway. Registered as an `npx mcp-remote` stdio bridge:
// mcp-remote drives the browser OAuth once, caches the token under ~/.mcp-auth,
// then proxies the remote Streamable-HTTP MCP server for the agent. This is the
// standard pattern for a remote OAuth MCP server in Claude Desktop / Code.
export const COMPOSIO_URL = "https://connect.composio.dev/mcp";
const COMPOSIO_SERVER = {
  command: "npx",
  args: ["-y", "mcp-remote", COMPOSIO_URL],
};

export function agentMcpConfigPath(vaultRoot: string): string {
  return join(vaultRoot, ".mcp.json");
}

// A per-server "this server completed its OAuth" marker. We only hand a server
// to a headless agent run once it's authorized, so mcp-remote reuses its cached
// token instead of trying to pop a browser mid-run.
export function agentMcpAuthMarker(vaultRoot: string, server: string): string {
  return join(vaultRoot, `.mcp-${server}-authorized`);
}

type McpConfigFile = { mcpServers?: Record<string, unknown> };

function readConfig(vaultRoot: string): McpConfigFile {
  const p = agentMcpConfigPath(vaultRoot);
  if (!existsSync(p)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as McpConfigFile;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") parsed.mcpServers = {};
    return parsed;
  } catch {
    return { mcpServers: {} };
  }
}

function writeConfig(vaultRoot: string, cfg: McpConfigFile): void {
  writeFileSync(agentMcpConfigPath(vaultRoot), JSON.stringify(cfg, null, 2));
}

// Merge the Composio server into the vault's .mcp.json. Idempotent — re-running
// is a no-op. Never clobbers other servers the user/agent has added.
export function addComposioToAgentConfig(vaultRoot: string): { ok: boolean; path: string; alreadyPresent: boolean } {
  const cfg = readConfig(vaultRoot);
  const present = !!cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, "composio");
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), composio: COMPOSIO_SERVER };
  writeConfig(vaultRoot, cfg);
  return { ok: true, path: agentMcpConfigPath(vaultRoot), alreadyPresent: present };
}

export function removeFromAgentConfig(vaultRoot: string, server: string): void {
  const cfg = readConfig(vaultRoot);
  if (cfg.mcpServers && server in cfg.mcpServers) {
    delete cfg.mcpServers[server];
    writeConfig(vaultRoot, cfg);
  }
}

export function markServerAuthorized(vaultRoot: string, server: string): void {
  try { writeFileSync(agentMcpAuthMarker(vaultRoot, server), new Date().toISOString()); } catch { /* best effort */ }
}

export function isServerAuthorized(vaultRoot: string, server: string): boolean {
  return existsSync(agentMcpAuthMarker(vaultRoot, server));
}

// The `--mcp-config` path to hand claude, or null if nothing is ready. Returns a
// path only when the managed config exists, has at least one server, and every
// configured server is authorized — so we never inject an un-authorized OAuth
// server into a headless `-p` run (which would block trying to open a browser).
export function agentMcpConfigForClaude(vaultRoot: string | undefined | null): string | null {
  if (!vaultRoot) return null;
  const p = agentMcpConfigPath(vaultRoot);
  if (!existsSync(p)) return null;
  const cfg = readConfig(vaultRoot);
  const servers = Object.keys(cfg.mcpServers ?? {});
  if (servers.length === 0) return null;
  for (const s of servers) {
    if (!isServerAuthorized(vaultRoot, s)) return null;
  }
  return p;
}

// Status for the UI: is Composio configured, and is it authorized + live.
export function composioStatus(vaultRoot: string): { configured: boolean; authorized: boolean } {
  const cfg = readConfig(vaultRoot);
  const configured = !!cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, "composio");
  return { configured, authorized: configured && isServerAuthorized(vaultRoot, "composio") };
}
