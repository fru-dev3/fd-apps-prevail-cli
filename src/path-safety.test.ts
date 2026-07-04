import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateVaultPath,
  isSafeEntryName,
  resolveSafeChild,
  appScopeId,
  resolveDomainDir,
  newDomainDir,
} from "./path-safety.ts";

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

describe("appScopeId — _app-<id> scope keys", () => {
  test("strips the _app- prefix to the app id", () => {
    expect(appScopeId("_app-google")).toBe("google");
    expect(appScopeId("_app-composio-notion")).toBe("composio-notion");
    expect(appScopeId("_app-my_app")).toBe("my_app");
  });

  test("normal domains are not app scopes", () => {
    for (const d of ["health", "wealth", "general", "app-store", "_appstore"]) {
      expect(appScopeId(d)).toBeNull();
    }
  });

  test("empty id and traversal attempts are rejected", () => {
    expect(appScopeId("_app-")).toBeNull();
    expect(appScopeId("_app-../evil")).toBeNull();
    expect(appScopeId("_app-a/b")).toBeNull();
    expect(appScopeId("_app-a\\b")).toBeNull();
  });
});

describe("resolveDomainDir / newDomainDir — app-scope rerouting", () => {
  // Functional check: an _app-<id> scope key must land under data/apps/<id>
  // (never data/domains), while a real domain still resolves under data/domains.
  function mkV4Vault(): string {
    const root = mkdtempSync(join(tmpdir(), "vault-appscope-"));
    mkdirSync(join(root, "data", "apps"), { recursive: true });
    mkdirSync(join(root, "data", "domains"), { recursive: true });
    return root;
  }

  test("_app-google resolves under data/apps/google, not data/domains", () => {
    const vault = mkV4Vault();
    const resolved = resolveDomainDir(vault, "_app-google");
    expect(resolved).toBe(join(vault, "data", "apps", "google", "_scope"));
    expect(resolved.startsWith(join(vault, "data", "apps") + "/")).toBe(true);
    expect(resolved).not.toContain(join("data", "domains"));
    // Same target for a brand-new scope.
    expect(newDomainDir(vault, "_app-google")).toBe(resolved);
  });

  test("a real domain still resolves under data/domains", () => {
    const vault = mkV4Vault();
    mkdirSync(join(vault, "data", "domains", "health"), { recursive: true });
    const resolved = resolveDomainDir(vault, "health");
    expect(resolved).toBe(join(vault, "data", "domains", "health"));
    expect(resolved).not.toContain(join("data", "apps"));
    expect(newDomainDir(vault, "health")).toBe(join(vault, "data", "domains", "health"));
  });

  test("app-scope thread dir lives inside the app, never among domains", () => {
    const vault = mkV4Vault();
    const threadsDir = join(resolveDomainDir(vault, "_app-composio-notion"), "_threads");
    expect(threadsDir).toBe(
      join(vault, "data", "apps", "composio-notion", "_scope", "_threads"),
    );
    expect(threadsDir).not.toContain(join("data", "domains"));
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
