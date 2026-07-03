// Vault layout v4 — the "clean domain" reorg.
//
// A domain folder used to be a flat pile that mixed the user's own files, the
// AI's derived files, and the app's plumbing. v4 sorts every entry into three
// lowercase folders by ownership, with only the two files that DEFINE a domain
// left at its root:
//
//   <domain>/
//     ideal.md          the domain's ideal state (was soul.md) — its target
//     manifest.json     domain config (defines routing/engine/sandbox)
//     source/           what YOU own (goals, config, starters, raw files)
//     memory/           what the AI DERIVED (state, memory, decisions, journal,
//                       skills, threads, briefs) — all regenerable
//     .system/          app plumbing (raw intent ledger, daemon cursors, caches)
//
// This module is the NON-DESTRUCTIVE migrator: it COPIES each entry into its new
// home (never moves/deletes), verifies by file count, and drops a marker. The
// originals stay put so the app keeps working on them until the reader/writer
// switch ships (staged rollout, exactly like migrateToDataLayout). Archiving the
// originals is a separate, explicitly-confirmed step (archiveLegacyDomainV4).

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { countFiles } from "./vault-data-layout.ts";
import { resolveDomainDir, DOMAINS_DIR, dataRoot } from "./path-safety.ts";

export const V4_MARKER = ".prevail-layout-v4";

// Map a domain entry (file or dir name) to its new relative destination under
// the domain dir, or null to LEAVE IT AT THE ROOT (manifest.json, ideal.md, and
// any unknown user file — safest default is to not move what we don't recognize).
export function v4Destination(name: string): string | null {
  const lower = name.toLowerCase();
  const stem = lower.replace(/\.(md|jsonl|json|bak)$/i, "");
  const ext = (lower.match(/\.(md|jsonl|json|bak)$/i)?.[1] ?? "").toLowerCase();

  // Root markers — never moved.
  if (lower === "manifest.json") return null;
  if (lower === "ideal.md" || lower === "soul.md") return "ideal.md"; // soul -> ideal

  // source/  — the user's own material.
  if (lower === "goals.md") return "source/goals.md";
  if (lower === "config.md") return "source/config.md";
  if (lower === "prompts.md") return "source/starters.md"; // kill the "journal" collision
  if (lower === "quickstart.md") return "source/quickstart.md";
  if (lower === "01_prior" || lower === "data") return `source/files/${name}`;

  // memory/  — AI-derived, regenerable.
  if (stem === "state" || stem === "_state") return "memory/state.md";
  if (stem === "memory" || stem === "_memory") return "memory/memory.md";
  if (stem === "decisions" || stem === "_decisions") return `memory/decisions.${ext || "jsonl"}`;
  if (stem === "journal" || stem === "_journal") return ext ? "memory/journal.md" : "memory/journal";
  if (stem === "open-loops") return "memory/open-loops.md";
  if (stem === "_tasks" || stem === "tasks") return `memory/tasks.${ext || "jsonl"}`;
  if (lower === "_skills" || lower === "skills") return "memory/skills"; // both merge here
  if (lower === "_threads") return "memory/threads";
  if (lower === "02_briefs") return "memory/briefs";
  if (lower === "00_current") return "memory/current";

  // .system/  — plumbing: the raw capture ledger, daemon cursors, caches.
  // Raw prompt ledger = the JOURNAL (founder model: journal = literal prompts).
  // Renamed on migration so the file name matches the concept.
  if (stem === "_intents" || stem === "intents") return `.system/journal.${ext || "jsonl"}`;
  if (lower === "_intents.archive.jsonl") return ".system/journal.archive.jsonl";
  if (stem === "_journal" && ext === "jsonl") return `.system/journal.${ext}`; // any raw journal jsonl
  if (stem === "_distill") return `.system/distill.cursor.${ext || "json"}`;
  if (stem === "_skillgen") return `.system/skillgen.cursor.${ext || "json"}`;
  if (stem === "_taskgen") return `.system/taskgen.cursor.${ext || "json"}`;
  if (stem === "_surface") return `.system/surface.cache.${ext || "json"}`;

  // Unknown — leave where it is (a user file we don't recognize).
  return null;
}

export interface V4MoveOp {
  entry: string;
  from: string;
  to: string;
  destRel: string;
}
export interface V4MigrateResult {
  domain: string;
  domainDir: string;
  alreadyMigrated: boolean;
  ops: V4MoveOp[];
  skipped: string[];   // entries left at the root (manifest, ideal, unknowns)
  verifiedFileCount: number;
  applied: boolean;    // false for a dry run
}

/** True once this domain has the v4 marker. */
export function isV4Domain(domainDir: string): boolean {
  return existsSync(join(domainDir, V4_MARKER));
}

