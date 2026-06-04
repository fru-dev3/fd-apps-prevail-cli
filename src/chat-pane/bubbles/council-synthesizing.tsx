import { spinnerChar, theme, thinkingWord } from "../../theme.ts";
import type { ChatMsg } from "../types.ts";

// Step-2 placeholder rendered between the panelist replies and the final
// verdict. Distinct from the per-panelist CouncilPendingBubble so the user
// can see the synthesis step explicitly ("synthesizing with Claude Code…")
// instead of wondering why the chair is "thinking" alongside the panel.
export function CouncilSynthesizingBubble({ msg, tick }: { msg: ChatMsg; tick: number }) {
  const synthCli = msg.cli ?? "claude";
  const labelParts: string[] = [synthCli];
  if (msg.model) labelParts.push(msg.model);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="row"
        border
        borderColor={theme.goldBright}
        backgroundColor={theme.bg}
        title=" ⚖ synthesizing verdict "
        titleAlignment="left"
        bottomTitle={` chair: ${labelParts.join(" · ")} `}
        bottomTitleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
        height={3}
      >
        <text fg={theme.goldBright}>{spinnerChar(tick)}</text>
        <text fg={theme.fgDim}>  {thinkingWord(tick)} the panel responses…</text>
      </box>
    </box>
  );
}
