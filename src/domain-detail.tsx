import type React from "react";
import { useEffect, useRef, useState } from "react";
import { theme } from "./theme.ts";
import {
  formatRelativeTime,
  readDomainView,
  skillGroup,
  type AppSkill,
  type Domain,
  type ViewKey,
} from "./vault.ts";
import { renderMarkdownLines } from "./markdown-lite.tsx";
import { detectClis, runChatTurn, type AvailableCli } from "./cli-bridge.ts";
import { WorkspaceConfigBar } from "./workspace-config-bar.tsx";

interface Props {
  domain: Domain | null;
  view: ViewKey;
  skillIdx: number;
  apps: AppSkill[];
  onPickSkill: (i: number) => void;
  topBar?: React.ReactNode;
  setEmbeddedInputActive?: (v: boolean) => void;
  // When the user clicks the "chat" tab in the global tab strip we set
  // this to true, which makes DomainDetail render DomainChat instead of
  // the view-specific markdown. Clicking any other tab (state/quickstart/
  // prompts/skills) sets it back to false. This is what makes each tab
  // actually DO something — previously DomainDetail always showed chat
  // regardless of tab.
  showChat?: boolean;
  // Used by the WorkspaceConfigBar at the top of the pane.
  councilOn?: boolean;
  onToggleCouncil?: () => void;
  frameworkTick?: number;
  onFrameworkChange?: () => void;
}

export function DomainDetail({ domain, view, skillIdx, apps, onPickSkill, topBar, setEmbeddedInputActive, showChat, councilOn, onToggleCouncil, frameworkTick, onFrameworkChange }: Props) {
  if (!domain) {
    return (
      <box
        flexGrow={1}
        border
        borderColor={theme.border}
        backgroundColor={theme.bg}
        title=" detail "
        paddingTop={1}
        paddingLeft={2}
      >
        <text fg={theme.fgDim}>No domain selected.</text>
      </box>
    );
  }

  const updated = formatRelativeTime(domain.stateMtime);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title={` ${domain.name} `}
      titleAlignment="left"
      bottomTitle={` updated ${updated}  ·  skills ${domain.skills.length}  ·  open ${domain.openLoopCount} `}
      bottomTitleAlignment="left"
    >
      {topBar}
      <WorkspaceConfigBar
        vaultPath={domain.path}
        councilOn={councilOn ?? false}
        onToggleCouncil={onToggleCouncil ?? (() => {})}
        frameworkTick={frameworkTick}
        onFrameworkChange={onFrameworkChange}
      />
      {/* Each tab renders DIFFERENT content (per user — they were
          clicking through tabs and seeing the same thing every time):
            chat tab       → DomainChat (embedded, full pane)
            skills tab     → SkillsList
            state tab      → state.md content
            quickstart tab → QUICKSTART.md
            prompts tab    → PROMPTS.md
          Clicking through the strip now actually toggles what's shown. */}
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        {showChat ? (
          <DomainChat domain={domain} setEmbeddedInputActive={setEmbeddedInputActive} />
        ) : view === "skills" ? (
          <SkillsList
            skills={domain.skills}
            selectedIdx={skillIdx}
            onPick={onPickSkill}
            apps={apps}
            domainName={domain.name}
          />
        ) : (
          <scrollbox flexGrow={1} scrollY>
            {renderMarkdownLines(readDomainView(domain, view))}
          </scrollbox>
        )}
      </box>
    </box>
  );
}

