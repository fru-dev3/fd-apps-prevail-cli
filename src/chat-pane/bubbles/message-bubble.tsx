import { theme } from "../../theme.ts";
import { renderMarkdownLines } from "../../markdown-lite.tsx";
import type { AvailableCli } from "../../cli-bridge.ts";
import type { ChatMsg } from "../types.ts";
import { DistillDraftBubble } from "./distill-draft.tsx";
import { CouncilPendingBubble } from "./council-pending.tsx";
import { CouncilSynthesizingBubble } from "./council-synthesizing.tsx";
import { CouncilResponseBubble } from "./council-response.tsx";
import { CouncilVerdictBubble } from "./council-verdict.tsx";
import { StreamingAssistantBubble } from "./streaming-assistant.tsx";
import { SerendipityBubble } from "./serendipity.tsx";
import { CouncilSuggestionBubble } from "./council-suggestion.tsx";
import { formatMetaBadge } from "./meta-badge.ts";

export function MessageBubble({
  msg,
  tick,
  availableClis,
  councilMode,
  onToggleCouncilMode,
  onAcceptDistill,
  onDiscardDistill,
  onEscalateCouncil,
}: {
  msg: ChatMsg;
  tick: number;
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
  onAcceptDistill: (ts: number, content: string) => void;
  onDiscardDistill: (ts: number) => void;
  onEscalateCouncil?: (prompt: string) => void;
}) {
  if (msg.kind === "distill-draft") {
    return <DistillDraftBubble msg={msg} onAccept={onAcceptDistill} onDiscard={onDiscardDistill} />;
  }
  // council-config bubbles are no longer rendered inline — config moved to a
  // dedicated overlay (see CouncilConfigPanel below). Existing transcripts may
  // still contain the kind so we silently skip them.
  if (msg.kind === "council-config") return null;
  if (msg.kind === "council-pending") {
    return <CouncilPendingBubble msg={msg} tick={tick} />;
  }
  if (msg.kind === "council-synthesizing") {
    return <CouncilSynthesizingBubble msg={msg} tick={tick} />;
  }
  if (msg.kind === "council-response") {
    return <CouncilResponseBubble msg={msg} />;
  }
  if (msg.kind === "council-verdict") {
    return <CouncilVerdictBubble msg={msg} />;
  }
  if (msg.kind === "streaming") {
    return <StreamingAssistantBubble msg={msg} tick={tick} />;
  }
  if (msg.kind === "serendipity") {
    return <SerendipityBubble msg={msg} />;
  }
  if (msg.kind === "council-suggestion") {
    return <CouncilSuggestionBubble msg={msg} onEscalate={onEscalateCouncil} />;
  }
  if (msg.role === "system") {
    return (
      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <text fg={theme.fgFaint}>— {msg.content} —</text>
      </box>
    );
  }
  const isUser = msg.role === "user";
  const color = isUser ? theme.bubbleUser : theme.bubbleAssistant;
  // Prefer the CLI the message was actually produced by (msg.cli is set when
  // we persist responses), else fall back to the session's current CLI. We
  // can't read session here, so leave assistant unlabeled when msg.cli is
  // missing — TabStrip already shows the active CLI prominently.
  const label = isUser
    ? " you "
    : msg.cli
      ? ` ${msg.cli}${msg.model ? ` · ${msg.model}` : ""} `
      : " assistant ";
  // Per-bubble metadata badge — only on assistant bubbles, only when
  // there's actually something to say (model, framework, or lens).
  // The user can switch models / lenses / frameworks turn-to-turn, so
  // the badge is the only thing in the transcript that makes the
  // current bubble's provenance unambiguous.
  const badge = !isUser ? formatMetaBadge(msg) : null;
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={color}
        backgroundColor={theme.bg}
        title={label}
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
