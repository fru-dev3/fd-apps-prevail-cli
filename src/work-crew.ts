// Work mode's crew: how a task is shaped, where it works, and how it says it
// is finished.
//
// Shape. Every new task is a scout or a ship (the router says which; the
// user changes it like a re-route). A scout investigates and changes nothing:
// it ends with a report file. A ship makes the change. A record from before
// shapes has none and runs as it always did.
//
// Worktrees. A ship task whose home is a git repo (a project folder) works in
// its own git worktree on a branch work/<task>, so two tasks on one repo
// never collide: ~/.workmux/<repo>/<task> (the workmux convention), never
// inside the vault. Closing the task removes the worktree only when it is
// clean and its branch is merged or pushed; otherwise it stays, and the card
// says so. The branch itself is never deleted.
//
// Ship mode. How a ship task on a repo finishes, read from the repo (`git
// config prevail.shipMode`) or found: ship-script (scripts/ship.sh: commit,
// push, an unlazy gate run until ALL MET), pr (push the branch and open a
// pull request) for a repo with a GitHub remote, else local-only (commit on
// the branch; the owner merges). The brief says it as a plain rule.
//
// No blind stops. A crew agent writes a status file before it ends:
//   <space>/memory/work/<task-id>/status.json   {state: done|blocked|failed, summary, report?}
//   <space>/memory/work/<task-id>/report.md     a scout's findings
// It sits in the task's own space, so the agent may write it under Vault Lock
// (never under _meta, which the act gate keeps from agents). Claude Code gets
// a Stop hook (its --settings file, never the user's own settings) that will
// not let it stop until the status file is there, and lets it go after a few
// tries so it can never loop. Other agents get the rule in their brief, and
// the watcher nudges once when one stops without it, then calls it failed.
//
//   ~/.prevail/work/<task-id>/settings.json   act gate + Stop hook (this Mac only)
//   ~/.prevail/work/<task-id>/stop-hook.sh    the hook: plain sh, no Prevail needed
//   ~/.prevail/work/<task-id>/stop-blocks     how many stops it held

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { configDir } from "./config.ts";
import { domainDir } from "./decisions.ts";

export type CrewShape = "scout" | "ship";
export type ShipMode = "ship-script" | "pr" | "local-only";
export const CREW_SHAPES: CrewShape[] = ["scout", "ship"];
export const SHIP_MODES: ShipMode[] = ["ship-script", "pr", "local-only"];

export interface WorktreeRef {
  /** The worktree folder (on this Mac). */
  path: string;
  branch: string;
  /** The repo's main checkout it was made from. */
  repo: string;
  /** What the branch started from (origin's default branch, else HEAD). */
  base: string;
  /** Where the agent works: the worktree, or the same subfolder in it the task's home is in the repo. */
  cwd: string;
  /** The Mac it is on (its label): only that Mac takes it away. */
  machine?: string;
}

export interface CrewStatus { state: "done" | "blocked" | "failed"; summary: string; report?: string }

/** The bits of a task the crew needs (a WorkTask has them all). */
export interface CrewTask { id: string; name?: string; text: string; thread: { space: string; session: string }; crew?: CrewShape; worktree?: WorktreeRef; shipMode?: ShipMode }

// ── Shape ───────────────────────────────────────────────────────────────────

// A step that makes or changes something: any one of them makes it a ship.
const SHIP_LEAD = /^(?:fix|build|add|implement|create|make|write|draft|update|change|edit|refactor|rename|remove|delete|migrate|ship|deploy|release|commit|set ?up|install|upgrade|bump|move|port|wire|book|file|reply|respond|send|email|organi[sz]e|clean ?up|merge|rewrite|replace|generate|scaffold|publish|plan|prepare|schedule)\b/i;
// A step that only finds out: a verb that reads, or a question.
const SCOUT_LEAD = /^(?:find(?: out)?|research|investigate|look (?:into|at|for|up)|explore|review|audit|check|compare|summari[sz]e|explain|analy[sz]e|figure out|understand|survey|assess|evaluate|read|list|search|trace|diagnose|tell me|what|why|how|which|where|when|who|is|are|does|do|did|can|should)\b/i;
const POLITE = /^(?:please|can you|could you|would you|i need you to|i want you to|help me)\s+/i;

