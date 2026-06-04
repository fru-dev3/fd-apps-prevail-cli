import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";

// Serendipity (Option B).
//
// After a chat turn finishes, optionally fire a *second* small call to
// the same CLI that asks for ONE non-obvious adjacent angle, fact, or
// question the user did NOT ask but would likely value. The result is
// surfaced as its own dim "serendipity" bubble in the transcript —
// distinct from the main reply so the user's eye picks out what was
// the actual answer vs. what was a bonus angle the model thought to
// mention.
//
// This is deliberately a SECOND call rather than a system-prompt
// addendum (Option A). The user explicitly chose B so the serendipity
// pass doesn't compete with the main answer for space inside the same
// reply — and so it can be toggled per-domain without restructuring
// the main prompt path.

const SERENDIPITY_INSTRUCTION = [
  "You just read a chat turn between a user and an assistant.",
  "Your one job: name ONE non-obvious adjacent thing — a fact, an angle,",
  "an adjacent question, an unintended consequence, a related decision",
  "downstream — that the user did NOT ask about but would genuinely",
  "value knowing as they think about this. Skip the obvious. Skip the",
  "generic. Skip safety disclaimers. Skip 'have you considered…' framing.",
  "Just SURFACE the angle, in one short paragraph. No header, no preamble.",
].join("\n");

export interface SerendipityArgs {
  cwd: string;
  cli: AvailableCli;
  model: string;
  userPrompt: string;
  assistantReply: string;
  signal?: AbortSignal;
}

export async function runSerendipityPass(args: SerendipityArgs): Promise<string | null> {
  // Truncate generously — we only need enough context for the model to
  // identify what the conversation was about. The detailed answer isn't
  // the point of this call.
  const q = args.userPrompt.slice(0, 4000);
  const a = args.assistantReply.slice(0, 6000);
  const prompt = [
    SERENDIPITY_INSTRUCTION,
    "",
    "TURN:",
    `[USER] ${q}`,
    "",
    `[ASSISTANT] ${a}`,
  ].join("\n");
  try {
    const reply = await runChatTurn({
      prompt,
      cwd: args.cwd,
      cli: args.cli,
      model: args.model,
      isFirst: true,
      bare: true,
      signal: args.signal,
      // Serendipity should be one paragraph max. 4000 chars catches
      // models that over-explain without truncating useful short replies.
      maxOutputChars: 4000,
    });
    const trimmed = reply.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    return null;
  }
}
