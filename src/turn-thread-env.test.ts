import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChatTurn } from "./cli-bridge.ts";

// Thread linkage: a turn that knows its Prevail thread exports it to the CLI
// it spawns (and so to that CLI's act-gate hook) as PREVAIL_THREAD_ID.
function fakeCli(): { bin: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-thread-cli-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nprintf 'thread=%s' "$PREVAIL_THREAD_ID"\n`);
  chmodSync(bin, 0o755);
  const cwd = join(dir, "vault", "foo");
  mkdirSync(cwd, { recursive: true });
  return { bin, cwd };
}

describe("PREVAIL_THREAD_ID on spawned turns", () => {
  test("set when the turn carries a thread id, absent otherwise, never leaking between turns", async () => {
    const { bin, cwd } = fakeCli();
    const cli = { kind: "claude" as const, bin, label: "claude" };
    const [a, b] = await Promise.all([
      runChatTurn({ prompt: "hi", cwd, cli, model: "", isFirst: true, bare: true, threadId: "thread_foo" }),
      runChatTurn({ prompt: "hi", cwd, cli, model: "", isFirst: true, bare: true }),
    ]);
    expect(a).toContain("thread=thread_foo");
    expect(b).not.toContain("thread_foo");
  });
});
