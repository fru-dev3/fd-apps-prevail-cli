import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DIRECT_PROVIDERS,
  DIRECT_PROVIDER_BY_ID,
  CLI_DEFAULT_MODELS,
  MODEL_QUICKPICKS_FALLBACK,
  CLI_MODEL_HINT,
  detectClis,
} from "./cli-bridge.ts";

// Snapshot + restore the provider key envs so detection tests don't leak.
const ENVS = DIRECT_PROVIDERS.map((p) => p.keyEnv);
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const e of ENVS) { saved[e] = process.env[e]; delete process.env[e]; }
});
afterEach(() => {
  for (const e of ENVS) {
    if (saved[e] === undefined) delete process.env[e];
    else process.env[e] = saved[e];
  }
});

describe("G1 direct providers", () => {
  test("the founder's named vendors are all present", () => {
    const ids: string[] = DIRECT_PROVIDERS.map((p) => p.id);
    for (const want of ["anthropic", "openai", "xai", "kimi", "deepseek", "google"]) {
      expect(ids).toContain(want);
    }
  });

  test("only Anthropic is native; the rest are OpenAI-compatible", () => {
    expect(DIRECT_PROVIDER_BY_ID.anthropic.native).toBe(true);
    for (const id of ["openai", "xai", "kimi", "deepseek", "google"] as const) {
      expect(DIRECT_PROVIDER_BY_ID[id].native).toBeFalsy();
    }
  });

  test("every provider has a default model, quickpicks, and a hint", () => {
    for (const p of DIRECT_PROVIDERS) {
      expect(CLI_DEFAULT_MODELS[p.id]).toBe(p.models[0]!);
      expect(MODEL_QUICKPICKS_FALLBACK[p.id]).toEqual(p.models);
      expect(typeof CLI_MODEL_HINT[p.id]).toBe("string");
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  test("key env names use the PREVAIL_ prefix (survives the engine env scrub)", () => {
    for (const p of DIRECT_PROVIDERS) {
      expect(p.keyEnv.startsWith("PREVAIL_")).toBe(true);
    }
  });

  test("a provider becomes available exactly when its key env is set", async () => {
    // detectClis() returns only installed/keyed providers, so presence == available.
    let list = await detectClis({ force: true });
    expect(list.some((c) => c.kind === "anthropic")).toBe(false);
    process.env.PREVAIL_ANTHROPIC_KEY = "sk-ant-test";
    list = await detectClis({ force: true });
    const a = list.find((c) => c.kind === "anthropic");
    expect(a).toBeDefined();
    expect(a?.label).toBe("Anthropic");
    expect(a?.bin).toBe("https://api.anthropic.com/v1");
    // A different provider with no key stays hidden.
    expect(list.some((c) => c.kind === "xai")).toBe(false);
  });
});
