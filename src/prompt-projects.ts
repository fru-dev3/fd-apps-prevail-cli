// Projects: the user's prompts grouped by the thing they were building, each
// turned into a REPLAY PACK a future model can rebuild the project from.
//
// The idea (Fru, 2026-09-25): prompts matter more than models. Every
// requirement, correction and follow-up typed while building something is
// the real spec. Keep those prompts verbatim, group them by project, and
// synthesize them with the most capable model available into one brief. When
// a better model ships, hand it the brief (and, if wanted, the full prompt
// history) and get a better build, without re-living every correction.
//
// Pipeline (`prevail projects build`):
//   1. corpus    every real user prompt, internal traffic removed (prompt-corpus.ts)
//   2. catalog   folder keys merged into named projects by the model
//   3. assign    prompts with no folder signal are assigned per session by the model
//   4. synthesize one replay brief per project (map/reduce over big histories)
//   5. recommend tasks, skills, apps, habits and automations across all projects
//
// Output:
//   data/domains/<domain>/memory/projects/<slug>/brief.md      the replay prompt
//   data/domains/<domain>/memory/projects/<slug>/prompts.md    every prompt as typed, in order
//   data/domains/<domain>/memory/projects/<slug>/prompts.jsonl every prompt record, exact original text included
//   data/domains/<domain>/memory/projects/<slug>/history/      earlier briefs (one per model run)
//   build/_meta/projects.json                                  index, timeline, recommendations
//   build/_meta/projects/state.json                            catalog + assignments + hashes
//   build/_meta/intents_distilled.json                         the older Intents view, fed from projects
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeModelId, scrubbedEnv, sanitizeEmDashes } from "./cli-bridge.ts";
import { runtimePath } from "./path-safety.ts";
import { loadCorpus, monthOf, type CorpusStats, type PromptRec } from "./prompt-corpus.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";

// The most capable model on each runtime. Synthesis quality is the whole
// point, so these default to the top tier; a newer model is one flag away
// (`--model`), and re-running with it rewrites every brief while the raw
// prompts stay untouched.
export const SYNTH_DEFAULTS: Record<string, string> = {
  claude: "claude-fable-5-1",
  codex: "gpt-6-astra",
};

export interface ModelChoice { cli: "claude" | "codex"; model: string }

export interface ProjectDef {
  slug: string;
  title: string;
  domain: string;
  kind: string; // app | site | video | library | research | life | ops | other
  summary: string;
  keys: string[]; // folder keys (prompt-corpus projectKeyOf) that belong to it
}

export interface PackState {
  hash: string;
  model: string;
  prompts: number;
  ts: number;
}

interface BuildState {
  version: 1;
  catalog: ProjectDef[];
  catalog_model: string;
  // session id -> project slug ("" = no project: a one-off question)
  sessions: Record<string, string>;
  packs: Record<string, PackState>;
}

export interface ProjectIntent {
  title: string;
  goal: string;
  status: "active" | "dormant" | "done";
}

export interface ProjectEntry {
  slug: string;
  title: string;
  domain: string;
  kind: string;
  summary: string;
  status: "active" | "dormant" | "done";
  prompt_count: number;
  first_ts: number;
  last_ts: number;
  monthly: Record<string, number>;
  weekly: Record<string, number>; // Monday (YYYY-MM-DD) -> prompts, for short histories
  tools: Record<string, number>;
  keys: string[];
  pack_dir: string; // vault-relative
  brief_model: string;
  brief_ts: number;
  intents: ProjectIntent[];
  takeaways: string[];
  ideas: string[];
  open_questions: string[];
}

export interface Recommendation {
  kind: "task" | "skill" | "app" | "habit" | "automation" | "project";
  title: string;
  why: string;
  domain?: string;
  project?: string; // the title the model wrote
  project_slug?: string; // the project it belongs to; titles change, slugs are the link
}

export interface ProjectsIndex {
  generated_ts: number;
  model: string;
  stats: CorpusStats & { projects: number; unassigned: number };
  months: Record<string, number>;
  projects: ProjectEntry[];
  recommendations: Recommendation[];
  recommendations_model: string;
}

// ---------------------------------------------------------------------------
// model runner

// One prompt in, one answer out. The prompt goes over stdin (histories run to
// hundreds of kB, past what argv should carry). Runs in an empty temp folder so
// no repo's CLAUDE.md/AGENTS.md rides along, with PREVAIL_INTERNAL set so the
// capture hook doesn't record Prevail's own call as something the user asked.
export type ModelRunner = (prompt: string, choice: ModelChoice) => Promise<string>;

