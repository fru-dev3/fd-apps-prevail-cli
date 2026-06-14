#!/usr/bin/env bun
// Vault layout migration v2 → v3.
//
// v3 nests domains under <vault>/domains/<domain> and apps under <vault>/apps/
// (the latter is mostly there already; this also relocates legacy community apps
// from ~/.prevail/apps). The engine READS both layouts (resolveDomainDir falls
// back to legacy), so this migration is OPTIONAL and can run any time — it just
// tidies an existing vault into the canonical shape.
//
// Safety (Hard rule: never lose user data):
//   - DRY RUN BY DEFAULT. Pass --apply to actually move anything.
//   - Idempotent: re-running after a successful move is a no-op.
//   - Per item: move only; if a destination already exists, it is SKIPPED
//     (never overwritten). Same-filesystem moves are atomic renames; cross-fs
//     moves copy → verify file count → only then remove the source.
//   - Writes a VAULT.json schema marker at the end.
//
// Usage:
//   bun scripts/migrate-vault-v3.ts [--vault <path>] [--apply]
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, cpSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { isDomainDir } from "../src/vault.ts";
import { DOMAINS_DIR, APPS_DIR } from "../src/path-safety.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const vaultArg = (() => {
  const i = args.indexOf("--vault");
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
})();

function readVaultPath(): string {
  if (vaultArg) return resolve(vaultArg);
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".prevail", "config.json"), "utf8")) as { vaultPath?: string };
    if (cfg.vaultPath) return resolve(cfg.vaultPath);
  } catch { /* fall through */ }
  console.error("No vault path. Pass --vault <path> or set it in ~/.prevail/config.json");
  process.exit(1);
}

const vault = readVaultPath();
if (!existsSync(vault)) { console.error(`vault not found: ${vault}`); process.exit(1); }

const tag = apply ? "APPLY" : "DRY-RUN";
console.log(`[migrate-v3] ${tag} · vault: ${vault}\n`);

let moved = 0;
let skipped = 0;

// Count files recursively — a cheap post-copy integrity check before removing
// the source on a cross-filesystem move.
function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else n += 1;
  }
  return n;
}

// Move `from` → `to`. Atomic rename on same fs; copy → verify → remove on EXDEV.
// Never removes the source unless the copy is verified.
function safeMove(from: string, to: string): void {
  mkdirSync(join(to, ".."), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const before = countFiles(from);
    cpSync(from, to, { recursive: true });
    const after = countFiles(to);
    if (after < before) throw new Error(`verify failed (${after} < ${before} files) — left source intact at ${from}`);
    rmSync(from, { recursive: true, force: true });
  }
}

// 1) Legacy root-level domains → vault/domains/<domain>
const domainsRoot = join(vault, DOMAINS_DIR);
const NON_DOMAIN = new Set([DOMAINS_DIR, APPS_DIR, "complete", "core", "scripts", ".git", ".claude", ".claude-plugin", "node_modules", "_archive"]);
for (const name of readdirSync(vault)) {
  if (NON_DOMAIN.has(name) || name.startsWith(".")) continue;
  const from = join(vault, name);
  try { if (!statSync(from).isDirectory() || !isDomainDir(from)) continue; } catch { continue; }
  const to = join(domainsRoot, name);
  if (existsSync(to)) { console.log(`  skip domain "${name}" (already in domains/)`); skipped++; continue; }
  console.log(`  move domain "${name}" → domains/${name}`);
  if (apply) safeMove(from, to);
  moved++;
}

// 2) Legacy community apps ~/.prevail/apps/<id> → vault/apps/<id>
const legacyApps = join(homedir(), ".prevail", "apps");
const appsRoot = join(vault, APPS_DIR);
if (existsSync(legacyApps)) {
  for (const id of readdirSync(legacyApps)) {
    if (id.startsWith(".")) continue;
    const from = join(legacyApps, id);
    try { if (!statSync(from).isDirectory()) continue; } catch { continue; }
    const to = join(appsRoot, id);
    if (existsSync(to)) { console.log(`  skip app "${id}" (already in vault/apps/)`); skipped++; continue; }
    console.log(`  move app "${id}" → apps/${id}`);
    if (apply) safeMove(from, to);
    moved++;
  }
}

// 3) Version marker
if (apply) {
  writeFileSync(join(vault, "VAULT.json"), JSON.stringify({ schema: 3, migratedAt: new Date().toISOString() }, null, 2) + "\n");
}

console.log(`\n[migrate-v3] ${tag} complete · ${moved} to move · ${skipped} already migrated`);
if (!apply && moved > 0) console.log("Re-run with --apply to perform the moves.");
