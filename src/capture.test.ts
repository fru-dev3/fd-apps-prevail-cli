import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  captureWritePath,
  hostSlug,
  ingest,
  ingestBatch,
  legacyStreamPath,
  listStreamFiles,
  statusReport,
} from "./capture.ts";

// Multi-machine capture: each machine appends to its OWN per-host stream
// (prompts/<tool>.<host>.jsonl), so two machines sharing a file-synced vault
// never write the same path and never produce a merge conflict. Readers merge
// every <tool>*.jsonl (legacy + per-host) by ts. These tests pin that contract.
//
// Vaults live under $HOME (not tmpdir) because validateVaultPath forbids /var,
// which is where macOS os.tmpdir() resolves.

const TEST_ROOT = join(homedir(), ".prevail-test-tmp");

function makeVault(): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  const vault = mkdtempSync(join(TEST_ROOT, "capwrite-"));
  // build/_meta so runtimePath resolves prompts under build/_meta (v4 home).
  mkdirSync(join(vault, "build", "_meta"), { recursive: true });
  return vault;
}

/** Seed a legacy (pre-multi-machine) shared stream file, creating prompts/. */
function seedLegacy(vault: string, slug: string, records: object[]): void {
  const p = legacyStreamPath(vault, slug);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const SAVED = process.env.PREVAIL_HOST_SLUG;
function asHost(h: string): void {
  process.env.PREVAIL_HOST_SLUG = h;
}
afterEach(() => {
  if (SAVED === undefined) delete process.env.PREVAIL_HOST_SLUG;
  else process.env.PREVAIL_HOST_SLUG = SAVED;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("per-host capture streams", () => {
  test("two hosts write two different files - never one shared path", () => {
    const vault = makeVault();
    asHost("mini");
    const r1 = ingest({ vault, tool: "claude", prompt: "from mini", session: "s1" });
    asHost("macbook");
    const r2 = ingest({ vault, tool: "claude", prompt: "from macbook", session: "s2" });

    expect(r1.written).toBe(true);
    expect(r2.written).toBe(true);
    expect(basename(r1.path)).toBe("claude.mini.jsonl");
    expect(basename(r2.path)).toBe("claude.macbook.jsonl");
    expect(r1.path).not.toBe(r2.path);

    // Both files exist; neither is the legacy shared file.
    const files = listStreamFiles(vault, "claude").map((f) => basename(f)).sort();
    expect(files).toEqual(["claude.macbook.jsonl", "claude.mini.jsonl"]);
  });

  test("the host field always matches the filename's <host> segment", () => {
    const vault = makeVault();
    asHost("mini");
    ingest({ vault, tool: "claude", prompt: "x", session: "s" });
    const rec = JSON.parse(readFileSync(captureWritePath(vault, "claude"), "utf8").trim());
    expect(rec.host).toBe("mini");
    expect(captureWritePath(vault, "claude").endsWith(`claude.${rec.host}.jsonl`)).toBe(true);
  });

  test("writers never append to the legacy file; readers still see it", () => {
    const vault = makeVault();
    seedLegacy(vault, "claude", [{ tool: "claude", session: "old", prompt: "history", host: "" }]);
    asHost("mini");
    const r = ingest({ vault, tool: "claude", prompt: "new", session: "s1" });

    // Live prompt landed in the per-host file, NOT the legacy one.
    expect(basename(r.path)).toBe("claude.mini.jsonl");
    expect(readFileSync(legacyStreamPath(vault, "claude"), "utf8").trim().split("\n").length).toBe(1);

    // A reader (listStreamFiles) surfaces both the legacy history and the per-host file.
    const files = listStreamFiles(vault, "claude").map((f) => basename(f)).sort();
    expect(files).toEqual(["claude.jsonl", "claude.mini.jsonl"]);
  });

  test("sync dedups against the legacy file - a re-scanned prompt is not re-appended", () => {
    const vault = makeVault();
    seedLegacy(vault, "claude", [{ tool: "claude", session: "s1", prompt: "dup", host: "" }]);
    asHost("mini");
    const res = ingestBatch(vault, "claude", [
      { prompt: "dup", session: "s1" }, // already in legacy → skipped
      { prompt: "fresh", session: "s2" }, // new → written
    ]);
    expect(res.written).toBe(1);
    expect(res.skipped).toBe(1);
    const perHost = readFileSync(captureWritePath(vault, "claude"), "utf8").trim().split("\n");
    expect(perHost.length).toBe(1);
    expect(JSON.parse(perHost[0]).prompt).toBe("fresh");
  });

  test("status sums counts across legacy + every per-host file", () => {
    const vault = makeVault();
    seedLegacy(vault, "claude", [
      { session: "a", prompt: "1" },
      { session: "b", prompt: "2" },
    ]);
    asHost("mini");
    ingest({ vault, tool: "claude", prompt: "3", session: "c" });
    asHost("macbook");
    ingest({ vault, tool: "claude", prompt: "4", session: "d" });

    const claude = statusReport(vault).streams.find((s) => s.tool === "claude");
    expect(claude?.count).toBe(4); // 2 legacy + mini + macbook
  });

  test("fresh vault with no legacy file works on per-host files only", () => {
    const vault = makeVault();
    asHost("mini");
    const r = ingest({ vault, tool: "claude", prompt: "only", session: "s" });
    expect(r.written).toBe(true);
    expect(listStreamFiles(vault, "claude").map((f) => basename(f))).toEqual(["claude.mini.jsonl"]);
    expect(statusReport(vault).streams.find((s) => s.tool === "claude")?.count).toBe(1);
  });

  test("stream matcher never captures a different tool that shares a prefix", () => {
    const vault = makeVault();
    seedLegacy(vault, "opencode", [{ session: "a", prompt: "x" }]);
    seedLegacy(vault, "openclaw", [{ session: "b", prompt: "y" }]);
    asHost("mini");
    ingest({ vault, tool: "opencode", prompt: "z", session: "s" });

    const oc = listStreamFiles(vault, "opencode").map((f) => basename(f)).sort();
    expect(oc).toEqual(["opencode.jsonl", "opencode.mini.jsonl"]);
    expect(oc).not.toContain("openclaw.jsonl");
  });

  test("empty/odd hostname disambiguates with a stable machine id, not a shared 'host'", () => {
    asHost("!!!"); // sanitizes to empty
    expect(hostSlug()).toMatch(/^host-[0-9a-f]{6}$/);
  });
});
