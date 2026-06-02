import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useKeyboard } from "@opentui/react";
import { theme, spinnerChar, thinkingWord } from "./theme.ts";
import {
  MODEL_QUICKPICKS,
  buildChatPrompt,
  formatModelBadge,
  type AvailableCli,
  type CliKind,
} from "./cli-bridge.ts";
import { buildDomainContext, type Domain, type ViewKey } from "./vault.ts";
import { renderMarkdownLines } from "./markdown-lite.tsx";
import { openInFinder, shortenHome } from "./system.ts";
import {
  formatRelativeDate,
  getDomainHistory,
  getRecentUserPrompts,
  getUserPromptsForDomain,
} from "./session.ts";
import {
  readCouncilConfig,
  setCouncilClis,
  setCouncilModel,
  addCouncilModel,
  removeCouncilModel,
  setCouncilChair,
  type CliKind as ConfigCliKind,
} from "./config.ts";
import {
  buildSuggestions,
  loadClickCounts,
  mergeSuggestions,
  parsePromptsMd,
  recordSuggestionClick,
  type Suggestion,
  type SuggestionContext,
  type SuggestionSource,
} from "./suggestions.ts";
import {
  getCachedLlmSuggestions,
  precomputeLlmSuggestions,
} from "./suggestions-llm.ts";

export type ChatSeed =
  | "tab"
  | { kind: "skill"; id: string; title: string }
  | { kind: "app"; id: string; title: string; domains: string[] };

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  kind?:
    | "distill-draft"
    | "distill-saved"
    | "distill-discarded"
    | "council-config"
    | "council-pending"
    | "council-response"
    | "council-synthesizing"
    | "council-verdict";
  cli?: CliKind; // for council-response bubbles
  model?: string;
}

export interface ChatSession {
  key: string;
  label: string;
  hostDomain: Domain;
  cli: AvailableCli;
  model: string;
  seed: ChatSeed;
  initialView: ViewKey;
  messages: ChatMsg[];
  pending: boolean;
  hasFirstTurn: boolean;
  sessionId: string;
}

export type ChatCommand =
  | { kind: "switch-cli"; cli: CliKind; model?: string }
  | { kind: "switch-model"; model: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "distill" }
  | { kind: "accept-distill"; ts: number; content: string }
  | { kind: "discard-distill"; ts: number }
  | { kind: "search"; query: string }
  | { kind: "history"; limit?: number }
  | { kind: "web"; mode: "allow" | "deny" | "status" }
  | { kind: "council"; prompt: string }
  | { kind: "council-config" }
  | { kind: "council-mode-toggle" }
  | { kind: "council-use"; clis: string[] }
  | { kind: "council-model"; cli: string; model: string }
  | { kind: "council-chair"; cli: string; model: string }
  | { kind: "heatmap"; days?: number }
  | { kind: "watch"; limit?: number }
  | { kind: "unknown"; raw: string };

interface Props {
  session: ChatSession;
  availableClis: AvailableCli[];
  tick: number;
  // councilMode is owned by App so the top-right toggle chip and the
  // optional config overlay stay in sync across re-renders / pane switches.
  councilMode: boolean;
  onToggleCouncilMode: () => void;
  onSend: (key: string, text: string) => void;
  onCommand: (key: string, command: ChatCommand) => void;
  onExit: () => void;
  // Cancel the in-flight prompt for this session. Returns true if there was
  // actually a turn to abort. Escape calls this first when pending; only
  // falls through to onExit when nothing is running.
  onCancel?: (key: string) => boolean;
  onAutocompleteChange?: (open: boolean) => void;
  topBar?: React.ReactNode;
}

