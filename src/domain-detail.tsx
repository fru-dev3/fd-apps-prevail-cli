import { theme } from "./theme.ts";
import { formatRelativeTime, readDomainView, type Domain, type ViewKey } from "./vault.ts";
import { renderMarkdownLines } from "./markdown-lite.tsx";

interface Props {
  domain: Domain | null;
  view: ViewKey;
  skillIdx: number;
  onPickTab: (i: number) => void;
  onPickSkill: (i: number) => void;
}

const TABS: { key: ViewKey; label: string }[] = [
  { key: "state", label: "state" },
  { key: "loops", label: "open items" },
  { key: "quickstart", label: "quickstart" },
  { key: "prompts", label: "prompts" },
  { key: "skills", label: "skills" },
];

export function DomainDetail({ domain, view, skillIdx, onPickTab, onPickSkill }: Props) {
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
      <TabBar activeKey={view} onPick={onPickTab} />
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        {view === "skills" ? (
          <SkillsList
            skills={domain.skills}
            selectedIdx={skillIdx}
            onPick={onPickSkill}
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

function TabBar({ activeKey, onPick }: { activeKey: ViewKey; onPick: (i: number) => void }) {
  return (
    <box
      flexDirection="row"
      height={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bg}
    >
      {TABS.map((tab, i) => {
        const active = tab.key === activeKey;
        const fg = active ? theme.gold : theme.fgDim;
        const label = active ? `[${tab.label}]` : ` ${tab.label} `;
        return (
          <box key={tab.key} flexDirection="row" onMouseDown={() => onPick(i)}>
            <text fg={fg}>{label}</text>
            <text fg={theme.bg}>{i < TABS.length - 1 ? "  " : ""}</text>
          </box>
        );
      })}
    </box>
  );
}

function SkillsList({
  skills,
  selectedIdx,
  onPick,
}: {
  skills: { id: string; title: string }[];
  selectedIdx: number;
  onPick: (i: number) => void;
}) {
  if (skills.length === 0) {
    return <text fg={theme.fgDim}>No skills for this domain.</text>;
  }
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.fgDim}>
        {skills.length} skills  ·  ↑/↓ navigate  ·  enter to run via claude
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
