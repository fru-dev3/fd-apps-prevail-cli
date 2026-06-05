import { theme } from "./theme.ts";
import { VERSION } from "./version.ts";
import { readResponseFramework, readResponseLens, readWebAccess } from "./config.ts";
import { FRAMEWORKS } from "./framework.ts";
import { getLens, type LensSelection } from "./lens.ts";
import { Chip } from "./chip.tsx";
import { useLayoutTier } from "./use-layout-tier.ts";

// Banner layout switches between three tiers based on terminal size:
//
//   wide    (≥ 150 cols AND ≥ 36 rows) — 9-row banner with ASCII PREVAIL
//                                        logo + full status column.
//                                        The original 1.6.2 layout.
//
//   medium  (≥ 100 cols AND ≥ 28 rows, but smaller than wide) — 7-row
//                                        banner: logo hidden, status
//                                        column gets the full width.
//                                        Fits 14"/15" MBPs and 24" 1080p
//                                        externals comfortably.
//
//   compact (smaller than medium) — 3-row banner: brand condensed to one
//                                   inline string, defaults and tools
//                                   each on a single row. Fits 13" MBP
//                                   fullscreen / split iTerm panes.
//
// Every clickable affordance survives at every tier — only layout
// changes.

interface Props {
  domainCount: number;
  totalLoops: number;
  appCount: number;
  vaultLabel: string;
  cliLabels: string[];
  activeChats: number;
  pendingChats: number;
  // Global toggles surfaced in the top-right of the banner so the user
  // can set defaults without opening a chat. Per-chat settings still
  // override these when present.
  globalCouncilOn?: boolean;
  onToggleGlobalCouncil?: () => void;
  onOpenCouncilConfig?: () => void;
  onOpenTools?: () => void;
  onOpenBenchmark?: () => void;
  frameworkTick?: number;
  onCycleFramework?: () => void;
  onCycleLens?: () => void;
  onCycleWeb?: () => void;
  cliHealthSummary?: { kind: string; label: string; ok: boolean | null; message?: string }[];
}

export function Branding({
  domainCount,
  totalLoops,
  appCount,
  vaultLabel,
  cliLabels,
  globalCouncilOn,
  onToggleGlobalCouncil,
  onOpenCouncilConfig,
  onOpenTools,
  onOpenBenchmark,
  onCycleFramework,
  onCycleLens,
  onCycleWeb,
  cliHealthSummary,
}: Props) {
  const now = new Date();
  const dateLabel = now
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();
  const yearLabel = now.getFullYear();
  const timeLabel = formatTime(now);
  const cliText =
    cliLabels.length > 0
      ? cliLabels.map((s) => s.toLowerCase()).join("  ·  ")
      : "no cli detected";

  const { tier } = useLayoutTier();

  if (tier === "compact") {
    return (
      <CompactBranding
        dateLabel={dateLabel}
        timeLabel={timeLabel}
        domainCount={domainCount}
        appCount={appCount}
        totalLoops={totalLoops}
        vaultLabel={vaultLabel}
        cliText={cliText}
        globalCouncilOn={globalCouncilOn}
        onToggleGlobalCouncil={onToggleGlobalCouncil}
        onOpenCouncilConfig={onOpenCouncilConfig}
        onOpenTools={onOpenTools}
        onOpenBenchmark={onOpenBenchmark}
        onCycleFramework={onCycleFramework}
        onCycleLens={onCycleLens}
        onCycleWeb={onCycleWeb}
        cliHealthSummary={cliHealthSummary}
      />
    );
  }

  // tier === "medium" → hide the giant ASCII logo so the status column
  // gets the full banner width. Drops height from 9 to 7. All status
  // rows (date / time / vault / defaults / tools / cli) survive
  // verbatim.
  const showLogo = tier === "wide";
  const bannerHeight = showLogo ? 9 : 7;

  return (
    <box
      flexDirection="column"
      height={bannerHeight}
      border={["bottom"]}
      borderColor={theme.gold}
      backgroundColor={theme.bg}
      paddingTop={showLogo ? 1 : 0}
      paddingBottom={0}
    >
      <box
        flexDirection="row"
        flexGrow={1}
        paddingLeft={showLogo ? 3 : 2}
        paddingRight={showLogo ? 3 : 2}
      >
        {showLogo && <BrandColumn />}
        {showLogo && <Separator />}
        <StatusColumn
          dateLabel={dateLabel}
          yearLabel={yearLabel}
          timeLabel={timeLabel}
          vaultLabel={vaultLabel}
          cliText={cliText}
          globalCouncilOn={globalCouncilOn}
          onToggleGlobalCouncil={onToggleGlobalCouncil}
          onOpenCouncilConfig={onOpenCouncilConfig}
          onOpenTools={onOpenTools}
          onOpenBenchmark={onOpenBenchmark}
          onCycleFramework={onCycleFramework}
          onCycleLens={onCycleLens}
          onCycleWeb={onCycleWeb}
          cliHealthSummary={cliHealthSummary}
          domainCount={domainCount}
          appCount={appCount}
          totalLoops={totalLoops}
          showBrandHeader={!showLogo}
        />
      </box>
    </box>
  );
}

