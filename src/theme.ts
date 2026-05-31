export const theme = {
  gold: "#C4A35A",
  goldDim: "#8A7340",
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
