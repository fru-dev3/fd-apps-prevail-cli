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
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { readManifest, writeManifest } from "./manifest.ts";

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

// ─────────────────────────────────────────────────────────────────────────
// verifyVault — walk every <vault>/<domain>/_log/.shasum sidecar and
// re-hash each referenced entry against the .md log. Flags both tampered
// entries (sha mismatch) and missing entries (id in .shasum but no
// matching ## section in the .md).
//
// The .shasum format is one line per turn:   <entry-id> <hex-sha256>
// where <entry-id> is YYYYMMDD-HHMM, written at writeTurnSummary time.
//
// Each entry in the .md file begins with a leading "\n" + "## HH:MM …"
// section header. We split the file on the "\n## " boundary, prepend the
// "\n" back to each entry chunk, and that's the exact text that was
// hashed at write time. Matching entries to ids is done by the HH:MM in
// the section header + the YYYY-MM-DD encoded in the .md filename.
// ─────────────────────────────────────────────────────────────────────────

export interface VerifyEntry {
  domain: string;
  file: string; // absolute path to the .md log
  entryId: string;
  ok: boolean;
  expected: string;
  actual?: string;
  // "mismatch" — entry exists but sha doesn't match.
  // "missing"  — entry-id in .shasum but no matching ## section in .md.
  // "ok"       — clean.
  status: "ok" | "mismatch" | "missing";
}

export function verifyVault(vaultPath: string): VerifyEntry[] {
  const vault = resolve(vaultPath);
  const out: VerifyEntry[] = [];
  if (!existsSync(vault)) return out;
  for (const domain of safeReaddir(vault)) {
    const domainPath = join(vault, domain);
    if (!isDir(domainPath)) continue;
    const logDir = join(domainPath, "_log");
    if (!isDir(logDir)) continue;
    const shasumPath = join(logDir, ".shasum");
    if (!existsSync(shasumPath)) continue;
    let shasumRaw: string;
    try {
      shasumRaw = readFileSync(shasumPath, "utf8");
    } catch {
      continue;
    }
    // Pre-parse every .md log in this _log/ into {id → entryText}.
    // Cheap: one log file per day, only loaded when its directory has a
    // .shasum to verify against.
    const fileCache = new Map<string, Map<string, string>>(); // filename → id→text
    for (const rawLine of shasumRaw.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const id = parts[0]!;
      const expected = parts[1]!;
      const dateKey = entryIdToDateKey(id);
      if (!dateKey) {
        out.push({
          domain,
          file: shasumPath,
          entryId: id,
          ok: false,
          expected,
          status: "missing",
        });
        continue;
      }
      const mdName = `${dateKey}.md`;
      const mdPath = join(logDir, mdName);
      if (!existsSync(mdPath)) {
        out.push({
          domain,
          file: mdPath,
          entryId: id,
          ok: false,
          expected,
          status: "missing",
        });
        continue;
      }
      let entries = fileCache.get(mdName);
      if (!entries) {
        let raw: string;
        try {
          raw = readFileSync(mdPath, "utf8");
        } catch {
          out.push({
            domain,
            file: mdPath,
            entryId: id,
            ok: false,
            expected,
            status: "missing",
          });
          continue;
        }
        entries = parseLogEntries(raw, dateKey);
        fileCache.set(mdName, entries);
      }
      const text = entries.get(id);
      if (text === undefined) {
        out.push({
          domain,
          file: mdPath,
          entryId: id,
          ok: false,
          expected,
          status: "missing",
        });
        continue;
      }
      const actual = createHash("sha256").update(text).digest("hex");
      if (actual === expected) {
        out.push({
          domain,
          file: mdPath,
          entryId: id,
          ok: true,
          expected,
          actual,
          status: "ok",
        });
      } else {
        out.push({
          domain,
          file: mdPath,
          entryId: id,
          ok: false,
          expected,
          actual,
          status: "mismatch",
        });
      }
    }
  }
  return out;
}

