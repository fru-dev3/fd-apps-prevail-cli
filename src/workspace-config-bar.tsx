import { theme } from "./theme.ts";
import { openInFinder, shortenHome } from "./system.ts";
import {
  readResponseFramework,
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
}

// Visible at the top of every domain and connector workspace. Surfaces
// the three things users were having to use slash commands for:
//   📂 Open Vault       → spawns Finder / Explorer / xdg-open at the path
//   Council: ON/OFF   → toggles council mode for this surface
//   ◆ Framework: <id>   → cycles through NONE → BLUF → WIN → SCQA → …
//
// Render order is left-aligned so the trio reads as one row.
export function WorkspaceConfigBar({
  vaultPath,
  councilOn,
  onToggleCouncil,
  onFrameworkChange,
  onOpenChat,
}: Props) {
  const current = readResponseFramework();
  const cycleFramework = () => {
    // Cycle order: none → bluf → win → scqa → sbar → ooda → proscons →
    // steelman → none. Wrap around. Single click changes it; no picker
    // overlay needed.
    const order = [null, ...FRAMEWORKS.map((f) => f.id)] as (string | null)[];
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length] ?? null;
    setResponseFramework(next as Parameters<typeof setResponseFramework>[0]);
    onFrameworkChange?.();
  };
  const fwLabel = current
    ? FRAMEWORKS.find((f) => f.id === current)?.label ?? current
    : "none";

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
      </box>
    </box>
  );
}
