export const theme = {
  gold: "#C4A35A",
  goldDim: "#8A7340",
  goldBright: "#F5E0A8",
  // aiAccent: high-contrast electric cyan, used for the "AI" inside the
  // prevAIl wordmark. Complementary to gold, so it pops hard against both
  // the dark background and the surrounding gold letters. This is the
  // visual handle on the brand thesis — the AI hidden inside prevail.
  aiAccent: "#3CD8FF",
  aiAccentDim: "#1A9DC8",
  bg: "#0E0E0E",
  bgPanel: "#161616",
  fg: "#E6E6E6",
  fgDim: "#9A9A9A",
  fgFaint: "#5A5A5A",
  accent: "#C4A35A",
  warn: "#E08A3C",
  ok: "#7BB369",
  selBg: "#2A2418",
  selFg: "#F2E2B6",
  border: "#3A3A3A",
  borderFocus: "#C4A35A",
  bubbleUser: "#C4A35A",
  bubbleAssistant: "#5F7A8C",
  bubbleSystem: "#3A3A3A",
  inputBorder: "#5F7A8C",
} as const;

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function spinnerChar(tick: number): string {
  return SPINNER[tick % SPINNER.length] ?? "·";
}

export const THINKING_WORDS = [
  "thinking",
  "pondering",
  "cogitating",
  "ruminating",
  "noodling",
  "brewing",
  "synthesizing",
  "musing",
  "deliberating",
  "marinating",
  "percolating",
  "reflecting",
  "reasoning",
  "weighing",
  "scheming",
  "untangling",
  "distilling",
  "composing",
  "considering",
  "calibrating",
  "drafting",
  "puzzling",
  "stewing",
  "tracing",
  "sketching",
  "wrangling",
  "channeling",
  "divining",
  "conjuring",
  "polishing",
] as const;

const WORD_TICKS = 12;

export function thinkingWord(tick: number): string {
  const idx = Math.floor(tick / WORD_TICKS) % THINKING_WORDS.length;
  return THINKING_WORDS[idx] ?? "thinking";
}
