import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRecipes, matchRecipe, recipeToSteps, seedSkillFromRecipe, type PortalRecipe } from "./recipes.ts";
import { parseSkillFile } from "./connector-skills.ts";
import type { AppSkill } from "./vault.ts";

const TMP = process.platform === "darwin" ? "/tmp" : require("node:os").tmpdir();
const conn = join(TMP, `prevail-rec2-${process.pid}`);
mkdirSync(conn, { recursive: true });
afterAll(() => rmSync(conn, { recursive: true, force: true }));

describe("loadRecipes", () => {
  test("bundles the portal recipes", () => {
    const r = loadRecipes();
    expect(r.length).toBeGreaterThanOrEqual(15);
    expect(r.find((x) => x.id === "fidelity")).toBeTruthy();
    expect(r.find((x) => x.id === "chase")?.start_url).toMatch(/^https:/);
  });
});

describe("matchRecipe", () => {
  test("matches by id and by host", () => {
    expect(matchRecipe("fidelity")?.label).toBe("Fidelity");
    expect(matchRecipe("https://secure.chase.com/x")?.id).toBe("chase");
    expect(matchRecipe("nonexistent-xyz")).toBeNull();
  });
});

describe("recipeToSteps", () => {
  test("converts the fidelity recipe and drops sleeps", () => {
    const fidelity = matchRecipe("fidelity")!;
    const steps = recipeToSteps(fidelity);
    expect(steps.find((s) => (s as { action: string }).action === "sleep" as never)).toBeUndefined();
    expect(steps.some((s) => s.action === "download_all_links")).toBe(true);
    expect(steps.some((s) => s.action === "navigate")).toBe(true);
  });
  test("css selectors are flagged brittle", () => {
    const recipe: PortalRecipe = { id: "t", label: "T", start_url: "https://t.com", actions: [{ type: "click", selector: ".x" }] };
    expect(recipeToSteps(recipe)[0]).toMatchObject({ action: "click", locator: { css: ".x", brittle: true } });
  });
});

describe("seedSkillFromRecipe", () => {
  test("writes a valid replay skill that parses back", () => {
    const fidelity = matchRecipe("fidelity")!;
    const r = seedSkillFromRecipe(conn, "fidelity", fidelity, "sync");
    expect(r.ok).toBe(true);
    expect(r.steps).toBeGreaterThan(0);
    const app = { id: "fidelity", path: conn } as AppSkill;
    const spec = parseSkillFile(require("node:fs").readFileSync(r.path!, "utf8"), r.path!, app);
    expect(spec?.runner).toBe("browser");
    expect(Array.isArray(spec?.extra?.steps)).toBe(true);
    expect(spec?.extra?.success_url_contains).toContain("/ftgw/digital/portfolio");
  });
  test("login-only recipes (no actions) report no automatable steps", () => {
    const schwab = matchRecipe("schwab")!; // has no actions array
    const r = seedSkillFromRecipe(conn, "schwab", schwab, "sync2");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/login-only|no automatable/);
  });
});
