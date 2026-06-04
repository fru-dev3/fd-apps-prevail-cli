import { theme } from "./theme.ts";
import { openInFinder, shortenHome } from "./system.ts";
import {
  resolveResponseFramework,
  resolveResponseLens,
  setResponseFramework,
  setResponseLens,
} from "./config.ts";
import { FRAMEWORKS } from "./framework.ts";
import { LENSES, type LensSelection } from "./lens.ts";

interface Props {
  vaultPath: string;
  councilOn: boolean;
  onToggleCouncil: () => void;
  frameworkTick?: number;
  onFrameworkChange?: () => void;
  onOpenChat?: () => void;
  // When set, the framework AND lens chips operate on per-domain overrides
  // for that key (falling back to the global default for display when no
  // override exists). When unset, the chips mutate the global default.
  // Apps currently pass undefined; that's intentional pending app-scope
  // plumbing in cli-bridge / council-runner.
  domainKey?: string;
}

// Visible at the top of every domain and connector workspace. One row,
// left-to-right:
//   ▸ Chat            → open the full ChatPane
//   ▸ open vault      → spawn Finder / Explorer / xdg-open at the path
//   Council: ON/OFF   → toggles council for this surface
//   ◆ Framework: id   → cycles BLUF → WIN → SCQA → … (output shape)
//   ◇ Lens: id        → cycles first-principles → … → all → off (angle of attack)
//
// Framework and Lens are independent axes — set both at once for the
// most structured output. Lens only fires when Council is ON; it's still
// shown when council is off so the user can pre-set it.
export function WorkspaceConfigBar({
  vaultPath,
  councilOn,
  onToggleCouncil,
  onFrameworkChange,
  onOpenChat,
  domainKey,
}: Props) {
  const { id: currentFw, scope: fwScope } = resolveResponseFramework(domainKey);
  const cycleFramework = () => {
    const order = [null, ...FRAMEWORKS.map((f) => f.id)] as (string | null)[];
    const idx = order.indexOf(currentFw);
    const next = order[(idx + 1) % order.length] ?? null;
    setResponseFramework(
      next as Parameters<typeof setResponseFramework>[0],
      domainKey,
    );
    onFrameworkChange?.();
  };
  const fwLabel = currentFw
    ? FRAMEWORKS.find((f) => f.id === currentFw)?.label ?? currentFw
    : "none";
  const fwScopeHint =
    domainKey && fwScope === "domain"
      ? " · domain"
      : domainKey && fwScope === "global"
        ? " · global"
        : "";

  const { sel: currentLens, scope: lensScope } = resolveResponseLens(domainKey);
  const cycleLens = () => {
    // Cycle order: off → first-principles → outsider → contrarian →
    // expansionist → executor → all → off. "all" is the fanout mode and
    // sits at the end so the user has to deliberately land on it.
    const order: LensSelection[] = [
      null,
      ...LENSES.map((l) => l.id as LensSelection),
      "all",
    ];
    const idx = order.findIndex((s) => s === currentLens);
    const next = order[(idx + 1) % order.length] ?? null;
    setResponseLens(next, domainKey);
    onFrameworkChange?.(); // re-uses the same redraw tick — both chips re-render
  };
  const lensLabel = currentLens === null
    ? "off"
    : currentLens === "all"
      ? "all (×5)"
      : LENSES.find((l) => l.id === currentLens)?.label ?? currentLens;
  const lensScopeHint =
    domainKey && lensScope === "domain"
      ? " · domain"
      : domainKey && lensScope === "global"
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
        <text fg={currentFw ? theme.aiAccent : theme.fgDim} attributes={currentFw ? 1 : 0}>
          ◆ Framework: {fwLabel}
        </text>
        {fwScopeHint && (
          <text fg={fwScope === "domain" ? theme.gold : theme.fgFaint}>
            {fwScopeHint}
          </text>
        )}
      </box>
      <text fg={theme.border}>{"   │   "}</text>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={cycleLens}
      >
        <text
          fg={currentLens ? theme.aiAccent : theme.fgDim}
          attributes={currentLens ? 1 : 0}
        >
          ◇ Lens: {lensLabel}
        </text>
        {lensScopeHint && (
          <text fg={lensScope === "domain" ? theme.gold : theme.fgFaint}>
            {lensScopeHint}
          </text>
        )}
        {currentLens && !councilOn && (
          <text fg={theme.fgFaint}> · needs council</text>
        )}
      </box>
    </box>
  );
}
