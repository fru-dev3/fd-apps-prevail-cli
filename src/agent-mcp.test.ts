import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentMcpServerIds } from "./agent-mcp.ts";

// #31 disabled apps are fully inert: a disabled connector's MCP server must NOT
// be injected into the agent's tool set. agentMcpServerIds is the single source
// of truth for which servers get written + allow-listed, so it must drop a
// disabled app's server.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const ROOT = join(TMP_BASE, `prevail-agentmcp-${process.pid}`);
const HOME = join(ROOT, "home");
const APPS = join(ROOT, "apps");

function seedMcpApps() {
  rmSync(ROOT, { recursive: true, force: true });
  const on = join(APPS, "mcp-on");
  const off = join(APPS, "mcp-off");
  mkdirSync(on, { recursive: true });
  mkdirSync(off, { recursive: true });
  writeFileSync(join(on, "SKILL.md"), "# On\n");
  writeFileSync(join(on, "manifest.json"), JSON.stringify({
    id: "mcp-on", name: "On", integration: "mcp", mcp: { command: "npx -y server-on" },
  }));
  writeFileSync(join(off, "SKILL.md"), "# Off\n");
  writeFileSync(join(off, "manifest.json"), JSON.stringify({
    id: "mcp-off", name: "Off", integration: "mcp", enabled: false, mcp: { command: "npx -y server-off" },
  }));
  mkdirSync(HOME, { recursive: true });
  process.env.PREVAIL_APPS_DIR = APPS;
  process.env.PREVAIL_HOME = HOME;
}

describe("agent MCP injection excludes disabled apps (#31)", () => {
  beforeEach(seedMcpApps);
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.PREVAIL_APPS_DIR;
    delete process.env.PREVAIL_HOME;
  });

  test("an enabled MCP app is injected; a disabled one is not", () => {
    // No vaultPath, no COMPOSIO_API_KEY => only the connected stdio MCP apps.
    const ids = agentMcpServerIds(undefined, { includeComposio: false });
    expect(ids).toContain("mcp-on");
    expect(ids).not.toContain("mcp-off");
  });
});
