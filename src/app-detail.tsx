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
        ) : app.community && !app.hasState && view === "state" ? (
          <scrollbox flexGrow={1} scrollY>
            {renderMarkdownLines(readAppSkill(app))}
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
