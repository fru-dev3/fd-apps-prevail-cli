// Response frameworks. Each one shapes how the model structures its answer:
// labeled sections, lead-with-the-conclusion, ruthless single-focus, etc.
// The user picks one at a time (or none) from the council config bubble or
// via /framework <id>; the active framework's `instruction` is prepended to
// every CLI call as a bracket-style preamble. The bracket format keeps the
// instruction visually separate from the user's actual question and is
// short enough not to dominate the prompt or get echoed noticeably in
// short replies.
//
// Adding a new framework: append to FRAMEWORKS, ensure the id is unique
// and kebab-case, write an instruction that is one paragraph at most, and
// let the user type `/framework <id>` to test it. No code wiring needed
// past this file.

export type FrameworkId =
  | "bluf"
  | "win"
  | "scqa"
  | "sbar"
  | "ooda"
  | "proscons"
  | "steelman";

export interface Framework {
  id: FrameworkId;
  // Short uppercase chip label for the UI. <=10 chars so chips stay tight.
  label: string;
  // One-line description shown in the chip's tooltip / config bubble.
  blurb: string;
  // The actual instruction prepended to every CLI prompt while this
  // framework is active. Keep terse — the model echoes long preambles.
  instruction: string;
}

export const FRAMEWORKS: readonly Framework[] = [
  {
    id: "bluf",
    label: "BLUF",
    blurb: "Bottom Line Up Front — lead with the answer, supporting detail after",
    instruction:
      "Apply the BLUF framework. Your first sentence MUST be the bottom line — the single most important conclusion or recommendation. Then provide supporting context in 1-3 short paragraphs. Never bury the conclusion under context.",
  },
  {
    id: "win",
    label: "WIN",
    blurb: "What's Important Now — identify the ONE next move and lead with it",
    instruction:
      "Apply the WIN (What's Important Now) framework. Identify the ONE most important next move the user should make. State that move in the first sentence. Drop everything that doesn't directly serve that next step. Be ruthlessly minimal — short is the feature, not a bug.",
  },
  {
    id: "scqa",
    label: "SCQA",
    blurb: "Situation · Complication · Question · Answer (Minto Pyramid)",
    instruction:
      "Apply the SCQA framework (Minto Pyramid). Structure your response in four clearly-labeled sections: **SITUATION** (the current state in 1-2 sentences), **COMPLICATION** (what changed or what's at risk), **QUESTION** (the decision to make), **ANSWER** (your recommendation with reasoning). No preamble before SITUATION.",
  },
  {
    id: "sbar",
    label: "SBAR",
    blurb: "Situation · Background · Assessment · Recommendation (handoff style)",
    instruction:
      "Apply the SBAR framework. Structure your response in four clearly-labeled sections: **SITUATION** (one line, what's happening), **BACKGROUND** (2-3 lines of relevant context), **ASSESSMENT** (your read of what it means), **RECOMMENDATION** (the concrete action to take). Each section labeled with bold. No preamble.",
  },
  {
    id: "ooda",
    label: "OODA",
    blurb: "Observe · Orient · Decide · Act — Boyd's tactical decision loop",
    instruction:
      "Apply Boyd's OODA loop. Structure your response in four labeled sections: **OBSERVE** (the facts on the ground), **ORIENT** (the frames, biases, or constraints to check), **DECIDE** (the call you'd make), **ACT** (the concrete next step). Concise — this is a tactical framework, not a treatise. No preamble.",
  },
  {
    id: "proscons",
    label: "PROS/CONS",
    blurb: "Pros · Cons · Recommendation — steelman both sides then call it",
    instruction:
      "Apply the Pros/Cons + Recommendation framework. Provide three labeled sections: **PROS** (3-5 bullet points making the strongest case for the proposal), **CONS** (3-5 bullet points making the strongest case against), **RECOMMENDATION** (your call with one paragraph of reasoning). Steelman both sides — don't strawman the side you disagree with.",
  },
  {
    id: "steelman",
    label: "STEELMAN",
    blurb: "Strongest counter-argument first, then your real recommendation",
    instruction:
      "Apply the Steelman framework. First, in a labeled **STEELMAN** section, argue the strongest possible case AGAINST what the user is proposing or assuming. Take the opposing view seriously and present its best form. Then, in a labeled **MY VIEW** section, give your actual recommendation — informed by the pressure-test you just ran.",
  },
];

export function getFramework(id: FrameworkId | null): Framework | null {
  if (!id) return null;
  return FRAMEWORKS.find((f) => f.id === id) ?? null;
}

export function isFrameworkId(s: string): s is FrameworkId {
  return FRAMEWORKS.some((f) => f.id === s);
}

// Build the bracket-style prompt preamble for a framework. Used by
// runChatTurn to wrap the user's prompt. Returns "" when fw is null so the
// caller can unconditionally concat.
export function buildFrameworkPreamble(fw: Framework | null): string {
  if (!fw) return "";
  return `[FRAMEWORK: ${fw.label} — ${fw.instruction}]\n\n`;
}
