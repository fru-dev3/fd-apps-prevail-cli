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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Read the first N lines that look like prompts out of PROMPTS.md for a
// domain. Each prompt is one line that ends in "?", starts with a verb,
// or begins with "•" / "-" / a numbered bullet. If PROMPTS.md is missing
// or empty, returns the generic fallback so the empty state always has
// SOMETHING to click. Pure read; no side effects.
function suggestionsForDomain(domain: Domain): string[] {
  const file = join(domain.path, "PROMPTS.md");
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8");
      const candidates = raw
        .split("\n")
        .map((l) => l.replace(/^\s*[-•\d.)]+\s*/, "").trim())
        .filter((l) => l.length > 8 && l.length < 140)
        .filter((l) => /\?$/.test(l) || /^(what|how|when|why|where|who|tell|walk|review|summarize|list|show|explain|compare|find|check|track|log|plan|draft|write)\b/i.test(l));
      if (candidates.length >= 3) return candidates.slice(0, 4);
    } catch {
      /* fall through to generic */
    }
  }
  // Fallback: generic but useful suggestions any domain can answer.
  return [
    `what should I work on first?`,
    `what's changed in state.md recently?`,
    `walk me through the open loops`,
    `summarize where this domain stands`,
  ];
}

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
  councilOn?: boolean;
  onToggleCouncil?: () => void;
  frameworkTick?: number;
  onFrameworkChange?: () => void;
  // Multi-select skills. The set is owned by app.tsx so it survives
  // tab clicks within a domain. Resets on domain change.
  selectedSkillIds?: Set<string>;
  onToggleSkill?: (skillId: string) => void;
}

export function DomainDetail({ domain, view, skillIdx, apps, onPickSkill, topBar, setEmbeddedInputActive, showChat, councilOn, onToggleCouncil, frameworkTick, onFrameworkChange, selectedSkillIds, onToggleSkill }: Props) {
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
      paddingTop={1}
      paddingBottom={1}
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
          <DomainChat
            domain={domain}
            setEmbeddedInputActive={setEmbeddedInputActive}
            selectedSkills={domain.skills.filter((s) => selectedSkillIds?.has(s.id))}
          />
        ) : view === "skills" ? (
          <SkillsList
            skills={domain.skills}
            selectedIdx={skillIdx}
            onPick={onPickSkill}
            apps={apps}
            domainName={domain.name}
            selectedSkillIds={selectedSkillIds}
            onToggleSkill={onToggleSkill}
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
function DomainChat({ domain, setEmbeddedInputActive, selectedSkills }: { domain: Domain; setEmbeddedInputActive?: (v: boolean) => void; selectedSkills?: { id: string; title: string }[] }) {
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

  // CRITICAL: claim the keyboard the MOMENT this chat mounts, not after
  // the first keystroke. Setting it on first onInput meant the first
  // character the user typed went through the global handler instead of
  // the input — single-letter keys like j/k/q/s/h/n/r/e navigated the
  // sidebar before the input even saw the keypress. With this effect,
  // any letter typed while the embedded chat is rendered goes straight
  // to the input.
  useEffect(() => {
    setEmbeddedInputActive?.(true);
    return () => setEmbeddedInputActive?.(false);
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
    // If skills were selected in the skills tab, include them as
    // <context> so the LLM knows what tools/playbooks to apply.
    const skillsBlock =
      selectedSkills && selectedSkills.length > 0
        ? `\n\n<selected_skills>\nThe user pre-selected these ${domain.name} skills as relevant context:\n${selectedSkills
            .map((s) => `  - ${s.id}: ${s.title}`)
            .join(
              "\n",
            )}\nRead their definitions under ${domain.path}/skills/ and apply them where relevant.\n</selected_skills>`
        : "";
    const prompt = `You are helping with the "${domain.name}" life domain in a personal-AI cockpit called prevAIl. The vault domain folder is ${domain.path}. Start by reading state.md if you need context. Use ONLY this domain's folder — do not read other domains or connectors.${skillsBlock}\n\nUser question: ${trimmed}`;
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
        <text fg={theme.aiAccent} attributes={1}>Chat with {domain.name}</text>
        <text fg={theme.fgFaint}>{`   ·   ${cli?.label ?? "no engine"}   ·   scope: this domain's vault folder`}</text>
      </box>
      <scrollbox flexGrow={1} scrollY>
        {history.length === 0 && !pending && (
          <>
            <text fg={theme.fgFaint}>{`  ask anything about ${domain.name}. suggestions${existsSync(join(domain.path, "PROMPTS.md")) ? " (from PROMPTS.md)" : ""}:`}</text>
            {suggestionsForDomain(domain).map((s, i) => (
              <text key={i} fg={theme.fgDim}>{`    › ${s}`}</text>
            ))}
            {selectedSkills && selectedSkills.length > 0 && (
              <>
                <text> </text>
                <text fg={theme.aiAccent}>{`  ◆ ${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"} pre-loaded as context:`}</text>
                {selectedSkills.map((s) => (
                  <text key={s.id} fg={theme.fgDim}>{`    · ${s.id} — ${s.title}`}</text>
                ))}
              </>
            )}
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
  selectedSkillIds,
  onToggleSkill,
}: {
  skills: { id: string; title: string }[];
  selectedIdx: number;
  onPick: (i: number) => void;
  apps: AppSkill[];
  domainName: string;
  selectedSkillIds?: Set<string>;
  onToggleSkill?: (skillId: string) => void;
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
        {skills.length} skills  ·  {linkedApps.length} linked apps  ·  click to select/unselect  ·  selected ones go into chat context
      </text>
      <text fg={theme.fgFaint}>
        {selectedSkillIds && selectedSkillIds.size > 0
          ? `  ${selectedSkillIds.size} selected  →  open the chat tab to use them as context`
          : "  none selected yet"}
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
                const isSelected = selectedSkillIds?.has(skill.id) ?? false;
                const isCursor = idx === selectedIdx;
                // Two states overlay: selection (☑/☐ glyph + persistent
                // highlight) and keyboard-cursor (› pointer + bg).
                const fg = isSelected ? theme.aiAccent : isCursor ? theme.selFg : theme.fg;
                const bg = isCursor ? theme.selBg : theme.bg;
                const checkbox = isSelected ? "✓" : "·";
                const pointer = isCursor ? "›" : " ";
                const titleFg = isCursor ? theme.selFg : isSelected ? theme.aiAccent : theme.fgDim;
                return (
                  <box
                    key={skill.id}
                    flexDirection="row"
                    backgroundColor={bg}
                    height={1}
                    onMouseDown={() => {
                      onPick(idx);
                      onToggleSkill?.(skill.id);
                    }}
                  >
                    <text fg={fg} bg={bg}>{pointer} {checkbox} {skill.id}</text>
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
