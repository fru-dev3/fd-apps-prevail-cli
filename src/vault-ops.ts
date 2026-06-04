// Pure-logic vault operations: prune old logs, backup the vault as a
// tarball, and restore from a tarball. No CLI concerns live here — the
// `prevail vault ...` subcommand in src/index.tsx wires this to argv.
//
// Design notes:
//   - pruneLog and parseDuration are deterministic, testable, and never
//     touch anything outside the explicit `_log/` and `_journal/` folders.
//   - backupVault / restoreVault shell out to the system `tar` binary
//     because Bun does not (as of this writing) expose a stable native
//     tar.gz writer. We pass arguments as an array via Bun.spawn so the
//     shell never sees user-controlled strings.
//   - restoreVault demands the user type the vault basename before it
//     extracts anything — same posture as `rm -rf` confirm prompts.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────
// parseDuration — "30d", "12h", "1y", "7d12h" → milliseconds
// ─────────────────────────────────────────────────────────────────────────

const MS_PER_UNIT: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

export function parseDuration(s: string): number {
  if (typeof s !== "string") {
    throw new Error(`parseDuration: expected string, got ${typeof s}`);
  }
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    throw new Error("parseDuration: empty string");
  }
  // Match repeated <number><unit> groups. Reject anything else.
  const re = /(\d+)([smhdwy])/gi;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    const mult = MS_PER_UNIT[unit];
    if (!mult) throw new Error(`parseDuration: unknown unit "${unit}"`);
    total += n * mult;
    consumed += m[0].length;
  }
  if (consumed !== trimmed.length || total === 0) {
    throw new Error(`parseDuration: invalid duration "${s}"`);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────
// pruneLog — walk <vault>/<domain>/_log/ and _journal/{decisions,facts}.md,
// drop files older than args.olderThanMs.
// ─────────────────────────────────────────────────────────────────────────

export interface PruneArgs {
  vaultPath: string;
  olderThanMs: number;
  // When false (the default), nothing is deleted — we just report.
  dryRun?: boolean;
  // Optional clock override so tests can pin "now".
  now?: number;
}

export interface PruneResult {
  files: string[];
  totalBytes: number;
}

// Only these basenames inside _journal/ are eligible for pruning. Everything
// else (notes.md, plan.md, etc.) is user-curated content and stays put.
const PRUNEABLE_JOURNAL_FILES = new Set(["decisions.md", "facts.md"]);

export function pruneLog(args: PruneArgs): PruneResult {
  const vault = resolve(args.vaultPath);
  const cutoff = (args.now ?? Date.now()) - args.olderThanMs;
  const dryRun = args.dryRun !== false; // default true — safety first
  const out: PruneResult = { files: [], totalBytes: 0 };
  if (!existsSync(vault)) return out;
  const entries = safeReaddir(vault);
  for (const e of entries) {
    const domainPath = join(vault, e);
    if (!isDir(domainPath)) continue;
    // _log/*.md — every dated log under every domain
    const logDir = join(domainPath, "_log");
    if (isDir(logDir)) {
      for (const f of safeReaddir(logDir)) {
        if (!f.endsWith(".md")) continue;
        considerForPrune(join(logDir, f), cutoff, out, dryRun);
        // .shasum sidecar — prune in step with its log
      }
      // .shasum sidecars are pruned together with their .md log above by
      // an explicit second pass so a stray .shasum without a log also
      // disappears if it's older than the cutoff.
      for (const f of safeReaddir(logDir)) {
        if (!f.endsWith(".shasum")) continue;
        considerForPrune(join(logDir, f), cutoff, out, dryRun);
      }
    }
    // _journal/decisions.md + _journal/facts.md — never touch anything else
    const journalDir = join(domainPath, "_journal");
    if (isDir(journalDir)) {
      for (const f of safeReaddir(journalDir)) {
        if (!PRUNEABLE_JOURNAL_FILES.has(f)) continue;
        considerForPrune(join(journalDir, f), cutoff, out, dryRun);
      }
    }
  }
  return out;
}

function considerForPrune(
  filePath: string,
  cutoffMs: number,
  out: PruneResult,
  dryRun: boolean,
): void {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return;
  }
  if (!st.isFile()) return;
  if (st.mtimeMs >= cutoffMs) return;
  out.files.push(filePath);
  out.totalBytes += st.size;
  if (!dryRun) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best effort — caller already has the path in the report
    }
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// backupVault — tar.gz the vault + safe parts of ~/.prevail/
// ─────────────────────────────────────────────────────────────────────────

export interface BackupArgs {
  vaultPath: string;
  outputPath: string;
  // Override for tests so we don't poke at the real ~/.prevail.
  prevailHome?: string;
}

export interface BackupResult {
  archivePath: string;
  bytes: number;
}