export function ChatPane({ session, availableClis, tick, councilMode, onToggleCouncilMode, onSend, onCommand, onExit, onCancel, onAutocompleteChange, topBar }: Props) {
  const ref = useRef<any>(null);
  // Hoisted from InputBox so the popover renders ABOVE InputBox at the
  // chat-pane level, keeping the input row at a stable bottom position.
  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Mirror councilMode into a ref so handleSubmit always reads the latest
  // value even if the underlying <input>'s onSubmit handler was bound on an
  // earlier render. Without this, toggling council ON after the input mounts
  // can leave the closure stale and route the message to the single-CLI path.
  const councilModeRef = useRef(councilMode);
  useEffect(() => {
    councilModeRef.current = councilMode;
  }, [councilMode]);

  const userMsgCount = session.messages.filter((m) => m.role === "user").length;
  const showSuggestions = userMsgCount === 0;

  // Re-poll the LLM cache while suggestions are visible. 1s feels live without
  // hammering the disk; we stop polling once the user has sent a message.
  const [llmCacheTick, setLlmCacheTick] = useState(0);
  useEffect(() => {
    if (!showSuggestions) return;
    const id = setInterval(() => setLlmCacheTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [showSuggestions, session.key]);

  // Kick off LLM precompute in the background once per session. Errors are
  // swallowed inside precomputeLlmSuggestions; Level 1 keeps working regardless.
  useEffect(() => {
    if (!showSuggestions) return;
    const ctx = buildSuggestionContext(session);
    const tid = setTimeout(() => {
      precomputeLlmSuggestions({
        domain: ctx.name,
        domainPath: ctx.path,
        cli: session.cli,
        model: session.model,
        clickHistory: loadClickCounts(),
        recentMessages: session.messages
          .filter((mm) => mm.role !== "system")
          .slice(-5)
          .map((mm) => ({ role: mm.role, content: mm.content })),
      }).catch(() => {});
    }, 100);
    return () => clearTimeout(tid);
  }, [showSuggestions, session.hostDomain.name, session.key]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!showSuggestions) return [];
    const ctx = buildSuggestionContext(session);
    const deterministic = buildSuggestions(ctx);
    const cached = getCachedLlmSuggestions(ctx.name) ?? [];
    if (cached.length === 0) return deterministic;
    const llmAsSuggestions: Suggestion[] = cached.map((s) => ({
      id: s.id,
      label: s.label,
      prompt: s.prompt,
      source: "llm" as SuggestionSource,
      score: 75,
    }));
    return mergeSuggestions(deterministic, llmAsSuggestions);
  }, [
    showSuggestions,
    session.hostDomain.path,
    session.hostDomain.stateMtime,
    session.hostDomain.openLoopCount,
    session.seed,
    session.key,
    llmCacheTick,
  ]);

  useLayoutEffect(() => {
    forceFocus(ref);
  }, [session.key]);

  useEffect(() => {
    const ids = [
      setTimeout(() => forceFocus(ref), 0),
      setTimeout(() => forceFocus(ref), 30),
      setTimeout(() => forceFocus(ref), 120),
    ];
    return () => ids.forEach(clearTimeout);
  }, [session.key]);

  useKeyboard((evt) => {
    if (evt.name !== "escape") return;
    // When a prompt is in flight, Escape cancels the request instead of
    // exiting the chat. This lets the user kill a slow CLI mid-turn without
    // losing their place in the conversation. If nothing is pending or no
    // cancel handler is wired, Escape exits as before.
    if (session.pending && onCancel) {
      const cancelled = onCancel(session.key);
      if (cancelled) return;
    }
    onExit();
  });

  const handleSubmit = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const cmd = parseSlashCommand(text);
      if (cmd.kind === "exit") {
        onExit();
      } else {
        onCommand(session.key, cmd);
      }
      try {
        ref.current?.setText?.("");
      } catch {}
      return;
    }
    if (session.pending) return;
    if (councilModeRef.current) {
      // Fan-out: route the bare text through the council command instead of
      // the single-CLI sendMessage path.
      onCommand(session.key, { kind: "council", prompt: text });
    } else {
      onSend(session.key, text);
    }
    try {
      ref.current?.setText?.("");
    } catch {}
  };

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title={` ${session.label} `}
      titleAlignment="left"
      bottomTitle={` enter send · / for commands · esc back `}
      bottomTitleAlignment="left"
    >
      {topBar}
      <Transcript
        session={session}
        tick={tick}
        suggestions={suggestions}
        availableClis={availableClis}
        councilMode={councilMode}
        onToggleCouncilMode={onToggleCouncilMode}
        onAcceptDistill={(ts, content) =>
          onCommand(session.key, { kind: "accept-distill", ts, content })
        }
        onDiscardDistill={(ts) =>
          onCommand(session.key, { kind: "discard-distill", ts })
        }
        onPickSuggestion={(s) => {
          recordSuggestionClick(s.id);
          onSend(session.key, s.prompt);
        }}
      />
      {councilMode && (
        <box
          flexDirection="row"
          height={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme.selBg}
        >
          <text fg={theme.goldBright} attributes={1}>⚖ council mode ON</text>
          <text fg={theme.fgDim}>  · your next message fans out to the panel</text>
        </box>
      )}
      <StatusLine session={session} tick={tick} />
      {popover && (
        <box flexDirection="column" paddingLeft={2} paddingRight={2}>
          <SlashAutocomplete
            matches={popover.matches}
            selectedIdx={popover.selectedIdx}
            onPick={popover.onPick}
            onHover={popover.onHover}
          />
        </box>
      )}
      <InputBox
        inputRef={ref}
        disabled={session.pending}
        onSubmit={handleSubmit}
        onAutocompleteChange={onAutocompleteChange}
        onPopoverChange={setPopover}
        recentPrompts={session.messages
          .filter((m) => m.role === "user" && m.content.trim().length > 0)
          .map((m) => m.content)}
      />
    </box>
  );
}

function forceFocus(ref: React.RefObject<any>) {
  try {
    ref.current?.focus?.();
  } catch {}
}

function PickerBar({
  clis,
  currentCli,
  model,
  onSwitchCli,
  onPickModel,
  onOpenCouncilConfig,
}: {
  clis: AvailableCli[];
  currentCli: CliKind;
  model: string;
  onSwitchCli: (cli: CliKind) => void;
  onPickModel: (model: string) => void;
  onOpenCouncilConfig: () => void;
}) {
  const picks = MODEL_QUICKPICKS[currentCli] ?? [];
  const isDefault = !model.trim();
  const currentLower = model.trim().toLowerCase();
  const customActive =
    !isDefault && !picks.some((p) => p === currentLower || currentLower.includes(p));
  return (
    <box
      flexDirection="row"
      height={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bg}
    >
      {clis.map((c) => {
        const active = c.kind === currentCli;
        const fg = active ? theme.gold : theme.fgDim;
        const bg = active ? theme.selBg : theme.bg;
        return (
          <box
            key={c.kind}
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={bg}
            onMouseDown={() => {
              if (!active) onSwitchCli(c.kind);
            }}
          >
            <text fg={fg} bg={bg}>
              {active ? `▸ ${c.label}` : c.label}
            </text>
          </box>
        );
      })}
      <text fg={theme.fgFaint}>  │  </text>
      <ModelChip
        label="default"
        active={isDefault}
        onClick={() => !isDefault && onPickModel("default")}
      />
      {picks.map((id) => (
        <ModelChip
          key={id}
          label={id}
          active={!isDefault && (id === currentLower || currentLower.includes(id))}
          onClick={() => onPickModel(id)}
        />
      ))}
      {customActive && <ModelChip label={model} active onClick={() => {}} />}
      <box flexGrow={1} />
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.bg}
        onMouseDown={onOpenCouncilConfig}
      >
        <text fg={theme.gold}>⚖ council</text>
      </box>
    </box>
  );
}

function ModelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const fg = active ? theme.gold : theme.fgDim;
  const bg = active ? theme.selBg : theme.bg;
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      onMouseDown={onClick}
    >
      <text fg={fg} bg={bg}>
        {active ? `▸ ${label}` : label}
      </text>
    </box>
  );
}

function SkillStrip({
  session,
  onPickSkill,
}: {
  session: ChatSession;
  onPickSkill: (skillId: string, title: string) => void;
}) {
  const skills = session.hostDomain.skills;
  if (skills.length === 0) return null;
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      backgroundColor={theme.bg}
    >
      <box
        flexDirection="column"
        border
        borderColor={theme.fgFaint}
        backgroundColor={theme.bg}
        title={` skills · ${session.hostDomain.name} (${skills.length}) — click to invoke `}
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
        height={5}
      >
        <scrollbox flexGrow={1} scrollY>
          {skills.map((s) => (
            <box
              key={s.id}
              flexDirection="row"
              height={1}
              onMouseDown={() => onPickSkill(s.id, s.title)}
            >
              <text fg={theme.gold}>▸ </text>
              <text fg={theme.fg}>{s.id}</text>
              <text fg={theme.fgFaint}>  · {s.title}</text>
            </box>
          ))}
        </scrollbox>
      </box>
    </box>
  );
}

