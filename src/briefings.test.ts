import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBriefings,
  saveBriefings,
  makeBriefingId,
  type BriefingEntry,
} from "./briefings.ts";

function makeFakeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "prevail-briefing-"));
  // One domain with the minimum shape scanVault expects.
  const wealth = join(dir, "wealth");
  mkdirSync(wealth, { recursive: true });
  writeFileSync(join(wealth, "state.md"), "# Wealth\n");
  return dir;
}

describe("briefings persistence", () => {
  test("loadBriefings returns [] for fresh vault", () => {
    const dir = makeFakeVault();
    expect(loadBriefings(dir)).toEqual([]);
  });

  test("save+load round-trip", () => {
    const dir = makeFakeVault();
    const entry: BriefingEntry = {
      id: makeBriefingId(),
      name: "wealth daily",
      cron: "0 7 * * *",
      domain: "wealth",
      prompt: "what's new this week?",
      mode: "council",
      deliver: "both",
      enabled: true,
      last_run: null,
      created_at: Date.now(),
    };
    saveBriefings(dir, [entry]);
    expect(existsSync(join(dir, ".briefings.json"))).toBe(true);
    const round = loadBriefings(dir);
    expect(round.length).toBe(1);
    expect(round[0]!.id).toBe(entry.id);
    expect(round[0]!.mode).toBe("council");
    expect(round[0]!.deliver).toBe("both");
  });

  test("malformed .briefings.json yields [] not a crash", () => {
    const dir = makeFakeVault();
    writeFileSync(join(dir, ".briefings.json"), "{not valid json");
    expect(loadBriefings(dir)).toEqual([]);
  });
});
