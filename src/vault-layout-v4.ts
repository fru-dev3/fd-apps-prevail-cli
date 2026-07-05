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

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  if (lower === "ideal-state.md") return null;
  // The domain ideal's ONE canonical home is ideal-state.md (what the desktop
  // Ideal State panel edits, the chat preamble injects, and the loop steward
  // reads). Adopt every historical / plausible alias so an ideal authored by
  // hand or by an agent under the "wrong" name self-heals to the canonical
  // file on the next groom pass instead of being invisible to the UI.
  if (
    lower === "ideal.md" ||
    lower === "soul.md" ||
    lower === "ideal_state.md" ||
    lower === "idealstate.md" ||
    lower === "ideal state.md"
  ) {
    return "ideal-state.md";
  }

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
  // Raw per-turn transcript logs (the daily _log/*.md + score/heartbeat jsonl).
  if (lower === "_log") return ".system/log";

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
 * The DIRECTORY home for a logical subdir (e.g. `_log`), honoring the domain's
 * layout. Unlike v4ContentPath, this PREFERS whichever of the v4 or legacy dir
 * already exists on a v4 domain, so a writer/reader never SPLITS content that is
 * still sitting at the legacy path (it keeps appending there until the migrator
 * consolidates it), and a clean v4 domain gets the v4 home. A no-op on legacy
 * domains. Does NOT create the dir — callers mkdir as they already do.
 */
