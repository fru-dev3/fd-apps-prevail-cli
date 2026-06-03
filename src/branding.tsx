import { theme } from "./theme.ts";

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
      height={8}
      border={["bottom"]}
      borderColor={theme.gold}
      backgroundColor={theme.bg}
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

// PREVAIL logo, rendered as three side-by-side blocks so the "AI" stays
// visually emphasized in aiAccent (electric cyan) while "PREV" and "L"
// sit in plain gold. High-contrast pairing — the AI is the unmistakable
// heart of the cockpit, not just a slightly-brighter shade of the same
// color it sits next to.
// Three logo groups (PREV / AI / L) — each one preserves the original
// ANSI-Shadow letter shapes that were designed to interlock as a readable
// word. We only add space BETWEEN the groups, not between individual
// letters, so each block stays as legible as the original wordmark while
// the AI section still reads as the distinct visual center.
// Logo groups, padded to consistent per-group width so the column
// positions don't jiggle row-to-row.
//
// Optical-spacing notes (why we don't just use equal mathematical gaps):
//   - V's right edge tapers from "██╗" (top) to "═══╝" (bottom). The TOP
//     visually leaves more whitespace on the right side than the bottom,
//     so a fixed gap reads as too-tight at the bottom and too-loose at top.
//   - A's left edge starts with a leading space on the top row, then
//     fills the full width on subsequent rows — opposite of V.
//   - I is a narrow letter (3 cells wide) sitting next to L which starts
//     wide ("██╗") at the top.
//
// We compensate by:
//   1. Padding each group's right edge with trailing whitespace so the
//      starting column of the NEXT group is always the same.
//   2. Using a generous GROUP_GAP (3 spaces) so any row-to-row variance
//      inside a letter is dominated by the inter-group whitespace, which
//      is what the eye actually uses to judge spacing.
//   3. Adding a single leading space inside the AI group so the optical
//      left edge of "A" aligns with the right edge of V's widest column.

const pad = (s: string, w: number) =>
  s + " ".repeat(Math.max(0, w - s.length));

// PREV — pad to the width of the WIDEST row so the right edge is flush.
const LOGO_PREV_RAW = [
  "██████╗ ██████╗ ███████╗██╗   ██╗",
  "██╔══██╗██╔══██╗██╔════╝██║   ██║",
  "██████╔╝██████╔╝█████╗  ██║   ██║",
  "██╔═══╝ ██╔══██╗██╔══╝  ╚██╗ ██╔╝",
  "██║     ██║  ██║███████╗ ╚████╔╝",
  "╚═╝     ╚═╝  ╚═╝╚══════╝  ╚═══╝",
] as const;
const PREV_W = Math.max(...LOGO_PREV_RAW.map((r) => r.length));

// AI — leading space gives optical centering between V (whose right edge
// is widest at the top) and the A's left edge (which is widest in the
// middle). Pad right edge to the widest row.
const LOGO_AI_RAW = [
  "  █████╗ ██╗",
  " ██╔══██╗██║",
  " ███████║██║",
  " ██╔══██║██║",
  " ██║  ██║██║",
  " ╚═╝  ╚═╝╚═╝",
] as const;
const AI_W = Math.max(...LOGO_AI_RAW.map((r) => r.length));

// L — keep narrow; the user reads "L" cleanly regardless of trailing.
const LOGO_L_RAW = [
  "██╗     ",
  "██║     ",
  "██║     ",
  "██║     ",
  "███████╗",
  "╚══════╝",
] as const;
const L_W = Math.max(...LOGO_L_RAW.map((r) => r.length));

const LOGO_PREV = LOGO_PREV_RAW.map((r) => pad(r, PREV_W));
const LOGO_AI = LOGO_AI_RAW.map((r) => pad(r, AI_W));
const LOGO_L = LOGO_L_RAW.map((r) => pad(r, L_W));

// 3-space gap between groups. Big enough that letter-shape variance
// within a group never bleeds visually into the next group.
const GROUP_GAP = "   ";

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
          {"        p r e v   ·   "}
          <span fg={theme.aiAccent}>A I</span>
          {"   ·   l   —   your AI life cockpit"}
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
        {timeLabel}  ·  prevail  ·  opentui · zig core
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
