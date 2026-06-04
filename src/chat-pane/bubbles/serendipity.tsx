import { theme } from "../../theme.ts";
import { renderMarkdownLines } from "../../markdown-lite.tsx";
import type { ChatMsg } from "../types.ts";

// Post-turn "serendipity" injection — rendered as a dim, narrow bubble
// directly under the main reply. The ◉ glyph differentiates it from
// council bubbles (⚖) and ordinary assistant bubbles. Color is dim
// gold so the user clearly sees it's adjacent commentary, not the
// answer to their question.
export function SerendipityBubble({ msg }: { msg: ChatMsg }) {
  const labelParts: string[] = ["serendipity"];
  if (msg.cli) labelParts.push(msg.cli);
  if (msg.model && msg.model.trim()) labelParts.push(msg.model.trim());
  return (
    <box flexDirection="column" paddingBottom={1} paddingLeft={2}>
      <box
        flexDirection="column"
        border
        borderColor={theme.goldDim}
        backgroundColor={theme.bg}
        title={` ◉ ${labelParts.join(" · ")} `}
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        {renderMarkdownLines(msg.content)}
      </box>
    </box>
  );
}