function Transcript({
  session,
  tick,
  suggestions,
  availableClis,
  councilMode,
  onToggleCouncilMode,
  onAcceptDistill,
  onDiscardDistill,
  onPickSuggestion,
}: {
  session: ChatSession;
  tick: number;
  suggestions: Suggestion[];
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
  onAcceptDistill: (ts: number, content: string) => void;
  onDiscardDistill: (ts: number) => void;
  onPickSuggestion: (s: Suggestion) => void;
}) {
  const messages = session.messages;
  const showChips =
    suggestions.length > 0 &&
    messages.filter((m) => m.role === "user").length === 0;
  const scrollRef = useRef<any>(null);
  // Track whether the user has scrolled UP and away from the bottom. If so,
  // we don't yank them back — they're reading older history. Reset when a
  // new turn fires (length jumps) so the next AI reply still snaps to view.
  const userScrolledAwayRef = useRef(false);

  // Auto-scroll on ANY message-array change (length grew OR a placeholder
  // got replaced in place), not just length. Use messages reference as the
  // dep — setChats always returns a new array, so this fires reliably.
  // Retry across a few frames because OpenTUI's scrollbox can compute the
  // new content height a tick or two after the React commit; one call alone
  // sometimes lands on a stale height and we sit at the top.
  useEffect(() => {
    if (userScrolledAwayRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    const tryScroll = () => {
      try {
        node.scrollTo?.(1e9);
      } catch {}
    };
    tryScroll();
    const t1 = setTimeout(tryScroll, 30);
    const t2 = setTimeout(tryScroll, 120);
    const t3 = setTimeout(tryScroll, 300);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [messages, session.pending, session.key]);

  // Reset the "scrolled away" flag whenever a brand-new turn starts. Keeps
  // the auto-follow behavior fresh per question — you can scroll up to read,
  // then send a new prompt and we'll follow again.
  useEffect(() => {
    userScrolledAwayRef.current = false;
  }, [messages.filter((m) => m.role === "user").length, session.key]);

  // Keyboard nav: PgUp / PgDn / Home / End scroll the transcript without
  // leaving the input. End also re-arms auto-follow so the next reply lands
  // in view.
  useKeyboard((evt) => {
    const node = scrollRef.current;
    if (!node) return;
    if (evt.name === "pageup") {
      userScrolledAwayRef.current = true;
      try { node.scrollBy?.(0, -20) ?? node.scrollTo?.(0); } catch {}
    } else if (evt.name === "pagedown") {
      try { node.scrollBy?.(0, 20) ?? node.scrollTo?.(1e9); } catch {}
    } else if (evt.name === "home" && evt.ctrl) {
      userScrolledAwayRef.current = true;
      try { node.scrollTo?.(0); } catch {}
    } else if (evt.name === "end" && evt.ctrl) {
      userScrolledAwayRef.current = false;
      try { node.scrollTo?.(1e9); } catch {}
    }
  });

  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      scrollY
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      {showChips && (
        <SuggestionChips suggestions={suggestions} onPick={onPickSuggestion} />
      )}
      <MetaLine session={session} visibleCount={messages.filter((m) => m.role !== "system").length} />
      {messages.map((m, i) => (
        <MessageBubble
          key={`m-${i}-${m.ts}`}
          msg={m}
          tick={tick}
          availableClis={availableClis}
          councilMode={councilMode}
          onToggleCouncilMode={onToggleCouncilMode}
          onAcceptDistill={onAcceptDistill}
          onDiscardDistill={onDiscardDistill}
        />
      ))}
      {/* The generic ThinkingBubble is for normal single-CLI chat. During
          council mode the per-panelist CouncilPendingBubble and the
          CouncilSynthesizingBubble already convey the same info, so suppress
          this one to avoid a redundant 4th spinner. */}
      {session.pending &&
        !messages.some(
          (m) => m.kind === "council-pending" || m.kind === "council-synthesizing",
        ) && <ThinkingBubble tick={tick} cliLabel={session.cli.label} />}
    </scrollbox>
  );
}

const SOURCE_ICON: Record<SuggestionSource, string> = {
  "stale-state": "◆",
  "open-loops": "◯",
  "prompts-md": "▶",
  history: "↻",
  llm: "≡",
  default: "·",
};

function SuggestionChips({
  suggestions,
  onPick,
}: {
  suggestions: Suggestion[];
  onPick: (s: Suggestion) => void;
}) {
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>try one to get started · clicks tune future suggestions</text>
      </box>
      {suggestions.map((s) => (
        <SuggestionChip key={s.id} suggestion={s} onPick={onPick} />
      ))}
    </box>
  );
}

function SuggestionChip({
  suggestion,
  onPick,
}: {
  suggestion: Suggestion;
  onPick: (s: Suggestion) => void;
}) {
  const [hover, setHover] = useState(false);
  const border = hover ? theme.goldBright : theme.gold;
  const labelFg = hover ? theme.goldBright : theme.fg;
  const icon = SOURCE_ICON[suggestion.source] ?? "·";
  return (
    <box flexDirection="column" paddingBottom={0}>
      <box
        flexDirection="row"
        border
        borderColor={border}
        backgroundColor={theme.bg}
        paddingLeft={1}
        paddingRight={1}
        height={3}
        onMouseDown={() => onPick(suggestion)}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <text fg={theme.gold}>{icon} </text>
        <text fg={labelFg}>{suggestion.label}</text>
      </box>
    </box>
  );
}

function buildSuggestionContext(session: ChatSession): SuggestionContext {
  const seed = session.seed;
  const isApp = seed !== "tab" && seed.kind === "app";
  // For app sessions we still anchor on hostDomain (always set) but key the
  // suggestion context to the app id so click-tracking is per-app, not per-host.
  const name = isApp ? seed.id : session.hostDomain.name;
  const path = session.hostDomain.path;
  const promptsPath = join(path, "PROMPTS.md");
  let promptsContent = "";
  if (existsSync(promptsPath)) {
    try {
      promptsContent = readFileSync(promptsPath, "utf8");
    } catch {}
  }
  const promptsMdEntries = parsePromptsMd(promptsContent);
  let recentChatPrompts: string[] = [];
  try {
    recentChatPrompts = getRecentUserPrompts(session.hostDomain.name, 10);
  } catch {}
  return {
    kind: isApp ? "app" : "domain",
    name,
    path,
    openLoopCount: session.hostDomain.openLoopCount,
    stateMtime: session.hostDomain.stateMtime,
    recentChatPrompts,
    promptsMdEntries,
  };
}

