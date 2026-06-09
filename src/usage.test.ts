import { describe, expect, it } from "bun:test";
import {
  aggregateUsage,
  buildEntry,
  costUsd,
  dayKey,
  filterByDomain,
  parseSince,
  rateFor,
  type UsageEntry,
} from "./usage.ts";

describe("pricing", () => {
  it("matches model substrings, most specific first", () => {
    expect(rateFor("claude", "claude-opus-4-8").inUsdPerMtok).toBe(15);
    expect(rateFor("claude", "claude-haiku-4-5").inUsdPerMtok).toBe(1);
    expect(rateFor("codex", "gpt-5").inUsdPerMtok).toBe(1.25);
  });
  it("local engines are free", () => {
    expect(costUsd("ollama", "llama3.1", 1_000_000, 1_000_000)).toBe(0);
  });
  it("costs input/output at their separate rates", () => {
    // opus: 15 in / 75 out per Mtok → 1M in + 1M out = 90
    expect(costUsd("claude", "opus", 1_000_000, 1_000_000)).toBe(90);
  });
});

function entry(over: Partial<UsageEntry>): UsageEntry {
  return buildEntry({
    session: "s1",
    cli: "claude",
    model: "opus",
    inputTokens: 100,
    outputTokens: 100,
    ...over,
  } as never);
}

describe("aggregateUsage", () => {
  const ts = Date.parse("2026-06-01T12:00:00Z");
  const entries: UsageEntry[] = [
    entry({ ts, domain: "tax", cli: "claude", model: "opus", inputTokens: 100, outputTokens: 100 }),
    entry({ ts: ts + 86400000, domain: "tax", cli: "codex", model: "gpt-5", inputTokens: 200, outputTokens: 50 }),
    entry({ ts, domain: "health", cli: "claude", model: "opus", inputTokens: 100, outputTokens: 100 }),
  ];

  it("totals calls and tokens", () => {
    const r = aggregateUsage(entries, "domain");
    expect(r.total.calls).toBe(3);
    expect(r.total.input_tokens).toBe(400);
    expect(r.total.output_tokens).toBe(250);
  });

  it("buckets by domain, ranked by cost desc", () => {
    const r = aggregateUsage(entries, "domain");
    expect(r.buckets.map((b) => b.key)).toContain("tax");
    expect(r.buckets.map((b) => b.key)).toContain("health");
    // tax has 2 calls incl. opus, so it outranks health
    expect(r.buckets[0]!.key).toBe("tax");
  });

  it("buckets by day in chronological order", () => {
    const r = aggregateUsage(entries, "day");
    expect(r.buckets[0]!.key < r.buckets[r.buckets.length - 1]!.key).toBe(true);
    expect(r.buckets.length).toBe(2);
  });

  it("keys model buckets as cli:model", () => {
    const r = aggregateUsage(entries, "model");
    expect(r.buckets.map((b) => b.key)).toContain("claude:opus");
    expect(r.buckets.map((b) => b.key)).toContain("codex:gpt-5");
  });
});

describe("filterByDomain", () => {
  const ts = Date.parse("2026-06-01T12:00:00Z");
  const entries: UsageEntry[] = [
    entry({ ts, domain: "tax" }),
    entry({ ts, domain: "health" }),
    entry({ ts, domain: null }),
  ];

  it("scopes to a named domain (case-insensitive)", () => {
    expect(filterByDomain(entries, "TAX").length).toBe(1);
    expect(filterByDomain(entries, "tax")[0]!.domain).toBe("tax");
  });

  it("selects the null/General bucket via sentinels", () => {
    expect(filterByDomain(entries, "general").length).toBe(1);
    expect(filterByDomain(entries, "(none)")[0]!.domain).toBeNull();
  });

  it("scoped aggregation only counts that domain", () => {
    const r = aggregateUsage(filterByDomain(entries, "tax"), "model");
    expect(r.total.calls).toBe(1);
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  it("parses relative windows", () => {
    expect(parseSince("7d", now)).toBe(now - 7 * 86400000);
    expect(parseSince("24h", now)).toBe(now - 24 * 3600000);
    expect(parseSince("30m", now)).toBe(now - 30 * 60000);
  });
  it("returns null for empty/garbage", () => {
    expect(parseSince(undefined, now)).toBeNull();
    expect(parseSince("nonsense", now)).toBeNull();
  });
});

describe("dayKey", () => {
  it("formats YYYY-MM-DD", () => {
    expect(dayKey(Date.parse("2026-06-01T12:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
