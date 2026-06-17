// End-to-end test of the autonomous-connect mechanism, minus the LLM research
// step (which needs a model). It exercises the deterministic core that the
// `prevail connect` command runs after the research agent returns a plan:
//
//   scaffoldCommunityApp(plan)  →  scanApps(vault)  →  probeConnector(app)
//
// i.e. write the connector + its auth_check into the vault, rescan it back the
// way the app would on launch, then RUN the auth_check to verify the connection
// actually works. Uses local commands (true/false) as the auth_check so no real
// third-party credentials are required — the point is the wiring, not a live API.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCommunityApp, scanApps } from "./vault.ts";
import { probeConnector } from "./connector-probe.ts";
import type { AuthCheckSpec } from "./connector-probe.ts";

let vaultRoot: string;
let prevAppsEnv: string | undefined;

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "prevail-connect-e2e-"));
  prevAppsEnv = process.env.PREVAIL_APPS_DIR;
  // Point the scaffolder at the same <vault>/apps the scanner reads, so the
  // round-trip mirrors a real vault: scaffold writes there, scanApps(vault) finds it.
  process.env.PREVAIL_APPS_DIR = join(vaultRoot, "apps");
});

afterEach(() => {
  if (prevAppsEnv === undefined) delete process.env.PREVAIL_APPS_DIR;
  else process.env.PREVAIL_APPS_DIR = prevAppsEnv;
  try { rmSync(vaultRoot, { recursive: true, force: true }); } catch {}
});

describe("autonomous connect — scaffold → rescan → probe", () => {
  test("a connector with a passing command auth_check verifies end-to-end", async () => {
    // 1. Scaffold, as the connect command does once the agent returns a plan.
    const scaffold = scaffoldCommunityApp({
      id: "demo-pass",
      title: "Demo Pass",
      integration: "api",
      domains: ["health"],
      authCheck: { kind: "command", command: "true" },
      refreshEvery: "1d",
    });
    expect(scaffold.ok).toBe(true);

    // 2. Rescan the vault the way the app does — the auth_check must survive the
    //    round-trip through manifest.json back onto the AppSkill.
    const apps = scanApps(vaultRoot);
    const app = apps.find((a) => a.id === "demo-pass");
    expect(app).toBeDefined();
    expect(app!.authCheck).toBeDefined();

    // 3. Probe: run the auth_check and confirm the connection is verified.
    const probe = await probeConnector(app!, (app!.authCheck as AuthCheckSpec) ?? null);
    expect(probe.ok).toBe(true);
    expect(probe.status).toBe("connected");
  });

  test("a connector with a failing command auth_check reports unverified, not crash", async () => {
    const scaffold = scaffoldCommunityApp({
      id: "demo-fail",
      title: "Demo Fail",
      integration: "api",
      domains: ["wealth"],
      authCheck: { kind: "command", command: "false" },
      refreshEvery: null,
    });
    expect(scaffold.ok).toBe(true);

    const app = scanApps(vaultRoot).find((a) => a.id === "demo-fail");
    expect(app).toBeDefined();

    const probe = await probeConnector(app!, (app!.authCheck as AuthCheckSpec) ?? null);
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe("error");
  });

  test("a connector scaffolded without an auth_check probes as not-configured", async () => {
    const scaffold = scaffoldCommunityApp({
      id: "demo-noauth",
      title: "Demo NoAuth",
      integration: "manual",
      domains: ["learning"],
    });
    expect(scaffold.ok).toBe(true);

    const app = scanApps(vaultRoot).find((a) => a.id === "demo-noauth");
    expect(app).toBeDefined();

    const probe = await probeConnector(app!, (app!.authCheck as AuthCheckSpec | undefined) ?? null);
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe("not-configured");
  });
});
