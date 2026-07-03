import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
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

  test("JSON sentinel round-trips: local live lock is not stolen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "e.lock");
    const first = tryAcquireLock(path);
    expect(first).not.toBeNull();
    // A second local acquire must fail — our own live PID holds it.
    expect(tryAcquireLock(path)).toBeNull();
    first!.release();
  });

  test("fresh foreign-host sentinel is NOT stolen even with a live-looking PID", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "f.lock");
    // Plant a lock owned by a DIFFERENT machine. The PID is our own live pid, so
    // a naive kill(pid,0) check would say "alive" anyway — but the point is we
    // must never PID-probe a foreign host. It stays live within the stale window.
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, host: `${hostname()}-other`, ts: Date.now() }),
    );
    expect(tryAcquireLock(path)).toBeNull();
  });

  test("foreign-host sentinel with a dead-looking PID is still NOT stolen while fresh", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "g.lock");
    // A PID that is reliably dead on THIS machine. Because the host is foreign we
    // must not PID-probe it, so it must remain locked while fresh.
    writeFileSync(
      path,
      JSON.stringify({ pid: 2147483640, host: "some-remote-mac", ts: Date.now() }),
    );
    expect(tryAcquireLock(path)).toBeNull();
  });

  test("foreign-host sentinel IS reclaimed once its mtime is stale", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "h.lock");
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, host: "some-remote-mac", ts: Date.now() }),
    );
    // Age the lock past the 5-minute stale floor.
    const old = (Date.now() - 6 * 60 * 1000) / 1000;
    utimesSync(path, old, old);
    const handle = tryAcquireLock(path);
    expect(handle).not.toBeNull();
    handle!.release();
  });
});
