import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";

// Auto-council classifier.
//
// When council is OFF and the user types a prompt, we optionally run a
// tiny LLM call that judges whether the prompt is the kind of question
// that would benefit from a multi-model council vs. a quick single
// answer. The answer is a single token (YES / NO) so the call is cheap
// in both time and tokens.
//
// Two modes (in addition to "off") are supported by the caller:
//
//   "suggest" — fire the classifier in parallel with the chat call. If
//               YES, surface a passive system-style suggestion in the
//               transcript prompting the user to re-run via council.
//               The chat call completes regardless, so latency is hidden.
//
//   "auto"    — fire the classifier BEFORE the chat call. If YES, route
//               the prompt to runCouncil instead of single chat. If NO,
//               fall through to single chat (~500ms penalty). The user
//               opted into latency in exchange for not having to read
//               and act on a suggestion.

const CLASSIFIER_INSTRUCTION = [
  "You are a binary classifier. Given a user message to an assistant,",
  "decide whether it is the kind of question that benefits from",
  "multiple expert perspectives — a strategic choice, life decision,",
  "open-ended judgment call, creative direction, or anything where",
  "consulting a few different angles would produce a better answer.",
  "",
  "Reply with EXACTLY one token: YES or NO. No punctuation, no prose,",
  "no explanation, no quotation marks. Default to NO when uncertain.",
  "",
  "Examples that should be YES:",
  "- Should I leave my job?",
  "- How should I structure my will?",
  "- What's the right strategy for launching this product?",
  "- Should I have the difficult conversation with my partner?",
  "",
  "Examples that should be NO:",
  "- Summarize this email.",
  "- What's the capital of France?",
  "- Reformat this code.",
  "- What does this error mean?",
  "- Translate to Spanish.",
].join("\n");

export interface ClassifyArgs {
  cwd: string;
  cli: AvailableCli;
  userPrompt: string;
  signal?: AbortSignal;
}

// Returns true when the classifier judges the prompt council-worthy.
// Returns false on any classifier failure (offline, error, ambiguous
// reply, abort) — fail-safe to "don't escalate" so the user never
// sees a council fire they didn't ask for due to a flaky call.
export async function classifyAsCouncilWorthy(args: ClassifyArgs): Promise<boolean> {
  const prompt = [
    CLASSIFIER_INSTRUCTION,
    "",
    "USER MESSAGE:",
    args.userPrompt.slice(0, 4000),
  ].join("\n");
  let reply = "";
  try {
    reply = await runChatTurn({
      prompt,
      cwd: args.cwd,
      cli: args.cli,
      // Empty model = CLI default. We don't pin haiku explicitly here
      // because the classifier prompt is short and any small model
      // suffices; users can pin claude-haiku-4-5 in council config if
      // they want predictable cost.
      model: "",
      isFirst: true,
      bare: true,
      signal: args.signal,
      // The classifier should reply with exactly YES or NO. 200 chars
      // catches any model that decides to elaborate before we cut it
      // off — the parser only checks the first token anyway.
      maxOutputChars: 200,
    });
  } catch {
    return false;
  }
  const norm = reply.trim().toUpperCase();
  // Strict YES match — anything else (no answer, prose, NO, error) is
  // treated as a no-go. The classifier was explicitly instructed to
  // default to NO on uncertainty, so this matches its bias.
  return norm.startsWith("YES");
}
