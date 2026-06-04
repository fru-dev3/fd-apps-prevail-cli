import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireLock } from "./file-lock.ts";

describe("tryAcquireLock", () => {
  test("first acquirer wins; second is rejected", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "a.lock");
    const first = tryAcquireLock(path);
    expect(first).not.toBeNull();
    const second = tryAcquireLock(path);
    expect(second).toBeNull();
    first!.release();
    expect(existsSync(path)).toBe(false);
    // After release, a new caller succeeds.
    const third = tryAcquireLock(path);
    expect(third).not.toBeNull();
    third!.release();
  });

  test("release is idempotent", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "b.lock");
    const handle = tryAcquireLock(path);
    expect(handle).not.toBeNull();
    handle!.release();
    expect(() => handle!.release()).not.toThrow();
  });

  test("stale lock from a dead PID is recovered", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "c.lock");
    // Plant a lock owned by a PID guaranteed to be dead — kernel PIDs
    // recycle, but the platform-wide max is well under 2^31 so a number
    // that big is reliably nonexistent.
    writeFileSync(path, "2147483640");
    // Force its mtime back so the staleness floor doesn't trigger first.
    // (We still expect the dead-PID check to recover it.)
    const handle = tryAcquireLock(path);
    expect(handle).not.toBeNull();
    handle!.release();
  });

  test("malformed lock file (non-numeric PID) is treated as stale", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "d.lock");
    writeFileSync(path, "not-a-pid");
    const handle = tryAcquireLock(path);
    expect(handle).not.toBeNull();
    handle!.release();
  });
});
