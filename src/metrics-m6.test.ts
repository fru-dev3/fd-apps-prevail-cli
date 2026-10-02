// Metrics M6: family metrics with consent per person (a member's numbers are
// logged and shown only while they share them, and never count in the
// owner's own metrics) and metric packs per vertical. Invented people only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addFamilyMetric, familyMetrics, sayMetric } from "./metrics-family.ts";
import { addMember, setConsent } from "./household.ts";
import { computeMetrics, series } from "./metrics.ts";
import { installPack } from "./packs.ts";

const ROOT = join("/tmp", `prevail-m6-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const NOW = Date.parse("2026-10-08T12:00:00Z");
beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general", "memory"), { recursive: true });
  writeFileSync(join(V, "data", "domains", "general", "manifest.json"), "{}");
});

describe("family metrics", () => {
  test("a member's numbers need their yes, show only while shared, and never count as the owner's", async () => {
    const id = await addFamilyMetric(V, { title: "Dinners together" });
    addMember(V, { name: "Ada Foo" });
    await sayMetric(V, id, 3, { now: NOW });
    await expect(sayMetric(V, id, 4, { now: NOW, member: "ada-foo" })).rejects.toThrow(/share them/);
    setConsent(V, "ada-foo", "metrics", true, { confirm: "Ada Foo" });
    await sayMetric(V, id, 4, { now: NOW, member: "ada-foo" });
    let f = await familyMetrics(V, NOW);
    expect(f[0]!.people.map((p) => [p.name, p.shared, p.weeks.at(-1)!.value])).toEqual([["You", true, 3], ["Ada Foo", true, 4]]);
    // The owner's own series has only their 3.
    const c = await computeMetrics(V, { now: NOW });
    expect(series(c, id, "week", 2).at(-1)!.value).toBe(3);
    setConsent(V, "ada-foo", "metrics", false);
    f = await familyMetrics(V, NOW);
    expect(f[0]!.people[1]).toMatchObject({ name: "Ada Foo", shared: false, weeks: [] });
    await expect(sayMetric(V, id, 2, { now: NOW, member: "ada-foo" })).rejects.toThrow(/share them/);
  });
  test("only family metrics take a member's number", async () => {
    await installPack(V, "consultants", { only: "metrics" });
    addMember(V, { name: "Bo Bar" });
    setConsent(V, "bo-bar", "metrics", true, { confirm: "Bo Bar" });
    await expect(sayMetric(V, "m-billable-hours", 5, { member: "bo-bar" })).rejects.toThrow(/not a family metric/);
    expect((await sayMetric(V, "m-billable-hours", 12, { now: NOW })).kind).toBe("stated.billable-hours");
    expect(readFileSync(join(V, "build", "metrics.md"), "utf8")).toContain("ask: How many billable hours this week?");
  });
});
