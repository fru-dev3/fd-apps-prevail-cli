// Goals: one store. Every domain keeps its goals in source/goals.md, one list
// item per goal (the grammar VAULT.md documents):
//
//   - [ ] Run a half marathon ~id:g-3f2a ~status:active ~due:2026-12-31
//     why: Feel strong again.
//
// General's goals are the life goals. Two older stores are folded in by groom
// (`vault migrate-v4`): the numbered lists in memory/goals.md written by the
// first setup interview, and the manifest's goals[] array. Neither was read by
// anything, so the Goals page and every chat turn saw no goals at all. The old
// files are kept beside the new one as dated backups; nothing is deleted.
//
// This module also owns two small foundations the goals work needs:
// versioned writes of a constitution (global or per domain) and the single
// profile file, build/user.md.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { buildRoot, resolveDomainDir } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { parseGoalLine } from "./projects.ts";

// Goal text is prose: a spaced em or en dash becomes a comma (the same rule
// the chat sanitizer applies), so no migrated title carries one.
function sanitizeEmDashes(t: string): string {
  return t.replace(/\s*\u2014\s*/g, ", ").replace(/\s+\u2013\s+/g, ", ");
}

export interface DomainGoal {
  id: string;
  title: string;
  status: string;
  due?: string;
  why?: string;
  domain: string;
  // The Compass chain: the objective this domain goal moves (~objective:o-x) and the values it serves.
  objective?: string;
  serves?: string;
}

export const GOALS_REL = join("source", "goals.md");

export function domainGoalsPath(vault: string, domain: string): string {
  return join(resolveDomainDir(vault, domain), GOALS_REL);
}

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

/** Parse a goals.md body into goals (the `why:` line under a goal belongs to it). */
export function parseGoals(domain: string, body: string): DomainGoal[] {
  const out: DomainGoal[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const g = parseGoalLine(lines[i]!);
    if (!g) continue;
    const why = lines[i + 1]?.match(/^\s+why:\s*(.*)$/)?.[1]?.trim();
    out.push({
      id: g.tokens.id || `g-${domain}-${i}`,
      title: g.title,
      status: g.status,
      ...(g.tokens.due ? { due: g.tokens.due } : {}),
      ...(why ? { why } : {}),
      domain,
      ...(g.tokens.objective ? { objective: g.tokens.objective } : {}),
      ...(g.tokens.serves ? { serves: g.tokens.serves } : {}),
    });
  }
  return out;
}

/** A domain's goals from source/goals.md (falling back to a root goals.md on an old layout). */
export function readDomainGoals(vault: string, domain: string): DomainGoal[] {
  const dir = resolveDomainDir(vault, domain);
  const body = readText(join(dir, GOALS_REL)) || readText(join(dir, "goals.md"));
  return parseGoals(domain, body);
}

/** The text of a domain's goals file, for context blocks that want the raw list. */
export function readDomainGoalsText(domainDir: string): string {
  return readText(join(domainDir, GOALS_REL)) || readText(join(domainDir, "goals.md"));
}

const isActive = (g: DomainGoal) => g.status === "active";

function goalLines(goals: DomainGoal[], max: number): string[] {
  const lines: string[] = [];
  for (const g of goals.filter(isActive).slice(0, max)) {
    lines.push(`- ${g.title}${g.due ? ` (by ${g.due})` : ""}`);
    if (g.why) lines.push(`  why: ${g.why.slice(0, 200)}`);
  }
  return lines;
}

/** The domain a chat cwd belongs to, or "general" for the vault root. */
export function domainOfCwd(cwd: string, vault: string): string {
  const name = basename(cwd);
  if (!name || cwd.replace(/\/+$/, "") === vault.replace(/\/+$/, "")) return "general";
  if (name === "_scope") return ""; // an app's chat space has no goals of its own
  // A mission's folder (data/missions/<slug>): its key, so a mission turn gets
  // the Compass and the chief of staff like General, and only life goals here.
  if (basename(dirname(cwd)) === "missions") return `_mission-${name}`;
  return name;
}

export const GOALS_HEADER = "# GOALS";

/**
 * The goals block for one chat turn: this domain's active goals, then the life
 * goals (General's). Empty when there are none. Kept short: titles, due dates
 * and the user's own "why", nothing else.
 */
export function goalsBlock(vault: string, domain: string): string {
  const own = domain && domain !== "general" ? goalLines(readDomainGoals(vault, domain), 8) : [];
  const life = goalLines(readDomainGoals(vault, "general"), 6);
  if (!own.length && !life.length) return "";
  const parts = [`${GOALS_HEADER}: what the user is working toward. Keep advice consistent with these; say so when a request works against one.`];
  if (own.length) parts.push(`## ${domain} goals`, ...own);
  if (life.length) parts.push("## Life goals", ...life);
  return parts.join("\n").slice(0, 3000);
}

