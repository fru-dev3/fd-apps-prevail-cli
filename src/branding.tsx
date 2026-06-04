import { theme } from "./theme.ts";
import { VERSION } from "./version.ts";

interface Props {
  domainCount: number;
  totalLoops: number;
  appCount: number;
  vaultLabel: string;
  cliLabels: string[];
  activeChats: number;
  pendingChats: number;
}

export function Branding({
  domainCount,
  totalLoops,
  appCount,
  vaultLabel,
  cliLabels,
  activeChats,
  pendingChats,
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
      height={12}
      border={["bottom"]}
      borderColor={theme.gold}
      backgroundColor={theme.bg}
      paddingTop={1}
      paddingBottom={1}
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
        <text fg={theme.goldDim}>
          {"  p r e v "}
          <span fg={theme.aiAccent}>A I</span>
          {" l   —   your AI life cockpit"}
        </text>
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
}) {
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
      <text> </text>
      <StatRow label="vault" value={vaultLabel} valueColor={theme.fg} />
      <StatRow label="cli" value={cliText} valueColor={theme.fg} />
      <StatRow label="chat" value={statusText} glyph={statusGlyph} valueColor={statusColor} />
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
