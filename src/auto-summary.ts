import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVerdict } from "./verdict-parser.ts";
import { encodeMeta, defaultRetroDue } from "./calibration.ts";
import { indexEntry } from "./memory.ts";

// Per-domain self-curating log. After every chat turn (and every council
// verdict), append a one-paragraph snapshot to <domain>/_log/YYYY-MM-DD.md.
// Over time this gives each domain a chronological record of decisions made
// and questions asked — without the user having to take notes.
//
// Pure heuristic — no LLM call. The user prompt and the assistant reply are
// already the source of truth; we just extract their first meaningful
// sentence + time-stamp them and append. Cheap, offline, never blocks.
//
// Future v2: optionally call a tiny model (ollama llama3.2:1b, or claude
// haiku) to compress the reply into a one-line decision summary. Hook is
// already here — swap heuristicSummarize for an async LLM call.

export interface TurnSummaryArgs {
  domainPath: string;
  userPrompt: string;
  assistantReply: string;
  cliLabel: string; // "Claude", "Codex·gpt-5", "Council ⚖", etc
  ts: number;
  kind: "chat" | "council-verdict";
  // Optional gut take captured BEFORE the council fanout. When present,
  // the log entry gets a prevail-meta block embedding gut + retro_due,
  // so calibration.ts can later compute "how often does my gut match
  // the council, and when it doesn't, who's right?"
  gut?: string;
  // Optional response-shaping metadata that was ACTIVE at send time.
  // Surfaced in the daily log as a `> meta:` blockquote line so the
  // domain learns over time which lens/framework combos shaped which
  // decisions. Display labels (e.g. "BLUF", "CONTRARIAN"), not ids.
  framework?: string;
  lens?: string;
}

// Write a chat-turn summary to today's log file. Creates _log/ if missing.
// Never throws — file-system / permission errors are swallowed so a writeback
// failure can't break the user's chat session.
export function writeTurnSummary(args: TurnSummaryArgs): void {
  let file = "";
  let headerLine = "";
  try {
    const logDir = join(args.domainPath, "_log");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    file = join(logDir, dayKey(args.ts) + ".md");
    if (!existsSync(file)) {
      appendFileSync(file, `# ${dayKey(args.ts)}\n`);
    }
    const entry = renderEntry(args);
    appendFileSync(file, entry);
    headerLine = entry.split("\n").find((l) => l.startsWith("## ")) ?? "";
  } catch {
    return;
  }
  // Memory layer: after the entry is on disk, ask the embedder for a vector
  // and splice it in next to the prevail-meta line. Async + best-effort —
  // a failure here (Ollama down, model not pulled) is silent. The log entry
  // still exists and is greppable; just no semantic recall on this one.
  if (file && headerLine) {
    void indexEntry({
      filePath: file,
      text: `${args.userPrompt}\n\n${args.assistantReply}`.slice(0, 4000),
      headerLine,
    }).catch(() => {});
  }
}

// Today-style YYYY-MM-DD key. Local time so the file aligns with the day
// the user is actually living through (not UTC).
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function timeKey(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderEntry(args: TurnSummaryArgs): string {
  const q = heuristicSummarize(args.userPrompt, 220);
  let assistantSnippet = args.assistantReply;
  let divergenceFlag = "";
  if (args.kind === "council-verdict") {
    const parsed = parseVerdict(args.assistantReply);
    if (parsed.verdict) assistantSnippet = parsed.verdict;
    if (parsed.hasDivergence) divergenceFlag = "  ·  🔀 disagreement";
  }
  const a = heuristicSummarize(assistantSnippet, 400);
  const tag = args.kind === "council-verdict" ? "⚖ council" : args.cliLabel;
  // Calibration metadata — invisible in rendered markdown but greppable
  // and machine-readable. Only written when there's something to track
  // (a gut take captured before the council, plus a retro_due date so
  // the daemon knows when to ask "how did this go?").
  const metaLine =
    args.gut && args.kind === "council-verdict"
      ? encodeMeta({
          id: entryId(args.ts),
          gut: args.gut,
          verdict: args.assistantReply.split("\n").find((l) => /^verdict\s*:/i.test(l.trim()))?.replace(/^[^a-z]*verdict\s*:\s*/i, "") ?? a,
          retroDue: defaultRetroDue(args.ts),
        })
      : null;
  // Response-shaping metadata: emit a blockquote line under the Q/A pair
  // when the turn carried a framework or a lens. Blockquote form keeps
  // the existing format intact (every renderer / recall pass already
  // skips quoted prose), while leaving a greppable trail of which
  // lens-of-attack + structure shaped this decision. Skipped entirely
  // when neither is set — old entries render exactly as before.
  const shapeBits: string[] = [];
  shapeBits.push(args.cliLabel);
  if (args.framework) shapeBits.push(`framework=${args.framework}`);
  if (args.lens) shapeBits.push(`lens=${args.lens}`);
  const shapeLine =
    args.framework || args.lens
      ? `> meta: ${shapeBits.join(" · ")}`
      : null;
  return [
    "",
    `## ${timeKey(args.ts)}  ·  ${tag}${divergenceFlag}`,
    ...(metaLine ? [metaLine] : []),
    "",
    `**Q:** ${quoteShield(q)}`,
    "",
    `**A:** ${quoteShield(a)}`,
    ...(shapeLine ? ["", shapeLine] : []),
    "",
  ].join("\n");
}

function entryId(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}${mo}${da}-${hh}${mm}`;
}

function quoteShield(s: string): string {
  // Single-line snippets stay inline; multi-line indent each subsequent
  // line so the markdown rendering shows a clean blockquote / continuation.
  const lines = s.split("\n");
  if (lines.length <= 1) return s;
  return lines.map((l, i) => (i === 0 ? l : `> ${l}`)).join("\n");
}

// Squeeze a long piece of text into its lead sentence + (if room) the next
// sentence. Strips markdown headers/bullets so the snippet reads as prose.
// Anything that's already <=cap stays unchanged.
export function heuristicSummarize(raw: string, cap: number): string {
  const cleaned = raw
    .replace(/^#+\s+/gm, "") // strip markdown headers
    .replace(/^[*-]\s+/gm, "") // strip bullet markers
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= cap) return cleaned;
  // Split on sentence boundaries; prefer first 1-2 sentences that fit.
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s.trim()}` : s.trim();
    if (next.length > cap) break;
    out = next;
  }
  if (!out) out = cleaned.slice(0, cap) + "…";
  return out;
}

// Read today's log (if any) so the daemon / TUI can offer "what we
// discussed today" recall. Returns null when the file doesn't exist.
export function readTodayLog(domainPath: string, ts = Date.now()): string | null {
  const file = join(domainPath, "_log", dayKey(ts) + ".md");
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