export const runModelOnce: ModelRunner = (prompt, choice) =>
  new Promise((resolveP, reject) => {
    try { assertSafeModelId(choice.model); } catch (e) { reject(e); return; }
    const cwd = mkdtempSync(join(tmpdir(), "prevail-projects-"));
    const args = choice.cli === "claude"
      ? ["-p", "--model", choice.model, "--output-format", "text"]
      : ["exec", "--skip-git-repo-check", "-m", choice.model, "-"];
    const child = spawn(choice.cli, args, { cwd, env: { ...scrubbedEnv(), PREVAIL_INTERNAL: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60 * 1000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      if (code !== 0 && !out.trim()) reject(new Error(`${choice.cli} exited ${code}: ${err.trim().slice(-400)}`));
      else resolveP(choice.cli === "codex" ? codexAnswer(out) : out);
    });
    child.stdin.end(prompt);
  });

// `codex exec` prints a transcript; the answer is what follows the last
// "codex" speaker line, before the token footer.
function codexAnswer(raw: string): string {
  const i = raw.lastIndexOf("\ncodex\n");
  let s = i >= 0 ? raw.slice(i + 7) : raw;
  const j = s.lastIndexOf("\ntokens used");
  if (j >= 0) s = s.slice(0, j);
  return s.trim();
}

// ---------------------------------------------------------------------------
// JSON out of a model answer

export function parseJsonAnswer<T>(out: string): T {
  let s = out.trim();
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s) as T; } catch { /* fall through to a balanced slice */ }
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error("model answer had no JSON");
  const open = s[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1)) as T;
  }
  throw new Error("model answer had unbalanced JSON");
}

// ---------------------------------------------------------------------------
// helpers

// Folder keys that say where a prompt was typed but not which project it was
// about: the monorepo root, the vault root, config folders, no folder at all.
// Their prompts are assigned per session by the model instead.
export function isAmbiguousKey(key: string): boolean {
  return key === "" || key === "fru" || key === "vault" || key === "tmp" || key === "domain:general"
    || /^(fd|fw)-(apps|libs|channels|studio)$/.test(key) || key.startsWith("config:");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

// One readable line for a list: Claude Code's paste wrapper tags and the
// session scratch paths are noise here (the prompt itself is untouched).
export function displayLine(text: string, n = 240): string {
  const s = text
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/\/private\/tmp\/claude-\d+\/\S+/g, "(a scratch file)")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [...${s.length - n} more chars]` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

function sessionOf(p: PromptRec): string {
  // Prompts with no session id group by tool + day: one sitting.
  return p.session && p.session !== "unknown" ? `${p.tool}:${p.session}` : `${p.tool}:${day(p.ts)}`;
}

function hashPrompts(ps: PromptRec[]): string {
  const h = createHash("sha256");
  for (const p of ps) h.update(`${p.ts}\u0001${p.text}\u0002`);
  return h.digest("hex").slice(0, 16);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function domainsOf(vault: string): string[] {
  const root = existsSync(join(vault, "data", "domains")) ? join(vault, "data", "domains") : vault;
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_") && d.name !== "build" && d.name !== "data")
      .map((d) => d.name);
  } catch { return []; }
}

function domainDir(vault: string, domain: string): string {
  const v4 = join(vault, "data", "domains");
  return existsSync(v4) ? join(v4, domain) : join(vault, domain);
}

function statePath(vault: string) { return runtimePath(vault, join("_meta", "projects", "state.json")); }
function indexPath(vault: string) { return runtimePath(vault, join("_meta", "projects.json")); }

function readState(vault: string): BuildState {
  try {
    const s = JSON.parse(vreadFile(statePath(vault))) as BuildState;
    if (s.version === 1) return s;
  } catch { /* first run */ }
  return { version: 1, catalog: [], catalog_model: "", sessions: {}, packs: {} };
}

function writeJson(path: string, v: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  vwriteFile(path, `${JSON.stringify(v, null, 2)}\n`);
}

export function readProjectsIndex(vault: string): ProjectsIndex | null {
  try { return JSON.parse(vreadFile(indexPath(vault))) as ProjectsIndex; } catch { return null; }
}

// ---------------------------------------------------------------------------
// 2. catalog: folder keys -> named projects

export function buildCatalogPrompt(keys: { key: string; n: number; first: number; last: number; samples: string[] }[], domains: string[]): string {
  const lines = keys.map((k) => `## key: ${k.key}  (${k.n} prompts, ${day(k.first)} to ${day(k.last)})\n${k.samples.map((s) => `- ${s}`).join("\n")}`);
  return `You are organizing one person's prompt history into PROJECTS: the distinct things they were building or working on. Each "key" below is a folder the prompts were typed in (a repo, a vault domain, a tool config folder), with its size, date range and sample prompts.

Group the keys into projects:
- Merge keys that are the same product or effort (a desktop app and its engine repo and its marketing site are ONE product; a renamed folder is the same project).
- Keep genuinely separate products separate, even when they share a theme.
- Every key must be in exactly one project.
- "domain" must be one of these existing life domains: ${domains.join(", ")}. Software goes under "dev" if it exists; video channels under "content" if it exists.
- "kind" is one of: app, site, video, library, research, life, ops, other.
- "slug" is short kebab-case, stable, and names the product (e.g. "prevail", "fru-dev-site").
- "summary" is one plain sentence on what the project is.

Return ONLY a JSON array: [{"slug","title","domain","kind","summary","keys":[...]}]. No prose, no em dashes.

${lines.join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// 3. assign: sessions with no folder signal -> projects

export function buildAssignPrompt(catalog: ProjectDef[], sessions: { id: string; digest: string[] }[], domains: string[]): string {
  const cat = catalog.map((p) => `- ${p.slug}: ${p.title}. ${p.summary}`).join("\n");
  const ss = sessions.map((s, i) => `### S${i + 1}\n${s.digest.map((d) => `- ${d}`).join("\n")}`).join("\n\n");
  return `Below are work sessions from one person's prompt history whose folder didn't say what they were about. Assign each session to the project it was about.

Known projects:
${cat}

Rules:
- Use a known project slug when the session is clearly about it.
- If several sessions are about the same thing that is NOT in the list (a product, a trip, a claim, a purchase, a life decision), invent ONE new project for them: answer "new:<kebab-slug>|<Title>|<domain>" with the same slug each time. Domain must be one of: ${domains.join(", ")}.
- A one-off question with no ongoing effort behind it: answer "".
Return ONLY a JSON object mapping session label to answer, e.g. {"S1":"prevail","S2":"new:maple-claim|maple insurance claim|insurance","S3":""}. No prose.

${ss}
`;
}