// Compact (small-screen) banner — 3 rows instead of 9. Drops the giant
// ASCII PREVAIL logo and the vault path row; collapses defaults +
// configure/bench/tools onto two single-line chip rows; CLI health
// shares a row with the date. Every clickable affordance from the big
// banner is preserved.
function CompactBranding({
  dateLabel,
  timeLabel,
  domainCount,
  appCount,
  totalLoops,
  vaultLabel,
  cliText: _cliText,
  globalCouncilOn,
  onToggleGlobalCouncil,
  onOpenCouncilConfig,
  onOpenTools,
  onOpenBenchmark,
  onCycleFramework,
  onCycleLens,
  onCycleWeb,
  cliHealthSummary,
}: {
  dateLabel: string;
  timeLabel: string;
  domainCount: number;
  appCount: number;
  totalLoops: number;
  vaultLabel: string;
  cliText: string;
  globalCouncilOn?: boolean;
  onToggleGlobalCouncil?: () => void;
  onOpenCouncilConfig?: () => void;
  onOpenTools?: () => void;
  onOpenBenchmark?: () => void;
  onCycleFramework?: () => void;
  onCycleLens?: () => void;
  onCycleWeb?: () => void;
  cliHealthSummary?: { kind: string; label: string; ok: boolean | null; message?: string }[];
}) {
  const fw = readResponseFramework();
  const fwLabel = fw ? FRAMEWORKS.find((f) => f.id === fw)?.label ?? fw : "none";
  const lensSel: LensSelection = readResponseLens();
  const lensLabel =
    lensSel === null
      ? "none"
      : lensSel === "all"
        ? "all"
        : getLens(lensSel)?.label ?? "none";
  const webAllow = readWebAccess() === "allow";
  return (
    <box
      flexDirection="column"
      height={3}
      border={["bottom"]}
      borderColor={theme.gold}
      backgroundColor={theme.bg}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Row 1: brand + date + stats + cli health */}
      <box flexDirection="row" height={1}>
        <text fg={theme.gold} attributes={1}>{"◈ prevAIl"}</text>
        <text fg={theme.goldDim}>{` v${VERSION}`}</text>
        <text fg={theme.fgFaint}>{"  ·  "}</text>
        <text fg={theme.gold}>{dateLabel}</text>
        <text fg={theme.fgFaint}>{"  "}</text>
        <text fg={theme.fgDim}>{timeLabel}</text>
        <text fg={theme.fgFaint}>{"  ·  "}</text>
        <text fg={theme.fgDim}>
          <span fg={theme.fg}>{domainCount}</span>
          {"d "}
          <span fg={theme.fg}>{appCount}</span>
          {"a "}
          <span fg={totalLoops > 0 ? theme.warn : theme.fg}>{totalLoops}</span>
          {"o"}
        </text>
        <box flexGrow={1} />
        {cliHealthSummary && cliHealthSummary.length > 0 && (
          <box flexDirection="row">
            {cliHealthSummary.map((h) => {
              const glyph = h.ok === true ? "✓" : h.ok === false ? "!" : "·";
              const fgC = h.ok === true ? theme.ok : h.ok === false ? theme.warn : theme.fgDim;
              return (
                <box key={h.kind} flexDirection="row" paddingLeft={1}>
                  <text fg={fgC}>{glyph}</text>
                  <text fg={theme.fgDim}>{h.label.toLowerCase()}</text>
                </box>
              );
            })}
          </box>
        )}
      </box>
      {/* Row 2: defaults — every per-question knob */}
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>{"defaults"}</text>
        <Chip
          label="⚖ C:"
          value={globalCouncilOn ? "ON" : "OFF"}
          active={!!globalCouncilOn}
          activeFg={theme.gold}
          onMouseDown={onToggleGlobalCouncil}
          paddingLeft={1}
        />
        <Chip
          label="◆ F:"
          value={fwLabel}
          active={!!fw}
          onMouseDown={onCycleFramework}
        />
        <Chip
          label="◇ L:"
          value={lensLabel}
          active={!!lensSel}
          onMouseDown={onCycleLens}
        />
        <Chip
          label="⬡ W:"
          value={webAllow ? "ON" : "OFF"}
          active={webAllow}
          onMouseDown={onCycleWeb}
        />
        <box flexGrow={1} />
        <text fg={theme.fgFaint}>{vaultLabel}</text>
      </box>
      {/* Row 3: tools — open the heavy panels */}
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>{"tools   "}</text>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenCouncilConfig}>
          <text fg={theme.aiAccent}>◇ configure</text>
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenBenchmark}>
          <text fg={theme.aiAccent} attributes={1}>◈ bench</text>
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenTools}>
          <text fg={theme.aiAccent} attributes={1}>▸ tools</text>
        </box>
      </box>
    </box>
  );
}

