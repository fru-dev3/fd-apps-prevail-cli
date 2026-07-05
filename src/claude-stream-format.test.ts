import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaudeStream } from "./cli-bridge.ts";

// Narration between tool calls must stream as separate paragraphs, not one
// run-on blob ("...exposes.Yes, I can."). The fake claude below replays the
// exact stream-json shape of a real multi-step turn.
function fakeClaude(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat <<'NDJSON'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nNDJSON\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const t = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const call = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "posthog_exec", input: {} }] } });
const result = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

describe("claude stream narration formatting", () => {
  test("text blocks separated by tool activity get paragraph breaks (stream and final agree)", async () => {
    const bin = fakeClaude([
      t("I'll check whether the PostHog connection is live and what tools it exposes."),
      call("a"), result("a"),
      t("Yes, I can. PostHog is connected."),
      call("b"), result("b"),
      t("Project found: \"Default project\" in org \"FDev3\"."),
    ]);
    let streamed = "";
    const final = await runClaudeStream(bin, [], process.cwd(), undefined, (d) => { streamed += d; }, () => {}, undefined);
    expect(final).toBe(
      "I'll check whether the PostHog connection is live and what tools it exposes.\n\n" +
      "Yes, I can. PostHog is connected.\n\n" +
      "Project found: \"Default project\" in org \"FDev3\".",
    );
    expect(streamed.trim()).toBe(final);
  });

  test("no spurious breaks: consecutive text with no tools in between stays as-is", async () => {
    const bin = fakeClaude([t("First sentence. "), t("Same thought continues.")]);
    const final = await runClaudeStream(bin, [], process.cwd(), undefined, undefined, () => {}, undefined);
    expect(final).toBe("First sentence. Same thought continues.");
  });

  test("no double break when the model already ended with a newline", async () => {
    const bin = fakeClaude([t("Done with step one.\n"), call("a"), result("a"), t("Step two.")]);
    const final = await runClaudeStream(bin, [], process.cwd(), undefined, undefined, () => {}, undefined);
    expect(final).toBe("Done with step one.\nStep two.");
  });
});
