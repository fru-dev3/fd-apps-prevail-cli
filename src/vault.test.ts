import { describe, expect, test } from "bun:test";
import { coerceRefresh } from "./vault.ts";

// coerceRefresh is the single validator the engine uses for the manifest
// `refresh.every` cadence. It must accept the legacy hourly/Nh/daily/weekly
// forms AND the new multi-day (<N>d, 1..90) / multi-week (<N>w, 1..12) forms,
// while still rejecting anything out of range or malformed.
describe("coerceRefresh cadences", () => {
  test("legacy forms still validate", () => {
    expect(coerceRefresh({ every: "hourly" })?.every).toBe("hourly");
    expect(coerceRefresh({ every: "6h" })?.every).toBe("6h");
    expect(coerceRefresh({ every: "daily" })?.every).toBe("daily");
    expect(coerceRefresh({ every: "weekly" })?.every).toBe("weekly");
  });

  test("multi-day cadences (1..90) validate", () => {
    expect(coerceRefresh({ every: "1d" })?.every).toBe("1d");
    expect(coerceRefresh({ every: "2d" })?.every).toBe("2d"); // every other day
    expect(coerceRefresh({ every: "3d" })?.every).toBe("3d");
    expect(coerceRefresh({ every: "90d" })?.every).toBe("90d");
  });

  test("multi-week cadences (1..12) validate", () => {
    expect(coerceRefresh({ every: "1w" })?.every).toBe("1w");
    expect(coerceRefresh({ every: "2w" })?.every).toBe("2w"); // every two weeks
    expect(coerceRefresh({ every: "12w" })?.every).toBe("12w");
  });

  test("out-of-range / malformed cadences are rejected", () => {
    expect(coerceRefresh({ every: "0d" })).toBeUndefined();
    expect(coerceRefresh({ every: "91d" })).toBeUndefined();
    expect(coerceRefresh({ every: "0w" })).toBeUndefined();
    expect(coerceRefresh({ every: "13w" })).toBeUndefined();
    expect(coerceRefresh({ every: "1h" })).toBeUndefined(); // 1h excluded by design
    expect(coerceRefresh({ every: "monthly" })).toBeUndefined();
    expect(coerceRefresh({ every: "2x" })).toBeUndefined();
  });

  test("optional at/on still carry through with a new cadence", () => {
    const r = coerceRefresh({ every: "2d", at: "07:30", on: "fri" });
    expect(r?.every).toBe("2d");
    expect(r?.at).toBe("07:30");
    expect(r?.on).toBe("fri");
  });
});