function MetaLine({ session, visibleCount }: { session: ChatSession; visibleCount: number }) {
  const ctx = useMemo(() => buildDomainContext(session.hostDomain), [session.hostDomain.path]);
  const history = useMemo(
    () => getDomainHistory(session.hostDomain.name),
    [session.hostDomain.name, session.key],
  );

  const parts: string[] = [];
  parts.push(`${visibleCount} msg${visibleCount === 1 ? "" : "s"}`);
  parts.push(`updated ${ctx.updatedLabel}`);
  if (session.seed !== "tab" && session.seed.kind === "skill") {
    parts.push(`skill ${session.seed.id}`);
  } else if (session.seed !== "tab" && session.seed.kind === "app") {
    parts.push(`app ${session.seed.id} (${session.seed.domains.length}×)`);
  }
  if (history.message_count > 0) {
    parts.push(
      `${history.message_count} past chat${history.message_count === 1 ? "" : "s"} · /search`,
    );
  }

  return (
    <box flexDirection="row" height={1} paddingBottom={0}>
      <text fg={theme.fgFaint}>{parts.join("  ·  ")}</text>
      <text fg={theme.fgFaint}>  ·  </text>
      <box
        flexDirection="row"
        onMouseDown={() => openInFinder(session.hostDomain.path)}
      >
        <text fg={theme.bubbleAssistant} attributes={4}>
          {shortenHome(session.hostDomain.path)}
        </text>
        <text fg={theme.fgFaint}> ↗</text>
      </box>
    </box>
  );
}

function MessageBubble({
  msg,
  tick,
  availableClis,
  councilMode,
  onToggleCouncilMode,
  onAcceptDistill,
  onDiscardDistill,
}: {
  msg: ChatMsg;
  tick: number;
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
  onAcceptDistill: (ts: number, content: string) => void;
  onDiscardDistill: (ts: number) => void;
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
    </box>
  );
}

function DistillDraftBubble({
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

function ThinkingBubble({ tick, cliLabel }: { tick: number; cliLabel: string }) {
  const char = spinnerChar(tick);
  const word = thinkingWord(tick);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="row"
        border
        borderColor={theme.bubbleAssistant}
        backgroundColor={theme.bg}
        title={` ${cliLabel} `}
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.gold}>{char}</text>
        <text fg={theme.fgDim}>  {word}…</text>
      </box>
    </box>
  );
}

const COUNCIL_KINDS: ConfigCliKind[] = ["claude", "codex", "gemini"];

