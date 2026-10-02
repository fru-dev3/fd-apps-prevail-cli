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
    writeFileSync(join(VAULT, d, "ideal-state.md"), `# ${d}\n`);
    writeFileSync(join(VAULT, d, "_state.md"), `# ${d} state\n- doing fine\n`);
  }
  mkdirSync(join(VAULT, "wealth", "source"), { recursive: true });
  writeFileSync(join(VAULT, "wealth", "source", "goals.md"), "- [ ] Save a foo fund ~id:g-1 ~status:active\n- [ ] Old bar ~id:g-2 ~status:archived\n");
  writeFileSync(join(VAULT, "ideal-state.md"), "# Ideal\nWealthy, healthy, connected.\n");
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("alignment", () => {
  test("signalAlignment scores each real domain with bounded scores", () => {
    seed();
    const r = signalAlignment(VAULT);
    expect(r.method).toBe("signal");
    for (const p of r.pillars) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
    }
    expect(r.pillars.map((p) => p.pillar).sort()).toEqual(["health", "social", "wealth"]);
    expect(r.overall).toBeGreaterThanOrEqual(0);
    expect(r.overall).toBeLessThanOrEqual(100);
  });

  test("internal folders and folders with no manifest or ideal are not domains", () => {
    seed();
    for (const d of ["foo", "_log"]) {
      mkdirSync(join(VAULT, d), { recursive: true });
      writeFileSync(join(VAULT, d, "ideal-state.md"), `# ${d}\n`);
    }
    mkdirSync(join(VAULT, "stray"), { recursive: true });
    writeFileSync(join(VAULT, "stray", "notes.md"), "x");
    const pillars = signalAlignment(VAULT).pillars.map((p) => p.pillar);
    expect(pillars).toContain("foo");
    expect(pillars).not.toContain("_log");
    expect(pillars).not.toContain("stray");
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

  test("computeAlignment uses the model, with each domain's goals in the prompt", async () => {
    seed();
    let seen = "";
    const fakeRun = async (prompt: string) => {
      seen = prompt;
      return '{"pillars":[{"pillar":"wealth","score":80,"trend":"up","rationale":"good"},{"pillar":"made-up","score":10}],"actions":["save more"]}';
    };
    const r = await computeAlignment(VAULT, 1234, { run: fakeRun });
    expect(seen).toContain("IDEAL STATE");
    expect(seen).toContain("Save a foo fund");
    expect(seen).not.toContain("Old bar");
    expect(r.method).toBe("model");
    expect(r.ts).toBe(1234);
    expect(r.pillars.map((p) => p.pillar)).toEqual(["wealth"]); // invented domains dropped
    expect(r.pillars[0]!.domains).toEqual(["wealth"]);
    const back = readAlignment(VAULT)!;
    expect(back.overall).toBe(r.overall);
  });

  test("a model report is reused for a day: at most one model call", async () => {
    seed();
    let calls = 0;
    const run = async () => { calls++; return '{"pillars":[{"pillar":"health","score":50}],"actions":[]}'; };
    await computeAlignment(VAULT, 1_000, { run });
    await computeAlignment(VAULT, 1_000 + 3600_000, { run });
    expect(calls).toBe(1);
    // Past a day with the same inputs it is still reused (up to a week).
    await computeAlignment(VAULT, 1_000 + 2 * 24 * 3600_000, { run });
    expect(calls).toBe(1);
    // A changed goal past the first day calls the model again.
    writeFileSync(join(VAULT, "health", "ideal-state.md"), "# health\nRun a foo race.\n");
    await computeAlignment(VAULT, 1_000 + 2 * 24 * 3600_000, { run });
    expect(calls).toBe(2);
    await computeAlignment(VAULT, 1_000 + 2 * 24 * 3600_000 + 60_000, { run, force: true });
    expect(calls).toBe(3);
  });

  test("computeAlignment falls back to signal when the model output is junk, and waits a day to retry", async () => {
    seed();
    let calls = 0;
    const r = await computeAlignment(VAULT, 99, { run: async () => { calls++; return "garbage, no json"; } });
    expect(r.method).toBe("signal");
    expect(r.ts).toBe(99);
    const again = await computeAlignment(VAULT, 99 + 3600_000, { run: async () => { calls++; return "garbage"; } });
    expect(again.method).toBe("signal");
    expect(calls).toBe(1);
  });

  test("buildAlignmentPrompt includes ideal state and domain digests", () => {
    const p = buildAlignmentPrompt("BE GREAT", [{ domain: "wealth", digest: "rich" }]);
    expect(p).toContain("BE GREAT");
    expect(p).toContain("wealth");
  });
});