/** Scout or ship, by code: an ask whose every step only finds out is a scout; a step that makes or changes something makes it a ship. */
export function crewOf(text: string): CrewShape {
  const steps = text.split(/[,;.!\n]|\b(?:and|then|also)\b/i).map((s) => s.trim().replace(POLITE, "")).filter(Boolean);
  if (!steps.length || steps.some((s) => SHIP_LEAD.test(s))) return "ship";
  return SCOUT_LEAD.test(steps[0]!) || /\?\s*$/.test(text.trim()) ? "scout" : "ship";
}

export const isCrewShape = (x: unknown): x is CrewShape => x === "scout" || x === "ship";

// ── Files ───────────────────────────────────────────────────────────────────

/** The task's crew files in its own space: the status file and a scout's report. */
export function crewPaths(vault: string, t: Pick<CrewTask, "id" | "thread">): { dir: string; status: string; report: string } {
  const dir = join(domainDir(vault, t.thread.space), "memory", "work", t.id);
  return { dir, status: join(dir, "status.json"), report: join(dir, "report.md") };
}

/** This Mac's own folder for a task's agent settings and Stop hook (never in the vault, never the user's settings). */
export const crewHome = (home?: string) => home ?? join(configDir(), "work");

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim().slice(0, n);

/** The status file, or null when it is missing or does not say a state. */
export function readCrewStatus(file: string): CrewStatus | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return null; }
  const state = j?.state;
  if (state !== "done" && state !== "blocked" && state !== "failed") return null;
  const summary = typeof j.summary === "string" ? oneLine(j.summary, 300) : "";
  return { state, summary, ...(typeof j.report === "string" && j.report.trim() ? { report: j.report.trim() } : {}) };
}

/** A fresh start (a launch, a follow-up): the last status file steps aside and the Stop hook's count starts again. */
export function resetCrewStatus(vault: string, t: Pick<CrewTask, "id" | "thread">, home?: string): void {
  const { status } = crewPaths(vault, t);
  try { if (existsSync(status)) renameSync(status, status.replace(/\.json$/, ".prev.json")); } catch { /* next write wins */ }
  try { rmSync(join(crewHome(home), t.id, "stop-blocks"), { force: true }); } catch { /* none */ }
}

// ── Git ─────────────────────────────────────────────────────────────────────

