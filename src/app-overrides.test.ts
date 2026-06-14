import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanCommunityApps, setCommunityAppEnabled, appOverridesPath } from "./vault.ts";

// Regression: toggling a BUNDLED community app's enabled flag used to write to
// the app's own manifest.json, which is read-only inside the app bundle — the
// write threw and the toggle silently no-opped. The fix routes enabled through
// a writable override file that scanCommunityApps folds back in.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const ROOT = join(TMP_BASE, `prevail-ovr-${process.pid}`);
const HOME = join(ROOT, "home");
const APPS = join(ROOT, "apps");

function seedBundledApp() {
  rmSync(ROOT, { recursive: true, force: true });
  const app = join(APPS, "demo-bank");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "SKILL.md"), "# Demo bank\n");
  writeFileSync(join(app, "manifest.json"), JSON.stringify({
    id: "demo-bank", name: "Demo Bank", domains: ["wealth"], integration: "api",
  }));
  mkdirSync(HOME, { recursive: true });
  // Point app discovery + the override file at the temp world (never the real home).
  process.env.PREVAIL_APPS_DIR = APPS;
  process.env.PREVAIL_HOME = HOME;
}

describe("app enabled override survives a read-only bundle", () => {
  beforeEach(seedBundledApp);
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.PREVAIL_APPS_DIR;
    delete process.env.PREVAIL_HOME;
  });

  test("an app defaults to enabled", () => {
    const app = scanCommunityApps().find((a) => a.id === "demo-bank");
    expect(app).toBeTruthy();
    expect(app!.enabled).not.toBe(false);
  });

  test("disabling persists to the override file and reflects in the scan", () => {
    const r = setCommunityAppEnabled("demo-bank", false);
    expect(r.ok).toBe(true);
    expect(r.path).toBe(appOverridesPath());
    expect(existsSync(appOverridesPath())).toBe(true);
    const app = scanCommunityApps().find((a) => a.id === "demo-bank");
    expect(app!.enabled).toBe(false);
  });

  test("re-enabling clears the override", () => {
    setCommunityAppEnabled("demo-bank", false);
    const r = setCommunityAppEnabled("demo-bank", true);
    expect(r.ok).toBe(true);
    const app = scanCommunityApps().find((a) => a.id === "demo-bank");
    expect(app!.enabled).not.toBe(false);
  });

  test("unknown app id is rejected", () => {
    const r = setCommunityAppEnabled("nope", false);
    expect(r.ok).toBe(false);
  });
});
