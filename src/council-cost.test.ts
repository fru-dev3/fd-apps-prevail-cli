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
    // claude 0.005 + codex 0.004 + gemini 0.003 + ollama 0 + chair 0.005
    expect(est.estCostUsd).toBeCloseTo(0.017, 6);
    expect(est.perCli.claude).toBeCloseTo(0.005, 6);
    expect(est.perCli.codex).toBeCloseTo(0.004, 6);
    expect(est.perCli.gemini).toBeCloseTo(0.003, 6);
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
    // (0.005 + 0.004 + 0.003 + 0) × 8 = 0.096; + chair 0.005 = 0.101
    expect(est.estCostUsd).toBeCloseTo(0.101, 6);
    expect(est.perCli.claude).toBeCloseTo(0.04, 6);
    expect(est.perCli.codex).toBeCloseTo(0.032, 6);
    expect(est.perCli.gemini).toBeCloseTo(0.024, 6);
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
    expect(est.estCostUsd).toBeCloseTo(0.005, 6);
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
    // claude 0.005×3 + codex 0.004×3 + ollama 0×3 + chair 0.005
    //   = 0.015 + 0.012 + 0 + 0.005 = 0.032
    expect(est.estCostUsd).toBeCloseTo(0.032, 6);
    expect(est.perCli.claude).toBeCloseTo(0.015, 6);
    expect(est.perCli.codex).toBeCloseTo(0.012, 6);
    expect(est.perCli.ollama).toBe(0);
  });

  test("unknown cli kind falls back to default per-call cost", () => {
    const est = estimateCouncilCost({
      panelists: [{ cliKind: "mystery-cli", model: "x" }],
      lensCount: 1,
      promptChars: 50,
    });
    // unknown: 0.005 + chair 0.005 = 0.010
    expect(est.estCostUsd).toBeCloseTo(0.01, 6);
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
