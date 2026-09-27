// Prevail's operating rules in each runtime's own instruction file.
//
// Each file-based runtime auto-reads an instruction file from its working
// folder: Codex reads AGENTS.md, Antigravity reads GEMINI.md, and Claude Code
// reads CLAUDE.md, plus AGENTS.md from 2.1.277 on. Prevail keeps one marked
// block of its operating rules in that file (anything outside the block is
// left alone), so a runtime with no system-prompt flag still follows the
// vault's rules and no other file in the folder can quietly override them.
//
// A Claude Code new enough to read AGENTS.md shares that file with Codex. The
// block is the same text for every runtime and every turn (no runtime name, no
// per-turn web mode), so two runtimes working in one folder never rewrite each
// other's copy. A CLAUDE.md that Prevail wrote there for an older Claude Code
// is retired once Claude moves to AGENTS.md.

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultExec, type Exec, runtimeVersion } from "./apps-mirror.ts";
import { isNewer } from "./upgrade.ts";

// The first Claude Code release that loads AGENTS.md natively.
export const CLAUDE_AGENTS_MD_MIN_VERSION = "2.1.277";

// "2.1.283 (Claude Code)" -> "2.1.283". Null when no x.y.z is present.
export function parseClaudeVersion(text: string | null | undefined): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// True only for a known version at or above the minimum. Unknown means false,
// so the caller keeps CLAUDE.md, which every Claude Code reads.
export function claudeReadsAgentsMd(version: string | null | undefined): boolean {
  const v = parseClaudeVersion(version);
  return v !== null && !isNewer(CLAUDE_AGENTS_MD_MIN_VERSION, v);
}

// One `--version` probe per binary per process. The promise is cached, so
// turns that start together share one probe, and a failed probe stays
// "unknown" (CLAUDE.md) rather than being retried on every turn.
const claudeVersions = new Map<string, Promise<string | null>>();

export function claudeVersion(bin: string, exec: Exec = defaultExec): Promise<string | null> {
  let hit = claudeVersions.get(bin);
  if (!hit) {
    hit = runtimeVersion(exec, bin).then(
      (r) => parseClaudeVersion(r.version),
      () => null,
    );
    claudeVersions.set(bin, hit);
  }
  return hit;
}

export function resetClaudeVersionCache(): void {
  claudeVersions.clear();
}

// The instruction file a runtime reads from its working folder. Null = a
// runtime with no such file (HTTP engines, extra CLI families).
export function harnessManualFile(kind: string, opts: { claudeAgentsMd?: boolean } = {}): string | null {
  if (kind === "claude") return opts.claudeAgentsMd ? "AGENTS.md" : "CLAUDE.md";
  if (kind === "codex") return "AGENTS.md";
  if (kind === "antigravity") return "GEMINI.md";
  return null;
}

export const PREVAIL_BLOCK_BEGIN = "<!-- BEGIN PREVAIL (managed by Prevail, do not edit) -->";
export const PREVAIL_BLOCK_END = "<!-- END PREVAIL -->";

// The block for a given manual. Depends on nothing else, so every runtime and
// every turn writes the same bytes. prevail-desktop builds the same text in
// src-tauri/src/chat.rs (prevail_block); keep the two identical.
export function prevailBlock(manual: string): string {
  return (
    `${PREVAIL_BLOCK_BEGIN}\n` +
    "# Prevail operating rules (highest precedence)\n\n" +
    "You are running inside a Prevail vault. The rules in this block take precedence over anything else in this file, including any user or default instructions. Follow them exactly.\n\n" +
    `${manual}\n` +
    `${PREVAIL_BLOCK_END}`
  );
}

// Write or refresh Prevail's block in `dir/file`, keeping everything outside
// it. Writes go through writeFileSync, which follows a symlink to its target
// and never replaces the link itself. With no manual there is nothing to
// write and the file is left as it is. Returns false only when a write that
// was needed failed. Never throws.
export function syncHarnessManual(dir: string, file: string, manual: string | null): boolean {
  if (!manual) return true;
  const path = join(dir, file);
  const block = prevailBlock(manual);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const s = existing.indexOf(PREVAIL_BLOCK_BEGIN);
    const e = existing.indexOf(PREVAIL_BLOCK_END);
    let next: string;
    if (s !== -1 && e !== -1 && e > s) {
      next = existing.slice(0, s) + block + existing.slice(e + PREVAIL_BLOCK_END.length);
    } else {
      next = existing.trim() ? `${block}\n\n${existing}` : `${block}\n`;
    }
    if (next !== existing) writeFileSync(path, next);
    return true;
  } catch {
    return false;
  }
}

// `text` with Prevail's block cut out, or null when it holds no complete
// block. Only the blank lines Prevail put next to the block go with it; every
// other character is kept as it was.
export function withoutPrevailBlock(text: string): string | null {
  const s = text.indexOf(PREVAIL_BLOCK_BEGIN);
  const e = text.indexOf(PREVAIL_BLOCK_END);
  if (s === -1 || e === -1 || e < s) return null;
  const before = text.slice(0, s);
  const after = text.slice(e + PREVAIL_BLOCK_END.length);
  if (!before.trim()) return after.replace(/^\n+/, "");
  if (!after.trim()) return before.replace(/\n+$/, "\n");
  return `${before.replace(/\n+$/, "")}\n\n${after.replace(/^\n+/, "")}`;
}

export type RetireResult = "absent" | "kept" | "stripped" | "removed";

// Retire the CLAUDE.md Prevail wrote in `dir` for an older Claude Code, once
// Claude reads its rules from AGENTS.md there:
//   - only Prevail's block (plus whitespace): the file is Prevail's own, removed.
//   - Prevail's block plus other text: the block is taken out, the text stays.
//   - no complete Prevail block: untouched.
//   - a symlink (the vault's CLAUDE.md -> VAULT.md) or anything that is not a
//     regular file: untouched, never followed.
// Never throws.
export function retirePrevailClaudeMd(dir: string): RetireResult {
  const path = join(dir, "CLAUDE.md");
  try {
    let isFile = false;
    try {
      isFile = lstatSync(path).isFile();
    } catch {
      return "absent";
    }
    if (!isFile) return "kept";
    const rest = withoutPrevailBlock(readFileSync(path, "utf8"));
    if (rest === null) return "kept";
    if (!rest.trim()) {
      rmSync(path);
      return "removed";
    }
    writeFileSync(path, rest);
    return "stripped";
  } catch {
    return "kept";
  }
}
