#!/usr/bin/env bun
// migrate-vault-v2.ts — v1 → v2 vault migrator (VAULT-SPEC-v2.md §12).
//
// Lossless & idempotent. Re-running is safe: every step checks before acting and
// nothing is deleted — files are MOVED to their v2 homes (legacy/derived names).
//
//   bun run scripts/migrate-vault-v2.ts <vault-path> [--dry]
//
// Per domain (a child dir with state.md OR soul.md), it:
//   state.md      → _state.md (+ derived_from frontmatter)
//   open-loops.md → _tasks.jsonl (checkbox lines parsed to task objects)
//   MEMORY.md     → _meta/
//   manifest.json → _meta/
//   QUICKSTART.md → _meta/ (preserved; soul seeds from it)
//   PROMPTS.md    → _skills/
//   skills/*      → _skills/
//   00_current/, 01_prior/ → data/
//   02_briefs/*   → _artifacts/
//   + creates soul.md (seeded) and goals.md (stub) if absent
//   + ensures data/ _meta/ _artifacts/ _skills/ exist
//   config.md, decisions.md, _log/, _threads/ stay put.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, statSync, rmdirSync,
} from "node:fs";
import { join, basename } from "node:path";

const vault = process.argv[2];
const DRY = process.argv.includes("--dry");
if (!vault || !existsSync(vault)) {
  console.error("usage: bun run scripts/migrate-vault-v2.ts <vault-path> [--dry]");
  process.exit(1);
}

const NON_DOMAIN = new Set([
  "core", "complete", "scripts", "benchmark", "apps", ".git", ".claude", "node_modules",
]);

let moved = 0, created = 0, skipped = 0;
const log = (s: string) => console.log(`  ${s}`);

function mv(from: string, to: string) {
  if (!existsSync(from)) return;
  if (existsSync(to)) { log(`skip (exists): ${basename(to)}`); skipped++; return; }
  log(`mv  ${from.replace(vault, "")} → ${to.replace(vault, "")}`);
  if (!DRY) renameSync(from, to);
  moved++;
}
function ensureDir(d: string) { if (!existsSync(d) && !DRY) mkdirSync(d, { recursive: true }); }
function rmEmpty(d: string) {
  if (!existsSync(d) || DRY) return;
  if (readdirSync(d).length === 0) { log(`rmdir ${d.replace(vault, "")} (empty)`); rmdirSync(d); }
}
function gitkeep(d: string) {
  if (DRY || !existsSync(d)) return;
  if (readdirSync(d).length === 0) writeFileSync(join(d, ".gitkeep"), "");
}
function write(path: string, content: string) {
  if (existsSync(path)) { log(`skip (exists): ${basename(path)}`); skipped++; return; }
  log(`new ${path.replace(vault, "")}`);
  if (!DRY) writeFileSync(path, content);
  created++;
}