// ── Migration: memory/goals.md and manifest goals[] into source/goals.md ────

/** Stable id for a migrated goal, so a re-run never duplicates it. */
export function goalIdFor(domain: string, title: string): string {
  return `g-${createHash("sha1").update(`${domain}\n${normTitle(title)}`).digest("hex").slice(0, 6)}`;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The user's goal text from a legacy list item: numbering and bold marks off, em dashes out. */
export function cleanLegacyGoal(line: string): string {
  const m = line.match(/^\s*(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/);
  if (!m) return "";
  return sanitizeEmDashes(m[1]!.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim());
}

/** List items of a legacy memory/goals.md (headings, notes and blank lines ignored). */
export function legacyGoalItems(body: string): string[] {
  return body.split("\n").map(cleanLegacyGoal).filter(Boolean);
}

export interface GoalsMigration {
  domain: string;
  added: number;
  from: ("memory/goals.md" | "manifest")[];
  backups: string[];
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A backup path beside `p` that does not exist yet: <name>.pre-compass-<date>[-n]. */
function backupPath(p: string, tag: string, date: string): string {
  let out = `${p}.${tag}-${date}`;
  for (let n = 2; existsSync(out); n++) out = `${p}.${tag}-${date}-${n}`;
  return out;
}

/**
 * Fold a domain's legacy goals into source/goals.md. The items of
 * memory/goals.md are the user's own words from the setup interview; when that
 * file exists the manifest's goals[] (a summary of the same list) is not
 * copied a second time. Goals already in source/goals.md (same title) are
 * skipped. memory/goals.md is renamed to a dated backup beside it; the
 * manifest keeps a dated backup and loses only its goals[] field. Idempotent:
 * once both stores are empty there is nothing to do.
 */
export function migrateLegacyGoals(vault: string, domain: string, now = Date.now()): GoalsMigration {
  const dir = resolveDomainDir(vault, domain);
  const res: GoalsMigration = { domain, added: 0, from: [], backups: [] };
  const date = today(now);
  const legacyPath = join(dir, "memory", "goals.md");
  const manifestPath = join(dir, "manifest.json");

  const legacy = existsSync(legacyPath) ? legacyGoalItems(readText(legacyPath)) : [];
  let manifest: Record<string, unknown> | null = null;
  let manifestRaw = "";
  if (existsSync(manifestPath)) {
    manifestRaw = readText(manifestPath);
    try { manifest = JSON.parse(manifestRaw) as Record<string, unknown>; } catch { manifest = null; }
  }
  const fromManifest = manifest && Array.isArray(manifest.goals)
    ? (manifest.goals as unknown[]).filter((g): g is string => typeof g === "string").map((g) => sanitizeEmDashes(g.replace(/\s+/g, " ").trim())).filter(Boolean)
    : [];
  if (!existsSync(legacyPath) && !fromManifest.length) return res;

  const items = legacy.length ? legacy : fromManifest;
  if (legacy.length) res.from.push("memory/goals.md");
  else if (fromManifest.length) res.from.push("manifest");

  const target = join(dir, GOALS_REL);
  const body = readText(target);
  const have = new Set(parseGoals(domain, body).map((g) => normTitle(g.title)));
  const add: string[] = [];
  for (const t of items) {
    if (have.has(normTitle(t))) continue;
    have.add(normTitle(t));
    add.push(`- [ ] ${t} ~id:${goalIdFor(domain, t)} ~status:active`);
  }
  if (add.length) {
    mkdirSync(dirname(target), { recursive: true });
    const head = body.trim() ? `${body.replace(/\s*$/, "")}\n` : `# ${domain} goals\n\n`;
    vwriteFile(target, `${head}${add.join("\n")}\n`);
    res.added = add.length;
  }

  if (existsSync(legacyPath)) {
    const b = backupPath(legacyPath, "pre-compass", date);
    renameSync(legacyPath, b);
    res.backups.push(b);
  }
  if (manifest && Array.isArray(manifest.goals) && (manifest.goals as unknown[]).length) {
    const b = backupPath(manifestPath, "pre-compass", date);
    writeFileSync(b, manifestRaw);
    res.backups.push(b);
    manifest.goals = [];
    vwriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return res;
}

/** Append goals (by title) to a domain's source/goals.md, skipping titles already there. */
export function appendGoals(vault: string, domain: string, titles: string[]): number {
  const target = domainGoalsPath(vault, domain);
  const body = readText(target);
  const have = new Set(parseGoals(domain, body).map((g) => normTitle(g.title)));
  const add = titles.map((t) => sanitizeEmDashes(t.replace(/\s+/g, " ").trim()))
    .filter((t) => t && !have.has(normTitle(t)) && (have.add(normTitle(t)), true))
    .map((t) => `- [ ] ${t} ~id:${goalIdFor(domain, t)} ~status:active`);
  if (!add.length) return 0;
  mkdirSync(dirname(target), { recursive: true });
  const head = body.trim() ? `${body.replace(/\s*$/, "")}\n` : `# ${domain} goals\n\n`;
  vwriteFile(target, `${head}${add.join("\n")}\n`);
  return add.length;
}

// ── Versioned constitution writes ───────────────────────────────────────────

/**
 * Write a constitution file (build/ideal-state.md or a domain's
 * ideal-state.md), first keeping the prior text as a dated version in
 * <name>.versions/<ISO>.md beside it. The same folder and naming the desktop
 * uses, so its version list shows engine writes too.
 */
export function writeVersioned(path: string, text: string, now = Date.now()): string | null {
  let prior = "";
  if (existsSync(path)) prior = readText(path);
  let kept: string | null = null;
  if (prior.trim() && prior.trim() !== text.trim()) {
    const vdir = path.replace(/\.md$/, "") + ".versions";
    mkdirSync(vdir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
    let p = join(vdir, `${stamp}.md`);
    for (let n = 1; existsSync(p); n++) p = join(vdir, `${stamp}-${n}.md`);
    vwriteFile(p, prior);
    kept = p;
  }
  mkdirSync(dirname(path), { recursive: true });
  vwriteFile(path, text);
  return kept;
}

/** Versions kept for a constitution file, newest first. */
export function listVersions(path: string): string[] {
  const vdir = path.replace(/\.md$/, "") + ".versions";
  try { return readdirSync(vdir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => join(vdir, f)); } catch { return []; }
}

// ── One profile file: build/user.md ────────────────────────────────────────

export function profilePath(vault: string): string {
  return join(buildRoot(vault), "user.md");
}

/** The user's profile: build/user.md, then the older names the app once wrote. */
export const MEMORY_HEADER = "# LONG-TERM MEMORY";
// The desktop's own header for the same block (chatpanel memoryPreamble), so a
// desktop turn that already carries it never gets it twice.
const DESKTOP_MEMORY_HEADER = "--- Long-term memory (";

/**
 * A domain's long-term memory (memory/memory.md, or a pre-v4 _memory.md) for a
 * chat turn that runs in that domain's folder. `cwd` is the domain folder.
 * Empty for a project or app space (their scope brings its own memory), when
 * the prompt already carries the block, or when nothing is recorded.
 */
export function memoryBlock(cwd: string, domain: string, prompt: string, cap = 4000): string {
  if (!domain || domain.startsWith("_") || prompt.includes(MEMORY_HEADER) || prompt.includes(DESKTOP_MEMORY_HEADER)) return "";
  const text = (readText(join(cwd, "memory", "memory.md")) || readText(join(cwd, "_memory.md"))).trim();
  if (!text) return "";
  return `${MEMORY_HEADER} (${domain}): what this space has learned across sessions. Use it as background; the user's words in this turn win.\n${text.slice(0, cap)}`;
}

export function readProfile(vault: string): string {
  const b = buildRoot(vault);
  for (const p of [join(b, "user.md"), join(b, "_profile.md"), join(b, "profile.md"), join(vault, "user.md"), join(vault, "profile.md")]) {
    const t = readText(p).trim();
    if (t) return t;
  }
  return "";
}

/**
 * Fold build/_profile.md (what the desktop used to write) into build/user.md.
 * When only _profile.md exists it becomes user.md; when both exist and differ,
 * its text is appended to user.md under a dated heading. Either way the old
 * file is kept as a dated backup beside it. Idempotent.
 */
export function migrateProfile(vault: string, now = Date.now()): { merged: boolean; backup?: string } {
  const b = buildRoot(vault);
  const old = join(b, "_profile.md");
  if (!existsSync(old)) return { merged: false };
  const oldText = readText(old).trim();
  const user = join(b, "user.md");
  const userText = readText(user).trim();
  if (oldText && oldText !== userText) {
    const next = userText ? `${userText}\n\n## Merged from _profile.md (${today(now)})\n\n${oldText}\n` : `${oldText}\n`;
    vwriteFile(user, next);
  }
  const backup = backupPath(old, "pre-user", today(now));
  try { renameSync(old, backup); } catch { copyFileSync(old, backup); }
  return { merged: true, backup };
}
