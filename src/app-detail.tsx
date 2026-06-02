import type React from "react";
import { theme } from "./theme.ts";
import {
  formatRelativeTime,
  readAppSkill,
  readAppView,
  type AppSkill,
  type ViewKey,
} from "./vault.ts";
import { renderMarkdownLines } from "./markdown-lite.tsx";

interface Props {
  app: AppSkill;
  view: ViewKey;
  skillIdx: number;
  onPickSkill: (i: number) => void;
  topBar?: React.ReactNode;
}

export function AppDetail({ app, view, skillIdx, onPickSkill, topBar }: Props) {
  const updated = formatRelativeTime(app.stateMtime);
  const domainsLabel =
    app.domains.length > 0 ? `used in ${app.domains.join(", ")}` : "no linked domains";
  const communityMark = app.community ? "★ community  ·  " : "";

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title={` ${app.id}  ·  ${app.title} `}
      titleAlignment="left"
      bottomTitle={` ${communityMark}${domainsLabel}  ·  updated ${updated}  ·  skills ${app.skills.length} `}
      bottomTitleAlignment="left"
    >
      {topBar}
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        {view === "skills" ? (
          <SkillsList
            skills={app.skills}
            selectedIdx={skillIdx}
            onPick={onPickSkill}
            appId={app.id}
          />
        ) : view === "state" ? (
          // For the state tab, render the connector overview: connection
          // method + health, available skills count, linked domains, plus
          // whatever vault state/skill content the app already has. This
          // is the "show me the connection + skills + domains in one
          // glance" view from the architecture refactor.
          <scrollbox flexGrow={1} scrollY>
            <ConnectorOverview app={app} />
            {app.community && !app.hasState
              ? renderMarkdownLines(readAppSkill(app))
              : renderMarkdownLines(readAppView(app, view))}
          </scrollbox>
        ) : (
          <scrollbox flexGrow={1} scrollY>
            {renderMarkdownLines(readAppView(app, view))}
          </scrollbox>
        )}
      </box>
    </box>
  );
}

function SkillsList({
  skills,
  selectedIdx,
  onPick,
  appId,
}: {
  skills: { id: string; title: string }[];
  selectedIdx: number;
  onPick: (i: number) => void;
  appId: string;
}) {
  if (skills.length === 0) {
    return <text fg={theme.fgDim}>No skills for {appId}.</text>;
  }
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.fgDim}>
        {skills.length} skills  ·  ↑/↓ navigate  ·  enter to run
      </text>
      <text> </text>
      <scrollbox flexGrow={1} scrollY>
        {skills.map((skill, i) => {
          const active = i === selectedIdx;
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
              onMouseDown={() => onPick(i)}
            >
              <text fg={fg} bg={bg}>{pointer}{skill.id}</text>
              <text fg={titleFg} bg={bg}>  ·  {skill.title}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

// Top-of-state view for an app/connector: 4 sections (Connection, Skills,
// Domains, Chat hint) that surface the metadata up front before the body
// content. This is the "click on US Bank, see how it connects + what
// skills it exposes + which domains consume it" view.
function ConnectorOverview({ app }: { app: AppSkill }) {
  const integrationLabel: Record<string, string> = {
    api: "REST/GraphQL API · stored key",
    oauth: "OAuth · token refresh",
    browser: "browser automation · cookie/Playwright",
    mcp: "MCP server · wrapped tool",
    manual: "manual · drop files in watched folder",
  };
  const integration = app.integration ?? "manual";
  const statusGlyph =
    app.status === "connected" ? "☑ connected" :
    app.status === "error" ? "☒ error" :
    app.status === "expired" ? "☒ auth expired" :
    "☐ not configured";
  const statusFg =
    app.status === "connected" ? theme.ok :
    app.status === "error" || app.status === "expired" ? theme.warn :
    theme.fgDim;
  const lastSync = app.lastSuccessTs
    ? formatRelativeTime(app.lastSuccessTs)
    : "never";
  return (
    <box flexDirection="column">
      <text fg={theme.gold} attributes={1}>▸ Connection</text>
      <text fg={theme.fgDim}>{"  type:   "}<span fg={theme.fg}>{integrationLabel[integration]}</span></text>
      <text fg={theme.fgDim}>{"  status: "}<span fg={statusFg}>{statusGlyph}</span><span fg={theme.fgFaint}>{`   ·   last sync ${lastSync}`}</span></text>
      {app.lastError && (
        <text fg={theme.fgDim}>{"  error:  "}<span fg={theme.warn}>{app.lastError}</span></text>
      )}
      {app.connectionNotes && (
        <>
          <text> </text>
          <text fg={theme.fgDim}>{app.connectionNotes.split("\n").slice(0, 6).join("\n")}</text>
        </>
      )}
      <text> </text>
      <text fg={theme.gold} attributes={1}>▸ Skills  ({app.skills.length})</text>
      {app.skills.length === 0 ? (
        <text fg={theme.fgFaint}>{"  no skills defined for this connector yet"}</text>
      ) : (
        app.skills.slice(0, 5).map((s) => (
          <text key={s.id} fg={theme.fgDim}>
            {"  · "}<span fg={theme.fg}>{s.id}</span>{"  ·  "}<span fg={theme.fgFaint}>{s.title}</span>
          </text>
        ))
      )}
      {app.skills.length > 5 && (
        <text fg={theme.fgFaint}>{`  · +${app.skills.length - 5} more — see Skills tab`}</text>
      )}
      <text> </text>
      <text fg={theme.gold} attributes={1}>▸ Linked domains  ({app.domains.length})</text>
      {app.domains.length === 0 ? (
        <text fg={theme.fgFaint}>{"  not wired into any life domain — set domains in manifest.json"}</text>
      ) : (
        <text fg={theme.fg}>{"  " + app.domains.join("  ·  ")}</text>
      )}
      <text> </text>
      <text fg={theme.gold} attributes={1}>▸ Chat with this connector</text>
      <text fg={theme.fgFaint}>{"  press enter (or c) to open a chat scoped to this connector"}</text>
      <text> </text>
      <text fg={theme.border}>{"─".repeat(60)}</text>
      <text> </text>
    </box>
  );
}