// Custom uniform-width wordmark.
//
// The ANSI Shadow font we used before had organic letter widths — V tapers
// from wide-top to thin-bottom, A leads with a single space row, I is
// narrower than L, P's tail is thin. NO amount of mathematical padding
// fixes geometry that varies per row. Three rebuilds later, the user was
// still right: the spacing read uneven.
//
// New approach: every letter is a 5×5 block in its own identical bounding
// box. Spacing between letters is then mathematical certainty — each
// occupies exactly 5 cells, with a 1-cell gap between within a group and
// a 3-cell gap between groups. Whitespace inside a letter doesn't bleed
// into inter-letter space because every letter starts at the same column
// and ends at the same column on every row.
//
// Letters are tuned to read at terminal scale: bold strokes, no tapering,
// minimum 2-cell strokes so the cyan AI block carries weight against
// PREV+L in gold.

type Glyph = readonly [string, string, string, string, string, string, string];

// ANSI Shadow-style 3D letters. Plain blocks were too flat — the user
// wanted depth back. These use ╗ ║ ╝ box-drawing chars to imply
// dimension on the right side of each stroke, giving the wordmark
// the "letters cut from solid material" feel instead of a rectangle
// fill. Every letter is normalized to a 10-cell wide × 7-cell tall
// bounding box so spacing across the wordmark stays mathematically
// uniform — narrow letters (I) get whitespace padding inside their
// box rather than being squeezed.
const G: Record<string, Glyph> = {
  P: [
    "██████╗   ",
    "██╔══██╗  ",
    "██████╔╝  ",
    "██╔═══╝   ",
    "██║       ",
    "██║       ",
    "╚═╝       ",
  ],
  R: [
    "██████╗   ",
    "██╔══██╗  ",
    "██████╔╝  ",
    "██╔══██╗  ",
    "██║  ██║  ",
    "██║  ██║  ",
    "╚═╝  ╚═╝  ",
  ],
  E: [
    "███████╗  ",
    "██╔════╝  ",
    "█████╗    ",
    "██╔══╝    ",
    "██║       ",
    "███████╗  ",
    "╚══════╝  ",
  ],
  V: [
    "██╗   ██╗ ",
    "██║   ██║ ",
    "██║   ██║ ",
    "╚██╗ ██╔╝ ",
    " ╚████╔╝  ",
    "  ╚██╔╝   ",
    "   ╚═╝    ",
  ],
  A: [
    "  █████╗  ",
    " ██╔══██╗ ",
    " ███████╗ ",
    " ██╔══██║ ",
    " ██║  ██║ ",
    " ██║  ██║ ",
    " ╚═╝  ╚═╝ ",
  ],
  I: [
    "██████╗   ",
    "╚═██╔═╝   ",
    "  ██║     ",
    "  ██║     ",
    "  ██║     ",
    "██████╗   ",
    "╚═════╝   ",
  ],
  L: [
    "██╗       ",
    "██║       ",
    "██║       ",
    "██║       ",
    "██║       ",
    "███████╗  ",
    "╚══════╝  ",
  ],
};

// Single gap value, applied between every letter — within PREV, within AI,
// and across the group boundaries. The wordmark reads as ONE word
// (PREVAIL) with mathematically equal spacing throughout. The AI block
// still pops because of its cyan color, not because of extra whitespace.
const LETTER_GAP = " ";
const GROUP_GAP = LETTER_GAP;

