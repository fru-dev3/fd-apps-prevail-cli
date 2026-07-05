import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  checkpointPath,
  hostSlug,
  readCheckpoint,
  writeCheckpoint,
  type CaptureCheckpoint,
} from "./capture-sync.ts";

// The checkpoint lives in the SHARED vault but must be per-machine, else two
// Macs with the same username overwrite each other's mtime high-water marks and
// silently MISS prompts. These tests exercise the hostname namespacing + the
// one-time migration from the legacy non-namespaced file.

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "capvault-"));
  // Create build/ so runtimePath resolves _meta under build/ (the canonical home).
  mkdirSync(join(vault, "build", "_meta"), { recursive: true });
  return vault;
}

const SAVED = process.env.PREVAIL_HOST_SLUG;
afterEach(() => {
  if (SAVED === undefined) delete process.env.PREVAIL_HOST_SLUG;
  else process.env.PREVAIL_HOST_SLUG = SAVED;
});

describe("capture-sync checkpoint namespacing", () => {
  test("hostSlug sanitizes to [a-z0-9-]", () => {
    process.env.PREVAIL_HOST_SLUG = "Frus-MacBook.Pro (2)";
    expect(hostSlug()).toMatch(/^[a-z0-9-]+$/);
    expect(hostSlug()).toBe("frus-macbook-pro-2");
  });

  test("checkpoint path is namespaced by host slug", () => {
    process.env.PREVAIL_HOST_SLUG = "mini";
    const vault = makeVault();
    expect(basename(checkpointPath(vault))).toBe("capture_sync_checkpoint.mini.json");
  });

  test("migration seeds the per-host file from a legacy checkpoint, leaving legacy in place", () => {
    process.env.PREVAIL_HOST_SLUG = "mini";
    const vault = makeVault();
    const legacy = join(vault, "build", "_meta", "capture_sync_checkpoint.json");
    const legacyCp: CaptureCheckpoint = {
      version: 1,
      files: { "/Users/alice/.claude/projects/x/s.jsonl": 12345 },
      prevailLastTs: 999,
      opencodeLastTs: 42,
    };
    writeFileSync(legacy, `${JSON.stringify(legacyCp, null, 2)}\n`, "utf8");

    // First read on this host migrates.
    const cp = readCheckpoint(vault);
    expect(cp.prevailLastTs).toBe(999);
    expect(cp.opencodeLastTs).toBe(42);
    expect(cp.files["/Users/alice/.claude/projects/x/s.jsonl"]).toBe(12345);

    // Per-host file now exists, seeded from legacy; legacy is left untouched.
    const hostFile = checkpointPath(vault);
    expect(existsSync(hostFile)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    const seeded = JSON.parse(readFileSync(hostFile, "utf8")) as CaptureCheckpoint;
    expect(seeded.prevailLastTs).toBe(999);
  });

  test("two hosts keep separate files and neither clobbers the other", () => {
    const vault = makeVault();

    // Host A (the mini/hub) records its high-water marks.
    process.env.PREVAIL_HOST_SLUG = "mini";
    writeCheckpoint(vault, {
      version: 1,
      files: { "/Users/alice/.claude/projects/a.jsonl": 100 },
      prevailLastTs: 100,
      opencodeLastTs: 0,
    });
    const fileA = checkpointPath(vault);

    // Host B (the laptop/client) records DIFFERENT marks for the same paths.
    process.env.PREVAIL_HOST_SLUG = "laptop";
    writeCheckpoint(vault, {
      version: 1,
      files: { "/Users/alice/.claude/projects/a.jsonl": 500 },
      prevailLastTs: 500,
      opencodeLastTs: 0,
    });
    const fileB = checkpointPath(vault);

    expect(fileA).not.toBe(fileB);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);

    // Host A's marks are intact (not clobbered by host B).
    process.env.PREVAIL_HOST_SLUG = "mini";
    expect(readCheckpoint(vault).prevailLastTs).toBe(100);
    // Host B's marks are its own.
    process.env.PREVAIL_HOST_SLUG = "laptop";
    expect(readCheckpoint(vault).prevailLastTs).toBe(500);
  });
});
