import { theme } from "./theme.ts";
import { VERSION } from "./version.ts";
import { readResponseFramework, readResponseLens } from "./config.ts";
import { FRAMEWORKS } from "./framework.ts";
import { LENSES, getLens, type LensSelection } from "./lens.ts";

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
  frameworkTick?: number;
  onCycleFramework?: () => void;
  onCycleLens?: () => void;
  cliHealthSummary?: { kind: string; label: string; ok: boolean | null; message?: string }[];
}

export function Branding({
  domainCount,
  totalLoops,
  appCount,
  vaultLabel,
  cliLabels,
  activeChats,
  pendingChats,
  globalCouncilOn,
  onToggleGlobalCouncil,
  onOpenCouncilConfig,
  onOpenTools,
  onCycleFramework,
  onCycleLens,
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

  return (
    <box
      flexDirection="column"
      height={9}
      border={["bottom"]}
      borderColor={theme.gold}
      backgroundColor={theme.bg}
      paddingTop={1}
      paddingBottom={0}
    >
      <box
        flexDirection="row"
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
      >
        <BrandColumn />
        <Separator />
        <StatusColumn
          dateLabel={dateLabel}
          yearLabel={yearLabel}
          timeLabel={timeLabel}
          vaultLabel={vaultLabel}
          cliText={cliText}
          activeChats={activeChats}
          pendingChats={pendingChats}
          globalCouncilOn={globalCouncilOn}
          onToggleGlobalCouncil={onToggleGlobalCouncil}
          onOpenCouncilConfig={onOpenCouncilConfig}
          onOpenTools={onOpenTools}
          onCycleFramework={onCycleFramework}
          onCycleLens={onCycleLens}
          cliHealthSummary={cliHealthSummary}
          domainCount={domainCount}
          appCount={appCount}
          totalLoops={totalLoops}
        />
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
  activeChats,
  pendingChats,
  domainCount,
  appCount,
  totalLoops,
  globalCouncilOn,
  onToggleGlobalCouncil,
  onOpenCouncilConfig,
  onOpenTools,
  onCycleFramework,
  onCycleLens,
  cliHealthSummary,
}: {
  dateLabel: string;
  yearLabel: number;
  timeLabel: string;
  vaultLabel: string;
  cliText: string;
  activeChats: number;
  pendingChats: number;
  domainCount: number;
  appCount: number;
  totalLoops: number;
  globalCouncilOn?: boolean;
  onToggleGlobalCouncil?: () => void;
  onOpenCouncilConfig?: () => void;
  onOpenTools?: () => void;
  onCycleFramework?: () => void;
  onCycleLens?: () => void;
  cliHealthSummary?: { kind: string; label: string; ok: boolean | null; message?: string }[];
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
  const statusGlyph = pendingChats > 0 ? "⠋" : activeChats > 0 ? "●" : "○";
  const statusColor =
    pendingChats > 0 ? theme.gold : activeChats > 0 ? theme.ok : theme.fgDim;
  const statusText =
    pendingChats > 0
      ? `${pendingChats} working · ${activeChats - pendingChats} idle`
      : activeChats > 0
        ? `${activeChats} chat${activeChats === 1 ? "" : "s"} ready · all idle`
        : "no chats yet";

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2}>
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
      <text fg={theme.fgDim}>
        {`${timeLabel}  ·  prevail v${VERSION}  ·  opentui`}
      </text>
      <StatRow label="vault" value={vaultLabel} valueColor={theme.fg} />
      <StatRow label="chat" value={statusText} glyph={statusGlyph} valueColor={statusColor} />
      {/* Two rows for the defaults block — the status column is too
          narrow to fit Council + configure + Framework + Lens + tools
          on a single line. Row 1: Council + configure + tools (surface
          controls). Row 2: Framework + Lens (response shaping). */}
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>{"defaults"}</text>
        <box flexDirection="row" paddingLeft={2} paddingRight={1} onMouseDown={onToggleGlobalCouncil}>
          <text fg={globalCouncilOn ? theme.gold : theme.fgDim} attributes={globalCouncilOn ? 1 : 0}>
            ◆ Council: {globalCouncilOn ? "ON" : "off"}
          </text>
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenCouncilConfig}>
          <text fg={theme.aiAccent}>◇ configure</text>
        </box>
        <text fg={theme.border}>{" │ "}</text>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onOpenTools}>
          <text fg={theme.aiAccent} attributes={1}>▸ tools</text>
        </box>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={theme.fgFaint}>{"        "}</text>
        <box flexDirection="row" paddingLeft={2} paddingRight={1} onMouseDown={onCycleFramework}>
          <text fg={fw ? theme.aiAccent : theme.fgDim} attributes={fw ? 1 : 0}>
            ◆ Framework: {fwLabel}
          </text>
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} onMouseDown={onCycleLens}>
          <text fg={lensSel ? theme.aiAccent : theme.fgDim} attributes={lensSel ? 1 : 0}>
            ◇ Lens: {lensLabel}
          </text>
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
