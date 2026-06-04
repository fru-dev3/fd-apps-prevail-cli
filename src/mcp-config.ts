import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { configDir } from "./config.ts";

// MCP server auth-token state. Stored next to the rest of prevail's
// machine-local config (~/.prevail/) and chmod'd to 0600 because anyone
// holding this token can invoke council / chat / read_state against the
// vault. Auto-generated on first server boot — the user never has to
// think about it unless they want to rotate it.

export interface McpConfig {
  // 64-char hex string (32 random bytes). Treat as opaque; clients send
  // it back as `prevail-<token>` in the `_meta.authorization` field of
  // every JSON-RPC request after `initialize`.
  token: string;
  createdAt: string;
}

// configDir() resolves to ~/.prevail in production. Tests can redirect
// it to a tmpdir via PREVAIL_CONFIG_DIR — Node's os.homedir() is cached
// at process start on macOS, so mutating HOME mid-process doesn't work.
function effectiveConfigDir(): string {
  const override = process.env.PREVAIL_CONFIG_DIR;
  return override && override.length > 0 ? override : configDir();
}

export function mcpConfigPath(): string {
  return join(effectiveConfigDir(), "mcp.json");
}

// Read the persisted token, or generate + persist one on first call.
// Resilient to a corrupt mcp.json — a malformed file is overwritten with
// a fresh token rather than crashing the server boot. The trade-off:
// any client cached against the old token will start getting -32001
// "unauthorized" until it re-reads mcp.json.
export function readOrCreateMcpToken(): string {
  const file = mcpConfigPath();
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<McpConfig>;
      if (parsed && typeof parsed.token === "string" && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch {
      // Fall through to regenerate. The malformed file is about to be
      // overwritten — better than refusing to boot the server because
      // someone hand-edited the JSON.
    }
  }
  const token = randomBytes(32).toString("hex");
  const cfg: McpConfig = { token, createdAt: new Date().toISOString() };
  const dir = effectiveConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return token;
}
