import { useState } from "react";
import { theme } from "./theme.ts";
import type { ViewKey } from "./vault.ts";
import { MODEL_QUICKPICKS, type AvailableCli, type CliHealth, type CliKind } from "./cli-bridge.ts";

interface TabDef {
  key: ViewKey | "chat";
  label: string;
}

const TABS: TabDef[] = [
  { key: "chat", label: "chat" },
  { key: "state", label: "state" },
  { key: "quickstart", label: "quick start" },
  { key: "prompts", label: "prompts" },
  { key: "skills", label: "skills" },
];

const EDITABLE_VIEWS: ReadonlySet<ViewKey | "chat"> = new Set([
  "state",
  "quickstart",
  "prompts",
]);

// Optional bundle: when present, the strip renders cli/model/council chips in
// the SAME row as the tabs. Pass this only when the chat is the active pane —
// vault-view modes (state/quickstart/etc.) don't need it.
export interface TabStripCliProps {
  clis: AvailableCli[];
  currentCli: CliKind;
  model: string;
  councilMode: boolean;
  cliHealth: Map<string, CliHealth | null>;
  onSwitchCli: (cli: CliKind) => void;
  onPickModel: (model: string) => void;
  onToggleCouncilMode: () => void;
  onOpenCouncilConfig: () => void;
}

interface Props {
  activeView: ViewKey;
  inChat: boolean;
  onPickView: (i: number) => void;
  onPickChat: () => void;
  onEdit?: () => void;
  cli?: TabStripCliProps;
}

export function TabStrip({ activeView, inChat, onPickView, onPickChat, onEdit, cli }: Props) {
  const showEdit = !inChat && EDITABLE_VIEWS.has(activeView) && onEdit;
  return (
    <box
      flexDirection="row"
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.bg}
    >
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
      {cli && inChat && (
        <>
          <text fg={theme.fgFaint}>{"   "}</text>
          <CliChips
            clis={cli.clis}
            currentCli={cli.currentCli}
            cliHealth={cli.cliHealth}
            onSwitchCli={cli.onSwitchCli}
          />
        </>
      )}
      <box flexGrow={1} />
      {showEdit && (
        <box flexDirection="row" onMouseDown={onEdit}>
          <text fg={theme.goldDim}>✎ edit</text>
        </box>
      )}
      {cli && inChat && (
        <>
          <box
            flexDirection="row"
            onMouseDown={cli.onToggleCouncilMode}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={cli.councilMode ? theme.selBg : theme.bg}
          >
            <text
              fg={cli.councilMode ? theme.goldBright : theme.gold}
              attributes={cli.councilMode ? 1 : 0}
            >
              {cli.councilMode ? "▣ Council ON" : "⚖ Council"}
            </text>
          </box>
          <text fg={theme.fgFaint}> </text>
          <box
            flexDirection="row"
            onMouseDown={cli.onOpenCouncilConfig}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.bgPanel}
          >
            <text fg={theme.gold}>⚙ configure</text>
          </box>
        </>
      )}
    </box>
  );
}

function CliChips({
  clis,
  currentCli,
  cliHealth,
  onSwitchCli,
}: {
  clis: AvailableCli[];
  currentCli: CliKind;
  cliHealth: Map<string, CliHealth | null>;
  onSwitchCli: (cli: CliKind) => void;
}) {
  return (
    <>
      {clis.map((c) => {
        const active = c.kind === currentCli;
        const fg = active ? theme.gold : theme.fgDim;
        // Inline health glyph next to each CLI label — ✓ ready, ⚠ failed
        // probe, · still probing. Replaces the old top-of-screen banner row.
        const h = cliHealth.get(c.kind);
        const glyph =
          h === null || h === undefined ? "·" : h.ok ? "✓" : "⚠";
        const glyphFg =
          h === null || h === undefined
            ? theme.fgFaint
            : h.ok
              ? theme.ok
              : theme.warn;
        return (
          <box
            key={c.kind}
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={active ? theme.selBg : theme.bg}
            onMouseDown={() => {
              if (!active) onSwitchCli(c.kind);
            }}
          >
            <text fg={glyphFg}>{glyph} </text>
            <text fg={fg} attributes={active ? 1 : 0}>
              {active ? `▸${c.label}` : c.label}
            </text>
          </box>
        );
      })}
    </>
  );
}

// Dropdown — collapsed by default to one chip showing the active model.
// Click the chip to expand the alternatives inline; pick one to apply + close.
// Default selection always shows literal "default" so the user knows nothing is
// overridden.
function ModelChips({
  currentCli,
  model,
  onPickModel,
}: {
  currentCli: CliKind;
  model: string;
  onPickModel: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const picks = MODEL_QUICKPICKS[currentCli] ?? [];
  const isDefault = !model.trim();
  const currentLower = model.trim().toLowerCase();
  // Aliases ("opus", "sonnet", "haiku") resolve to the latest model in their
  // tier. Without the (latest) suffix users assume there's a missing version
  // number — make the alias semantics visible.
  const isAlias = (s: string) => !/-\d/.test(s) && s !== "default";
  const decorate = (id: string) => (isAlias(id) ? `${id} (latest)` : id);
  const currentLabel = isDefault ? "default" : decorate(model.trim());
  // Build the list of alternatives the user hasn't currently selected.
  const alts = ["default", ...picks].filter((id) => {
    if (id === "default") return !isDefault;
    return id !== currentLower && !currentLower.includes(id);
  });
  const pick = (id: string) => {
    onPickModel(id);
    setOpen(false);
  };
  return (
    <>
      <Chip
        label={`${currentLabel} ${open ? "▴" : "▾"}`}
        active
        onClick={() => setOpen((v) => !v)}
      />
      {open &&
        alts.map((id) => (
          <Chip
            key={id}
            label={decorate(id)}
            active={false}
            onClick={() => pick(id)}
          />
        ))}
    </>
  );
}

function Chip({
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
      <text fg={fg} bg={bg} attributes={active ? 1 : 0}>
        {active ? `▸${label}` : label}
      </text>
    </box>
  );
}
