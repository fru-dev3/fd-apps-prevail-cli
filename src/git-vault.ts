// Auto-commit vault edits for undo / audit.
//
// The vault is plain files (see docs/VAULT-SPEC.md). If — and only if — the
// user keeps their vault under git, we can give them free undo + an audit
// trail by committing after every agent edit. This module is intentionally
// SAFE and conservative:
//
//   - It NEVER runs `git init` (we don't impose version control on a vault
//     the user chose to keep un-versioned).
//   - It NEVER pushes (no network, no remote side effects, ever).
//   - It NEVER throws fatally. A git failure must not break the chat / edit
//     path — every failure is logged to ~/.prevail/debug.log and swallowed,
//     mirroring the silent-catch convention in debug-log.ts / file-lock.ts.
//   - It only commits when the working tree actually has changes, so we
//     don't litter the history with empty commits.
//
// All git invocations go through `git -C <vault>` so the caller's cwd is
// irrelevant and we always operate on the vault repo, never an enclosing one.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { logDebug } from "./debug-log.ts";
import { validateVaultPath } from "./path-safety.ts";

// Cap git's wall-clock so a hung git (e.g. a stale index.lock, a credential
// prompt that shouldn't happen offline) can't wedge the edit path forever.
const GIT_TIMEOUT_MS = 15_000;

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

// Run `git -C <vaultPath> <args…>` with stdin disabled (so git can never
// block waiting on an interactive prompt) and a hard timeout. Returns a
// normalized result object; never throws.
function runGit(vaultPath: string, args: string[]): GitRun {
  try {
    const res = spawnSync("git", ["-C", vaultPath, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // Belt-and-suspenders against any interactive prompt (credentials,
      // GPG passphrase): keep git fully non-interactive.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    if (res.error) {
      logDebug("git-vault", "git spawn failed", {
        args,
        error: res.error.message,
      });
      return { ok: false, stdout: "", stderr: res.error.message, status: null };
    }
    return {
      ok: res.status === 0,
      stdout: (res.stdout ?? "").toString(),
      stderr: (res.stderr ?? "").toString(),
      status: res.status,
    };
  } catch (err) {
    logDebug("git-vault", "git invocation threw", {
      args,
      error: (err as Error).message,
    });
    return { ok: false, stdout: "", stderr: (err as Error).message, status: null };
  }
}

// True iff `vaultPath` is the top level of a git working tree. We require the
// vault to BE the repo root (not merely live inside some enclosing repo) so we
// never accidentally `add -A` files outside the vault. Returns false on any
// error — the safe default is "not a repo", which makes commitVault a no-op.
export function isGitRepo(vaultPath: string): boolean {
  const v = validateVaultPath(vaultPath);
  if (!v.ok) return false;
  if (!existsSync(vaultPath)) return false;
  // Fast path: a `.git` directory (or file, for worktrees/submodules) at the
  // vault root is the common case. Confirm with git itself to handle the
  // worktree / gitfile cases correctly.
  const inside = runGit(vaultPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return false;
  const top = runGit(vaultPath, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return false;
  // Compare resolved tops so we only act when the vault IS the repo root.
  const repoTop = top.stdout.trim();
  if (!repoTop) return false;
  // Accept either an exact match or the .git-at-root signal. realpath
  // differences (symlinks under iCloud/Tailscale) make a strict string
  // compare fragile, so also accept the presence of .git at the vault root.
  if (repoTop === vaultPath) return true;
  return existsSync(join(vaultPath, ".git"));
}

// True iff the vault working tree has staged or unstaged changes (including
// untracked files). Uses `status --porcelain` — empty output means clean.
function hasChanges(vaultPath: string): boolean {
  const res = runGit(vaultPath, ["status", "--porcelain"]);
  if (!res.ok) return false;
  return res.stdout.trim().length > 0;
}

export interface CommitResult {
  // Whether a commit was actually created.
  committed: boolean;
  // Why we didn't commit, when committed === false. One of:
  // "not-a-repo" | "no-changes" | "git-error".
  reason?: "not-a-repo" | "no-changes" | "git-error";
}

// Stage everything and commit, but ONLY if the vault is a git repo and there
// are changes to record. Never inits, never pushes, never throws. Returns a
// small result the caller can log or ignore.
export function commitVault(vaultPath: string, message: string): CommitResult {
  if (!isGitRepo(vaultPath)) {
    return { committed: false, reason: "not-a-repo" };
  }
  if (!hasChanges(vaultPath)) {
    return { committed: false, reason: "no-changes" };
  }
  const add = runGit(vaultPath, ["add", "-A"]);
  if (!add.ok) {
    logDebug("git-vault", "git add -A failed", { stderr: add.stderr.slice(0, 500) });
    return { committed: false, reason: "git-error" };
  }
  // --no-verify so a user's pre-commit hooks can't block (or slow) the
  // auto-commit path. The point is a frictionless audit trail, not gate-keeping.
  const safeMsg = sanitizeMessage(message);
  const commit = runGit(vaultPath, [
    "commit",
    "--no-verify",
    "-m",
    safeMsg,
  ]);
  if (!commit.ok) {
    // A race where another writer committed our changes first leaves nothing
    // to commit — treat "nothing to commit" as a benign no-op, not an error.
    if (/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      return { committed: false, reason: "no-changes" };
    }
    logDebug("git-vault", "git commit failed", {
      stderr: commit.stderr.slice(0, 500),
      stdout: commit.stdout.slice(0, 500),
    });
    return { committed: false, reason: "git-error" };
  }
  return { committed: true };
}

// Normalize a commit message: collapse to a single safe line, cap length.
// We pass the message as a discrete argv element to spawnSync (no shell), so
// there's no shell-injection surface — this is purely cosmetic / defensive.
function sanitizeMessage(message: string): string {
  const oneLine = (message ?? "").replace(/[\r\n]+/g, " ").trim();
  const capped = oneLine.length > 500 ? oneLine.slice(0, 500) : oneLine;
  return capped.length > 0 ? capped : "prevail: vault update";
}

// Run `fn`, then auto-commit whatever it changed. The commit label is wrapped
// in a small prefix so the audit history is grep-able. `fn` may be sync or
// async; its return value is passed straight through. A failing commit never
// affects `fn`'s result — the edit already happened; the commit is best-effort.
export async function withVaultCommit<T>(
  vaultPath: string,
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const result = await fn();
  try {
    commitVault(vaultPath, `prevail: ${label}`);
  } catch (err) {
    // commitVault already swallows internally, but guard the await/return
    // path too — withVaultCommit must be as crash-proof as its callee.
    logDebug("git-vault", "withVaultCommit commit threw", {
      label,
      error: (err as Error).message,
    });
  }
  return result;
}
