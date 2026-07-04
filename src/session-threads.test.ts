// Thread persistence must resolve to ONE location per domain across the v4
// split, matching the desktop. Regression cover for the disappearance bug where
// a v4 domain wrote threads to _threads/ but listed/read from memory/threads/
// (or vice versa), orphaning them.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V4_MARKER } from "./vault-layout-v4.ts";
import {
  importDesktopThreads,
  readThreadTurns,
  threadJsonlPath,
  writeThreadTurn,
} from "./session.ts";

let vault = "";
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-cli-threads-"));
});
afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }); } catch {}
});

// Make `health` a v4-marked domain under data/domains and return its dir.
function v4Domain(): string {
  const dir = join(vault, "data", "domains", "health");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, V4_MARKER), "1");
  return dir;
}

test("v4 domain: new thread writes to memory/threads and round-trips", () => {
  v4Domain();
  writeThreadTurn(vault, "health", "sess1", {
    id: "t-1", parentId: null, role: "user", cli: "claude", model: "m", content: "hi", ts: 1,
  });
  const p = threadJsonlPath(vault, "health", "sess1");
  expect(p.includes(join("memory", "threads"))).toBe(true);
  expect(existsSync(p)).toBe(true);
  const turns = readThreadTurns(vault, "health", "sess1");
  expect(turns.length).toBe(1);
  expect(turns[0].content).toBe("hi");
});

test("v4 domain: appends CONTINUE an existing legacy _threads/ session, not split it", () => {
  const dir = v4Domain();
  // Pre-existing session file in the LEGACY dir (older engine build).
  const legacy = join(dir, "_threads");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "old.jsonl"), JSON.stringify({ id: "t-0", parentId: null, role: "user", cli: "", model: "", content: "first", ts: 0 }) + "\n");
  // A new append for the same session must land in the SAME (legacy) file.
  writeThreadTurn(vault, "health", "old", {
    id: "t-1", parentId: "t-0", role: "assistant", cli: "claude", model: "m", content: "second", ts: 1,
  });
  expect(threadJsonlPath(vault, "health", "old")).toBe(join(legacy, "old.jsonl"));
  const turns = readThreadTurns(vault, "health", "old");
  expect(turns.map((t) => t.content)).toEqual(["first", "second"]);
});

test("v4 domain: desktop .md thread in legacy _threads/ is still imported (not orphaned)", () => {
  const dir = v4Domain();
  const legacy = join(dir, "_threads");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(
    join(legacy, "legacy-chat.md"),
    "## You\n\nold question\n\n## Assistant\n\nold answer\n",
  );
  const res = importDesktopThreads(vault, "health");
  expect(res.imported).toContain("legacy-chat");
  const turns = readThreadTurns(vault, "health", "legacy-chat");
  expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(turns[0].content).toBe("old question");
});

// Regression: a macOS AppleDouble "._<slug>.md" sidecar (created on a network/
// exFAT vault) must NOT crash the import. Its slug "._<slug>" fails
// threadJsonlPath's id validation; because importDesktopThreads runs before
// every engine chat turn and its caller does NOT wrap it in try/catch, a throw
// here aborted the whole conversation ("invalid session id" follow-up bug). The
// sidecar must be skipped and the real thread imported.
test("v4 domain: AppleDouble ._<slug>.md sidecar is skipped, real thread still imported", () => {
  const dir = v4Domain();
  const tdir = join(dir, "memory", "threads");
  mkdirSync(tdir, { recursive: true });
  const slug = "2026-07-04_13-28-27_811c9dc5";
  writeFileSync(join(tdir, `${slug}.md`), "## You\n\nhello\n\n## Assistant\n\nhi\n");
  // The sidecar macOS drops next to it - ends in .md but has a "._" slug.
  writeFileSync(join(tdir, `._${slug}.md`), "\x00\x05\x16\x07AppleDouble");
  // Must NOT throw (the bug threw "invalid session id: ._2026-...").
  const res = importDesktopThreads(vault, "health");
  expect(res.imported).toContain(slug);
  // No "._" slug ever leaks into imported OR skipped.
  expect([...res.imported, ...res.skipped].some((s) => s.startsWith("."))).toBe(false);
  const turns = readThreadTurns(vault, "health", slug);
  expect(turns[0].content).toBe("hello");
});