// ---------------------------------------------------------------------------
// 4. synthesize: a project's prompts -> replay brief

function renderPromptLog(ps: PromptRec[], cap: number): string {
  return ps.map((p) => `[${stamp(p.ts)} ${p.tool}] ${clip(p.text.trim(), cap)}`).join("\n\n");
}

export function buildNotesPrompt(title: string, part: number, parts: number, log: string): string {
  return `You are reading part ${part} of ${parts} of the complete prompt history one person typed while working on "${title}". Extract everything a future engineer (or model) would need to REBUILD this project from scratch and get it right the first time.

Write markdown notes with these sections, each a dense bullet list with the date of the prompt(s) it comes from:
## Goals and scope
## Requirements (features, behaviour, integrations)
## Corrections and taste rules (every time the person pushed back, corrected, or said "never/always/don't": quote them)
## Decisions (what was chosen and why)
## Problems hit and how they were fixed
## Still open

Be exhaustive about corrections: they are the most valuable part. Do not invent anything the prompts don't say. No em dashes.

PROMPTS:
${log}
`;
}

export function buildBriefPrompt(p: ProjectDef, stats: { n: number; first: number; last: number }, material: string, isNotes: boolean): string {
  return `You are writing a REPLAY BRIEF for the project "${p.title}" (${p.summary}). It is distilled from all ${stats.n} prompts the person typed about it between ${day(stats.first)} and ${day(stats.last)}.

The brief is a single prompt the person will hand to a future, more capable model or coding agent to rebuild this project from scratch, better, without repeating any of the back-and-forth. It must carry every requirement, every correction and taste rule, and every hard-won decision, stated as instructions to that future builder.

Write it in markdown with exactly these sections:
# Rebuild: ${p.title}
(one paragraph: what it is, who it's for, what "done" looks like)
## Requirements
(numbered, grouped by area, specific and testable)
## Rules the person has already had to state (do not make them say these again)
(every correction and taste rule, as imperative lines; quote the person's words where they are sharp)
## Decisions already made
(choice and the reason, one line each)
## Pitfalls
(things that broke before and what fixed them)
## Acceptance checks
(how the builder proves it's done)
## Open questions
(what the person had not settled yet)

Then, after the brief, output a line with exactly "===TAKEAWAYS===" followed by ONLY a JSON object:
{"status":"active|dormant|done","intents":[{"title","goal","status"}],"takeaways":[short durable lessons],"ideas":[ideas the person raised but did not build],"open_questions":[...]}

Write it for a model, not for the person: direct, complete, no preamble, no em dashes. Never invent requirements the ${isNotes ? "notes" : "prompts"} don't support. Never state a fact about the person (job title, employer, city, age, family, finances) unless the ${isNotes ? "notes" : "prompts"} state it in so many words; leave it out rather than guess. The brief is only as trustworthy as its least-supported line.

${isNotes ? "NOTES (extracted from the full prompt history, in order):" : "PROMPTS (complete, in order):"}
${material}
`;
}

interface Takeaways { status?: string; intents?: ProjectIntent[]; takeaways?: string[]; ideas?: string[]; open_questions?: string[] }

export function splitBrief(out: string): { brief: string; take: Takeaways } {
  const i = out.indexOf("===TAKEAWAYS===");
  const brief = sanitizeEmDashes((i >= 0 ? out.slice(0, i) : out).trim().replace(/^```(?:markdown)?\n|\n```$/g, ""));
  let take: Takeaways = {};
  if (i >= 0) { try { take = parseJsonAnswer<Takeaways>(out.slice(i + 15)); } catch { /* brief still stands */ } }
  return { brief, take };
}

// ---------------------------------------------------------------------------
// 5. recommend

export function buildRecommendPrompt(projects: ProjectEntry[], ctx: { domains: string[]; skills: string[]; apps: string[] }): string {
  const ps = projects.map((p) => `- ${p.title} [${p.domain}, ${p.kind}, ${p.status}, ${p.prompt_count} prompts, ${day(p.first_ts)} to ${day(p.last_ts)}]: ${p.summary}${p.open_questions.length ? ` Open: ${p.open_questions.slice(0, 3).join("; ")}` : ""}${p.takeaways.length ? ` Lessons: ${p.takeaways.slice(0, 3).join("; ")}` : ""}`).join("\n");
  return `Below is everything one person has been working on, distilled from their full prompt history across every AI tool they use. Recommend what would most make them more productive and move their goals forward.

Projects:
${ps}

They already have these life domains: ${ctx.domains.join(", ")}
Skills already written (don't re-recommend): ${ctx.skills.slice(0, 150).join(", ") || "none"}
Apps already connected (don't re-recommend): ${ctx.apps.join(", ") || "none"}

Give 12 to 20 recommendations, the highest-leverage first, across these kinds:
- task: a concrete next action on a specific project
- skill: a reusable procedure worth writing down because they keep re-explaining it (name it, say what it does)
- app: a service or tool to connect or adopt, named specifically
- habit: a change in how they work
- automation: something that should run on a schedule or trigger instead of by hand
- project: something to start, merge, or stop

Each must be specific to THEIR history (name the project, the repeated pain, the pattern), never generic advice.
Return ONLY a JSON array: [{"kind","title","why","domain","project"}] where project is a project title or "". No prose, no em dashes.
`;
}