// Compose a group from its letters with single-cell gaps. Returns 7 rows.
function compose(letters: readonly string[]): readonly string[] {
  const rows: string[] = ["", "", "", "", "", "", ""];
  for (let i = 0; i < letters.length; i++) {
    const g = G[letters[i]!]!;
    for (let r = 0; r < 7; r++) {
      rows[r] += g[r];
      if (i < letters.length - 1) rows[r] += LETTER_GAP;
    }
  }
  return rows;
}

const LOGO_PREV = compose(["P", "R", "E", "V"]);
const LOGO_AI = compose(["A", "I"]);
const LOGO_L = compose(["L"]);

function BrandColumn() {
  // Render each row as three spans: PREV (gold) — gap — AI (cyan) — gap —
  // L (gold). The per-group GAP keeps the original ANSI-Shadow letter
  // shapes intact (which were tuned to interlock) so the word reads
  // cleanly, while the gap on either side of AI makes the cyan block
  // pop as the visual center.
  return (
    <box flexDirection="row" width={88}>
      <Mascot />
      <box flexDirection="column" paddingLeft={2}>
        {LOGO_PREV.map((_, i) => (
          <text key={`logo-${i}`} attributes={1}>
            <span fg={theme.gold} attributes={1}>{LOGO_PREV[i]}</span>
            <span fg={theme.gold} attributes={1}>{GROUP_GAP}</span>
            <span fg={theme.aiAccent} attributes={1}>{LOGO_AI[i]}</span>
            <span fg={theme.gold} attributes={1}>{GROUP_GAP}</span>
            <span fg={theme.gold} attributes={1}>{LOGO_L[i]}</span>
          </text>
        ))}
      </box>
    </box>
  );
}

function Mascot() {
  return (
    <box flexDirection="column" width={9} paddingTop={1}>
      <text fg={theme.goldDim}> ╲ │ ╱ </text>
      <text fg={theme.gold} attributes={1}> ─ ◈ ─ </text>
      <text fg={theme.goldDim}> ╱ │ ╲ </text>
      <text> </text>
      <text fg={theme.fgFaint}>EST 2026</text>
    </box>
  );
}

function Separator() {
  return (
    <box flexDirection="column" width={3} paddingLeft={1} paddingRight={1}>
      {Array.from({ length: 7 }, (_, i) => (
        <text key={`sep-${i}`} fg={theme.border}>
          │
        </text>
      ))}
    </box>
  );
}

