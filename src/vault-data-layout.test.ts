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
  archiveLegacyBuild,
  BUILD_SUPPORTING_ENTRIES,
  countFiles,
  isAlreadyDataRoot,
  isDataLayout,
  migratableEntries,
  migrateToBuildLayout,
  migrateToDataLayout,
} from "./vault-data-layout.ts";
import { dataRoot, resolveDomainDir, appsContainer, newDomainDir } from "./path-safety.ts";
import { scanVault } from "./vault.ts";
import { appendScoreHistory, readScoreHistory } from "./score.ts";
import type { ContextScore } from "./manifest.ts";

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

  test("after migrate+repoint, archiveLegacyRoot sweeps EVERYTHING verified", () => {
    // migrate writes the marker; the config repoint (done by the CLI command)
    // makes every reader use data/, so all originals are safe to archive.
    migrateToDataLayout(vault);
    const { archiveDir, archived } = archiveLegacyRoot(vault, "20260616-000000");
    // Both containers AND the loose General files are archived (all mirrored).
    expect(archived).toContain("domains");
    expect(archived).toContain("apps");
    expect(archived).toContain("_decisions.jsonl");
    expect(archived).toContain("profile.md");
    // Root is clean of originals; copies under data/ remain; nothing deleted.
    expect(existsSync(join(vault, "_decisions.jsonl"))).toBe(false);
    expect(existsSync(join(vault, "data", "_decisions.jsonl"))).toBe(true);
    expect(existsSync(join(archiveDir, "_decisions.jsonl"))).toBe(true);
    // The data/ container itself is never archived (it's the live vault).
    expect(archived).not.toContain("data");
    expect(existsSync(join(vault, "data"))).toBe(true);
  });

  test("migrate writes a data-root marker; the repointed path is idempotent", () => {
    migrateToDataLayout(vault);
    // The vault root is NOT itself a data root (config still points here pre-repoint).
    expect(isAlreadyDataRoot(vault)).toBe(false);
    // The data/ dir (where config gets repointed to) carries the marker.
    expect(isAlreadyDataRoot(join(vault, "data"))).toBe(true);
  });

  test("archiveLegacyRoot refuses to run before migration", () => {
    expect(() => archiveLegacyRoot(vault, "x")).toThrow();
  });

  // Regression: the score-history log must land under data/domains/<d>/_log,
  // never at a stray <vault>/<d>/_log. (General leaked a root general/_log/
  // score.jsonl because appendScoreHistory joined the raw vault root.)
  test("appendScoreHistory writes under data/domains, not the vault root", () => {
    migrateToDataLayout(vault); // creates data/ so dataRoot() is <vault>/data
    mkdirSync(join(vault, "data", "domains", "general"), { recursive: true });
    appendScoreHistory(vault, "general", { score: 42 } as unknown as ContextScore);
    // Canonical location has the entry...
    const canonical = join(vault, "data", "domains", "general", "_log", "score.jsonl");
    expect(existsSync(canonical)).toBe(true);
    expect(readFileSync(canonical, "utf8")).toContain('"score":42');
    // ...and nothing leaked to the vault root.
    expect(existsSync(join(vault, "general"))).toBe(false);
    // readScoreHistory reads it back from the canonical home.
    expect(readScoreHistory(vault, "general").map((p) => p.score)).toContain(42);
  });
});

// B2-12: the build/ migrator — copy + verify + leave originals; archive never deletes.
describe("migrateToBuildLayout", () => {
  let v: string;
  beforeEach(() => { v = mkdtempSync(join(TEST_ROOT, "buildmig-")); });
  afterEach(() => { try { rmSync(v, { recursive: true, force: true }); } catch { /* noop */ } });

  test("copies supporting entries into build/, leaves originals, verifies", () => {
    writeFileSync(join(v, "_decisions.jsonl"), "{}\n");
    writeFileSync(join(v, "_intents.jsonl"), "{}\n{}\n");
    mkdirSync(join(v, "_meta"), { recursive: true });
    writeFileSync(join(v, "_meta", "alignment.json"), "{}");
    mkdirSync(join(v, "benchmark"), { recursive: true });
    writeFileSync(join(v, "benchmark", "q.json"), "{}");
    writeFileSync(join(v, "notes.json"), "[]");
    // CONTENT must NOT move.
    writeFileSync(join(v, "_memory.md"), "# mem");

    const r = migrateToBuildLayout(v);
    expect(r.ok).toBe(true);
    expect(r.copiedFiles).toBe(r.sourceFiles);
    // Copied into build/.
    expect(existsSync(join(v, "build", "_decisions.jsonl"))).toBe(true);
    expect(existsSync(join(v, "build", "_meta", "alignment.json"))).toBe(true);
    expect(existsSync(join(v, "build", "benchmark", "q.json"))).toBe(true);
    expect(existsSync(join(v, "build", "notes.json"))).toBe(true);
    // Originals LEFT in place (non-destructive).
    expect(existsSync(join(v, "_decisions.jsonl"))).toBe(true);
    // CONTENT never moved.
    expect(existsSync(join(v, "build", "_memory.md"))).toBe(false);
    expect(existsSync(join(v, "_memory.md"))).toBe(true);
  });

  test("BUILD_SUPPORTING_ENTRIES excludes content files", () => {
    // Per-domain/app CONTENT must never be swept into build/. profile.md and the
    // other config files (ideal-state.md, omega.md, AGENTS-operating.md,
    // calendar-external.json) ARE supporting entries now (build/ is their canonical
    // home), so they are intentionally not listed here.
    for (const c of ["_memory.md", "_state.md", "_skills", "domains", "apps"]) {
      expect(BUILD_SUPPORTING_ENTRIES).not.toContain(c);
    }
  });

  test("archiveLegacyBuild refuses before migration, then moves originals (never deletes)", () => {
    writeFileSync(join(v, "_decisions.jsonl"), "{}\n");
    expect(() => archiveLegacyBuild(v, "x")).toThrow(); // no build/ yet
    migrateToBuildLayout(v);
    const { archived, archiveDir } = archiveLegacyBuild(v, "20260618");
    expect(archived).toContain("_decisions.jsonl");
    // Moved out of root, into the archive, and the live copy survives in build/.
    expect(existsSync(join(v, "_decisions.jsonl"))).toBe(false);
    expect(existsSync(join(archiveDir, "_decisions.jsonl"))).toBe(true);
    expect(existsSync(join(v, "build", "_decisions.jsonl"))).toBe(true);
  });
});
