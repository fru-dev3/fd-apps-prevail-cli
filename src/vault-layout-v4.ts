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
    "    ideal-state.versions/  earlier texts of ideal-state.md, one <ISO time>.md",
    "                      per save (kept for restore, never hand-edited)",
    "    user.md           who the user is (injected into every chat, on every",
    "                      path). The ONE profile file; an older _profile.md is",
    "                      folded in on groom and kept as _profile.md.pre-user-<date>",
    "                      Frontmatter birthday: MM-DD (optional) marks a fresh start.",
    "    chief-of-staff.md the user's chief of staff: frontmatter name (the user",
    "                      chooses it) and voice; ## Limits (usd, minutes per",
    "                      job), ## Never pull in (domains), ## What I've learned.",
    "                      Frontmatter handoff: auto | offer | off (jobs judged from chat);",
    "                      holds: ask (default) | alone (protected blocks on your",
    "                      own calendar may be created without asking).",
    "                      General is their home: a General chat speaks as them.",
    "    specialists/<id>.md  the user's own specialists and overrides of built-ins",
    "                      (frontmatter id, name, family, returns, ceiling read |",
    "                      write-vault | draft | act-ask | act, tools, budget,",
    "                      handoff, done_when; ## Mandate, ## Method, ## Never)",
    "                      The app's Edit saves it; the file it replaces and any",
    "                      Reset go to specialists/.versions/<id>.<ISO>.md (never",
    "                      deleted), each save a line in _meta/specialists/ledger.jsonl",
    "                      A preset names base: <built-in id> and never goes past it",
    "                      (ceiling, tools); pack: <id> marks one a vertical pack",
    "                      installed (`prevail packs list|install|uninstall`, ledger",
    "                      in _meta/packs/ledger.jsonl). An outside agent has",
    "                      endpoint: https://..., tool:, calls_per_day: (the file is",
    "                      the allowlist): it gets only the brief, each call waits",
    "                      for your yes in the Inbox, calls in",
    "                      _meta/specialists/outside.jsonl. Made by talking:",
    "                      `prevail specialists draft|create`",
    "                      Earlier texts in chief-of-staff.versions/<ISO time>.md",
    "    playbooks/<id>.json  the user's playbooks (steps skill | agent |",
    "                      synthesize | glance | specialist | task; a synthesize",
    "                      output may use {date}); a specialist step { specialist",
    "                      or specialists, brief, uses: [step ids], gate: stop,",
    "                      approval: ask } runs as a job; draft: true marks one",
    "                      saved from chat and not yet adopted; a loop with",
    "                      playbook: <id> runs one on its cadence, or with",
    "                      on: <radar kind>[:words] once per new radar item",
    "                      (the Sentinel's events). Scheduled and event runs land",
    "                      in the Inbox until seen (`prevail playbook inbox|seen|",
    "                      trigger <id> --domain d --cadence c | --on k`).",
    "                      `prevail playbook rows|show|save <job>|adopt|run --json`",
    "    compass.md        the Compass, in the user's own words, as a chain where each",
    "                      level references the one above: ~schema:2 under the title;",
    "                      ## Purpose (why I exist), ## Values (- Title ~id:v-x ~rank:N,",
    "                      then indented words: \"<quote>\", enough:), ## Mission",
    "                      statement (- ~id:st-x ~serves:v-x,v-y: what I do, for",
    "                      whom), ## Vision (- ~id:vi-x ~statement:st-x), ## Objectives",
    "                      (- ~id:o-x ~vision:vi-x ~metric:<metric or state variable>",
    "                      ~target:N ~due:D: measurable outcomes), ## Goals (- [ ] Title",
    "                      ~id:g-x ~objective:o-x ~serves:v-x",
    "                      ~status:proposed|confirmed|prototyping|active|paused|achieved|released,",
    "                      indented why:, outcome:, obstacle:, plan: (if ... then ...),",
    "                      expect: 1-5, initiative: lines (the strategic initiatives;",
    "                      p- ids; a chosen one runs as a project); then the supporting",
    "                      sections ## Roles, ## Non-negotiables, ## Negotiables,",
    "                      ## Routines, ## Capacity. A file without ~schema:2 reads",
    "                      ## Mission as Purpose and path: as initiative:; groom",
    "                      migrates it once (snapshot to compass.versions/ first). In a",
    "                      schema 2 file ## Mission is the mission statement. Values",
    "                      serve the one purpose and a vision (objective) with no",
    "                      token links to the only statement (vision), implicitly.",
    "                      Links are never forced: `prevail compass tree --json` lists",
    "                      every node with parents and children and what is not",
    "                      linked per level; `compass links|link accept|decline <id>|",
    "                      link <goal> <objective>`; `compass bootstrap --chain`",
    "                      drafts the statement, vision and objectives, quoted. A goal",
    "                      goes active only with its",
    "                      WOOP, until then it is confirmed), ## Non-negotiables (~check:),",
    "                      ## Negotiables (trade:), ## Capacity (hours_for_goals_wk: N,",
    "                      money_for_goals_mo: N, stress_budget: N, meeting_hours_wk: N,",
    "                      work_hours_wk: N; the time review warns when next week's",
    "                      calendar goes past them). A path line may",
    "                      carry hours:, usd:, stress:, needs: (conditions), effects:",
    "                      (tags, or variable deltas like dinners_home_wk-2) and",
    "                      values: (v-x -1, v-y +2); the conflict detector reads them.",
    "                      ~check: names a state variable (sleep_hours, spend_usd_mo,",
    "                      checkin.calm, away_days_yr, dinners_home_wk, new_debt_usd",
    "                      ...) and is enforced in code. ~status:proposed marks",
    "                      a drafted line not yet confirmed (never injected); a bare",
    "                      ~local keeps a line off cloud models. Unknown lines kept.",
    "                      ## Routines (- Title ~id:rt-x ~cadence:daily|weekly|monthly|",
    "                      <n>x-week|<n>d ~metric:m-x ~serves:v-x): measured as rolling",
    "                      rates by their metric; `prevail radar routines bootstrap`",
    "                      drafts them, quoted, from each domain's Habits and routines.",
    "                      A chosen path's expect: line may be a metric check",
    "                      (m-workouts>=3) the radar compares each week.",
    "                      Paths (shown as initiatives): `prevail compass paths <goal>",
    "                      --generate` proposes 6 to 8 with forced variety; code",
    "                      drops those that break a rule, overrun ## Capacity or",
    "                      are dominated; 2-3 land as path: lines ~status:proposed",
    "                      ~kind:low-effort|capital|skill|social|change-target|do-nothing",
    "                      with why:, hours:, usd:, stress:, values:, expect:, stop:,",
    "                      swap: (the even-swap sentence). `compass path choose",
    "                      <id> [--until D]` sets ~status:chosen ~until: ~approval:ask,",
    "                      installs its playbooks (playbooks: ids) on a loop in the",
    "                      goal's domain and a first task; `path retire <id>",
    "                      --because T` stops its loops (because:). `compass paths",
    "                      check|review` (weekly, quarterly).",
    "                      Confirmed lines go into every chat turn and MCP read_compass.",
    "                      `prevail compass show|bootstrap|confirm|drop --json`",
    "    compass.versions/ the file before each change, one <ISO time>.md each",
    "                      (`prevail compass history` reads them: when each value and",
    "                      role appeared, moved rank or was dropped)",
    "    household.json    the household (Goals G5): members with consent per person",
    "                      (compass, metrics), both off until the member says yes",
    "                      (their own name typed to agree); off works at once",
    "    household/<id>/compass.md  a member's own Compass, kept only with their",
    "                      compass consent; household/shared.md shared goals",
    "                      (- [ ] Title ~id:sg-x ~members:me,<id> ~hours:N ~usd:N);",
    "                      household/_archive/<id>-<date>/ a removed member (never",
    "                      deleted). `prevail compass household ...`",
    "    exports/compass-constitution-<date>.md  the confirmed Compass as a",
    "                      constitution any AI can read (`prevail compass export`;",
    "                      never ~local or proposed lines)",
    "    metrics.md        the metrics registry (format under Ledgers below).",
    "                      ~pack:<id> marks a metric a vertical pack added (an",
    "                      indented ask: line is its weekly question); ~family:yes a",
    "                      family metric: numbers carry who logged them (attrs.member)",
    "                      and count only while that member shares their numbers",
    "                      (household metrics consent), never in the owner's own.",
    "                      `prevail metrics say <id> <n> [--member id] | family [add] |",
    "                      packs`",
    "    _meta/            machine-managed ledgers - NEVER hand-edit (details below)",
    "      jobs/<run-id>/  one playbook run: run.json and what its steps wrote;",
    "                      or one job the chief of staff staffed: job.json (ask,",
    "                      owner / consulted / informed domains, team, effort,",
    "                      budget, status, cost), steps/<n>-<specialist>.json (passes,",
    "                      checks, cost), result.json, filed.jsonl (each write to a",
    "                      domain, for Undo), drafts.md (never sent), build/ (a",
    "                      Builder's files, never run), undone/. A playbook's",
    "                      specialist step is a job <run-id>-<step id>. job.json",
    "                      actions: what the Operator named, each with the broker's",
    "                      answer (blocked | asks | done | failed | declined); one",
    "                      that asks waits in the Inbox, Allow runs it.",
    "                      jobs/inbox-seen.json  scheduled and event runs already seen",
    "      triggers.jsonl  each radar item that fired an event loop (once, ever)",
    "      staffing.jsonl  every Adjust of a job (learned after two alike)",
    "      compass/        ledger.jsonl (every status change: ts, id, from, to,",
    "                      reason, evidence, by), proposals.jsonl (drafted",
    "                      lines with the quote and the file it came from, and",
    "                      candidates heard in chat with src chat), interview.json",
    "                      (where the Compass conversation stands), signals.json",
    "                      (each state variable: value, source, age), graph.json",
    "                      (serves, competes, interferes, enables, synergy, breaks",
    "                      edges with evidence; conflicts; model answers cached by",
    "                      content hash), conflicts.jsonl (accepted or resolved",
    "                      tensions), alignment.json (the weekly roll-up: matters",
    "                      vs lived, attention per value, Needs you), paths.json",
    "                      (every proposed path per goal with its verdict and the",
    "                      reason it was left out, and its playbook drafts),",
    "                      installs.jsonl (what choosing a path installed),",
    "                      path-checks.json (the weekly expectation check),",
    "                      quarter.json (the last quarterly review), links.json",
    "                      (proposed chain links: goal to objective, task to",
    "                      initiative, each with the quote that suggested it, by",
    "                      bootstrap, conversation or code; proposed | accepted |",
    "                      declined)",
    "      commitments/    filed.jsonl (each commitment or waiting-for filed from",
    "                      chat, sent mail or meeting notes, for Undo), proposals.jsonl",
    "                      (promises not sure enough to file alone; the weekly",
    "                      review asks). `prevail commitments list|scan|proposals|",
    "                      answer|undo|note --json`",
    "      mail/headers.<account>.jsonl  sent and received mail headers on this",
    "                      Mac only; a sent one may carry promises (the promise",
    "                      sentence, never the message) and asks: true",
    "      today/<date>.json  the Today card: the three, their reasons, the taps;",
    "                      today/weights.json what the taps taught",
    "      radar.json      what is falling behind, with evidence and lead time:",
    "                      commitments, waiting-fors, routines, relationships,",
    "                      goals, paths, admin deadlines, domains, decisions,",
    "                      projects (`prevail radar show --json`); Today shows one",
    "      capture/        told.jsonl (everything told to the chief of staff on",
    "                      any surface and where code filed it: a task, promise,",
    "                      waiting-for, decision, Compass candidate, number, a",
    "                      project's practice or spend, or a note; an undo line",
    "                      marks one undone), mail-seen.json (mail to yourself",
    "                      already filed), undone/ (decision records Undo moved",
    "                      aside). `prevail tell <text> [--domain d] [--mission m]",
    "                      | tell undo <id> | tell list`, `prevail forgetting`;",
    "                      MCP tell and what_am_i_forgetting",
    "      time/           holds.jsonl (protected blocks proposed for next week:",
    "                      ask | created | declined; the last line per id wins) and",
    "                      declines.jsonl (drafted declines, never sent). `prevail",
    "                      time week [--next]|review|propose|holds|declines|hold",
    "                      approve|decline <id>|day`; MCP read_time",
    "      interruptions.jsonl  every proactive message asked for (sent only within",
    "                      three a week; the rest waits for the weekly review)",
    "  data/",
    "    domains/<slug>/   one life domain per dir (lowercase slug)",
    "    domains/_archive/<slug>/  archived domains, kept as they were (never",
    "                      deleted; `prevail vault restore <slug> --json` brings one back)",
    "    apps/<id>/        one connected app per dir",
    "    missions/<slug>/  one project per dir: a time-bound effort (format below)",
    "    entities/         people, places, orgs, things (format below)",
    "    suggestions.json  structure suggestion decisions (format below)",
    "```",
    "No other root-level files or directories. Ever.",
    "",
    "## A domain - data/domains/<slug>/",
    "```",
    "  manifest.json       identity + settings (JSON, fields below)",
    "  ideal-state.md      THE domain ideal: purpose, current reality, target,",
    "                      metrics, habits/routines, what to avoid",
    "  ideal-state.versions/  earlier texts of the domain ideal, one <ISO time>.md",
    "                      per changed save (kept for restore, never hand-edited)",
    "  _tasks.md           task board (line grammar below); on a v4 domain it",
    "                      lives at memory/tasks.md",
    "  _loops.json         standing loops (schema below)",
    "  _loops_runtime.json loop run history/pending - machine-managed, NEVER edit",
    "  _surface.json       suggested questions cache - machine-managed, NEVER edit",
    "  source/             the user's own material: goals.md, config.md, any files",
    "    specialists/<id>.md  the user's instructions for a specialist in this",
    "                      domain; frontmatter may only tighten (lower ceiling,",
    "                      fewer tools or apps, on: false)",
    "                      (earlier texts in specialists/.versions/<id>.<ISO>.md)",
    "    goals.md          the domain's goals, one list item each:",
    "                      - [ ] Title ~id:g-x ~status:active|done|archived",
    "                        ~due:YYYY-MM-DD ~progress:0-100 ~objective:o-x (the",
    "                        Compass objective it moves), then an indented",
    "                        \"why:\" line. [x] = done. Other lines are kept.",
    "                      The ONE goal store: every chat turn carries the",
    "                      domain's active goals, then General's (life goals).",
    "                      Groom folds the old memory/goals.md lists and manifest",
    "                      goals[] in here, keeping memory/goals.md.pre-compass-<date>",
    "                      and manifest.json.pre-compass-<date> as backups.",
    "  memory/             AI-maintained knowledge",
    "    state.md          current-state snapshot (autoState caveat below)",
    "    memory.md         durable long-term memory (injected into every chat);",
    "                      the Interviewer adds \"## Questions to ask you (<date>)\"",
    "                      blocks (Undo takes out exactly that block)",
    "    threads/          chat transcripts (<slug>.md + <slug>.jsonl) - NEVER edit",
    "    updates.jsonl     what conversations in OTHER domains noted for this one,",
    "                      append-only, one line per touch:",
    "                      { ts(ms), from_domain, thread, fact, entities: [id] }",
    "    touches.jsonl     the reach of this domain's own threads, one line per",
    "                      turn: { ts(ms), thread, domains: [slug], entities: [id] }",
    "    decisions/<slug>.md  an open decision: frontmatter question, status",
    "                      open|decided|revisit, due, owner, consulted, serves, gut,",
    "                      recommendation, confidence, decided, chose, retro_due,",
    "                      retro_right; ## Context, Options, Trade-offs,",
    "                      Recommendation, Decision, Retro. Deciding also appends",
    "                      decisions.jsonl. Every open one has a due date (two",
    "                      weeks when none is said). Tasks phrased \"Decide whether",
    "                      ...\" open one (linked in Context); a chat that deliberates",
    "                      is offered one; a Compass conflict can become one. The",
    "                      recommendation (the Steward, or the council for a big",
    "                      one) is shown only after the gut call.",
    "                      `prevail decide list|open|scan|from-conflict|recommend|gut|decide|retro`",
    "    briefs/<date>-<slug>.md  pages a job's Editor wrote (Undo moves them out)",
    "    lessons/<date>-<slug>.md  lesson plans and quizzes the Tutor filed (Undo",
    "                      moves them out; the review date is a task)",
    "    reviews/          (General) pages written by code: week-<date>.md (the",
    "                      weekly review), stack-<YYYY-MM>.md, paths-<YYYY>-Q<n>.md",
    "                      (the quarterly initiative review), recap-<YYYY-MM>.md (the",
    "                      monthly mini-recap), your-year-<YYYY>.html (Your Year, one",
    "                      self-contained page; never anything local-only),",
    "                      year-<YYYY>.md (the yearly review: values, roles, purpose,",
    "                      three odyssey lives; written once, your answers kept)",
    "    specialists/<id>.md  a specialist's notebook here: what it learned, short,",
    "                      AI-maintained, the user may edit",
    "    open-loops.md.pre-today-<date>  the old open-loops list, folded into the",
    "                      board and decisions (kept as a backup)",
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
    "- goals: retired; goals live in source/goals.md (groom moves any here)",
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
    "- `~kind:commitment ~to:person/<slug>`: a promise the user made to someone;",
    "  `~kind:waiting ~from:person/<slug>`: something someone owes the user;",
    "  `~src:<where>` (gmail:<thread-hash>:<n>, chat:<thread>, meeting:<hash>:<n>,",
    "  job:<id>, playbook:<id>, open-loops). Told to the chief of staff (\"remind",
    "  me I owe Sam the deck by Friday\") they are filed at once; promises with a",
    "  person and a date in sent mail are filed with Undo; action items in",
    "  meeting notes (data/apps/<id>/meetings/*.md or a domain's",
    "  source/meetings/*.md, under an Action items or Next steps heading) too.",
    "  `~closed:YYYY-MM-DD` the day a task was checked off;",
    "  `~mission:<slug>` a task that serves a project (shown on its Tasks tab).",
    "  `~initiative:<p-id>` or `~goal:<g-id>` a task that moves a Compass initiative",
    "  or goal (the Compass chain: Today names its walk up to the vision).",
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
    "    \"playbook\": \"renewal-review\", // optional: run this playbook instead",
    "    \"on\": \"admin:renew\",         // optional: run on a radar event, not the clock",
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
    "  _scope/_threads/<slug>.md   the app's chats; frontmatter carries",
    "                  `app: <id>` (listed by `prevail apps threads <id> --json`)",
    "  _log/access.jsonl   machine-managed, append-only: one line per MCP call",
    "                  the act gate saw for this app, reads included:",
    "                  { ts, tool, access: read|write|blocked,",
    "                    outcome: ran|queued|denied|declined, thread?, domain?,",
    "                    entity?, account?, summary }. account (Google tool",
    "                  calls only) = the Google account it ran as, \"claude\"",
    "                  for Claude's one-account connector. summary = argument keys + short",
    "                  values (60 chars), sensitive values replaced by their",
    "                  category, bodies by their length. Never edit;",
    "                  `prevail apps access-log [--app <id>] [--domain <d>]",
    "                  [--entity <id>] [--thread <t>] [--account <a>] [--limit N] --json`",
    "```",
    "Google apps (Gmail, Drive, Calendar) and accounts: `prevail apps accounts",
    "<app-id> --json` lists [{ id (the account email), label?, default, via:",
    "gws|claude }]: every account Prevail's google_workspace connector holds,",
    "plus Claude's own connector (one account). `prevail chat --google-account",
    "<account|all>` picks one; `all` reads each account in turn (one call per",
    "account, labeled), while drafts and writes go to the default account only",
    "and queue for approval. Nothing is ever sent.",
    "Apps are chat scopes: `prevail chat --json --app <id>` (repeatable) gives the",
    "turn an app context block (runtime, status, read/write/blocked tools, SKILL.md",
    "excerpt); reads run, writes and sends queue for approval. A turn whose",
    "engine lacks the app's connector moves to the one runtime that owns them",
    "all (a `routed` event) or reports `app_unavailable`. On a Claude turn the",
    "session's init event gives each connector's live status: one needing",
    "sign-in emits `app_needs_auth` and is marked in the mirror; one that did",
    "not load emits `app_unavailable` with a reason.",
    "",
    "### Trusted sources (the user's own sites, read-only)",
    "An app whose manifest has `trusted: true` and integration",
    "mcp-remote (a remote MCP endpoint, streamable HTTP), web (a site with",
    "llms.txt and/or openapi.json) or links (URLs the model may GET).",
    "```",
    "  manifest.json   { id, name, integration: mcp-remote|web|links,",
    "                    urls: [https...], trusted: true, domains: [],",
    "                    probe: { ok, checked_at, error?, tools?, llms_txt?,",
    "                    openapi?, urls? },",
    "                    tools: [...] (mcp-remote; readOnlyHint = read),",
    "                    source: { title, llms, endpoints: [{path,summary}] }",
    "                    (web; capped) }",
    "  build/_meta/apps/trusted.json   machine-managed allowlist the act gate",
    "                  trusts: per id its kind, urls, hosts, read tools. Never",
    "                  edit; editing a manifest never widens what runs live.",
    "```",
    "- `prevail apps add-source --kind mcp-remote|web|links --url <u>",
    "  [--url <u2>...] --name <n> --vault V --json` creates or adopts",
    "  data/apps/<slug of name>/ (user values kept), checks the source",
    "  (mcp-remote: initialize + tools/list; web: /llms.txt + /openapi.json;",
    "  links: a GET each; 10 s) and returns { app, probe, adopted }. https",
    "  only (http for localhost); a URL carrying a password or key/token",
    "  parameter is refused: credentials are never stored. Never add a",
    "  database connection string; put an MCP or API in front of the data.",
    "- `prevail apps remove-source <id>` moves the folder to",
    "  data/apps/_archive/ (never deletes) and drops it from trusted.json.",
    "- They show in `prevail apps list` with trusted, integration, urls and",
    "  status connected when the last check passed.",
    "- Referenced in chat (--app / --scope-app): an mcp-remote source joins a",
    "  Claude turn as an http MCP server under its id (tools mcp__<id>__*,",
    "  merged with the user's own MCP config); its read tools run and are",
    "  logged to _log/access.jsonl, anything else queues. Other engines: the",
    "  turn moves to Claude or reports `app_unavailable`. A web/links source",
    "  puts its summary in the app block; on Claude, WebFetch may GET only its",
    "  hosts (allowed through the act gate even under Vault Lock); other",
    "  engines get the summary only.",
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
    "## Entities - data/entities/<kind>/<slug>/entity.md",
    "People, places, companies/products and things the user talks about, with",
    "the context of every conversation about them. Kind dirs: people/, places/,",
    "orgs/, things/. Slug = lowercase name, non-alphanumerics as '-'. Each",
    "entity is a folder:",
    "  <slug>/entity.md                   the page (format below)",
    "  <slug>/picture.<png|jpg|webp|svg>  optional picture",
    "  <slug>/files/                      optional attachments the user added",
    "An older vault has flat <slug>.md pages; they are still read, and refresh",
    "(or `prevail entities migrate-folders`) moves each into <slug>/entity.md.",
    "It never overwrites: when entity.md already exists the old page is kept",
    "beside it as entity.conflict.md.",
    "```",
    "---",
    "name: Sam Rivera",
    "kind: person            # person | place | org | thing",
    "aliases: [Sam]",
    "saved: true             # true = the user saved it; false = auto-created",
    "created: 2026-09-01T12:00:00Z",
    "updated: 2026-09-20T08:00:00Z",
    "mention_count: 7",
    "website: example.com   # optional; a bare domain or URL",
    "picture: picture.png   # optional; a file name in the entity folder",
    "---",
    "",
    "## What you've discussed   model digest of the conversations - regenerated",
    "## Your notes              the USER's text - never overwritten by any tool",
    "## Conversations           dated links to threads / prompt sittings",
    "```",
    "- Yours vs Reference: every indexed entity is either the user's own",
    "  (relation: yours: their property, lender, tenant, people in their life)",
    "  or a reference (people in an essay the model wrote). Signals: the user",
    "  acted on it (saved, entity chat, notes, picture, files; sticky), it is",
    "  in the user's OWN words (their turns, prompt sittings) and not only in",
    "  model output, possessive language near it (my lawyer, our house), it is",
    "  in a domain's source/ files or an app access-log summary, and it came up",
    "  outside General. The index carries relation, relation_confidence and",
    "  home_domain (the domain with the most user-word mentions). A reference",
    "  with no user-word mention in 90 days drops out of the index; nothing on",
    "  disk changes. Yours never fade.",
    "- data/entities/relations.json: the user's overrides, synced, always win:",
    "  { \"overrides\": { \"<id>\": \"yours\"|\"reference\" } }. Written by",
    "  `prevail entities set-relation <id> yours|reference`; do not hand-edit.",
    "- Autosave (per machine, ~/.prevail/config.json `autosave`): which",
    "  entities get a page on their own, on refresh and after a touch. yours",
    "  (default) = Yours entities with relation_confidence >= 0.6; all = every",
    "  indexed entity; off = only what the user saves. `prevail config get",
    "  autosave` / `prevail config set autosave off|yours|all [--json]`.",
    "- <slug>/updates.jsonl: what conversations anywhere noted about this Yours",
    "  entity, append-only: { ts(ms), from_domain, thread, fact }.",
    "- `website` is set by the user; for an org only, refresh may fill it from",
    "  a URL in its own mentions whose domain spells the org's name. Never",
    "  guessed from the name alone, never for people or places.",
    "- Safe to edit: frontmatter name/aliases and the Your notes section. The",
    "  other two sections are rewritten on refresh.",
    "- Mentions come from prevail://person|place|org|thing/<name> links in chat",
    "  threads and from entity tags on prompt sittings. The aggregate index is",
    "  build/_meta/entities/index.json (machine-managed, NEVER edit).",
    "- Entity chats: a thread whose frontmatter has `entity: <kind>/<slug>` is a",
    "  conversation about that entity. Refresh counts it, lists it under the",
    "  page's Conversations and feeds its user turns to the digest.",
    "- CLI: `prevail entities list|show <id>|save <id>|note <id> --text ...|",
    "  note <id> --append --text ...|threads <id>|refresh|backfill`,",
    "  `set-picture <id> --file F` (png/jpg/webp/svg, up to 5 MB),",
    "  `set-website <id> --url U`, `files <id>`, `add-file <id> --file F`,",
    "  `migrate-folders`, `set-relation <id> yours|reference`,",
    "  `list --relation yours|reference` (list --json also returns counts).",
    "  (id = kind/slug, e.g. person/sam-rivera). `note --append` adds a dated",
    "  paragraph to Your notes; `threads` lists the entity's chats, newest first.",
    "  `prevail chat --json --entity <id>` gives every turn the entity's context.",
    "- Duplicates: `prevail entities duplicates` lists possible duplicate pairs",
    "  (same kind, confidence 0..1, a one-line reason); `merge <keepId> <mergeId>`",
    "  folds one into the other; `not-same <idA> <idB>` records they differ.",
    "  Refresh merges clear duplicates (confidence >= 0.9) on its own. A merge",
    "  never loses data: the keeper gains the other's name and aliases as",
    "  aliases, its mentions and conversations, and its notes appended under a",
    "  dated \"Merged from <name>:\" line.",
    "- data/entities/merges.json: merge decisions, synced with the vault.",
    "  { \"merges\": [{ \"from\": id, \"into\": id, \"ts\": iso, \"auto\": bool,",
    "  \"reason\": str }], \"notSame\": [[idA, idB], ...] }. A merged id resolves",
    "  to its keeper everywhere (show, threads, chat --entity, `entity:` tags);",
    "  threads are never rewritten. A notSame pair is never proposed again.",
    "  Written by the CLI under a lock; do not hand-edit.",
    "- data/entities/_merged/<kind dir>/<slug>/: folders of merged entities,",
    "  archived as they were (never deleted). Their files/ are also copied to",
    "  the keeper's files/.",
    "- Entity projects became Projects: data/entities/projects/ is migrated into",
    "  data/missions/ by `prevail projects migrate` (groom runs it once; the old",
    "  folders move to data/entities/_migrated/projects-<date>/, a tar.gz backup",
    "  goes to ~ first, nothing is deleted). An old id project/<slug> resolves",
    "  to mission/<slug> everywhere (entities show, chat --entity, ~project:).",
    "",
    "## A Project - data/missions/<slug>/ (shown as Projects; stored as missions)",
    "A time-bound effort the user talks to (Learn the cello, Kitchen remodel):",
    "a domain with an outcome and an end. It REFERENCES domains, apps, people",
    "and calendar events by id and never copies their data; only what is born",
    "in the project lives here. Id: mission/<slug>.",
    "```",
    "<slug>/",
    "  mission.md          the page: frontmatter (below), ## Outcome, ## Why,",
    "                      ## Your notes (the user's text, never overwritten)",
    "  milestones.md       - [ ] Title ~id:ms-x ~due:YYYY-MM-DD ~weight:N",
    "                      ~check:<metric><op><n> (completes itself) ~done:D",
    "  links.json          { calendar: [{ app, event, title, start, kind, source:",
    "                      matched|created, milestone? }], tasks: [{ domain, id }],",
    "                      decisions: [{ domain, file }], files: [{ domain, path }],",
    "                      threads: [{ domain, thread }] } references only",
    "  artifacts/          what the project produced (pages, plans, drafts)",
    "  files/              files the user added; filed to a domain at close",
    "  _loops.json         project loops (disabled at close-out)",
    "  memory/state.md memory.md   current state; what the project learned",
    "  memory/log.md       dated lines, newest first (`prevail projects log`)",
    "  memory/ledger.jsonl budget actuals { ts, line, usd (spend negative),",
    "                      what, ref (plaid:<id> | file:<path> | chat:<thread>),",
    "                      by: matched|user|project }; a ref counts once",
    "  memory/tasks.md     mission-native tasks (the domain task grammar)",
    "  memory/decisions.jsonl updates.jsonl touches.jsonl specialists/<id>.md",
    "  memory/threads/     project chats - NEVER edit",
    "  memory/calendar-pending.jsonl  events the project created: a hold on",
    "                      the user's own calendar waits for their yes (status ask,",
    "                      created after), one with other people stays a draft",
    "  memory/closeout-filed.jsonl  every close-out write, for Undo (7 days)",
    "  memory/migrated-<date>.md    receipt when it came from a project page",
    "  closeout.md         written at completion; closeout-<date>.md on reopen",
    "```",
    "mission.md frontmatter (YAML; lists and maps in flow style):",
    "  name, status: active|paused|completed|archived, outcome, start, target",
    "  (YYYY-MM-DD, required), completed, result: met|partly|not-met|changed,",
    "  cadence, domains: [{slug, role: owner|consulted|informed}] (exactly one",
    "  owner), apps: [id], specialists: [id], people: [person/<slug>],",
    "  entities: [kind/slug], budget: {total_usd, hours_wk, lines: [{id, label,",
    "  usd}]}, goal, path (Compass ids: the goal and the initiative it carries",
    "  out; `initiative:` is read as path), serves, metrics, match: {calendar,",
    "  email_from, merchants}, prompt_projects, repos, ceiling: read |",
    "  write-vault | draft | act-ask | act (tightens only), nudges: {per_week,",
    "  muted}, privacy: {localOnly} (any local-only attached domain makes the",
    "  project local-only), created, updated.",
    "- Lifecycle: active <-> paused; complete runs the close-out; archive hides",
    "  it (the folder never moves); reopen clears completed and result and keeps",
    "  closeout.md as closeout-<date>.md. Never deleted.",
    "- Chat: `prevail chat --json --mission <slug>` (threads in memory/threads,",
    "  thread key _mission-<slug>). A turn carries the project's outcome,",
    "  progress, memory, owner and consulted domains, tasks, calendar, apps and",
    "  people; the chief of staff speaks from inside it. Jobs it starts are",
    "  owned by mission/<slug>; a domain outside the project is asked for",
    "  (bring in), never read.",
    "- Close-out: `prevail projects complete <slug> --plan-only --json` drafts",
    "  every line; `--apply plan.json` files the kept ones (owner memory.md under",
    "  ## Missions, notes and money to updates.jsonl, people to their",
    "  updates.jsonl, files to the owner's source/missions/<slug>/, open tasks",
    "  moved with ~mission:<slug>, routines to the owner's ideal state) with a",
    "  receipt each; `prevail projects undo <slug> <n>` within 7 days.",
    "- Progress without data entry (capture sync): calendar events whose title",
    "  matches match.calendar are linked and counted (events/missions,",
    "  mission.event with attrs.mission), mail from match.email_from is counted,",
    "  card charges from match.merchants are ledger lines (by matched, the",
    "  charge referenced, once); in the project's chat \"practiced 30 min\" is a",
    "  stated.practiced event carrying the project and \"paid $120 for ...\" a",
    "  ledger line. Project metrics are metrics.md lines with ~mission:<slug>",
    "  (`prevail projects metrics|track`); a milestone ~check: reads the metric's",
    "  total since start. Linking a Compass path writes project: <slug> under it;",
    "  `projects from-path <path-id>` starts one. Today shows a project item when",
    "  one is due or late; the radar flags quiet, behind pace, budget past 80%",
    "  and a passed target; nudges spend the same three-a-week budget, at most",
    "  nudges.per_week each.",
    "- A task or goal line anywhere links to a project with ~mission:<slug>",
    "  (an older ~project:<slug> still counts).",
    "- CLI: `prevail projects list|create|show|set|attach|detach|milestone|",
    "  budget|event|pause|resume|archive|reopen|complete|undo|tasks|log|context|",
    "  migrate|sync|radar|metrics|track|events-pending|event-approve|link-path|",
    "  from-path --json`. MCP: list_missions, read_mission, mission_context,",
    "  mission_log; chat takes mission. create_mission, set_mission_status and",
    "  complete_mission are writes: each waits in the Inbox (the act queue) and",
    "  runs the moment the user allows it. Telegram: /m <project> pins a chat",
    "  (its turns run in the project), /m off unpins; practice or a spend said",
    "  anywhere goes to the project it names (or the only learning project).",
    "  `prevail projects <sub>` is the same command as `prevail missions <sub>`.",
    "  Prompt groups (build/_meta/projects.json, `prevail prompt-groups`,",
    "  MCP list_projects) are a different thing: a prompt group with 3+",
    "  sittings can suggest a Project.",
    "",
    "## Structure suggestions - data/suggestions.json",
    "- The touch step also notes topics none of the domains covers (per machine:",
    "  build/_meta/linking/unhomed.jsonl { ts, thread, home, label, fact, effort? }).",
    "- `prevail suggest structure --json` lists pending suggestions",
    "  [{ id, kind: domain|project|archive_domain, title, reason,",
    "  evidence: [{ thread?, ts, domain }], confidence }]: a new domain when one",
    "  label comes up in 3+ conversations within 30 days; a project (kind",
    "  project, kept for compatibility) for a prompt project with 3+ sittings and",
    "  no project, or an effort topic",
    "  at the same threshold; archiving a domain with no threads, touches or",
    "  updates in 365 days. They also appear in `prevail recommendations` under",
    "  category structure with action { kind: structure_suggestion, id }.",
    "- `prevail suggest accept <id> --json` creates the domain (then appends",
    "  the evidence conversations' facts to its memory/updates.jsonl), creates",
    "  the project, or archives the domain (moved, never deleted).",
    "  `prevail suggest dismiss <id> [--forever] --json`: Not now = 30 days.",
    "- data/suggestions.json (synced): { accepted: [id], dismissed: [{ id,",
    "  until?(ms) }] }. Written by the CLI under a lock; do not hand-edit.",
    "",
    "## Daemons - exactly what writes what",
    "- Loops daemon: runs due loops; writes _loops_runtime.json, files tasks in",
    "  _tasks.md, delivers briefings (journal / Gmail-to-self), logs to",
    "  build/_meta/activity.<host>.jsonl (one stream per machine; the old shared",
    "  activity.jsonl is read-only history) + action audit.",
    "- State consolidator (per-domain, only when manifest.config.autoState=true):",
    "  rewrites memory/state.md from recent activity.",
    "- Intents distiller: reads journals + capture streams; writes",
    "  build/_meta/intents_distilled.json.",
    "- Intent refresh: tags each new prompt sitting with the entities it",
    "  mentions (build/_meta/entities/), rebuilds the entity index, creates",
    "  auto pages and refreshes page digests under data/entities/.",
    "- Skill/task generators: may add skills/<id>/ and _tasks.md lines from",
    "  captured activity.",
    "- Capture: harness hooks + transcript sync append per-HOST streams",
    "  build/_meta/prompts/<tool>.<host>.jsonl (schema below). One file per",
    "  machine, so file-level sync never conflicts on concurrent appends; the",
    "  legacy build/_meta/prompts/<tool>.jsonl is read-only history.",
    "- Surface: writes _surface.json suggested questions per domain.",
    "- Touch step (every `prevail chat --json` turn, after the reply): one small",
    "  classification says which OTHER domains and which Yours entities the",
    "  exchange concerns, with one fact line each, and appends updates.jsonl",
    "  lines plus the home domain's touches.jsonl line. Skipped for short",
    "  messages, incognito, and Bunker / local-only. Threads are never edited.",
    "- Filing (every General conversation gets a home domain, generously):",
    "  `prevail route` files a General thread in its best domain at a low bar",
    "  (0.35) and links others at 0.6 (at most 3); only when nothing clears the",
    "  bar is it unfiled, with 3 candidates. The desktop re-checks on turns 1, 3",
    "  and every 5th, only adding domains; `route correct` choices always win.",
    "  The filing lives in the thread's `routed:` frontmatter (home first).",
    "  `prevail file plan [--limit N] --json` proposes filings for unfiled",
    "  threads; read-only, skips Bunker / local-only / incognito, cached in",
    "  build/_meta/filing/.",
    "- Linking consolidator (learn daemon, HUB only, once a day per target):",
    "  folds updates.jsonl into memory/state.md under \"## Across your life\"",
    "  (newest first, source domain + date), a source that touched a domain",
    "  3+ times into memory/memory.md under the same heading, and entity",
    "  updates into the page's What you've discussed. Checkpoints in",
    "  build/_meta/linking/consolidate.json. Never deletes an update line.",
    "  `prevail consolidate [--domain d] [--entity id] [--json]` runs it now.",
    "  `prevail updates [--domain d] [--entity id] [--since ISO] [--limit N]",
    "  --json` lists lines newest first, each with target",
    "  {kind:'domain',slug} or {kind:'entity',id}.",
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
    "- Capture streams build/_meta/prompts/<tool>.<host>.jsonl (per machine;",
    "  legacy <tool>.jsonl is read-only history). Readers merge EVERY file",
    "  matching <tool>*.jsonl by ts; writers only ever append the per-host file:",
    "  { ts(ISO), epoch_ms, tool, session, cwd, prompt, source:'push'|'sync', host }",
    "  host matches the filename's <host> segment.",
    "Append through `prevail capture ingest` or the app - never by hand.",
    "- AI usage events build/_meta/events/<tool>/<YYYY-MM>.<host>.jsonl: every",
    "  AI tool's own local records (Claude Code, Codex, opencode, Hermes,",
    "  Antigravity, Cursor, AionUi, Wispr Flow, glyph) as counts, one line per",
    "  day, tool, model and project: { ts(YYYY-MM-DD), src, kind: ai.tokens |",
    "  ai.session | ai.prompt | ai.quota | ai.code | ai.cost_reported, n, model?,",
    "  project?, host, tier, attrs: { in, out, cache_read, cache_write,",
    "  cache_write_1h, reasoning, sessions, usd_api, usd_reported, ... } }. No",
    "  prompt or reply text. Each host rewrites only its own files, for the",
    "  current and previous month; older months are frozen (`--backfill` writes",
    "  older months that have no file yet). Written by `prevail ai scan` (and",
    "  every `capture sync`); read by `prevail ai usage`, which merges every host.",
    "- Git events build/_meta/events/git/<YYYY-MM>.<host>.jsonl, same shape:",
    "  kind git.commit (commits the user authored that day in one repo; attrs",
    "  ai = commits with an AI co-author trailer, hours = commit hours) and",
    "  git.tag (release tags). Written by `prevail metrics scan` and every",
    "  `capture sync`, per host; no commit message or code is read.",
    "- Metrics: build/metrics.md is the registry the user reads and edits",
    "  (## Pinned | Tracking | Paused | Retired; - Title ~id:m-x ~per:week",
    "  ~unit:usd ~tier:measured|derived|asked ~serves:<compass id>, then from:,",
    "  and because: on a retired one; unknown lines kept). A pinned metric names",
    "  what it serves (or is documentary); at most 3 per value or goal, 5 in all.",
    "  A learned metric line adds ~src:<events dir> ~kind:<event kind> [~value:attr].",
    "  build/_meta/metrics/proposals.jsonl (answers to proposals: track, dismiss,",
    "  edit), rules.jsonl (never propose X), insights.jsonl (change points with",
    "  the files behind them, and thumbs).",
    "- build/_meta/events/checkins/<YYYY-MM>.<host>.jsonl: the weekly 1-5 calm",
    "  check-in (kind checkin.calm, attrs calm, week, note). events/stated/: numbers",
    "  the user said in chat (kind stated.<verb>, attrs value, unit; no text).",
    "  build/_meta/metrics/<id>.jsonl holds daily points { date, value, n } and",
    "  catalog.json the definitions; build/_meta/sources.json each source's",
    "  files, events, date span, hosts and caveats. Computed from the events",
    "  above plus files already in the vault, read in place and never copied:",
    "  task boards (done lines with ~closed:), _loops_runtime.json runs,",
    "  decisions.jsonl, the prompt capture (the user's own prompts only), any",
    "  skill's trips.json, watch-history scrapes, card statement CSVs in app",
    "  folders. `prevail metrics glance|list|series <id>|sources --json`; MCP",
    "  read_metrics and metric_series. The hub recomputes once a day.",
    "- Stories and experiments (metrics plan M5): metrics/year/<YYYY>.json",
    "  (Your Year's aggregates), metrics/patterns.json (pairs of weekly",
    "  metrics, lags 0-2, Benjamini-Hochberg; survivors only), metrics/",
    "  experiments.jsonl (n-of-1 experiments: alternate A/B weeks, scored by",
    "  code; the last line per id wins). `prevail metrics year [--write]|recap",
    "  [--month M] [--write]|heatmap <id>|places|patterns|experiment",
    "  propose|start|stop|score`. The hub writes last month's recap once and",
    "  the year page through December. Local-only domains, ~local Compass",
    "  lines and events-local sources never appear in a story.",
    "- Qualitative and alignment (metrics plan M4): check-in events also carry",
    "  checkin.ladder { now, future 0-10, quarter } (asked once a quarter),",
    "  checkin.who5 { score 0-100 } (monthly, only after `prevail review who5",
    "  on`) and checkin.hypothesis { kind, yes }. build/metrics.md lines may",
    "  carry ~enough:N (lived against enough), ~guard:<metric> (the guardrail),",
    "  ~moves:<metric> (an input to test against an outcome); a ## Seasons",
    "  section lists breaks that pause metrics: - Title ~from:YYYY-MM-DD",
    "  ~to:YYYY-MM-DD [~pauses:m-a,m-b] (weeks with 3+ days away pause work",
    "  metrics on their own). build/_meta/metrics/ also holds hypotheses.jsonl",
    "  (yes / no answers), hypothesis-weights.json (what the answers taught),",
    "  proxies.json (passive proxies, hidden until they predict check-ins) and",
    "  asked.json (WHO-5 on or off). `prevail metrics lived | guardrails | lags",
    "  | proxies | themes | hypotheses | seasons`, `prevail review ladder <now>",
    "  <future> | who5 on|off | who5 <a> <b> <c> <d> <e> | hypothesis <key> yes|no`.",
    "- build/_meta/apps/adapters.<host>.json: each AI adapter's health on that",
    "  machine (files read, versions seen, shape ok | unknown | absent) and the",
    "  AI tools seen with no adapter yet.",
    "- An app's manifest.json may carry cost: { amount, period: month|year,",
    "  source, set } (what the user pays; `prevail ai plan <app> --usd N`).",
    "- The stack (apps plan): every app record may also carry kind (ai-tool |",
    "  app | web | subscription-only | device | service), category, surfaces,",
    "  identifiers { bundle_ids, domains, merchants, email_senders, binaries }",
    "  (how signals map to it; the user's corrections land here and win),",
    "  lifecycle (in use | unused | archived), first_seen, found_by. Records are",
    "  created for every vendor seen in use; existing values are never",
    "  overwritten and archived apps are never recreated.",
    "- Money on a record (apps plan A3, written by `prevail apps money` and",
    "  every apps scan; a cost with source stated is never replaced): cost",
    "  { amount, period, source: card statements | plaid, confidence, set },",
    "  renewal { next, period, source }, trial { ends, source }, price_history",
    "  [{ date, amount }], last_charge, billed_twice. Card statement CSVs are",
    "  read in place; only charges matched to an app become money.charge",
    "  (metrics source charges). Receipt and lifecycle mail from senders that",
    "  map to an app: events/receipts/ (app.receipt | app.renewal | app.trial |",
    "  app.welcome | app.price | app.cancel, { until }). Recurring merchants",
    "  that match no app: build/_meta/apps/unknown-merchants.json (this Mac).",
    "  `prevail apps charges [--all] --json` lists the recurring series.",
    "- The doctor and the stack (apps plan A4): `prevail doctor apps` probes",
    "  each CLI (--version, sign-in where cheap), Google per account, the AI",
    "  adapters' shapes, capture gaps, connected sources and vendor status",
    "  pages into build/_meta/apps/health.<host>.json (per app: status ok |",
    "  auth_expired | ineligible | vendor_down | missing | degraded |",
    "  unknown_shape | capture_gap, checks, last_ok, first_fail, changed).",
    "  `prevail apps stack | cards | card <key> keep|snooze|done|review|fix|",
    "  archive|cancel-steps | review | offboard <id>`. Card answers:",
    "  build/_meta/apps/cards.jsonl. Broken capture may use the interruption",
    "  budget; everything else is one line in the weekly review and the",
    "  monthly stack review, data/domains/general/memory/reviews/",
    "  stack-<YYYY-MM>.md (written once a month by the capture sync).",
    "  Offboarding drafts: data/apps/<id>/offboarding-<date>.md (a checklist",
    "  and a message, never sent). Archiving moves the folder to",
    "  data/apps/_archive/. build/_meta/apps/seen-bundles.<host>.json: when",
    "  each installed app was first seen on that Mac (new-app detection).",
    "- App and web usage events build/_meta/events/apps/<YYYY-MM>.<host>.jsonl",
    "  (app.focus { minutes, device: mac | device-<id>, via: screentime |",
    "  knowledgec | live } per bundle id and day; app.last_used from Spotlight)",
    "  and events/web/ (web.visits per registrable domain and day). No URL,",
    "  title or query; health, finance, adult and dating sites never counted.",
    "  Written by `prevail apps scan` and every `capture sync`. Screen Time and",
    "  Safari need Full Disk Access for Prevail; without it they say so.",
    "- build/_meta/events-local/<src>/: events of sources marked local-only",
    "  (photos, messages, calls, local-model themes); never synced.",
    "- build/_meta/apps/ (machine-managed): usage-sources.<host>.json (what each",
    "  usage source could read on that Mac, and the installed apps),",
    "  usage.json (per app: active days 7/30/90, minutes 30d by device, web",
    "  visits, AI sessions, trend), unknown.json (signals that matched no app),",
    "  mapping.json (ignored signals). `prevail apps scan | usage | unknown |",
    "  map <bundle|domain|merchant|sender|binary> <value> <app-id|ignore> |",
    "  records --json`.",
    "- build/_meta/household/consent.jsonl (machine-managed): every consent",
    "  change for a household member (member, scope, on, by, ts).",
    "- build/_meta/consent.json (machine-managed, per Mac): which sources the",
    "  user allowed on this Mac. `prevail sources list | consent <id> on|off`.",
    "  Sources that need nothing new are on; connections and sensitive sources",
    "  (wave 3 and 4) are off until turned on.",
    "- Connected sources (metrics plan M3), each in build/_meta/events/<src>/",
    "  <YYYY-MM>.<host>.jsonl, counts and hashes only: gmail (email.sent,",
    "  email.received, email.reply, email.replied { minutes }, email.person",
    "  (hashed), email.job_application), calendar (cal.meeting, cal.focus,",
    "  cal.after_hours, cal.family { hours }), github (gh.pr_opened,",
    "  gh.pr_merged, gh.issue_opened), youtube (yt.views, yt.published,",
    "  yt.subscribers), plaid (money.recurring per app), apple-health",
    "  (health.steps, health.sleep, health.workout, health.rhr), timeline",
    "  (place.visit, place.new hashed, day.away), oura, strava, garmin.",
    "  photos, messages, calls, topics and themes are local-only (events-local).",
    "  `prevail sources sync [<id>] [--backfill]`; the capture sync runs the",
    "  due ones. build/_meta/source-state.json: each source's last sync.",
    "- build/_meta/mail/headers.<account>.jsonl and build/_meta/calendar/",
    "  events.<account>.json (machine-managed, this Mac only, never synced):",
    "  message headers (id, thread, ts, sent|received, from, to, cc, subject,",
    "  in_reply_to, labels; never a body) and calendar events (id, calendar,",
    "  title, start, end, attendees count, own response) for Today's",
    "  commitments, projects and the time review.",
    "- Exports the user drops in: data/apps/apple-health/inbox/ (export.zip),",
    "  data/apps/timeline/inbox/ (Timeline JSON), data/apps/garmin-connect/",
    "  inbox/. Tokens for YouTube, Plaid, Oura and Strava live in the Mac's",
    "  Keychain (services prevail-<id>), never in the vault.",
    "",
    "## Integrating from OUTSIDE the app",
    "- CLI (`prevail`): chat --domain <slug> (grounded chat) · agent-run (act",
    "  mode) · loops --once / --run-loop (run loops now) · briefing run ·",
    "  connectors list|set <id> domains|account|model|refresh|enabled ·",
    "  skill-usage used|report|archive|unarchive · capture ingest|sync ·",
    "  vault migrate-v4 (groom) · role get|set hub|client · telegram setup ·",
    "  today [tap <key> done|move|not-important|right-list] · review week|checkin <1-5> ·",
    "  job dispatch|start|show|list|stop|adjust|undo · specialists list|show|save|domain-save|reset ·",
    "  decide list|open|gut|decide|retro · compass interview|woop|candidates ·",
    "  metrics proposals|answer|pin|retire|insights",
    "- MCP: `prevail mcp` serves vault tools (chat, council, tasks, loops,",
    "  memory, intents, apps, entities, read_today, weekly_review, hand_off,",
    "  list_jobs, open_decisions) to any MCP-capable client.",
    "- Writes that contact people / spend money / are irreversible queue in the",
    "  app's Needs-you inbox for one-tap approval; design integrations to expect",
    "  that gate rather than fight it.",
    "- Two guardrails are enforced IN CODE at execution and cannot be prompted",
    "  around: (1) email policy - mail to anyone but the user's own accounts is",
    "  drafted (or refused) for the user to send themself; (2) sensitive egress",
    "  guard - outbound content to another party carrying PII, money figures,",
    "  health/legal/salary/strategy details, or verbatim quotes is HELD until",
    "  the user releases that exact action. (3) action gateway - connector",
    "  writes (claude.ai connectors, any MCP server) are held by a",
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
