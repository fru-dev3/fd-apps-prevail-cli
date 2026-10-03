// Metrics M6: a number logged by hand for an asked metric counts in the
// owner's series; anything else is refused. (Family metrics, household
// numbers and metric packs were removed by the owner, 2026-10-02.)
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sayMetric } from "./metrics-family.ts";
import { computeMetrics, series } from "./metrics.ts";
import { moveMetric } from "./metric-proposals.ts";

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

describe("asked metrics", () => {
  test("a number said by hand counts in the series; a measured metric takes none", async () => {
    moveMetric(V, "m-foo-hours", "tracking", { line: "- Foo hours ~id:m-foo-hours ~per:week ~unit:hours ~tier:asked ~src:stated ~kind:stated.foo-hours ~value:value" });
    expect((await sayMetric(V, "m-foo-hours", 12, { now: NOW })).kind).toBe("stated.foo-hours");
    const c = await computeMetrics(V, { now: NOW });
    expect(series(c, "m-foo-hours", "week", 2).at(-1)!.value).toBe(12);
    await expect(sayMetric(V, "m-nope", 1)).rejects.toThrow(/not a metric you log by hand/);
  });
});
