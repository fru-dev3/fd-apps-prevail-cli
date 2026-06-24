import { describe, it, expect } from "bun:test";
import { sanitizeAnsi } from "./markdown-lite.tsx";

describe("sanitizeAnsi (M24/O87)", () => {
  it("strips ANSI/control sequences but keeps text, markdown, tabs, newlines", () => {
    expect(sanitizeAnsi("[31mred[0m")).toBe("red");
    expect(sanitizeAnsi("]0;titleok")).toBe("ok");
    expect(sanitizeAnsi("clear[2J[Hnow")).toBe("clearnow");
    expect(sanitizeAnsi("a\tb\nc")).toBe("a\tb\nc");
    // markdown link syntax (no ESC) is untouched
    expect(sanitizeAnsi("see [docs](http://x)")).toBe("see [docs](http://x)");
  });
});
