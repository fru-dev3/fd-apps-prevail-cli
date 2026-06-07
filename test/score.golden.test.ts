import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContextScore } from "../src/score.ts";

// Golden test: build a tiny, fully-specified fixture domain under /tmp and
// assert that computeContextScore's DETERMINISTIC dimensions are stable.
//
// Determinism notes:
//   - coverage, density, structure, activity, config_completeness depend ONLY
//     on which files exist and their content — fully reproducible.
//   - freshness depends on file mtime (wall-clock). The fixture is written
//     fresh in beforeAll, so all files are < 7 days old and freshness === 100
//     by the rubric (score.ts scoreFreshness: ageDays <= 7 => 100). We assert
//     it === 100 rather than pinning freshness_secs (which is nonzero/varying).
//
// If any deterministic dimension here drifts, the scoring contract changed and
// this golden must be re-blessed alongside a schema-version bump.

let vaultPath: string;
const DOMAIN = "fixture";

beforeAll(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "prevail-golden-vault-"));
  const dir = join(vaultPath, DOMAIN);
  mkdirSync(dir, { recursive: true });

  // state.md — exactly 10 words.
  writeFileSync(
    join(dir, "state.md"),
    "# State\n\none two three four five six seven eight nine ten\n",
  );

  // config.md — 4 key:value fields, 2 filled, 2 empty/placeholder.
  // -> config_completeness = 2/4 = 50.
  writeFileSync(
    join(dir, "config.md"),
    [
      "# Config",
      "owner: Fru",
      "region: MN",
      "advisor:",
      "broker: (none)",
      "",
    ].join("\n"),
  );

  // one _log session -> activity logs ratio = 1/10.
  mkdirSync(join(dir, "_log"), { recursive: true });
  writeFileSync(join(dir, "_log", "2026-01-01.md"), "# Log\nentry\n");

  // (intentionally NO decisions.md, NO _journal, NO _threads, NO skills,
  //  NO briefs/prior/current) — pins coverage/structure to known values.
});

afterAll(() => {
  if (vaultPath) rmSync(vaultPath, { recursive: true, force: true });
});

describe("score golden", () => {
  test("deterministic dimensions are stable for the fixture domain", () => {
    const sc = computeContextScore(vaultPath, DOMAIN);

    expect(sc.domain).toBe(DOMAIN);

    // Six fixed dimensions, in frozen order.
    expect(Object.keys(sc.breakdown)).toEqual([
      "coverage",
      "density",
      "freshness",
      "structure",
      "activity",
      "config_completeness",
    ]);

    // coverage: state.md + config.md + _log/*.md present (3 of 5) -> 60.
    expect(sc.breakdown.coverage.score).toBe(60);

    // density: 10 (state) + 0 (decisions) + ~6 (config words) words.
    //   config.md tokens: "#","Config","owner:","Fru","region:","MN",
    //   "advisor:","broker:","(none)" => 9 words. state => 12 words incl "# State".
    //   We assert the exact computed value rather than re-deriving by hand.
    const words = 12 + 0 + 9; // state words + decisions + config words
    expect(sc.breakdown.density.score).toBe(
      Math.min(100, Math.round((100 * words) / 800)),
    );

    // freshness: fixture just written -> within 7 days -> 100.
    expect(sc.breakdown.freshness.score).toBe(100);

    // structure: state, config, logs present (3 of 10 artifact kinds) -> 30.
    expect(sc.breakdown.structure.score).toBe(30);

    // activity: 1 log, 0 threads -> 100 * (0.5*0.1 + 0.5*0) = 5.
    expect(sc.breakdown.activity.score).toBe(5);

    // config_completeness: 2 of 4 fields filled -> 50.
    expect(sc.breakdown.config_completeness.score).toBe(50);

    // Headline score is the weighted roll-up of the above. Recompute from the
    // dims so the golden also pins the rubric weights.
    const W = {
      coverage: 25,
      density: 20,
      freshness: 20,
      structure: 15,
      activity: 10,
      config_completeness: 10,
    };
    const expected = Math.round(
      (sc.breakdown.coverage.score * W.coverage +
        sc.breakdown.density.score * W.density +
        sc.breakdown.freshness.score * W.freshness +
        sc.breakdown.structure.score * W.structure +
        sc.breakdown.activity.score * W.activity +
        sc.breakdown.config_completeness.score * W.config_completeness) /
        100,
    );
    expect(sc.score).toBe(expected);
    expect(sc.score).toBeGreaterThanOrEqual(0);
    expect(sc.score).toBeLessThanOrEqual(100);

    // Running twice yields identical deterministic dimensions (excluding the
    // wall-clock fields computed_at / freshness_secs).
    const sc2 = computeContextScore(vaultPath, DOMAIN);
    expect(sc2.breakdown).toEqual(sc.breakdown);
    expect(sc2.score).toBe(sc.score);
  });
});
