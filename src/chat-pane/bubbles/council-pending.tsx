import { spinnerChar, theme, thinkingWord } from "../../theme.ts";
import type { ChatMsg } from "../types.ts";
import { COUNCIL_CLI_COLORS } from "./council-colors.ts";

// Per-panelist placeholder rendered the instant runCouncil fans out, so the
// user sees all 3 (or however many) panelists working at once. Replaced by
// CouncilResponseBubble when that panelist actually returns.
export function CouncilPendingBubble({ msg, tick }: { msg: ChatMsg; tick: number }) {
  const cli = msg.cli;
  const color = cli ? COUNCIL_CLI_COLORS[cli] : theme.bubbleAssistant;
  const labelParts = [cli ?? "unknown"];
  if (msg.model) labelParts.push(msg.model);
  const title = ` ⚖ ${labelParts.join(" · ")} `;
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="row"
        border
        borderColor={color}
        backgroundColor={theme.bg}
        title={title}
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
        height={3}
      >
        <text fg={theme.gold}>{spinnerChar(tick)}</text>
        <text fg={theme.fgDim}>  {thinkingWord(tick)}…</text>
      </box>
    </box>
  );
}
