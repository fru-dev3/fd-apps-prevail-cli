import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { activityFile, logActivity } from "./activity.ts";

const V = join("/tmp", `prevail-activity-${process.pid}`);
afterAll(() => rmSync(V, { recursive: true, force: true }));

test("each machine appends only its own activity stream", () => {
  mkdirSync(join(V, "build"), { recursive: true });
  process.env.PREVAIL_HOST_SLUG = "foo-hub";
  logActivity(V, { type: "loop_run", title: "Ran the foo loop", domain: "health" });
  delete process.env.PREVAIL_HOST_SLUG;
  const f = join(V, "build", "_meta", "activity.foo-hub.jsonl");
  expect(existsSync(f)).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf8").trim()).title).toBe("Ran the foo loop");
  expect(existsSync(join(V, "build", "_meta", "activity.jsonl"))).toBe(false);
  expect(activityFile(V)).toContain("activity.");
});
