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
  kind?: "distill-draft" | "distill-saved" | "distill-discarded";
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
  | { kind: "heatmap"; days?: number }
  | { kind: "watch"; limit?: number }
  | { kind: "unknown"; raw: string };

interface Props {
  session: ChatSession;
  availableClis: AvailableCli[];
  tick: number;
  onSend: (key: string, text: string) => void;
  onCommand: (key: string, command: ChatCommand) => void;
  onExit: () => void;
  onAutocompleteChange?: (open: boolean) => void;
}

export function ChatPane({ session, availableClis, tick, onSend, onCommand, onExit, onAutocompleteChange }: Props) {
  const ref = useRef<any>(null);

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
    if (evt.name === "escape") onExit();
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
    onSend(session.key, text);
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
      bottomTitle={` enter send · / for commands · esc back `}
      bottomTitleAlignment="left"
    >
      <PickerBar
        clis={availableClis}
        currentCli={session.cli.kind}
        model={session.model}
        onSwitchCli={(cli) =>
          onCommand(session.key, { kind: "switch-cli", cli, model: undefined })
        }
        onPickModel={(model) =>
          onCommand(session.key, { kind: "switch-model", model })
        }
      />
      <Transcript
        session={session}
        tick={tick}
        suggestions={suggestions}
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
      <SkillStrip
        session={session}
        onPickSkill={(skillId, title) => {
          const msg = `Use the ${skillId} skill (${title}). Read its SKILL.md under ${session.hostDomain.path}/../skills/${skillId}/, confirm any inputs you need, then run it on this vault.`;
          onSend(session.key, msg);
        }}
      />
      <StatusLine session={session} tick={tick} />
      <InputBox
        inputRef={ref}
        disabled={session.pending}
        onSubmit={handleSubmit}
        onAutocompleteChange={onAutocompleteChange}
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
}: {
  clis: AvailableCli[];
  currentCli: CliKind;
  model: string;
  onSwitchCli: (cli: CliKind) => void;
  onPickModel: (model: string) => void;
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
      <text fg={theme.fgFaint}>/model name</text>
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
  onAcceptDistill,
  onDiscardDistill,
  onPickSuggestion,
}: {
  session: ChatSession;
  tick: number;
  suggestions: Suggestion[];
  onAcceptDistill: (ts: number, content: string) => void;
  onDiscardDistill: (ts: number) => void;
  onPickSuggestion: (s: Suggestion) => void;
}) {
  const messages = session.messages;
  const showChips =
    suggestions.length > 0 &&
    messages.filter((m) => m.role === "user").length === 0;
  const scrollRef = useRef<any>(null);

  // Auto-scroll to the latest message whenever the message count or the
  // pending (assistant typing) state changes. Use a large scrollTo target so
  // we land at the bottom regardless of total height.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    try {
      node.scrollTo?.(1e9);
    } catch {}
  }, [messages.length, session.pending, session.key]);

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
          onAcceptDistill={onAcceptDistill}
          onDiscardDistill={onDiscardDistill}
        />
      ))}
      {session.pending && <ThinkingBubble tick={tick} />}
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
  onAcceptDistill,
  onDiscardDistill,
}: {
  msg: ChatMsg;
  onAcceptDistill: (ts: number, content: string) => void;
  onDiscardDistill: (ts: number) => void;
}) {
  if (msg.kind === "distill-draft") {
    return <DistillDraftBubble msg={msg} onAccept={onAcceptDistill} onDiscard={onDiscardDistill} />;
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
  const label = isUser ? " you " : " claude ";
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

function ThinkingBubble({ tick }: { tick: number }) {
  const char = spinnerChar(tick);
  const word = thinkingWord(tick);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="row"
        border
        borderColor={theme.bubbleAssistant}
        backgroundColor={theme.bg}
        title=" claude "
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

function StatusLine({ session, tick }: { session: ChatSession; tick: number }) {
  return (
    <box
      flexDirection="row"
      height={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bg}
    >
      {session.pending ? (
        <>
          <text fg={theme.gold}>{spinnerChar(tick)}</text>
          <text fg={theme.fgDim}>  {session.cli.label} is {thinkingWord(tick)}…</text>
        </>
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
  { cmd: "/council", arg: "<prompt>", desc: "ask claude, codex, AND gemini in parallel — for high-stakes decisions", aliases: ["/c", "/panel"] },
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

function InputBox({
  inputRef,
  disabled,
  onSubmit,
  onAutocompleteChange,
}: {
  inputRef: React.RefObject<any>;
  disabled: boolean;
  onSubmit: (v: string) => void;
  onAutocompleteChange?: (open: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
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
    onSubmit(v);
  };

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

  useKeyboard((evt) => {
    if (!showAutocomplete || matches.length === 0) return;
    if (evt.name === "up") {
      setSelectedIdx((i) => (i - 1 + matches.length) % matches.length);
    } else if (evt.name === "down") {
      setSelectedIdx((i) => (i + 1) % matches.length);
    } else if (evt.name === "tab") {
      const pick = matches[selectedIdx];
      if (pick) pickCommand(pick);
    }
  });

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
    >
      {showAutocomplete && matches.length > 0 && (
        <SlashAutocomplete
          matches={matches}
          selectedIdx={selectedIdx}
          onPick={pickCommand}
          onHover={setSelectedIdx}
        />
      )}
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
          onInput={setValue as any}
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
