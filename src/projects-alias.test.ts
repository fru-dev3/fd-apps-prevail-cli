// Projects is the word the user sees (stored as missions): `prevail projects
// <sub>` runs every missions subcommand, prompt groups answer at
// `prevail prompt-groups` (and keep their own subcommands under projects).
// Invented data; the CLI runs against a scratch vault.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const V = join("/tmp", `prevail-projects-alias-${process.pid}`);
const run = (...a: string[]) => {
  const r = spawnSync(process.execPath, [join(import.meta.dir, "index.tsx"), "--vault", V, ...a, "--json"], { encoding: "utf8", env: { ...process.env, PREVAIL_VAULT_ROOT: V } });
  return JSON.parse(r.stdout.trim().split("\n").pop() || "null");
};
beforeAll(() => {
  for (const d of ["general", "hobbies"]) { mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true }); writeFileSync(join(V, "data", "domains", d, "manifest.json"), "{}"); }
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
});
afterAll(() => rmSync(V, { recursive: true, force: true }));

test("projects runs the missions subcommands; prompt groups have their own command", () => {
  expect(run("projects", "create", "--name", "Learn the foo", "--owner", "hobbies", "--target", "2027-01-01")).toMatchObject({ id: "mission/learn-the-foo" });
  expect(run("projects", "list").map((m: { slug: string }) => m.slug)).toEqual(["learn-the-foo"]);
  expect(run("projects", "milestone", "learn-the-foo", "add", "--title", "First lesson")).toMatchObject({ ok: true });
  expect(run("projects", "pause", "learn-the-foo")).toMatchObject({ status: "paused" });
  expect(run("missions", "show", "learn-the-foo")).toMatchObject({ status: "paused" });
  expect(run("prompt-groups", "list")).toMatchObject({ projects: [] });
  expect(run("projects", "timeline")).toMatchObject({ vantage: "month" });
}, 30_000);
