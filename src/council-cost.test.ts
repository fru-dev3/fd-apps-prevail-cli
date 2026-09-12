import { describe, expect, test } from "bun:test";
import { estimateCouncilCost, formatCostLine } from "./council-cost.ts";

describe("estimateCouncilCost", () => {
  test("4 panelists, lens off → 5 calls (4 panel + chair)", () => {
    const est = estimateCouncilCost({
      panelists: [
        { cliKind: "claude", model: "" },
        { cliKind: "codex", model: "" },
        { cliKind: "gemini", model: "" },
        { cliKind: "ollama", model: "" },
      ],
      lensCount: 1,
      promptChars: 200,
    });
    expect(est.panelistCount).toBe(4);
    expect(est.lensCount).toBe(1);
    expect(est.totalCalls).toBe(5);
    // Per call = model-pricing default tier × 1000 in / 500 out tokens:
    // claude (Opus 5, $5/$25) 0.0175 + codex (Sol, $2/$10) 0.007
    //   + gemini ($1.25/$5) 0.00375 + ollama 0 + chair 0.0175
    expect(est.estCostUsd).toBeCloseTo(0.04575, 6);
    expect(est.perCli.claude).toBeCloseTo(0.0175, 6);
    expect(est.perCli.codex).toBeCloseTo(0.007, 6);
    expect(est.perCli.gemini).toBeCloseTo(0.00375, 6);
    expect(est.perCli.ollama).toBe(0);
  });

  test("4 panelists, lens=all (count 8) → 33 calls (32 panel + chair)", () => {
    const est = estimateCouncilCost({
      panelists: [
        { cliKind: "claude", model: "" },
        { cliKind: "codex", model: "" },
        { cliKind: "gemini", model: "" },
        { cliKind: "ollama", model: "" },
      ],
      lensCount: 8,
      promptChars: 200,
    });
    expect(est.panelistCount).toBe(4);
    expect(est.lensCount).toBe(8);
    expect(est.totalCalls).toBe(33);
    // (0.0175 + 0.007 + 0.00375 + 0) × 8 = 0.226; + chair 0.0175 = 0.2435
    expect(est.estCostUsd).toBeCloseTo(0.2435, 6);
    expect(est.perCli.claude).toBeCloseTo(0.14, 6);
    expect(est.perCli.codex).toBeCloseTo(0.056, 6);
    expect(est.perCli.gemini).toBeCloseTo(0.03, 6);
    expect(est.perCli.ollama).toBe(0);
  });

  test("ollama-only panelists contribute $0 to panel spend (chair-only cost)", () => {
    const est = estimateCouncilCost({
      panelists: [
        { cliKind: "ollama", model: "llama3" },
        { cliKind: "ollama", model: "mistral" },
        { cliKind: "ollama", model: "phi3" },
      ],
      lensCount: 1,
      promptChars: 100,
    });
    expect(est.totalCalls).toBe(4);
    // Ollama contributes 0, only the chair call costs anything.
    expect(est.perCli.ollama).toBe(0);
    expect(est.estCostUsd).toBeCloseTo(0.0175, 6);
  });

  test("mixed council with lens count 3: claude + codex + ollama", () => {
    const est = estimateCouncilCost({
      panelists: [
        { cliKind: "claude", model: "opus-4-7" },
        { cliKind: "codex", model: "gpt-5.4" },
        { cliKind: "ollama", model: "llama3" },
      ],
      lensCount: 3,
      promptChars: 150,
    });
    // 3 panelists × 3 lenses = 9 panel calls + chair = 10
    expect(est.totalCalls).toBe(10);
    // Priced on the named model: opus ($5/$25) 0.0175×3 + gpt-5.4 ($1.25/$10)
    // 0.00625×3 + ollama 0×3 + chair 0.0175 = 0.0525 + 0.01875 + 0 + 0.0175
    expect(est.estCostUsd).toBeCloseTo(0.08875, 6);
    expect(est.perCli.claude).toBeCloseTo(0.0525, 6);
    expect(est.perCli.codex).toBeCloseTo(0.01875, 6);
    expect(est.perCli.ollama).toBe(0);
  });

  test("frontier tiers are priced from model-pricing: Fable and GPT-6", () => {
    const est = estimateCouncilCost({
      panelists: [
        { cliKind: "claude", model: "claude-fable-5-1" },
        { cliKind: "codex", model: "gpt-6" },
      ],
      lensCount: 1,
      promptChars: 50,
    });
    // Both $10/$50: 0.01 + 0.025 = 0.035 per call; + chair 0.0175
    expect(est.perCli.claude).toBeCloseTo(0.035, 6);
    expect(est.perCli.codex).toBeCloseTo(0.035, 6);
    expect(est.estCostUsd).toBeCloseTo(0.0875, 6);
  });

  test("unknown cli kind falls back to default per-call cost", () => {
    const est = estimateCouncilCost({
      panelists: [{ cliKind: "mystery-cli", model: "x" }],
      lensCount: 1,
      promptChars: 50,
    });
    // unknown ($5/$15 global default): 0.0125 + chair 0.0175 = 0.03
    expect(est.estCostUsd).toBeCloseTo(0.03, 6);
    expect(est.totalCalls).toBe(2);
  });

  test("lensCount of 0 is normalized to 1 (no lens active)", () => {
    const est = estimateCouncilCost({
      panelists: [{ cliKind: "claude", model: "" }],
      lensCount: 0,
      promptChars: 10,
    });
    expect(est.lensCount).toBe(1);
    expect(est.totalCalls).toBe(2);
  });
});

describe("formatCostLine", () => {
  test("produces the canonical one-line format with 2-decimal dollars", () => {
    const line = formatCostLine({
      panelistCount: 4,
      lensCount: 1,
      totalCalls: 5,
      estCostUsd: 0.017,
      perCli: {},
    });
    expect(line).toBe(
      "estimated cost: ~$0.02 for 5 calls (rough — actual depends on response length)",
    );
  });
});
