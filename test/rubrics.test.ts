import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateRelevance, resolveRubricKey } from "../src/rubrics.ts";
import { computeContextScore } from "../src/score.ts";

describe("rubrics — domain resolution", () => {
  test("canonical and alias keys resolve", () => {
    expect(resolveRubricKey("health")).toBe("health");
    expect(resolveRubricKey("Health")).toBe("health");
    expect(resolveRubricKey("tax")).toBe("taxes"); // alias
    expect(resolveRubricKey("finance")).toBe("wealth"); // alias
    expect(resolveRubricKey("email")).toBe("mail"); // alias
  });
  test("unknown domains return null", () => {
    expect(resolveRubricKey("nutrition")).toBeNull();
    expect(resolveRubricKey("zzz-custom")).toBeNull();
  });
});

describe("rubrics — relevance evaluation", () => {
  let vaultPath: string;

  beforeAll(() => {
    vaultPath = mkdtempSync(join(tmpdir(), "prevail-rubric-vault-"));

    // A health domain that mentions several expected items in its state text.
    const health = join(vaultPath, "health");
    mkdirSync(join(health, "data"), { recursive: true });
    writeFileSync(
      join(health, "state.md"),
      [
        "# Health",
        "Insurance carrier: Blue Cross, member id 12345.",
        "Deductible: $2,000. Premium: $340/month.",
        "PCP: Dr. Smith. Medications: none currently.",
        "Allergies: penicillin.",
      ].join("\n"),
    );
    writeFileSync(join(health, "config.md"), "owner: Fru\n");

    // A custom domain with no rubric.
    const custom = join(vaultPath, "nutrition");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "state.md"), "# Nutrition\nEat well.\n");
  });

  afterAll(() => {
    if (vaultPath) rmSync(vaultPath, { recursive: true, force: true });
  });

  test("a matching domain produces a relevance block with detected items", () => {
    const rel = evaluateRelevance({
      domain: "health",
      dir: join(vaultPath, "health"),
      stateText:
        "Insurance carrier: Blue Cross, member id 12345. Deductible: $2,000. Premium: $340/month. PCP: Dr. Smith. Allergies: penicillin.",
      configText: "owner: Fru",
      textMtime: Date.now(),
    });
    expect(rel).not.toBeNull();
    expect(rel!.matched).toBe("health");
    expect(rel!.score).toBeGreaterThan(0);
    const byId = Object.fromEntries(rel!.items.map((i) => [i.id, i]));
    expect(byId.insurance_card.present).toBe(true);
    expect(byId.deductible.present).toBe(true);
    expect(byId.premium.present).toBe(true);
    expect(byId.allergies.present).toBe(true);
    // Every item carries a concrete recommendation for when it's missing.
    for (const it of rel!.items) expect(it.recommend.length).toBeGreaterThan(0);
  });

  test("a custom domain yields null relevance", () => {
    const rel = evaluateRelevance({
      domain: "nutrition",
      dir: join(vaultPath, "nutrition"),
      stateText: "Eat well.",
      configText: "",
      textMtime: Date.now(),
    });
    expect(rel).toBeNull();
  });

  test("computeContextScore blends relevance for known domains, leaves it null for custom", () => {
    const known = computeContextScore(vaultPath, "health");
    expect(known.relevance).not.toBeNull();
    expect(known.relevance!.matched).toBe("health");

    const custom = computeContextScore(vaultPath, "nutrition");
    expect(custom.relevance).toBeNull();
  });
});
