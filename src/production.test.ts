import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProduction, markDemoVault, isDemoVault, DEMO_MARKER } from "./production.ts";

// Work under cwd (os.tmpdir() = /var is a forbidden vault prefix elsewhere).
const ROOT = join(process.cwd(), `tmp-prod-test-${process.pid}`);

function seed(dir: string) {
  mkdirSync(join(dir, "health"), { recursive: true });
  writeFileSync(join(dir, "health", "state.md"), "demo");
  writeFileSync(join(dir, "_intents.jsonl"), "{}\n");
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("production transition", () => {
  test("marks and detects a demo vault", () => {
    const v = join(ROOT, "demo");
    seed(v);
    expect(isDemoVault(v)).toBe(false);
    markDemoVault(v);
    expect(existsSync(join(v, DEMO_MARKER))).toBe(true);
    expect(isDemoVault(v)).toBe(true);
  });

  test("init creates a clean production vault and switches mode", () => {
    const prod = join(ROOT, "prod");
    const res = initProduction({ vault: prod });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(existsSync(prod)).toBe(true);
    expect(readdirSync(prod).length).toBe(0); // empty, ready for real use
  });

  test("clears a demo-marked vault when asked", () => {
    const demo = join(ROOT, "demo");
    const prod = join(ROOT, "prod");
    seed(demo);
    markDemoVault(demo);
    const res = initProduction({ vault: prod, clearDemo: demo });
    expect(res.demoCleared).toBe(true);
    expect(readdirSync(demo).length).toBe(0); // demo emptied
  });

  test("REFUSES to clear an unmarked (real) vault — never deletes user data", () => {
    const real = join(ROOT, "real");
    const prod = join(ROOT, "prod");
    seed(real); // no demo marker — this is a real vault
    const res = initProduction({ vault: prod, clearDemo: real });
    expect(res.demoCleared).toBe(false);
    expect(res.refusedClear).toBe(require("node:path").resolve(real));
    expect(existsSync(join(real, "health", "state.md"))).toBe(true); // intact
  });

  test("never clears the target vault itself", () => {
    const v = join(ROOT, "same");
    seed(v);
    markDemoVault(v);
    const res = initProduction({ vault: v, clearDemo: v });
    expect(res.demoCleared).toBe(false); // same dir → skipped
  });
});
