import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearLock, isLockSet, readLock, setPasscode, verifyPasscode } from "./lock.ts";

function tmpLock(): string {
  return join(mkdtempSync(join(tmpdir(), "prevail-lock-")), "lock.json");
}

describe("app lock (Phase 0 passcode)", () => {
  it("starts unset", () => {
    const f = tmpLock();
    expect(isLockSet(f)).toBe(false);
    expect(readLock(f)).toBeNull();
  });

  it("sets a passcode and verifies the right one", async () => {
    const f = tmpLock();
    await setPasscode("correct horse", "2026-06-09T00:00:00Z", f);
    expect(isLockSet(f)).toBe(true);
    expect(await verifyPasscode("correct horse", f)).toBe(true);
    rmSync(f, { force: true });
  });

  it("rejects the wrong passcode", async () => {
    const f = tmpLock();
    await setPasscode("correct horse", "2026-06-09T00:00:00Z", f);
    expect(await verifyPasscode("wrong", f)).toBe(false);
    rmSync(f, { force: true });
  });

  it("stores only an Argon2id verifier, never the passcode", async () => {
    const f = tmpLock();
    await setPasscode("super secret pass", "2026-06-09T00:00:00Z", f);
    const lock = readLock(f)!;
    expect(lock.algorithm).toBe("argon2id");
    expect(lock.verifier.startsWith("$argon2id$")).toBe(true);
    expect(JSON.stringify(lock)).not.toContain("super secret pass");
    rmSync(f, { force: true });
  });

  it("rejects too-short passcodes", async () => {
    const f = tmpLock();
    await expect(setPasscode("ab", "2026-06-09T00:00:00Z", f)).rejects.toThrow(/at least/);
  });

  it("clears the lock", async () => {
    const f = tmpLock();
    await setPasscode("correct horse", "2026-06-09T00:00:00Z", f);
    clearLock(f);
    expect(isLockSet(f)).toBe(false);
    expect(await verifyPasscode("correct horse", f)).toBe(false);
  });
});
