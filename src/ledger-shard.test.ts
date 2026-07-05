import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostToken, shardPathFor, shardPaths, readAllShards } from "./ledger-shard.ts";

// Per-host sharding: each machine appends to its own file; readers merge all.
describe("ledger sharding (G4)", () => {
  test("hostToken is filesystem-safe and stable", () => {
    expect(hostToken("Frus-MacBook-Pro.local")).toBe("frus-macbook-pro-local");
    expect(hostToken("")).toBe("unknown");
  });

  test("shardPathFor inserts the host before the extension", () => {
    const p = shardPathFor("/v/_log/action-audit.jsonl", "mini");
    expect(p).toBe("/v/_log/action-audit.mini.jsonl");
  });

  test("shardPaths finds every host shard plus a legacy single file, merged in order", () => {
    const dir = mkdtempSync(`${tmpdir()}/prevail-shard-`);
    const logical = join(dir, "action-audit.jsonl");
    writeFileSync(logical, '{"ts":0,"src":"legacy"}\n');                 // pre-sharding file
    writeFileSync(join(dir, "action-audit.mini.jsonl"), '{"ts":2,"src":"mini"}\n');
    writeFileSync(join(dir, "action-audit.mbp.jsonl"), '{"ts":1,"src":"mbp"}\n');
    // An unrelated file in the same dir must NOT be picked up.
    writeFileSync(join(dir, "usage.mini.jsonl"), '{"ts":9}\n');
    const paths = shardPaths(logical);
    expect(paths.length).toBe(3);
    expect(paths.some((p) => p.endsWith("usage.mini.jsonl"))).toBe(false);
    const merged = readAllShards(logical).trim().split("\n").map((l) => JSON.parse(l).src);
    expect(merged.sort()).toEqual(["legacy", "mbp", "mini"]);
  });
});
