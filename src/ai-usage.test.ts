import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiUsageReport, apiUsd, detectNewTools, priceFor, scanAiUsage, scrub, setPlanCost, sqlTime, toEvents, type Roots } from "./ai-usage.ts";
import { buildEntry } from "./usage.ts";

const ROOT = join("/tmp", `prevail-ai-usage-${process.pid}`);
const HOME = join(ROOT, "home");
const V = join(ROOT, "vault");
const roots: Roots = { home: HOME, appSupport: join(HOME, "Library", "Application Support"), cacheDir: join(ROOT, "cache") };
const NOW = Date.parse("2026-10-15T12:00:00Z");

const asst = (id: string, req: string, ts: string, out: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", requestId: req, timestamp: ts, cwd: "/work/foo", sessionId: "s-1", version: "2.1.0",
  message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 200 } } },
  ...extra,
});

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "apps"), { recursive: true });
  // Claude Code: one response written as two content-block lines (the first
  // with partial output), copied again into a resumed session file; a second
  // response; a cost-state line; one line in an unknown shape.
  const proj = join(HOME, ".claude", "projects", "-work-foo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "s-1.jsonl"), [
    JSON.stringify({ type: "user", cwd: "/work/foo", message: { content: "hello sk-ant-api03-thisisnotarealkeyatall" } }),
    asst("msg_a", "req_a", "2026-10-02T10:00:00Z", 5),
    asst("msg_a", "req_a", "2026-10-02T10:00:01Z", 50),
    asst("msg_b", "req_b", "2026-10-03T10:00:00Z", 20, { cwd: "/work/foo/sub" }),
    JSON.stringify({ type: "cost-state", sessionId: "s-1", startTime: "2026-10-02T09:59:00Z", totalCostUSD: 0.5 }),
    "",
  ].join("\n"));
  writeFileSync(join(proj, "s-2.jsonl"), [asst("msg_a", "req_a", "2026-10-02T10:00:01Z", 50), ""].join("\n"));
  // A subagent transcript that ran elsewhere still belongs to the folder's project.
  mkdirSync(join(proj, "s-1", "subagents"), { recursive: true });
  writeFileSync(join(proj, "s-1", "subagents", "agent-1.jsonl"), [asst("msg_sub", "req_sub", "2026-10-02T11:00:00Z", 1, { cwd: "/tmp/elsewhere" }), ""].join("\n"));
  // An old month: written once, then frozen.
  writeFileSync(join(proj, "s-old.jsonl"), [asst("msg_old", "req_old", "2026-07-02T10:00:00Z", 7), ""].join("\n"));
  // Codex: a new-shape rollout (token_usage_record) and an old one (token_count last).
  const cx = join(HOME, ".codex", "sessions", "2026", "10", "02");
  mkdirSync(cx, { recursive: true });
  const meta = JSON.stringify({ timestamp: "2026-10-02T10:00:00Z", type: "session_meta", payload: { id: "c-1", cwd: "/work/bar", cli_version: "0.155.1" } });
  const ctx = JSON.stringify({ timestamp: "2026-10-02T10:00:00Z", type: "turn_context", payload: { model: "gpt-6-astra", cwd: "/work/bar" } });
  const usage = { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 1040 };
  writeFileSync(join(cx, "rollout-new.jsonl"), [meta, ctx,
    JSON.stringify({ timestamp: "2026-10-02T10:00:02Z", type: "token_usage_record", payload: { response_id: "r1", turn_id: "t1", usage } }),
    JSON.stringify({ timestamp: "2026-10-02T10:00:02Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage }, rate_limits: { primary: { used_percent: 12 }, secondary: { used_percent: 30 }, plan_type: "plus" } } }),
    ""].join("\n"));
  writeFileSync(join(cx, "rollout-old.jsonl"), [meta.replace("c-1", "c-2"), ctx,
    JSON.stringify({ timestamp: "2026-10-02T11:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } }),
    JSON.stringify({ timestamp: "2026-10-02T11:01:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...usage, input_tokens: 2000 }, last_token_usage: usage } } }),
    ""].join("\n"));
  // opencode with its own cost; glyph sessions; Wispr counts.
  const oc = join(HOME, ".local", "share", "opencode");
  mkdirSync(oc, { recursive: true });
  const db = new Database(join(oc, "opencode.db"));
  db.run("create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)");
  db.run("insert into message values ('m1','s',0,0,?)", [JSON.stringify({ role: "assistant", modelID: "foo-model", cost: 0.25, sessionID: "o-1", path: { cwd: "/work/baz" }, time: { created: Date.parse("2026-10-04T10:00:00Z") }, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } })]);
  db.close();
  mkdirSync(join(HOME, ".local", "state", "glyph"), { recursive: true });
  writeFileSync(join(HOME, ".local", "state", "glyph", "sessions.tsv"), "2026-10-05T09:00:00\tcodex\tfoo-session\t/work/bar\thost\n2026-10-05T10:00:00\tclaude\tbar-session\t/work/foo\thost\n");
  const wd = join(roots.appSupport, "Wispr Flow");
  mkdirSync(wd, { recursive: true });
  const w = new Database(join(wd, "flow.sqlite"));
  w.run("create table History (transcriptEntityId text, timestamp text, formattedText text)");
  w.run("create table InstructHistory (id text, createdAt text)");
  w.run("insert into History values ('d1','2026-10-06 08:00:00.000 +00:00','secret words never read')");
  w.run("insert into InstructHistory values ('i1','2026-10-06 09:00:00.000 +00:00')");
  w.close();
}

beforeEach(seed);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("prices", () => {
  test("exact, dated and effort-suffixed model ids find their price", () => {
    expect(priceFor("claude-opus-5-5")!.in).toBe(4);
    expect(priceFor("claude-haiku-4-5-20251001")!.cw1h).toBe(2);
    expect(priceFor("gpt-6-astra-high")!.out).toBe(50);
    expect(priceFor("not-a-model")).toBeNull();
  });
  test("cache tiers are priced apart: 1h writes cost more than 5m writes", () => {
    const base = { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0, reasoning: 0 };
    expect(apiUsd("claude-opus-5-5", { ...base, cw: 1e6 })).toBeCloseTo(5, 6);
    expect(apiUsd("claude-opus-5-5", { ...base, cw1h: 1e6 })).toBeCloseTo(8, 6);
    expect(apiUsd("claude-opus-5-5", { ...base, cr: 1e6 })).toBeCloseTo(0.2, 6);
  });
});

describe("adapters", () => {
  test("Claude: one record per response, the complete count wins, copies are not counted twice", () => {
    const r = scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    expect(r.tools.claude!.shape).toBe("ok");
    const lines = readFileSync(join(V, "build", "_meta", "events", "claude", "2026-10.mac-a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const tok = lines.filter((e) => e.kind === "ai.tokens");
    const out = tok.reduce((a, e) => a + e.attrs.out, 0);
    expect(out).toBe(71); // 50 (msg_a, full) + 20 (msg_b) + 1 (subagent)
    expect(tok.reduce((a, e) => a + e.attrs.cache_write_1h, 0)).toBe(300);
    // The project is where the session started, not where it wandered.
    expect(new Set(tok.map((e) => e.project))).toEqual(new Set(["/work/foo"]));
    expect(lines.find((e) => e.kind === "ai.cost_reported").attrs.usd_reported).toBe(0.5);
    // No prompt text ever reaches the vault.
    const all = readdirSync(join(V, "build", "_meta", "events"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(V, "build", "_meta", "events", f), "utf8")).join("\n");
    expect(all).not.toContain("hello");
    expect(all).not.toContain("secret words");
    expect(all).not.toContain("sk-ant");
  });

  test("Codex: response records when present, otherwise each count's last usage; cached input apart", () => {
    scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    const tok = readFileSync(join(V, "build", "_meta", "events", "codex", "2026-10.mac-a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "ai.tokens");
    // new file: 1 record; old file: 2 counts. Never the cumulative total.
    expect(tok.reduce((a, e) => a + e.n, 0)).toBe(3);
    expect(tok.reduce((a, e) => a + e.attrs.in, 0)).toBe(3 * 400);
    expect(tok.reduce((a, e) => a + e.attrs.cache_read, 0)).toBe(3 * 600);
  });

  test("months before the previous one are frozen; incremental scans read only grown files", () => {
    const first = scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    expect(first.months).toEqual(["2026-09", "2026-10"]);
    expect(existsSync(join(V, "build", "_meta", "events", "claude", "2026-07.mac-a.jsonl"))).toBe(false);
    const again = scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    expect(again.tools.claude!.read).toBe(0);
    writeFileSync(join(HOME, ".claude", "projects", "-work-foo", "s-2.jsonl"), [asst("msg_a", "req_a", "2026-10-02T10:00:01Z", 50), asst("msg_c", "req_c", "2026-10-07T10:00:00Z", 3), ""].join("\n"));
    expect(scanAiUsage(V, { roots, now: NOW, host: "mac-a" }).tools.claude!.read).toBe(1);
  });

  test("a deleted transcript keeps its tokens (copy as you read)", () => {
    scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    rmSync(join(HOME, ".claude", "projects", "-work-foo", "s-1.jsonl"));
    scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    const r = aiUsageReport(V, "2026-10", { tool: "claude" });
    expect(r.total.out).toBe(71);
  });

  test("an unknown usage shape is a health problem, not silent zeros", () => {
    writeFileSync(join(HOME, ".claude", "projects", "-work-foo", "s-3.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-10-08T00:00:00Z", message: { id: "x", usage: { tokens_in: 5 } } }) + "\n");
    const r = scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    expect(r.tools.claude!.shape).toBe("unknown");
    expect(r.tools.claude!.note).toContain("shape");
    const health = JSON.parse(readFileSync(join(V, "build", "_meta", "apps", "adapters.mac-a.json"), "utf8"));
    expect(health.tools.claude.shape).toBe("unknown");
  });

  test("opencode, glyph and Wispr give counts and the tool's own cost; absent tools say absent", () => {
    const r = scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    expect(r.tools.opencode!.events).toBeGreaterThan(0);
    expect(r.tools.hermes!.shape).toBe("absent");
    const rep = aiUsageReport(V, "2026-10");
    expect(rep.by_tool.find((t) => t.key === "opencode")!.usd_reported).toBe(0.25);
    expect(rep.by_tool.find((t) => t.key === "glyph")!.sessions).toBe(2);
    expect(rep.by_tool.find((t) => t.key === "wispr")!.prompts).toBe(2);
    expect(rep.by_tool.find((t) => t.key === "codex")!.quota).toMatchObject({ five_hour_pct: 12, seven_day_pct: 30, plan: "plus" });
  });
});

describe("one ledger across machines", () => {
  test("every host's events add up, and both Macs read the same number", () => {
    scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    const a = aiUsageReport(V, "2026-10");
    // A second machine's file (as synced into the same vault).
    const src = join(V, "build", "_meta", "events", "claude", "2026-10.mac-a.jsonl");
    writeFileSync(join(V, "build", "_meta", "events", "claude", "2026-10.mac-b.jsonl"), readFileSync(src, "utf8").replaceAll('"host":"mac-a"', '"host":"mac-b"'));
    const both = aiUsageReport(V, "2026-10");
    expect(both.hosts).toEqual(["mac-a", "mac-b"]);
    expect(both.by_tool.find((t) => t.key === "claude")!.out).toBe(2 * a.by_tool.find((t) => t.key === "claude")!.out);
  });

  test("paid comes from the vendor's app record; the value multiple is API-equivalent over paid", () => {
    scanAiUsage(V, { roots, now: NOW, host: "mac-a" });
    expect(aiUsageReport(V, "2026-10").paid_monthly).toBeNull();
    setPlanCost(V, "anthropic", 1, "month");
    const r = aiUsageReport(V, "2026-10");
    const claude = r.by_tool.find((t) => t.key === "claude")!;
    expect(claude.paid_monthly).toBe(1);
    expect(claude.value_multiple).toBeCloseTo(Math.round(claude.usd_api * 10) / 10, 1);
    expect(() => setPlanCost(V, "../x", 1, "month")).toThrow();
  });
});

describe("honesty", () => {
  test("secrets in stored strings are redacted", () => {
    expect(scrub("/Users/foo/ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted]");
    expect(scrub("/work/foo")).toBe("/work/foo");
  });
  test("SQLite datetimes parse with a space or an offset", () => {
    expect(sqlTime("2026-10-06 08:00:00.000 +00:00")).toBe(Date.parse("2026-10-06T08:00:00Z"));
    expect(sqlTime("2026-10-02 10:30:05.237964+00:00")).toBe(Date.parse("2026-10-02T10:30:05.237Z"));
    expect(sqlTime(1780704624940)).toBe(1780704624940);
  });
  test("a chat estimate stays labeled estimated in the usage ledger", () => {
    expect(buildEntry({ session: "s", cli: "claude", inputTokens: 10, outputTokens: 5, tokenSource: "estimated" }).token_source).toBe("estimated");
    expect(buildEntry({ session: "s", cli: "claude", inputTokens: 10, outputTokens: 5 }).token_source).toBe("reported");
  });
  test("tools on PATH with no adapter are reported, not ignored", () => {
    const bin = join(ROOT, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "grok"), "");
    expect(detectNewTools(roots, bin).map((t) => t.tool)).toContain("grok");
  });
  test("toEvents keeps the larger of two records sharing a key", () => {
    const t = (out: number) => ({ in: 1, out, cr: 0, cw: 0, cw1h: 0, reasoning: 0 });
    const ev = toEvents("claude", [
      { k: "a", ts: NOW, kind: "ai.tokens", model: "claude-opus-5-5", t: t(1) },
      { k: "a", ts: NOW, kind: "ai.tokens", model: "claude-opus-5-5", t: t(9) },
    ], "h");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.attrs.out).toBe(9);
  });
});
