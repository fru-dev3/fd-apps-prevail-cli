import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  rateFor,
  estimateTokens,
  costUsd,
  buildEntry,
  recordUsage,
  readUsage,
  aggregateUsage,
  parseSince,
  usageLedgerPath,
} from "../src/usage.ts";

describe("usage — pricing", () => {
  test("resolves per-model rates by substring, vendor fallback, free local", () => {
    expect(rateFor("claude", "claude-opus-4-8").outUsdPerMtok).toBe(75);
    expect(rateFor("claude", "claude-sonnet-4-6").outUsdPerMtok).toBe(15);
    expect(rateFor("codex", "gpt-5.5").inUsdPerMtok).toBe(1.25);
    expect(rateFor("ollama", "llama3.2")).toEqual({ inUsdPerMtok: 0, outUsdPerMtok: 0 });
    // unknown model on a known vendor → vendor default
    expect(rateFor("claude", "mystery-model").outUsdPerMtok).toBe(75);
  });

  test("estimateTokens ~ chars/4 and costUsd uses in/out split", () => {
    expect(estimateTokens("12345678")).toBe(2);
    // opus: 1M in @ $15, 1M out @ $75
    expect(costUsd("claude", "opus", 1_000_000, 0)).toBeCloseTo(15, 5);
    expect(costUsd("claude", "opus", 0, 1_000_000)).toBeCloseTo(75, 5);
    expect(costUsd("ollama", "llama3.2", 1_000_000, 1_000_000)).toBe(0);
  });

  test("buildEntry flags reported vs estimated and stamps the day", () => {
    const reported = buildEntry({ session: "s", cli: "claude", model: "opus", inputTokens: 100, outputTokens: 50 });
    expect(reported.token_source).toBe("reported");
    expect(reported.billed).toBe(false);
    expect(reported.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const estimated = buildEntry({ session: "s", cli: "claude", model: "opus", inputChars: 400 });
    expect(estimated.token_source).toBe("estimated");
    expect(estimated.input_tokens).toBe(100);
  });
});

describe("usage — ledger + aggregation", () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "prevail-usage-")); });
  afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); });

  test("record appends to _meta/usage.jsonl and read round-trips", () => {
    recordUsage(vault, { session: "a", domain: "wealth", surface: "chat", cli: "claude", model: "opus", inputTokens: 1000, outputTokens: 500 });
    recordUsage(vault, { session: "a", domain: "health", surface: "chat", cli: "codex", model: "gpt-5.5", inputTokens: 2000, outputTokens: 400 });
    expect(existsSync(usageLedgerPath(vault))).toBe(true);
    const entries = readUsage(vault);
    expect(entries.length).toBe(2);
    expect(entries[0]!.est_cost_usd).toBeGreaterThan(0);
  });

  test("aggregate by domain and by model buckets correctly", () => {
    recordUsage(vault, { session: "a", domain: "wealth", cli: "claude", model: "opus", inputTokens: 1000, outputTokens: 1000 });
    recordUsage(vault, { session: "a", domain: "wealth", cli: "claude", model: "opus", inputTokens: 1000, outputTokens: 1000 });
    recordUsage(vault, { session: "a", domain: "health", cli: "ollama", model: "llama3.2", inputTokens: 5000, outputTokens: 5000 });

    const byDomain = aggregateUsage(readUsage(vault), "domain");
    const wealth = byDomain.buckets.find((b) => b.key === "wealth")!;
    expect(wealth.calls).toBe(2);
    expect(byDomain.total.calls).toBe(3);
    // wealth (paid) should sort above health (free) by cost
    expect(byDomain.buckets[0]!.key).toBe("wealth");

    const byModel = aggregateUsage(readUsage(vault), "model");
    expect(byModel.buckets.find((b) => b.key === "claude:opus")!.calls).toBe(2);
    expect(byModel.buckets.find((b) => b.key === "ollama:llama3.2")!.est_cost_usd).toBe(0);
  });

  test("parseSince handles relative + filters reads", () => {
    const now = 1_000_000_000_000;
    expect(parseSince("7d", now)).toBe(now - 7 * 86400000);
    expect(parseSince("24h", now)).toBe(now - 24 * 3600000);
    expect(parseSince(undefined)).toBeNull();
  });
});