/**
 * The path a logical content file lives at, honoring the domain's layout: the v4
 * sub-path on a migrated domain (parent created on demand), else the legacy flat
 * name. The single resolver readers AND writers share so a v4 domain round-trips
 * consistently. A no-op on un-migrated domains (returns the legacy path), so it
 * is safe to route existing writers/readers through it. Mirrors the desktop's
 * paths::v4_content_path.
 */
export function v4ContentPath(domainDir: string, v4Rel: string, legacy: string): string {
  if (isV4Domain(domainDir)) {
    const p = join(domainDir, v4Rel);
    mkdirSync(dirname(p), { recursive: true });
    return p;
  }
  return join(domainDir, legacy);
}

/**
 * Plan (and optionally apply) the v4 reorg for ONE domain. Non-destructive: every
 * op is a recursive copy into the new location; originals are untouched. Pass
 * `apply=false` for a dry run (returns the plan without touching disk).
 */
export function migrateDomainToV4(vaultPath: string, domain: string, apply: boolean): V4MigrateResult {
  const domainDir = resolveDomainDir(vaultPath, domain);
  const empty: V4MigrateResult = { domain, domainDir, alreadyMigrated: false, ops: [], skipped: [], verifiedFileCount: 0, applied: false };
  if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) return empty;
  if (isV4Domain(domainDir)) return { ...empty, alreadyMigrated: true };

  const ops: V4MoveOp[] = [];
  const skipped: string[] = [];
  for (const de of readdirSync(domainDir, { withFileTypes: true })) {
    const name = de.name;
    if (name === V4_MARKER || name === "source" || name === "memory" || name === ".system") continue;
    const destRel = v4Destination(name);
    if (!destRel) { skipped.push(name); continue; }
    ops.push({ entry: name, from: join(domainDir, name), to: join(domainDir, destRel), destRel });
  }

  if (apply) {
    for (const op of ops) {
      mkdirSync(join(op.to, ".."), { recursive: true });
      // recursive+force so _skills/ and skills/ MERGE into memory/skills/.
      cpSync(op.from, op.to, { recursive: true, force: true, errorOnExist: false });
    }
    // Marker last, so a crash mid-copy just re-runs (idempotent).
    try { writeFileSync(join(domainDir, V4_MARKER), `migrated ${new Date().toISOString()}\n`); } catch { /* best effort */ }
  }

  // Verify: the new subtrees should hold at least as many files as we copied in.
  const verifiedFileCount = apply
    ? ["source", "memory", ".system"].reduce((n, d) => n + countFiles(join(domainDir, d)), 0)
    : 0;

  return { domain, domainDir, alreadyMigrated: false, ops, skipped, verifiedFileCount, applied: apply };
}

/** Every domain directory in the vault (v4 container, then v3, then flat root). */
export function listDomainDirs(vaultPath: string): string[] {
  const names = new Set<string>();
  const containers = [join(dataRoot(vaultPath), DOMAINS_DIR), join(vaultPath, DOMAINS_DIR)];
  for (const c of containers) {
    if (!existsSync(c)) continue;
    for (const de of readdirSync(c, { withFileTypes: true })) {
      if (de.isDirectory() && !de.name.startsWith(".") && !de.name.startsWith("_")) names.add(de.name);
    }
  }
  return [...names];
}

/** Migrate (or dry-run) every domain in the vault. */
export function migrateVaultToV4(vaultPath: string, apply: boolean): V4MigrateResult[] {
  return listDomainDirs(vaultPath).map((d) => migrateDomainToV4(vaultPath, d, apply));
}

/**
 * Archive the now-migrated ORIGINAL entries into <domain>/_pre-v4-<stamp>/ so the
 * root is clean. Separate + explicit (never auto-run): only call once the reader
 * switch is live and the new layout is confirmed working. Non-destructive: a
 * rename into an archive dir, not a delete.
 */
export function archiveLegacyDomainV4(vaultPath: string, domain: string, stamp: string): { archiveDir: string; archived: string[] } {
  const domainDir = resolveDomainDir(vaultPath, domain);
  const archiveDir = join(domainDir, `_pre-v4-${stamp}`);
  const archived: string[] = [];
  if (!isV4Domain(domainDir)) return { archiveDir, archived };
  mkdirSync(archiveDir, { recursive: true });
  for (const de of readdirSync(domainDir, { withFileTypes: true })) {
    const name = de.name;
    if (name.startsWith("_pre-v4-") || name === V4_MARKER) continue;
    if (name === "source" || name === "memory" || name === ".system") continue;
    if (v4Destination(name) === null) continue; // leave root markers + unknowns in place
    renameSync(join(domainDir, name), join(archiveDir, name));
    archived.push(name);
  }
  return { archiveDir, archived };
}
