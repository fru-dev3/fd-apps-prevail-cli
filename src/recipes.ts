// recipes — bundled, declarative starting points for the browser lane. Each
// recipe is a known portal (bank/broker/IRS/…) with a login URL, a post-login
// success marker, and a best-effort post-login action list. They let a browser
// connector work DETERMINISTICALLY from day one (no LLM) for the ~15 portals we
// ship; the agentic loop is only needed for the long tail and for re-learning
// when a recipe drifts.
//
// The recipe action vocabulary is the desktop tier_c DSL (type/selector). We
// convert it to the engine's ReplayStep shape (action/locator) when seeding a
// skill, so one recipe seeds a normal `runner: browser` skill that the existing
// replayer + sync daemon run with zero new machinery.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { buildReplaySkillMarkdown } from "./browser-record.ts";
import { validateReplaySteps, type ReplayStep, type AllowedKey } from "./browser-actions.ts";
// Bundled into the compiled binary by bun's JSON import; resolved from disk in dev.
import BUNDLED_RECIPES from "../assets/automation/recipes.json";

export interface RecipeAction {
  type: "goto" | "click" | "wait_for" | "select_option" | "download_all_links" | "sleep" | "press";
  url?: string;
  wait_until?: string;
  selector?: string;
  value?: string;
  key?: string;
  max?: number;
  timeout_sec?: number;
  seconds?: number;
}

export interface PortalRecipe {
  id: string;
  label: string;
  domain_hint?: string;
  start_url: string;
  success_url_contains?: string;
  notes?: string | null;
  actions?: RecipeAction[];
}

export function loadRecipes(userRecipesPath?: string): PortalRecipe[] {
  const bundled = (BUNDLED_RECIPES as PortalRecipe[]).slice();
  if (userRecipesPath && existsSync(userRecipesPath)) {
    try {
      const user = JSON.parse(vreadFile(userRecipesPath)) as PortalRecipe[];
      // User entries override bundled ones by id.
      const byId = new Map(bundled.map((r) => [r.id, r]));
      for (const r of user) if (r && r.id) byId.set(r.id, r);
      return [...byId.values()];
    } catch {
      /* malformed overrides → ignore, keep bundled */
    }
  }
  return bundled;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Match a recipe by exact id, then by the host of an app id-derived url, then by
// the host of a provided url. Returns null when nothing fits.
export function matchRecipe(idOrUrl: string, recipes = loadRecipes()): PortalRecipe | null {
  const exact = recipes.find((r) => r.id === idOrUrl);
  if (exact) return exact;
  const host = idOrUrl.includes("://") ? hostOf(idOrUrl) : idOrUrl.toLowerCase();
  if (!host) return null;
  return (
    recipes.find((r) => hostOf(r.start_url) === host) ||
    recipes.find((r) => hostOf(r.start_url).includes(host) || host.includes(r.id)) ||
    null
  );
}

// Convert a recipe's best-effort actions into deterministic ReplaySteps. Recipe
// selectors are CSS (flagged brittle); sleeps are dropped (replay relies on
// wait_for/expect markers, not blind pauses).
export function recipeToSteps(recipe: PortalRecipe): ReplayStep[] {
  const steps: ReplayStep[] = [];
  for (const a of recipe.actions ?? []) {
    switch (a.type) {
      case "goto":
        if (a.url) steps.push({ action: "navigate", url: a.url });
        break;
      case "click":
        if (a.selector) steps.push({ action: "click", locator: { css: a.selector, brittle: true }, timeout_sec: a.timeout_sec });
        break;
      case "wait_for":
        if (a.selector) steps.push({ action: "wait_for", locator: { css: a.selector, brittle: true }, timeout_sec: a.timeout_sec });
        break;
      case "select_option":
        if (a.selector) steps.push({ action: "select", locator: { css: a.selector, brittle: true }, option: a.value });
        break;
      case "download_all_links":
        steps.push({ action: "download_all_links", selector: a.selector || "a[href$='.pdf']", max: a.max ?? 24 });
        break;
      case "press":
        steps.push({ action: "press", key: (a.key as AllowedKey) || "Enter" });
        break;
      // sleep: intentionally dropped.
    }
  }
  return steps;
}

export interface SeedResult {
  ok: boolean;
  path?: string;
  steps: number;
  message: string;
}

// Seed a deterministic `runner: browser` replay skill from a recipe. Used when a
// browser connector is created for a known portal — it works from day one, and
// the agent only kicks in to re-learn if the recipe drifts.
export function seedSkillFromRecipe(connectorDir: string, connectorId: string, recipe: PortalRecipe, skillId = "sync"): SeedResult {
  const steps = recipeToSteps(recipe);
  if (steps.length === 0) {
    return { ok: false, steps: 0, message: `recipe "${recipe.id}" has no automatable actions (login-only; use browser-learn)` };
  }
  const check = validateReplaySteps(steps);
  if (!check.ok) return { ok: false, steps: steps.length, message: `invalid recipe steps: ${check.errors.join("; ")}` };
  const md = buildReplaySkillMarkdown(
    {
      skillId,
      connector: connectorId,
      goal: `Download the latest statements/data from ${recipe.label}`,
      startUrl: recipe.start_url,
      trigger: "refresh",
      session: "profile",
      domainAllow: [hostOf(recipe.start_url)].filter(Boolean),
      successGlob: "data/imports/**/*",
    },
    steps,
  );
  // Carry the recipe's success_url_contains for the post-login human gate.
  const withMarker = recipe.success_url_contains
    ? md.replace(/^start_url: .*$/m, (l) => `${l}\nsuccess_url_contains: ${recipe.success_url_contains}`)
    : md;
  const skillsDir = join(connectorDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const path = join(skillsDir, `${skillId}.md`);
  vwriteFile(path, withMarker);
  return { ok: true, path, steps: steps.length, message: `seeded ${steps.length} steps from "${recipe.label}" → ${skillId}.md` };
}
