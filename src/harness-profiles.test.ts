import { test, expect } from "bun:test";
import { buildHarnessArgs, isHarness } from "./harness-profiles.ts";

test("hermes uses -z (not -p) and maps autonomy to its own switch", () => {
  const safe = buildHarnessArgs("hermes", { prompt: "do the thing", model: "", autonomy: "safe" });
  expect(safe).toEqual(["--safe-mode", "-z", "do the thing"]);
  const auto = buildHarnessArgs("hermes", { prompt: "do the thing", model: "sonnet", autonomy: "auto" });
  expect(auto).toEqual(["-m", "sonnet", "--yolo", "-z", "do the thing"]);
});

test("pi uses -p with --model and the prompt last", () => {
  expect(buildHarnessArgs("pi", { prompt: "hello", model: "", autonomy: "safe" })).toEqual(["-p", "hello"]);
  expect(buildHarnessArgs("pi", { prompt: "hello", model: "google/gemini", autonomy: "safe" }))
    .toEqual(["-p", "--model", "google/gemini", "hello"]);
});

test("opencode uses the `run` subcommand", () => {
  expect(buildHarnessArgs("opencode", { prompt: "fix bug", model: "", autonomy: "auto" })).toEqual(["run", "fix bug"]);
});

test("openclaw uses the best-effort -p convention (claude-protocol gateway)", () => {
  expect(buildHarnessArgs("openclaw", { prompt: "x", model: "", autonomy: "safe" })).toEqual(["-p", "x"]);
});

test("profileless kind returns null (caller falls back to generic convention)", () => {
  expect(buildHarnessArgs("cursor", { prompt: "x", model: "", autonomy: "safe" })).toBeNull();
  expect(isHarness("hermes")).toBe(true);
  expect(isHarness("claude")).toBe(false);
});
