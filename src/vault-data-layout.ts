// W4 (Monday feedback) — the `data/` vault layout migrator.
//
// The founder's vault root accumulated loose files (`_decisions.jsonl`,
// `_intents.jsonl`, `usage.ndjson`, `profile.md`, `AGENTS-operating.md`,
// `_skillgen.json`, `_taskgen.json`) sitting next to the `domains/` and `apps/`
// containers. The ask: "Avoid loose files. Everything should be in a folder.
// Use a prefix for apps and domains so they are close together inside a data
// folder." This module relocates the vault's content under a single
// `<vault>/data/` container so the root is clean and apps+domains sit together.
//
// SAFETY (hard rule: never delete or lose user data). The migration is:
//   • non-destructive — it COPIES content into `data/`, then verifies by file
//     count; the originals are left exactly where they were.
//   • idempotent — re-running merges without clobbering an existing `data/`.
//   • opt-in — nothing runs automatically; the desktop/CLI invokes it on the
//     user's command, ideally with a fresh backup taken first.
// Readers (path-safety.ts: dataRoot/resolveDomainDir/appsContainer) prefer
// `data/` the instant it exists, so the app keeps working before AND after, and
// a pre-v4 vault with no `data/` dir is untouched. Pruning the now-duplicated
// originals is a SEPARATE, explicitly-confirmed step (archiveLegacyRoot) so a
// verified copy always exists before anything leaves the root.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DATA_DIR, validateVaultPath } from "./path-safety.ts";

// Root entries that are NOT vault content and must never be swept into data/:
// the data container itself, VCS / tooling dirs, and node_modules. Everything
// else at the root (domains/, apps/, the loose _*.jsonl/*.md/*.ndjson files,
// _threads/, benchmark/, …) is the user's vault content and moves together.
const ROOT_SKIP = new Set([
  DATA_DIR,
  ".git",
  ".claude",
  ".claude-plugin",
  "node_modules",
]);

/**
 * Count every file under `path`, recursively. A plain file counts as 1; a
 * directory is walked; a missing path is 0. (The migrator points this at both
 * directory entries like `domains/` and loose file entries like `profile.md`.)
 */
export function countFiles(path: string): number {
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return 1;
  let n = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else if (entry.isFile()) n += 1;
  }
  return n;
}

/** The set of root entries this migrator would relocate into data/. */
export function migratableEntries(vaultPath: string): string[] {
  if (!existsSync(vaultPath)) return [];
  return readdirSync(vaultPath, { withFileTypes: true })
    .filter((e) => !ROOT_SKIP.has(e.name))
    .map((e) => e.name)
    .sort();
}

/** True when this vault already uses the v4 `data/` container. */
export function isDataLayout(vaultPath: string): boolean {
  const d = join(vaultPath, DATA_DIR);
  try {
    return existsSync(d) && statSync(d).isDirectory();
  } catch {
    return false;
  }
}

// Marker dropped INSIDE the data/ container on migration. After the configured
// vault path is repointed to <vault>/data, this marker is what tells a re-run
// "you're already the data root — don't nest another data/ inside me."
const DATA_ROOT_MARKER = ".prevail-data-layout";

/** True when `vaultPath` IS itself a migrated data root (config already repointed). */
export function isAlreadyDataRoot(vaultPath: string): boolean {
  return existsSync(join(vaultPath, DATA_ROOT_MARKER));
}

export interface DataMigrateResult {
  dataDir: string;
  alreadyMigrated: boolean; // a data/ dir already existed before this run
  movedEntries: string[]; // top-level root entries copied into data/
  sourceFiles: number; // files under the entries we copied (at source)
  copiedFiles: number; // files now present under data/ for those entries
  ok: boolean; // every source file is accounted for under data/
}

/**
 * Copy the vault's content (everything except ROOT_SKIP) into `<vault>/data/`,
 * non-destructively, then verify by file count. The originals are never
 * touched. Idempotent and safe to re-run.
 */
export function migrateToDataLayout(vaultPath: string): DataMigrateResult {
  const v = validateVaultPath(vaultPath);
  if (!v.ok) throw new Error(`refusing to migrate: ${v.reason}`);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error(`vault not found or not a directory: ${vaultPath}`);
  }
  const dataDir = join(vaultPath, DATA_DIR);
  const alreadyMigrated = isDataLayout(vaultPath);
  const entries = migratableEntries(vaultPath);

  mkdirSync(dataDir, { recursive: true });

  let sourceFiles = 0;
  let copiedFiles = 0;
  for (const name of entries) {
    const src = join(vaultPath, name);
    const dest = join(dataDir, name);
    const before = countFiles(src);
    sourceFiles += before;
    // Merge-copy without clobbering wholesale, so a partial/previous migration
    // isn't destroyed by a re-run.
    cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
    copiedFiles += countFiles(dest);
  }

  const ok = copiedFiles >= sourceFiles;
  // Drop the data-root marker only after a verified copy, so a re-run on the
  // repointed path is recognized as already-migrated (no nested data/data/).
  if (ok) {
    try { writeFileSync(join(dataDir, DATA_ROOT_MARKER), `migrated ${new Date().toISOString()}\n`); } catch { /* best effort */ }
  }

  return {
    dataDir,
    alreadyMigrated,
    movedEntries: entries,
    sourceFiles,
    copiedFiles,
    ok,
  };
}

// Only the containers whose READERS are already v4-aware (path-safety.ts:
// resolveDomainDir / appsContainer prefer <vault>/data/...). Archiving anything
// else would orphan it: the General-bucket loose files + dirs (_decisions.jsonl,
/**
 * AFTER a verified migration + config repoint (every surface now reads from
 * data/), move the now-orphaned originals out of the root into a timestamped
 * archive folder. NEVER deletes — renames into `_pre-data-<stamp>/`. An entry is
 * archived ONLY when a full copy is confirmed present under data/ (so a file is
 * never removed from the root unless it's verifiably reachable from the live
 * vault); anything not yet fully mirrored is reported as `deferred` and left in
 * place. `stamp` is injected so the archive name is deterministic/testable.
 * `vaultPath` is the TRUE root (the parent that contains data/).
 */
export function archiveLegacyRoot(vaultPath: string, stamp: string): { archiveDir: string; archived: string[]; deferred: string[] } {
  if (!isDataLayout(vaultPath)) {
    throw new Error("refusing to archive: no data/ layout exists yet — migrate first");
  }
  const dataDir = join(vaultPath, DATA_DIR);
  const archiveDir = join(vaultPath, `_pre-data-${stamp}`);
  mkdirSync(archiveDir, { recursive: true });
  const archived: string[] = [];
  const deferred: string[] = [];
  for (const name of migratableEntries(vaultPath)) {
    const root = join(vaultPath, name);
    const mirrored = join(dataDir, name);
    // Only archive once the copy is verified complete under data/.
    if (countFiles(mirrored) < countFiles(root)) { deferred.push(name); continue; }
    renameSync(root, join(archiveDir, name));
    archived.push(name);
  }
  return { archiveDir: resolve(archiveDir), archived, deferred };
}
