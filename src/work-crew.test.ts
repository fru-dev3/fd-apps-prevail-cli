import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeWorktree, crewBrief, crewOf, crewPaths, ensureWorktree, readCrewStatus, resetCrewStatus, shipModeOf, STOP_BLOCKS, stopHookSettings, worktreeName, type CrewTask } from "./work-crew.ts";

const ROOT = join("/tmp", `prevail-work-crew-${process.pid}`);
const V = join(ROOT, "vault");
const REPO = join(ROOT, "code", "foo-app");
const ORIGIN = join(ROOT, "origin", "foo-app.git");
const TREES = join(ROOT, "trees");
const saved = process.env.PREVAIL_CONFIG_DIR;
beforeAll(() => { process.env.PREVAIL_CONFIG_DIR = join(ROOT, "config"); });
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); if (saved === undefined) delete process.env.PREVAIL_CONFIG_DIR; else process.env.PREVAIL_CONFIG_DIR = saved; });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Foo", GIT_AUTHOR_EMAIL: "foo@example.com", GIT_COMMITTER_NAME: "Foo", GIT_COMMITTER_EMAIL: "foo@example.com" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "data", "domains", "general", "memory"), { recursive: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(ORIGIN, { recursive: true });
  git(ORIGIN, "init", "--quiet", "--bare", "-b", "main");
  git(REPO, "init", "--quiet", "-b", "main");
  writeFileSync(join(REPO, "src", "foo.ts"), "export const foo = 1;\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "--quiet", "-m", "foo");
  git(REPO, "remote", "add", "origin", ORIGIN);
  git(REPO, "push", "--quiet", "-u", "origin", "main");
  git(REPO, "remote", "set-head", "origin", "main");
}

const task = (o: Partial<CrewTask> = {}): CrewTask => ({ id: "w20261010-101010-ab12-1", name: "Foo Fix", text: "Fix the foo bug", thread: { space: "general", session: "s1" }, crew: "ship", ...o });

describe("scout or ship, by code", () => {
  test("an ask that only finds out is a scout; anything that makes or changes something is a ship", () => {
    for (const s of ["Find the best foo carrier for the rentals", "Why does the foo build fail?", "Research foo carriers and compare their prices", "Look into the foo login bug", "Can you review the foo PR"]) expect([s, crewOf(s)]).toEqual([s, "scout"]);
    for (const s of ["Fix the foo login bug", "Find the foo bug and fix it", "Draft an email to the foo bank about the fee", "Plan a foo training block for next month", "Add dark mode to foo", "Book a foo table"]) expect([s, crewOf(s)]).toEqual([s, "ship"]);
  });
});

describe("worktrees", () => {
  beforeEach(seed);
  test("a ship task on a repo gets its own worktree on a work/ branch, from origin's default branch, in the same subfolder", () => {
    const w = ensureWorktree(V, task(), join(REPO, "src"), { root: TREES })!;
    expect(w.branch).toBe(`work/${worktreeName(task())}`);
    expect(w.branch).toBe("work/foo-fix-ab12-1");
    expect(w.path).toBe(join(TREES, "foo-app", "foo-fix-ab12-1"));
    expect(w.cwd).toBe(join(w.path, "src"));
    expect(w.base).toBe("origin/main");
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(w.branch);
    // Made once: asked again, the same one comes back. Two tasks on one repo never share one.
    expect(ensureWorktree(V, task({ worktree: w }), REPO, { root: TREES })).toEqual(w);
    const other = ensureWorktree(V, task({ id: "w20261010-101010-ab12-2" }), REPO, { root: TREES })!;
    expect(other.path).not.toBe(w.path);
    expect(other.branch).toBe("work/foo-fix-ab12-2");
  });
  test("a scout, a folder that is not a repo, and the vault itself get none", () => {
    expect(ensureWorktree(V, task({ crew: "scout" }), REPO, { root: TREES })).toBeNull();
    expect(ensureWorktree(V, task(), join(ROOT, "nowhere"), { root: TREES })).toBeNull();
    git(V, "init", "--quiet");
    expect(ensureWorktree(V, task(), V, { root: TREES })).toBeNull();
    expect(() => ensureWorktree(V, task(), REPO, { root: join(V, "trees") })).toThrow(/never goes inside the vault/);
  });
  test("closing removes a worktree only when nothing would be lost; the branch always stays", () => {
    const w = ensureWorktree(V, task(), REPO, { root: TREES })!;
    writeFileSync(join(w.path, "src", "foo.ts"), "export const foo = 2;\n");
    expect(closeWorktree(w)).toEqual({ removed: false, why: "it has changes that are not committed" });
    git(w.path, "commit", "--quiet", "-am", "foo two");
    expect(closeWorktree(w)).toEqual({ removed: false, why: "its branch is not merged or pushed yet" });
    expect(existsSync(w.path)).toBe(true);
    git(w.path, "push", "--quiet", "-u", "origin", w.branch);
    expect(closeWorktree(w)).toEqual({ removed: true, why: "its branch is pushed" });
    expect(existsSync(w.path)).toBe(false);
    expect(git(REPO, "branch", "--list", w.branch)).toContain(w.branch);
    // A branch with nothing new is merged already: nothing to lose.
    const empty = ensureWorktree(V, task({ id: "w20261010-101010-ab12-3" }), REPO, { root: TREES })!;
    expect(closeWorktree(empty)).toEqual({ removed: true, why: "its branch is merged" });
  });
  test("ship mode: the repo's own setting, else ship.sh, else a GitHub remote opens a PR, else local only", () => {
    expect(shipModeOf(REPO)).toBe("local-only");
    git(REPO, "remote", "add", "gh", "git@github.com:foo/foo-app.git");
    expect(shipModeOf(REPO)).toBe("pr");
    mkdirSync(join(REPO, "scripts"), { recursive: true });
    writeFileSync(join(REPO, "scripts", "ship.sh"), "#!/bin/sh\n");
    expect(shipModeOf(REPO)).toBe("ship-script");
    git(REPO, "config", "prevail.shipMode", "local-only");
    expect(shipModeOf(REPO)).toBe("local-only");
  });
});