export function v4DirPath(domainDir: string, v4Rel: string, legacy: string): string {
  if (isV4Domain(domainDir)) {
    const v4 = join(domainDir, v4Rel);
    if (existsSync(v4)) return v4;
    const leg = join(domainDir, legacy);
    if (existsSync(leg)) return leg;
    return v4;
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

// =============================================================================
// Consolidation — clean up LEGACY leftovers a non-v4-aware writer re-created at a
// v4 domain's ROOT after the domain was already migrated (the reported bug). This
// is the idempotent second pass the "Rebuild structure" button runs: every root
// entry that has a v4 home (per v4Destination) is MOVED into it, non-destructively.
// A clean domain is a no-op.
// =============================================================================

export interface V4ConsolidateResult {
  domain: string;
  moved: string[];     // entry -> dest, freshly relocated (dest was absent)
  deduped: string[];   // root copy was byte-identical to the v4 copy; removed
  conflicts: string[]; // both kept; the loser parked as <name>.pre-reorg
  merged: string[];    // a dir merged child-by-child into an existing v4 dir
}

/** True once a domain root has no more recognized legacy leftovers to move. */
function sameBytes(a: string, b: string): boolean {
  try {
    const sa = statSync(a), sb = statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch { return false; }
}

// A non-colliding parking name next to `dest`: memory/threads/foo.md ->
// memory/threads/foo.pre-reorg.md (uniquified). Never overwrites.
function preReorgName(dest: string): string {
  const dir = dirname(dest);
  const base = dest.slice(dir.length + 1);
  const dot = base.indexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const ext = dot >= 0 ? base.slice(dot) : "";
  let candidate = join(dir, `${stem}.pre-reorg${ext}`);
  let n = 2;
  while (existsSync(candidate)) { candidate = join(dir, `${stem}.pre-reorg-${n}${ext}`); n++; }
  return candidate;
}

// Place file `src` at `dest`, non-destructively. dest absent -> move. Identical
// bytes -> drop the redundant src. Otherwise keep the RICHER (larger; tie: newer)
// copy at dest and park the loser as <dest>.pre-reorg. Larger-first (not
// newer-first) so a freshly re-seeded EMPTY placeholder (e.g. a stray MEMORY.md)
// can never demote the real distilled content to a sidecar. Never deletes content.
function placeFile(src: string, dest: string): "moved" | "deduped" | "conflict" {
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) { renameSync(src, dest); return "moved"; }
  if (sameBytes(src, dest)) { rmSync(src, { force: true }); return "deduped"; }
  const ss = statSync(src), ds = statSync(dest);
  const srcWins = ss.size > ds.size || (ss.size === ds.size && ss.mtimeMs > ds.mtimeMs);
  if (srcWins) {
    renameSync(dest, preReorgName(dest)); // the older v4 copy becomes the loser
    renameSync(src, dest);                // the newer root copy becomes canonical
  } else {
    renameSync(src, preReorgName(dest));  // the older root copy is parked
  }
  return "conflict";
}

// Merge directory `src` into `dest` child-by-child (files via placeFile, dirs
// recursively). Removes src once it is empty. Used for _threads/, _log/, etc.
function mergeDir(src: string, dest: string, tally: { moved: number; deduped: number; conflicts: number }): void {
  mkdirSync(dest, { recursive: true });
  for (const de of readdirSync(src, { withFileTypes: true })) {
    const cSrc = join(src, de.name), cDest = join(dest, de.name);
    if (de.isDirectory()) { mergeDir(cSrc, cDest, tally); continue; }
    const r = placeFile(cSrc, cDest);
    if (r === "moved") tally.moved++; else if (r === "deduped") tally.deduped++; else tally.conflicts++;
  }
  try { if (readdirSync(src).length === 0) rmdirSync(src); } catch { /* a non-empty remnant stays */ }
}

/**
 * Consolidate any legacy leftovers still at a v4 domain's root into their v4
 * homes. Non-destructive + idempotent: a clean domain (or a non-v4 domain) is a
 * no-op. Reuses v4Destination for the mapping — never invents new destinations.
 */
export function consolidateDomainV4Leftovers(vaultPath: string, domain: string): V4ConsolidateResult {
  const domainDir = resolveDomainDir(vaultPath, domain);
  const res: V4ConsolidateResult = { domain, moved: [], deduped: [], conflicts: [], merged: [] };
  if (!existsSync(domainDir) || !statSync(domainDir).isDirectory() || !isV4Domain(domainDir)) return res;
  for (const de of readdirSync(domainDir, { withFileTypes: true })) {
    const name = de.name;
    if (name === V4_MARKER || name === "source" || name === "memory" || name === ".system") continue;
    if (name.startsWith("_pre-v4-")) continue; // the migrator's own backup
    const destRel = v4Destination(name);
    if (!destRel) continue; // manifest.json and unknown user files stay put
    const src = join(domainDir, name);
    const dest = join(domainDir, destRel);
    if (dest === src) continue; // already at its canonical root home (e.g. ideal.md)
    if (de.isDirectory()) {
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(src, dest);
        res.moved.push(`${name} -> ${destRel}`);
      } else {
        const t = { moved: 0, deduped: 0, conflicts: 0 };
        mergeDir(src, dest, t);
        res.merged.push(`${name} -> ${destRel} (moved ${t.moved}, deduped ${t.deduped}, kept-both ${t.conflicts})`);
      }
    } else {
      const r = placeFile(src, dest);
      if (r === "moved") res.moved.push(`${name} -> ${destRel}`);
      else if (r === "deduped") res.deduped.push(`${name} (identical to ${destRel}, root copy removed)`);
      else res.conflicts.push(`${name} vs ${destRel} (kept both, loser parked as .pre-reorg)`);
    }
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// The vault map: ONE canonical, harness-neutral document (<vault>/VAULT.md)
// that teaches ANY AI - Claude, Codex, Gemini, Antigravity, local models, plain
// scripts - how the entire vault is structured: where every concept lives, the
// exact formats, which daemons write what, what may be edited, what must never
// be touched, and how to integrate from outside the app. Harness convention
// files (CLAUDE.md / AGENTS.md / GEMINI.md) are SYMLINKS to VAULT.md where the
// filesystem allows (one file, zero drift); on filesystems without symlinks
// (exFAT, some SMB mounts) they fall back to a tiny pointer shim. All managed
// text is marker-fenced; user content outside the markers survives.
// ─────────────────────────────────────────────────────────────────────────────

const MAP_BEGIN = "<!-- BEGIN PREVAIL VAULT MAP (auto-managed - edits inside this block are overwritten on groom) -->";
const MAP_END = "<!-- END PREVAIL VAULT MAP -->";

export function vaultMap(): string {
  return [
    MAP_BEGIN,
    "# VAULT.md - the complete map of this Prevail vault",
    "",
    "This vault IS the product; the Prevail app is one client over these files.",
    "Any AI or script may work on the vault directly. Follow this map exactly:",
    "correctly named files appear in the app (panels re-read on open); misnamed",
    "KNOWN files self-heal to canonical names on app launch; unknown files stay",
    "where you put them.",
    "",
    "FINDING THE VAULT: never assume its path - it differs per machine and",
    "deployment. Resolve it from ~/.prevail/config.json (the vaultPath field),",
    "or ask the running app (Details panel). This file sits at that root.",
    "",
    "BEFORE EDITING: read 200 bytes of any memory/state.md - if it is not plain",
    "markdown, this vault is ENCRYPTED at rest; do NOT hand-edit anything, use",
    "the app or CLI instead.",
    "",
    "## Layout law",
    "```",
    "<vault>/",
    "  VAULT.md            this map (canonical; CLAUDE/AGENTS/GEMINI.md link here)",
    "  build/              vault-global config + derived data",
    "    ideal-state.md    the user's GLOBAL constitution (layered under domains)",
    "    user.md           who the user is (injected into chats)",
    "    _meta/            machine-managed ledgers - NEVER hand-edit (details below)",
    "  data/",
    "    domains/<slug>/   one life domain per dir (lowercase slug)",
    "    apps/<id>/        one connected app per dir",
    "```",
    "No other root-level files or directories. Ever.",
    "",
    "## A domain - data/domains/<slug>/",
    "```",
    "  manifest.json       identity + settings (JSON, fields below)",
    "  ideal-state.md      THE domain ideal: purpose, current reality, target,",
    "                      metrics, habits/routines, what to avoid",
    "  _tasks.md           task board (line grammar below)",
    "  _loops.json         standing loops (schema below)",
    "  _loops_runtime.json loop run history/pending - machine-managed, NEVER edit",
    "  _surface.json       suggested questions cache - machine-managed, NEVER edit",
    "  source/             the user's own material: goals.md, config.md, any files",
    "  memory/             AI-maintained knowledge",
    "    state.md          current-state snapshot (autoState caveat below)",
    "    memory.md         durable long-term memory (injected into every chat)",
    "    threads/          chat transcripts (<slug>.md + <slug>.jsonl) - NEVER edit",
    "  .system/            journal.jsonl (provenance ledger), log/ - NEVER edit",
    "  skills/<skill-id>/SKILL.md    one skill per dir",
    "  skills/_archive/<skill-id>/   archived skills (invisible to the app)",
    "```",
    "Create a NEW domain: make the dir + a manifest.json or ideal-state.md; the",
    "app discovers it on the next scan. Renaming a domain = renaming its dir",
    "(update references in _loops.json and app manifests that name it).",
    "",
    "### manifest.json fields (safe to edit)",
    "- identity: { name, label, emoji, summary }",
    "- goals: [\"string\", ...]",
    "- config: { cli, model, autoState }  - autoState true lets the state daemon",
    "  consolidate memory/state.md; put durable truths in ideal-state.md /",
    "  source/ / memory/memory.md, or set autoState false to hand-manage state.",
    "- routing: { keywords: [], channels: [], default: bool } - inbound routing",
    "- heartbeat: { enabled: bool, routines: [{ id, schedule, enabled? }] }",
    "  schedule = 5-field cron OR 'hourly' | 'daily [HH:MM]' | 'weekly [day] [HH:MM]'.",
    "  A routine id matching skills/<id>/ may take its cadence from that SKILL.md.",
    "- privacy: { localOnly: bool } - true pins this domain to local models only",
    "Malformed fields are silently dropped by the reader; keep valid JSON.",
    "",
    "### _tasks.md - one task per line",
    "`- [ ] Task text @2026-07-15 ~priority:high ~owner:ai ~status:doing`",
    "- `- [ ]` open, `- [x]` done · `@YYYY-MM-DD` due date",
    "- `~priority:` high | critical (absent = normal)",
    "- `~owner:ai` hands the task to the AI steward: the loops daemon picks up",
    "  open AI-owned tasks (a few per pass), DOES them with real tools when",
    "  autonomy allows, then sets `~status:review` (done, awaiting user accept)",
    "  or `~status:blocked` (needs the user) - both surface in the Decision Inbox.",
    "- `~status:` todo | doing | blocked | review | icebox",
    "- Leave `~id:` and `+added` tokens to the app.",
    "",
    "### _loops.json - standing, self-driving routines",
    "```json",
    "{ \"desiredState\": \"one-line target for the domain\",",
    "  \"loops\": [{ \"id\": \"rent-watch\", \"name\": \"Rent Watch\",",
    "    \"purpose\": \"what this loop continuously achieves\",",
    "    \"kind\": \"steward\",           // steward | briefing | scout",
    "    \"type\": \"open\",              // open | closed (closed ends when condition met)",
    "    \"cadence\": \"weekly\",         // daily | weekly | monthly",
    "    \"autonomy\": \"auto\",          // suggest | tasks | ask | auto",
    "    \"channel\": \"gmail\",          // briefing loops only: log | gmail | telegram",
    "    \"signals\": [], \"condition\": \"\", \"evaluation\": \"\",",
    "    \"enabled\": true, \"status\": \"active\" }] }",
    "```",
    "Autonomy semantics: suggest = propose only · tasks = may file tasks · ask =",
    "propose, consequential actions wait for approval · auto = ACTS with real",
    "tools (files, web, connectors); money / contacting others / irreversible",
    "actions ALWAYS queue for user approval regardless. Loops read ideal-state.md",
    "as their target; with no ideal an auto loop drafts one itself.",
    "",
    "### skills/ - how skills behave",
    "- Discovery: any skills/<skill-id>/SKILL.md dir is a skill; `description:`",
    "  near the top is its summary; optional `cadence:` feeds heartbeat routines.",
    "- In chat: attached via /<skill-name>; an app's primary skill auto-attaches",
    "  in that app's chat. Skill bodies are injected into the prompt.",
    "- Usage is metered into build/_meta/skill_usage.json (machine-managed);",
    "  `prevail skill-usage report` ranks by real use and flags unused/dormant.",
    "- Archive = MOVE the dir to skills/_archive/<id>/ (never delete);",
    "  `prevail skill-usage archive|unarchive <domain> <id>` does it safely.",
    "",
    "## An app - data/apps/<id>/",
    "```",
    "  manifest.json   integration: api|oauth|browser|mcp|manual · domains: []",
    "                  account: { label }   which identity of a multi-account",
    "                                       connector this app instance is",
    "                  refresh: { every }   sync cadence · enabled: bool",
    "                  autonomy: read-only|act · model: per-app default",
    "  SKILL.md        how to operate this app",
    "  skills/         its runnable skills (learn/replay/sync)",
    "  _scope/         the app's own chat space - NEVER edit",
    "```",
    "Google specifics: accounts are MACHINE-LOCAL gws profiles (~/.config/gws*);",
    "the manifest account.label binds this app to one of them. With several",
    "accounts and no binding/pick, the connector refuses rather than guess.",
    "",
    "### Creating apps by hand (import pipelines welcome)",
    "Make data/apps/<id>/ with any of: manifest.json (partial is fine), SKILL.md,",
    "skills/<skill-id>/SKILL.md, data files. Connecting the app from the UI (or",
    "`prevail connectors`) ADOPTS the folder: missing canonical manifest fields",
    "are filled in, your values and files are never overwritten, domains are",
    "unioned. A folder with no manifest is adopted the same way. Minimal useful",
    "manifest: { \"id\": \"<dir-name>\", \"name\": \"...\", \"domains\": [\"money\"],",
    "\"integration\": \"api|oauth|browser|mcp|manual\" }.",
    "",
    "## Daemons - exactly what writes what",
    "- Loops daemon: runs due loops; writes _loops_runtime.json, files tasks in",
    "  _tasks.md, delivers briefings (journal / Gmail-to-self), logs to",
    "  build/_meta activity + action audit.",
    "- State consolidator (per-domain, only when manifest.config.autoState=true):",
    "  rewrites memory/state.md from recent activity.",
    "- Intents distiller: reads journals + capture streams; writes",
    "  build/_meta/intents_distilled.json.",
    "- Skill/task generators: may add skills/<id>/ and _tasks.md lines from",
    "  captured activity.",
    "- Capture: harness hooks + transcript sync append",
    "  build/_meta/prompts/<tool>.jsonl (schema below).",
    "- Surface: writes _surface.json suggested questions per domain.",
    "- Groom (app launch): adopts misnamed known files (ideal.md/soul.md/",
    "  ideal_state.md -> ideal-state.md), maintains this map + harness links.",
    "- Multi-machine: the vault syncs BETWEEN machines; ~/.config, credentials,",
    "  keychains are per-machine. Processing daemons run on the HUB role machine;",
    "  capture runs everywhere. Do not assume another machine's credentials.",
    "",
    "## Ledgers and their schemas (read-only for agents)",
    "- Domain journal .system/journal.jsonl - one JSON object per prompt:",
    "  { kind:'intent', ts(ms), session, thread, domain, surface, cli, model,",
    "    model_id, message, prompt, prefs, host, app, app_version, os,",
    "    engine_version, tz, meta_v }",
    "- Capture stream build/_meta/prompts/<tool>.jsonl:",
    "  { ts(ISO), epoch_ms, tool, session, cwd, prompt, source:'push'|'sync', host }",
    "Append through `prevail capture ingest` or the app - never by hand.",
    "",
    "## Integrating from OUTSIDE the app",
    "- CLI (`prevail`): chat --domain <slug> (grounded chat) · agent-run (act",
    "  mode) · loops --once / --run-loop (run loops now) · briefing run ·",
    "  connectors list|set <id> domains|account|model|refresh|enabled ·",
    "  skill-usage used|report|archive|unarchive · capture ingest|sync ·",
    "  vault migrate-v4 (groom) · role get|set hub|client · telegram setup",
    "- MCP: `prevail mcp` serves vault tools (chat, council, tasks, loops,",
    "  memory, intents, apps) to any MCP-capable client.",
    "- Writes that contact people / spend money / are irreversible queue in the",
    "  app's Needs-you inbox for one-tap approval; design integrations to expect",
    "  that gate rather than fight it.",
    "- Two guardrails are enforced IN CODE at execution and cannot be prompted",
    "  around: (1) email policy - mail to anyone but the user's own accounts is",
    "  drafted (or refused) for the user to send themself; (2) sensitive egress",
    "  guard - outbound content to another party carrying PII, money figures,",
    "  health/legal/salary/strategy details, or verbatim quotes is HELD until",
    "  the user releases that exact action. (3) action gateway - connector",
    "  writes (claude.ai connectors, Composio, any MCP server) are held by a",
    "  tool hook and queue for approval the same way; an approved act is a",
    "  single-use grant consumed by retrying the exact same tool call. Do not",
    "  attempt workarounds; tell the user what approval is needed instead.",
    "",
    "## NEVER touch",
    "build/_meta/ (ledgers, caches, pending approvals) · any .system/ ·",
    "memory/threads/ · _loops_runtime.json · _surface.json · app _scope/ dirs.",
    "Machine-managed; hand edits corrupt ledgers or are overwritten.",
    "",
    "## Refresh + self-healing semantics",
    "- App panels re-read files when opened: navigate away and back after edits.",
    "- Ideal aliases (ideal.md, soul.md, ideal_state.md, idealstate.md) adopt to",
    "  ideal-state.md on app launch; legacy flat names (_state.md, _memory.md,",
    "  soul.md) migrate into the layout above.",
    MAP_END,
    "",
  ].join("\n");
}

// Kept for callers/tests that predate the rename.
export function vaultAgentContract(): string {
  return vaultMap();
}

const SHIM_BEGIN = "<!-- BEGIN PREVAIL SHIM (auto-managed) -->";
const SHIM_END = "<!-- END PREVAIL SHIM -->";

function shimBody(): string {
  return [
    SHIM_BEGIN,
    "This vault's structure, formats, editing rules, and integration points are",
    "documented in ONE canonical, harness-neutral file: **read `VAULT.md` in this",
    "directory before creating or editing anything here.**",
    SHIM_END,
    "",
  ].join("\n");
}

// Replace a marker-fenced block inside existing content (or append/create).
function upsertBlock(existing: string, begin: string, end: string, block: string): string {
  const bi = existing.indexOf(begin);
  const ei = existing.indexOf(end);
  if (bi !== -1 && ei !== -1 && ei > bi) {
    return existing.slice(0, bi) + block.trimEnd() + existing.slice(ei + end.length);
  }
  if (existing.trim()) return `${existing.trimEnd()}\n\n${block}`;
  return block;
}

// Ensure one harness convention file points at VAULT.md. Preferred form: a real
// SYMLINK (one file on disk, zero drift - the harness auto-loads the full map).
// Fallbacks, in order: keep a correct existing symlink; preserve user content
// by upserting the pointer block; plain pointer file when the filesystem
// refuses symlinks (exFAT, some SMB/Windows setups).
function ensureHarnessLink(vaultPath: string, file: string): boolean {
  const p = join(vaultPath, file);
  try {
    let st: import("node:fs").Stats | null = null;
    try { st = lstatSync(p); } catch { /* absent */ }
    if (st?.isSymbolicLink()) {
      try {
        if (readlinkSync(p) === "VAULT.md") return false; // already correct
        rmSync(p);
      } catch { /* fall through to recreate */ }
    } else if (st) {
      const existing = readFileSync(p, "utf8");
      const stripped = existing
        .replace(new RegExp(`${SHIM_BEGIN}[\\s\\S]*?${SHIM_END}`), "")
        .replace(/<!-- BEGIN PREVAIL[\s\S]*?END PREVAIL[^>]*-->/g, "")
        .trim();
      if (stripped) {
        // Real user content lives here - never replace with a link; keep the
        // file and make sure the pointer block is present and current.
        const next = upsertBlock(existing, SHIM_BEGIN, SHIM_END, shimBody());
        if (next !== existing) { writeFileSync(p, next); return true; }
        return false;
      }
      rmSync(p); // only our own managed text - safe to upgrade to a symlink
    }
    try {
      symlinkSync("VAULT.md", p);
      return true;
    } catch {
      writeFileSync(p, shimBody()); // filesystem refused symlinks - pointer file
      return true;
    }
  } catch {
    return false;
  }
}

// Write/refresh the canonical VAULT.md and the per-harness links to it.
// Idempotent; user content outside managed blocks survives.
export function writeVaultAgentContract(vaultPath: string): { ok: boolean; path: string; updated: boolean } {
  let updated = false;
  try {
    const p = join(vaultPath, "VAULT.md");
    let existing = "";
    try { existing = readFileSync(p, "utf8"); } catch { /* new file */ }
    const next = upsertBlock(existing, MAP_BEGIN, MAP_END, vaultMap());
    if (next !== existing) { writeFileSync(p, next); updated = true; }
    for (const shim of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      if (ensureHarnessLink(vaultPath, shim)) updated = true;
    }
    return { ok: true, path: p, updated };
  } catch {
    return { ok: false, path: join(vaultPath, "VAULT.md"), updated: false };
  }
}
