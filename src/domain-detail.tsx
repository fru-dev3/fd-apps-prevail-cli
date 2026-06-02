import type React from "react";
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

interface Props {
  domain: Domain | null;
  view: ViewKey;
  skillIdx: number;
  apps: AppSkill[];
  onPickSkill: (i: number) => void;
  topBar?: React.ReactNode;
}

export function DomainDetail({ domain, view, skillIdx, apps, onPickSkill, topBar }: Props) {
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
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        {view === "skills" ? (
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
