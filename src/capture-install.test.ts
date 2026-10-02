import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptHookWired, renderPlist, unwirePromptHook, wirePromptHook } from "./capture-install.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "capinst-"));

describe("capture push hooks", () => {
  test("adds a Codex UserPromptSubmit hook beside the existing ones, once", () => {
    const file = join(tmp(), "hooks.json");
    const other = { hooks: [{ type: "command", command: "foo-status working" }] };
    writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [other], Stop: [other] } }));
    expect(promptHookWired("codex", file)).toBe(false);

    const first = wirePromptHook("codex", file, true);
    expect(first).toMatchObject({ wired: true, action: "added", method: "push" });
    const second = wirePromptHook("codex", file, true);
    expect(second.action).toBe("updated");

    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.hooks.Stop).toEqual([other]);
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(2);
    expect(cfg.hooks.UserPromptSubmit[0]).toEqual(other);
    expect(cfg.hooks.UserPromptSubmit[1].hooks[0].command).toContain("capture --tool codex");
    expect(promptHookWired("codex", file)).toBe(true);
    expect(promptHookWired("claude", file)).toBe(false);

    expect(unwirePromptHook("codex", file).action).toBe("removed");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit).toEqual([other]);
  });

  test("a missing harness is left alone", () => {
    const file = join(tmp(), "hooks.json");
    expect(wirePromptHook("codex", file, false)).toMatchObject({ wired: false, action: "noop" });
  });

  test("a hooks file that is not JSON is reported, not overwritten", () => {
    const file = join(tmp(), "hooks.json");
    writeFileSync(file, "{ not json");
    expect(wirePromptHook("codex", file, true).error).toBeTruthy();
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("capture sync agent", () => {
  test("follows the saved vault instead of pinning one", () => {
    const plist = renderPlist();
    expect(plist).toContain("<string>sync</string>");
    expect(plist).not.toContain("--vault");
    expect(plist).toContain("prevail-capture.log");
  });
});