function CouncilConfigBubble({
  availableClis,
  councilMode,
  onToggleCouncilMode,
}: {
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
}) {
  // Force re-render after each click that mutates persistent config.
  const [_revision, setRevision] = useState(0);
  const cfg = readCouncilConfig();
  const detectedKinds = new Set(availableClis.map((c) => c.kind));

  const isInPanel = (k: ConfigCliKind): boolean => {
    if (cfg.clis === null) return detectedKinds.has(k);
    return cfg.clis.includes(k);
  };

  const togglePanel = (k: ConfigCliKind) => {
    if (!detectedKinds.has(k)) return;
    const detectedList = Array.from(detectedKinds) as ConfigCliKind[];
    const current = cfg.clis ?? detectedList;
    const next = current.includes(k)
      ? current.filter((x) => x !== k)
      : [...current, k];
    setCouncilClis(next.length === 0 ? [] : next);
    setRevision((r) => r + 1);
  };

  // Set "default" (no pin) — clears all model variants for this CLI.
  const resetModels = (k: ConfigCliKind) => {
    setCouncilModel(k, null);
    setRevision((r) => r + 1);
  };
  // Toggle a model variant in/out of the panel for this CLI. Lets the user
  // build a comparison panel (e.g. opus-4-7 + opus-4-8 + sonnet) by checking
  // multiple chips on the same row.
  const toggleVariant = (k: ConfigCliKind, m: string, isOn: boolean) => {
    if (isOn) removeCouncilModel(k, m);
    else addCouncilModel(k, m);
    setRevision((r) => r + 1);
  };

  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={theme.gold}
        backgroundColor={theme.bg}
        title=" ⚖ council panel · click to toggle "
        titleAlignment="left"
        bottomTitle=" persists to ~/.prevail/config.json "
        bottomTitleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
      >
        {COUNCIL_KINDS.map((kind) => {
          const detected = detectedKinds.has(kind);
          const inPanel = detected && isInPanel(kind);
          const checkbox = inPanel ? "[×]" : detected ? "[ ]" : "[—]";
          const checkboxFg = inPanel
            ? theme.gold
            : detected
              ? theme.fgDim
              : theme.fgFaint;
          const nameFg = detected ? theme.gold : theme.fgFaint;
          const pinnedList = cfg.models[kind] ?? [];
          const hasAnyPin = pinnedList.length > 0;
          const picks = MODEL_QUICKPICKS[kind] ?? [];
          // Surface custom model entries the user added that aren't in the
          // built-in quickpicks (typed via /council model claude add foo).
          const customPins = pinnedList.filter((m) => !picks.includes(m));
          return (
            <box key={kind} flexDirection="column" paddingTop={0}>
              <box
                flexDirection="row"
                height={1}
                onMouseDown={() => togglePanel(kind)}
              >
                <text fg={checkboxFg} attributes={inPanel ? 1 : 0}>
                  {checkbox}{" "}
                </text>
                <text fg={nameFg} attributes={inPanel ? 1 : 0}>
                  {kind}
                </text>
                {!detected && (
                  <text fg={theme.fgFaint}>  (not on PATH)</text>
                )}
                {detected && (
                  <text fg={theme.fgFaint}>
                    {"  → "}
                    {hasAnyPin ? pinnedList.join(", ") : "default model"}
                  </text>
                )}
              </box>
              {detected && (() => {
                // Aliases ("opus", "sonnet", "haiku") are CLI shorthand that
                // resolves to *the latest* model in that tier. Versioned IDs
                // ("claude-opus-4-7") pin a specific version. We show them on
                // separate rows so the comparison is explicit.
                //
                // Width matters: cramming all 6 claude versions on one row
                // overflows the bubble and right-edge chips get clipped
                // mid-string (the user sees "claude-opus-" with no number).
                // So we group versions by tier prefix (opus / sonnet / haiku)
                // and render each tier on its own row.
                const isVersionId = (s: string) => /-\d/.test(s);
                const aliasPicks = picks.filter((p) => !isVersionId(p));
                const versionPicks = picks.filter(isVersionId);
                const renderChip = (p: string, displayLabel?: string) => {
                  const isOn = pinnedList.includes(p);
                  return (
                    <CouncilModelChip
                      key={p}
                      label={displayLabel ?? p}
                      active={isOn}
                      onClick={() => toggleVariant(kind, p, isOn)}
                    />
                  );
                };
                // Group versions by tier so claude's 6 IDs become 3 rows of
                // 1-3 chips each. For codex/gemini (4 versions) the group is
                // just one row, which is fine.
                const tierOf = (s: string): string => {
                  const m = s.match(/^(?:claude-|gemini-|gpt-)?([a-z0-9]+)/i);
                  return m?.[1]?.toLowerCase() ?? s;
                };
                const versionTiers = new Map<string, string[]>();
                for (const v of versionPicks) {
                  const t = tierOf(v);
                  const arr = versionTiers.get(t) ?? [];
                  arr.push(v);
                  versionTiers.set(t, arr);
                }
                return (
                  <box flexDirection="column">
                    <box flexDirection="row" height={1} paddingLeft={2}>
                      <text fg={theme.fgFaint}>aliases: </text>
                      <CouncilModelChip
                        label="default"
                        active={!hasAnyPin}
                        onClick={() => resetModels(kind)}
                      />
                      {aliasPicks.map((p) =>
                        renderChip(p, `${p} (latest)`),
                      )}
                    </box>
                    {[...versionTiers.entries()].map(([tier, list]) => (
                      <box
                        key={tier}
                        flexDirection="row"
                        height={1}
                        paddingLeft={2}
                      >
                        <text fg={theme.fgFaint}>
                          {`${tier.padEnd(8, " ")}:`}
                        </text>
                        {list.map((p) =>
                          // Codex pinned versions are blocked when codex is
                          // logged in via ChatGPT-account auth (the common
                          // case). Suffix the chip label with * so the user
                          // sees up-front which picks need API-key auth; the
                          // footer below the section explains.
                          renderChip(
                            p,
                            kind === "codex" ? `${p} *` : undefined,
                          ),
                        )}
                      </box>
                    ))}
                    {kind === "codex" && versionPicks.length > 0 && (
                      <box flexDirection="row" height={1} paddingLeft={2}>
                        <text fg={theme.fgFaint}>
                          {"         * pinned codex models require codex login --api-key — ChatGPT-account auth only allows the default"}
                        </text>
                      </box>
                    )}
                    {customPins.length > 0 && (
                      <box flexDirection="row" height={1} paddingLeft={2}>
                        <text fg={theme.fgFaint}>custom:  </text>
                        {customPins.map((p) => (
                          <CouncilModelChip
                            key={p}
                            label={p}
                            active
                            onClick={() => toggleVariant(kind, p, true)}
                          />
                        ))}
                      </box>
                    )}
                  </box>
                );
              })()}
              <text> </text>
            </box>
          );
        })}
        {(() => {
          // Verdict synthesizer (chair). null = auto: first panelist that
          // returns. Pinning lets the user always have e.g. claude write the
          // verdict no matter who else is on the panel. Click a chip to set;
          // click "auto" to clear.
          const chair = cfg.chair;
          const pickChair = (next: { cli: ConfigCliKind } | null) => {
            setCouncilChair(next);
            setRevision((r) => r + 1);
          };
          return (
            <box flexDirection="column" paddingTop={0}>
              <box flexDirection="row" height={1}>
                <text fg={theme.gold} attributes={1}>verdict synthesizer</text>
                <text fg={theme.fgFaint}>
                  {"  → "}
                  {chair
                    ? chair.model
                      ? `${chair.cli} · ${chair.model}`
                      : chair.cli
                    : "auto (first panelist to reply)"}
                </text>
              </box>
              <box flexDirection="row" height={1} paddingLeft={2}>
                <text fg={theme.fgFaint}>chair:   </text>
                <CouncilModelChip
                  label="auto"
                  active={chair === null}
                  onClick={() => pickChair(null)}
                />
                {COUNCIL_KINDS.map((k) => (
                  <CouncilModelChip
                    key={k}
                    label={k}
                    active={chair?.cli === k}
                    onClick={() => pickChair({ cli: k })}
                  />
                ))}
              </box>
              <text> </text>
            </box>
          );
        })()}
        <box
          flexDirection="row"
          height={1}
          onMouseDown={onToggleCouncilMode}
        >
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={councilMode ? theme.selBg : theme.bgPanel}
          >
            <text fg={councilMode ? theme.goldBright : theme.gold} attributes={1}>
              {councilMode ? "▣ council mode ON" : "▸ ask the council  (next message fans out)"}
            </text>
          </box>
          {councilMode && (
            <text fg={theme.fgFaint}>  · click again to turn off · or just type /council</text>
          )}
        </box>
        <text> </text>
      </box>
    </box>
  );
}

// Full-pane overlay version of the council configuration UI. Rendered by App
// when councilConfigOpen is true — keeps the config out of the chat transcript.
// ESC closes; clicking "done" closes; mutations persist immediately to
// ~/.prevail/config.json (same handlers as the original bubble).
export function CouncilConfigPanel({
  availableClis,
  councilMode,
  onToggleCouncilMode,
  onClose,
}: {
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
  onClose: () => void;
}) {
  useKeyboard((evt) => {
    if (evt.name === "escape") onClose();
  });
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title=" ⚖ configure council "
      titleAlignment="left"
      bottomTitle=" esc or click [done] to close · changes save instantly "
      bottomTitleAlignment="left"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={theme.fgDim}>
        Pick which CLIs run when council mode is active, and (optionally) pin a
        specific model per CLI. The toggle at the bottom is the same toggle as
        the [⚖ Council] chip in the top-right of the chat.
      </text>
      <text> </text>
      <CouncilConfigBubble
        availableClis={availableClis}
        councilMode={councilMode}
        onToggleCouncilMode={onToggleCouncilMode}
      />
      <box flexGrow={1} />
      <box flexDirection="row" height={1} onMouseDown={onClose}>
        <text fg={theme.gold} attributes={1}>[ done ]</text>
        <text fg={theme.fgFaint}>  · esc also closes</text>
      </box>
    </box>
  );
}

