import { describe, expect, test } from "bun:test";
import { FRAMEWORKS, getFramework, isFrameworkId } from "./framework.ts";

describe("frameworks", () => {
  test("every framework has a unique kebab-case id, a label, and a non-empty instruction", () => {
    const ids = new Set<string>();
    for (const f of FRAMEWORKS) {
      expect(f.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.instruction.length).toBeGreaterThan(0);
    }
  });

  test("the go-nogo framework forces one committed GO or NO-GO verdict", () => {
    expect(isFrameworkId("go-nogo")).toBe(true);
    const f = getFramework("go-nogo");
    expect(f).not.toBeNull();
    expect(f!.instruction).toContain("GO");
    expect(f!.instruction).toContain("NO-GO");
    // It must forbid the hedge.
    expect(f!.instruction.toLowerCase()).toContain("never both");
  });
});