describe("the brief, the status file and the Stop hook", () => {
  beforeEach(seed);
  test("a scout may write only its report and status; a ship is told its worktree and how the project ships", () => {
    const scout = crewBrief(V, task({ crew: "scout" })).join("\n");
    const p = crewPaths(V, task());
    expect(p.dir).toBe(join(V, "data", "domains", "general", "memory", "work", "w20261010-101010-ab12-1"));
    expect(scout).toContain("This is a scout task");
    expect(scout).toContain("Do not edit, create, move or delete any file");
    expect(scout).toContain(`Write what you found to ${p.report}`);
    expect(scout).toContain(`write ${p.status} as JSON`);
    const w = { path: "/tmp/foo-tree", branch: "work/foo-fix-ab12-1", repo: "/tmp/foo-app", base: "origin/main", cwd: "/tmp/foo-tree" };
    expect(crewBrief(V, task({ worktree: w, shipMode: "pr" })).join("\n")).toContain("push the branch (git push -u origin work/foo-fix-ab12-1) and open a pull request with gh pr create");
    expect(crewBrief(V, task({ worktree: w, shipMode: "ship-script" })).join("\n")).toContain("run it (scripts/ship.sh) until the gate shows ALL MET");
    expect(crewBrief(V, task({ worktree: w, shipMode: "local-only" })).join("\n")).toContain("Do not push or merge: the owner merges it.");
    expect(crewBrief(V, task({ crew: undefined }))).toEqual([]);
    for (const l of [...crewBrief(V, task({ worktree: w, shipMode: "pr" })), ...crewBrief(V, task({ crew: "scout" }))]) expect(l).not.toMatch(/[—–]/);
  });
  test("the status file is read only when it says a state; a fresh run moves the last one aside", () => {
    const p = crewPaths(V, task());
    expect(readCrewStatus(p.status)).toBeNull();
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.status, JSON.stringify({ state: "maybe" }));
    expect(readCrewStatus(p.status)).toBeNull();
    writeFileSync(p.status, JSON.stringify({ state: "done", summary: "Fixed the foo bug — tests pass", report: p.report }));
    expect(readCrewStatus(p.status)).toEqual({ state: "done", summary: "Fixed the foo bug, tests pass", report: p.report });
    resetCrewStatus(V, task());
    expect(existsSync(p.status)).toBe(false);
    expect(existsSync(join(p.dir, "status.prev.json"))).toBe(true);
  });
  test("the Stop hook holds the agent until the status file exists, and lets it go after a few tries", () => {
    const base = join(ROOT, "gate.json");
    writeFileSync(base, JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "foo-gate" }] }] } }));
    const path = stopHookSettings(V, task(), { base });
    expect(path).toBe(join(ROOT, "config", "work", task().id, "settings.json"));
    const s = JSON.parse(readFileSync(path, "utf8")) as { hooks: { PreToolUse: unknown[]; Stop: { hooks: { command: string }[] }[] } };
    expect(s.hooks.PreToolUse).toHaveLength(1);
    const cmd = s.hooks.Stop[0]!.hooks[0]!.command;
    const stop = () => spawnSync("sh", ["-c", cmd], { encoding: "utf8" }).stdout.trim();
    const first = JSON.parse(stop()) as { decision: string; reason: string };
    expect(first.decision).toBe("block");
    expect(first.reason).toContain(crewPaths(V, task()).status);
    for (let i = 1; i < STOP_BLOCKS; i++) expect(stop()).toContain("block");
    // The loop guard: after STOP_BLOCKS holds, it lets the agent stop.
    expect(stop()).toBe("");
    // A fresh run counts again; with the status file there, it never holds.
    resetCrewStatus(V, task());
    expect(stop()).toContain("block");
    const p = crewPaths(V, task());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.status, JSON.stringify({ state: "done", summary: "Foo fixed." }));
    expect(stop()).toBe("");
  });
});
