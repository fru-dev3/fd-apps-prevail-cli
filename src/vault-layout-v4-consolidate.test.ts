// Vault-cleanliness regression cover. Two guarantees:
//   1. A runtime writer on a v4 domain lands in the v4 home (.system/log,
//      memory/...), NOT a stray legacy path at the domain ROOT.
//   2. The migrate-v4 consolidation (the "Rebuild structure" second pass) moves
//      any legacy leftover a non-v4-aware build left at the root into its v4 home,
//      non-destructively (dedup keeps the newer, _threads/ MERGES), and is
//      idempotent.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V4_MARKER, consolidateDomainV4Leftovers, v4DirPath } from "./vault-layout-v4.ts";
import { writeTurnSummary } from "./auto-summary.ts";

let vault = "";
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "prevail-v4-consol-")); });
afterEach(() => { try { rmSync(vault, { recursive: true, force: true }); } catch {} });

// Make `career` a v4-marked domain under data/domains and return its dir.
function v4Domain(name = "career"): string {
  const dir = join(vault, "data", "domains", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, V4_MARKER), "1");
  return dir;
}

// --- Part 1: writers are v4-aware ------------------------------------------

test("writer on a v4 domain writes to .system/log, not a root _log/", () => {
  const dir = v4Domain();
  writeTurnSummary({
    domainPath: dir, userPrompt: "what next?", assistantReply: "ship it",
    cliLabel: "Claude", ts: Date.UTC(2026, 6, 1, 12, 0, 0), kind: "chat",
  });
  // Landed in the v4 home.
  expect(existsSync(join(dir, ".system", "log"))).toBe(true);
  expect(readdirSync(join(dir, ".system", "log")).some((f) => f.endsWith(".md"))).toBe(true);
  // NOT at the legacy root.
  expect(existsSync(join(dir, "_log"))).toBe(false);
});

test("writer on a legacy (un-marked) domain keeps writing _log/ (no behavior change)", () => {
  const dir = join(vault, "data", "domains", "career");
  mkdirSync(dir, { recursive: true }); // no V4 marker
  writeTurnSummary({
    domainPath: dir, userPrompt: "x", assistantReply: "y",
    cliLabel: "Claude", ts: Date.UTC(2026, 6, 1, 12, 0, 0), kind: "chat",
  });
  expect(existsSync(join(dir, "_log"))).toBe(true);
  expect(existsSync(join(dir, ".system", "log"))).toBe(false);
});

test("writer PREFERS an existing legacy _log/ so it never splits history", () => {
  const dir = v4Domain();
  mkdirSync(join(dir, "_log"), { recursive: true }); // a leftover already at root
  expect(v4DirPath(dir, ".system/log", "_log")).toBe(join(dir, "_log"));
});

// --- Part 2: consolidation --------------------------------------------------

test("consolidation moves a root MEMORY.md into memory/memory.md (keeps the richer copy)", () => {
  const dir = v4Domain();
  // A short distilled memory already exists at the v4 home (smaller).
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "memory.md"), "old");
  const oldTime = new Date(Date.UTC(2026, 0, 1));
  utimesSync(join(dir, "memory", "memory.md"), oldTime, oldTime);
  // A stray root MEMORY.md a non-v4-aware writer re-created (larger).
  writeFileSync(join(dir, "MEMORY.md"), "NEWER durable facts, more content");

  const r = consolidateDomainV4Leftovers(vault, "career");

  expect(existsSync(join(dir, "MEMORY.md"))).toBe(false); // root cleaned
  // The larger (richer) wins at the canonical home.
  expect(readFileSync(join(dir, "memory", "memory.md"), "utf8")).toBe("NEWER durable facts, more content");
  // The smaller copy is parked, never lost.
  expect(existsSync(join(dir, "memory", "memory.pre-reorg.md"))).toBe(true);
  expect(readFileSync(join(dir, "memory", "memory.pre-reorg.md"), "utf8")).toBe("old");
  expect(r.conflicts.length).toBe(1);
});