function StatusColumn({
  dateLabel,
  yearLabel,
  timeLabel,
  vaultLabel,
  cliText,
  domainCount,
  appCount,
  totalLoops,
  globalCouncilOn,
  onToggleGlobalCouncil,
  onOpenCouncilConfig,
  onOpenTools,
  onOpenBenchmark,
  onCycleFramework,
  onCycleLens,
  onCycleWeb,
  cliHealthSummary,
  showBrandHeader = false,
}: {
  dateLabel: string;
  yearLabel: number;
  timeLabel: string;
  vaultLabel: string;
  cliText: string;
  domainCount: number;
  appCount: number;
  totalLoops: number;
  globalCouncilOn?: boolean;
  onToggleGlobalCouncil?: () => void;
  onOpenCouncilConfig?: () => void;
  onOpenTools?: () => void;
  onOpenBenchmark?: () => void;
  onCycleFramework?: () => void;
  onCycleLens?: () => void;
  onCycleWeb?: () => void;
  cliHealthSummary?: { kind: string; label: string; ok: boolean | null; message?: string }[];
  showBrandHeader?: boolean;
}) {
  const fw = readResponseFramework();
  const fwLabel = fw ? FRAMEWORKS.find((f) => f.id === fw)?.label ?? fw : "none";
  const lensSel: LensSelection = readResponseLens();
  const lensLabel =
    lensSel === null
      ? "none"
      : lensSel === "all"
        ? "all (×5)"
        : getLens(lensSel)?.label ?? "none";
  // statusGlyph/statusText/statusColor previously fed a "chat" StatRow
  // that read "no chats yet" most of the time — the user asked to drop
  // the row entirely. Active chat state is implied by the cli health
  // row + per-domain spinners in the sidebar. Locals removed.

  const webAllow = readWebAccess() === "allow";

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2}>
      {/* When the giant ASCII logo is hidden (medium tier), surface a
          one-line brand header inline so the user still sees the app
          name + version at the top of the banner. */}
      {showBrandHeader && (
        <box flexDirection="row" height={1}>
          <text fg={theme.gold} attributes={1}>{"◈ prevAIl"}</text>
          <text fg={theme.goldDim}>{`  v${VERSION}  ·  opentui`}</text>
        </box>
      )}
      <box flexDirection="row" height={1}>
        <text fg={theme.gold} attributes={1}>
          {dateLabel}
        </text>
        <text fg={theme.goldDim}>{`  ·  ${yearLabel}`}</text>
        <box flexGrow={1} />
        {/* Compact stats moved here from the brand column so the banner is
            shorter and the chat area gets more vertical real estate. */}
        <text fg={theme.fgDim}>
          <span fg={theme.fg}>{domainCount}</span>
          {" dom · "}
          <span fg={theme.fg}>{appCount}</span>
          {" apps · "}
          <span fg={totalLoops > 0 ? theme.warn : theme.fg}>{totalLoops}</span>
          {" open"}
        </text>
      </box>
      {!showBrandHeader && (
        <text fg={theme.fgDim}>
          {`${timeLabel}  ·  prevail v${VERSION}  ·  opentui`}
        </text>
      )}
      {showBrandHeader && (
        <text fg={theme.fgDim}>{timeLabel}</text>
      )}
      <StatRow label="vault" value={vaultLabel} valueColor={theme.fg} />
      {/* "chat" line dropped — it was just "no chats yet" most of the
          time and added noise. Active chat count moves elsewhere when
          we need it. The chat status is also implied by the cli health
          row below. */}
      {/* Two-line defaults block.
          Row 1: ⚖ Council · ◆ Framework · ◇ Lens — the three
          per-question decisions ("how does this question get answered").
          Row 2: ◇ configure · ▸ tools — globals + integrations.
          Each chip uses a DISTINCT leading glyph (⚖ scales for the
          deliberative council, ◆ filled diamond for the structural
          framework, ◇ open diamond for the lens) so they don't read
          as repeats — user reported "seems they all have same icons
          right now." */}
      {/* Chip rendering is delegated to the shared <Chip /> component
          (src/chip.tsx). That component encodes the opentui-safe pattern
          (two-text-per-chip + NBSP value prefix) so future rendering
          glitches only need one fix. */}
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>{"defaults"}</text>
        <Chip
          label="⚖ Council:"
          value={globalCouncilOn ? "ON" : "OFF"}
          active={!!globalCouncilOn}
          activeFg={theme.gold}
          onMouseDown={onToggleGlobalCouncil}
          paddingLeft={2}
        />
        <Chip
          label="◆ Framework:"
          value={fwLabel}
          active={!!fw}
          onMouseDown={onCycleFramework}
        />
        <Chip
          label="◇ Lens:"
          value={lensLabel}
          active={!!lensSel}
          onMouseDown={onCycleLens}
        />
      </box>
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>{"        "}</text>
        <Chip
          label="⬡ Web:"
          value={webAllow ? "ON" : "OFF"}
          active={webAllow}
          onMouseDown={onCycleWeb}
          paddingLeft={2}
        />
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenCouncilConfig}>
          <text fg={theme.aiAccent}>◇ configure</text>
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenBenchmark}>
          <text fg={theme.aiAccent} attributes={1}>◈ bench</text>
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenTools}>
          <text fg={theme.aiAccent} attributes={1}>▸ tools</text>
        </box>
      </box>
      {cliHealthSummary && cliHealthSummary.length > 0 && (
        // Render each panelist health badge as its own <box> with
        // padding so opentui treats them as separate layout cells —
        // rendering ALL of them inside a single <text> caused the
        // labels to bleed into each other when trailing whitespace got
        // collapsed at render time ("panel" + "Claude" + "Codex" came
        // out as "panellts ✓ Claude c✓nCodex …" in the cockpit).
        <box flexDirection="row" height={1}>
          <text fg={theme.fgFaint}>{"cli"}</text>
          {cliHealthSummary.map((h) => {
            const glyph =
              h.ok === true ? "✓" : h.ok === false ? "!" : "·";
            const fgC =
              h.ok === true ? theme.ok : h.ok === false ? theme.warn : theme.fgDim;
            return (
              <box key={h.kind} flexDirection="row" paddingLeft={2}>
                <text fg={fgC}>{glyph}</text>
                <text fg={theme.fg}>{" " + h.label}</text>
              </box>
            );
          })}
        </box>
      )}
    </box>
  );
}

function StatRow({
  label,
  value,
  valueColor,
  glyph,
}: {
  label: string;
  value: string;
  valueColor: string;
  glyph?: string;
}) {
  const padded = label.padEnd(8, " ");
  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.fgFaint}>{padded}</text>
      {glyph && <text fg={valueColor}>{glyph} </text>}
      <text fg={valueColor}>{value}</text>
    </box>
  );
}

function formatTime(d: Date): string {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}