// Anything matching these glob-ish patterns is excluded from the tarball.
// We pass them straight to tar's --exclude flag. Tar interprets `*` as a
// path wildcard, so `*.token` matches any path component with that suffix.
const BACKUP_EXCLUDES: readonly string[] = [
  // High-sensitivity secrets that live next to config.json
  "telegram.json",
  "mcp.json",
  // Per-connector OAuth state — refresh tokens, access tokens, PKCE state
  "auth",
  // Catch-all suffixes — tar `--exclude` matches against full paths and
  // basenames, so these cover anything named *.token or *.refresh_token.
  "*.token",
  "*.refresh_token",
];

export async function backupVault(args: BackupArgs): Promise<BackupResult> {
  const vault = resolve(args.vaultPath);
  if (!existsSync(vault)) {
    throw new Error(`backupVault: vault path not found: ${vault}`);
  }
  const out = resolve(args.outputPath);
  const outDir = resolve(out, "..");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const prevailHome = args.prevailHome ?? join(homedir(), ".prevail");

  // We assemble the tar in two passes so the archive contains a clean,
  // predictable top-level layout regardless of where the vault sits on
  // disk:
  //   archive.tar.gz
  //   ├── vault/        (whatever args.vaultPath pointed at)
  //   └── prevail/      (safe parts of ~/.prevail/ — config.json + sessions.db)
  //
  // tar's `-C` flag changes directory before reading the next path. We
  // rename via tar's `--transform` (BSD tar: `-s`) only when needed; here
  // we use a simpler approach — stage paths through symlink-free relative
  // includes by giving tar two `-C dir name` pairs in sequence.

  // First: do we have anything safe to include from ~/.prevail/?
  const stagePaths: { cwd: string; name: string }[] = [];
  // Vault contents always go in.
  stagePaths.push({ cwd: resolve(vault, ".."), name: basename(vault) });
  // Safe ~/.prevail/ children — config.json and sessions.db only.
  if (existsSync(prevailHome)) {
    const cfg = join(prevailHome, "config.json");
    if (existsSync(cfg)) {
      stagePaths.push({ cwd: prevailHome, name: "config.json" });
    }
    const sdb = join(prevailHome, "sessions.db");
    if (existsSync(sdb)) {
      stagePaths.push({ cwd: prevailHome, name: "sessions.db" });
    }
  }

  // Build the tar argv. We use a single tar invocation with multiple `-C`
  // segments so the archive is created in one shot (atomic from the
  // caller's perspective — partial file only exists during the spawn).
  const argv: string[] = ["-czf", out];
  for (const ex of BACKUP_EXCLUDES) {
    argv.push("--exclude", ex);
  }
  for (const seg of stagePaths) {
    argv.push("-C", seg.cwd, seg.name);
  }

  // NEVER use shell:true — paths are user-controlled. Pass the array.
  const proc = Bun.spawn(["tar", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar failed (exit ${code}): ${stderr.trim()}`);
  }

  const bytes = statSync(out).size;
  return { archivePath: out, bytes };
}

// ─────────────────────────────────────────────────────────────────────────
// restoreVault — interactive: refuse unless user types the vault basename
// ─────────────────────────────────────────────────────────────────────────

export interface RestoreArgs {
  archivePath: string;
  targetVaultPath: string;
  // Test/automation hook so callers can bypass stdin. The function we
  // expose here is "the prompt + read line" — return the user's input.
  confirm?: (prompt: string) => Promise<string>;
}

export async function restoreVault(args: RestoreArgs): Promise<void> {
  const archive = resolve(args.archivePath);
  const target = resolve(args.targetVaultPath);
  if (!existsSync(archive)) {
    throw new Error(`restoreVault: archive not found: ${archive}`);
  }
  const expected = basename(target);
  const prompt = `this will OVERWRITE files in ${target}. Type the vault name to confirm: `;
  const answer = await (args.confirm ?? defaultStdinConfirm)(prompt);
  if (answer.trim() !== expected) {
    throw new Error(
      `restoreVault: confirmation mismatch — expected "${expected}", got "${answer.trim()}"`,
    );
  }
  // Make sure the target exists before we untar into it. tar will create
  // intermediate dirs but the parent must exist when we pass -C.
  if (!existsSync(target)) mkdirSync(target, { recursive: true });

  const proc = Bun.spawn(["tar", "-xzf", archive, "-C", target], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extract failed (exit ${code}): ${stderr.trim()}`);
  }
}

async function defaultStdinConfirm(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  // Read one line off stdin. Bun exposes process.stdin as an
  // AsyncIterable<Uint8Array> chunks; one chunk per line is the common
  // case in interactive mode, but we still concatenate defensively.
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk);
    const nl = buf.indexOf("\n");
    if (nl >= 0) return buf.slice(0, nl);
  }
  return buf;
}

// Convenience used by the CLI: default backup filename.
export function defaultBackupPath(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(homedir(), `prevail-backup-${stamp}.tar.gz`);
}

// Tiny helper for the CLI — formats bytes as "12.3 MB" etc.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Used as an inert "verify" placeholder until #41 lands.
export const VERIFY_PLACEHOLDER_MESSAGE =
  "vault verify will be implemented as part of the tamper-evident log work (#41). For now, no-op.";
