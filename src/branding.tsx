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
      height={11}
      border={["bottom"]}
      borderStyle="double"
      borderColor={theme.gold}
      backgroundColor={theme.bg}
    >
      <box
        flexDirection="row"
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={0}
      >
        <BrandColumn
          domainCount={domainCount}
          appCount={appCount}
          totalLoops={totalLoops}
        />
        <Separator />
        <StatusColumn
          dateLabel={dateLabel}
          yearLabel={yearLabel}
          timeLabel={timeLabel}
          vaultLabel={vaultLabel}
          cliText={cliText}
          activeChats={activeChats}
          pendingChats={pendingChats}
        />
      </box>
    </box>
  );
}

// AIREADY is at cols 0-57; the trailing U starts at col 58 (9 chars wide).
const LOGO_U_OFFSET = 58;
const LOGO_LINES = [
  " █████╗ ██╗   ██████╗ ███████╗ █████╗ ██████╗ ██╗   ██╗   ██╗   ██╗",
  "██╔══██╗██║   ██╔══██╗██╔════╝██╔══██╗██╔══██╗╚██╗ ██╔╝   ██║   ██║",
  "███████║██║   ██████╔╝█████╗  ███████║██║  ██║ ╚████╔╝    ██║   ██║",
  "██╔══██║██║   ██╔══██╗██╔══╝  ██╔══██║██║  ██║  ╚██╔╝     ██║   ██║",
  "██║  ██║██║   ██║  ██║███████╗██║  ██║██████╔╝   ██║      ╚██████╔╝",
  "╚═╝  ╚═╝╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═════╝    ╚═╝       ╚═════╝ ",
] as const;

function BrandColumn({
  domainCount,
  appCount,
  totalLoops,
}: {
  domainCount: number;
  appCount: number;
  totalLoops: number;
}) {
  return (
    <box flexDirection="row" width={80}>
      <Mascot />
      <box flexDirection="column" paddingLeft={2}>
        {LOGO_LINES.map((line, i) => {
          const prefix = line.slice(0, LOGO_U_OFFSET);
          const uChars = line.slice(LOGO_U_OFFSET);
          return (
            <text key={`logo-${i}`} fg={theme.gold} attributes={1}>
              <span fg={theme.gold} attributes={1}>{prefix}</span>
              <span fg={theme.goldBright} attributes={1}>{uChars}</span>
            </text>
          );
        })}
        <text fg={theme.goldDim}>
          {"        a i  ·  r e a d y  ·  "}
          <span fg={theme.goldBright}>u</span>
          {"   —   personal ai cockpit"}
        </text>
        <text> </text>
        <text fg={theme.fgDim}>
          {"        "}
          <span fg={theme.fg}>{domainCount.toString().padStart(2, " ")}</span>
          {" life domains   "}
          <span fg={theme.fg}>{appCount.toString().padStart(2, " ")}</span>
          {" life apps   "}
          <span fg={totalLoops > 0 ? theme.warn : theme.fg}>
            {totalLoops.toString().padStart(2, " ")}
          </span>
          {" open items"}
        </text>
      </box>
    </box>
  );
}

function Mascot() {
  return (
    <box flexDirection="column" width={9} paddingTop={2}>
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
      {Array.from({ length: 12 }, (_, i) => (
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
}: {
  dateLabel: string;
  yearLabel: number;
  timeLabel: string;
  vaultLabel: string;
  cliText: string;
  activeChats: number;
  pendingChats: number;
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
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
      <box flexDirection="row" height={1}>
        <text fg={theme.gold} attributes={1}>
          {dateLabel}
        </text>
        <text fg={theme.goldDim}>{`  ·  ${yearLabel}`}</text>
      </box>
      <text fg={theme.fgDim}>
        {timeLabel}  ·  aireadyu  ·  opentui · zig core
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
