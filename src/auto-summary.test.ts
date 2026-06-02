import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristicSummarize, writeTurnSummary, readTodayLog } from "./auto-summary.ts";

describe("heuristicSummarize", () => {
  test("short text passes through unchanged", () => {
    expect(heuristicSummarize("hi there", 100)).toBe("hi there");
  });

  test("strips markdown headers + bullets", () => {
    const r = heuristicSummarize("## Big heading\n- one\n- two", 200);
    expect(r).not.toContain("##");
    expect(r).not.toContain("- ");
  });

  test("prefers full sentences when over cap", () => {
    const long =
      "First sentence is short. Second sentence has more text in it. " +
      "Third sentence keeps going on and on and on with extra words to ensure it would push past the cap.";
    const r = heuristicSummarize(long, 80);
    expect(r.length).toBeLessThanOrEqual(80);
    expect(r).toContain("First sentence");
  });

  test("hard-cuts when no sentence fits the cap", () => {
    const r = heuristicSummarize("a".repeat(500), 50);
    expect(r.length).toBeLessThanOrEqual(51); // 50 + ellipsis
    expect(r.endsWith("…")).toBe(true);
  });
});

describe("writeTurnSummary + readTodayLog", () => {
  test("creates _log dir + appends today's file", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-summary-"));
    writeTurnSummary({
      domainPath: dir,
      userPrompt: "should I file the August 1041?",
      assistantReply: "Yes — file by the August 15 deadline.",
      cliLabel: "Claude",
      ts: Date.now(),
      kind: "chat",
    });
    const log = readTodayLog(dir);
    expect(log).not.toBeNull();
    expect(log).toContain("Claude");
    expect(log).toContain("August 1041");
    expect(log).toContain("August 15");
  });

  test("multiple writes append to the same daily file", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-summary-"));
    const ts = Date.now();
    writeTurnSummary({ domainPath: dir, userPrompt: "Q1", assistantReply: "A1", cliLabel: "Claude", ts, kind: "chat" });
    writeTurnSummary({ domainPath: dir, userPrompt: "Q2", assistantReply: "A2", cliLabel: "Codex", ts: ts + 1000, kind: "chat" });
    const log = readTodayLog(dir, ts);
    expect(log).toContain("Q1");
    expect(log).toContain("Q2");
    expect(log).toContain("Claude");
    expect(log).toContain("Codex");
  });

  test("council verdict gets the ⚖ tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "prevail-summary-"));
    writeTurnSummary({
      domainPath: dir,
      userPrompt: "best move?",
      assistantReply: "VERDICT: do X",
      cliLabel: "Council ⚖ Claude",
      ts: Date.now(),
      kind: "council-verdict",
    });
    const log = readTodayLog(dir);
    expect(log).toContain("⚖");
  });

  test("does not throw when domain path is invalid (silent failure mode)", () => {
    expect(() =>
      writeTurnSummary({
        domainPath: "/dev/null/cant-mkdir-here",
        userPrompt: "x",
        assistantReply: "y",
        cliLabel: "Claude",
        ts: Date.now(),
        kind: "chat",
      }),
    ).not.toThrow();
  });
});