/** Runs git in a folder (tests may pass their own). */
export type Git = (args: string[], cwd: string) => { ok: boolean; out: string };
export const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}`.trim() || `${r.stderr ?? ""}`.trim() };
};

/** A path with its links resolved, through the nearest folder that exists (a worktree is checked before it is made). */
const real = (p: string): string => {
  let d = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(d), ...tail); } catch {
      const up = dirname(d);
      if (up === d) return resolve(p);
      tail.unshift(basename(d));
      d = up;
    }
  }
};
const inside = (child: string, parent: string) => { const r = relative(real(parent), real(child)); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };

/** The repo a folder is in (its top), or null when it is not a git work tree. */
export function repoOf(path: string, git: Git = realGit): string | null {
  if (!existsSync(path)) return null;
  const r = git(["rev-parse", "--show-toplevel"], path);
  return r.ok && r.out ? r.out.split("\n")[0]!.trim() : null;
}

/** How a ship task on this repo finishes: the repo's own setting, else ship.sh, else a GitHub remote, else local only. */
export function shipModeOf(repo: string, git: Git = realGit): ShipMode {
  const set = git(["config", "--get", "prevail.shipMode"], repo);
  if (set.ok && (SHIP_MODES as string[]).includes(set.out.trim())) return set.out.trim() as ShipMode;
  if (existsSync(join(repo, "scripts", "ship.sh"))) return "ship-script";
  const remote = git(["remote", "-v"], repo);
  return remote.ok && /github\.com[:/]/i.test(remote.out) ? "pr" : "local-only";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
/** The task's short name for its branch and folder: its name, then the end of its id so two tasks never share one. */
export const worktreeName = (t: Pick<CrewTask, "id" | "name" | "text">) => `${slug(t.name || t.text)}-${t.id.split("-").slice(-2).join("-")}`;
/** Where worktrees go: ~/.workmux (the workmux convention), or PREVAIL_WORKTREE_ROOT. */
export const worktreeRoot = (root?: string) => root ?? process.env.PREVAIL_WORKTREE_ROOT ?? join(homedir(), ".workmux");

/**
 * A ship task's own worktree for the repo its home folder is in: made once,
 * reused after. Null when the task is not a ship, its folder is not a git
 * repo, or the repo is the vault (the vault is never worked on in a
 * worktree). Throws when git cannot make it.
 */
export function ensureWorktree(vault: string, t: CrewTask, folder: string, o: { git?: Git; root?: string } = {}): WorktreeRef | null {
  if (t.crew !== "ship") return null;
  const git = o.git ?? realGit;
  if (t.worktree && existsSync(t.worktree.path)) return t.worktree;
  const repo = repoOf(folder, git);
  if (!repo || inside(repo, vault) || inside(vault, repo)) return null;
  const name = worktreeName(t);
  const path = join(worktreeRoot(o.root), basename(repo), name);
  if (inside(path, vault)) throw new Error("a worktree never goes inside the vault");
  const branch = `work/${name}`;
  // Start from origin's default branch when there is one (the main checkout may sit on an old branch).
  git(["fetch", "--quiet", "origin"], repo);
  const head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
  const base = head.ok && head.out ? head.out : "HEAD";
  mkdirSync(join(path, ".."), { recursive: true });
  const has = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).ok;
  const add = existsSync(path) ? { ok: true, out: "" } : git(["worktree", "add", ...(has ? [path, branch] : ["-b", branch, path, base])], repo);
  if (!add.ok) throw new Error(`git could not make a worktree: ${add.out.split("\n")[0]}`);
  const sub = relative(real(repo), real(folder));
  return { path, branch, repo, base, cwd: sub && !sub.startsWith("..") ? join(path, sub) : path };
}

/**
 * Take a worktree away when nothing would be lost: clean, and its branch
 * merged into its base or pushed. Otherwise it stays and `why` says so. The
 * branch is never deleted.
 */
export function closeWorktree(w: WorktreeRef, git: Git = realGit): { removed: boolean; why: string } {
  if (!existsSync(w.path)) return { removed: true, why: "it was already gone" };
  const st = git(["status", "--porcelain"], w.path);
  if (!st.ok) return { removed: false, why: "git could not read it" };
  if (st.out.trim()) return { removed: false, why: "it has changes that are not committed" };
  const merged = git(["merge-base", "--is-ancestor", w.branch, w.base], w.repo).ok;
  const remote = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${w.branch}`], w.repo);
  const ahead = remote.ok ? git(["rev-list", "--count", `origin/${w.branch}..${w.branch}`], w.repo) : null;
  const pushed = !!ahead?.ok && ahead.out === "0";
  if (!merged && !pushed) return { removed: false, why: "its branch is not merged or pushed yet" };
  const rm = git(["worktree", "remove", w.path], w.repo);
  return rm.ok ? { removed: true, why: merged ? "its branch is merged" : "its branch is pushed" } : { removed: false, why: `git would not remove it: ${rm.out.split("\n")[0]}` };
}

// ── The brief and the Stop hook ─────────────────────────────────────────────

const SHIP_RULE: Record<ShipMode, (branch: string) => string> = {
  "ship-script": (b) => `- How this project ships: commit on ${b}, push the branch, then open a deploy gate with the unlazy skill and run it (scripts/ship.sh) until the gate shows ALL MET. A commit alone is not done.`,
  pr: (b) => `- How this project ships: commit on ${b}, push the branch (git push -u origin ${b}) and open a pull request with gh pr create. Pushing the branch and opening the pull request are allowed; do not merge it.`,
  "local-only": (b) => `- How this project ships: commit on ${b} and stop there. Do not push or merge: the owner merges it.`,
};

