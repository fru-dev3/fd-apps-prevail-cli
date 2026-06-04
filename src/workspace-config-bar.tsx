import { theme } from "./theme.ts";
import { openInFinder, shortenHome } from "./system.ts";
import {
  resolveResponseFramework,
  setResponseFramework,
} from "./config.ts";
import { FRAMEWORKS } from "./framework.ts";

interface Props {
  vaultPath: string;
  councilOn: boolean;
  onToggleCouncil: () => void;
  frameworkTick?: number;
  onFrameworkChange?: () => void;
  // Click handler for the "Chat" link — opens the full ChatPane for
  // the current domain/app. Without this, the workspace had no visible
  // entry point to chat (the chat tab in the strip is small and easy
  // to miss).
  onOpenChat?: () => void;
  // When set, the framework chip operates on the per-domain override
  // for that key (falling back to the global default for display when
  // no override exists). When unset, the chip mutates the global
  // default — same as before. Apps currently pass undefined; that's
  // intentional pending app-scope plumbing in cli-bridge/chat-pane.
  domainKey?: string;
}

// Visible at the top of every domain and connector workspace. Surfaces
// the things users were having to use slash commands for:
//   ▸ Chat           → open the full ChatPane for this domain/app
//   ▸ open vault     → spawns Finder / Explorer / xdg-open at the path
//   Council: ON/OFF  → toggles council mode for this surface
//   ◆ Framework: id  → cycles through NONE → BLUF → WIN → SCQA → …
//
// Render order is left-aligned so the row reads as one.
export function WorkspaceConfigBar({
  vaultPath,
  councilOn,
  onToggleCouncil,
  onFrameworkChange,
  onOpenChat,
  domainKey,
}: Props) {
  const { id: current, scope } = resolveResponseFramework(domainKey);
  const cycleFramework = () => {
    // Cycle order: none → bluf → win → scqa → sbar → ooda → proscons →
    // steelman → none. Wraps around. When `domainKey` is set, this
    // mutates only that domain's override (so cycling to "none" clears
    // the override and lets the domain fall back to the global default).
    const order = [null, ...FRAMEWORKS.map((f) => f.id)] as (string | null)[];
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length] ?? null;
    setResponseFramework(
      next as Parameters<typeof setResponseFramework>[0],
      domainKey,
    );
    onFrameworkChange?.();
  };
  const fwLabel = current
    ? FRAMEWORKS.find((f) => f.id === current)?.label ?? current
    : "none";
  // Tiny scope hint after the framework name so the user can tell at a
  // glance whether they're seeing the global default or a domain-only
  // override. `· domain` is the only non-default state worth shouting
  // about; `· global` would be visual noise on the common case.
  const scopeHint =
    domainKey && scope === "domain"
      ? " · domain"
      : domainKey && scope === "global"
        ? " · global"
        : "";

  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
      {onOpenChat && (
        <>
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={onOpenChat}
          >
            <text fg={theme.aiAccent} attributes={1}>▸ Chat</text>
          </box>
          <text fg={theme.border}>{"   │   "}</text>
        </>
      )}
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => openInFinder(vaultPath)}
      >
        <text fg={theme.aiAccent}>▸ </text>
        <text fg={theme.fgDim}>open vault  </text>
        <text fg={theme.fgFaint}>{shortenHome(vaultPath)}</text>
      </box>
      <text fg={theme.border}>{"   │   "}</text>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={onToggleCouncil}
      >
        <text fg={councilOn ? theme.gold : theme.fgDim} attributes={councilOn ? 1 : 0}>
          Council: {councilOn ? "ON" : "OFF"}
        </text>
      </box>
      <text fg={theme.border}>{"   │   "}</text>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={cycleFramework}
      >
        <text fg={current ? theme.aiAccent : theme.fgDim} attributes={current ? 1 : 0}>
          ◆ Framework: {fwLabel}
        </text>
        {scopeHint && (
          <text fg={scope === "domain" ? theme.gold : theme.fgFaint}>
            {scopeHint}
          </text>
        )}
      </box>
    </box>
  );
}
