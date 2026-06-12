import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { vreadFile, vwriteFile } from "./vault-session.ts";

import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";
import { buildCouncilPanel, runCouncilOneShot } from "./council-runner.ts";

// Canonical benchmark — the USER's personal set of questions with KNOWN
// ground-truth verdicts. Distinct from the bundled bench/ generic suite:
//
//   bench/questions/          ← bundled-with-app, generic, sample
//   <vault>/benchmark/        ← the user's own canonical Q&A
//     questions/              ← each .md = one question + expected outcome
//     runs/                   ← per-model run output dirs
//
// A canonical question carries a frontmatter block declaring what the
// CORRECT verdict looks like (the user's actual decision, made in real
// life, that they stand behind). When we point a new model at the
// suite, we score how well its reply aligns with those known answers.
//
// The frontmatter shape extends the existing bench question format with
// two ground-truth fields:
//
//   expected_decision: a short noun phrase or sentence — "invest"
//                       or "stay another 12 months", what the answer
//                       SHOULD recommend.
//   expected_verdict_keywords: a list of substrings that should appear
//                              in a competent verdict — "liquidity",
//                              "spread", "6 month floor". Mechanical
//                              floor score is the percentage hit.

export interface CanonicalQuestion {
  id: string;
  domain: string;
  /** Archived questions are kept for the historical runs that used them,
   *  but excluded from new runs and the active list. */
  archived?: boolean;
  prompt: string;
  context?: string;
  notes?: string;
  council?: boolean; // true = run via runCouncil; false = single chat
  expected_decision?: string;
  expected_verdict_keywords?: string[];
  // Relative paths under <vault>/benchmark/attachments/ to inline into
  // the prompt. Markdown / plain text recommended for portability;
  // binary formats (PDFs, images) work when the receiving CLI has
  // native multimodal support, but the bench runner currently inlines
  // their CONTENT as text so non-text files won't be meaningful for
  // Codex / Ollama. Use the build-bench-attachments.sh script to
  // generate companion PDFs for visual inspection.
  attachments?: string[];
  filePath: string;
}

export function benchmarkRoot(vaultPath: string): string {
  return join(vaultPath, "benchmark");
}

export function attachmentsDir(vaultPath: string): string {
  return join(benchmarkRoot(vaultPath), "attachments");
}

export function questionsDir(vaultPath: string): string {
  return join(benchmarkRoot(vaultPath), "questions");
}

export function runsDir(vaultPath: string): string {
  return join(benchmarkRoot(vaultPath), "runs");
}

