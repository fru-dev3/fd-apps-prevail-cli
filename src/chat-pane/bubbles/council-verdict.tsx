import { theme } from "../../theme.ts";
import { renderMarkdownLines } from "../../markdown-lite.tsx";
import { parseVerdict } from "../../verdict-parser.ts";
import type { ChatMsg } from "../types.ts";
import { formatMetaBadge } from "./meta-badge.ts";

// Final synthesized recommendation across the council. Visually distinct:
// brighter gold border, thicker title, and a clear bottom-title hint.
//
// When the chair produced the four-section format, we render Divergence in
// its own electric-cyan accent panel — the actual point of running a
// council is the disagreement, and burying it inside a wall of text
// defeats the purpose. The Verdict line gets its own gold-edged hero block.
export function CouncilVerdictBubble({ msg }: { msg: ChatMsg }) {
  const synthCli = msg.cli ?? "claude";
  const labelParts: string[] = [synthCli];
  if (msg.model) labelParts.push(msg.model);
  const parsed = parseVerdict(msg.content);
  const titleSuffix = parsed.hasDivergence ? "  ·  🔀 disagreement" : "";
  const badge = formatMetaBadge(msg, { verdict: true });
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={theme.goldBright}
        backgroundColor={theme.bg}
        title={` ◆ council verdict${titleSuffix} `}
        titleAlignment="left"
        bottomTitle={` synthesized by ${labelParts.join(" · ")} `}
        bottomTitleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        {parsed.structured ? (
          <VerdictSections parsed={parsed} />
        ) : (
          // Chair ignored the format request — fall back to rendering the
          // raw text so we never silently drop content.
          renderMarkdownLines(msg.content)
        )}
      </box>
      {badge && <text fg={theme.fgFaint}>{badge}</text>}
    </box>
  );
}

function VerdictSections({ parsed }: { parsed: ReturnType<typeof parseVerdict> }) {
  return (
    <box flexDirection="column">
      {parsed.panelistSaid && (
        <SectionBlock title="What each panelist said" body={parsed.panelistSaid} accent={theme.fgDim} />
      )}
      {parsed.consensus && (
        <SectionBlock title="Consensus" body={parsed.consensus} accent={theme.ok} />
      )}
      {parsed.divergence && parsed.hasDivergence && (
        // Hero block for divergence — accent border, cyan title, dedicated
        // space. This is the value of the council; it has to be obvious.
        <box
          flexDirection="column"
          border
          borderColor={theme.aiAccent}
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
        >
          <text fg={theme.aiAccent} attributes={1}>🔀 Where panelists disagreed</text>
          <text> </text>
          {renderMarkdownLines(parsed.divergence)}
        </box>
      )}
      {parsed.divergence && !parsed.hasDivergence && (
        <SectionBlock title="Divergence" body={parsed.divergence} accent={theme.fgFaint} />
      )}
      {parsed.verdict && (
        <box
          flexDirection="column"
          border
          borderColor={theme.gold}
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
        >
          <text fg={theme.gold} attributes={1}>⚖ Verdict</text>
          <text> </text>
          {renderMarkdownLines(parsed.verdict)}
        </box>
      )}
    </box>
  );
}

function SectionBlock({
  title,
  body,
  accent,
}: {
  title: string;
  body: string;
  accent: string;
}) {
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={accent} attributes={1}>▸ {title}</text>
      {renderMarkdownLines(body)}
    </box>
  );
}
