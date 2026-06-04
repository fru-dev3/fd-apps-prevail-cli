// Cognitive lenses. A lens is a *frame of attack* on a problem, not a
// structure for the answer (that's what frameworks do). Each lens forces
// the model to approach the question from a specific angle — first
// principles, contrarian, etc. The point of running multiple lenses on
// the same question is to surface the structural divergence between
// framings, then let the chair synthesize across them.
//
// When the user sets lens = "all" (the only mode that fans out), every
// panelist in the council runs every lens — so 4 CLIs × 5 lenses = 20
// panelist calls per question, then one chair pass. That's expensive,
// which is why lens is opt-in and gated to council mode.

export type LensId =
  | "first-principles"
  | "outsider"
  | "contrarian"
  | "expansionist"
  | "executor"
  | "alien"
  | "mom"
  | "dad";

// "off" = no lens applied (single response).
// "all" = fan out across every lens in LENSES (multiplies panelists by 5).
// A specific id = apply just that lens to every panelist (no fanout).
export type LensSelection = LensId | "all" | null;

export interface Lens {
  id: LensId;
  // Short uppercase chip label for the UI. <=14 chars.
  label: string;
  // One-line blurb shown in tooltips / config bubbles.
  blurb: string;
  // The actual angle-of-attack instruction prepended to the panelist
  // prompt. Phrased as a directive to the model, not a description.
  instruction: string;
}

export const LENSES: readonly Lens[] = [
  {
    id: "first-principles",
    label: "FIRST PRINCIPLES",
    blurb: "Forget everything considered so far. Start from the fundamentals.",
    instruction:
      "Approach this problem from first principles. Forget all conventional wisdom, prior advice in this conversation, industry best practice, or what 'most people do.' Strip the problem down to its fundamental physical, economic, or logical truths and rebuild the answer from there. Do not appeal to precedent or norms as a reason — only to the underlying mechanics.",
  },
  {
    id: "outsider",
    label: "OUTSIDER",
    blurb: "Challenge the thinking. Avoid prior knowledge or context.",
    instruction:
      "Approach this problem as a complete outsider. Pretend you have no prior context about this user, this domain, or how this kind of decision is usually made. Challenge every assumption baked into the question itself — including whether the question is the right one. Strip the problem down and look at it fresh, with no priors.",
  },
  {
    id: "contrarian",
    label: "CONTRARIAN",
    blurb: "Look for what will fail. Find the failure modes the obvious answer ignores.",
    instruction:
      "Approach this problem as a contrarian. Assume the user's preferred path — or the most obvious answer — is wrong. Find the failure modes, the hidden risks, the second-order consequences. Name the strongest case AGAINST acting on the obvious answer. Be skeptical, not negative for its own sake; if the obvious answer survives the pressure-test, say so plainly.",
  },
  {
    id: "expansionist",
    label: "EXPANSIONIST",
    blurb: "Find the upside that's being missed. Bigger plays, asymmetric bets.",
    instruction:
      "Approach this problem as an expansionist. Assume the user is anchored on a small, safe version of the question. Find the upside they are missing — the 5× play, the adjacency that changes the game, the asymmetric bet hiding inside the conservative framing. If the bigger play has real downside, name it, but lead with what's being left on the table.",
  },
  {
    id: "executor",
    label: "EXECUTOR",
    blurb: "What to do right now. Cut all theory. The next 24 hours only.",
    instruction:
      "Approach this problem as an operator who cares only about the next 24 hours. Cut all theory and all options analysis. What is the single most important action the user can take TODAY? Be concrete, be specific about the first move, be impatient. If the right answer cannot be acted on in the next 24 hours, the framing is wrong — find the smallest concrete step that can.",
  },
  {
    id: "alien",
    label: "ALIEN",
    blurb: "Foreign intelligence. No biases, no priors, no human context.",
    instruction:
      "Approach this problem as an alien intelligence encountering humans for the first time. You have NO prior context, NO understanding of human culture, NO biases about money, family, work, health, status, or any other human institution. Treat every assumption baked into the question — including what 'success' or 'good' means here — as a foreign artifact worth interrogating. What would a completely outside intelligence, looking at the raw situation, actually do? Name the assumptions you had to throw out to see it clearly.",
  },
  {
    id: "mom",
    label: "MOM",
    blurb: "A loving mother's voice. Long view. Wellbeing first. What's the cost?",
    instruction:
      "Approach this problem as the user's mother — someone who loves them deeply, has watched them across decades, and worries about their wellbeing more than their wins. What is the LONG view here? What is the user not seeing about themselves, their relationships, their body, their family, their peace of mind? Be warm, be direct, be honest about what mom thinks they're avoiding. Don't moralize; speak from love. Name what you'd say to them if it were just the two of you talking.",
  },
  {
    id: "dad",
    label: "DAD",
    blurb: "A grounded father's voice. Practical, responsibility, hard truths.",
    instruction:
      "Approach this problem as the user's father — someone who loves them deeply but speaks in practical, grounded terms. What is the responsible move? What does the user need to OWN here that they're sidestepping? What hard truth do they need to hear from someone who has their back but won't sugarcoat it? Focus on responsibility, follow-through, and the real-world cost of inaction. Be steady, be plain-spoken, and tell them what dad would actually say at the kitchen table.",
  },
];

export function getLens(id: LensId | null): Lens | null {
  if (!id) return null;
  return LENSES.find((l) => l.id === id) ?? null;
}

export function isLensId(s: string): s is LensId {
  return LENSES.some((l) => l.id === s);
}

// Build the bracket-style prompt preamble for a single lens. Used by the
// council runners to wrap each panelist's prompt with their assigned
// lens. Returns "" when lens is null so callers can unconditionally concat.
export function buildLensPreamble(lens: Lens | null): string {
  if (!lens) return "";
  return `[LENS: ${lens.label} — ${lens.instruction}]\n\n`;
}

// Resolve a LensSelection into the concrete list of lenses to fan across.
//   - null  → []          (no lens — single panelist call per CLI)
//   - id    → [getLens(id)] (apply that lens to every panelist)
//   - "all" → LENSES      (fan every panelist across all 5 lenses)
export function expandLensSelection(sel: LensSelection): Lens[] {
  if (sel === null) return [];
  if (sel === "all") return [...LENSES];
  const lens = getLens(sel);
  return lens ? [lens] : [];
}
