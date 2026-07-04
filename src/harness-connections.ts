// The harness-connections registry: Prevail as a SUPERSET of every AI
// harness's connector ecosystem. Each vendor names and stores "a connection to
// an external app" differently:
//
//   Claude Code  ~/.claude.json mcpServers (local stdio/http servers) PLUS
//                account-level claude.ai connectors (remote MCP, synced with
//                the user's claude.ai account) visible only via `claude mcp
//                list` text output ("claude.ai PayPal: https://... - ✔ Connected").
//                Runtime tool names look like mcp__claude_ai_PayPal__<tool>.
//   Codex        ~/.codex/config.toml [mcp_servers.<id>] TOML blocks (local),
//                plus ChatGPT "apps/plugins" that live account-side only
//                (chatgpt.com/apps) and are reachable ONLY inside a Codex
//                session - no on-disk enumeration exists.
//   Gemini       ~/.gemini/settings.json mcpServers (same JSON shape as
//                Claude's local config).
//
// This module normalizes all of them into one inventory so the app's
// Connections page can show every lane an app is reachable through, and match
// them to Prevail app ids. Read-only; every reader is injectable for tests.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export type Harness = "claude" | "codex" | "gemini";

export interface HarnessConnection {
  harness: Harness;
  /** The vendor's own identifier (server key / connector display name). */
  id: string;
  /** Human display name ("PayPal"). */
  name: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  /** local-config = on this machine's disk; account = synced with the vendor
   *  account (claude.ai connectors, ChatGPT apps). */
  source: "local-config" | "account";
  url?: string;
  /** From live health output where available (claude mcp list ✔/!). */
  health?: "healthy" | "degraded" | "unknown";
}

export interface HarnessScan {
  connections: HarnessConnection[];
  /** Human notes about lanes that exist but can't be enumerated (ChatGPT apps). */
  notes: string[];
}

// ── Claude ───────────────────────────────────────────────────────────────────

export function parseClaudeLocalConfig(jsonText: string): HarnessConnection[] {
  try {
    const d = JSON.parse(jsonText) as { mcpServers?: Record<string, { type?: string; url?: string; command?: string }> };
    return Object.entries(d.mcpServers ?? {}).map(([id, v]) => ({
      harness: "claude" as const,
      id,
      name: id,
      transport: (v.type === "http" || v.type === "sse" ? v.type : v.command ? "stdio" : "unknown") as HarnessConnection["transport"],
      source: "local-config" as const,
      url: v.url,
    }));
  } catch {
    return [];
  }
}

// `claude mcp list` text: "claude.ai PayPal: https://mcp.paypal.com/mcp - ! Connected · tools fetch failed"
export function parseClaudeMcpList(text: string): HarnessConnection[] {
  const out: HarnessConnection[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?):\s+(https?:\/\/\S+)\s+-\s+(.*)$/);
    if (!m) continue;
    const rawName = m[1]!.trim();
    const status = m[3]!.trim();
    const isAccount = rawName.toLowerCase().startsWith("claude.ai ");
    out.push({
      harness: "claude",
      id: rawName,
      name: isAccount ? rawName.slice("claude.ai ".length).trim() : rawName,
      transport: m[2]!.includes("/sse") ? "sse" : "http",
      source: isAccount ? "account" : "local-config",
      url: m[2]!,
      health: /✔/.test(status) ? "healthy" : /!|✘|failed|error/i.test(status) ? "degraded" : "unknown",
    });
  }
  return out;
}

// ── Codex ────────────────────────────────────────────────────────────────────

