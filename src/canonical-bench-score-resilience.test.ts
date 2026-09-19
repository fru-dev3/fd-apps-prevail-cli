// Arena scoring resilience.
//
// The defect these lock down: a benchmark batch would finish, the answers were
// paid for in real tokens, and the runs still showed as unscored - permanently.
// A run whose judge produced nothing still got a score.json written, and the
// "has a score.json" check then skipped it on every later attempt, so no amount
// of re-scoring could ever recover it.
import { describe, expect, test } from "bun:test";
import { needsScoring } from "./canonical-bench.ts";

const scored = (judge_avg: number | null) => JSON.stringify({ judge_avg, keyword_avg: 27.8 });

describe("needsScoring", () => {
  test("a run that was never scored is scored", () => {
    expect(needsScoring({ hasScoreFile: false, hasJudge: true })).toBe(true);
    expect(needsScoring({ hasScoreFile: false, hasJudge: false })).toBe(true);
  });

  test("a fully judged run is left alone", () => {
    expect(needsScoring({ hasScoreFile: true, scoreJson: scored(7.2), hasJudge: true })).toBe(false);
  });

  test("a judge_avg of 0 is a real score, not a missing one", () => {
    // 0 is falsy. Checking truthiness here would re-judge every model that
    // genuinely scored zero, burning tokens forever on the worst performers.
    expect(needsScoring({ hasScoreFile: true, scoreJson: scored(0), hasJudge: true })).toBe(false);
  });

  test("a run whose judge produced nothing is picked back up", () => {
    // The regression. This is the state 52 of Fru's 56 runs were stuck in.
    expect(needsScoring({ hasScoreFile: true, scoreJson: scored(null), hasJudge: true })).toBe(true);
  });

  test("but not when there is still no judge to run", () => {
    // Without a judge, re-scoring it would only redo the keyword pass and
    // leave judge_avg null again. Nothing to gain, so skip it.
    expect(needsScoring({ hasScoreFile: true, scoreJson: scored(null), hasJudge: false })).toBe(false);
  });

  test("an unreadable score.json is not treated as a score", () => {
    expect(needsScoring({ hasScoreFile: true, scoreJson: "{tru", hasJudge: true })).toBe(true);
    expect(needsScoring({ hasScoreFile: true, scoreJson: null, hasJudge: true })).toBe(true);
  });

  test("--rescore overrides every other consideration", () => {
    expect(needsScoring({ hasScoreFile: true, scoreJson: scored(9.1), rescore: true, hasJudge: true })).toBe(true);
    expect(needsScoring({ hasScoreFile: true, scoreJson: scored(9.1), rescore: true, hasJudge: false })).toBe(true);
  });
});
