// Prevail's block in each runtime's instruction file: the Claude Code version
// gate, which file each runtime gets, a block that reads the same for every
// runtime, and retiring the CLAUDE.md Prevail wrote for an older Claude Code.
// Invented folder names and text only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "./apps-mirror.ts";
import {
  CLAUDE_AGENTS_MD_MIN_VERSION,
  claudeReadsAgentsMd,
  claudeVersion,
  harnessManualFile,
  PREVAIL_BLOCK_BEGIN,
  PREVAIL_BLOCK_END,
  parseClaudeVersion,
  prevailBlock,
  resetClaudeVersionCache,
  retirePrevailClaudeMd,
  syncHarnessManual,
  withoutPrevailBlock,
} from "./harness-manual.ts";

const MANUAL = "# Garden rules\nKeep every bed's notes in state.md.";
const USER_TEXT = "# My notes\n\nWater the tomatoes before noon.\n";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prevail-harness-manual-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function execReturning(stdout: string, calls: string[] = [], extra: Partial<ExecResult> = {}): Exec {
  return async (bin) => {
    calls.push(bin);
    return { code: 0, stdout, stderr: "", missing: false, timedOut: false, ...extra };
  };
}

describe("Claude Code version gate", () => {
  test("reads the version out of claude --version output", () => {
    expect(parseClaudeVersion("2.1.283 (Claude Code)")).toBe("2.1.283");
    expect(parseClaudeVersion("v2.1.277")).toBe("2.1.277");
    expect(parseClaudeVersion("claude: command not found")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
    expect(parseClaudeVersion(undefined)).toBeNull();
  });

  test("2.1.277 and later read AGENTS.md", () => {
    expect(CLAUDE_AGENTS_MD_MIN_VERSION).toBe("2.1.277");
    expect(claudeReadsAgentsMd("2.1.277")).toBe(true);
    expect(claudeReadsAgentsMd("2.1.283 (Claude Code)")).toBe(true);
    expect(claudeReadsAgentsMd("2.2.0")).toBe(true);
    expect(claudeReadsAgentsMd("3.0.0")).toBe(true);
    // Compared as numbers, not text: 2.1.1000 is newer than 2.1.277.
    expect(claudeReadsAgentsMd("2.1.1000")).toBe(true);
  });

  test("older and unknown versions keep CLAUDE.md", () => {
    expect(claudeReadsAgentsMd("2.1.276")).toBe(false);
    expect(claudeReadsAgentsMd("2.1.138 (Claude Code)")).toBe(false);
    expect(claudeReadsAgentsMd("2.0.999")).toBe(false);
    expect(claudeReadsAgentsMd("1.9.400")).toBe(false);
    expect(claudeReadsAgentsMd(null)).toBe(false);
    expect(claudeReadsAgentsMd(undefined)).toBe(false);
    expect(claudeReadsAgentsMd("not a version")).toBe(false);
  });

  describe("claudeVersion probes once per binary per process", () => {
    beforeEach(() => resetClaudeVersionCache());
    afterEach(() => resetClaudeVersionCache());

    test("concurrent and repeated calls share one probe", async () => {
      const calls: string[] = [];
      const exec = execReturning("2.1.290 (Claude Code)\n", calls);
      const [a, b] = await Promise.all([claudeVersion("/opt/acme/claude", exec), claudeVersion("/opt/acme/claude", exec)]);
      const c = await claudeVersion("/opt/acme/claude", exec);
      expect([a, b, c]).toEqual(["2.1.290", "2.1.290", "2.1.290"]);
      expect(calls).toEqual(["/opt/acme/claude"]);
    });

    test("each binary gets its own probe", async () => {
      const calls: string[] = [];
      expect(await claudeVersion("/opt/acme/new/claude", execReturning("2.1.290", calls))).toBe("2.1.290");
      expect(await claudeVersion("/opt/acme/old/claude", execReturning("2.1.100", calls))).toBe("2.1.100");
      expect(calls).toEqual(["/opt/acme/new/claude", "/opt/acme/old/claude"]);
    });

    test("a failed or missing probe is unknown, cached, not retried", async () => {
      const calls: string[] = [];
      const failing: Exec = async (bin) => {
        calls.push(bin);
        throw new Error("spawn failed");
      };
      expect(await claudeVersion("/opt/acme/broken/claude", failing)).toBeNull();
      expect(await claudeVersion("/opt/acme/broken/claude", failing)).toBeNull();
      expect(calls).toHaveLength(1);
      expect(await claudeVersion("/opt/acme/missing/claude", execReturning("", [], { code: null, missing: true }))).toBeNull();
      expect(await claudeVersion("/opt/acme/garbled/claude", execReturning("usage: claude [options]"))).toBeNull();
    });
  });
});

describe("harnessManualFile", () => {
  test("claude gets AGENTS.md only when its version reads it", () => {
    expect(harnessManualFile("claude")).toBe("CLAUDE.md");
    expect(harnessManualFile("claude", { claudeAgentsMd: false })).toBe("CLAUDE.md");
    expect(harnessManualFile("claude", { claudeAgentsMd: true })).toBe("AGENTS.md");
  });

  test("other runtimes are unchanged", () => {
    expect(harnessManualFile("codex")).toBe("AGENTS.md");
    expect(harnessManualFile("codex", { claudeAgentsMd: true })).toBe("AGENTS.md");
    expect(harnessManualFile("antigravity")).toBe("GEMINI.md");
    expect(harnessManualFile("ollama")).toBeNull();
    expect(harnessManualFile("openrouter")).toBeNull();
  });
});

describe("prevailBlock", () => {
  test("matches the desktop's bytes", () => {
    // Same literal as chat.rs block_bytes_match_the_engine in prevail-desktop.
    expect(prevailBlock("Rule one.")).toBe(
      "<!-- BEGIN PREVAIL (managed by Prevail, do not edit) -->\n# Prevail operating rules (highest precedence)\n\nYou are running inside a Prevail vault. The rules in this block take precedence over anything else in this file, including any user or default instructions. Follow them exactly.\n\nRule one.\n<!-- END PREVAIL -->",
    );
  });

  test("names no runtime file and carries no per-turn web mode", () => {
    const block = prevailBlock(MANUAL);
    expect(block.startsWith(`${PREVAIL_BLOCK_BEGIN}\n`)).toBe(true);
    expect(block.endsWith(PREVAIL_BLOCK_END)).toBe(true);
    expect(block).toContain(MANUAL);
    expect(block).toContain("anything else in this file");
    expect(block).not.toMatch(/CLAUDE\.md|AGENTS\.md|GEMINI\.md/);
    expect(block).not.toContain("<web-access>");
  });
});

describe("syncHarnessManual", () => {
  test("writes the same bytes whichever runtime file it lands in", () => {
    for (const file of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) expect(syncHarnessManual(dir, file, MANUAL)).toBe(true);
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(claude);
    expect(readFileSync(join(dir, "GEMINI.md"), "utf8")).toBe(claude);
    expect(claude).toBe(`${prevailBlock(MANUAL)}\n`);
  });

  test("a second run leaves the file byte-for-byte alone", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, USER_TEXT);
    syncHarnessManual(dir, "AGENTS.md", MANUAL);
    const first = readFileSync(path, "utf8");
    expect(first).toBe(`${prevailBlock(MANUAL)}\n\n${USER_TEXT}`);
    syncHarnessManual(dir, "AGENTS.md", MANUAL);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("refreshes only the block, keeping text around it", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, `Intro line.\n\n${PREVAIL_BLOCK_BEGIN}\nold rules in this AGENTS.md\n${PREVAIL_BLOCK_END}\n\n${USER_TEXT}`);
    syncHarnessManual(dir, "AGENTS.md", MANUAL);
    expect(readFileSync(path, "utf8")).toBe(`Intro line.\n\n${prevailBlock(MANUAL)}\n\n${USER_TEXT}`);
  });

  test("writes through a symlink and keeps the link", () => {
    writeFileSync(join(dir, "MAP.md"), "# Map\n");
    symlinkSync("MAP.md", join(dir, "AGENTS.md"));
    syncHarnessManual(dir, "AGENTS.md", MANUAL);
    expect(lstatSync(join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "AGENTS.md"))).toBe("MAP.md");
    expect(readFileSync(join(dir, "MAP.md"), "utf8")).toBe(`${prevailBlock(MANUAL)}\n\n# Map\n`);
  });

  test("no manual: nothing is written", () => {
    expect(syncHarnessManual(dir, "AGENTS.md", null)).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  test("reports a failed write", () => {
    expect(syncHarnessManual(join(dir, "no-such-folder"), "AGENTS.md", MANUAL)).toBe(false);
  });
});

