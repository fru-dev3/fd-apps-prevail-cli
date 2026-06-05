import { useState } from "react";
import { useOnResize, useRenderer } from "@opentui/react";

// Two-tier responsive layout. Drives both the Branding height/contents
// and the Sidebar width — and any other component that wants to adapt.
//
//   compact — 13" MBP terminal, split iTerm panes (≲ 100 cols OR < 28 rows)
//   wide    — everything else — IDENTICAL to the original 1.6.2 layout
//             with the ASCII PREVAIL logo and full status column
//
// User feedback (v1.6.5): the v1.6.4 "medium" tier was too aggressive —
// it knocked perfectly comfortable 14"/15" MBP and external-monitor
// setups into a no-logo layout the user did not want. Only adapt when
// the terminal is genuinely small.
//
// We check BOTH dimensions in OR mode: any axis being tight knocks the
// layout down to compact. That way a tall-but-narrow split (90 cols ×
// 50 rows) still drops to compact instead of trying to render a wide
// 9-row banner that gets horizontally clipped.
export type LayoutTier = "compact" | "wide";

export const TIER_THRESHOLDS = {
  compactMaxWidth: 100,
  compactMaxHeight: 28,
} as const;

export function classifyTier(width: number, height: number): LayoutTier {
  if (width < TIER_THRESHOLDS.compactMaxWidth || height < TIER_THRESHOLDS.compactMaxHeight) {
    return "compact";
  }
  return "wide";
}

// React hook that tracks the current tier and resubscribes to terminal
// resize events so the layout adapts live without remounting the app.
// Defaults to "wide" when the renderer isn't available yet (SSR, tests).
export function useLayoutTier(): { tier: LayoutTier; width: number; height: number } {
  const renderer = useRenderer();
  const [size, setSize] = useState(() => ({
    width: renderer?.terminalWidth ?? 200,
    height: renderer?.terminalHeight ?? 50,
  }));
  useOnResize(() => {
    setSize({
      width: renderer?.terminalWidth ?? 200,
      height: renderer?.terminalHeight ?? 50,
    });
  });
  return {
    tier: classifyTier(size.width, size.height),
    width: size.width,
    height: size.height,
  };
}
