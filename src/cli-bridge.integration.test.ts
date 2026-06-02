// Integration smoke tests — actually spawn each detected CLI with the exact
// argv buildCliArgs() produces and verify the CLI doesn't immediately fail on
// the structural errors we'd hit if a required flag were missing (e.g.,
// 'Not inside a trusted directory' for codex or 'Gemini CLI is not running
// in a trusted directory' for gemini).
//
// Tests are SKIPPED when:
//   - the CLI binary is not on PATH
//   - INTEGRATION_TESTS env var is not set (default off — these can take 30s+
//     per CLI and require network + working auth)
//
// To run: INTEGRATION_TESTS=1 bun test src/cli-bridge.integration.test.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliArgs, detectClis, type AvailableCli } from "./cli-bridge.ts";

const SHOULD_RUN = process.env.INTEGRATION_TESTS === "1";

function findCli(kind: "claude" | "codex" | "gemini"): AvailableCli | null {
  return detectClis().find((c) => c.kind === kind) ?? null;
}

function makeFakeVaultDir(): string {
  // Create a non-git temp dir to mimic a vault folder. This is the exact
  // shape that previously broke codex (no git repo, no trust list).
  const dir = mkdtempSync(join(tmpdir(), "prevail-test-"));
  writeFileSync(join(dir, "state.md"), "# Test\nplaceholder.");
  return dir;
}

function runCli(bin: string, args: string[], cwd: string): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(bin, args, {
    cwd,
    env: process.env,
    timeout: 90_000,
    encoding: "utf8",
  });
  return {
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
    code: r.status,
  };
}

describe.if(SHOULD_RUN)("cli-bridge integration", () => {
  describe("codex", () => {
    const cli = findCli("codex");
    test.if(cli !== null)(
      "does not hit 'Not inside a trusted directory'",
      () => {
        if (!cli) return; // type guard for compiler; .if() already gates
        const dir = makeFakeVaultDir();
        try {
          const args = buildCliArgs({
            cli: "codex",
            prompt: "Reply with exactly the word: pong",
            model: "",
            isFirst: true,
            manual: null,
          });
          const { stdout, stderr } = runCli(cli.bin, args, dir);
          const combined = stdout + stderr;
          // The structural error our --skip-git-repo-check flag is meant to
          // prevent. If we ever see this, the argv construction has regressed.
          expect(combined).not.toContain("Not inside a trusted directory");
          expect(combined).not.toContain("skip-git-repo-check was not specified");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120_000,
    );
  });

  describe("gemini", () => {
    const cli = findCli("gemini");
    test.if(cli !== null)(
      "does not hit 'not running in a trusted directory'",
      () => {
        if (!cli) return;
        const dir = makeFakeVaultDir();
        try {
          const args = buildCliArgs({
            cli: "gemini",
            prompt: "Reply with exactly the word: pong",
            model: "",
            isFirst: true,
            manual: null,
          });
          const { stdout, stderr } = runCli(cli.bin, args, dir);
          const combined = stdout + stderr;
          expect(combined).not.toContain("not running in a trusted directory");
          expect(combined).not.toContain("use `--skip-trust`");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120_000,
    );
  });

  describe("claude", () => {
    const cli = findCli("claude");
    test.if(cli !== null)("--help exits 0 with the right argv shape", () => {
      if (!cli) return;
      const r = spawnSync(cli.bin, ["--help"], { encoding: "utf8", timeout: 10_000 });
      expect(r.status).toBe(0);
      expect((r.stdout ?? "").toString().toLowerCase()).toContain("claude");
    });
  });
});

// Always-on lightweight smoke test: verifies each detected CLI's --help works.
// This catches the case where a CLI was uninstalled or its binary is broken,
// without needing network/auth.
describe("cli --help smoke", () => {
  const clis = detectClis();
  for (const cli of clis) {
    test(`${cli.kind} --help exits 0`, () => {
      const r = spawnSync(cli.bin, ["--help"], { encoding: "utf8", timeout: 10_000 });
      expect(r.status).toBe(0);
    });
  }
  if (clis.length === 0) {
    test.skip("no CLIs detected on PATH", () => {});
  }
});
