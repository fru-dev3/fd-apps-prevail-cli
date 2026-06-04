import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";

// Per-domain JOURNAL — distinct from _log/.
//
// _log/<date>.md is the raw transcript (every Q + A verbatim, written by
// auto-summary.ts when checkpoint is on). It is high-volume and lossy in
// the sense that it gives you everything and you have to grep.
//
// journal/ is the CURATED layer. After each turn we ask a small model
// to extract: (a) the decision the user implicitly or explicitly made,
// and (b) any standalone facts the assistant surfaced that the user
// would want indexed for later. Two files, both cumulative:
//
//   journal/decisions.md   ← "I will invest the cash rather than prepay
//                            the mortgage" — line-level, appendable.
//   journal/facts.md       ← "Effective mortgage rate is 4.1% at my tax
//                            bracket." — line-level, appendable.
//
// Each appended bullet carries a backlink to the source _log entry by
// timestamp so a future tool can jump from a fact to the conversation
// that surfaced it.
//
// The distillation pass is BEST-EFFORT and silent on failure. If the
// classifier CLI is offline or rejects the call, the function returns
// without writing — the raw _log entry is the source of truth, the
// journal is the index on top of it. We never block the chat path.

export interface DistillArgs {
  domainPath: string;
  userPrompt: string;
  assistantReply: string;
  ts: number; // turn timestamp — used to build the backlink to _log
  cli: AvailableCli; // which CLI to use as the distiller
  model?: string;
  signal?: AbortSignal;
}

const DISTILL_PROMPT = [
  "You are reading a single chat turn between a user and an assistant.",
  "Your job is to extract two things and ONLY these two things, in this",
  "exact format. No preamble, no commentary.",
  "",
  "DECISION: <one short sentence naming the decision the user is making,",
  "considering, or has just made. If no decision is visible in this",
  "turn, write the literal word NONE.>",
  "",
  "FACTS:",
  "<one bullet per standalone fact surfaced in this turn that a future",
  "reader would want indexed — concrete numbers, dates, names, rates,",
  "rules. Skip prose, skip opinions, skip generic advice. Max 5 bullets.",
  "If no notable facts were surfaced, write the literal word NONE.>",
  "",
  "Be terse. Each bullet ≤120 chars. No quoting. No 'the user'.",
].join("\n");

interface DistillResult {
  decision: string | null;
  facts: string[];
}

function buildDistillCall(args: DistillArgs): string {
  // Bracket the turn so the model can clearly distinguish it from the
  // instruction. Truncate generously — distillation should look at the
  // whole turn but we don't want a 50KB reply blowing out the call.
  const q = args.userPrompt.slice(0, 4000);
  const a = args.assistantReply.slice(0, 8000);
  return [
    DISTILL_PROMPT,
    "",
    "TURN:",
    `[USER] ${q}`,
    "",
    `[ASSISTANT] ${a}`,
  ].join("\n");
}

function parseDistill(raw: string): DistillResult {
  const lines = raw.split("\n").map((l) => l.trim());
  let decision: string | null = null;
  const facts: string[] = [];
  let inFacts = false;
  for (const line of lines) {
    if (!line) continue;
    if (/^DECISION:\s*/i.test(line)) {
      const body = line.replace(/^DECISION:\s*/i, "").trim();
      if (body && body.toUpperCase() !== "NONE") decision = body;
      inFacts = false;
      continue;
    }
    if (/^FACTS\s*:?\s*$/i.test(line)) {
      inFacts = true;
      continue;
    }
    if (inFacts) {
      if (line.toUpperCase() === "NONE") {
        inFacts = false;
        continue;
      }
      // Accept "- foo", "* foo", "• foo", or plain prose.
      const stripped = line.replace(/^[-*•]\s*/, "").trim();
      if (stripped) facts.push(stripped);
    }
  }
  return { decision, facts };
}

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

function ensureJournalDir(domainPath: string): string | null {
  const dir = join(domainPath, "journal");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function appendBullet(
  file: string,
  header: string,
  ts: number,
  text: string,
): void {
  try {
    if (!existsSync(file)) appendFileSync(file, `# ${header}\n\n`);
    const date = dayKey(ts);
    const time = timeKey(ts);
    // Backlink: `_log/<date>.md#<time>` — a reader (or a future CLI command)
    // can jump straight to the source turn. Markdown renderers may not
    // honor it as a real anchor, but the path is greppable and that's
    // what matters.
    const line = `- ${date} ${time} · ${text}  · [src](../_log/${date}.md)\n`;
    appendFileSync(file, line);
  } catch {
    /* silent best-effort */
  }
}

// Distill one chat turn into journal/decisions.md + journal/facts.md.
// Returns void — never throws, never blocks the caller meaningfully.
// Designed to be fire-and-forgotten with .catch(() => {}) from the
// caller, just like the existing indexEntry() pattern in auto-summary.
export async function distillTurnToJournal(args: DistillArgs): Promise<void> {
  const dir = ensureJournalDir(args.domainPath);
  if (!dir) return;
  const distillPrompt = buildDistillCall(args);
  let raw = "";
  try {
    raw = await runChatTurn({
      prompt: distillPrompt,
      cwd: args.domainPath,
      cli: args.cli,
      model: args.model ?? "",
      isFirst: true,
      bare: true,
      signal: args.signal,
    });
  } catch {
    return;
  }
  const parsed = parseDistill(raw);
  if (parsed.decision) {
    appendBullet(
      join(dir, "decisions.md"),
      `${args.domainPath.split("/").pop() ?? "domain"} · decisions`,
      args.ts,
      parsed.decision,
    );
  }
  if (parsed.facts.length > 0) {
    const factsFile = join(dir, "facts.md");
    if (!existsSync(factsFile)) {
      try {
        appendFileSync(
          factsFile,
          `# ${args.domainPath.split("/").pop() ?? "domain"} · facts\n\n`,
        );
      } catch {
        return;
      }
    }
    for (const fact of parsed.facts) appendBullet(factsFile, "", args.ts, fact);
  }
}
