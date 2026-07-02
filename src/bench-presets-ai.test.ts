import { describe, expect, test } from "bun:test";
import { buildPresetPrompt, extractPresetJson, groundPresets, PRESET_CATEGORIES, type AvailableModel } from "./bench-presets-ai.ts";

const MODELS: AvailableModel[] = [
  { key: "claude::opus", label: "Claude Opus 4.8", provider: "claude", validated: true, local: false, tier: "flagship" },
  { key: "claude::sonnet", label: "Claude Sonnet 4.7", provider: "claude", validated: true, local: false, tier: "mid" },
  { key: "openai::gpt-5", label: "GPT-5", provider: "openai", validated: true, local: false, tier: "flagship" },
  { key: "gemini::flash", label: "Gemini Flash", provider: "gemini", validated: false, local: false, tier: "small" },
  { key: "ollama::llama3", label: "Llama 3 8B", provider: "ollama", validated: true, local: true, tier: "small" },
];

describe("buildPresetPrompt", () => {
  test("lists every available cli::model key and its tags", () => {
    const p = buildPresetPrompt(MODELS);
    for (const m of MODELS) expect(p).toContain(m.key);
    expect(p).toContain("claude");
    expect(p).toContain("local/open"); // ollama tagged local
    expect(p).toContain("validated");
    expect(p).toContain("unverified"); // gemini flash
  });
  test("names the canonical categories and the JSON shape", () => {
    const p = buildPresetPrompt(MODELS);
    expect(p).toContain(PRESET_CATEGORIES[0]);
    expect(p).toContain('{"presets":[{"name"');
  });
  test("contains no em dashes", () => {
    expect(buildPresetPrompt(MODELS)).not.toContain("—");
  });
});

describe("extractPresetJson", () => {
  test("parses a bare JSON object", () => {
    const v = extractPresetJson('{"presets":[{"name":"A","rationale":"r","models":["claude::opus"]}]}');
    expect(Array.isArray(v?.presets)).toBe(true);
    expect(v!.presets!.length).toBe(1);
  });
  test("tolerates markdown fences and preamble/trailing prose", () => {
    const raw = 'Here you go:\n```json\n{"presets":[{"name":"A","rationale":"r","models":["claude::opus"]}]}\n```\nHope that helps!';
    const v = extractPresetJson(raw);
    expect(v?.presets?.length).toBe(1);
  });
  test("returns null on non-JSON", () => {
    expect(extractPresetJson("no json here")).toBeNull();
  });
});

describe("groundPresets — unknown-key filtering", () => {
  test("drops hallucinated model keys, keeping only known ones", () => {
    const parsed = {
      presets: [
        { name: "Frontier", rationale: "best flagships", models: ["claude::opus", "openai::gpt-5", "acme::ultra-9000"] },
      ],
    };
    const out = groundPresets(parsed, MODELS);
    expect(out.length).toBe(1);
    expect(out[0]!.models).toEqual(["claude::opus", "openai::gpt-5"]);
    expect(out[0]!.models).not.toContain("acme::ultra-9000");
  });

  test("drops a preset that has fewer than 2 grounded models after filtering", () => {
    const parsed = {
      presets: [
        { name: "Bogus", rationale: "all fake", models: ["fake::a", "fake::b"] },
        { name: "OneReal", rationale: "single real", models: ["claude::opus", "nope::x"] },
        { name: "Good", rationale: "two real", models: ["claude::opus", "claude::sonnet"] },
      ],
    };
    const out = groundPresets(parsed, MODELS);
    expect(out.map((p) => p.name)).toEqual(["Good"]);
  });

  test("dedupes identical model sets and dedupes keys within a preset", () => {
    const parsed = {
      presets: [
        { name: "P1", rationale: "", models: ["claude::opus", "openai::gpt-5"] },
        { name: "P2", rationale: "", models: ["openai::gpt-5", "claude::opus"] }, // same set, different order
        { name: "P3", rationale: "", models: ["claude::opus", "claude::opus", "ollama::llama3"] }, // dupe key
      ],
    };
    const out = groundPresets(parsed, MODELS);
    expect(out.length).toBe(2); // P2 dropped as a duplicate set
    const p3 = out.find((p) => p.name === "P3");
    expect(p3?.models).toEqual(["claude::opus", "ollama::llama3"]);
  });

  test("caps a preset at max models and skips presets with no name", () => {
    const many = MODELS.map((m) => m.key);
    const parsed = {
      presets: [
        { name: "", rationale: "", models: many },
        { name: "Big", rationale: "", models: [...many, ...many] },
      ],
    };
    const out = groundPresets(parsed, MODELS, { max: 3 });
    expect(out.length).toBe(1);
    expect(out[0]!.models.length).toBe(3);
  });

  test("returns [] for null / missing presets array", () => {
    expect(groundPresets(null, MODELS)).toEqual([]);
    expect(groundPresets({}, MODELS)).toEqual([]);
  });
});
