import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrateDomainToV4, v4Destination, isV4Domain } from "./vault-layout-v4.ts";

// Vaults created under homedir(): validateVaultPath forbids /var (macOS tmpdir).
function makeVault(): string {
  return mkdtempSync(join(homedir(), ".prevail-v4-test-"));
}

describe("v4Destination mapping", () => {
  test("routes each entry to source / memory / .system, root markers stay", () => {
    expect(v4Destination("manifest.json")).toBeNull();
    expect(v4Destination("soul.md")).toBe("ideal.md");         // soul -> ideal
    expect(v4Destination("ideal.md")).toBe("ideal.md");
    expect(v4Destination("goals.md")).toBe("source/goals.md");
    expect(v4Destination("PROMPTS.md")).toBe("source/starters.md");
    expect(v4Destination("01_prior")).toBe("source/files/01_prior");
    expect(v4Destination("_state.md")).toBe("memory/state.md");
    expect(v4Destination("MEMORY.md")).toBe("memory/memory.md");
    expect(v4Destination("_decisions.jsonl")).toBe("memory/decisions.jsonl");
    expect(v4Destination("_skills")).toBe("memory/skills");
    expect(v4Destination("skills")).toBe("memory/skills");     // both merge
    expect(v4Destination("_intents.jsonl")).toBe(".system/intents.jsonl");
    expect(v4Destination("_surface.json")).toBe(".system/surface.cache.json");
    expect(v4Destination("mystery.txt")).toBeNull();           // unknown stays put
  });
});

describe("migrateDomainToV4", () => {
  test("non-destructively copies into the three folders, merges skills, is idempotent", () => {
    const v = makeVault();
    const d = join(v, "data", "domains", "wealth");
    mkdirSync(join(d, "_skills", "wins"), { recursive: true });
    mkdirSync(join(d, "skills", "standup"), { recursive: true });
    writeFileSync(join(d, "_skills", "wins", "SKILL.md"), "a");
    writeFileSync(join(d, "skills", "standup", "SKILL.md"), "b");
    for (const [f, c] of [["soul.md", "why"], ["goals.md", "g"], ["PROMPTS.md", "p"], ["_state.md", "s"], ["_intents.jsonl", "{}"], ["manifest.json", "{}"]] as const) {
      writeFileSync(join(d, f), c);
    }

    // Dry run touches nothing.
    const dry = migrateDomainToV4(v, "wealth", false);
    expect(dry.applied).toBe(false);
    expect(isV4Domain(d)).toBe(false);
    expect(dry.skipped).toContain("manifest.json");

    // Apply.
    const res = migrateDomainToV4(v, "wealth", true);
    expect(res.applied).toBe(true);
    expect(isV4Domain(d)).toBe(true);
    expect(existsSync(join(d, "ideal.md"))).toBe(true);              // soul renamed
    expect(existsSync(join(d, "source", "goals.md"))).toBe(true);
    expect(existsSync(join(d, "source", "starters.md"))).toBe(true);
    expect(existsSync(join(d, "memory", "state.md"))).toBe(true);
    expect(existsSync(join(d, "memory", "skills", "wins", "SKILL.md"))).toBe(true);
    expect(existsSync(join(d, "memory", "skills", "standup", "SKILL.md"))).toBe(true); // merged
    expect(existsSync(join(d, ".system", "intents.jsonl"))).toBe(true);
    // Non-destructive: originals + root markers stay.
    expect(existsSync(join(d, "soul.md"))).toBe(true);
    expect(existsSync(join(d, "manifest.json"))).toBe(true);

    // Idempotent.
    expect(migrateDomainToV4(v, "wealth", false).alreadyMigrated).toBe(true);
    rmSync(v, { recursive: true, force: true });
  });
});