// ---------------------------------------------------------------------------
// pack files

function renderPromptsMd(p: ProjectDef, ps: PromptRec[]): string {
  const head = `# ${p.title}: every prompt\n\n${ps.length} prompts, ${day(ps[0].ts)} to ${day(ps[ps.length - 1].ts)}, as typed and in order. brief.md is distilled from these; prompts.jsonl holds the exact original records, and the capture streams under build/_meta/prompts/ remain the source of record.\n`;
  const body = ps.map((x) => `### ${stamp(x.ts)} · ${x.tool}${x.host ? ` · ${x.host}` : ""}${x.raw !== undefined ? " · recovered from a wrapped prompt (original in prompts.jsonl)" : ""}\n\n${x.text}\n`).join("\n");
  return `${head}\n${body}`;
}

// ---------------------------------------------------------------------------
// the build

export interface BuildOptions {
  vault: string;
  model?: ModelChoice; // synthesis model; default = most capable claude
  regroup?: boolean; // rebuild the catalog from scratch
  rebrief?: boolean; // rewrite every brief (e.g. a new model shipped)
  only?: string[]; // limit synthesis to these slugs
  minPrompts?: number; // projects smaller than this get no brief (default 5)
  concurrency?: number;
  run?: ModelRunner;
  log?: (msg: string) => void;
  home?: string; // whose harness transcripts to read (tests pass an empty one)
}

const DAY_MS = 864e5;

// A brief is rewritten when its project has grown enough to change it (15
// prompts or 15%, whichever is more), when it is a week old and anything new
// arrived, or when a different model is asked for. Without this, the
// background daemon would re-run the most capable model over an active
// project's whole history every half hour.
export function briefIsFresh(packed: PackState | undefined, hash: string, prompts: number, model: string, briefExists: boolean, now = Date.now()): boolean {
  if (!packed || !briefExists || packed.model !== model) return false;
  if (packed.hash === hash) return true;
  const grew = prompts - packed.prompts;
  if (grew >= Math.max(15, Math.ceil(packed.prompts * 0.15))) return false;
  return now - packed.ts < 7 * DAY_MS;
}

const CHUNK_CHARS = 240_000; // one map call's worth of prompt log (~60k tokens)
const PROMPT_CAP = 4_000; // a pasted log beyond this adds little to the brief

