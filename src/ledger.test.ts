import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLedger, readLedgerTail, readLedgerAll, archiveShardPath, archiveShards } from "./ledger.ts";

// Durable bounded ledger: locked appends, size-triggered monthly archiving,
// bounded tail reads, full-history merge. (No encryption in these tests -
// vappendLine is a plain append when the session isn't encrypted.)
const NOW = Date.UTC(2026, 6, 15); // 2026-07

describe("appendLedger + archiving", () => {
  test("appends lines, keeps the live file bounded, archives the prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-ledger-"));
    const path = join(dir, "usage.jsonl");
    // Write enough to cross the 512KB soft cap (each line ~1KB).
    const line = JSON.stringify({ ts: 1, pad: "x".repeat(1000) });
    for (let i = 0; i < 700; i++) appendLedger(path, line, NOW);
    const liveSize = readFileSync(path, "utf8").length;
    expect(liveSize).toBeLessThan(512 * 1024 + 2048); // stayed bounded
    // An archive shard for the month exists and holds the rolled prefix.
    const shard = archiveShardPath(path, "2026-07");
    expect(existsSync(shard)).toBe(true);
    expect(archiveShards(path)).toContain(shard);
  });

  test("readLedgerTail returns only the newest N, from the live file", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-ledger-"));
    const path = join(dir, "audit.jsonl");
    for (let i = 0; i < 50; i++) appendLedger(path, JSON.stringify({ n: i }), NOW);
    const tail = readLedgerTail<{ n: number }>(path, 5);
    expect(tail.map((r) => r.n)).toEqual([45, 46, 47, 48, 49]);
  });

  test("readLedgerAll merges every archive shard then the live tail, in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-ledger-"));
    const path = join(dir, "decisions.jsonl");
    const big = JSON.stringify({ ts: 1, pad: "y".repeat(1000) });
    for (let i = 0; i < 700; i++) appendLedger(path, JSON.stringify({ n: i, pad: big }), NOW);
    const all = readLedgerAll<{ n: number }>(path);
    // Every record survived the rotation (archive + live), in append order.
    expect(all.length).toBe(700);
    expect(all[0].n).toBe(0);
    expect(all[699].n).toBe(699);
  });

  test("bad lines are skipped, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-ledger-"));
    const path = join(dir, "x.jsonl");
    writeFileSync(path, '{"ok":1}\n{ broken\n{"ok":2}\n');
    expect(readLedgerTail<{ ok: number }>(path, 10).map((r) => r.ok)).toEqual([1, 2]);
  });
});