export function ensureScaffold(vaultPath: string): void {
  for (const dir of [
    benchmarkRoot(vaultPath),
    questionsDir(vaultPath),
    runsDir(vaultPath),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

interface ParsedFrontmatter {
  fields: Record<string, string | string[]>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, body: raw };
  const fields: Record<string, string | string[]> = {};
  let i = 1;
  while (i < lines.length && lines[i]!.trim() !== "---") {
    const line = lines[i]!;
    const m = line.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
    if (m) {
      const key = m[1]!;
      const value = m[2]!.trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        // Inline list: [foo, bar, baz]
        fields[key] = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      } else {
        fields[key] = value;
      }
    }
    i++;
  }
  const body = lines.slice(i + 1).join("\n");
  return { fields, body };
}

function extractSection(body: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = body.match(re);
  if (!m) return undefined;
  const start = m.index! + m[0].length;
  const rest = body.slice(start);
  const next = rest.match(/^##\s+/m);
  const section = (next ? rest.slice(0, next.index!) : rest).trim();
  return section || undefined;
}

export function readQuestion(filePath: string): CanonicalQuestion | null {
  let raw = "";
  try { raw = vreadFile(filePath); } catch { return null; }
  const { fields, body } = parseFrontmatter(raw);
  const id = typeof fields.id === "string" ? fields.id : null;
  const domain = typeof fields.domain === "string" ? fields.domain : null;
  if (!id || !domain) return null;
  const prompt = extractSection(body, "Prompt") ?? "";
  return {
    id,
    domain,
    archived: typeof fields.archived === "string" ? fields.archived === "true" : undefined,
    prompt,
    context: extractSection(body, "Context"),
    notes: extractSection(body, "Notes"),
    council: typeof fields.council === "string" ? fields.council === "true" : undefined,
    expected_decision: typeof fields.expected_decision === "string" ? fields.expected_decision : undefined,
    expected_verdict_keywords: Array.isArray(fields.expected_verdict_keywords)
      ? fields.expected_verdict_keywords
      : undefined,
    attachments: Array.isArray(fields.attachments)
      ? (fields.attachments as string[]).filter((s) => typeof s === "string")
      : undefined,
    filePath,
  };
}

export function listQuestions(vaultPath: string): CanonicalQuestion[] {
  const dir = questionsDir(vaultPath);
  if (!existsSync(dir)) return [];
  const out: CanonicalQuestion[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const q = readQuestion(join(dir, entry));
    if (q && !q.archived) out.push(q);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

interface SeedDraftArgs {
  vaultPath: string;
  domain: string;
  prompt?: string;
  context?: string;
  notes?: string;
  council?: boolean;
  expected_decision?: string;
  expected_verdict_keywords?: string[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
}

function nextDraftId(vaultPath: string, domain: string, hint: string): string {
  const base = `${domain}-${slugify(hint) || "draft"}`;
  let candidate = base;
  let n = 2;
  const existing = new Set(listQuestions(vaultPath).map((q) => q.id));
  while (existing.has(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

// Write a question file. Returns the absolute path. Caller can hand
// this to the editor for the user to fill in the blanks. Filled-in
// fields are persisted as-is; missing ones get instructive placeholders
// the user replaces.
export function writeDraftQuestion(args: SeedDraftArgs): string {
  ensureScaffold(args.vaultPath);
  const id = nextDraftId(args.vaultPath, args.domain, args.prompt ?? "draft");
  const path = join(questionsDir(args.vaultPath), `${id}.md`);
  const fm: string[] = ["---"];
  fm.push(`id: ${id}`);
  fm.push(`domain: ${args.domain}`);
  fm.push(`created: ${dayKey(Date.now())}`);
  fm.push(`source: ai`);
  if (args.council !== undefined) fm.push(`council: ${args.council}`);
  if (args.expected_decision) {
    fm.push(`expected_decision: ${escapeYaml(args.expected_decision)}`);
  } else {
    fm.push(`expected_decision: <FILL IN: one short sentence — what the answer SHOULD recommend>`);
  }
  if (args.expected_verdict_keywords && args.expected_verdict_keywords.length > 0) {
    fm.push(`expected_verdict_keywords: [${args.expected_verdict_keywords.map(escapeKeyword).join(", ")}]`);
  } else {
    fm.push(`expected_verdict_keywords: [<keyword1>, <keyword2>, <keyword3>]`);
  }
  fm.push("---");
  fm.push("");
  fm.push("## Prompt");
  fm.push("");
  fm.push(args.prompt ?? "<FILL IN: the question as you'd type it to the council>");
  fm.push("");
  fm.push("## Context");
  fm.push("");
  fm.push(args.context ?? "<FILL IN: facts the model needs — numbers, dates, constraints>");
  fm.push("");
  fm.push("## Notes");
  fm.push("");
  fm.push(args.notes ?? "<FILL IN: what you actually decided, and why. Real-world outcome if known.>");
  fm.push("");
  vwriteFile(path, fm.join("\n"));
  return path;
}

function escapeYaml(s: string): string {
  if (/[:#&*!|>'"%@`]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function escapeKeyword(s: string): string {
  if (/[\s,\[\]]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

// --- RUN -----------------------------------------------------------------

export interface CanonicalRunArgs {
  vaultPath: string;
  questions: CanonicalQuestion[];
  clis: AvailableCli[];
  // Which CLI to run the question through. When undefined and the
  // question has council=true, the call is fanned to the whole panel
  // via runCouncilOneShot. When defined, the question is run as a
  // single chat — useful for benchmarking ONE new model against the
  // canonical set.
  targetCli?: AvailableCli;
  targetModel?: string;
  signal?: AbortSignal;
  onProgress?: (id: string, status: "start" | "ok" | "error", info?: string) => void;
}

export interface CanonicalRunRecord {
  id: string;
  domain: string;
  prompt: string;
  expected_decision?: string;
  expected_verdict_keywords?: string[];
  reply: string;
  ms: number;
  council: boolean;
  cli?: string;
  model?: string;
  ok: boolean;
  error?: string;
}

// Per-attachment inline budget. The prompt build truncates the read
// file to this many chars and labels the truncation. Keeps a single
// 50KB attachment from blowing out the prompt size for cheap CLIs
// while still letting a model see enough context to reason from.
const ATTACHMENT_CHAR_BUDGET = 16000;

function buildQuestionPrompt(q: CanonicalQuestion, vaultPath: string): string {
  const parts: string[] = [];
  if (q.context) {
    parts.push(`Context:\n${q.context.trim()}`);
    parts.push("");
  }
  // Inline attachments as labeled blocks. The runner is single-CLI-
  // agnostic by design — we don't translate to @path syntax for
  // Claude even though Claude Code would resolve it. Inlining keeps
  // Codex/Antigravity/Ollama on the same footing and avoids the
  // per-CLI attachment-syntax sprawl. Binary formats (PDFs/images)
  // come out as their raw bytes decoded as UTF-8 — meaningful for
  // PDFs that contain extractable text in their stream, useless for
  // images. Use `bash scripts/build-bench-attachments.sh` to produce
  // companion PDFs for visual inspection; this runner sees the .md.
  if (q.attachments && q.attachments.length > 0) {
    const dir = attachmentsDir(vaultPath);
    for (const rel of q.attachments) {
      const full = join(dir, rel);
      let content = "";
      try {
        content = vreadFile(full);
      } catch {
        content = `(could not read attachment: ${rel})`;
      }
      const truncated =
        content.length > ATTACHMENT_CHAR_BUDGET
          ? content.slice(0, ATTACHMENT_CHAR_BUDGET) +
            `\n\n[... attachment truncated at ${ATTACHMENT_CHAR_BUDGET} chars]`
          : content;
      parts.push(`[ATTACHMENT: ${rel}]`);
      parts.push(truncated);
      parts.push("[END ATTACHMENT]");
      parts.push("");
    }
  }
  parts.push(q.prompt.trim());
  return parts.join("\n");
}

// Run the entire canonical set (or a filtered subset). Returns one
// record per question. Caller writes the records to disk via
// writeRunDirectory below.
export async function runCanonicalSet(args: CanonicalRunArgs): Promise<CanonicalRunRecord[]> {
  const records: CanonicalRunRecord[] = [];
  for (const q of args.questions) {
    args.onProgress?.(q.id, "start");
    const prompt = buildQuestionPrompt(q, args.vaultPath);
    const cwd = join(args.vaultPath, q.domain);
    const effectiveCwd = existsSync(cwd) ? cwd : args.vaultPath;
    const start = Date.now();
    // When the question is council-flagged AND no specific target CLI
    // was passed, run the whole council. When a target IS pinned, run
    // it as a single chat against that CLI — that's the "test new
    // model" use case.
    const useCouncil = q.council === true && !args.targetCli;
    try {
      if (useCouncil) {
        const panel = buildCouncilPanel(args.clis);
        const result = await runCouncilOneShot({
          prompt,
          cwd: effectiveCwd,
          panelists: panel,
          signal: args.signal,
        });
        records.push({
          id: q.id,
          domain: q.domain,
          prompt,
          expected_decision: q.expected_decision,
          expected_verdict_keywords: q.expected_verdict_keywords,
          reply: result.verdict,
          ms: Date.now() - start,
          council: true,
          ok: !result.degraded,
        });
        args.onProgress?.(q.id, "ok", `council · ${result.panel.length} panelists`);
      } else {
        const cli = args.targetCli ?? args.clis[0];
        if (!cli) throw new Error("no CLI available");
        const reply = await runChatTurn({
          prompt,
          cwd: effectiveCwd,
          cli,
          model: args.targetModel ?? "",
          isFirst: true,
          bare: true,
          signal: args.signal,
        });
        records.push({
          id: q.id,
          domain: q.domain,
          prompt,
          expected_decision: q.expected_decision,
          expected_verdict_keywords: q.expected_verdict_keywords,
          reply,
          ms: Date.now() - start,
          council: false,
          cli: cli.kind,
          model: args.targetModel,
          ok: true,
        });
        args.onProgress?.(q.id, "ok", `${cli.label}${args.targetModel ? "·" + args.targetModel : ""}`);
      }
    } catch (err) {
      records.push({
        id: q.id,
        domain: q.domain,
        prompt,
        expected_decision: q.expected_decision,
        expected_verdict_keywords: q.expected_verdict_keywords,
        reply: "",
        ms: Date.now() - start,
        council: useCouncil,
        cli: args.targetCli?.kind,
        model: args.targetModel,
        ok: false,
        error: (err as Error).message,
      });
      args.onProgress?.(q.id, "error", (err as Error).message);
    }
  }
  return records;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Build the human-readable name for a run directory:
//   2026-06-04_claude-opus-4-7
//   2026-06-04_council
function runLabel(args: { targetCli?: AvailableCli; targetModel?: string }): string {
  if (!args.targetCli) return "council";
  const parts: string[] = [args.targetCli.kind];
  if (args.targetModel && args.targetModel.trim()) parts.push(args.targetModel.trim());
  return parts.join("-");
}

export function writeRunDirectory(args: {
  vaultPath: string;
  records: CanonicalRunRecord[];
  ts?: number;
  targetCli?: AvailableCli;
  targetModel?: string;
  batchId?: string;
  batchLabel?: string;
}): string {
  const ts = args.ts ?? Date.now();
  ensureScaffold(args.vaultPath);
  let label = `${dayKey(ts)}_${runLabel(args)}`;
  let dir = join(runsDir(args.vaultPath), label);
  // Same model rerun on the same day must be a NEW run, never a reuse of the
  // existing directory (whose stale score.json made `score --all` skip it, so
  // a rerun looked instantly "finished" with the old numbers).
  if (existsSync(dir)) {
    const d = new Date(ts);
    const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("-");
    label = `${label}_${hms}`;
    dir = join(runsDir(args.vaultPath), label);
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Run metadata: the desktop reruns and labels from this instead of parsing
  // the directory name (which now carries a dedupe time suffix on reruns).
  vwriteFile(
    join(dir, "meta.json"),
    JSON.stringify({
      cli: args.targetCli?.kind ?? null,
      model: args.targetModel ?? null,
      council: !args.targetCli,
      ts,
    }, null, 2),
  );
  // Batch membership: model runs launched together share one batch id so the
  // UI can group and rerun them as a unit. (--batch was accepted and silently
  // dropped before this; batch.json never existed.)
  if (args.batchId) {
    vwriteFile(join(dir, "batch.json"), JSON.stringify({ id: args.batchId, label: args.batchLabel ?? null }, null, 2));
  }
  // results.md — one section per question with the reply, timing, and
  // any error. Greppable, PR-able, the source of truth for `bench score`.
  const md: string[] = [];
  md.push(`# canonical run · ${label}`);
  md.push("");
  md.push(`- date: ${new Date(ts).toISOString()}`);
  md.push(`- target: ${runLabel(args)}`);
  md.push(`- questions: ${args.records.length}`);
  const ok = args.records.filter((r) => r.ok).length;
  md.push(`- successful: ${ok}/${args.records.length}`);
  md.push("");
  for (const r of args.records) {
    md.push(`## ${r.id}`);
    md.push("");
    md.push(`- domain: ${r.domain}`);
    md.push(`- council: ${r.council}`);
    if (r.cli) md.push(`- cli: ${r.cli}${r.model ? "·" + r.model : ""}`);
    md.push(`- ms: ${r.ms}`);
    md.push(`- ok: ${r.ok}`);
    if (r.expected_decision) md.push(`- expected_decision: ${r.expected_decision}`);
    if (r.expected_verdict_keywords) md.push(`- expected_verdict_keywords: [${r.expected_verdict_keywords.join(", ")}]`);
    md.push("");
    md.push(`### prompt`);
    md.push("");
    md.push(r.prompt);
    md.push("");
    md.push(`### reply`);
    md.push("");
    md.push(r.ok ? r.reply : `(error: ${r.error})`);
    md.push("");
    md.push("---");
    md.push("");
  }
  vwriteFile(join(dir, "results.md"), md.join("\n"));
  // results.json — machine-readable mirror for `bench score` to load
  // without re-parsing markdown.
  vwriteFile(
    join(dir, "results.json"),
    JSON.stringify(args.records, null, 2),
  );
  return dir;
}

// --- SCORE ---------------------------------------------------------------

export interface QuestionScore {
  id: string;
  domain: string;
  // Mechanical keyword-match floor: percentage of
  // expected_verdict_keywords that appear (case-insensitive,
  // substring-match) in the model's reply. Null when the question has
  // no expected_verdict_keywords. Range 0-100.
  keyword_score: number | null;
  keyword_hits: string[];
  keyword_misses: string[];
  // LLM-as-judge qualitative score. Range 0-10. Null when no judge
  // ran (e.g. no CLIs available, or scoring was called with --no-judge).
  judge_score: number | null;
  judge_rationale: string | null;
}

export interface RunScore {
  runDir: string;
  label: string;
  questionScores: QuestionScore[];
  // Per-run aggregates.
  keyword_avg: number | null;
  judge_avg: number | null;
}

function keywordMatch(reply: string, keywords?: string[]): {
  score: number | null;
  hits: string[];
  misses: string[];
} {
  if (!keywords || keywords.length === 0) {
    return { score: null, hits: [], misses: [] };
  }
  const lowered = reply.toLowerCase();
  const hits: string[] = [];
  const misses: string[] = [];
  for (const k of keywords) {
    if (lowered.includes(k.toLowerCase())) hits.push(k);
    else misses.push(k);
  }
  const score = Math.round((hits.length / keywords.length) * 100);
  return { score, hits, misses };
}

const JUDGE_INSTRUCTION = [
  "You are scoring a model's answer to a benchmark question.",
  "The user has a KNOWN correct decision they stand behind.",
  "Read the question, the expected decision (ground truth), and the",
  "model's reply. Output a score from 0 to 10 and a one-line rationale.",
  "Scoring guidance:",
  "  10 = reply clearly recommends the expected decision with",
  "       reasoning that matches the user's stated rationale",
  "   7 = recommends roughly the right decision but reasoning is",
  "       weak or different from what the user found compelling",
  "   5 = mixed — could be read as supporting either side",
  "   3 = recommends the WRONG decision but at least engages",
  "   0 = recommends the WRONG decision OR fails to commit",
  "Reply with EXACTLY two lines and nothing else:",
  "SCORE: <integer 0-10>",
  "WHY: <one short sentence>",
].join("\n");

async function judgeOne(
  judgeCli: AvailableCli,
  judgeModel: string,
  record: CanonicalRunRecord,
  signal?: AbortSignal,
): Promise<{ score: number | null; rationale: string | null }> {
  if (!record.expected_decision || !record.reply) return { score: null, rationale: null };
  const prompt = [
    JUDGE_INSTRUCTION,
    "",
    "QUESTION:",
    record.prompt,
    "",
    "EXPECTED DECISION (user's ground truth):",
    record.expected_decision,
    "",
    "MODEL'S REPLY:",
    record.reply.slice(0, 8000),
  ].join("\n");
  let raw = "";
  try {
    raw = await runChatTurn({
      prompt,
      cwd: process.cwd(),
      cli: judgeCli,
      model: judgeModel,
      isFirst: true,
      bare: true,
      signal,
    });
  } catch {
    return { score: null, rationale: null };
  }
  const scoreMatch = raw.match(/^SCORE:\s*(\d+)/im);
  const whyMatch = raw.match(/^WHY:\s*(.+)$/im);
  if (!scoreMatch) return { score: null, rationale: null };
  const score = Math.max(0, Math.min(10, parseInt(scoreMatch[1]!, 10)));
  return { score, rationale: whyMatch?.[1]?.trim() ?? null };
}

export interface ScoreArgs {
  vaultPath: string;
  runDir: string;
  judgeCli?: AvailableCli;
  judgeModel?: string;
  signal?: AbortSignal;
  onProgress?: (id: string) => void;
}

export async function scoreRun(args: ScoreArgs): Promise<RunScore> {
  const jsonFile = join(args.runDir, "results.json");
  const raw = vreadFile(jsonFile);
  const records: CanonicalRunRecord[] = JSON.parse(raw);
  const questionScores: QuestionScore[] = [];
  for (const r of records) {
    args.onProgress?.(r.id);
    const km = keywordMatch(r.reply, r.expected_verdict_keywords);
    let judge_score: number | null = null;
    let judge_rationale: string | null = null;
    if (args.judgeCli && r.expected_decision && r.reply) {
      const j = await judgeOne(args.judgeCli, args.judgeModel ?? "", r, args.signal);
      judge_score = j.score;
      judge_rationale = j.rationale;
    }
    questionScores.push({
      id: r.id,
      domain: r.domain,
      keyword_score: km.score,
      keyword_hits: km.hits,
      keyword_misses: km.misses,
      judge_score,
      judge_rationale,
    });
  }
  const kScores = questionScores.map((q) => q.keyword_score).filter((s): s is number => s !== null);
  const jScores = questionScores.map((q) => q.judge_score).filter((s): s is number => s !== null);
  const avg = (xs: number[]) => xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  const result: RunScore = {
    runDir: args.runDir,
    label: args.runDir.split("/").pop() ?? args.runDir,
    questionScores,
    keyword_avg: avg(kScores),
    judge_avg: avg(jScores),
  };
  vwriteFile(join(args.runDir, "score.json"), JSON.stringify(result, null, 2));
  // Markdown scoreboard alongside the json for grep/PR review.
  const md: string[] = [];
  md.push(`# score · ${result.label}`);
  md.push("");
  md.push(`- keyword_avg: ${result.keyword_avg ?? "—"}%`);
  md.push(`- judge_avg:   ${result.judge_avg ?? "—"} / 10`);
  md.push("");
  md.push(`| id | domain | keyword% | judge/10 | rationale |`);
  md.push(`| --- | --- | --- | --- | --- |`);
  for (const q of questionScores) {
    md.push(`| ${q.id} | ${q.domain} | ${q.keyword_score ?? "—"} | ${q.judge_score ?? "—"} | ${q.judge_rationale ?? ""} |`);
  }
  vwriteFile(join(args.runDir, "score.md"), md.join("\n"));
  return result;
}

// Leaderboard: read every <vault>/benchmark/runs/*/score.json and
// produce a table sorted by judge_avg (when present) or keyword_avg.
export interface LeaderboardEntry {
  label: string;
  runDir: string;
  keyword_avg: number | null;
  judge_avg: number | null;
  questions: number;
}

export function buildLeaderboard(vaultPath: string): LeaderboardEntry[] {
  const root = runsDir(vaultPath);
  if (!existsSync(root)) return [];
  const out: LeaderboardEntry[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const scoreFile = join(dir, "score.json");
    if (!existsSync(scoreFile)) continue;
    try {
      const data: RunScore = JSON.parse(vreadFile(scoreFile));
      out.push({
        label: data.label,
        runDir: data.runDir,
        keyword_avg: data.keyword_avg,
        judge_avg: data.judge_avg,
        questions: data.questionScores.length,
      });
    } catch {
      /* skip malformed score files */
    }
  }
  return out.sort((a, b) => {
    const aj = a.judge_avg ?? -1;
    const bj = b.judge_avg ?? -1;
    if (aj !== bj) return bj - aj;
    return (b.keyword_avg ?? -1) - (a.keyword_avg ?? -1);
  });
}

// Aggregate every scored run into a public model x domain matrix for the
// website Prevail Benchmark. One run = one model (from meta.json, else the
// run label); each question carries its domain, so per-cell averages fall out.
export interface PublicResults {
  schema: string;
  synthetic: true;
  generated_at: string;
  domains: string[];
  models: { key: string; cli: string | null; model: string | null; label: string }[];
  // matrix[modelKey][domain] = { judge_avg, keyword_avg, n }
  matrix: Record<string, Record<string, { judge_avg: number | null; keyword_avg: number | null; n: number }>>;
  leaderboard: { key: string; label: string; judge_avg: number | null; keyword_avg: number | null; questions: number }[];
}

export function buildPublicResults(vaultPath: string, generatedAt: string): PublicResults {
  const root = runsDir(vaultPath);
  const domainsSet = new Set<string>();
  const models: PublicResults["models"] = [];
  const matrix: PublicResults["matrix"] = {};
  const leaderboard: PublicResults["leaderboard"] = [];
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      const scoreFile = join(dir, "score.json");
      if (!existsSync(scoreFile)) continue;
      let data: RunScore;
      try { data = JSON.parse(vreadFile(scoreFile)) as RunScore; } catch { continue; }
      // Identify the model from meta.json when present, else the label.
      let cli: string | null = null;
      let model: string | null = null;
      const metaPath = join(dir, "meta.json");
      if (existsSync(metaPath)) {
        try {
          const m = JSON.parse(vreadFile(metaPath)) as { cli?: string | null; model?: string | null; council?: boolean };
          cli = m.cli ?? null; model = m.model ?? null;
          if (m.council) { cli = "council"; model = null; }
        } catch { /* fall back to label */ }
      }
      const key = cli ? `${cli}${model ? `:${model}` : ""}` : data.label;
      const label = cli ? `${cli}${model ? ` ${model}` : ""}` : data.label;
      if (!matrix[key]) {
        matrix[key] = {};
        models.push({ key, cli, model, label });
      }
      // Per-domain accumulation for this run.
      const byDomain: Record<string, { j: number[]; k: number[] }> = {};
      for (const q of data.questionScores) {
        domainsSet.add(q.domain);
        const b = (byDomain[q.domain] ??= { j: [], k: [] });
        if (q.judge_score !== null) b.j.push(q.judge_score);
        if (q.keyword_score !== null) b.k.push(q.keyword_score);
      }
      const mean = (xs: number[]): number | null => xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
      for (const [dom, b] of Object.entries(byDomain)) {
        const prev = matrix[key][dom];
        // Newest run wins per cell (runs are processed in dir order; keep the
        // one with more data, else overwrite — drift history lives in dated files).
        const cell = { judge_avg: mean(b.j), keyword_avg: mean(b.k), n: b.j.length || b.k.length };
        if (!prev || cell.n >= prev.n) matrix[key][dom] = cell;
      }
      leaderboard.push({ key, label, judge_avg: data.judge_avg, keyword_avg: data.keyword_avg, questions: data.questionScores.length });
    }
  }
  // Best entry per model key for the leaderboard.
  const bestByKey = new Map<string, PublicResults["leaderboard"][number]>();
  for (const e of leaderboard) {
    const cur = bestByKey.get(e.key);
    if (!cur || (e.judge_avg ?? -1) > (cur.judge_avg ?? -1)) bestByKey.set(e.key, e);
  }
  const lb = [...bestByKey.values()].sort((a, b) => (b.judge_avg ?? -1) - (a.judge_avg ?? -1));
  return {
    schema: "prevail.benchmark/v1",
    synthetic: true,
    generated_at: generatedAt,
    domains: [...domainsSet].sort(),
    models,
    matrix,
    leaderboard: lb,
  };
}

// Load a single saved run for inspection — used when the user clicks
// a leaderboard row to drill into a historical run's per-question
// results without re-running.
export function loadRunForInspection(runDir: string): {
  records: CanonicalRunRecord[];
  score: RunScore;
} | null {
  const resultsFile = join(runDir, "results.json");
  const scoreFile = join(runDir, "score.json");
  if (!existsSync(resultsFile) || !existsSync(scoreFile)) return null;
  try {
    const records: CanonicalRunRecord[] = JSON.parse(vreadFile(resultsFile));
    const score: RunScore = JSON.parse(vreadFile(scoreFile));
    return { records, score };
  } catch {
    return null;
  }
}

// Import seed: pull a council-verdict entry out of a domain's _log file
// at <vault>/<domain>/_log/<date>.md and turn it into a draft. Heuristic
// — looks for the most recent "⚖ council" section in the file. Returns
// the draft path, or null if no usable verdict was found.
export function seedFromLatestCouncil(
  vaultPath: string,
  domain: string,
): { path: string; sourceFile: string } | null {
  const logDir = join(vaultPath, domain, "_log");
  if (!existsSync(logDir)) return null;
  // Newest first.
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
  for (const f of files) {
    const file = join(logDir, f);
    let content = "";
    try { content = vreadFile(file); } catch { continue; }
    // Match the LAST council section in the file (most recent verdict).
    const sectionRe = /##\s+\d{1,2}:\d{2}\s+·\s+⚖[^\n]*\n([\s\S]*?)(?=^##\s|\Z)/gm;
    let lastMatch: RegExpExecArray | null = null;
    for (
      let m: RegExpExecArray | null = sectionRe.exec(content);
      m;
      m = sectionRe.exec(content)
    ) {
      lastMatch = m;
    }
    if (!lastMatch) continue;
    const section = lastMatch[1] ?? "";
    const qMatch = section.match(/\*\*Q:\*\*\s*([\s\S]*?)(?:\n\n|\n\*\*A:\*\*|$)/);
    const aMatch = section.match(/\*\*A:\*\*\s*([\s\S]*?)(?:\n\n>|\n\n##|$)/);
    const prompt = qMatch?.[1]?.trim();
    const verdict = aMatch?.[1]?.trim();
    if (!prompt || !verdict) continue;
    const path = writeDraftQuestion({
      vaultPath,
      domain,
      prompt,
      notes: `Imported from ${f}. Original verdict:\n\n${verdict}`,
      council: true,
    });
    return { path, sourceFile: file };
  }
  return null;
}
