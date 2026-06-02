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
// Per-letter blocks so the renderer can space them out evenly via gap.
// Each LETTER[i] is one row of one letter; render joins them with a chosen
// gap so the wordmark stretches to fill the available width.
const L_P = [
  "██████╗",
  "██╔══██╗",
  "██████╔╝",
  "██╔═══╝",
  "██║",
  "╚═╝",
] as const;
const L_R = [
  "██████╗",
  "██╔══██╗",
  "██████╔╝",
  "██╔══██╗",
  "██║  ██║",
  "╚═╝  ╚═╝",
] as const;
const L_E = [
  "███████╗",
  "██╔════╝",
  "█████╗",
  "██╔══╝",
  "███████╗",
  "╚══════╝",
] as const;
const L_V = [
  "██╗   ██╗",
  "██║   ██║",
  "██║   ██║",
  "╚██╗ ██╔╝",
  " ╚████╔╝",
  "  ╚═══╝",
] as const;
const L_A = [
  " █████╗",
  "██╔══██╗",
  "███████║",
  "██╔══██║",
  "██║  ██║",
  "╚═╝  ╚═╝",
] as const;
const L_I = [
  "██╗",
  "██║",
  "██║",
  "██║",
  "██║",
  "╚═╝",
] as const;
const L_L = [
  "██╗",
  "██║",
  "██║",
  "██║",
  "███████╗",
  "╚══════╝",
] as const;
// Wider gap between letters than the old fixed-width strings used.
// Tweaking GAP shifts how much horizontal space the wordmark eats.
const LETTER_GAP = "   ";

function BrandColumn() {
  // Compose each row by joining the per-letter blocks with LETTER_GAP.
  // PREV and L render in gold; AI renders in aiAccent (electric cyan) so
  // the AI pops as the brand thesis.
  const prev = (i: number) =>
    [L_P[i], L_R[i], L_E[i], L_V[i]].join(LETTER_GAP);
  const ai = (i: number) => [L_A[i], L_I[i]].join(LETTER_GAP);
  const l = (i: number) => L_L[i]!;
  return (
    <box flexDirection="row" width={88}>
      <Mascot />
      <box flexDirection="column" paddingLeft={2}>
        {L_P.map((_, i) => (
          <text key={`logo-${i}`} attributes={1}>
            <span fg={theme.gold} attributes={1}>{prev(i)}</span>
            <span fg={theme.gold} attributes={1}>{LETTER_GAP}</span>
            <span fg={theme.aiAccent} attributes={1}>{ai(i)}</span>
            <span fg={theme.gold} attributes={1}>{LETTER_GAP}</span>
            <span fg={theme.gold} attributes={1}>{l(i)}</span>
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