// Parse a .md log into a map of entryId → exact entry text (matching what
// writeTurnSummary fed to sha256). Each entry begins with the leading
// newline + "## HH:MM" header. We use the YYYY-MM-DD dateKey (from the
// filename) + HH:MM from the header to reconstruct YYYYMMDD-HHMM ids.
function parseLogEntries(raw: string, dateKey: string): Map<string, string> {
  const out = new Map<string, string>();
  // dateKey is "YYYY-MM-DD" — strip dashes for the id prefix.
  const ymd = dateKey.replace(/-/g, "");
  // Find every "\n## " boundary. Each entry text is "\n## …\n" through
  // (but not including) the next "\n## " or EOF — i.e. the exact string
  // that was appended to the file (renderEntry output).
  const boundary = "\n## ";
  const indices: number[] = [];
  let i = raw.indexOf(boundary);
  while (i !== -1) {
    indices.push(i);
    i = raw.indexOf(boundary, i + 1);
  }
  for (let k = 0; k < indices.length; k++) {
    const start = indices[k]!;
    const end = k + 1 < indices.length ? indices[k + 1]! : raw.length;
    const entryText = raw.slice(start, end);
    // Header line lives right after the leading "\n". Pull HH:MM out of it.
    // Format: "\n## HH:MM  ·  <tag>…"
    const headerMatch = entryText.match(/^\n## (\d{2}):(\d{2})\b/);
    if (!headerMatch) continue;
    const hh = headerMatch[1]!;
    const mm = headerMatch[2]!;
    const id = `${ymd}-${hh}${mm}`;
    // First occurrence wins — if two turns landed in the same minute, we
    // only verify the first. Acceptable: entry ids collide on minute
    // granularity by design (entryId() returns YYYYMMDD-HHMM).
    if (!out.has(id)) out.set(id, entryText);
  }
  return out;
}

// "20260604-1037" → "2026-06-04" (or null if malformed).
function entryIdToDateKey(id: string): string | null {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-\d{4}$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ─────────────────────────────────────────────────────────────────────────
// archiveDomain / restoreDomain / listArchived — move a domain in and out of
// <vault>/_archive/ and flip its manifest's `archived` flag.
//
// The contract (TRACK E4):
//   - _archive/ is a NON-domain directory: the scanner must never treat it as
//     a domain or recurse into it. See the NOTE below — as of this writing
//     NON_DOMAIN_DIRS in src/vault.ts does NOT list "_archive", so it would
//     be skipped only because it has no top-level state.md. Adding "_archive"
//     to NON_DOMAIN_DIRS is recommended belt-and-suspenders (it's owned by the
//     vault.ts track, so it's flagged here rather than edited).
//   - archiveDomain takes a per-domain backup BEFORE moving anything, then
//     relocates <vault>/<domain>/ → <vault>/_archive/<domain>/, then sets the
//     manifest's archived=true + archived_at=now (written in the new location).
//   - restoreDomain moves it back and clears the archived flag.
//   - listArchived returns the archived domain names under _archive/.
//
// NOTE on _archive exclusion from domain scans: a domain dir keeps its own
// state.md after the move, so the live folder <vault>/<domain>/state.md is
// gone (good — it disappears from the active sidebar). The relocated copy now
// lives at <vault>/_archive/<domain>/state.md. Because the scanner only looks
// at the vault's IMMEDIATE children, the only thing it would see is the
// "_archive" directory itself — which has no top-level state.md and so is not
// a domain. It is therefore already excluded by the domain rule; listing it in
// NON_DOMAIN_DIRS would make that explicit + cheaper.
// ─────────────────────────────────────────────────────────────────────────

export const ARCHIVE_DIR = "_archive";

export interface ArchiveResult {
  domain: string;
  from: string;
  to: string;
  backup: BackupResult;
}

export interface RestoreDomainResult {
  domain: string;
  from: string;
  to: string;
}

function archiveRoot(vaultPath: string): string {
  return join(resolve(vaultPath), ARCHIVE_DIR);
}

// Reject domain names that could escape the vault when joined (path
// separators, "..", null bytes, absolute fragments). Domain names come from
// the CLI here, not readdirSync, so this guard is load-bearing.
function assertSafeDomainName(domain: string): void {
  if (
    typeof domain !== "string" ||
    domain.length === 0 ||
    domain.includes("/") ||
    domain.includes("\\") ||
    domain.includes("\0") ||
    domain === "." ||
    domain === ".."
  ) {
    throw new Error(`invalid domain name: ${JSON.stringify(domain)}`);
  }
}

/**
 * Archive a domain: back it up, then move <vault>/<domain>/ into
 * <vault>/_archive/<domain>/ and set archived=true + archived_at=now in its
 * manifest. Never deletes data. Throws if the domain doesn't exist or an
 * archived copy already exists.
 */
export async function archiveDomain(
  vaultPath: string,
  domain: string,
): Promise<ArchiveResult> {
  assertSafeDomainName(domain);
  const vault = resolve(vaultPath);
  const from = join(vault, domain);
  if (!existsSync(from)) {
    throw new Error(`archiveDomain: domain not found: ${from}`);
  }
  if (!statSync(from).isDirectory()) {
    throw new Error(`archiveDomain: not a directory: ${from}`);
  }
  const root = archiveRoot(vault);
  const to = join(root, domain);
  if (existsSync(to)) {
    throw new Error(`archiveDomain: already archived: ${to}`);
  }

  // BEFORE moving, take a backup of this domain. The whole vault tarball is
  // overkill for a single-domain archive, so we back up just the domain
  // subtree, named after the domain + date.
  const backupOut = defaultDomainBackupPath(domain);
  const backup = await backupDomain({ vaultPath: vault, domain, outputPath: backupOut });

  // Move the domain into _archive/ (create the archive root if needed).
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  renameSync(from, to);

  // Flip the manifest flag IN THE NEW LOCATION. readManifest/writeManifest
  // operate relative to a vault root + domain, so we treat _archive as the
  // "vault root" for this domain.
  setArchivedFlag(root, domain, true, new Date().toISOString());

  return { domain, from, to, backup };
}

/**
 * Restore an archived domain: move it back from <vault>/_archive/<domain>/ to
 * <vault>/<domain>/ and clear the archived flag. Throws if no archived copy
 * exists or a live domain of the same name is already present.
 */
export function restoreDomain(
  vaultPath: string,
  domain: string,
): RestoreDomainResult {
  assertSafeDomainName(domain);
  const vault = resolve(vaultPath);
  const root = archiveRoot(vault);
  const from = join(root, domain);
  if (!existsSync(from)) {
    throw new Error(`restoreDomain: not archived: ${from}`);
  }
  const to = join(vault, domain);
  if (existsSync(to)) {
    throw new Error(`restoreDomain: a live domain already exists at ${to}`);
  }

  // Clear the flag while the domain is still in _archive/ (so the on-disk
  // manifest is correct before the move), then relocate it back to the vault
  // root.
  setArchivedFlag(root, domain, false, null);
  renameSync(from, to);

  return { domain, from, to };
}

/**
 * List the names of archived domains (immediate subdirectories of
 * <vault>/_archive/). Returns [] when nothing is archived.
 */
export function listArchived(vaultPath: string): string[] {
  const root = archiveRoot(vaultPath);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of safeReaddir(root)) {
    if (isDir(join(root, name))) out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// Set/clear archived + archived_at on a domain's manifest. If no manifest
// exists yet, this is a no-op for the flag (a manifest-less domain has no
// archived state to track) — the move itself is what hides/shows it.
function setArchivedFlag(
  baseRoot: string,
  domain: string,
  archived: boolean,
  archivedAt: string | null,
): void {
  const m = readManifest(baseRoot, domain);
  if (!m) return;
  m.archived = archived;
  m.archived_at = archivedAt;
  writeManifest(baseRoot, domain, m);
}

// Default per-domain backup filename, e.g. ~/prevail-archive-wealth-2026-06-06.tar.gz
export function defaultDomainBackupPath(domain: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(homedir(), `prevail-archive-${domain}-${stamp}.tar.gz`);
}

// Back up a single domain subtree to a tar.gz. Mirrors backupVault's tar
// posture (array argv, no shell, exclude secrets) but scopes the archive to
// just <vault>/<domain>/.
export interface BackupDomainArgs {
  vaultPath: string;
  domain: string;
  outputPath: string;
}

export async function backupDomain(args: BackupDomainArgs): Promise<BackupResult> {
  assertSafeDomainName(args.domain);
  const vault = resolve(args.vaultPath);
  const domainPath = join(vault, args.domain);
  if (!existsSync(domainPath)) {
    throw new Error(`backupDomain: domain not found: ${domainPath}`);
  }
  const out = resolve(args.outputPath);
  const outDir = resolve(out, "..");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const argv: string[] = ["-czf", out];
  for (const ex of BACKUP_EXCLUDES) {
    argv.push("--exclude", ex);
  }
  // -C <vault> <domain> → archive contains a single top-level "<domain>/"
  // entry, so it restores cleanly relative to any vault root.
  argv.push("-C", vault, args.domain);

  const proc = Bun.spawn(["tar", ...argv], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar failed (exit ${code}): ${stderr.trim()}`);
  }
  const bytes = statSync(out).size;
  return { archivePath: out, bytes };
}