export async function buildProjects(opts: BuildOptions): Promise<ProjectsIndex> {
  const vault = opts.vault;
  const model = opts.model ?? { cli: "claude", model: SYNTH_DEFAULTS.claude };
  const run = opts.run ?? runModelOnce;
  const log = opts.log ?? (() => {});
  const conc = opts.concurrency ?? 3;
  const minPrompts = opts.minPrompts ?? 5;
  const domains = domainsOf(vault);
  const fallbackDomain = domains.includes("general") ? "general" : (domains[0] ?? "general");
  const state = readState(vault);

  // 1. corpus
  const { prompts, stats } = loadCorpus(vault, opts.home);
  log(`corpus: ${stats.records} records, ${stats.kept} real prompts (${stats.internal} internal removed)`);
  if (prompts.length === 0) throw new Error("no prompts captured yet");

  // 2. catalog from the folder keys that do name a project
  const byKey = new Map<string, PromptRec[]>();
  for (const p of prompts) if (!isAmbiguousKey(p.project)) (byKey.get(p.project) ?? byKey.set(p.project, []).get(p.project)!).push(p);
  const known = new Set(state.catalog.flatMap((c) => c.keys));
  const newKeys = [...byKey.keys()].filter((k) => opts.regroup || !known.has(k));
  if (opts.regroup) state.catalog = [];
  if (newKeys.length) {
    log(`catalog: grouping ${newKeys.length} folder keys`);
    const keyInfo = newKeys.map((k) => {
      const ps = byKey.get(k)!;
      const pick = [...ps.slice(0, 3), ...ps.slice(Math.floor(ps.length / 2), Math.floor(ps.length / 2) + 2), ...ps.slice(-3)];
      return { key: k, n: ps.length, first: ps[0].ts, last: ps[ps.length - 1].ts, samples: [...new Set(pick.map((x) => clip(oneLine(x.text), 220)))] };
    });
    const existing = state.catalog.length
      ? `\n\nThese projects already exist; put a new key into one of them (reuse its slug and repeat its fields, listing only the new keys) when it belongs there:\n${state.catalog.map((c) => `- ${c.slug}: ${c.title} (${c.domain}, ${c.kind})`).join("\n")}`
      : "";
    const answer = await run(buildCatalogPrompt(keyInfo, domains) + existing, model);
    const defs = parseJsonAnswer<ProjectDef[]>(answer);
    for (const d of defs) {
      const slug = slugify(d.slug || d.title);
      const keys = (d.keys ?? []).filter((k) => byKey.has(k));
      const hit = state.catalog.find((c) => c.slug === slug);
      if (hit) { hit.keys = [...new Set([...hit.keys, ...keys])]; continue; }
      state.catalog.push({ slug, title: d.title || slug, domain: domains.includes(d.domain) ? d.domain : fallbackDomain, kind: d.kind || "other", summary: d.summary || "", keys });
    }
    // A key the model forgot still gets a home: its own project.
    const placed = new Set(state.catalog.flatMap((c) => c.keys));
    for (const k of newKeys) {
      if (placed.has(k)) continue;
      const slug = slugify(k.replace(/^(domain|config):/, "").replace(/^(fd|fw)-(apps|libs|channels)-/, ""));
      const dom = k.startsWith("domain:") && domains.includes(k.slice(7)) ? k.slice(7) : fallbackDomain;
      state.catalog.push({ slug, title: slug, domain: dom, kind: "other", summary: "", keys: [k] });
    }
    state.catalog_model = model.model;
  }
  const keyToSlug = new Map<string, string>();
  for (const c of state.catalog) for (const k of c.keys) keyToSlug.set(k, c.slug);

  // 3. assign ambiguous sessions
  const bySession = new Map<string, PromptRec[]>();
  for (const p of prompts) if (isAmbiguousKey(p.project) || !keyToSlug.has(p.project)) (bySession.get(sessionOf(p)) ?? bySession.set(sessionOf(p), []).get(sessionOf(p))!).push(p);
  const pending = [...bySession.entries()].filter(([id]) => !(id in state.sessions) || opts.regroup);
  if (pending.length) {
    log(`assign: ${pending.length} sessions with no project folder`);
    const batches: [string, PromptRec[]][][] = [];
    for (let i = 0; i < pending.length; i += 120) batches.push(pending.slice(i, i + 120));
    await pool(batches, conc, async (batch, bi) => {
      const digest = batch.map(([id, ps]) => ({
        id,
        digest: [...new Set([...ps.slice(0, 4), ...ps.slice(-2)].map((x) => clip(oneLine(x.text), 240)))],
      }));
      try {
        const ans = parseJsonAnswer<Record<string, string>>(await run(buildAssignPrompt(state.catalog, digest, domains), model));
        batch.forEach(([id], i) => {
          const a = (ans[`S${i + 1}`] ?? "").trim();
          if (a.startsWith("new:")) {
            const [slugRaw, title, dom] = a.slice(4).split("|");
            const slug = slugify(slugRaw);
            if (!state.catalog.some((c) => c.slug === slug)) {
              state.catalog.push({ slug, title: (title || slug).trim(), domain: domains.includes((dom ?? "").trim()) ? dom.trim() : fallbackDomain, kind: "other", summary: "", keys: [] });
            }
            state.sessions[id] = slug;
          } else {
            state.sessions[id] = state.catalog.some((c) => c.slug === a) ? a : "";
          }
        });
        log(`assign: batch ${bi + 1}/${batches.length} done`);
      } catch (e) {
        log(`assign: batch ${bi + 1} failed (${(e as Error).message}); those sessions stay unassigned and retry next run`);
      }
    });
  }
  writeJson(statePath(vault), state);

  // materialize
  const members = new Map<string, PromptRec[]>();
  let unassigned = 0;
  for (const p of prompts) {
    const slug = !isAmbiguousKey(p.project) && keyToSlug.has(p.project) ? keyToSlug.get(p.project)! : state.sessions[sessionOf(p)] ?? "";
    if (!slug) { unassigned++; continue; }
    (members.get(slug) ?? members.set(slug, []).get(slug)!).push(p);
  }

  // 4. synthesize
  const prev = readProjectsIndex(vault);
  const prevBy = new Map((prev?.projects ?? []).map((p) => [p.slug, p]));
  const defs = state.catalog.filter((c) => (members.get(c.slug)?.length ?? 0) > 0);
  const entries = await pool(defs, conc, async (def): Promise<ProjectEntry> => {
    const ps = members.get(def.slug)!;
    const monthly: Record<string, number> = {};
    const weekly: Record<string, number> = {};
    const tools: Record<string, number> = {};
    for (const p of ps) {
      monthly[monthOf(p.ts)] = (monthly[monthOf(p.ts)] ?? 0) + 1;
      const wk = periodOf(p.ts, "week").key.slice(0, 10);
      weekly[wk] = (weekly[wk] ?? 0) + 1;
      tools[p.tool] = (tools[p.tool] ?? 0) + 1;
    }
    const dir = join(domainDir(vault, def.domain), "memory", "projects", def.slug);
    const rel = dir.startsWith(vault) ? dir.slice(vault.length + 1) : dir;
    const old = prevBy.get(def.slug);
    const base: ProjectEntry = {
      slug: def.slug, title: def.title, domain: def.domain, kind: def.kind, summary: def.summary,
      status: old?.status ?? (Date.now() - ps[ps.length - 1].ts < 30 * 864e5 ? "active" : "dormant"),
      prompt_count: ps.length, first_ts: ps[0].ts, last_ts: ps[ps.length - 1].ts, monthly, weekly, tools, keys: def.keys,
      pack_dir: rel, brief_model: old?.brief_model ?? "", brief_ts: old?.brief_ts ?? 0,
      intents: old?.intents ?? [], takeaways: old?.takeaways ?? [], ideas: old?.ideas ?? [], open_questions: old?.open_questions ?? [],
    };
    // The verbatim prompt file is rewritten every run: it is the asset, and
    // it costs nothing.
    mkdirSync(dir, { recursive: true });
    vwriteFile(join(dir, "prompts.md"), renderPromptsMd(def, ps));
    // Machine-exact copy: every field, and the original captured text wherever
    // the readable one had a wrapper peeled off. The capture streams remain
    // the source of record; this is a per-project copy of them.
    vwriteFile(join(dir, "prompts.jsonl"), ps.map((x) => JSON.stringify({ ts: new Date(x.ts).toISOString(), tool: x.tool, host: x.host, session: x.session, cwd: x.cwd, domain: x.domain, src: x.src, text: x.text, ...(x.raw !== undefined ? { raw: x.raw } : {}) })).join("\n") + "\n");

    const hash = hashPrompts(ps);
    const packed = state.packs[def.slug];
    const want = ps.length >= minPrompts && (!opts.only || opts.only.includes(def.slug));
    if (!want || (!opts.rebrief && briefIsFresh(packed, hash, ps.length, model.model, existsSync(join(dir, "brief.md"))))) return base;

    try {
      const full = renderPromptLog(ps, PROMPT_CAP);
      let material = full;
      let isNotes = false;
      if (full.length > CHUNK_CHARS) {
        const chunks: PromptRec[][] = [];
        let cur: PromptRec[] = [];
        let size = 0;
        for (const p of ps) {
          const n = Math.min(p.text.length, PROMPT_CAP) + 40;
          if (size + n > CHUNK_CHARS && cur.length) { chunks.push(cur); cur = []; size = 0; }
          cur.push(p); size += n;
        }
        if (cur.length) chunks.push(cur);
        log(`${def.slug}: ${ps.length} prompts in ${chunks.length} parts`);
        const notes = await pool(chunks, 2, (c, i) => run(buildNotesPrompt(def.title, i + 1, chunks.length, renderPromptLog(c, PROMPT_CAP)), model));
        material = notes.map((n, i) => `<!-- part ${i + 1}: ${day(chunks[i][0].ts)} to ${day(chunks[i][chunks[i].length - 1].ts)} -->\n${n.trim()}`).join("\n\n");
        isNotes = true;
      }
      log(`${def.slug}: writing brief from ${ps.length} prompts`);
      const out = await run(buildBriefPrompt(def, { n: ps.length, first: ps[0].ts, last: ps[ps.length - 1].ts }, material, isNotes), model);
      const { brief, take } = splitBrief(out);
      if (!brief.trim()) throw new Error("empty brief");
      const briefPath = join(dir, "brief.md");
      if (existsSync(briefPath)) {
        // Keep every earlier brief: comparing what two models made of the same
        // prompts is part of the point.
        const hist = join(dir, "history");
        mkdirSync(hist, { recursive: true });
        try { vwriteFile(join(hist, `${day(packed?.ts ?? Date.now())}-${slugify(packed?.model ?? "earlier")}.md`), vreadFile(briefPath)); } catch { /* */ }
      }
      const header = `<!-- prevail:replay-brief model=${model.model} generated=${new Date().toISOString()} prompts=${ps.length} from=${day(ps[0].ts)} to=${day(ps[ps.length - 1].ts)} -->\n`;
      vwriteFile(briefPath, header + brief + "\n");
      state.packs[def.slug] = { hash, model: model.model, prompts: ps.length, ts: Date.now() };
      writeJson(statePath(vault), state);
      const st = take.status === "done" || take.status === "dormant" || take.status === "active" ? take.status : base.status;
      return {
        ...base, status: st, brief_model: model.model, brief_ts: Date.now(),
        intents: (take.intents ?? []).filter((x) => x && x.title),
        takeaways: take.takeaways ?? [], ideas: take.ideas ?? [], open_questions: take.open_questions ?? [],
      };
    } catch (e) {
      log(`${def.slug}: brief failed (${(e as Error).message}); keeping the previous one`);
      return base;
    }
  });
  entries.sort((a, b) => b.last_ts - a.last_ts);

  // A project that no longer has any prompts (a filter now recognizes them as
  // Prevail's own, or they were reassigned) keeps its pack, moved aside
  // rather than deleted.
  for (const c of state.catalog) {
    if (members.has(c.slug)) continue;
    const dir = join(domainDir(vault, c.domain), "memory", "projects", c.slug);
    if (!existsSync(dir)) continue;
    const dest = join(domainDir(vault, c.domain), "memory", "projects", "_archived", `${c.slug}-${day(Date.now())}`);
    try { mkdirSync(join(dest, ".."), { recursive: true }); renameSync(dir, dest); log(`${c.slug}: no prompts left; pack moved to ${dest.slice(vault.length + 1)}`); } catch { /* leave it */ }
    delete state.packs[c.slug];
  }
  writeJson(statePath(vault), state);

  // 5. recommend: when a brief changed, or once a day, not on every small run
  let recs = prev?.recommendations ?? [];
  let recModel = prev?.recommendations_model ?? "";
  const briefed = entries.filter((e) => e.brief_model);
  const anyNewBrief = entries.some((e) => e.brief_ts >= (prev?.generated_ts ?? 0) && e.brief_ts > 0 && e.brief_ts !== (prevBy.get(e.slug)?.brief_ts ?? 0));
  const recsStale = !prev || recs.length === 0 || recModel !== model.model || Date.now() - prev.generated_ts > DAY_MS;
  if (briefed.length && (anyNewBrief || recsStale)) {
    try {
      const ctx = { domains, skills: listSkills(vault), apps: listApps(vault) };
      recs = parseJsonAnswer<Recommendation[]>(await run(buildRecommendPrompt(entries.filter((e) => e.prompt_count >= minPrompts), ctx), model))
        .filter((r) => r && r.title)
        .map((r) => ({ ...r, title: sanitizeEmDashes(r.title), why: sanitizeEmDashes(r.why ?? "") }));
      const byTitle = new Map(entries.map((e) => [e.title.toLowerCase(), e.slug]));
      for (const r of recs) r.project_slug = byTitle.get((r.project ?? "").toLowerCase()) ?? "";
      recModel = model.model;
    } catch (e) { log(`recommendations failed (${(e as Error).message}); keeping the previous set`); }
  }

  const months: Record<string, number> = {};
  for (const p of prompts) months[monthOf(p.ts)] = (months[monthOf(p.ts)] ?? 0) + 1;
  const index: ProjectsIndex = {
    generated_ts: Date.now(), model: model.model,
    stats: { ...stats, projects: entries.length, unassigned },
    months, projects: entries, recommendations: recs, recommendations_model: recModel,
  };
  writeJson(indexPath(vault), index);
  writeIntentsDistilled(vault, index);
  return index;
}

