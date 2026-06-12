import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFile, readAppMode, readConfig, setAppMode, writeConfig } from "./config.ts";

// config.ts honors PREVAIL_CONFIG_DIR as its test seam (os.homedir() is cached
// at process start, so mutating HOME mid-process can't reroute configDir()).

let savedDir: string | undefined;
let tmpDir: string;

beforeEach(() => {
  savedDir = process.env.PREVAIL_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "prevail-config-"));
  process.env.PREVAIL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = savedDir;
});

describe("app mode", () => {
  test("defaults to production when no config exists", () => {
    expect(readConfig()).toBeNull();
    expect(readAppMode()).toBe("production");
  });

  // Regression: setAppMode used to early-return when no config existed, so the
  // first-launch demo flow could never flip the flag and the demo badge never
  // appeared. It must now seed a config and persist the mode.
  test("setAppMode('demo') seeds a config on first launch and persists", () => {
    expect(readConfig()).toBeNull();
    setAppMode("demo");
    expect(existsSync(configFile())).toBe(true);
    expect(readAppMode()).toBe("demo");
    const cfg = readConfig();
    expect(cfg?.appMode).toBe("demo");
    // A fresh config must carry a vaultPath (required field) — the bundled
    // demo vault when the caller didn't supply one.
    expect(typeof cfg?.vaultPath).toBe("string");
    expect((cfg?.vaultPath ?? "").length).toBeGreaterThan(0);
  });

  test("setAppMode seeds the caller-supplied vault path when given", () => {
    const sandbox = join(tmpDir, "demo-vault");
    setAppMode("demo", sandbox);
    expect(readConfig()?.vaultPath).toBe(sandbox);
    expect(readAppMode()).toBe("demo");
  });

  test("setAppMode preserves existing config fields", () => {
    writeConfig({
      vaultPath: "/real/vault",
      createdAt: new Date().toISOString(),
      councilDefaultOn: true,
    });
    setAppMode("demo");
    const cfg = readConfig();
    expect(cfg?.vaultPath).toBe("/real/vault"); // unchanged
    expect(cfg?.councilDefaultOn).toBe(true); // unchanged
    expect(cfg?.appMode).toBe("demo");
  });

  test("setAppMode follows a caller-supplied vault on an existing config", () => {
    writeConfig({
      vaultPath: "/demo/sandbox",
      createdAt: new Date().toISOString(),
      appMode: "demo",
    });
    // The production switch names the real vault — config must follow it,
    // or CLI/scheduled runs without --vault keep reading the demo sandbox.
    setAppMode("production", "/real/vault");
    const cfg = readConfig();
    expect(cfg?.vaultPath).toBe("/real/vault");
    expect(cfg?.appMode).toBe("production");
  });

  test("round-trips back to production", () => {
    setAppMode("demo");
    expect(readAppMode()).toBe("demo");
    setAppMode("production");
    expect(readAppMode()).toBe("production");
  });
});
