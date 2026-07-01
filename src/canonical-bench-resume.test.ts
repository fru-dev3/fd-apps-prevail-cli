import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPriorRun,
  resolveRunDir,
  runCanonicalSet,
  runsDir,
  writeRunResults,
  type CanonicalRunRecord,
  type CanonicalQuestion,
} from "./canonical-bench.ts";

// Bulletproof-resume contract for the Arena benchmark. These lock in the
// crash-safe / idempotent / resumable behavior for the RUN side without
// spawning any model: they exercise the pure data layer (resolveRunDir,
// writeRunResults, loadPriorRun) and the skip path of runCanonicalSet.

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-bench-resume-"));
});
afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }); } catch { /* ignore */ }
});

function rec(id: string, ok: boolean): CanonicalRunRecord {
  return {
    id,
    domain: "wealth",
    prompt: `prompt ${id}`,
    reply: ok ? `answer ${id}` : "",
    ms: 100,
    council: false,
    cli: "claude",
    model: "opus",
    ok,
    ...(ok ? {} : { error: "boom" }),
  };
}

describe("bench resume data layer", () => {
  test("writeRunResults + loadPriorRun round-trips and only ok ids count as done", () => {
    const { dir, label, ts } = resolveRunDir({
      vaultPath: vault,
      targetCli: { kind: "claude", label: "Claude", bin: "claude" } as any,
      targetModel: "opus",
      batchId: "b1",
    });
    const records = [rec("q1", true), rec("q2", false), rec("q3", true)];
    writeRunResults(dir, label, ts, records);

    const prior = loadPriorRun(dir);
    expect(prior).not.toBeNull();
    expect(prior!.records.length).toBe(3);
    // Only the two OK answers are "done" - the errored one must retry.
    expect([...prior!.okIds].sort()).toEqual(["q1", "q3"]);

    // results.json is the real persisted artifact scoring reads.
    const onDisk: CanonicalRunRecord[] = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
    expect(onDisk.map((r) => r.id)).toEqual(["q1", "q2", "q3"]);
  });

  test("resolveRunDir reuses resumeDir instead of minting a fresh one", () => {
    const first = resolveRunDir({
      vaultPath: vault,
      targetCli: { kind: "claude", label: "Claude", bin: "claude" } as any,
      targetModel: "opus",
      batchId: "b1",
    });
    writeRunResults(first.dir, first.label, first.ts, [rec("q1", true)]);

    const resumed = resolveRunDir({
      vaultPath: vault,
      targetCli: { kind: "claude", label: "Claude", bin: "claude" } as any,
      targetModel: "opus",
      batchId: "b1",
      resumeDir: first.dir,
    });
    // Same directory - the resume writes back into it, no new run created.
    expect(resumed.dir).toBe(first.dir);
  });

  test("meta.json and batch.json are written up front by resolveRunDir", () => {
    const { dir } = resolveRunDir({
      vaultPath: vault,
      targetCli: { kind: "codex", label: "Codex", bin: "codex" } as any,
      targetModel: "gpt",
      batchId: "b42",
      batchLabel: "my batch",
    });
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "batch.json"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.cli).toBe("codex");
    expect(meta.model).toBe("gpt");
    const batch = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8"));
    expect(batch.id).toBe("b42");
  });

  test("runCanonicalSet skips already-answered ids, never re-running them, and flushes each record", async () => {
    const questions: CanonicalQuestion[] = [
      { id: "q1", domain: "wealth", prompt: "p1", filePath: "q1.md" },
      { id: "q2", domain: "wealth", prompt: "p2", filePath: "q2.md" },
    ];
    // q1 already answered on a prior interrupted run.
    const prior = [rec("q1", true)];
    const flushes: number[] = [];
    let ran = 0;

    const records = await runCanonicalSet({
      vaultPath: vault,
      questions,
      clis: [],
      // No targetCli + non-council question => targetCli path with clis[0]
      // undefined would throw "no CLI available" for q2, which we WANT: it
      // proves q2 executed (and errored) while q1 was skipped, never run.
      skipIds: new Set(["q1"]),
      priorRecords: prior,
      perQuestionTimeoutMs: 0,
      onRecord: (recs) => { flushes.push(recs.length); },
      onProgress: (_id, status) => { if (status === "start") ran++; },
    });

    // q1 skipped (never "start"ed); q2 attempted once.
    expect(ran).toBe(1);
    // Output carries BOTH: the carried-over q1 and the freshly-attempted q2.
    expect(records.map((r) => r.id).sort()).toEqual(["q1", "q2"]);
    // q1's original OK record is preserved untouched.
    const q1 = records.find((r) => r.id === "q1")!;
    expect(q1.ok).toBe(true);
    expect(q1.reply).toBe("answer q1");
    // A flush happened for the executed question (crash-safety).
    expect(flushes.length).toBeGreaterThanOrEqual(1);
    // The flushed set is the FULL set (prior + new), so results.json stays complete.
    expect(flushes[flushes.length - 1]).toBe(2);
  });
});
