import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { vappendLine, vreadFile } from "./vault-session.ts";
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
  // Response-shaping + cockpit-state snapshot at SEND TIME. All of
  // these are surfaced together in the daily log's `> meta:` line so a
  // future read of the log can fully reconstruct which toggles were
  // ON when this turn fired — not just framework/lens, but web access,
  // serendipity, council mode, and the exact model id. The user
  // explicitly asked: "when logging the questions and answers in
  // _log you must include all the configs like model, date time,
  // serendipity, web, lens, etc."
  framework?: string;
  lens?: string;
  model?: string; // exact model id (or "default" / "" when not pinned)
  webAccess?: "allow" | "deny";
  serendipity?: boolean;
  councilOn?: boolean;
  // When true, the FULL user prompt + FULL assistant reply are written
  // verbatim (just whitespace-normalized) — no heuristicSummarize
  // truncation. This is "checkpoint" mode: every interaction lands on
  // disk in its original form so the user has a complete transcript.
  // Default (false) preserves the long-standing summarized log shape.
  raw?: boolean;
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
      vappendLine(file, `# ${dayKey(args.ts)}\n`);
    }
    const entry = renderEntry(args);
    vappendLine(file, entry);
    headerLine = entry.split("\n").find((l) => l.startsWith("## ")) ?? "";
    // Tamper-evident sidecar: alongside the .md log, append one line to
    // _log/.shasum recording <entry-id> <sha256-of-entry>. The verify
    // subcommand later walks these to flag mismatches. Best-effort —
    // a failure here must never crash the chat path, so wrap in try/catch
    // and swallow.
    try {
      const sha = createHash("sha256").update(entry).digest("hex");
      const id = entryId(args.ts);
      const shasumFile = join(logDir, ".shasum");
      vappendLine(shasumFile, `${id} ${sha}\n`);
    } catch {
      // best-effort — never break the user's chat
    }
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
  // Checkpoint mode (raw=true): keep the prompt and reply VERBATIM. The
  // user explicitly asked for the chat to be saved as-it-happens, not
  // condensed. Strip nothing except trailing whitespace; markdown stays
  // markdown. Summarized mode (default) keeps the existing one-line
  // snapshot used by the daily index + memory recall.
  const q = args.raw ? args.userPrompt.trimEnd() : heuristicSummarize(args.userPrompt, 220);
  let assistantSnippet = args.assistantReply;
  let divergenceFlag = "";
  if (args.kind === "council-verdict") {
    const parsed = parseVerdict(args.assistantReply);
    if (parsed.verdict) assistantSnippet = parsed.verdict;
    if (parsed.hasDivergence) divergenceFlag = "  ·  🔀 disagreement";
  }
  const a = args.raw ? assistantSnippet.trimEnd() : heuristicSummarize(assistantSnippet, 400);
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
  // Response-shaping + cockpit-state snapshot. Emitted as a blockquote
  // so renderers and recall passes that ignore quoted prose see it as
  // metadata, but the line stays greppable. The user explicitly asked
  // for the FULL config: model, framework, lens, web, serendipity,
  // council mode. We always emit cli/time/date implicitly (date comes
  // from the file path, time from the `## HH:MM` header) — the meta
  // line carries everything ELSE that was active at send time.
  const shapeBits: string[] = [];
  shapeBits.push(args.cliLabel);
  if (args.model && args.model.trim()) shapeBits.push(`model=${args.model.trim()}`);
  if (args.framework) shapeBits.push(`framework=${args.framework}`);
  else shapeBits.push("framework=none");
  if (args.lens) shapeBits.push(`lens=${args.lens}`);
  else shapeBits.push("lens=none");
  if (args.webAccess) shapeBits.push(`web=${args.webAccess === "allow" ? "on" : "off"}`);
  if (args.serendipity !== undefined) shapeBits.push(`serendipity=${args.serendipity ? "on" : "off"}`);
  if (args.councilOn !== undefined) shapeBits.push(`council=${args.councilOn ? "on" : "off"}`);
  const shapeLine = `> meta: ${shapeBits.join(" · ")}`;
  return [
    "",
    `## ${timeKey(args.ts)}  ·  ${tag}${divergenceFlag}`,
    ...(metaLine ? [metaLine] : []),
    "",
    `**Q:** ${quoteShield(q)}`,
    "",
    `**A:** ${quoteShield(a)}`,
    "",
    shapeLine,
    "",
  ].join("\n");
}

export function entryId(ts: number): string {
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
    return vreadFile(file);
  } catch {
    return null;
  }
}