// The older Settings > Intents view and every reader of intents_distilled.json
// (home briefing, loops, app suggestions, omega) now see the whole history:
// one intent per project, most recent first.
function writeIntentsDistilled(vault: string, index: ProjectsIndex) {
  const intents = index.projects.filter((p) => p.brief_model).map((p) => ({
    title: p.title,
    goal: p.intents[0]?.goal ?? p.summary,
    underlying_need: p.summary,
    domains: [p.domain],
    sources: Object.keys(p.tools),
    status: p.status === "done" ? "resolved" : p.status,
    confidence: 0.9,
    open_questions: p.open_questions,
    evidence: p.takeaways.slice(0, 4),
    prompt_refs: [],
    prompt_ts: [],
    recommendations: index.recommendations.filter((r) => r.project === p.title).map((r) => r.title),
    project: p.slug,
    first_ts: p.first_ts,
    last_ts: p.last_ts,
    prompt_count: p.prompt_count,
  }));
  writeJson(runtimePath(vault, join("_meta", "intents_distilled.json")), {
    generated_ts: Math.floor(index.generated_ts / 1000),
    source_count: index.stats.kept,
    source: "projects",
    intents,
  });
}

function listSkills(vault: string): string[] {
  const out: string[] = [];
  for (const d of domainsOf(vault)) {
    try { for (const s of readdirSync(join(domainDir(vault, d), "skills"), { withFileTypes: true })) if (s.isDirectory() && !s.name.startsWith("_")) out.push(s.name); } catch { /* */ }
  }
  return [...new Set(out)];
}

