// One --settings value per claude launch: the merge, the choice between the
// act-gate file and inline JSON, and the act-gate file carrying both.
// Invented vault and folder names only.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { actGateSettingsPath } from "./act-gate.ts";
import { AGENTS_MD_SETTINGS, type ClaudeSettings, claudeSettingsArg, mergeClaudeSettings } from "./claude-settings.ts";

describe("mergeClaudeSettings", () => {
  test("objects merge key by key, arrays concatenate, later scalars win", () => {
    const a: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: "a" }] }, model: "one", env: { A: "1" } };
    const b: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: "b" }], Stop: [] }, model: "two", env: { B: "2" } };
    expect(mergeClaudeSettings(a, b)).toEqual({
      hooks: { PreToolUse: [{ matcher: "a" }, { matcher: "b" }], Stop: [] },
      model: "two",
      env: { A: "1", B: "2" },
    });
  });

  test("skips missing parts and never mutates its inputs", () => {
    const a: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: "a" }] } };
    const before = JSON.stringify(a);
    const out = mergeClaudeSettings(null, a, undefined, AGENTS_MD_SETTINGS);
    (out.hooks as { PreToolUse: unknown[] }).PreToolUse.push({ matcher: "z" });
    expect(JSON.stringify(a)).toBe(before);
    expect(mergeClaudeSettings()).toEqual({});
  });

  test("the act-gate hook and the AGENTS.md option land in one value", () => {
    const merged = mergeClaudeSettings({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [] }] } }, AGENTS_MD_SETTINGS);
    expect(merged).toEqual({
      hooks: { PreToolUse: [{ matcher: ".*", hooks: [] }] },
      pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } },
    });
  });
});

describe("claudeSettingsArg", () => {
  test("with a gate, the option is merged into the gate file", () => {
    const seen: (ClaudeSettings | undefined)[] = [];
    const gate = (extra?: ClaudeSettings) => {
      seen.push(extra);
      return "/tmp/acme-gate.json";
    };
    expect(claudeSettingsArg({ gate, agentsMd: true })).toBe("/tmp/acme-gate.json");
    expect(claudeSettingsArg({ gate, agentsMd: false })).toBe("/tmp/acme-gate.json");
    expect(seen).toEqual([AGENTS_MD_SETTINGS, undefined]);
  });

  test("without a gate, the option goes inline", () => {
    expect(claudeSettingsArg({ gate: null, agentsMd: true })).toBe(JSON.stringify(AGENTS_MD_SETTINGS));
    expect(claudeSettingsArg({ gate: null, agentsMd: false })).toBeNull();
  });

  test("a gate that fails to write falls back to inline", () => {
    const gate = () => {
      throw new Error("disk full");
    };
    expect(claudeSettingsArg({ gate, agentsMd: true })).toBe(JSON.stringify(AGENTS_MD_SETTINGS));
    expect(claudeSettingsArg({ gate, agentsMd: false })).toBeNull();
  });
});

describe("actGateSettingsPath with extra settings", () => {
  // The gate writes under the real home (Bun's homedir ignores $HOME), so
  // remove exactly the files this test created.
  const vault = `/tmp/prevail-settings-merge-${process.pid}`;
  const created: string[] = [];
  afterAll(() => {
    for (const p of created) rmSync(p, { force: true });
  });

  test("one file carries the hook and the AGENTS.md option", () => {
    const plain = actGateSettingsPath(vault, "garden", true);
    const merged = actGateSettingsPath(vault, "garden", true, AGENTS_MD_SETTINGS);
    created.push(plain, merged);
    expect(merged).not.toBe(plain);
    const plainBody = JSON.parse(readFileSync(plain, "utf8"));
    const mergedBody = JSON.parse(readFileSync(merged, "utf8"));
    expect(Object.keys(plainBody)).toEqual(["hooks"]);
    expect(mergedBody.hooks).toEqual(plainBody.hooks);
    expect(mergedBody.hooks.PreToolUse[0].hooks[0].command).toContain("act-gate-hook");
    expect(mergedBody.pluginConfigs["agents-md@builtin"].options.instructionFiles).toBe("claude-md-and-agents-md");
  });

  test("with no extra, the file is the same shape as before", () => {
    const plain = actGateSettingsPath(vault, "orchard", false);
    created.push(plain);
    const body = readFileSync(plain, "utf8");
    expect(body.startsWith('{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":')).toBe(true);
    expect(body).not.toContain("--vault-lock");
    expect(actGateSettingsPath(vault, "orchard", false)).toBe(plain);
    expect(existsSync(plain)).toBe(true);
    // Same file name as before extra settings existed.
    const legacyKey = createHash("sha256").update(`${vault}\norchard\nfalse`).digest("hex").slice(0, 12);
    expect(basename(plain)).toBe(`${legacyKey}.json`);
  });
});
