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

// Adoption contract: connecting an app whose folder ALREADY exists on disk
// (hand-created or from an external import pipeline) adopts it - missing
// canonical manifest fields are filled, user skills and values are untouched,
// and a fresh scaffold over a manifest-less folder keeps its SKILL.md.
import { scaffoldCommunityApp } from "./vault.ts";
import { readFileSync as _rd } from "node:fs";

describe("app folder adoption (pre-existing dirs)", () => {
  beforeEach(seedApp);

  test("existing manifest is adopted: missing fields filled, user values kept, skills untouched", () => {
    const dir = join(APPS, "posthog");
    mkdirSync(join(dir, "skills", "usage-report"), { recursive: true });
    writeFileSync(join(dir, "skills", "usage-report", "SKILL.md"), "# usage-report\nmy imported skill\n");
    writeFileSync(join(dir, "SKILL.md"), "# My PostHog notes\n");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "PostHog (mine)", domains: ["dev"] }));
    const r = scaffoldCommunityApp({ id: "posthog", title: "PostHog", integration: "api", domains: ["business"] });
    expect(r.ok).toBe(true);
    const m = JSON.parse(_rd(join(dir, "manifest.json"), "utf8"));
    expect(m.id).toBe("posthog");                       // canonical id healed in
    expect(m.name).toBe("PostHog (mine)");              // user's value preserved
    expect(m.domains.sort()).toEqual(["business", "dev"]); // domains unioned
    expect(m.integration).toBe("api");                  // missing field filled
    // User files untouched.
    expect(_rd(join(dir, "SKILL.md"), "utf8")).toContain("My PostHog notes");
    expect(_rd(join(dir, "skills", "usage-report", "SKILL.md"), "utf8")).toContain("my imported skill");
    // And the app now shows up in the scan.
    expect(scanCommunityApps().some((a) => a.id === "posthog")).toBe(true);
  });

  test("manifest-less imported folder: fresh scaffold keeps its SKILL.md", () => {
    const dir = join(APPS, "stessa");
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# Imported stessa instructions\n");
    const r = scaffoldCommunityApp({ id: "stessa", title: "Stessa", integration: "api", domains: ["real-estate"] });
    expect(r.ok).toBe(true);
    expect(_rd(join(dir, "SKILL.md"), "utf8")).toContain("Imported stessa instructions");
    expect(JSON.parse(_rd(join(dir, "manifest.json"), "utf8")).id).toBe("stessa");
  });

  test("an unparseable existing manifest fails with an honest, actionable error", () => {
    const dir = join(APPS, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{not json");
    const r = scaffoldCommunityApp({ id: "broken", title: "Broken", integration: "api", domains: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not be adopted");
  });
});
