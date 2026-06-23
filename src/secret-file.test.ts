import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecretFile } from "./secret-file.ts";

describe("writeSecretFile — credential files are never world-readable (O12/O44)", () => {
  test("creates a new secret file with 0600 mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-secret-"));
    const f = join(dir, "token");
    writeSecretFile(f, "s3cr3t");
    expect(readFileSync(f, "utf8")).toBe("s3cr3t");
    if (process.platform !== "win32") {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
  });

  test("tightens an EXISTING world-readable file to 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-secret-"));
    const f = join(dir, "token");
    writeFileSync(f, "old", { mode: 0o644 }); // pre-existing, world-readable
    writeSecretFile(f, "new");
    expect(readFileSync(f, "utf8")).toBe("new");
    if (process.platform !== "win32") {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
  });
});
