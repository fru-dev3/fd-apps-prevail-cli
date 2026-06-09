// Embedded (app-owned) vault — Feature 2 of the master build plan.
//
// The canonical app-owned vault lives at ~/.prevail/vault. New installs default
// here so there's no loose folder to manage; existing external vaults keep
// working and can be migrated in on demand. This module owns the location and a
// non-destructive copy+verify migration, shared by every surface (CLI, desktop,
// tui) so relocation goes through one verified path. It NEVER moves or deletes
// the source — it copies, verifies, and leaves the original in place.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { configDir } from "./config.ts";

/** The app-owned vault location: ~/.prevail/vault. */
export function embeddedVaultPath(): string {
  return join(configDir(), "vault");
}

/** True when `p` already resolves to the embedded location. */
export function isEmbeddedVault(p: string): boolean {
  return resolve(p) === resolve(embeddedVaultPath());
}

/** Count every file (not directory) under `dir`, recursively. 0 if absent. */
export function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else if (entry.isFile()) n += 1;
  }
  return n;
}

export interface MigrateResult {
  dest: string;
  alreadyEmbedded: boolean;
  copied: number; // files verified at the destination after the copy
  sourceFiles: number;
  ok: boolean; // dest file count >= source file count
}

/**
 * Copy a vault tree from `src` into `dest` (default: the embedded location),
 * non-destructively, then verify by file count. Idempotent: if `src` already IS
 * the destination, it's a no-op success. The source is never removed — callers
 * decide whether to archive it after the user confirms.
 */
export function migrateVaultToEmbedded(src: string, dest = embeddedVaultPath()): MigrateResult {
  const sourceFiles = countFiles(src);
  if (resolve(src) === resolve(dest)) {
    return { dest, alreadyEmbedded: true, copied: sourceFiles, sourceFiles, ok: true };
  }
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`source vault not found or not a directory: ${src}`);
  }
  mkdirSync(dest, { recursive: true });
  // Merge-copy the tree; do not clobber the destination wholesale so an
  // existing embedded vault isn't destroyed by a re-run.
  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
  const copied = countFiles(dest);
  return {
    dest,
    alreadyEmbedded: false,
    copied,
    sourceFiles,
    ok: copied >= sourceFiles,
  };
}
