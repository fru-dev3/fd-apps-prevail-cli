import { spinnerChar, theme } from "../../theme.ts";
import type { ChatMsg } from "../types.ts";

// Live-updating assistant bubble. While the CLI streams text, this is what
// the user sees — same border + title as a finished assistant message, but
// with a spinner where the cursor would be while we wait for more tokens.
// Empty content (model hasn't emitted yet) shows a "thinking" line; once
// chunks arrive, the content fills in real time.
export function StreamingAssistantBubble({ msg, tick }: { msg: ChatMsg; tick: number }) {
  const char = spinnerChar(tick);
  const content = msg.content;
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={theme.bubbleAssistant}
        backgroundColor={theme.bg}
        title=" assistant "
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        {content.length === 0 ? (
          <box flexDirection="row">
            <text fg={theme.gold}>{char}</text>
            <text fg={theme.fgDim}>  receiving…</text>
          </box>
        ) : (
          <>
            <text fg={theme.fg}>{content}</text>
            <text fg={theme.fgFaint}>{char} streaming…</text>
          </>
        )}
      </box>
    </box>
  );
}
