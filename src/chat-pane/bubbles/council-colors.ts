import { theme } from "../../theme.ts";
import type { CliKind } from "../../cli-bridge.ts";

export const COUNCIL_CLI_COLORS: Record<CliKind, string> = {
  claude: theme.gold, // warm gold — matches brand
  codex: theme.bubbleAssistant, // muted blue
  antigravity: theme.ok, // green — Google panelist (formerly gemini)
  ollama: theme.aiAccent, // electric cyan — the "local AI" panelist
};
