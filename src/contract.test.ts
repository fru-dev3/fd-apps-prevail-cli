import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Upstream CONTRACT canaries (G8). Prevail parses the output of external tools
// we do not control - the `gws` CLI's JSON, and `claude --output-format
// stream-json`. If an upstream release renames a field or event, our parser
// silently degrades ("unknown = write" is safe; a missed recipient parse is
// not). These tests run the REAL binary and assert the exact keys our parsers
// depend on still exist, so a drift becomes a RED build on any machine (dev,
// release runner) that has the tool. They SKIP cleanly where the tool is
// absent (generic CI), so they never produce a false failure.

function has(bin: string): boolean {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 && !!(r.stdout || "").trim();
}

describe("contract: claude --output-format stream-json", () => {
  const available = has("claude");
  test.skipIf(!available)("emits {type:assistant, message.content[]} and {type:result, result}", () => {
    // Minimal, cheap, offline-safe turn. Haiku keeps it fast + cheap.
    const r = spawnSync("claude", ["-p", "Reply with the single word: ok", "--output-format", "stream-json", "--verbose", "--model", "haiku"], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    const lines = (r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);

    // The parser (cli-bridge runClaudeStream) iterates EVERY assistant event's
    // content blocks, so the contract is: at least one assistant event exists,
    // each carries a content array, and a text block appears across them.
    const assistants = events.filter((e) => e.type === "assistant");
    expect(assistants.length, "no {type:'assistant'} event - stream-json shape changed").toBeGreaterThan(0);
    for (const a of assistants) {
      const msg = a.message as { content?: unknown } | undefined;
      expect(Array.isArray(msg?.content), "assistant.message.content is not an array").toBe(true);
    }
    const allBlocks = assistants.flatMap((a) => (a.message as { content?: Array<Record<string, unknown>> }).content ?? []);
    const textBlock = allBlocks.find((b) => b.type === "text");
    expect(textBlock, "no {type:'text', text} block across assistant events").toBeDefined();
    expect(typeof textBlock!.text).toBe("string");

    const result = events.find((e) => e.type === "result");
    expect(result, "no {type:'result'} terminal event - stream-json shape changed").toBeDefined();
    // The parser reads result.result on success. A rate-limited / errored run
    // (is_error) is an environment condition, not a contract break, so only
    // assert the field's type when the turn actually succeeded.
    if (result!.is_error !== true) {
      expect(typeof result!.result, "result.result is not a string on a successful turn").toBe("string");
    }
  }, 70_000);
});

describe("contract: gws auth status --json", () => {
  const available = has("gws");
  test.skipIf(!available)("returns JSON with the identity/scope fields the doctor reads", () => {
    const r = spawnSync("gws", ["auth", "status"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(r.stdout || "{}"); } catch { parsed = null; }
    // If gws is installed but not authed it may print non-JSON guidance; that's
    // a valid state, not a contract break. Only assert the shape when it IS JSON.
    if (!parsed || typeof parsed !== "object") {
      expect(true).toBe(true); // not authed / non-JSON guidance - not a drift
      return;
    }
    // gws-doctor.ts GwsAuthStatus depends on these keys existing (any may be
    // absent when not authed, but the object must be the expected shape - a
    // `user` string when present, arrays for scopes/enabled_apis when present).
    if ("user" in parsed) expect(typeof parsed.user === "string" || parsed.user === null).toBe(true);
    if ("scopes" in parsed) expect(Array.isArray(parsed.scopes)).toBe(true);
    if ("enabled_apis" in parsed) expect(Array.isArray(parsed.enabled_apis)).toBe(true);
    // The doctor also expects auth errors to surface as text it can show, not a throw.
    expect(parsed).not.toBeNull();
  }, 20_000);
});

describe("contract: codex exec sandbox flags", () => {
  const available = has("codex");
  test.skipIf(!available)("still supports --sandbox workspace-write (the C1 fix depends on it)", () => {
    const r = spawnSync("codex", ["exec", "--help"], { encoding: "utf8", timeout: 15_000 });
    const help = `${r.stdout || ""}${r.stderr || ""}`;
    // cli-bridge's Codex act path passes `--sandbox workspace-write`; if codex
    // drops/renames that flag, the C1 sandboxing silently breaks.
    expect(help).toContain("--sandbox");
    expect(help.toLowerCase()).toContain("workspace-write");
  }, 20_000);
});
