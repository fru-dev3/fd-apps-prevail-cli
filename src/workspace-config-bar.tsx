import { theme } from "./theme.ts";
import { openInFinder } from "./system.ts";
import {
  readCheckpoint,
  readWebAccess,
  resolveResponseFramework,
  resolveResponseLens,
  setCheckpoint,
  setResponseFramework,
  setResponseLens,
  setWebAccess,
} from "./config.ts";
import { FRAMEWORKS } from "./framework.ts";
import { LENSES, type LensSelection } from "./lens.ts";

interface Props {
  vaultPath: string;
  councilOn: boolean;
  onToggleCouncil: () => void;
  frameworkTick?: number;
  onFrameworkChange?: () => void;
  // Edit button shows up only when the caller passes a handler — usually
  // when the current tab is editable (state / quickstart / prompts).
  // In chat mode, leave undefined; in workspace mode, pass the editor
  // opener so the user can jump into $EDITOR from the same row.
  onEdit?: () => void;
  // When set, the framework AND lens chips operate on per-domain
  // overrides for that key. Falls back to the global default for
  // display when no override exists.
  domainKey?: string;
}

// The single config row that sits at the BOTTOM of the content area in
// BOTH chat mode AND workspace mode. Same shape, same position, no
// duplication with the TabStrip above. Reads:
//
//   ⚖ Council ON   ◆ Framework: SCQA   ◇ Lens: none   ⬡ Web: on   ▣ Save: on   ▸ vault   ✎ edit
//
// What lives here, and why:
//   ⚖ Council     — toggle for THIS surface (per-domain).
//   ◆ Framework  — per-domain override; cycles on click.
//   ◇ Lens       — per-domain override for the cognitive lens fanout.
//   ⬡ Web        — global web-access toggle (allow/deny). Promoted out
//                   of the Tools panel because the user flips it often.
//   ▣ Save       — per-domain checkpoint toggle. ON (default) writes
//                   the full prompt + reply to <domain>/_log/ on every
//                   turn so the user has a complete transcript.
//   ▸ vault      — quick Finder/xdg-open at the active domain path.
//   ✎ edit       — opens $EDITOR on the active markdown tab when applicable.
//
// What's intentionally NOT here:
//   - Chat link: the [chat] tab in the TabStrip already does this.
//   - Configure: it's in the global defaults block in the banner (one place).
//   - CLI chips: they're in the TabStrip row, attached to nav tabs.
export function WorkspaceConfigBar({
  vaultPath,
  councilOn,
  onToggleCouncil,
  onFrameworkChange,
  onEdit,
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
  // Scope hint removed — the user found "· domain" confusing
  // ("why is the text domain here?"). The user already knows the scope
  // by where they clicked: workspace bar = per-domain, top bar = global.
  void fwScope;

  const { sel: currentLens, scope: lensScope } = resolveResponseLens(domainKey);
  const cycleLens = () => {
    const order: LensSelection[] = [
      null,
      ...LENSES.map((l) => l.id as LensSelection),
      "all",
    ];
    const idx = order.findIndex((s) => s === currentLens);
    const next = order[(idx + 1) % order.length] ?? null;
    setResponseLens(next, domainKey);
    onFrameworkChange?.();
  };
  const lensLabel = currentLens === null
    ? "none"
    : currentLens === "all"
      ? "all (×5)"
      : LENSES.find((l) => l.id === currentLens)?.label ?? currentLens;
  void lensScope;

  // Web access — global only (no per-domain override). The user wanted
  // the existing tools-panel toggle promoted to a clickable chip on the
  // ConfigBar so they can flip web on/off as easily as council/framework.
  // Click cycles allow ↔ deny.
  const webAllow = readWebAccess() === "allow";
  const cycleWeb = () => {
    setWebAccess(webAllow ? "deny" : "allow");
    onFrameworkChange?.();
  };

  // Checkpoint — when ON (default), every chat turn writes raw Q+A to
  // <domain>/_log/. Per-domain override available so a noisy domain
  // can be turned off without disabling globally.
  const checkpointOn = readCheckpoint(domainKey);
  const toggleCheckpoint = () => {
    setCheckpoint(!checkpointOn, domainKey);
    onFrameworkChange?.();
  };

  const sep = (
    <text fg={theme.border}>{"   │   "}</text>
  );

  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={onToggleCouncil}
      >
        <text fg={councilOn ? theme.gold : theme.fgDim} attributes={councilOn ? 1 : 0}>
          {councilOn ? "⚖ Council ON" : "⚖ Council off"}
        </text>
      </box>
      {sep}
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={cycleFramework}
      >
        <text fg={currentFw ? theme.aiAccent : theme.fgDim} attributes={currentFw ? 1 : 0}>
          ◆ Framework: {fwLabel}
        </text>
      </box>
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
      </box>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={cycleWeb}
      >
        <text fg={webAllow ? theme.aiAccent : theme.fgDim} attributes={webAllow ? 1 : 0}>
          ⬡ Web: {webAllow ? "on" : "off"}
        </text>
      </box>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={toggleCheckpoint}
      >
        <text fg={checkpointOn ? theme.aiAccent : theme.fgDim} attributes={checkpointOn ? 1 : 0}>
          ▣ Save: {checkpointOn ? "on" : "off"}
        </text>
      </box>
      <box flexGrow={1} />
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => openInFinder(vaultPath)}
      >
        <text fg={theme.aiAccent}>▸ vault</text>
      </box>
      {onEdit && (
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          onMouseDown={onEdit}
        >
          <text fg={theme.goldDim}>✎ edit</text>
        </box>
      )}
    </box>
  );
}
