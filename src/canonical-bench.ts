import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  prompt: string;
  context?: string;
  notes?: string;
  council?: boolean; // true = run via runCouncil; false = single chat
  expected_decision?: string;
  expected_verdict_keywords?: string[];
  filePath: string;
}

export function benchmarkRoot(vaultPath: string): string {
  return join(vaultPath, "benchmark");
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
  try { raw = readFileSync(filePath, "utf8"); } catch { return null; }
  const { fields, body } = parseFrontmatter(raw);
  const id = typeof fields.id === "string" ? fields.id : null;
  const domain = typeof fields.domain === "string" ? fields.domain : null;
  if (!id || !domain) return null;
  const prompt = extractSection(body, "Prompt") ?? "";
  return {
    id,
    domain,
    prompt,
    context: extractSection(body, "Context"),
    notes: extractSection(body, "Notes"),
    council: typeof fields.council === "string" ? fields.council === "true" : undefined,
    expected_decision: typeof fields.expected_decision === "string" ? fields.expected_decision : undefined,
    expected_verdict_keywords: Array.isArray(fields.expected_verdict_keywords)
      ? fields.expected_verdict_keywords
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
    if (q) out.push(q);
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
  writeFileSync(path, fm.join("\n"));
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
    try { content = readFileSync(file, "utf8"); } catch { continue; }
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
