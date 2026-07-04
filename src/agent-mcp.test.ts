import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentMcpServerIds, writeAgentMcpConfig } from "./agent-mcp.ts";

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

// Fix 1: the composer's Google-account chip selection is threaded to the
// gws-mcp launch as an authoritative default target account. When
// opts.googleAccount is set, the google_workspace server is launched with
// `--account <label>`; when it is absent the flag is omitted (backward-compat).
describe("gws-mcp launch honors the picked Google account (Fix 1)", () => {
  const GWS_ROOT = join(TMP_BASE, `prevail-gwsacct-${process.pid}`);
  const GWS_HOME = join(GWS_ROOT, "home");
  const VAULT = join(GWS_ROOT, "vault");
  const FAKE_GWS = join(GWS_ROOT, "gws");

  beforeEach(() => {
    rmSync(GWS_ROOT, { recursive: true, force: true });
    mkdirSync(GWS_HOME, { recursive: true });
    mkdirSync(VAULT, { recursive: true });
    // A real file so resolveGwsBinary() returns truthy and the gws server wires in.
    writeFileSync(FAKE_GWS, "#!/bin/sh\n");
    process.env.PREVAIL_HOME = GWS_HOME;
    process.env.PREVAIL_GWS_BIN = FAKE_GWS;
  });
  afterAll(() => {
    rmSync(GWS_ROOT, { recursive: true, force: true });
    delete process.env.PREVAIL_HOME;
    delete process.env.PREVAIL_GWS_BIN;
  });

  function gwsArgs(googleAccount?: string): string[] {
    const p = writeAgentMcpConfig(VAULT, { includeComposio: false, googleAccount });
    expect(p).not.toBeNull();
    const cfg = JSON.parse(readFileSync(p!, "utf8")) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    const gws = cfg.mcpServers["google_workspace"];
    expect(gws).toBeDefined();
    return gws!.args ?? [];
  }

  test("a picked account adds --account <label> to the gws-mcp launch", () => {
    const args = gwsArgs("fru.dev");
    const idx = args.indexOf("--account");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("fru.dev");
  });

  test("no picked account => no --account flag (backward compatible)", () => {
    const args = gwsArgs(undefined);
    expect(args).not.toContain("--account");
  });
});
