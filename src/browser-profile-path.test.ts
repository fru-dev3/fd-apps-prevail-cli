// Browser-automation Chrome profiles must live MACHINE-LOCAL, never inside the
// synced vault. These tests pin the path shape, the id sanitization, the pure
// (no-side-effect) resolver, and the one-time non-destructive migration that
// moves a legacy in-vault profile out to the machine-local home.

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  browserProfileDir,
  browserProfilePath,
  browserProfilesRoot,
  sanitizeConnectorId,
} from "./path-safety.ts";

const root = browserProfilesRoot();
const created: string[] = [];
function uniqueId(tag: string): string {
  const id = `test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  created.push(join(root, id));
  return id;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("browserProfilesRoot / browserProfilePath", () => {
  test("root is ~/.prevail/browser-profiles, under home", () => {
    expect(root).toBe(join(homedir(), ".prevail", "browser-profiles"));
    expect(root.startsWith(homedir())).toBe(true);
  });

  test("browserProfilePath is pure — resolves without creating anything", () => {
    const id = uniqueId("pure");
    const p = browserProfilePath(id);
    expect(p).toBe(join(root, id, "profile"));
    expect(existsSync(p)).toBe(false); // no side effects
  });

  test("path is never under a vault-looking location", () => {
    const p = browserProfilePath("fidelity-com");
    expect(p).toBe(join(root, "fidelity-com", "profile"));
    expect(p.includes(`${"data"}/apps/`)).toBe(false);
    expect(p.includes("/auth/profile")).toBe(false);
    expect(p.startsWith(homedir())).toBe(true);
  });
});

describe("sanitizeConnectorId", () => {
  test("lowercases, strips unsafe chars, takes basename", () => {
    expect(sanitizeConnectorId("Fidelity-COM")).toBe("fidelity-com");
    expect(sanitizeConnectorId("a b!c@d")).toBe("a-b-c-d");
    // a full connectorDir collapses to the app id (basename)
    expect(sanitizeConnectorId("/some/vault/data/apps/fidelity-com")).toBe("fidelity-com");
    expect(sanitizeConnectorId("keeps.dots_and-dashes")).toBe("keeps.dots_and-dashes");
  });

  test("never empty; slashes/dots can't escape a segment", () => {
    expect(sanitizeConnectorId("")).toBe("connector");
    expect(sanitizeConnectorId("///")).toBe("connector");
    expect(sanitizeConnectorId("..")).toBe("connector"); // basename ".." -> trimmed to empty -> fallback
    const p = browserProfilePath("../../etc/passwd");
    // basename is "passwd"; path stays under the profiles root
    expect(p).toBe(join(root, "passwd", "profile"));
    expect(p.startsWith(root)).toBe(true);
  });
});

describe("browserProfileDir", () => {
  test("creates the machine-local dir on demand, under home, not a vault", () => {
    const id = uniqueId("create");
    const dir = browserProfileDir(id);
    expect(dir).toBe(join(root, id, "profile"));
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(join(homedir(), ".prevail", "browser-profiles"))).toBe(true);
  });

  test("one-time migration moves a legacy in-vault profile out to the new home", () => {
    const id = uniqueId("migrate");
    const vault = mkdtempSync(join(tmpdir(), "prevail-vault-"));
    try {
      const legacy = join(vault, "data", "apps", id, "auth", "profile");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "Cookies"), "session-cookie");

      const dir = browserProfileDir(id, legacy);

      // moved OUT of the vault to the machine-local home, login preserved
      expect(dir).toBe(join(root, id, "profile"));
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(dir)).toBe(true);
      expect(readFileSync(join(dir, "Cookies"), "utf8")).toBe("session-cookie");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("migration is a no-op once the machine-local profile already exists", () => {
    const id = uniqueId("noop");
    const dir = browserProfileDir(id); // create machine-local first
    writeFileSync(join(dir, "keep"), "local");

    const vault = mkdtempSync(join(tmpdir(), "prevail-vault-"));
    try {
      const legacy = join(vault, "auth", "profile");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "Cookies"), "stale");

      const again = browserProfileDir(id, legacy);
      expect(again).toBe(dir);
      // legacy left untouched (we never delete what we didn't relocate)
      expect(existsSync(legacy)).toBe(true);
      // machine-local profile not clobbered by the legacy one
      expect(readFileSync(join(dir, "keep"), "utf8")).toBe("local");
      expect(existsSync(join(dir, "Cookies"))).toBe(false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
