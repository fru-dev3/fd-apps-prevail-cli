import { theme } from "../../theme.ts";
import type { ChatMsg } from "../types.ts";

// Auto-council "suggest" mode bubble — passive nudge that the prompt
// looks council-worthy. The original prompt is stored in msg.content
// so a click on the bubble can re-fire it through the council path.
export function CouncilSuggestionBubble({
  msg,
  onEscalate,
}: {
  msg: ChatMsg;
  onEscalate?: (prompt: string) => void;
}) {
  const clickable = Boolean(onEscalate);
  return (
    <box
      flexDirection="row"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      onMouseDown={clickable ? () => onEscalate!(msg.content) : undefined}
    >
      <text fg={theme.aiAccent} attributes={1}>⚖ this looks council-worthy</text>
      <text fg={theme.fgFaint}>  ·  </text>
      <text fg={clickable ? theme.gold : theme.fgDim}>
        {clickable ? "click to re-run through council" : "re-send with /council to get a panel verdict"}
      </text>
    </box>
  );
}