// Pull the domain's display title out of a v1 state.md first heading.
function titleFromState(dir: string, fallback: string): string {
  const sp = join(dir, "state.md");
  if (existsSync(sp)) {
    const first = readFileSync(sp, "utf8").split("\n").find((l) => l.startsWith("# "));
    if (first) return first.replace(/^#\s*/, "").replace(/\s+State\b.*$/i, "").trim();
  }
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

// Parse open-loops.md checkbox lines into _tasks.jsonl objects.
function tasksFromOpenLoops(dir: string, ts: string): string {
  const f = join(dir, "open-loops.md");
  if (!existsSync(f)) return "";
  const lines = readFileSync(f, "utf8").split("\n");
  const out: string[] = [];
  let i = 0;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/);
    if (!m) continue;
    const done = m[1].toLowerCase() === "x";
    out.push(JSON.stringify({
      id: `t_${(++i).toString(36)}`,
      title: m[2],
      status: done ? "done" : "open",
      priority: "normal",
      source: "migrated:open-loops.md",
      created: ts,
      updated: ts,
    }));
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

function migrateDomain(dir: string, name: string, ts: string) {
  console.log(`\n[${name}]`);
  ensureDir(join(dir, "data"));
  ensureDir(join(dir, "_meta"));
  ensureDir(join(dir, "_artifacts"));
  ensureDir(join(dir, "_skills"));

  // state.md → _state.md (+ provenance frontmatter)
  const sp = join(dir, "state.md"), s2 = join(dir, "_state.md");
  if (existsSync(sp) && !existsSync(s2)) {
    const body = readFileSync(sp, "utf8");
    const fm = `---\nderived_from:\n  data: "migrated-from-v1"\n  ledger: 0\nat: "${ts}"\nby: "v1-migration"\nschema: 2\n---\n\n`;
    log(`mv  state.md → _state.md (+frontmatter)`);
    if (!DRY) { writeFileSync(s2, fm + body); renameSync(sp, join(dir, "_meta", "state.v1.md")); }
    moved++;
  }

  // open-loops.md → _tasks.jsonl (always relocate; create the log even if empty)
  if (existsSync(join(dir, "open-loops.md"))) {
    write(join(dir, "_tasks.jsonl"), tasksFromOpenLoops(dir, ts)); // may be ""
    mv(join(dir, "open-loops.md"), join(dir, "_meta", "open-loops.v1.md"));
  }

  // agent meta → _meta/
  mv(join(dir, "MEMORY.md"), join(dir, "_meta", "MEMORY.md"));
  mv(join(dir, "manifest.json"), join(dir, "_meta", "manifest.json"));
  mv(join(dir, "QUICKSTART.md"), join(dir, "_meta", "QUICKSTART.md"));

  // PROMPTS.md + skills/* → _skills/
  mv(join(dir, "PROMPTS.md"), join(dir, "_skills", "PROMPTS.md"));
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const e of readdirSync(skillsDir)) mv(join(skillsDir, e), join(dir, "_skills", e));
    rmEmpty(skillsDir);
  }

  // raw data dirs → data/
  for (const d of ["00_current", "01_prior"]) mv(join(dir, d), join(dir, "data", d));
  // briefs are synthesized → _artifacts/
  const briefs = join(dir, "02_briefs");
  if (existsSync(briefs) && statSync(briefs).isDirectory()) {
    for (const e of readdirSync(briefs)) mv(join(briefs, e), join(dir, "_artifacts", e));
    rmEmpty(briefs);
  }

  // keep empty agent folders visible in git
  for (const d of ["_artifacts", "_skills", "data"]) gitkeep(join(dir, d));

  // soul.md (intent) — seed from state title
  const title = titleFromState(dir, name);
  write(join(dir, "soul.md"),
    `# ${title}\n\n> The why of this domain — purpose, principles, what winning looks like.\n> Stable; you rarely touch this. (Seeded by v1→v2 migration — refine me.)\n\n## Purpose\n\n_TODO: why does this domain exist for you?_\n\n## Principles\n\n- _TODO_\n\n## Risk posture\n\n- _TODO_\n`);

  // goals.md (intent) — stub
  write(join(dir, "goals.md"),
    `# ${title} — Goals\n\n> Objectives + their KPI targets. Each goal names the metric the ledger tracks.\n\n## Objectives\n\n- [ ] _TODO objective_ — metric: \`_metric_key_\`, target: _value_, by: _date_\n`);
}

const ts = new Date().toISOString();
const entries = readdirSync(vault, { withFileTypes: true });
let domainCount = 0;
for (const e of entries) {
  if (!e.isDirectory()) continue;
  if (e.name.startsWith(".") || e.name.startsWith("_") || NON_DOMAIN.has(e.name)) continue;
  const dir = join(vault, e.name);
  if (!existsSync(join(dir, "state.md")) && !existsSync(join(dir, "soul.md"))) continue;
  migrateDomain(dir, e.name, ts);
  domainCount++;
}

console.log(`\n${DRY ? "[DRY] " : ""}done — ${domainCount} domains | ${moved} moved | ${created} created | ${skipped} skipped`);