const COUNCIL_CLI_COLORS: Record<CliKind, string> = {
  claude: theme.gold, // warm gold — matches brand
  codex: theme.bubbleAssistant, // muted blue
  gemini: theme.ok, // green
};

// Per-panelist placeholder rendered the instant runCouncil fans out, so the
// user sees all 3 (or however many) panelists working at once. Replaced by
// CouncilResponseBubble when that panelist actually returns.
function CouncilPendingBubble({ msg, tick }: { msg: ChatMsg; tick: number }) {
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

function CouncilResponseBubble({ msg }: { msg: ChatMsg }) {
  const cli = msg.cli;
  const color = cli ? COUNCIL_CLI_COLORS[cli] : theme.bubbleAssistant;
  const labelParts = [cli ?? "unknown"];
  if (msg.model) labelParts.push(msg.model);
  const title = ` ⚖ ${labelParts.join(" · ")} `;
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
    </box>
  );
}

// Step-2 placeholder rendered between the panelist replies and the final
// verdict. Distinct from the per-panelist CouncilPendingBubble so the user
// can see the synthesis step explicitly ("synthesizing with Claude Code…")
// instead of wondering why the chair is "thinking" alongside the panel.
function CouncilSynthesizingBubble({ msg, tick }: { msg: ChatMsg; tick: number }) {
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

// Final synthesized recommendation across the council. Visually distinct:
// brighter gold border, thicker title, and a clear bottom-title hint.
function CouncilVerdictBubble({ msg }: { msg: ChatMsg }) {
  const synthCli = msg.cli ?? "claude";
  const labelParts: string[] = [synthCli];
  if (msg.model) labelParts.push(msg.model);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={theme.goldBright}
        backgroundColor={theme.bg}
        title=" ⚖ council verdict "
        titleAlignment="left"
        bottomTitle={` synthesized by ${labelParts.join(" · ")} `}
        bottomTitleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        {renderMarkdownLines(msg.content)}
      </box>
    </box>
  );
}

function CouncilModelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  // Bordered chip — gives an obvious clickable hit target so the user sees
  // these as buttons (the borderless ModelChip in the picker bar reads as
  // text, which confused users in the inline council bubble).
  const bg = active ? theme.selBg : theme.bgPanel;
  const fg = active ? theme.goldBright : theme.gold;
  const border = active ? theme.goldBright : theme.fgDim;
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      borderColor={border}
      border={["left", "right"]}
      onMouseDown={onClick}
    >
      <text fg={fg} bg={bg} attributes={active ? 1 : 0}>
        {label}
      </text>
    </box>
  );
}

function StatusLine({ session, tick: _tick }: { session: ChatSession; tick: number }) {
  // When pending, the per-message ThinkingBubble at the end of the transcript
  // already shows the spinner + "X is thinking…" word. Rendering the same
  // here was a duplicate, so the status line stays silent during work and
  // only carries the idle ready-prompt.
  return (
    <box
      flexDirection="row"
      height={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bg}
    >
      {session.pending ? (
        <text fg={theme.fgFaint}> </text>
      ) : (
        <text fg={theme.fgFaint}>
          {session.hasFirstTurn
            ? "ready · type your next question"
            : "ready · seeded with " + describeSeed(session.seed)}
        </text>
      )}
    </box>
  );
}

interface SlashCommandSpec {
  cmd: string;
  arg?: string;
  desc: string;
  aliases?: string[];
}

const SLASH_COMMANDS: SlashCommandSpec[] = [
  { cmd: "/distill", desc: "synthesize this conversation into a reusable SKILL.md", aliases: ["/skill"] },
  { cmd: "/search", arg: "<query>", desc: "FTS5 search across all past chats", aliases: ["/s"] },
  { cmd: "/history", arg: "[n]", desc: "show your past prompts for this domain (default 20)", aliases: ["/h", "/prompts"] },
  { cmd: "/web", arg: "[on|off]", desc: "global web access — toggle or check status (default: allow)" },
  { cmd: "/council", arg: "<prompt>", desc: "ask the configured panel in parallel  ·  /council config to see panel, /council use ..., /council model ...", aliases: ["/c", "/panel"] },
  { cmd: "/heatmap", arg: "[days]", desc: "domain activity heatmap (default 30 days)", aliases: ["/heat", "/activity"] },
  { cmd: "/watch", arg: "[n]", desc: "show recent background-watcher observations (default 20)", aliases: ["/watcher", "/obs"] },
  { cmd: "/claude", arg: "[model]", desc: "switch this chat to Claude Code" },
  { cmd: "/codex", arg: "[model]", desc: "switch this chat to Codex" },
  { cmd: "/gemini", arg: "[model]", desc: "switch this chat to Gemini CLI" },
  { cmd: "/model", arg: "<name>", desc: "set model on the current CLI · /model default clears it", aliases: ["/m"] },
  { cmd: "/clear", desc: "clear conversation messages (keeps session config)", aliases: ["/reset"] },
  { cmd: "/help", desc: "show all slash commands", aliases: ["/?"] },
  { cmd: "/exit", desc: "return to cockpit (same as esc)", aliases: ["/quit", "/q", "/close"] },
];

function matchSlashCommands(query: string): SlashCommandSpec[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => {
    if (c.cmd.startsWith(q)) return true;
    return (c.aliases ?? []).some((a) => a.startsWith(q));
  });
}

interface PopoverState {
  matches: SlashCommandSpec[];
  selectedIdx: number;
  onHover: (i: number) => void;
  onPick: (cmd: SlashCommandSpec) => void;
}

