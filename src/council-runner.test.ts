import { describe, expect, test } from "bun:test";
import { buildCouncilPanel } from "./council-runner.ts";
import type { AvailableCli } from "./cli-bridge.ts";

// Pure-logic test — doesn't actually run any CLI / Ollama. Just verifies the
// panel-builder respects the saved council config shape that the TUI also
// reads (no risk of TUI and daemon drifting on what "the panel" means).
describe("buildCouncilPanel", () => {
  test("returns one panelist per detected CLI when no config is pinned", () => {
    const fake: AvailableCli[] = [
      { kind: "claude", bin: "/bin/c", label: "Claude" },
      { kind: "codex", bin: "/bin/x", label: "Codex" },
    ];
    const panel = buildCouncilPanel(fake);
    expect(panel.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(panel.map((p) => p.cli.kind));
    expect(kinds.has("claude")).toBe(true);
    expect(kinds.has("codex")).toBe(true);
  });

  test("empty CLI list produces empty panel", () => {
    const panel = buildCouncilPanel([]);
    expect(panel.length).toBe(0);
  });
});