function listApps(vault: string): string[] {
  try { return readdirSync(join(vault, "data", "apps"), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return []; }
}

// The prompt a user hands a new model to rebuild a project: the brief, and
// with `withPrompts` the full verbatim history appended as the source record.
export function replayPrompt(vault: string, slug: string, withPrompts = false): string {
  const idx = readProjectsIndex(vault);
  const p = idx?.projects.find((x) => x.slug === slug);
  if (!p) throw new Error(`no project "${slug}"`);
  const dir = join(vault, p.pack_dir);
  let brief = "";
  try { brief = vreadFile(join(dir, "brief.md")).replace(/^<!--.*?-->\n/, ""); } catch { throw new Error(`"${slug}" has no brief yet; run prevail projects build`); }
  if (!withPrompts) return brief;
  let prompts = "";
  try { prompts = vreadFile(join(dir, "prompts.md")); } catch { /* */ }
  return `${brief}\n\n---\n\n# Appendix: the original prompts\nThe brief above is distilled from these. Where they disagree, the later prompt wins.\n\n${prompts}`;
}

// ---------------------------------------------------------------------------
// Retrospect: the same corpus, rolled up by time. Pure read-over (no model
// call): each prompt lands on the project the last build assigned it to, so
// "where did my attention go" and "what was I building" are one data source.

export type Vantage = "day" | "week" | "month" | "year";

export interface TimelinePeriod {
  key: string;
  label: string;
  total: number;
  byProject: { slug: string; title: string; domain: string; count: number }[];
  byDomain: { domain: string; count: number }[];
  threads: { domain: string; project: string; message: string; ts: number; count: number }[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// tzOffsetMinutes is Date.getTimezoneOffset() from the viewer, so periods
// break at the viewer's midnight, not the machine's.
export function periodOf(ts: number, vantage: Vantage, tzOffsetMinutes = 0): { key: string; label: string } {
  const d = new Date(ts - tzOffsetMinutes * 60_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const dd = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (vantage === "day") return { key: `${y}-${pad(m + 1)}-${pad(dd)}`, label: `${MONTHS[m]} ${dd}, ${y}` };
  if (vantage === "year") return { key: `${y}`, label: `${y}` };
  if (vantage === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const mon = new Date(Date.UTC(y, m, dd - dow));
    const sun = new Date(Date.UTC(y, m, dd - dow + 6));
    const label = mon.getUTCMonth() === sun.getUTCMonth()
      ? `${MONTHS[mon.getUTCMonth()]} ${mon.getUTCDate()} to ${sun.getUTCDate()}`
      : `${MONTHS[mon.getUTCMonth()]} ${mon.getUTCDate()} to ${MONTHS[sun.getUTCMonth()]} ${sun.getUTCDate()}`;
    return { key: `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}w`, label };
  }
  return { key: `${y}-${pad(m + 1)}`, label: `${MONTHS_LONG[m]} ${y}` };
}

// Which project each prompt belongs to, from the saved catalog and session
// assignments. Prompts from folders or sessions the last build hasn't seen
// fall under "" until the next build.
export function assignedPrompts(vault: string, home?: string): { prompts: PromptRec[]; slugOf: (p: PromptRec) => string; catalog: ProjectDef[] } {
  const state = readState(vault);
  const { prompts } = loadCorpus(vault, home);
  const keyToSlug = new Map<string, string>();
  for (const c of state.catalog) for (const k of c.keys) keyToSlug.set(k, c.slug);
  const slugOf = (p: PromptRec) => (!isAmbiguousKey(p.project) && keyToSlug.has(p.project) ? keyToSlug.get(p.project)! : state.sessions[sessionOf(p)] ?? "");
  return { prompts, slugOf, catalog: state.catalog };
}

export function timeline(vault: string, vantage: Vantage, tzOffsetMinutes = 0, home?: string): { vantage: Vantage; periods: TimelinePeriod[]; built: boolean } {
  const { prompts, slugOf, catalog } = assignedPrompts(vault, home);
  const bySlug = new Map(catalog.map((c) => [c.slug, c]));
  interface Acc { label: string; total: number; proj: Map<string, number>; dom: Map<string, number>; threads: Map<string, { domain: string; project: string; message: string; ts: number; count: number }> }
  const buckets = new Map<string, Acc>();
  for (const p of prompts) {
    const { key, label } = periodOf(p.ts, vantage, tzOffsetMinutes);
    const b = buckets.get(key) ?? { label, total: 0, proj: new Map(), dom: new Map(), threads: new Map() };
    buckets.set(key, b);
    const slug = slugOf(p);
    const def = bySlug.get(slug);
    const domain = def?.domain ?? (p.domain || "general");
    b.total++;
    b.proj.set(slug, (b.proj.get(slug) ?? 0) + 1);
    b.dom.set(domain, (b.dom.get(domain) ?? 0) + 1);
    const tk = sessionOf(p);
    const t = b.threads.get(tk) ?? { domain, project: slug, message: displayLine(p.text), ts: p.ts, count: 0 };
    t.count++;
    b.threads.set(tk, t);
  }
  const periods = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, b]): TimelinePeriod => ({
    key, label: b.label, total: b.total,
    byProject: [...b.proj.entries()].sort((x, y) => y[1] - x[1]).map(([slug, count]) => ({ slug, title: bySlug.get(slug)?.title ?? "Other", domain: bySlug.get(slug)?.domain ?? "general", count })),
    byDomain: [...b.dom.entries()].sort((x, y) => y[1] - x[1]).map(([domain, count]) => ({ domain, count })),
    threads: [...b.threads.values()].sort((x, y) => y.count - x.count || y.ts - x.ts).slice(0, 40),
  }));
  return { vantage, periods, built: catalog.length > 0 };
}

// ---------------------------------------------------------------------------
// curation

// Rename a project (its slug, and optionally its title). The slug names the
// pack folder, so the folder moves with it; the brief is kept, not rewritten.
export function renameProject(vault: string, from: string, to: string, title?: string): ProjectDef {
  const state = readState(vault);
  const def = state.catalog.find((c) => c.slug === from);
  if (!def) throw new Error(`no project "${from}"`);
  const oldTitle = readProjectsIndex(vault)?.projects.find((p) => p.slug === from)?.title ?? def.title;
  const slug = slugify(to);
  if (slug !== from && state.catalog.some((c) => c.slug === slug)) throw new Error(`"${slug}" already exists`);
  const oldDir = join(domainDir(vault, def.domain), "memory", "projects", from);
  const newDir = join(domainDir(vault, def.domain), "memory", "projects", slug);
  if (slug !== from && existsSync(oldDir)) renameSync(oldDir, newDir);
  def.slug = slug;
  if (title) def.title = title;
  for (const [sid, s] of Object.entries(state.sessions)) if (s === from) state.sessions[sid] = slug;
  if (state.packs[from]) { state.packs[slug] = state.packs[from]; if (slug !== from) delete state.packs[from]; }
  writeJson(statePath(vault), state);
  const idx = readProjectsIndex(vault);
  if (idx) {
    for (const p of idx.projects) {
      if (p.slug !== from) continue;
      p.slug = slug;
      if (title) p.title = title;
      p.pack_dir = p.pack_dir.replace(/[^/]+$/, slug);
    }
    // Recommendations link by slug; older ones only carry the title.
    for (const r of idx.recommendations) {
      if (r.project_slug === from || (!r.project_slug && r.project === oldTitle)) { r.project_slug = slug; if (title) r.project = title; }
    }
    writeJson(indexPath(vault), idx);
    writeIntentsDistilled(vault, idx);
  }
  return def;
}