function InputBox({
  inputRef,
  disabled,
  onSubmit,
  onAutocompleteChange,
  onPopoverChange,
  recentPrompts,
}: {
  inputRef: React.RefObject<any>;
  disabled: boolean;
  onSubmit: (v: string) => void;
  onAutocompleteChange?: (open: boolean) => void;
  onPopoverChange?: (p: PopoverState | null) => void;
  // Most-recent-last list of prior user prompts for ↑/↓ history recall.
  // When the slash autocomplete is open, ↑/↓ still drives that menu (its
  // handler runs first and returns). Otherwise ↑ walks backward through
  // history (newest first), ↓ walks forward toward the original draft.
  recentPrompts: string[];
}) {
  const [value, setValue] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  // History-navigation state. historyIdx = 0 means "showing user's current
  // draft"; 1 = most recent prior prompt; 2 = second most recent; etc.
  // draftBeforeHistory snapshots the in-progress text so ↓ can return to it
  // after the user walks up through history and decides to come back.
  const historyIdxRef = useRef(0);
  const draftBeforeHistoryRef = useRef("");
  const showAutocomplete = !disabled && value.startsWith("/");
  const matches = useMemo(
    () => (showAutocomplete ? matchSlashCommands(value) : []),
    [showAutocomplete, value],
  );

  useEffect(() => {
    onAutocompleteChange?.(showAutocomplete && matches.length > 0);
  }, [showAutocomplete, matches.length, onAutocompleteChange]);

  useEffect(() => {
    if (selectedIdx >= matches.length) setSelectedIdx(0);
  }, [matches.length, selectedIdx]);

  const pickCommand = (cmd: SlashCommandSpec) => {
    const needsArg = !!cmd.arg;
    const next = needsArg ? `${cmd.cmd} ` : cmd.cmd;
    setValue(next);
    setSelectedIdx(0);
    if (inputRef.current) {
      try {
        inputRef.current.value = next;
        inputRef.current.focus?.();
      } catch {}
    }
  };

  // Surface the popover to the parent so it can render OUTSIDE InputBox and
  // keep the input row at a stable bottom position when slash commands fire.
  useEffect(() => {
    if (showAutocomplete && matches.length > 0) {
      onPopoverChange?.({
        matches,
        selectedIdx,
        onHover: setSelectedIdx,
        onPick: pickCommand,
      });
    } else {
      onPopoverChange?.(null);
    }
  }, [showAutocomplete, matches, selectedIdx, onPopoverChange]);

  // Drop the input's text both in our state and in the underlying OpenTUI
  // <input>. setText is the OpenTUI handle for programmatic value changes;
  // setValue alone wouldn't make the cursor + visible text follow.
  const setInputText = (next: string) => {
    setValue(next);
    try {
      inputRef.current?.setText?.(next);
    } catch {}
  };

  const handleSubmit = (v: string) => {
    const trimmed = v.trim();
    if (showAutocomplete && matches.length > 0 && !trimmed.includes(" ")) {
      const exact = matches.find(
        (m) => m.cmd === trimmed || (m.aliases ?? []).some((a) => a === trimmed),
      );
      if (!exact) {
        const pick = matches[selectedIdx];
        if (pick) {
          pickCommand(pick);
          return;
        }
      }
    }
    setValue("");
    setSelectedIdx(0);
    // Successful send — reset history cursor so the next ↑ starts from the
    // newest prompt again. Drop any saved draft too; the user just sent.
    historyIdxRef.current = 0;
    draftBeforeHistoryRef.current = "";
    onSubmit(v);
  };

  useKeyboard((evt) => {
    // Slash-menu navigation takes priority when it's open.
    if (showAutocomplete && matches.length > 0) {
      if (evt.name === "up") {
        setSelectedIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      } else if (evt.name === "down") {
        setSelectedIdx((i) => (i + 1) % matches.length);
        return;
      } else if (evt.name === "tab") {
        const pick = matches[selectedIdx];
        if (pick) pickCommand(pick);
        return;
      }
    }
    // Otherwise ↑/↓ walks prior-prompt history (terminal-style recall).
    // Empty session → nothing to recall, no-op.
    if (recentPrompts.length === 0) return;
    if (evt.name === "up") {
      if (historyIdxRef.current === 0) {
        // First step into history — snapshot whatever the user was typing
        // so ↓ can bring it back when they walk forward past index 1.
        draftBeforeHistoryRef.current = value;
      }
      const nextIdx = Math.min(historyIdxRef.current + 1, recentPrompts.length);
      historyIdxRef.current = nextIdx;
      setInputText(recentPrompts[recentPrompts.length - nextIdx] ?? "");
    } else if (evt.name === "down") {
      if (historyIdxRef.current === 0) return; // already at draft
      const nextIdx = historyIdxRef.current - 1;
      historyIdxRef.current = nextIdx;
      if (nextIdx === 0) {
        setInputText(draftBeforeHistoryRef.current);
      } else {
        setInputText(recentPrompts[recentPrompts.length - nextIdx] ?? "");
      }
    }
  });

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      height={4}
    >
      <box
        flexDirection="row"
        border
        borderColor={disabled ? theme.fgFaint : theme.inputBorder}
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
        height={3}
      >
        <text fg={disabled ? theme.fgFaint : theme.gold}>{`› `}</text>
        <input
          ref={inputRef}
          flexGrow={1}
          focused
          placeholder={
            disabled
              ? "still thinking — type your next message or press esc"
              : "ask anything · / for commands · enter sends · esc back"
          }
          backgroundColor={theme.bgPanel}
          textColor={theme.fg}
          onInput={((next: string) => {
            // User-typed change. Drop the history cursor so the next ↑ starts
            // from the most recent prompt again (otherwise editing a recalled
            // prompt then ↓ would surprise people by jumping back to draft).
            setValue(next);
            historyIdxRef.current = 0;
            draftBeforeHistoryRef.current = "";
          }) as any}
          onSubmit={handleSubmit as any}
        />
      </box>
    </box>
  );
}

