import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateVaultPath, isSafeEntryName, resolveSafeChild } from "./path-safety.ts";

describe("validateVaultPath", () => {
  test("absolute non-system paths are allowed", () => {
    expect(validateVaultPath("/Users/alice/vault").ok).toBe(true);
  });

  test("filesystem root is rejected", () => {
    expect(validateVaultPath("/").ok).toBe(false);
  });

  test("system dirs are rejected", () => {
    for (const p of ["/etc/vault", "/var/lib", "/usr/local/share", "/System/Library", "/dev/null"]) {
      const r = validateVaultPath(p);
      expect(r.ok).toBe(false);
    }
  });

  test("relative paths are rejected", () => {
    expect(validateVaultPath("./vault").ok).toBe(false);
  });

  test("null byte in path is rejected", () => {
    expect(validateVaultPath("/Users/alice/vault\0evil").ok).toBe(false);
  });

  test("empty path is rejected", () => {
    expect(validateVaultPath("").ok).toBe(false);
  });
});

describe("isSafeEntryName", () => {
  test("normal names are accepted", () => {
    for (const n of ["wealth", "tax", "real-estate", "domain_name_42"]) {
      expect(isSafeEntryName(n)).toBe(true);
    }
  });

  test("dotted / parent-ref names are rejected", () => {
    for (const n of [".", "..", ".hidden"]) {
      expect(isSafeEntryName(n)).toBe(false);
    }
  });

  test("null bytes / control chars are rejected", () => {
    expect(isSafeEntryName("wealth\0evil")).toBe(false);
    expect(isSafeEntryName("wealth\n")).toBe(false);
    expect(isSafeEntryName("wealth\t")).toBe(false);
  });

  test("empty / oversized names rejected", () => {
    expect(isSafeEntryName("")).toBe(false);
    expect(isSafeEntryName("x".repeat(201))).toBe(false);
  });
});

describe("resolveSafeChild — symlink escape detection", () => {
  test("legit subdir resolves under root", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    mkdirSync(join(root, "wealth"));
    expect(resolveSafeChild(root, "wealth")).not.toBeNull();
  });

  test("symlink escaping the vault root is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secrets.md"), "shh");
    symlinkSync(outside, join(root, "wealth"));
    expect(resolveSafeChild(root, "wealth")).toBeNull();
  });

  test("non-existent child returns null without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    expect(resolveSafeChild(root, "nothing")).toBeNull();
  });
});
