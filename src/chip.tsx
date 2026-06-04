import { theme } from "./theme.ts";

// Shared Chip component for the workspace config bar and the banner
// defaults block. Encodes the proven opentui-safe pattern in ONE place
// so future rendering glitches only need one fix.
//
// RENDERING NOTE: opentui's text node clips when a <text> has either
// (a) literal segments + JSX interpolation as siblings, OR
// (b) a single multi-token string sandwiched in JSX whitespace.
// The proven safe pattern in this codebase (CLI health row, council
// chips) is multiple <text> nodes INSIDE one <box> — each <text>
// becomes its own layout cell so opentui never has to split one.
// Every chip rendered here uses that shape: <text label/> <text value/>.
//
// Two-tone chip coloring. The LABEL ("◆ Framework:") stays dim — it
// names the axis but doesn't tell you anything dynamic. The VALUE
// ("BLUF") gets the highlight color so the user can scan the row and
// see the active state at a glance. When a chip is OFF / "none",
// both halves stay dim — no value to draw attention to.
//
// Spacing note: opentui strips BOTH trailing AND leading whitespace
// inside text cells, so neither "Foo: " nor " bar" produces a visible
// gap when the cells are adjacent. Fix: use a non-breaking space
// (U+00A0,  ) — terminals render it as a space, opentui treats it
// as a normal glyph and preserves it. NBSP is the leading character
// on every value cell rendered by this component.

const NBSP = " ";

interface ChipProps {
  label: string;             // e.g. "◆ Framework:"
  value: string;             // e.g. "BLUF" or "OFF"
  active: boolean;           // whether the value should pop (theme.aiAccent + bold) vs dim
  activeFg?: string;         // override the value fg when active (gold for Council ON)
  onMouseDown?: () => void;
  paddingLeft?: number;      // defaults to 1
  paddingRight?: number;     // defaults to 1
}

export function Chip({
  label,
  value,
  active,
  activeFg,
  onMouseDown,
  paddingLeft = 1,
  paddingRight = 1,
}: ChipProps) {
  const valueFg = active ? (activeFg ?? theme.aiAccent) : theme.fgDim;
  return (
    <box
      flexDirection="row"
      paddingLeft={paddingLeft}
      paddingRight={paddingRight}
      onMouseDown={onMouseDown}
    >
      <text fg={theme.fgDim}>{label}</text>
      <text fg={valueFg} attributes={active ? 1 : 0}>{NBSP + value}</text>
    </box>
  );
}
