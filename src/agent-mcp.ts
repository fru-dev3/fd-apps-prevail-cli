// Agent-facing MCP servers — the MCP servers Prevail's AI agent (the claude CLI)
// is allowed to use on agentic runs. This is distinct from the ingestion MCP
// registry: these are tools the AGENT calls live (e.g. the Composio gateway,
// which fronts 1000+ apps over one OAuth connection).
//
// The Composio gateway is keyed: the desktop hands the engine a Composio API
// key via the COMPOSIO_API_KEY env var (a "ck_..." value). When that key is
// present we materialize a machine-local Claude-Code-compatible agent MCP
// config at ~/.prevail/agent-mcp.json (NOT in the vault — it carries a secret),
// pointing at the hosted Composio Streamable-HTTP MCP endpoint with the key in
// the X-CONSUMER-API-KEY header. cli-bridge passes that file to claude via
// `--mcp-config` ONLY on the agentic `act` path, so a default chat turn is
// byte-for-byte unchanged and a run with no key never gets the flag at all.

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// The hosted Composio gateway. HTTP / Streamable-HTTP transport, authenticated
// with the consumer's Composio API key in the X-CONSUMER-API-KEY header. This is
// the shared contract the desktop relies on; do not change the URL or header.
export const COMPOSIO_URL = "https://connect.composio.dev/mcp";
export const COMPOSIO_KEY_ENV = "COMPOSIO_API_KEY";
export const NANGO_KEY_ENV = "NANGO_SECRET_KEY";

// The machine-local agent MCP config. Lives under ~/.prevail (always writable,
// machine-scoped) NOT the vault, because it embeds the Composio API key and the
// vault is backed up / synced across machines.
export function agentMcpConfigPath(): string {
  const base = process.env.PREVAIL_HOME || join(homedir(), ".prevail");
  return join(base, "agent-mcp.json");
}

export function composioApiKey(): string | null {
  const k = process.env[COMPOSIO_KEY_ENV];
  return k && k.trim() ? k.trim() : null;
}

// Build the Claude-Code-compatible .mcp.json shape for the Composio gateway.
function buildComposioConfig(key: string): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      composio: {
        type: "http",
        url: COMPOSIO_URL,
        headers: { "X-CONSUMER-API-KEY": key },
      },
    },
  };
}

// Materialize ~/.prevail/agent-mcp.json from the COMPOSIO_API_KEY env var and
// return its path, or null when no key is set. Idempotent: re-running rewrites
// the file with the current key. chmod 0600 because the file carries a secret.
export function writeAgentMcpConfig(): string | null {
  const key = composioApiKey();
  if (!key) return null;
  const p = agentMcpConfigPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(buildComposioConfig(key), null, 2));
    try { chmodSync(p, 0o600); } catch { /* best effort */ }
    return p;
  } catch {
    return null;
  }
}

// The `--mcp-config` path to hand claude on an agentic run, or null when there
// is nothing to inject. Returns a path ONLY when COMPOSIO_API_KEY is set (we
// write/refresh the config on demand); returns null otherwise so the caller
// adds no flag and the turn is unchanged.
export function agentMcpConfigForClaude(): string | null {
  if (!composioApiKey()) return null;
  return writeAgentMcpConfig();
}

// Status for the UI: is the Composio gateway configured (a key is present) and
// is its machine-local config materialized on disk.
export function composioStatus(): { configured: boolean; authorized: boolean } {
  const configured = !!composioApiKey();
  return { configured, authorized: configured && existsSync(agentMcpConfigPath()) };
}
