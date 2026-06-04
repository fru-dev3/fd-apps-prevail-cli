import { theme } from "./theme.ts";
import { openInFinder } from "./system.ts";
import {
  readAutoCouncil,
  readCheckpoint,
  readSerendipity,
  readWebAccess,
  resolveResponseFramework,
  resolveResponseLens,
  setAutoCouncil,
  setCheckpoint,
  setResponseFramework,
  setResponseLens,
  setSerendipity,
  setWebAccess,
} from "./config.ts";
import type { AutoCouncilMode } from "./config.ts";
import { FRAMEWORKS } from "./framework.ts";
import { LENSES, type LensSelection } from "./lens.ts";
import { Chip } from "./chip.tsx";

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
  // Scope hint removed — the user found "· domain" confusing
  // ("why is the text domain here?"). The user already knows the scope
  // by where they clicked: workspace bar = per-domain, top bar = global.
  const { id: currentFw } = resolveResponseFramework(domainKey);
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

  const { sel: currentLens } = resolveResponseLens(domainKey);
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

  // Serendipity — when ON, every turn fires a second small call after
  // the main reply asking for one non-obvious adjacent angle. Lands as
  // a dim ◉ bubble. OFF by default — opt-in per domain.
  const serendipityOn = readSerendipity(domainKey);
  const toggleSerendipity = () => {
    setSerendipity(!serendipityOn, domainKey);
    onFrameworkChange?.();
  };

  // Auto-council mode — cycles off → suggest → auto → off.
  // "suggest" = passive YES-bubble appended to transcript on YES.
  // "auto"    = block-and-route to council on YES (latency on every send).
  // Glyph: ◐ (half-circle) suggests partial / hint mode.
  const autoMode = readAutoCouncil(domainKey);
  const cycleAuto = () => {
    const order: AutoCouncilMode[] = ["off", "suggest", "auto"];
    const idx = order.indexOf(autoMode);
    const next = order[(idx + 1) % order.length]!;
    setAutoCouncil(next, domainKey);
    onFrameworkChange?.();
  };

  const sep = (
    <text fg={theme.border}>{"   │   "}</text>
  );

  // All chip rendering is delegated to the shared <Chip /> component
  // (src/chip.tsx) so the opentui-safe pattern lives in exactly one
  // place. Council pops gold when ON (its activeFg override); every
  // other chip pops aiAccent (the Chip default). Original rendering
  // and spacing rationale (NBSP value prefix, two-text-per-chip,
  // two-tone coloring) moved to chip.tsx as a header comment block.

  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
      <Chip
        label="⚖ Council:"
        value={councilOn ? "ON" : "OFF"}
        active={councilOn}
        activeFg={theme.gold}
        onMouseDown={onToggleCouncil}
      />
      {sep}
      <Chip
        label="◆ Framework:"
        value={fwLabel}
        active={!!currentFw}
        onMouseDown={cycleFramework}
      />
      <Chip
        label="◇ Lens:"
        value={lensLabel}
        active={!!currentLens}
        onMouseDown={cycleLens}
      />
      <Chip
        label="⬡ Web:"
        value={webAllow ? "ON" : "OFF"}
        active={webAllow}
        onMouseDown={cycleWeb}
      />
      <Chip
        label="▣ Save:"
        value={checkpointOn ? "ON" : "OFF"}
        active={checkpointOn}
        onMouseDown={toggleCheckpoint}
      />
      <Chip
        label="◉ Serendipity:"
        value={serendipityOn ? "ON" : "OFF"}
        active={serendipityOn}
        onMouseDown={toggleSerendipity}
      />
      <Chip
        label="◐ Auto:"
        value={autoMode.toUpperCase()}
        active={autoMode !== "off"}
        onMouseDown={cycleAuto}
      />
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