// Minimal TOML block scan for [mcp_servers.<id>] + its command/url lines. A
// real TOML parser is overkill for this shape and adds a dependency.
export function parseCodexConfig(tomlText: string): HarnessConnection[] {
  const out: HarnessConnection[] = [];
  const seen = new Set<string>();
  const lines = tomlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*\[mcp_servers\.([A-Za-z0-9_.-]+)\]\s*$/);
    if (!m) continue;
    const id = m[1]!;
    if (id.includes(".") || seen.has(id)) continue; // sub-tables like x.tools.y
    seen.add(id);
    let transport: HarnessConnection["transport"] = "unknown";
    let url: string | undefined;
    for (let j = i + 1; j < lines.length && !lines[j]!.trim().startsWith("["); j++) {
      if (/^\s*command\s*=/.test(lines[j]!)) transport = "stdio";
      const u = lines[j]!.match(/^\s*url\s*=\s*"([^"]+)"/);
      if (u) { url = u[1]; transport = url.includes("/sse") ? "sse" : "http"; }
    }
    out.push({ harness: "codex", id, name: id, transport, source: "local-config", url });
  }
  return out;
}

// ── Gemini ───────────────────────────────────────────────────────────────────

export function parseGeminiSettings(jsonText: string): HarnessConnection[] {
  try {
    const d = JSON.parse(jsonText) as { mcpServers?: Record<string, { url?: string; httpUrl?: string; command?: string }> };
    return Object.entries(d.mcpServers ?? {}).map(([id, v]) => {
      const url = v.httpUrl ?? v.url;
      return {
        harness: "gemini" as const,
        id,
        name: id,
        transport: (v.command ? "stdio" : url ? (url.includes("/sse") ? "sse" : "http") : "unknown") as HarnessConnection["transport"],
        source: "local-config" as const,
        url,
      };
    });
  } catch {
    return [];
  }
}

// ── Scan ─────────────────────────────────────────────────────────────────────

export interface ScanIO {
  readFile: (p: string) => string | null;
  runClaudeMcpList: () => string | null;
}

const defaultIO: ScanIO = {
  readFile: (p) => {
    try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; }
  },
  runClaudeMcpList: () => {
    try {
      const r = spawnSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 25_000 });
      return r.status === 0 ? r.stdout : null;
    } catch { return null; }
  },
};

export function scanHarnessConnections(io: ScanIO = defaultIO): HarnessScan {
  const connections: HarnessConnection[] = [];
  const notes: string[] = [];
  const home = homedir();

  const claudeCfg = io.readFile(join(home, ".claude.json"));
  if (claudeCfg) connections.push(...parseClaudeLocalConfig(claudeCfg));
  const list = io.runClaudeMcpList();
  if (list) {
    // The live list supersedes config entries with the same id (it has health).
    const fromList = parseClaudeMcpList(list);
    const listIds = new Set(fromList.map((c) => c.id.toLowerCase()));
    for (let i = connections.length - 1; i >= 0; i--) {
      if (connections[i]!.harness === "claude" && listIds.has(connections[i]!.id.toLowerCase())) connections.splice(i, 1);
    }
    connections.push(...fromList);
  } else {
    notes.push("claude mcp list unavailable - account connectors (claude.ai) not enumerated");
  }

  const codexCfg = io.readFile(join(home, ".codex", "config.toml"));
  if (codexCfg) connections.push(...parseCodexConfig(codexCfg));
  notes.push("ChatGPT apps/plugins are account-side and reachable only inside a Codex session - route the app's chat to the codex runtime to use them");

  const gem = io.readFile(join(home, ".gemini", "settings.json")) ?? io.readFile(join(home, ".config", "gemini", "settings.json"));
  if (gem) connections.push(...parseGeminiSettings(gem));

  return { connections, notes };
}

// Match an app (id + title) against the inventory: normalized substring match
// in either direction, so "paypal" ↔ "claude.ai PayPal" ↔ "PayPal" all meet.
export function matchAppConnections(appId: string, appTitle: string, scan: HarnessScan): HarnessConnection[] {
  const norm = (s: string) => s.toLowerCase().replace(/^claude\.ai\s+/, "").replace(/[^a-z0-9]+/g, "");
  const wants = [norm(appId), norm(appTitle)].filter(Boolean);
  return scan.connections.filter((c) => {
    const n = norm(c.name);
    if (!n) return false;
    return wants.some((w) => w && (n.includes(w) || w.includes(n)));
  });
}
