// Restart a project with a newer model: the replay brief (prompt-projects.ts)
// parsed into structured parts, rendered as a handoff prompt, a short intent
// brief or the raw prompts; and a read-only check of an existing folder
// against those requirements.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sanitizeEmDashes } from "./cli-bridge.ts";
import { parseJsonAnswer, readProjectsIndex, runModelOnce, type ModelChoice, type ModelRunner } from "./prompt-projects.ts";
import { modelChoice } from "./mirror.ts";
import { vreadFile } from "./vault-session.ts";

export interface Requirement { text: string; source: "you" | "inferred" }

export interface RestartDoc {
  slug: string;
  title: string;
  goal: string;
  requirements: Requirement[];
  rules: string[];
  decisions: string[];
  dead_ends: string[];
  open_questions: string[];
  brief_model: string;
}

// Items of a markdown section: numbered or bulleted lines, with wrapped
// continuation lines folded in. Sub-headings (### A. Area) are skipped.
export function sectionItems(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*+])\s+(.*\S)/);
    if (m) { out.push(m[1].trim()); continue; }
    const t = line.trim();
    if (!t || /^#/.test(t) || /^\(.*\)$/.test(t)) continue;
    if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ` ${t}`;
    else if (!out.length || /^\S/.test(line)) out.push(t);
  }
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// A requirement is the person's own when it quotes them.
const QUOTED = /["“][^"”]{3,}["”]/;

export function parseBrief(md: string): Omit<RestartDoc, "slug" | "title" | "brief_model"> & { title: string; model: string } {
  const model = md.match(/<!--\s*prevail:replay-brief\s+model=(\S+)/)?.[1] ?? "";
  const body = md.replace(/^<!--.*?-->\n?/, "");
  const lines = body.split("\n");
  let title = "";
  const sections = new Map<string, string[]>();
  let cur = "__intro";
  sections.set(cur, []);
  for (const l of lines) {
    const h1 = l.match(/^#\s+(.*)/);
    if (h1 && !title) { title = h1[1].replace(/^Rebuild:\s*/i, "").trim(); continue; }
    const h2 = l.match(/^##\s+(.*)/);
    if (h2) { cur = h2[1].trim().toLowerCase(); sections.set(cur, []); continue; }
    sections.get(cur)!.push(l);
  }
  const find = (prefix: string) => {
    for (const [k, v] of sections) if (k.startsWith(prefix)) return v.join("\n");
    return "";
  };
  const goal = find("__intro").split(/\n{2,}/).map((p) => p.replace(/\s+/g, " ").trim()).find((p) => p && !/^\(.*\)$/.test(p)) ?? "";
  return {
    title, model, goal,
    requirements: sectionItems(find("requirements")).map((text) => ({ text, source: QUOTED.test(text) ? "you" : "inferred" })),
    rules: sectionItems(find("rules")),
    decisions: sectionItems(find("decisions")),
    dead_ends: sectionItems(find("pitfalls")),
    open_questions: sectionItems(find("open questions")),
  };
}

function packDir(vault: string, slug: string) {
  const idx = readProjectsIndex(vault);
  const p = idx?.projects.find((x) => x.slug === slug);
  if (!p) throw new Error(`no project "${slug}"`);
  return { p, dir: join(vault, p.pack_dir) };
}

export function projectRestart(vault: string, slug: string, exclude: string[] = []): RestartDoc {
  const { p, dir } = packDir(vault, slug);
  let md = "";
  try { md = vreadFile(join(dir, "brief.md")); } catch { throw new Error(`"${slug}" has no brief yet; run prevail projects build`); }
  const b = parseBrief(md);
  const drop = new Set(exclude.map((x) => x.trim()));
  const keep = (xs: string[]) => xs.filter((x) => !drop.has(x));
  return {
    slug, title: p.title || b.title, goal: b.goal,
    requirements: b.requirements.filter((r) => !drop.has(r.text)),
    rules: keep(b.rules), decisions: keep(b.decisions), dead_ends: keep(b.dead_ends),
    open_questions: keep(b.open_questions.length ? b.open_questions : p.open_questions ?? []),
    brief_model: b.model || p.brief_model,
  };
}

function rawPrompts(vault: string, slug: string): string {
  const { dir } = packDir(vault, slug);
  try { return vreadFile(join(dir, "prompts.md")); } catch { return ""; }
}

export type RestartFormat = "handoff" | "intent" | "raw";

export function restartText(vault: string, slug: string, format: RestartFormat, opts: { exclude?: string[]; withPrompts?: boolean } = {}): string {
  if (format === "raw") return rawPrompts(vault, slug);
  const r = projectRestart(vault, slug, opts.exclude ?? []);
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const block = (h: string, xs: string[]) => (xs.length ? `## ${h}\n${list(xs)}\n` : "");
  if (format === "intent") {
    return [`# ${r.title}`, "", r.goal, "", block("What it has to do", r.requirements.map((x) => x.text)), block("Rules", r.rules)].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
  const parts = [
    `I worked on "${r.title}" with an earlier model. Below is everything I asked for, distilled from every prompt I typed, including the corrections I had to make. Build it again from scratch and do it properly this time. Do not make me repeat any of the rules below.`,
    "",
    `## Goal\n${r.goal}\n`,
    block("Success criteria", r.requirements.map((x) => x.text)),
    block("Rules I already had to give", r.rules),
    block("Decisions already made", r.decisions),
    block("Dead ends (do not repeat these)", r.dead_ends),
    block("Open questions (ask me before assuming)", r.open_questions),
  ];
  let text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  if (opts.withPrompts) {
    const raw = rawPrompts(vault, slug);
    if (raw) text += `\n---\n\n# Appendix: my original prompts\nThe summary above is distilled from these. Where they disagree, the later prompt wins.\n\n${raw}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// diff: which requirements an existing folder meets. Read-only on the folder.

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".turbo", ".venv", "venv", "__pycache__", ".cache", "coverage", "out", ".vercel", ".svelte-kit", "Pods", "DerivedData"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|py|rs|go|swift|kt|java|rb|php|vue|svelte|css|html|sql|toml|ya?ml)$/i;
const KEY = /^(readme(\.\w+)?|package\.json|cargo\.toml|pyproject\.toml|go\.mod|claude\.md|agents\.md|index\.html|vite\.config\.\w+|tauri\.conf\.json)$/i;

export function folderSnapshot(folder: string, cap = 150_000): { tree: string[]; files: { path: string; text: string }[] } {
  const tree: string[] = [];
  const all: { path: string; size: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || tree.length >= 2000) return;
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (tree.length >= 2000) return;
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relative(folder, full);
      if (e.isDirectory()) { tree.push(`${rel}/`); walk(full, depth + 1); }
      else if (e.isFile()) {
        tree.push(rel);
        try { all.push({ path: rel, size: statSync(full).size }); } catch { /* */ }
      }
    }
  };
  walk(folder, 0);
  const depthOf = (p: string) => p.split("/").length;
  const key = all.filter((f) => KEY.test(f.path.split("/").pop() ?? "")).sort((a, b) => depthOf(a.path) - depthOf(b.path));
  const src = all.filter((f) => SOURCE.test(f.path) && !key.includes(f) && !/\.(test|spec)\./.test(f.path) && f.size < 200_000)
    .sort((a, b) => depthOf(a.path) - depthOf(b.path) || b.size - a.size);
  const files: { path: string; text: string }[] = [];
  let used = 0;
  for (const f of [...key, ...src]) {
    if (used >= cap) break;
    let text = "";
    try { text = vreadFile(join(folder, f.path)); } catch { continue; }
    if (text.includes("\u0000")) continue;
    const room = Math.min(20_000, cap - used);
    if (room < 500) break;
    const t = text.length > room ? `${text.slice(0, room)}\n[...truncated]` : text;
    files.push({ path: f.path, text: t });
    used += t.length;
  }
  return { tree, files };
}

export function buildDiffPrompt(r: RestartDoc, snap: { tree: string[]; files: { path: string; text: string }[] }): string {
  return `You are checking an existing codebase against the requirements for "${r.title}". Goal: ${r.goal}

For EACH requirement decide from the files below whether the code clearly meets it (met), clearly does not (missed), or you cannot tell from what you can see (unclear). Copy each requirement's text exactly into exactly one list. Rules the person set count as requirements too.

Return ONLY a JSON object: {"met": [...], "missed": [...], "unclear": [...]}. No prose, no em dashes.

REQUIREMENTS:
${[...r.requirements.map((x) => x.text), ...r.rules].map((x, i) => `${i + 1}. ${x}`).join("\n")}

FILE TREE:
${snap.tree.join("\n")}

FILES:
${snap.files.map((f) => `=== ${f.path} ===\n${f.text}`).join("\n\n")}
`;
}

export interface DiffResult { met: string[]; missed: string[]; unclear: string[] }

export async function projectDiff(vault: string, slug: string, folder: string, opts: { model?: ModelChoice; run?: ModelRunner } = {}): Promise<DiffResult> {
  try { if (!statSync(folder).isDirectory()) throw new Error(); } catch { throw new Error(`not a folder: ${folder}`); }
  const r = projectRestart(vault, slug);
  const snap = folderSnapshot(folder);
  const run = opts.run ?? runModelOnce;
  const ans = parseJsonAnswer<Partial<DiffResult>>(await run(buildDiffPrompt(r, snap), opts.model ?? modelChoice()));
  const clean = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string").map((x) => sanitizeEmDashes(x)) : []);
  return { met: clean(ans.met), missed: clean(ans.missed), unclear: clean(ans.unclear) };
}
