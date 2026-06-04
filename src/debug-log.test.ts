import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLogPath, logDebug, readDebugTail } from "./debug-log.ts";

// Isolate every test in its own tmp PREVAIL_DATA_DIR so we never touch
// the real ~/.prevail/debug.log on the dev machine.
let prevDir: string | undefined;
let tmp: string;

beforeEach(() => {
  prevDir = process.env.PREVAIL_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), "prevail-debug-"));
  process.env.PREVAIL_DATA_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.PREVAIL_DATA_DIR;
  else process.env.PREVAIL_DATA_DIR = prevDir;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("logDebug", () => {
  test("creates the debug log file with 0600 mode on first write", () => {
    const file = debugLogPath();
    expect(existsSync(file)).toBe(false);
    logDebug("test.cat", "hello");
    expect(existsSync(file)).toBe(true);
    const mode = statSync(file).mode & 0o777;
    // chmod is best-effort on exotic filesystems; tmpdir on macOS/Linux
    // should honor it. Assert 0o600 — if this ever fails on CI we'll
    // know the filesystem doesn't support chmod and can relax it.
    expect(mode).toBe(0o600);
  });

  test("multiple calls append, never overwrite", () => {
    logDebug("a", "first");
    logDebug("b", "second", { k: 1 });
    logDebug("c", "third");
    const lines = readDebugTail(50);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]!.cat).toBe("a");
    expect(parsed[0]!.msg).toBe("first");
    expect(parsed[1]!.cat).toBe("b");
    expect(parsed[1]!.meta).toEqual({ k: 1 });
    expect(parsed[2]!.cat).toBe("c");
    // Every entry must carry a ts.
    for (const p of parsed) expect(typeof p.ts).toBe("string");
  });

  test("rotates when the file crosses 5MB", () => {
    const file = debugLogPath();
    // Seed a >5MB file directly so the very next logDebug() trips the
    // size check and rotates. We need the parent dir to exist first —
    // logDebug normally creates it, but we're writing manually.
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(tmp, { recursive: true });
    const big = "x".repeat(5 * 1024 * 1024 + 100);
    writeFileSync(file, big);
    expect(statSync(file).size).toBeGreaterThan(5 * 1024 * 1024);

    logDebug("rotate", "trigger");

    // After rotation: debug.log.1 holds the old bloated content, and
    // debug.log is a small file holding the single new entry.
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(`${file}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeLessThan(1024);
    const fresh = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(fresh) as Record<string, unknown>;
    expect(parsed.cat).toBe("rotate");
    expect(parsed.msg).toBe("trigger");
  });
});

describe("readDebugTail", () => {
  test("returns empty when no log exists", () => {
    expect(readDebugTail(10)).toEqual([]);
  });

  test("returns the last n entries in chronological order", () => {
    for (let i = 0; i < 10; i++) logDebug("seq", `m${i}`);
    const tail = readDebugTail(3);
    expect(tail).toHaveLength(3);
    const msgs = tail.map((l) => (JSON.parse(l) as { msg: string }).msg);
    // Oldest of the kept slice first, newest last.
    expect(msgs).toEqual(["m7", "m8", "m9"]);
  });

  test("returns all entries when n exceeds count", () => {
    logDebug("x", "1");
    logDebug("x", "2");
    const tail = readDebugTail(50);
    expect(tail).toHaveLength(2);
  });
});