function SlashAutocomplete({
  matches,
  selectedIdx,
  onPick,
  onHover,
}: {
  matches: SlashCommandSpec[];
  selectedIdx: number;
  onPick: (c: SlashCommandSpec) => void;
  onHover: (i: number) => void;
}) {
  return (
    <box
      flexDirection="column"
      border
      borderColor={theme.gold}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      title=" slash commands · ↑↓ select · tab accept "
      titleAlignment="left"
    >
      {matches.map((c, i) => {
        const active = i === selectedIdx;
        const bg = active ? theme.selBg : theme.bgPanel;
        const cmdFg = active ? theme.goldBright : theme.gold;
        const argFg = active ? theme.selFg : theme.fgDim;
        const descFg = active ? theme.selFg : theme.fg;
        return (
          <box
            key={c.cmd}
            flexDirection="row"
            backgroundColor={bg}
            height={1}
            onMouseDown={() => onPick(c)}
            onMouseMove={() => onHover(i)}
          >
            <text fg={active ? theme.gold : theme.fgFaint} bg={bg}>
              {active ? "› " : "  "}
            </text>
            <text fg={cmdFg} bg={bg} attributes={active ? 1 : 0}>
              {c.cmd.padEnd(10, " ")}
            </text>
            <text fg={argFg} bg={bg}>{(c.arg ?? "").padEnd(12, " ")}</text>
            <text fg={descFg} bg={bg}>{c.desc}</text>
          </box>
        );
      })}
    </box>
  );
}

function describeSeed(seed: ChatSeed): string {
  if (seed === "tab") return "the active tab";
  if (seed.kind === "skill") return `skill ${seed.id}`;
  return `app ${seed.id} (${seed.domains.length} domain${seed.domains.length === 1 ? "" : "s"})`;
}

function parseSlashCommand(text: string): ChatCommand {
  const trimmed = text.slice(1).trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ");
  const cmd = head.toLowerCase();
  if (cmd === "exit" || cmd === "quit" || cmd === "q" || cmd === "close") {
    return { kind: "exit" };
  }
  if (cmd === "help" || cmd === "?" || cmd === "commands") {
    return { kind: "help" };
  }
  if (cmd === "clear" || cmd === "reset") {
    return { kind: "clear" };
  }
  if (cmd === "claude") return { kind: "switch-cli", cli: "claude", model: arg || undefined };
  if (cmd === "codex") return { kind: "switch-cli", cli: "codex", model: arg || undefined };
  if (cmd === "gemini") return { kind: "switch-cli", cli: "gemini", model: arg || undefined };
  if (cmd === "model" || cmd === "m") return { kind: "switch-model", model: arg };
  if (cmd === "distill" || cmd === "skill") return { kind: "distill" };
  if (cmd === "search" || cmd === "s") return { kind: "search", query: arg };
  if (cmd === "history" || cmd === "h" || cmd === "prompts") {
    const n = parseInt(arg, 10);
    return { kind: "history", limit: Number.isFinite(n) && n > 0 ? n : undefined };
  }
  if (cmd === "web") {
    const a = arg.trim().toLowerCase();
    if (a === "on" || a === "allow" || a === "enable") return { kind: "web", mode: "allow" };
    if (a === "off" || a === "deny" || a === "disable") return { kind: "web", mode: "deny" };
    return { kind: "web", mode: "status" };
  }
  if (cmd === "council" || cmd === "c" || cmd === "panel") {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    if (sub === "config" || sub === "status" || sub === "show") {
      return { kind: "council-config" };
    }
    if (sub === "use" || sub === "set") {
      return { kind: "council-use", clis: parts.slice(1).map((s) => s.toLowerCase()) };
    }
    if (sub === "model") {
      const cliArg = parts[1] ?? "";
      const modelArg = parts.slice(2).join(" ");
      return { kind: "council-model", cli: cliArg.toLowerCase(), model: modelArg };
    }
    if (sub === "chair" || sub === "synth" || sub === "synthesizer") {
      // /council chair                  — show current chair
      // /council chair default          — clear (auto: first successful panelist)
      // /council chair <cli> [model]    — pin to a specific (cli, model)
      const cliArg = (parts[1] ?? "").toLowerCase();
      const modelArg = parts.slice(2).join(" ").trim();
      return { kind: "council-chair", cli: cliArg, model: modelArg };
    }
    return { kind: "council", prompt: arg };
  }
  if (cmd === "heatmap" || cmd === "heat" || cmd === "activity") {
    const n = parseInt(arg, 10);
    return { kind: "heatmap", days: Number.isFinite(n) && n > 0 ? n : undefined };
  }
  if (cmd === "watch" || cmd === "watcher" || cmd === "obs") {
    const n = parseInt(arg, 10);
    return { kind: "watch", limit: Number.isFinite(n) && n > 0 ? n : undefined };
  }
  return { kind: "unknown", raw: text };
}

export const SLASH_HELP = [
  "/claude [model]   switch this chat to Claude Code (model arg optional)",
  "/codex [model]    switch this chat to Codex",
  "/gemini [model]   switch this chat to Gemini CLI",
  "/model <name>     set model on the current CLI · /model default clears it",
  "/distill          synthesize this conversation into a reusable SKILL.md (alias: /skill)",
  "/search <query>   FTS5 search across all past chats in any domain (alias: /s)",
  "/clear            clear conversation messages (keeps session config)",
  "/help             show this list",
  "/exit             return to cockpit (same as esc)",
  "",
  "model is passed straight through to the CLI (--model <name>),",
  "so whatever your CLI accepts will work — opus, sonnet, gpt-5, etc.",
].join("\n");

export function makeInitialMessages(label: string, cli: AvailableCli): ChatMsg[] {
  return [
    {
      role: "system",
      content: `chat with ${label} · ${cli.label} · esc to return`,
      ts: Date.now(),
    },
  ];
}

export function makeSeedPrompt(session: ChatSession, userText: string): string {
  if (session.hasFirstTurn) return userText;
  const head = baseSeedPrompt(session);
  return `${head}\n\nFirst user message: ${userText}`;
}

function baseSeedPrompt(session: ChatSession): string {
  const seed = session.seed;
  if (seed === "tab") return buildChatPrompt(session.hostDomain, session.initialView);
  if (seed.kind === "skill") {
    return `You are helping with the "${session.hostDomain.name}" life domain. The user wants to run the "${seed.id}" skill (${seed.title}). Read SKILL.md under ${session.hostDomain.path}/../skills/${seed.id}/, confirm any inputs you need, then act on the ${session.hostDomain.path} vault.`;
  }
  return `You are connecting the "${seed.id}" app (${seed.title}). It is referenced by these life domains: ${seed.domains.join(", ")}. Read its SKILL.md to learn how to authenticate and what data it exposes, then ask the user which domain to act on and what to fetch.`;
}
