import { theme } from "../../theme.ts";
import { renderMarkdownLines } from "../../markdown-lite.tsx";
import { defaultModelFor } from "../../cli-bridge.ts";
import type { ChatMsg } from "../types.ts";
import { COUNCIL_CLI_COLORS } from "./council-colors.ts";
import { formatMetaBadge } from "./meta-badge.ts";

export function CouncilResponseBubble({ msg }: { msg: ChatMsg }) {
  const cli = msg.cli;
  const color = cli ? COUNCIL_CLI_COLORS[cli] : theme.bubbleAssistant;
  const labelParts = [cli ?? "unknown"];
  // Same fallback as the badge below — show the CLI's default model when
  // no model is pinned, so every panelist's title is uniformly informative.
  if (msg.model && msg.model.trim()) labelParts.push(msg.model.trim());
  else if (cli) labelParts.push(`${defaultModelFor(cli)} (default)`);
  const title = ` ⚖ ${labelParts.join(" · ")} `;
  const badge = formatMetaBadge(msg);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={color}
        backgroundColor={theme.bg}
        title={title}
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        {renderMarkdownLines(msg.content)}
      </box>
      {badge && <text fg={theme.fgFaint}>{badge}</text>}
    </box>
  );
}
