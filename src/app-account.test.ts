import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanCommunityApps, setCommunityAppAccount } from "./vault.ts";

// The generic "an app = a connector + an identity" contract: an app instance can
// be BOUND to one account of a multi-account connector (manifest.account), and
// the binding round-trips through the scanner so attach-time inheritance sees
// exactly what was written. Machine-agnostic: labels are arbitrary user labels.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const ROOT = join(TMP_BASE, `prevail-acct-${process.pid}`);
const HOME = join(ROOT, "home");
const APPS = join(ROOT, "apps");

function seedApp() {
  rmSync(ROOT, { recursive: true, force: true });
  const app = join(APPS, "google-personal");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "SKILL.md"), "# Google (personal)\n");
  writeFileSync(join(app, "manifest.json"), JSON.stringify({
    id: "google-personal", name: "Google (personal)", domains: ["productivity"], integration: "manual",
  }));
  mkdirSync(HOME, { recursive: true });
  process.env.PREVAIL_APPS_DIR = APPS;
  process.env.PREVAIL_HOME = HOME;
}

describe("app account identity binding", () => {
  beforeEach(seedApp);
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.PREVAIL_APPS_DIR;
    delete process.env.PREVAIL_HOME;
  });

  test("binding persists to the manifest and reflects in the scan", () => {
    const r = setCommunityAppAccount("google-personal", "personal", "someone@example.com");
    expect(r.ok).toBe(true);
    expect(r.account).toEqual({ label: "personal", address: "someone@example.com" });
    const app = scanCommunityApps().find((a) => a.id === "google-personal");
    expect(app!.account).toEqual({ label: "personal", address: "someone@example.com" });
  });

  test("clearing removes the binding ('' / off / none)", () => {
    setCommunityAppAccount("google-personal", "personal");
    for (const clear of ["", "off", "none"]) {
      setCommunityAppAccount("google-personal", "personal");
      const r = setCommunityAppAccount("google-personal", clear);
      expect(r.ok).toBe(true);
      expect(r.account).toBeNull();
      const app = scanCommunityApps().find((a) => a.id === "google-personal");
      expect(app!.account).toBeUndefined();
    }
  });

  test("unknown app id is rejected; other manifest fields survive a bind", () => {
    expect(setCommunityAppAccount("nope", "x").ok).toBe(false);
    setCommunityAppAccount("google-personal", "work");
    const app = scanCommunityApps().find((a) => a.id === "google-personal");
    expect(app!.domains).toEqual(["productivity"]);
    expect(app!.account?.label).toBe("work");
  });
});