describe("withoutPrevailBlock", () => {
  const block = prevailBlock(MANUAL);

  test("a file that is only the block leaves nothing", () => {
    expect(withoutPrevailBlock(`${block}\n`)).toBe("");
  });

  test("gives back the user text exactly as it was before Prevail prepended", () => {
    expect(withoutPrevailBlock(`${block}\n\n${USER_TEXT}`)).toBe(USER_TEXT);
  });

  test("keeps text on both sides", () => {
    expect(withoutPrevailBlock(`Intro line.\n\n${block}\n\n${USER_TEXT}`)).toBe(`Intro line.\n\n${USER_TEXT}`);
    expect(withoutPrevailBlock(`${USER_TEXT}\n${block}\n`)).toBe(USER_TEXT);
  });

  test("no complete block: null", () => {
    expect(withoutPrevailBlock(USER_TEXT)).toBeNull();
    expect(withoutPrevailBlock(`${PREVAIL_BLOCK_BEGIN}\nunfinished`)).toBeNull();
    expect(withoutPrevailBlock(`${PREVAIL_BLOCK_END}\n${PREVAIL_BLOCK_BEGIN}`)).toBeNull();
  });
});

describe("retirePrevailClaudeMd", () => {
  const claudeMd = () => join(dir, "CLAUDE.md");

  test("a CLAUDE.md holding only Prevail's block is removed", () => {
    // The shape an older engine left: its block, with a web note, and a newline.
    writeFileSync(claudeMd(), `${PREVAIL_BLOCK_BEGIN}\nold rules in this CLAUDE.md\n<web-access>\noff\n</web-access>\n${PREVAIL_BLOCK_END}\n`);
    expect(retirePrevailClaudeMd(dir)).toBe("removed");
    expect(existsSync(claudeMd())).toBe(false);
  });

  test("a mixed CLAUDE.md keeps the user text and loses only the block", () => {
    writeFileSync(claudeMd(), `${prevailBlock(MANUAL)}\n\n${USER_TEXT}`);
    expect(retirePrevailClaudeMd(dir)).toBe("stripped");
    expect(readFileSync(claudeMd(), "utf8")).toBe(USER_TEXT);
  });

  test("a CLAUDE.md with no Prevail block is untouched", () => {
    writeFileSync(claudeMd(), USER_TEXT);
    expect(retirePrevailClaudeMd(dir)).toBe("kept");
    expect(readFileSync(claudeMd(), "utf8")).toBe(USER_TEXT);
  });

  test("the vault's CLAUDE.md link to its map is never followed or removed", () => {
    const map = `${prevailBlock(MANUAL)}\n\n# Map\n`;
    writeFileSync(join(dir, "VAULT.md"), map);
    symlinkSync("VAULT.md", claudeMd());
    expect(retirePrevailClaudeMd(dir)).toBe("kept");
    expect(lstatSync(claudeMd()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeMd())).toBe("VAULT.md");
    expect(readFileSync(join(dir, "VAULT.md"), "utf8")).toBe(map);
  });

  test("no CLAUDE.md: nothing to do", () => {
    expect(retirePrevailClaudeMd(dir)).toBe("absent");
  });
});