test("a NEWER but EMPTY stray placeholder cannot demote the richer distilled memory", () => {
  const dir = v4Domain();
  mkdirSync(join(dir, "memory"), { recursive: true });
  // Real distilled content at the canonical home (older).
  writeFileSync(join(dir, "memory", "memory.md"), "real distilled durable facts, lots of content");
  const oldTime = new Date(Date.UTC(2026, 0, 1));
  utimesSync(join(dir, "memory", "memory.md"), oldTime, oldTime);
  // A stray root placeholder written just now (newer, but tiny).
  writeFileSync(join(dir, "MEMORY.md"), "# placeholder");

  consolidateDomainV4Leftovers(vault, "career");

  // The richer content stays canonical; the placeholder is parked, not promoted.
  expect(readFileSync(join(dir, "memory", "memory.md"), "utf8")).toBe("real distilled durable facts, lots of content");
  expect(readFileSync(join(dir, "memory", "memory.pre-reorg.md"), "utf8")).toBe("# placeholder");
  expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
});

test("consolidation drops a byte-identical root duplicate (pure dedup)", () => {
  const dir = v4Domain();
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "memory.md"), "same");
  writeFileSync(join(dir, "MEMORY.md"), "same");
  const r = consolidateDomainV4Leftovers(vault, "career");
  expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  expect(readFileSync(join(dir, "memory", "memory.md"), "utf8")).toBe("same");
  expect(existsSync(join(dir, "memory", "memory.pre-reorg.md"))).toBe(false);
  expect(r.deduped.length).toBe(1);
});

