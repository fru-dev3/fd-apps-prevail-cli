// Guards for the hand-maintained model catalogs (cli-bridge.ts) and the two
// price tables. No CLI exposes a "list models" endpoint, so these lists go
// stale silently, and a stale DEFAULT is the expensive failure: every council
// panelist on that CLI errors out until someone notices. In Sep 2026 the codex
// default was still gpt-5.4, retired 2026-08-31.

import { describe, expect, test } from "bun:test";
import {
  CLI_DEFAULT_MODELS,
  MODEL_QUICKPICKS_FALLBACK,
  OPENROUTER_MODELS,
  defaultModelFor,
} from "./cli-bridge.ts";
import { rateFor } from "./usage.ts";
import { priceFor } from "./model-pricing.ts";

// Ids retired by their vendor, or dropped from a CLI's catalog.
const RETIRED = [
  "gpt-5.4", "gpt-5.4-mini", "gpt-5-codex", "gpt-5.2", "gpt-5.3-codex", "o3", "o4-mini",
  "claude-opus-4-1", "claude-opus-4-7", "claude-sonnet-4-7", "claude-sonnet-4-5",
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash",
  "Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (Low)",
];

describe("model catalogs", () => {
  test("no quickpick list offers a retired model", () => {
    const offenders: string[] = [];
    for (const [cli, models] of Object.entries(MODEL_QUICKPICKS_FALLBACK)) {
      for (const m of models) if (RETIRED.includes(m)) offenders.push(`${cli}:${m}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every CLI's default model is one of its own quickpicks", () => {
    for (const [cli, models] of Object.entries(MODEL_QUICKPICKS_FALLBACK)) {
      const def = CLI_DEFAULT_MODELS[cli as keyof typeof CLI_DEFAULT_MODELS];
      // Extra CLI families deliberately default to "" (the runtime's own default).
      if (!def || models.length === 0) continue;
      expect(models).toContain(def);
    }
  });

  test("the subscription CLIs default to a current model", () => {
    expect(defaultModelFor("claude")).toBe("claude-opus-5");
    expect(defaultModelFor("codex")).toBe("gpt-5.6-sol");
    expect(defaultModelFor("antigravity")).toBe("Gemini 3.8 Flash (High)");
  });

  test("claude quickpicks carry the fable tier", () => {
    expect(MODEL_QUICKPICKS_FALLBACK.claude).toContain("fable");
    expect(MODEL_QUICKPICKS_FALLBACK.claude).toContain("claude-fable-5-1");
    expect(MODEL_QUICKPICKS_FALLBACK.claude).toContain("claude-sonnet-5");
  });

  test("codex quickpicks carry GPT-6 Astra", () => {
    expect(MODEL_QUICKPICKS_FALLBACK.codex).toContain("gpt-6-astra");
  });

  test("openrouter ids keep the vendor/model shape", () => {
    for (const id of OPENROUTER_MODELS) expect(id).toMatch(/^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/);
  });
});

describe("pricing", () => {
  // Both tables are substring/regex matchers, so a new model name can silently
  // fall through to a wrong rule (or to null).
  test("usage.ts prices the current models", () => {
    expect(rateFor("claude", "claude-fable-5-1")).toEqual({ inUsdPerMtok: 10, outUsdPerMtok: 50 });
    expect(rateFor("claude", "claude-opus-5")).toEqual({ inUsdPerMtok: 5, outUsdPerMtok: 25 });
    expect(rateFor("claude", "claude-sonnet-5")).toEqual({ inUsdPerMtok: 2, outUsdPerMtok: 10 });
    expect(rateFor("claude", "claude-haiku-4-5")).toEqual({ inUsdPerMtok: 1, outUsdPerMtok: 5 });
    // "codex" is in the haystack for every Codex model, so model-specific rules
    // must win over the generic codex rule.
    expect(rateFor("codex", "gpt-6-astra")).toEqual({ inUsdPerMtok: 10, outUsdPerMtok: 50 });
    expect(rateFor("codex", "gpt-5.6-luna")).toEqual({ inUsdPerMtok: 0.2, outUsdPerMtok: 1.2 });
    expect(rateFor("antigravity", "Gemini 3.8 Flash (High)")).toEqual({ inUsdPerMtok: 0.75, outUsdPerMtok: 3.75 });
    expect(rateFor("ollama", "llama3.1")).toEqual({ inUsdPerMtok: 0, outUsdPerMtok: 0 });
  });

  test("model-pricing.ts prices the current models (3D Arena)", () => {
    expect(priceFor("claude", "claude-fable-5-1")).toMatchObject({ inUsd: 10, outUsd: 50 });
    expect(priceFor("claude", "claude-opus-5")).toMatchObject({ inUsd: 5, outUsd: 25 });
    expect(priceFor("codex", "gpt-6-astra")).toMatchObject({ inUsd: 10, outUsd: 50 });
    expect(priceFor("codex", "gpt-5.6-sol")).toMatchObject({ inUsd: 2, outUsd: 10 });
    expect(priceFor("antigravity", "Gemini 3.8 Flash (High)")).toMatchObject({ inUsd: 0.75, outUsd: 3.75 });
    expect(priceFor("ollama", "llama3.1")).toMatchObject({ source: "local" });
  });
});
