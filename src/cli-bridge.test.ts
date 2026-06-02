import { describe, expect, test } from "bun:test";
import { buildCliArgs, detectClis } from "./cli-bridge.ts";

describe("buildCliArgs", () => {
  const PROMPT = "Reply with: pong";

  describe("claude", () => {
    test("first turn, no model, no manual", () => {
      const args = buildCliArgs({
        cli: "claude",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args).toEqual(["-p", PROMPT]);
    });

    test("first turn with model and manual", () => {
      const args = buildCliArgs({
        cli: "claude",
        prompt: PROMPT,
        model: "opus",
        isFirst: true,
        manual: "OPERATING MANUAL CONTENT",
      });
      expect(args).toEqual([
        "--model",
        "opus",
        "--append-system-prompt",
        "OPERATING MANUAL CONTENT",
        "-p",
        PROMPT,
      ]);
    });

    test("continue turn uses --continue (no system-prompt re-injection)", () => {
      const args = buildCliArgs({
        cli: "claude",
        prompt: PROMPT,
        model: "",
        isFirst: false,
        manual: "MANUAL",
      });
      expect(args).toEqual(["--continue", "-p", PROMPT]);
    });
  });

  describe("codex", () => {
    test("includes --skip-git-repo-check so vault dirs (non-git) work", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args[0]).toBe("exec");
      expect(args).toContain("--skip-git-repo-check");
    });

    test("passes -m model when set", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "gpt-5-codex",
        isFirst: true,
        manual: null,
      });
      const mIdx = args.indexOf("-m");
      expect(mIdx).toBeGreaterThanOrEqual(0);
      expect(args[mIdx + 1]).toBe("gpt-5-codex");
    });

    test("prompt is the final positional arg", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args[args.length - 1]).toBe(PROMPT);
    });

    test("manual is wrapped in <operating-manual> block in the prompt", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: "MANUAL CONTENT",
      });
      const last = args[args.length - 1] ?? "";
      expect(last).toContain("<operating-manual>");
      expect(last).toContain("MANUAL CONTENT");
      expect(last).toContain(PROMPT);
    });
  });

  describe("gemini", () => {
    test("includes --skip-trust so vault dirs work", () => {
      const args = buildCliArgs({
        cli: "gemini",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args).toContain("--skip-trust");
    });

    test("passes -m model when set, then -p prompt", () => {
      const args = buildCliArgs({
        cli: "gemini",
        prompt: PROMPT,
        model: "gemini-2.5-pro",
        isFirst: true,
        manual: null,
      });
      const mIdx = args.indexOf("-m");
      const pIdx = args.indexOf("-p");
      expect(mIdx).toBeGreaterThanOrEqual(0);
      expect(args[mIdx + 1]).toBe("gemini-2.5-pro");
      expect(pIdx).toBeGreaterThan(mIdx);
      expect(args[pIdx + 1]).toBe(PROMPT);
    });

    test("default model uses just -p prompt", () => {
      const args = buildCliArgs({
        cli: "gemini",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      const pIdx = args.indexOf("-p");
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(args[pIdx + 1]).toBe(PROMPT);
    });
  });
});

describe("detectClis", () => {
  test("returns an array (length depends on installed CLIs)", () => {
    const clis = detectClis();
    expect(Array.isArray(clis)).toBe(true);
    for (const c of clis) {
      expect(["claude", "codex", "gemini"]).toContain(c.kind);
      expect(c.bin).toMatch(/\//);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});
