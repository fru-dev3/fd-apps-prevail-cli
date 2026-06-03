import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeMeta,
  decodeMeta,
  defaultRetroDue,
  listPendingRetrospectives,
  recordOutcome,
  computeCalibration,
  writeCalibrationReport,
} from "./calibration.ts";

function makeFakeDomain(): string {
  const dir = mkdtempSync(join(tmpdir(), "calib-"));
  mkdirSync(join(dir, "_log"), { recursive: true });
  return dir;
}

describe("encodeMeta / decodeMeta round-trip", () => {
  test("preserves every field", () => {
    const m = {
      id: "20260603-1432",
      gut: "prepay — feels safer",
      verdict: "Invest if 6mo liquidity",
      retroDue: "2026-09-01",
      outcome: "right",
    };
    const encoded = encodeMeta(m);
    const decoded = decodeMeta(encoded);
    expect(decoded?.id).toBe(m.id);
    expect(decoded?.gut).toBe(m.gut);
    expect(decoded?.verdict).toBe(m.verdict);
    expect(decoded?.retroDue).toBe(m.retroDue);
    expect(decoded?.outcome).toBe(m.outcome);
  });

  test("strips pipes from values so the format stays parseable", () => {
    const m = { id: "x", gut: "first | second | third" };
    const round = decodeMeta(encodeMeta(m));
    expect(round?.gut).not.toContain("|");
  });

  test("non-meta line returns null", () => {
    expect(decodeMeta("just a regular markdown line")).toBeNull();
    expect(decodeMeta("<!-- some other comment -->")).toBeNull();
  });
});

describe("listPendingRetrospectives", () => {
  test("returns entries past their retro_due with no outcome", () => {
    const dir = makeFakeDomain();
    const oldDate = "2026-01-01";
    const futureDate = "2027-01-01";
    writeFileSync(
      join(dir, "_log", "2026-01-01.md"),
      [
        "# 2026-01-01",
        "## 09:00  ·  ⚖ council",
        encodeMeta({ id: "20260101-0900", gut: "go", verdict: "go", retroDue: oldDate }),
        "**Q:** test 1",
        "**A:** test 1",
        "",
        "## 10:00  ·  ⚖ council",
        encodeMeta({ id: "20260101-1000", gut: "stop", verdict: "stop", retroDue: oldDate, outcome: "right" }),
        "**Q:** test 2 (already has outcome)",
        "",
        "## 11:00  ·  ⚖ council",
        encodeMeta({ id: "20260101-1100", gut: "wait", verdict: "wait", retroDue: futureDate }),
        "**Q:** test 3 (not due yet)",
      ].join("\n"),
    );
    const pending = listPendingRetrospectives(dir);
    const ids = pending.map((p) => p.id);
    expect(ids).toContain("20260101-0900");
    expect(ids).not.toContain("20260101-1000"); // already has outcome
    expect(ids).not.toContain("20260101-1100"); // future
  });
});

describe("recordOutcome", () => {
  test("updates the meta line in place", () => {
    const dir = makeFakeDomain();
    const f = join(dir, "_log", "2026-01-01.md");
    writeFileSync(
      f,
      [
        "# 2026-01-01",
        "## 09:00  ·  ⚖ council",
        encodeMeta({ id: "20260101-0900", gut: "go", verdict: "go", retroDue: "2026-01-01" }),
        "**Q:** test",
      ].join("\n"),
    );
    expect(recordOutcome(dir, "20260101-0900", "right")).toBe(true);
    const after = readFileSync(f, "utf8");
    expect(after).toContain("outcome=right");
  });

  test("returns false when id isn't found", () => {
    const dir = makeFakeDomain();
    writeFileSync(join(dir, "_log", "2026-01-01.md"), "# 2026-01-01\n");
    expect(recordOutcome(dir, "nope", "right")).toBe(false);
  });
});

describe("computeCalibration + writeCalibrationReport", () => {
  test("counts agreements and right calls; writes _calibration.md", () => {
    const dir = makeFakeDomain();
    writeFileSync(
      join(dir, "_log", "2026-01-01.md"),
      [
        "# 2026-01-01",
        // agreed + right
        "## 09:00  ·  ⚖ council",
        encodeMeta({ id: "a", gut: "invest now", verdict: "invest now is correct", retroDue: "2026-01-01", outcome: "right" }),
        // disagreed + right (gut won)
        "## 10:00  ·  ⚖ council",
        encodeMeta({ id: "b", gut: "wait three months", verdict: "buy immediately", retroDue: "2026-01-01", outcome: "right" }),
        // agreed + wrong
        "## 11:00  ·  ⚖ council",
        encodeMeta({ id: "c", gut: "sell soon", verdict: "sell soon", retroDue: "2026-01-01", outcome: "wrong" }),
      ].join("\n"),
    );
    const stats = computeCalibration(dir);
    expect(stats.total).toBe(3);
    expect(stats.agreed).toBe(2); // a, c
    expect(stats.rightOnAgreement).toBe(1); // a
    expect(stats.rightOnDisagreement).toBe(1); // b
    writeCalibrationReport(dir);
    const report = readFileSync(join(dir, "_calibration.md"), "utf8");
    expect(report).toContain("Calibration");
    expect(report).toContain("decisions with outcome");
  });
});

describe("defaultRetroDue", () => {
  test("returns a YYYY-MM-DD ~90 days out", () => {
    const due = defaultRetroDue(Date.parse("2026-01-01T00:00:00Z"));
    expect(due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(due).toBe("2026-04-01");
  });
});
