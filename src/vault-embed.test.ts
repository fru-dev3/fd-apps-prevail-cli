import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countFiles, isEmbeddedVault, migrateVaultToEmbedded, embeddedVaultPath } from "./vault-embed.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "prevail-embed-src-"));
  mkdirSync(join(dir, "tax"), { recursive: true });
  mkdirSync(join(dir, "health", "_log"), { recursive: true });
  writeFileSync(join(dir, "tax", "soul.md"), "# tax");
  writeFileSync(join(dir, "tax", "_state.md"), "state");
  writeFileSync(join(dir, "health", "soul.md"), "# health");
  writeFileSync(join(dir, "health", "_log", "2026-06-01.md"), "log");
  return dir; // 4 files
}

describe("countFiles", () => {
  it("counts files recursively, ignoring directories", () => {
    const v = makeVault();
    expect(countFiles(v)).toBe(4);
    rmSync(v, { recursive: true, force: true });
  });
  it("returns 0 for a missing dir", () => {
    expect(countFiles(join(tmpdir(), "definitely-not-here-xyz"))).toBe(0);
  });
});

describe("isEmbeddedVault", () => {
  it("recognizes the embedded location", () => {
    expect(isEmbeddedVault(embeddedVaultPath())).toBe(true);
    expect(isEmbeddedVault("/some/other/vault")).toBe(false);
  });
});

describe("migrateVaultToEmbedded", () => {
  it("copies the tree and verifies by file count, leaving the source intact", () => {
    const src = makeVault();
    const dest = mkdtempSync(join(tmpdir(), "prevail-embed-dst-"));
    const r = migrateVaultToEmbedded(src, join(dest, "vault"));
    expect(r.ok).toBe(true);
    expect(r.alreadyEmbedded).toBe(false);
    expect(r.sourceFiles).toBe(4);
    expect(r.copied).toBe(4);
    // Source is untouched.
    expect(countFiles(src)).toBe(4);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("is a no-op when src already is the destination", () => {
    const src = makeVault();
    const r = migrateVaultToEmbedded(src, src);
    expect(r.alreadyEmbedded).toBe(true);
    expect(r.ok).toBe(true);
    rmSync(src, { recursive: true, force: true });
  });

  it("throws on a missing source", () => {
    expect(() => migrateVaultToEmbedded(join(tmpdir(), "nope-xyz"), join(tmpdir(), "d")))
      .toThrow();
  });
});
