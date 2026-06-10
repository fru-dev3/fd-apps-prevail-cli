import { describe, expect, test } from "bun:test";
import { discoverModels } from "./models.ts";

describe("model discovery", () => {
  test("subscription CLIs have no list API → empty (desktop uses curated)", async () => {
    expect(await discoverModels("claude")).toEqual([]);
    expect(await discoverModels("codex")).toEqual([]);
    expect(await discoverModels("antigravity")).toEqual([]);
  });

  test("unknown provider → empty, never throws", async () => {
    expect(await discoverModels("nope-xyz")).toEqual([]);
  });

  // ollama/lmstudio/openrouter hit live endpoints; not asserted here to keep the
  // suite network-independent. Each is wrapped in try/catch and returns [] on
  // failure, so a discovery call is always safe.
});