test("consolidation MERGES a root _threads/ into memory/threads/ without loss", () => {
  const dir = v4Domain();
  mkdirSync(join(dir, "memory", "threads"), { recursive: true });
  writeFileSync(join(dir, "memory", "threads", "canonical.jsonl"), "keep-me\n");
  writeFileSync(join(dir, "memory", "threads", "dup.jsonl"), "v4-side\n");
  mkdirSync(join(dir, "_threads"), { recursive: true });
  writeFileSync(join(dir, "_threads", "fresh.jsonl"), "new-thread\n");    // no collision -> moves
  writeFileSync(join(dir, "_threads", "dup.jsonl"), "root-side-diff\n");  // collision -> keep both

  const r = consolidateDomainV4Leftovers(vault, "career");

  expect(existsSync(join(dir, "_threads"))).toBe(false); // root _threads gone
  expect(readFileSync(join(dir, "memory", "threads", "canonical.jsonl"), "utf8")).toBe("keep-me\n");
  expect(readFileSync(join(dir, "memory", "threads", "fresh.jsonl"), "utf8")).toBe("new-thread\n");
  // The colliding thread files are BOTH kept (v4 one plus a parked copy).
  expect(existsSync(join(dir, "memory", "threads", "dup.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "memory", "threads", "dup.pre-reorg.jsonl"))).toBe(true);
  expect(r.merged.length).toBe(1);
});

test("consolidation routes the plumbing cursors to .system/ and is idempotent", () => {
  const dir = v4Domain();
  writeFileSync(join(dir, "_skillgen.json"), "{}");
  writeFileSync(join(dir, "_taskgen.json"), "{}");
  mkdirSync(join(dir, "_log"), { recursive: true });
  writeFileSync(join(dir, "_log", "2026-07-01.md"), "# log\n");

  const first = consolidateDomainV4Leftovers(vault, "career");
  expect(existsSync(join(dir, ".system", "skillgen.cursor.json"))).toBe(true);
  expect(existsSync(join(dir, ".system", "taskgen.cursor.json"))).toBe(true);
  expect(existsSync(join(dir, ".system", "log", "2026-07-01.md"))).toBe(true);
  // Nothing recognized left at the root.
  expect(existsSync(join(dir, "_skillgen.json"))).toBe(false);
  expect(existsSync(join(dir, "_taskgen.json"))).toBe(false);
  expect(existsSync(join(dir, "_log"))).toBe(false);
  expect(first.moved.length).toBeGreaterThanOrEqual(3);

  // Idempotent: a re-run on the now-clean domain is a no-op.
  const second = consolidateDomainV4Leftovers(vault, "career");
  expect(second.moved.length + second.deduped.length + second.conflicts.length + second.merged.length).toBe(0);
});

test("consolidation keeps manifest + unknowns at root and ADOPTS ideal.md to ideal-state.md", () => {
  const dir = v4Domain();
  writeFileSync(join(dir, "manifest.json"), "{}");
  writeFileSync(join(dir, "ideal.md"), "# ideal");
  writeFileSync(join(dir, "my-notes.txt"), "mine");
  const r = consolidateDomainV4Leftovers(vault, "career");
  expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  // The ideal self-heals to its ONE canonical name (the file the app reads).
  expect(existsSync(join(dir, "ideal-state.md"))).toBe(true);
  expect(existsSync(join(dir, "ideal.md"))).toBe(false);
  expect(existsSync(join(dir, "my-notes.txt"))).toBe(true);
  expect(r.moved.length).toBe(1);
});

test("consolidation is a no-op on a non-v4 domain", () => {
  const dir = join(vault, "data", "domains", "career");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), "facts"); // legacy layout, no marker
  const r = consolidateDomainV4Leftovers(vault, "career");
  expect(existsSync(join(dir, "MEMORY.md"))).toBe(true); // untouched
  expect(r.moved.length).toBe(0);
});

// Canonical ideal + the in-vault agent contract (vault-as-the-product law).
import { v4Destination, vaultAgentContract, writeVaultAgentContract } from "./vault-layout-v4.ts";
import { mkdtempSync as _mkdtemp2, readFileSync as _read2, writeFileSync as _write2, rmSync as _rm2 } from "node:fs";
import { join as _join2 } from "node:path";
import { tmpdir as _tmp2 } from "node:os";

test("v4Destination: every ideal alias adopts to ideal-state.md; canonical stays put", () => {
  for (const alias of ["ideal.md", "soul.md", "IDEAL.md", "ideal_state.md", "idealstate.md", "ideal state.md"]) {
    expect(v4Destination(alias)).toBe("ideal-state.md");
  }
  expect(v4Destination("ideal-state.md")).toBeNull(); // root marker, never moved
  expect(v4Destination("manifest.json")).toBeNull();
});

test("vault map: canonical VAULT.md + harness shims, idempotent, user content survives", () => {
  const v = _mkdtemp2(_join2(_tmp2(), "prevail-contract-"));
  try {
    const r1 = writeVaultAgentContract(v);
    expect(r1.ok).toBe(true);
    expect(r1.updated).toBe(true);
    // The canonical, harness-neutral map holds the full contract.
    const map = _read2(_join2(v, "VAULT.md"), "utf8");
    expect(map).toContain("ideal-state.md");
    expect(map).toContain("NEVER touch");
    expect(map).toContain("_loops.json schema");
    expect(map).toContain("Integrating from OUTSIDE the app");
    // Every harness shim exists and points at VAULT.md, never duplicating it.
    for (const shim of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      const body = _read2(_join2(v, shim), "utf8");
      expect(body).toContain("VAULT.md");
      expect(body.length).toBeLessThan(600);
    }
    // Idempotent second write.
    expect(writeVaultAgentContract(v).updated).toBe(false);
    // User content outside the managed block survives a refresh.
    _write2(_join2(v, "VAULT.md"), `My own notes up top.\n\n${vaultAgentContract()}`);
    const r3 = writeVaultAgentContract(v);
    expect(r3.ok).toBe(true);
    const after = _read2(_join2(v, "VAULT.md"), "utf8");
    expect(after).toContain("My own notes up top.");
    expect(after).toContain("ideal-state.md");
  } finally {
    _rm2(v, { recursive: true, force: true });
  }
});
