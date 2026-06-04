import { theme } from "../../theme.ts";
import { renderMarkdownLines } from "../../markdown-lite.tsx";
import type { ChatMsg } from "../types.ts";

export function DistillDraftBubble({
  msg,
  onAccept,
  onDiscard,
}: {
  msg: ChatMsg;
  onAccept: (ts: number, content: string) => void;
  onDiscard: (ts: number) => void;
}) {
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={theme.gold}
        backgroundColor={theme.bg}
        title=" 🪄 distilled skill draft "
        titleAlignment="left"
        bottomTitle=" click [accept] to save · [discard] to throw away "
        bottomTitleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        {renderMarkdownLines(msg.content)}
      </box>
      <box flexDirection="row" paddingTop={0} paddingLeft={2}>
        <box
          flexDirection="row"
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme.selBg}
          onMouseDown={() => onAccept(msg.ts, msg.content)}
        >
          <text fg={theme.gold} attributes={1}>▶ accept and save</text>
        </box>
        <text fg={theme.bg}>  </text>
        <box
          flexDirection="row"
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme.bgPanel}
          onMouseDown={() => onDiscard(msg.ts)}
        >
          <text fg={theme.fgDim}>✗ discard</text>
        </box>
      </box>
    </box>
  );
}