// Embedded chat scoped to this life domain. Same pattern as the connector
// workspace's ConnectorChat — owns its own message history, spawns a
// runChatTurn streaming reply, and tells the LLM to use ONLY this domain's
// folder as context.
function DomainChat({ domain, setEmbeddedInputActive }: { domain: Domain; setEmbeddedInputActive?: (v: boolean) => void }) {
  type ChatLine = { role: "user" | "assistant"; content: string; ts: number };
  const [history, setHistory] = useState<ChatLine[]>([]);
  const [pending, setPending] = useState(false);
  const [streamBuf, setStreamBuf] = useState("");
  const [cli, setCli] = useState<AvailableCli | null>(null);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    setHistory([]);
    setPending(false);
    setStreamBuf("");
  }, [domain.name]);

  useEffect(() => {
    let cancelled = false;
    detectClis().then((list) => {
      if (cancelled || list.length === 0) return;
      const claude = list.find((c) => c.kind === "claude");
      setCli(claude ?? list[0]!);
    });
    return () => { cancelled = true; };
  }, []);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    if (!cli) {
      setHistory((h) => [...h, { role: "assistant", content: "(no CLI detected)", ts: Date.now() }]);
      return;
    }
    setHistory((h) => [...h, { role: "user", content: trimmed, ts: Date.now() }]);
    inputRef.current?.setText?.("");
    setPending(true);
    setStreamBuf("");
    const prompt = `You are helping with the "${domain.name}" life domain in a personal-AI cockpit called prevAIl. The vault domain folder is ${domain.path}. Start by reading state.md if you need context. Use ONLY this domain's folder — do not read other domains or connectors.\n\nUser question: ${trimmed}`;
    runChatTurn({
      prompt,
      cwd: domain.path,
      cli,
      model: "",
      isFirst: true,
      bare: true,
      onChunk: (delta) => setStreamBuf((s) => s + delta),
    })
      .then((reply) => setHistory((h) => [...h, { role: "assistant", content: reply, ts: Date.now() }]))
      .catch((err: Error) => setHistory((h) => [...h, { role: "assistant", content: `(error: ${err.message})`, ts: Date.now() }]))
      .finally(() => {
        setPending(false);
        setStreamBuf("");
      });
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" height={1}>
        <text fg={theme.aiAccent} attributes={1}>💬 Chat with {domain.name}</text>
        <text fg={theme.fgFaint}>{`   ·   ${cli?.label ?? "no engine"}   ·   scope: this domain's vault folder`}</text>
      </box>
      <scrollbox flexGrow={1} scrollY>
        {history.length === 0 && !pending && (
          <>
            <text fg={theme.fgFaint}>{`  ask anything about ${domain.name}. try:`}</text>
            <text fg={theme.fgDim}>{`    › what should I work on first?`}</text>
            <text fg={theme.fgDim}>{`    › what's changed in state.md recently?`}</text>
            <text fg={theme.fgDim}>{`    › walk me through the open loops`}</text>
          </>
        )}
        {history.map((m, i) => (
          <box key={i} flexDirection="column" paddingTop={1}>
            <text fg={m.role === "user" ? theme.gold : theme.fgDim}>
              {m.role === "user" ? "  › " : "  ▸ "}
              <span fg={theme.fg}>{m.content}</span>
            </text>
          </box>
        ))}
        {pending && (
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.fgDim}>{"  ▸ "}<span fg={theme.fg}>{streamBuf || "…"}</span></text>
          </box>
        )}
      </scrollbox>
      <box flexDirection="row" height={3} border borderColor={theme.aiAccent} paddingLeft={1} paddingRight={1}>
        <text fg={pending ? theme.fgFaint : theme.aiAccent}>{`› `}</text>
        <input
          ref={inputRef}
          flexGrow={1}
          focused
          placeholder={pending ? "thinking…" : `ask about ${domain.name}…`}
          backgroundColor={theme.bgPanel}
          textColor={theme.fg}
          onInput={(() => setEmbeddedInputActive?.(true)) as any}
          onSubmit={((next: string) => {
            setEmbeddedInputActive?.(false);
            send(next);
          }) as any}
        />
      </box>
    </box>
  );
}

const GROUP_LABEL: Record<string, string> = {
  op: "ops skills",
  flow: "workflow skills",
  task: "task skills",
  other: "other skills",
};

const GROUP_ORDER = ["op", "flow", "task", "other"] as const;

function SkillsList({
  skills,
  selectedIdx,
  onPick,
  apps,
  domainName,
}: {
  skills: { id: string; title: string }[];
  selectedIdx: number;
  onPick: (i: number) => void;
  apps: AppSkill[];
  domainName: string;
}) {
  const linkedApps = apps.filter((a) => a.domains.includes(domainName));
  if (skills.length === 0 && linkedApps.length === 0) {
    return <text fg={theme.fgDim}>No skills for this domain.</text>;
  }

  // skills already arrive sorted by vault.ts skillRank (group-major). Walk
  // them and emit a section header each time the group changes.
  const sections: Record<string, { idx: number; skill: { id: string; title: string } }[]> = {
    op: [],
    flow: [],
    task: [],
    other: [],
  };
  skills.forEach((skill, idx) => {
    sections[skillGroup(skill.id)]!.push({ idx, skill });
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.fgDim}>
        {skills.length} skills  ·  {linkedApps.length} linked apps  ·  ↑/↓ navigate  ·  enter to run
      </text>
      <text> </text>
      <scrollbox flexGrow={1} scrollY>
        {GROUP_ORDER.map((g) => {
          const rows = sections[g];
          if (!rows || rows.length === 0) return null;
          return (
            <box key={`group-${g}`} flexDirection="column">
              <text fg={theme.goldDim}>
                ▸ {GROUP_LABEL[g]}  ({rows.length})
              </text>
              {rows.map(({ idx, skill }) => {
                const active = idx === selectedIdx;
                const fg = active ? theme.selFg : theme.fg;
                const bg = active ? theme.selBg : theme.bg;
                const pointer = active ? "› " : "  ";
                const titleFg = active ? theme.selFg : theme.fgDim;
                return (
                  <box
                    key={skill.id}
                    flexDirection="row"
                    backgroundColor={bg}
                    height={1}
                    onMouseDown={() => onPick(idx)}
                  >
                    <text fg={fg} bg={bg}>{pointer}{skill.id}</text>
                    <text fg={titleFg} bg={bg}>  ·  {skill.title}</text>
                  </box>
                );
              })}
              <text> </text>
            </box>
          );
        })}
        {linkedApps.length > 0 && (
          <box flexDirection="column">
            <text fg={theme.goldDim}>
              ▸ apps available for {domainName}  ({linkedApps.length})
            </text>
            {linkedApps.map((a) => {
              const fg = theme.fg;
              const titleFg = theme.fgDim;
              const mark = a.community ? "★" : " ";
              return (
                <box key={`app-${a.id}`} flexDirection="row" height={1}>
                  <text fg={fg}>  {mark} {a.id}</text>
                  <text fg={titleFg}>  ·  {a.title}</text>
                </box>
              );
            })}
          </box>
        )}
      </scrollbox>
    </box>
  );
}
