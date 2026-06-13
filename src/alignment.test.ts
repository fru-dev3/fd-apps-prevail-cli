import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { signalAlignment, parseAlignmentJson, computeAlignment, readAlignment, buildAlignmentPrompt } from "./alignment.ts";

// macOS tmpdir() is /var/folders (forbidden by validateVaultPath); use /tmp.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const ROOT = join(TMP_BASE, `prevail-align-${process.pid}`);
const VAULT = join(ROOT, "vault");

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of ["wealth", "health", "social"]) {
    mkdirSync(join(VAULT, d), { recursive: true });
    writeFileSync(join(VAULT, d, "soul.md"), `# ${d}\n`);
    writeFileSync(join(VAULT, d, "_state.md"), `# ${d} state\n- doing fine\n`);
  }
  writeFileSync(join(VAULT, "ideal-state.md"), "# Ideal\nWealthy, healthy, connected.\n");
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("alignment", () => {
  test("signalAlignment buckets domains into pillars with bounded scores", () => {
    seed();
    const r = signalAlignment(VAULT);
    expect(r.method).toBe("signal");
    expect(r.pillars.length).toBeGreaterThan(0);
    for (const p of r.pillars) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
    }
    const pillars = r.pillars.map((p) => p.pillar);
    expect(pillars).toContain("wealth");
    expect(pillars).toContain("health");
    expect(pillars).toContain("relationships"); // social → relationships
    expect(r.overall).toBeGreaterThanOrEqual(0);
    expect(r.overall).toBeLessThanOrEqual(100);
  });

  test("parseAlignmentJson extracts pillars + clamps scores from messy model output", () => {
    const raw = 'sure!\n```json\n{"pillars":[{"pillar":"wealth","score":150,"trend":"up","rationale":"on track"},{"pillar":"health","score":-5,"trend":"down","rationale":"slipping"}],"actions":["rebalance"]}\n```';
    const p = parseAlignmentJson(raw)!;
    expect(p).not.toBeNull();
    expect(p.pillars[0]!.score).toBe(100); // clamped
    expect(p.pillars[1]!.score).toBe(0); // clamped
    expect(p.actions).toEqual(["rebalance"]);
  });

  test("parseAlignmentJson returns null on non-JSON", () => {
    expect(parseAlignmentJson("no json here")).toBeNull();
  });

  test("computeAlignment uses the model run when it returns valid JSON", async () => {
    seed();
    const fakeRun = async (prompt: string) => {
      expect(prompt).toContain("IDEAL STATE");
      return '{"pillars":[{"pillar":"wealth","score":80,"trend":"up","rationale":"good"}],"actions":["save more"]}';
    };
    const r = await computeAlignment(VAULT, 1234, { run: fakeRun });
    expect(r.method).toBe("model");
    expect(r.ts).toBe(1234);
    expect(r.pillars[0]!.pillar).toBe("wealth");
    expect(r.pillars[0]!.domains).toContain("wealth");
    // persisted + readable
    const back = readAlignment(VAULT)!;
    expect(back.overall).toBe(r.overall);
  });

  test("computeAlignment falls back to signal when the model output is junk", async () => {
    seed();
    const r = await computeAlignment(VAULT, 99, { run: async () => "garbage, no json" });
    expect(r.method).toBe("signal");
    expect(r.ts).toBe(99);
  });

  test("buildAlignmentPrompt includes ideal state and domain digests", () => {
    const p = buildAlignmentPrompt("BE GREAT", [{ domain: "wealth", digest: "rich" }]);
    expect(p).toContain("BE GREAT");
    expect(p).toContain("wealth");
  });
});