/** The crew's lines in the brief: the shape's rule, the worktree and ship mode for a ship, and the status file every crew agent writes. */
export function crewBrief(vault: string, t: CrewTask, root?: string): string[] {
  if (!t.crew) return [];
  // On another Mac the same files sit under that Mac's vault folder.
  const on = (f: string) => (root ? join(root, relative(vault, f)) : f);
  const c = crewPaths(vault, t);
  const p = { status: on(c.status), report: on(c.report) };
  const lines = ["", t.crew === "scout" ? "This is a scout task: find out and report. Change nothing." : "This is a ship task: make the change."];
  if (t.crew === "scout") {
    lines.push(
      "- Do not edit, create, move or delete any file, and do not commit, except the two files below.",
      `- Write what you found to ${p.report} as markdown: the answer first, then the evidence (files, sources, figures).`,
    );
  } else if (t.worktree) {
    lines.push(
      `- You work in your own git worktree at ${t.worktree.path}, on the branch ${t.worktree.branch}. Stay in it; never touch the main checkout at ${t.worktree.repo}.`,
      "- Never push to the default branch, never force push, never skip hooks (--no-verify).",
      SHIP_RULE[t.shipMode ?? "local-only"](t.worktree.branch),
    );
  }
  lines.push(
    `- Before you stop, write ${p.status} as JSON: {"state":"done|blocked|failed","summary":"<one plain line>"${t.crew === "scout" ? `,"report":"${p.report}"` : ""}}. done when it is finished, blocked when only the owner can unblock it (say what you need in the summary), failed when it cannot be done. You may not end without it.`,
  );
  return lines;
}

const shq = (w: string) => `'${w.replace(/'/g, "'\\''")}'`;
/** How many stops the hook holds before it lets the agent go (it can never loop). */
export const STOP_BLOCKS = 3;

/**
 * The task's Claude Code settings: the act gate's hooks (when there is a
 * file) plus a Stop hook that will not let the agent end before its status
 * file exists, at most STOP_BLOCKS times. Written on this Mac only; returns
 * the settings path for --settings.
 */
export function stopHookSettings(vault: string, t: Pick<CrewTask, "id" | "thread">, o: { base?: string | null; home?: string } = {}): string {
  const dir = join(crewHome(o.home), t.id);
  mkdirSync(dir, { recursive: true });
  const { status } = crewPaths(vault, t);
  const script = join(dir, "stop-hook.sh");
  const count = join(dir, "stop-blocks");
  const reason = `Prevail needs this task's status file before you stop. Write ${status} as JSON with state (done, blocked or failed) and a one line summary, then stop.`;
  writeFileSync(script, [
    "#!/bin/sh",
    "# Prevail Work mode: no blind stops. Written by Prevail for one task; safe to delete.",
    `status=${shq(status)}`,
    `count=${shq(count)}`,
    '[ -s "$status" ] && exit 0',
    'n=$(cat "$count" 2>/dev/null || echo 0)',
    "n=$((n + 1))",
    'echo "$n" > "$count"',
    `[ "$n" -gt ${STOP_BLOCKS} ] && exit 0`,
    `printf '%s\\n' ${shq(JSON.stringify({ decision: "block", reason }))}`,
    "exit 0",
    "",
  ].join("\n"));
  try { chmodSync(script, 0o755); } catch { /* sh runs it anyway */ }
  let settings: { hooks?: Record<string, unknown[]> } = {};
  try { if (o.base) settings = JSON.parse(readFileSync(o.base, "utf8")) as typeof settings; } catch { settings = {}; }
  const hooks = { ...(settings.hooks ?? {}) };
  hooks.Stop = [...(Array.isArray(hooks.Stop) ? hooks.Stop : []), { hooks: [{ type: "command", command: `sh ${shq(script)}` }] }];
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ ...settings, hooks }));
  return path;
}
