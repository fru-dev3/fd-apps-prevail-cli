import { readdirSync, existsSync, mkdirSync, } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { detectClis } from "./cli-bridge.ts";
import { buildCouncilPanel, runCouncilOneShot } from "./council-runner.ts";
import { parseVerdict } from "./verdict-parser.ts";

// prevail-bench runner. Walks the bundled question suite, fires /council
// against each one, records the panel responses + verdict + timing to
// markdown, then writes a summary table. Plain markdown out — the whole
// scoreboard is grep-friendly and PR-able.

interface BenchQuestion {
  id: string;
  domain: string;
  stakes: string;
  verifiable: boolean;
  prompt: string;
  context: string;
  rubric: string;
  filePath: string;
}

export function benchQuestionDirs(): string[] {
  const dirs: string[] = [];
  try {
    const execDir = dirname(process.execPath);
    dirs.push(resolve(execDir, "bench", "questions"));
    dirs.push(resolve(execDir, "..", "bench", "questions"));
  } catch {}
  if (process.argv[1]) {
    try {
      const argvDir = dirname(process.argv[1]);
      dirs.push(resolve(argvDir, "bench", "questions"));
      dirs.push(resolve(argvDir, "..", "bench", "questions"));
    } catch {}
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    dirs.push(resolve(here, "..", "bench", "questions"));
  } catch {}
  return dirs;
}

export function loadQuestions(): BenchQuestion[] {
  const out: BenchQuestion[] = [];
  const seen = new Set<string>();
  for (const dir of benchQuestionDirs()) {
    if (!existsSync(dir)) continue;
    for (const domain of readdirSync(dir, { withFileTypes: true })) {
      if (!domain.isDirectory()) continue;
      const domainDir = join(dir, domain.name);
      for (const f of readdirSync(domainDir)) {
        if (!f.endsWith(".md")) continue;
        const filePath = join(domainDir, f);
        let raw: string;
        try {
          raw = vreadFile(filePath);
        } catch {
          continue;
        }
        const q = parseQuestionFile(raw, filePath);
        if (!q) continue;
        if (seen.has(q.id)) continue;
        seen.add(q.id);
        out.push(q);
      }
    }
    if (out.length > 0) break; // first dir with content wins
  }
  return out;
}

function parseQuestionFile(raw: string, filePath: string): BenchQuestion | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (!fm.id || !fm.domain) return null;
  const body = fmMatch[2]!;
  const prompt = extractSection(body, "Prompt");
  const context = extractSection(body, "Context");
  const rubric = extractSection(body, "Scoring rubric");
  return {
    id: fm.id,
    domain: fm.domain,
    stakes: fm.stakes ?? "medium",
    verifiable: fm.verifiable === "true",
    prompt,
    context,
    rubric,
    filePath,
  };
}

function extractSection(body: string, name: string): string {
  const re = new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "m");
  const m = body.match(re);
  return m?.[1]?.trim() ?? "";
}

export interface BenchPanelEntry {
  label: string;
  reply: string;
  ok: boolean;
}

export interface BenchResult {
  question: BenchQuestion;
  verdict: string;
  chairLabel: string;
  panelCount: number;
  successfulPanelists: number;
  divergenceFlagged: boolean;
  msTotal: number;
  panelLabels: string[];
  rawPanel: BenchPanelEntry[];
}

export async function runBenchOne(q: BenchQuestion, vaultPath: string): Promise<BenchResult> {
  const start = Date.now();
  const clis = await detectClis();
  const panel = buildCouncilPanel(clis);
  // Use a synthetic "domain path" rooted at the vault — bench questions
  // don't necessarily map to a real vault domain. Falls back to vault root.
  const domainPath = existsSync(join(vaultPath, q.domain))
    ? join(vaultPath, q.domain)
    : vaultPath;
  const fullPrompt = q.context
    ? `${q.prompt}\n\n## Context\n${q.context}`
    : q.prompt;
  const r = await runCouncilOneShot({
    prompt: fullPrompt,
    cwd: domainPath,
    panelists: panel,
    vaultPath,
  });
  const parsed = parseVerdict(r.verdict);
  return {
    question: q,
    verdict: r.verdict,
    chairLabel: r.chairLabel,
    panelCount: r.panel.length,
    successfulPanelists: r.panel.filter((p) => p.ok && !p.reply.startsWith("(")).length,
    divergenceFlagged: parsed.hasDivergence,
    msTotal: Date.now() - start,
    panelLabels: r.panel.map((p) => (p.model ? `${p.cli.label}·${p.model}` : p.cli.label)),
    rawPanel: r.panel.map((p) => ({
      label: p.model ? `${p.cli.label}·${p.model}` : p.cli.label,
      reply: p.reply,
      ok: p.ok,
    })),
  };
}

export function writeBenchResult(result: BenchResult, outputDir: string): string {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `${result.question.id}.md`);
  const lines = [
    `# ${result.question.id}`,
    "",
    `- **domain:** ${result.question.domain}`,
    `- **stakes:** ${result.question.stakes}`,
    `- **panelists:** ${result.panelLabels.join(", ")}`,
    `- **chair:** ${result.chairLabel}`,
    `- **divergence flagged:** ${result.divergenceFlagged ? "yes" : "no"}`,
    `- **time:** ${(result.msTotal / 1000).toFixed(1)}s`,
    "",
    `## Question`,
    "",
    result.question.prompt,
    "",
    `## Verdict`,
    "",
    result.verdict,
    "",
    `## Panel responses`,
    "",
  ];
  for (const p of result.rawPanel) {
    lines.push(`### ${p.label}`);
    lines.push("");
    lines.push(p.reply);
    lines.push("");
  }
  vwriteFile(file, lines.join("\n"));
  return file;
}

export function writeBenchSummary(results: BenchResult[], outputDir: string, runDate: string): string {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `${runDate}-summary.md`);
  const lines = [
    `# prevail-bench · ${runDate}`,
    "",
    `${results.length} question${results.length === 1 ? "" : "s"} run.`,
    "",
    "| id | domain | stakes | panel | chair | divergence | time |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.question.id} | ${r.question.domain} | ${r.question.stakes} | ${r.successfulPanelists}/${r.panelCount} | ${r.chairLabel} | ${r.divergenceFlagged ? "🔀" : "—"} | ${(r.msTotal / 1000).toFixed(1)}s |`,
    );
  }
  vwriteFile(file, lines.join("\n"));
  return file;
}

export function defaultResultsDir(): string {
  // ~/.prevail/bench-results/ keeps user runs out of the repo. Contributors
  // who want to share results can copy/commit them into bench/results/.
  return join(homedir(), ".prevail", "bench-results");
}
