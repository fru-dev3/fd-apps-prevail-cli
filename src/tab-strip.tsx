import { theme } from "./theme.ts";
import type { ViewKey } from "./vault.ts";

interface TabDef {
  key: ViewKey | "chat";
  label: string;
}

const TABS: TabDef[] = [
  { key: "state", label: "state" },
  { key: "loops", label: "open items" },
  { key: "quickstart", label: "quickstart" },
  { key: "prompts", label: "prompts" },
  { key: "skills", label: "skills" },
  { key: "chat", label: "chat" },
];

interface Props {
  domainName: string;
  activeView: ViewKey;
  inChat: boolean;
  onPickView: (i: number) => void;
  onPickChat: () => void;
}

export function TabStrip({ domainName, activeView, inChat, onPickView, onPickChat }: Props) {
  return (
    <box
      flexDirection="row"
      height={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bg}
    >
      <text fg={theme.fgFaint}>{domainName.padEnd(12, " ").slice(0, 12)}</text>
      {TABS.map((tab, i) => {
        const isChatTab = tab.key === "chat";
        const active = isChatTab ? inChat : !inChat && tab.key === activeView;
        const fg = active ? theme.gold : theme.fgDim;
        const label = active ? `[${tab.label}]` : ` ${tab.label} `;
        const onClick = isChatTab ? onPickChat : () => onPickView(i);
        return (
          <box key={tab.key} flexDirection="row" onMouseDown={onClick}>
            <text fg={fg} attributes={active ? 1 : 0}>{label}</text>
            {i < TABS.length - 1 && <text fg={theme.fgFaint}>·</text>}
          </box>
        );
      })}
    </box>
  );
}
