import { theme } from "../../theme.ts";
import type { CliKind } from "../../cli-bridge.ts";

// Partial: only the council-relevant families/providers get bespoke colors.
// The extra CLI families (gemini, copilot, cursor, …) fall back to the default
// bubble color at the call sites (`?? theme.bubbleAssistant`).
export const COUNCIL_CLI_COLORS: Partial<Record<CliKind, string>> = {
  claude: theme.gold, // warm gold — matches brand
  codex: theme.bubbleAssistant, // muted blue
  antigravity: theme.ok, // green — Google panelist (formerly gemini)
  ollama: theme.aiAccent, // electric cyan — the "local AI" panelist
  openrouter: theme.gold, // gateway — reuse gold (routes to many vendors)
  // Direct providers (G1) — single-vendor keys.
  anthropic: theme.gold, // Claude family
  openai: theme.bubbleAssistant,
  xai: theme.bubbleAssistant,
  kimi: theme.ok,
  deepseek: theme.aiAccent,
  google: theme.ok,
};
