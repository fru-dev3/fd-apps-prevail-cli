import { theme } from "./theme.ts";

// Strip ANSI/terminal control sequences from externally-sourced text before it's
// rendered to the TUI, so model/connector output can't move the cursor, clear the
// screen, or spoof UI (M24/O87). Covers CSI (ESC[…), OSC (ESC]…BEL/ST), and bare
// control chars except tab/newline.
export function sanitizeAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export function renderMarkdownLines(content: string) {
  const lines = sanitizeAnsi(content).split("\n");
  return lines.map((raw, i) => {
    const key = `ln-${i}`;
    return <MarkdownLine key={key} line={raw} />;
  });
}

function MarkdownLine({ line }: { line: string }) {
  if (line.trim().length === 0) {
    return <text> </text>;
  }

  const h1 = line.match(/^#\s+(.*)$/);
  if (h1) {
    return (
      <text fg={theme.gold} attributes={1}>
        {h1[1]}
      </text>
    );
  }
  const h2 = line.match(/^##\s+(.*)$/);
  if (h2) {
    return (
      <text fg={theme.gold}>
        {h2[1]}
      </text>
    );
  }
  const h3 = line.match(/^###\s+(.*)$/);
  if (h3) {
    return <text fg={theme.goldDim}>{h3[1]}</text>;
  }

  if (/^\s*>\s*/.test(line)) {
    const text = line.replace(/^\s*>\s?/, "");
    return <text fg={theme.fgFaint}>│ {text}</text>;
  }

  const unchecked = line.match(/^(\s*)[-*]\s*\[\s\]\s*(.*)$/);
  if (unchecked) {
    return (
      <text fg={theme.warn}>
        {unchecked[1]}◯ {unchecked[2]}
      </text>
    );
  }
  const checked = line.match(/^(\s*)[-*]\s*\[x\]\s*(.*)$/i);
  if (checked) {
    return (
      <text fg={theme.ok}>
        {checked[1]}● {checked[2]}
      </text>
    );
  }

  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) {
    return (
      <text fg={theme.fg}>
        {bullet[1]}• {stripInline(bullet[2])}
      </text>
    );
  }

  if (/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?\s*-{3,}/.test(line)) {
    return <text fg={theme.fgDim}>{line}</text>;
  }

  if (/^\s*```/.test(line)) {
    return <text fg={theme.fgFaint}>{line}</text>;
  }

  const meta = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
  if (meta) {
    return (
      <text fg={theme.fg}>
        <span fg={theme.gold}>{meta[1]}:</span> {stripInline(meta[2])}
      </text>
    );
  }

  return <text fg={theme.fg}>{stripInline(line)}</text>;
}

function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
