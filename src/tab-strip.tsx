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
        // CRITICAL FIX: TABS includes "chat" at index 0 but VIEW_ORDER in
        // app.tsx is [state, quickstart, prompts, skills] — no chat. So
        // the TABS index for non-chat tabs is OFFSET BY 1 from VIEW_ORDER.
        // Pass (i - 1) so clicking "state" (TABS i=1) maps to VIEW_ORDER[0],
        // "skills" (TABS i=4) maps to VIEW_ORDER[3]. Without this, every
        // tab click selected the NEXT tab in the list, and "skills" went
        // off the end (showed nothing).
        const onClick = isChatTab ? onPickChat : () => onPickView(i - 1);
        return (
          <box key={tab.key} flexDirection="row" onMouseDown={onClick}>
            <text fg={fg} attributes={active ? 1 : 0}>{label}</text>
            {i < TABS.length - 1 && <text fg={theme.fgFaint}>·</text>}
          </box>
        );
      })}
      {cli && (
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
      {/* Council toggle + ◇ configure used to live here, but they
          duplicated the same controls in the WorkspaceConfigBar below.
          Council now lives only on the ConfigBar (per-surface); ◇
          configure stays in the global defaults block in the banner.
          The TabStrip is now nav + cli chips only — one job per row. */}
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
