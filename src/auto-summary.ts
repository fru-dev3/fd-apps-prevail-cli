import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
}

// Write a chat-turn summary to today's log file. Creates _log/ if missing.
// Never throws — file-system / permission errors are swallowed so a writeback
// failure can't break the user's chat session.
export function writeTurnSummary(args: TurnSummaryArgs): void {
  try {
    const logDir = join(args.domainPath, "_log");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const file = join(logDir, dayKey(args.ts) + ".md");
    if (!existsSync(file)) {
      // First write today — drop a header so the file is grep-friendly.
      appendFileSync(file, `# ${dayKey(args.ts)}\n`);
    }
    appendFileSync(file, renderEntry(args));
  } catch {
    // intentionally silent — see comment above
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
  const a = heuristicSummarize(args.assistantReply, 400);
  const tag = args.kind === "council-verdict" ? "⚖ council" : args.cliLabel;
  // Two-blank-line separator between entries so they render as distinct
  // sections in markdown editors.
  return [
    "",
    `## ${timeKey(args.ts)}  ·  ${tag}`,
    "",
    `**Q:** ${q}`,
    "",
    `**A:** ${a}`,
    "",
  ].join("\n");
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
