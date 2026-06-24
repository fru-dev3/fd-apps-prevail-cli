// G11 — factory reset / secure purge tests. Exercises the pure planner + the
// executor against a temp config dir + temp vault, so nothing touches the real
// ~/.prevail.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planPurge, purge } from "./purge.ts";

let dir: string;
let vault: string;

function seedSecrets(d: string) {
  writeFileSync(join(d, "config.json"), "{}");
  writeFileSync(join(d, "lock.json"), "{}");
  writeFileSync(join(d, "mcp.json"), "{}");
  writeFileSync(join(d, "telegram.json"), "{}");
  writeFileSync(join(d, "budget.jsonl"), "");
  writeFileSync(join(d, "watcher.jsonl"), "");
  writeFileSync(join(d, "sessions.db"), "");
  mkdirSync(join(d, "sessions"), { recursive: true });
  writeFileSync(join(d, "sessions", "work-abc.jsonl"), "");
  mkdirSync(join(d, "prompts"), { recursive: true });
  writeFileSync(join(d, "prompts", "work.md"), "");
  mkdirSync(join(d, "connectors", "gmail", "auth"), { recursive: true });
  writeFileSync(join(d, "connectors", "gmail", "auth", "refresh.token"), "SECRET");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prevail-purge-"));
  vault = mkdtempSync(join(tmpdir(), "prevail-vault-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});

describe("purge / factory reset", () => {
  test("dry-run plans every existing secret but deletes nothing", () => {
    seedSecrets(dir);
    const res = purge({ dir, vaultPath: vault, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.removed.length).toBe(0);
    const kinds = res.planned.map((t) => t.kind).sort();
    expect(kinds).toContain("config");
    expect(kinds).toContain("connectors");
    expect(kinds).toContain("telegram");
    // Everything still on disk.
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "connectors", "gmail", "auth", "refresh.token"))).toBe(true);
  });

  test("applies: removes app secrets, preserves the vault by default", () => {
    seedSecrets(dir);
    writeFileSync(join(vault, "note.md"), "my data");
    const res = purge({ dir, vaultPath: vault });
    expect(res.dryRun).toBe(false);
    // All secret files gone.
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect(existsSync(join(dir, "telegram.json"))).toBe(false);
    expect(existsSync(join(dir, "sessions"))).toBe(false);
    expect(existsSync(join(dir, "connectors"))).toBe(false);
    // Vault untouched + listed as kept.
    expect(existsSync(join(vault, "note.md"))).toBe(true);
    expect(res.kept.some((k) => k.target.kind === "vault")).toBe(true);
  });

  test("only enumerates targets that actually exist", () => {
    // Empty config dir → nothing to remove.
    const res = purge({ dir, vaultPath: vault, dryRun: true });
    expect(res.planned.filter((t) => t.kind !== "vault").length).toBe(0);
  });

  test("preserves the keyring when an encrypted vault is kept", () => {
    seedSecrets(dir);
    writeFileSync(join(dir, "vault-keyring.json"), "{}");
    // Mark the vault encrypted (presence of the marker file).
    writeFileSync(join(vault, ".prevail-encrypted"), new Date(0).toISOString());
    const res = purge({ dir, vaultPath: vault });
    // Keyring kept (deleting it would brick the encrypted vault).
    expect(existsSync(join(dir, "vault-keyring.json"))).toBe(true);
    expect(res.kept.some((k) => k.target.kind === "keyring")).toBe(true);
  });

  test("removes the keyring when the vault is plaintext", () => {
    seedSecrets(dir);
    writeFileSync(join(dir, "vault-keyring.json"), "{}");
    // No .prevail-encrypted marker → plaintext vault.
    const res = purge({ dir, vaultPath: vault });
    expect(existsSync(join(dir, "vault-keyring.json"))).toBe(false);
    expect(res.removed.some((t) => t.kind === "keyring")).toBe(true);
  });

  test("includeVault erases the vault too", () => {
    seedSecrets(dir);
    writeFileSync(join(dir, "vault-keyring.json"), "{}");
    writeFileSync(join(vault, ".prevail-encrypted"), new Date(0).toISOString());
    writeFileSync(join(vault, "note.md"), "my data");
    const res = purge({ dir, vaultPath: vault, includeVault: true });
    expect(existsSync(vault)).toBe(false);
    // With the vault being erased, the keyring is removed too.
    expect(existsSync(join(dir, "vault-keyring.json"))).toBe(false);
    expect(res.removed.some((t) => t.kind === "vault")).toBe(true);
    expect(res.removed.some((t) => t.kind === "keyring")).toBe(true);
  });

  test("planPurge is pure (no disk mutation)", () => {
    seedSecrets(dir);
    planPurge({ dir, vaultPath: vault });
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });
});
