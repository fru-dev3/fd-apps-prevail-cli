import { useState } from "react";
import { useOnResize, useRenderer } from "@opentui/react";

// Three-tier responsive layout. Drives both the Branding height/contents
// and the Sidebar width — and any other component that wants to adapt.
// The thresholds are tuned to common real-world terminal sizes:
//
//   compact  — 13" MBP terminal, split iTerm panes (≲ 100 cols × 28 rows)
//   medium   — 14"/15" MBPs, 24" 1080p externals (≲ 150 cols × 36 rows)
//   wide     — 16" MBP, 27" Studio Display, external monitors (anything more)
//
// We check BOTH dimensions in OR mode: any axis being tight knocks the
// layout down a tier. That way a tall-but-narrow split (90 cols × 50
// rows) still drops to compact instead of trying to render a wide
// 9-row banner that gets horizontally clipped.
export type LayoutTier = "compact" | "medium" | "wide";

export const TIER_THRESHOLDS = {
  compactMaxWidth: 100,
  compactMaxHeight: 28,
  mediumMaxWidth: 150,
  mediumMaxHeight: 36,
} as const;

export function classifyTier(width: number, height: number): LayoutTier {
  if (width < TIER_THRESHOLDS.compactMaxWidth || height < TIER_THRESHOLDS.compactMaxHeight) {
    return "compact";
  }
  if (width < TIER_THRESHOLDS.mediumMaxWidth || height < TIER_THRESHOLDS.mediumMaxHeight) {
    return "medium";
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
