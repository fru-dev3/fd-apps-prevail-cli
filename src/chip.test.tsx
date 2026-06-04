import { describe, expect, test } from "bun:test";
import { Chip } from "./chip.tsx";
import { theme } from "./theme.ts";

// NBSP = U+00A0. The Chip component must prepend this (NOT a regular
// space) to the value cell so opentui doesn't collapse leading
// whitespace inside the value <text> when the label <text> butts up
// against it. We assert on the value string the component renders, not
// on terminal output — that's the load-bearing invariant.
const NBSP = " ";

// We don't have an opentui test renderer here, so we inspect the React
// element tree directly by calling the Chip function component and
// walking its returned tree. Each Chip returns a <box> whose children
// are two <text> nodes: [label, NBSP+value].

interface RenderedNode {
  type: string;
  props: Record<string, unknown> & { children?: unknown };
}

function renderChip(props: Parameters<typeof Chip>[0]): RenderedNode {
  return Chip(props) as unknown as RenderedNode;
}

function getTexts(box: RenderedNode): RenderedNode[] {
  const children = box.props.children;
  const arr = Array.isArray(children) ? children : [children];
  return arr.filter(
    (c): c is RenderedNode =>
      !!c && typeof c === "object" && (c as RenderedNode).type === "text",
  );
}

describe("Chip", () => {
  test("renders label and value both in fgDim when inactive", () => {
    const node = renderChip({
      label: "◆ Framework:",
      value: "none",
      active: false,
    });
    const texts = getTexts(node);
    expect(texts.length).toBe(2);
    expect(texts[0]!.props.fg).toBe(theme.fgDim);
    expect(texts[1]!.props.fg).toBe(theme.fgDim);
  });

  test("renders value in aiAccent when active (default)", () => {
    const node = renderChip({
      label: "◆ Framework:",
      value: "BLUF",
      active: true,
    });
    const texts = getTexts(node);
    expect(texts[0]!.props.fg).toBe(theme.fgDim);
    expect(texts[1]!.props.fg).toBe(theme.aiAccent);
  });

  test("activeFg override is honored when active", () => {
    const node = renderChip({
      label: "⚖ Council:",
      value: "ON",
      active: true,
      activeFg: theme.gold,
    });
    const texts = getTexts(node);
    expect(texts[1]!.props.fg).toBe(theme.gold);
  });

  test("activeFg override is ignored when inactive — value stays dim", () => {
    const node = renderChip({
      label: "⚖ Council:",
      value: "OFF",
      active: false,
      activeFg: theme.gold,
    });
    const texts = getTexts(node);
    expect(texts[1]!.props.fg).toBe(theme.fgDim);
  });

  test("value text starts with NBSP (U+00A0), not a regular space", () => {
    const node = renderChip({
      label: "◇ Lens:",
      value: "stoic",
      active: true,
    });
    const texts = getTexts(node);
    const valueChildren = texts[1]!.props.children;
    const valueStr = Array.isArray(valueChildren)
      ? valueChildren.join("")
      : String(valueChildren);
    expect(valueStr.charCodeAt(0)).toBe(0x00a0);
    expect(valueStr).toBe(NBSP + "stoic");
    // And NOT a regular ASCII space.
    expect(valueStr.charCodeAt(0)).not.toBe(0x20);
  });

  test("attributes bit is 1 when active, 0 when inactive", () => {
    const onNode = renderChip({
      label: "⬡ Web:",
      value: "ON",
      active: true,
    });
    const offNode = renderChip({
      label: "⬡ Web:",
      value: "OFF",
      active: false,
    });
    expect(getTexts(onNode)[1]!.props.attributes).toBe(1);
    expect(getTexts(offNode)[1]!.props.attributes).toBe(0);
  });

  test("onMouseDown handler is wired to the outer box", () => {
    let clicked = 0;
    const node = renderChip({
      label: "◐ Auto:",
      value: "OFF",
      active: false,
      onMouseDown: () => {
        clicked += 1;
      },
    });
    const handler = node.props.onMouseDown as (() => void) | undefined;
    expect(typeof handler).toBe("function");
    handler?.();
    expect(clicked).toBe(1);
  });

  test("default padding is 1 on both sides", () => {
    const node = renderChip({
      label: "▣ Save:",
      value: "ON",
      active: true,
    });
    expect(node.props.paddingLeft).toBe(1);
    expect(node.props.paddingRight).toBe(1);
  });

  test("paddingLeft override is honored (branding Council/Web use 2)", () => {
    const node = renderChip({
      label: "⚖ Council:",
      value: "ON",
      active: true,
      activeFg: theme.gold,
      paddingLeft: 2,
    });
    expect(node.props.paddingLeft).toBe(2);
    expect(node.props.paddingRight).toBe(1);
  });
});
