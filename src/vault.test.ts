import { describe, expect, test } from "bun:test";
import { coerceRefresh } from "./vault.ts";

// coerceRefresh is the single validator the engine uses for the manifest
// `refresh.every` cadence. It must accept the legacy hourly/Nh/daily/weekly
// forms AND the new multi-day (<N>d, 1..90) / multi-week (<N>w, 1..12) forms,
// while still rejecting anything out of range or malformed.
describe("coerceRefresh cadences", () => {
  test("legacy forms still validate", () => {
    expect(coerceRefresh({ every: "hourly" })?.every).toBe("hourly");
    expect(coerceRefresh({ every: "6h" })?.every).toBe("6h");
    expect(coerceRefresh({ every: "daily" })?.every).toBe("daily");
    expect(coerceRefresh({ every: "weekly" })?.every).toBe("weekly");
  });

  test("multi-day cadences (1..90) validate", () => {
    expect(coerceRefresh({ every: "1d" })?.every).toBe("1d");
    expect(coerceRefresh({ every: "2d" })?.every).toBe("2d"); // every other day
    expect(coerceRefresh({ every: "3d" })?.every).toBe("3d");
    expect(coerceRefresh({ every: "90d" })?.every).toBe("90d");
  });

  test("multi-week cadences (1..12) validate", () => {
    expect(coerceRefresh({ every: "1w" })?.every).toBe("1w");
    expect(coerceRefresh({ every: "2w" })?.every).toBe("2w"); // every two weeks
    expect(coerceRefresh({ every: "12w" })?.every).toBe("12w");
  });

  test("out-of-range / malformed cadences are rejected", () => {
    expect(coerceRefresh({ every: "0d" })).toBeUndefined();
    expect(coerceRefresh({ every: "91d" })).toBeUndefined();
    expect(coerceRefresh({ every: "0w" })).toBeUndefined();
    expect(coerceRefresh({ every: "13w" })).toBeUndefined();
    expect(coerceRefresh({ every: "1h" })).toBeUndefined(); // 1h excluded by design
    expect(coerceRefresh({ every: "monthly" })).toBeUndefined();
    expect(coerceRefresh({ every: "2x" })).toBeUndefined();
  });

  test("optional at/on still carry through with a new cadence", () => {
    const r = coerceRefresh({ every: "2d", at: "07:30", on: "fri" });
    expect(r?.every).toBe("2d");
    expect(r?.at).toBe("07:30");
    expect(r?.on).toBe("fri");
  });
});

import { mkdirSync, rmSync, writeFileSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldCommunityApp, scanApps, seedAppParityFiles } from "./vault.ts";

// #55/#32 app/domain parity: "an app is a domain with a little bit more." A
// connected app gets the SAME standing-context files a domain does, in addition
// to its skills/ + manifest, all under data/apps/<id>/ (never the vault root).
describe("app/domain parity scaffolding", () => {
  const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
  const ROOT = join(TMP_BASE, `prevail-parity-${process.pid}`);

  function freshVault(): string {
    rmSync(ROOT, { recursive: true, force: true });
    // v4 vault: data/ exists, so apps land in data/apps and the root stays bare.
    mkdirSync(join(ROOT, "data", "apps"), { recursive: true });
    return ROOT;
  }

  test("scaffoldCommunityApp creates the domain-like parity files under data/apps/<id>", () => {
    const vault = freshVault();
    const r = scaffoldCommunityApp({ id: "acme", title: "Acme", integration: "manual", domains: ["wealth"], vaultRoot: vault });
    expect(r.ok).toBe(true);
    const appDir = join(vault, "data", "apps", "acme");
    // Its own skills/ + manifest (pre-existing behavior).
    expect(existsSync(join(appDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(appDir, "skills"))).toBe(true);
    // Domain-parity standing-context files.
    for (const f of ["soul.md", "state.md", "MEMORY.md", "_intents.jsonl"]) {
      expect(existsSync(join(appDir, f))).toBe(true);
    }
    expect(statSync(join(appDir, "_journal")).isDirectory()).toBe(true);
    expect(statSync(join(appDir, "_threads")).isDirectory()).toBe(true);
    // Canonical layout: nothing written at the vault root, only data/.
    const rootEntries = readdirSync(vault);
    expect(rootEntries).toEqual(["data"]);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("seedAppParityFiles is idempotent and edit-safe (never clobbers)", () => {
    const vault = freshVault();
    const appDir = join(vault, "data", "apps", "edited");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "MEMORY.md"), "USER CONTENT");
    seedAppParityFiles(appDir, "Edited");
    seedAppParityFiles(appDir, "Edited"); // re-run must be a no-op
    expect(readFileSync(join(appDir, "MEMORY.md"), "utf8")).toBe("USER CONTENT");
    expect(existsSync(join(appDir, "soul.md"))).toBe(true);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("scanApps reads the enabled flag off a vault app's manifest", () => {
    const vault = freshVault();
    scaffoldCommunityApp({ id: "onapp", title: "On", integration: "manual", domains: [], vaultRoot: vault });
    const offDir = join(vault, "data", "apps", "offapp");
    mkdirSync(offDir, { recursive: true });
    writeFileSync(join(offDir, "manifest.json"), JSON.stringify({ id: "offapp", name: "Off", integration: "manual", enabled: false }));
    const apps = scanApps(vault);
    expect(apps.find((a) => a.id === "onapp")!.enabled).not.toBe(false);
    expect(apps.find((a) => a.id === "offapp")!.enabled).toBe(false);
    rmSync(ROOT, { recursive: true, force: true });
  });
});
