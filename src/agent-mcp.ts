// Agent-facing MCP servers - the MCP servers Prevail's AI agent (the claude CLI)
// is given on engine turns: the user's connected stdio MCP apps, the gated
// google_workspace connector, and Prevail's own action primitives. The config
// is materialized machine-locally at ~/.prevail/agent-mcp-<hash>.json (NOT in
// the vault) and cli-bridge passes it to claude via `--mcp-config`.

import { writeSecretFile } from "./secret-file.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { scanCommunityApps } from "./vault.ts";
import { resolveGwsBinary } from "./calendar-sync.ts";

// The machine-local agent MCP config. Lives under ~/.prevail (always writable,
// machine-scoped) NOT the vault, because it names machine-local binaries and the
// vault is backed up / synced across machines.
// A short, stable, filesystem-safe hash of a string (djb2 in hex). Used to give
// each vault its OWN agent-mcp config file.
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// The machine-local agent MCP config path. PER-VAULT: the file name carries a
// hash of the vault path, so two concurrent agent runs on DIFFERENT vaults (e.g.
// the desktop and a CLI run, or two windows) can never clobber each other's
// config and hand a spawned MCP server the WRONG vault (which previously caused
// tools to write to the wrong place - even to `/`). Same-vault runs share the
// file but write identical content, so that's safe. Absent vaultPath keeps the
// legacy shared name.
export function agentMcpConfigPath(vaultPath?: string): string {
  const base = process.env.PREVAIL_HOME || join(homedir(), ".prevail");
  const suffix = vaultPath && vaultPath.trim() ? `-${shortHash(vaultPath.trim())}` : "";
  return join(base, `agent-mcp${suffix}.json`);
}

// Build the stdio mcpServers entries for the vault's connected MCP apps. Scans
// the vault's connected apps for integration === "mcp" with a non-empty
// mcpSetup.command and emits one Claude-Code-compatible stdio server entry per
// app, keyed by the app id. The full spawn command string is split into
// { command: <first token>, args: [<rest>] }.
//
// NOTE: this is a naive whitespace split. It does NOT honor shell quoting, so a
// command with quoted arguments containing spaces (e.g. `foo --path "a b"`)
// will be split into the wrong tokens. The contract is a simple
// `npx -y <package>`-style command, which this handles correctly.
function buildConnectedMcpServers(vaultPath?: string): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  try {
    for (const app of scanCommunityApps(vaultPath)) {
      // A disabled app is fully inert: never inject its MCP server into the
      // agent's tool set (enabled === false means do-not-sync, do-not-expose,
      // do-not-run). Absent / true stays available.
      if (app.enabled === false) continue;
      if (app.integration !== "mcp") continue;
      const cmd = app.mcpSetup?.command?.trim();
      if (!cmd) continue;
      const parts = cmd.split(/\s+/);
      const command = parts[0];
      if (!command) continue;
      servers[app.id] = { command, args: parts.slice(1) };
    }
  } catch {
    // A malformed vault must never break agent wiring; just emit nothing.
  }
  return servers;
}

// Build the full mcpServers map that will be injected, keyed by server id: every
// connected stdio MCP app in the vault (integration "mcp" with a
// mcpSetup.command), plus google_workspace and prevail_acts when the vault is
// known. This is the single source of truth for BOTH the written config and the
// list of server ids the caller allow-lists, so the two can never drift apart.
function buildAgentMcpServers(
  vaultPath?: string,
  opts?: { domain?: string; googleAccount?: string },
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = { ...buildConnectedMcpServers(vaultPath) };
  // The gated Google Workspace tool: only wired in when (a) we know the vault to
  // queue approvals into and (b) the user has an authenticated gws CLI on this
  // machine. The agent reaches it as a stdio MCP server launched from THIS
  // executable (process.execPath is the prevail binary in the compiled build).
  // Reads run live; writes are queued to <vault>/_meta/pending_gws.json and only
  // run after explicit approval.
  if (vaultPath) {
    try {
      if (resolveGwsBinary()) {
        const domain = opts?.domain?.trim();
        // The user's Google-account chip selection (composer Modes). Threaded
        // here as the AUTHORITATIVE default target account for gws reads and
        // queued writes, so the connector honors the picked account even when
        // the model omits an `account:` tool-arg. Absent = today's behavior.
        const account = opts?.googleAccount?.trim();
        mcpServers["google_workspace"] = {
          command: process.execPath,
          args: [
            "gws-mcp",
            "--vault",
            vaultPath,
            ...(domain ? ["--domain", domain] : []),
            ...(account ? ["--account", account] : []),
          ],
        };
      }
    } catch {
      // gws detection must never break agent wiring.
    }
    // Prevail's OWN action primitives (create_skill / create_loop / remember).
    // Always wired in when we know the vault, so an agentic run saves skills,
    // loops, and memory into THIS vault — never the host model's native skill
    // folder / cron / sandbox. This is the model-agnostic execution surface.
    try {
      const domain = opts?.domain?.trim();
      mcpServers["prevail_acts"] = {
        command: process.execPath,
        args: ["acts-mcp", "--vault", vaultPath, ...(domain ? ["--domain", domain] : [])],
      };
    } catch {
      // never let acts wiring break a turn.
    }
  }
  return mcpServers;
}

export function writeAgentMcpConfig(
  vaultPath?: string,
  opts?: { domain?: string; googleAccount?: string },
): string | null {
  const mcpServers = buildAgentMcpServers(vaultPath, opts);
  if (Object.keys(mcpServers).length === 0) return null;
  const p = agentMcpConfigPath(vaultPath);
  try {
    writeSecretFile(p, JSON.stringify({ mcpServers }, null, 2));
    return p;
  } catch {
    return null;
  }
}

// The `--mcp-config` path to hand claude, or null when there is nothing to
// inject (no server to wire); the caller then adds no flag and the turn is
// unchanged.
export function agentMcpConfigForClaude(
  vaultPath?: string,
  opts?: { domain?: string; googleAccount?: string },
): string | null {
  return writeAgentMcpConfig(vaultPath, opts);
}

// The ids (server keys) of the MCP servers that WILL be injected for these
// opts. The caller uses these to allow exactly those servers' tools in headless
// chat (claude `-p` auto-denies un-allowed tool use, so without this the agent
// could not call them outside of skip-permissions act runs). Building from the
// same map as writeAgentMcpConfig guarantees the allow-list matches what was
// written.
export function agentMcpServerIds(
  vaultPath?: string,
  opts?: { domain?: string; googleAccount?: string },
): string[] {
  return Object.keys(buildAgentMcpServers(vaultPath, opts));
}
