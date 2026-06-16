import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// validateVaultPath (correctly) forbids /var, /tmp-style system paths, so the
// macOS default tmpdir() (/var/folders/...) can't host a test vault. Use a temp
// dir under $HOME instead — a legitimate vault location.
const TEST_ROOT = join(homedir(), ".prevail-test-tmp");
mkdirSync(TEST_ROOT, { recursive: true });

import {
  archiveLegacyRoot,
  countFiles,
  isDataLayout,
  migratableEntries,
  migrateToDataLayout,
} from "./vault-data-layout.ts";
import { dataRoot, resolveDomainDir, appsContainer, newDomainDir } from "./path-safety.ts";
import { scanVault } from "./vault.ts";

let vault: string;

function writeFile(rel: string, body: string) {
  const full = join(vault, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

// A realistic pre-v4 vault: a v3 domains/ container with one domain, an apps/
// container, and the loose General-bucket files at the root.
function seedVault() {
  writeFile("domains/wealth/_state.md", "# Wealth\nnet worth up");
  writeFile("domains/wealth/_decisions.jsonl", '{"decision":"hold"}\n');
  writeFile("apps/gmail/manifest.json", '{"id":"gmail"}');
  writeFile("_decisions.jsonl", '{"decision":"general"}\n');
  writeFile("_intents.jsonl", '{"kind":"intent","message":"hi"}\n');
  writeFile("usage.ndjson", '{"tok":1}\n');
  writeFile("profile.md", "# Me");
  writeFile("AGENTS-operating.md", "# Ops");
}

beforeEach(() => {
  vault = mkdtempSync(join(TEST_ROOT, "prevail-w4-"));
  seedVault();
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("v4 data-layout migrator", () => {
  test("pre-migration: dataRoot is the vault root and reads work", () => {
    expect(dataRoot(vault)).toBe(vault);
    expect(isDataLayout(vault)).toBe(false);
    expect(resolveDomainDir(vault, "wealth")).toBe(join(vault, "domains", "wealth"));
    const domains = scanVault(vault).map((d) => d.name);
    expect(domains).toContain("wealth");
  });

  test("migration is non-destructive: originals stay, data/ gets a full copy", () => {
    const before = countFiles(vault);
    const r = migrateToDataLayout(vault);
    expect(r.ok).toBe(true);
    expect(r.alreadyMigrated).toBe(false);
    expect(r.movedEntries).toContain("domains");
    expect(r.movedEntries).toContain("apps");
    expect(r.movedEntries).toContain("_decisions.jsonl");
    // Originals untouched.
    expect(existsSync(join(vault, "domains", "wealth", "_state.md"))).toBe(true);
    expect(existsSync(join(vault, "_decisions.jsonl"))).toBe(true);
    // Copies present under data/ with identical content.
    expect(existsSync(join(vault, "data", "domains", "wealth", "_state.md"))).toBe(true);
    expect(readFileSync(join(vault, "data", "_decisions.jsonl"), "utf8"))
      .toBe(readFileSync(join(vault, "_decisions.jsonl"), "utf8"));
    // No file was lost: total count grew (root copy + data copy), never shrank.
    expect(countFiles(vault)).toBeGreaterThan(before);
  });

  test("after migration readers prefer data/ and the vault still resolves", () => {
    migrateToDataLayout(vault);
    expect(isDataLayout(vault)).toBe(true);
    expect(dataRoot(vault)).toBe(join(vault, "data"));
    expect(resolveDomainDir(vault, "wealth")).toBe(join(vault, "data", "domains", "wealth"));
    expect(appsContainer(vault)).toBe(join(vault, "data", "apps"));
    expect(newDomainDir(vault, "health")).toBe(join(vault, "data", "domains", "health"));
    // The scanner still finds the domain (now under data/), exactly once.
    const domains = scanVault(vault).map((d) => d.name).filter((n) => n === "wealth");
    expect(domains).toEqual(["wealth"]);
  });

  test("migration is idempotent — a re-run does not duplicate or fail", () => {
    migrateToDataLayout(vault);
    const r2 = migrateToDataLayout(vault);
    expect(r2.ok).toBe(true);
    expect(r2.alreadyMigrated).toBe(true);
    expect(scanVault(vault).map((d) => d.name).filter((n) => n === "wealth")).toEqual(["wealth"]);
  });

  test("the data/ container is never itself treated as a domain", () => {
    migrateToDataLayout(vault);
    expect(scanVault(vault).map((d) => d.name)).not.toContain("data");
    expect(migratableEntries(vault)).not.toContain("data");
  });

  test("archiveLegacyRoot sweeps only v4-aware containers; defers loose files", () => {
    migrateToDataLayout(vault);
    const { archiveDir, archived, deferred } = archiveLegacyRoot(vault, "20260616-000000");
    // domains/ + apps/ readers are v4-aware → safe to archive.
    expect(archived).toContain("domains");
    expect(archived).toContain("apps");
    expect(existsSync(join(vault, "domains"))).toBe(false);
    expect(existsSync(join(archiveDir, "domains"))).toBe(true); // moved, not deleted
    expect(existsSync(join(vault, "data", "domains", "wealth", "_state.md"))).toBe(true);
    // The General-bucket loose files are still read from the root → must NOT be
    // archived yet (would orphan them); they're reported as deferred instead.
    expect(deferred).toContain("_decisions.jsonl");
    expect(existsSync(join(vault, "_decisions.jsonl"))).toBe(true);
    // The vault still resolves entirely (domains now under data/).
    expect(scanVault(vault).map((d) => d.name)).toContain("wealth");
  });

  test("archiveLegacyRoot refuses to run before migration", () => {
    expect(() => archiveLegacyRoot(vault, "x")).toThrow();
  });
});
