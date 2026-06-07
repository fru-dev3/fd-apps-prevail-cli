import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { scaffoldDomain } from "./domain-scaffold.ts";
import { ensureManifest, writeManifest } from "./manifest.ts";
import { isSafeEntryName } from "./path-safety.ts";
import { scanVault, type Domain } from "./vault.ts";

// =============================================================================
// TRACK E3 — Onboarding.
//
// `prevail onboard recommend` (answers JSON on stdin) → OnboardingRecommendation
// `prevail onboard apply`     (picks JSON on stdin)   → Domain[]
//
// recommendDomains is a pure rubric: a fixed questionnaire (~7 yes/no-ish
// questions) maps to a LEAN core set of life domains plus a handful of
// conditional adds. No LLM, no I/O — deterministic so the TUI/scripts can rely
// on it and the fixtures stay stable.
//
// applyOnboarding turns the user's picks into real domains: scaffold (reusing
// domain-scaffold), ensureManifest (seeds MEMORY.md), seed config.md +
// starter goals/skills onto the manifest, and create the _drop/ inbox. Fully
// idempotent — an already-scaffolded domain is left intact, only missing pieces
// are filled in.
//
// Output shapes are FROZEN:
//   recommend → docs/schemas/OnboardingRecommendation.json
//   apply     → docs/schemas/Domain.json  (as Domain[])
// =============================================================================

// --- Output types (mirror docs/schemas/OnboardingRecommendation.json) --------

export interface ProposedDomain {
  /** Proposed domain key (safe directory name). */
  name: string;
  /** Human display name. */
  label: string;
  /** Suggested sidebar emoji. */
  emoji: string;
  /** One-line description of the proposed domain. */
  summary: string;
  /** Why this domain was recommended, grounded in the user's answers. */
  reason: string;
  /** True if pre-selected (strong fit); false if offered but optional. */
  recommended: boolean;
  /** Optional starter goals to seed the domain's manifest. */
  starterGoals?: string[];
  /** Optional skill ids to enable on scaffold. */
  suggestedSkills?: string[];
}

export interface OnboardingRecommendation {
  /** Proposed domains, most relevant first. */
  domains: ProposedDomain[];
  /** Overall narrative explaining the recommended set. */
  rationale: string;
  /** ISO-8601 timestamp the recommendation was generated. */
  generated_at: string;
}

// --- Answers ----------------------------------------------------------------
//
// The questionnaire is intentionally small and tolerant: every field is
// optional and coerced to a boolean, so partial / free-form payloads still
// produce a sensible recommendation. The wire format is
// `{ "answers": { ... } }` (per ENGINE-JSON-API), but recommendDomains accepts
// the inner answers object directly.

export interface OnboardingAnswers {
  /** Owns a home or other property? → home + real-estate. */
  owns_property?: boolean;
  /** Has dependents (kids, family they support)? → insurance, benefits. */
  has_dependents?: boolean;
  /** Self-employed / runs a business or LLC? → business, tax. */
  self_employed?: boolean;
  /** Has taxable investments / brokerage / crypto? → wealth (always), tax. */
  has_investments?: boolean;
  /** Tracks a chronic condition or active health goals? → health (strong). */
  tracks_health?: boolean;
  /** Employed (W-2) and cares about comp/benefits? → career, benefits. */
  employed_w2?: boolean;
  /** Wants the records/archive domain for documents? → records (offered). */
  wants_records?: boolean;
  // Free-text "focus" is tolerated but not interpreted by the rubric — it is
  // echoed into the rationale so a human reading --json sees their own words.
  focus?: string;
}

// =============================================================================
// The rubric.
//
// CORE (always proposed, recommended=true): wealth, health, career, home,
// records — the lean five-pillar starter every life-OS wants. Some core items
// flip recommended=false when an answer says they don't apply (e.g. no W-2 →
// career still offered, just not pre-checked).
//
// CONDITIONAL ADDS (proposed only when an answer triggers them): tax,
// real-estate, insurance, business, benefits.
//
// `recommended` controls pre-selection; the user picks the final subset.
// =============================================================================

interface RubricSpec {
  name: string;
  label: string;
  emoji: string;
  summary: string;
  /** Default reason; overridden per-answer below. */
  reason: string;
  starterGoals: string[];
  suggestedSkills: string[];
  /** Starter state.md body (used by applyOnboarding to seed a fresh domain). */
  state: string;
  /** Starter config.md body (used by applyOnboarding to seed a fresh domain). */
  config: string;
}

function b(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "y" || s === "1";
  }
  if (typeof v === "number") return v !== 0;
  return false;
}

// Starter content builders — richer than the generic domain-scaffold defaults
// because we know the domain's purpose here. Kept small; the human fleshes
// these out. Markdown only (no front-matter) to match vault-demo conventions.
function stateBody(title: string, overview: string, openItems: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const items = openItems.map((i) => `- [ ] ${i}`).join("\n");
  return `# ${title} State

**Last updated:** ${today}

## Overview

${overview}

## Open Items

${items}
`;
}

function configBody(title: string, summary: string, rows: [string, string][]): string {
  const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  return `# AI Ready Life: ${title} — Config

summary: ${summary}

| Key | Value |
|---|---|
${table}
`;
}

// The full catalog. Order here is the canonical "most relevant first" order
// for the recommendation: core pillars, then conditional adds.
function catalog(): Record<string, RubricSpec> {
  return {
    wealth: {
      name: "wealth",
      label: "Wealth",
      emoji: "💰",
      summary: "Money pulse — net worth, accounts, cash flow.",
      reason: "Every life-OS starts with a money pulse — net worth, accounts, and cash flow in one place.",
      starterGoals: ["Establish a net-worth baseline"],
      suggestedSkills: ["connect-financial-institution"],
      state: stateBody(
        "Wealth",
        "Net worth, accounts, and cash flow. The financial baseline everything else is measured against.",
        ["Add your accounts (checking, savings, brokerage)", "Record a net-worth baseline"],
      ),
      config: configBody("Wealth", "Money pulse — net worth, accounts, cash flow.", [
        ["primary bank", ""],
        ["brokerage", ""],
        ["net-worth target", ""],
      ]),
    },
    health: {
      name: "health",
      label: "Health",
      emoji: "🩺",
      summary: "Body pulse — activity, weight, and appointments.",
      reason: "A balanced life-OS includes health — activity, weight, and appointments.",
      starterGoals: ["Log a weekly activity baseline"],
      suggestedSkills: [],
      state: stateBody(
        "Health",
        "Activity, weight, appointments, and any conditions worth tracking.",
        ["Note current weight and resting metrics", "Add upcoming appointments"],
      ),
      config: configBody("Health", "Body pulse — activity, weight, and appointments.", [
        ["primary care", ""],
        ["pharmacy", ""],
        ["wearable", ""],
      ]),
    },
    career: {
      name: "career",
      label: "Career",
      emoji: "💼",
      summary: "Primary income — role, comp, and growth.",
      reason: "Career anchors your primary income — role, comp trajectory, and growth.",
      starterGoals: ["Capture current role + comp"],
      suggestedSkills: [],
      state: stateBody(
        "Career",
        "Your primary income: current role, compensation, and growth track.",
        ["Record current role and employer", "Note next career milestone"],
      ),
      config: configBody("Career", "Primary income — role, comp, and growth.", [
        ["employer", ""],
        ["role", ""],
        ["review cycle", ""],
      ]),
    },
    home: {
      name: "home",
      label: "Home",
      emoji: "🏠",
      summary: "Household — maintenance, utilities, logistics.",
      reason: "Home keeps household logistics — maintenance, utilities, and recurring chores — from slipping.",
      starterGoals: ["List recurring home tasks"],
      suggestedSkills: [],
      state: stateBody(
        "Home",
        "Household operations: maintenance, utilities, and the logistics of running the place.",
        ["List recurring maintenance tasks", "Record utility accounts"],
      ),
      config: configBody("Home", "Household — maintenance, utilities, logistics.", [
        ["address", ""],
        ["utilities", ""],
        ["maintenance vendors", ""],
      ]),
    },
    records: {
      name: "records",
      label: "Records",
      emoji: "🗂️",
      summary: "Archive — documents, IDs, and important papers.",
      reason: "Records is the archive — IDs, contracts, and important papers you'll want to find fast.",
      starterGoals: ["Inventory critical documents"],
      suggestedSkills: [],
      state: stateBody(
        "Records",
        "The archive: identity documents, contracts, warranties, and anything worth keeping findable.",
        ["Inventory IDs and critical documents", "Set up a filing convention"],
      ),
      config: configBody("Records", "Archive — documents, IDs, and important papers.", [
        ["document store", ""],
        ["backup location", ""],
      ]),
    },
    // --- conditional adds ---
    tax: {
      name: "tax",
      label: "Tax",
      emoji: "🧾",
      summary: "Compliance — deadlines, filings, and documents.",
      reason: "Investments or self-employment mean tax complexity — deadlines and filings deserve their own domain.",
      starterGoals: ["Track this year's filing deadlines"],
      suggestedSkills: [],
      state: stateBody(
        "Tax",
        "Filing deadlines, documents, and compliance obligations across all your income sources.",
        ["List filing deadlines for the year", "Gather prior-year returns"],
      ),
      config: configBody("Tax", "Compliance — deadlines, filings, and documents.", [
        ["filing status", ""],
        ["preparer / software", ""],
        ["entities", ""],
      ]),
    },
    "real-estate": {
      name: "real-estate",
      label: "Real Estate",
      emoji: "🏡",
      summary: "Property — deeds, mortgages, and operations.",
      reason: "You own property — deeds, mortgages, insurance, and operations warrant a dedicated domain.",
      starterGoals: ["Record each property's key facts"],
      suggestedSkills: [],
      state: stateBody(
        "Real Estate",
        "Owned property: deeds, mortgages, insurance, and operational details per address.",
        ["Record each property's key facts", "Note mortgage and insurance details"],
      ),
      config: configBody("Real Estate", "Property — deeds, mortgages, and operations.", [
        ["properties", ""],
        ["mortgage lender", ""],
        ["property manager", ""],
      ]),
    },
    insurance: {
      name: "insurance",
      label: "Insurance",
      emoji: "🛡️",
      summary: "Risk — policies, coverage, and beneficiaries.",
      reason: "With dependents or property, insurance coverage and beneficiaries need a clear home.",
      starterGoals: ["Inventory active policies"],
      suggestedSkills: [],
      state: stateBody(
        "Insurance",
        "Policies, coverage levels, and beneficiaries — your risk-management layer.",
        ["Inventory active policies", "Confirm beneficiaries are current"],
      ),
      config: configBody("Insurance", "Risk — policies, coverage, and beneficiaries.", [
        ["health", ""],
        ["life", ""],
        ["property / auto", ""],
      ]),
    },
    business: {
      name: "business",
      label: "Business",
      emoji: "🏢",
      summary: "Ventures — entities, revenue, and compliance.",
      reason: "You're self-employed — a business domain keeps entities, revenue, and obligations in one place.",
      starterGoals: ["List entities and their status"],
      suggestedSkills: ["fd-business-review"],
      state: stateBody(
        "Business",
        "Your ventures: legal entities, revenue, and compliance obligations.",
        ["List entities and their filing status", "Capture current revenue lines"],
      ),
      config: configBody("Business", "Ventures — entities, revenue, and compliance.", [
        ["entities", ""],
        ["bank", ""],
        ["accountant", ""],
      ]),
    },
    benefits: {
      name: "benefits",
      label: "Benefits",
      emoji: "🎁",
      summary: "Comp & benefits — equity, retirement, perks.",
      reason: "Employed with dependents — equity, retirement, and benefits elections are worth tracking deliberately.",
      starterGoals: ["Capture benefits elections"],
      suggestedSkills: [],
      state: stateBody(
        "Benefits",
        "Equity, retirement accounts, and benefits elections from your employer.",
        ["Capture benefits elections", "Record equity grants and vesting"],
      ),
      config: configBody("Benefits", "Comp & benefits — equity, retirement, perks.", [
        ["401k / retirement", ""],
        ["equity", ""],
        ["HSA / FSA", ""],
      ]),
    },
  };
}

// =============================================================================
// recommendDomains — the pure rubric.
// =============================================================================

export function recommendDomains(answers: OnboardingAnswers | null | undefined): OnboardingRecommendation {
  const a = answers ?? {};
  const ownsProperty = b(a.owns_property);
  const hasDependents = b(a.has_dependents);
  const selfEmployed = b(a.self_employed);
  const hasInvestments = b(a.has_investments);
  const tracksHealth = b(a.tracks_health);
  const employedW2 = b(a.employed_w2);
  const wantsRecords = b(a.wants_records);

  const cat = catalog();
  const out: ProposedDomain[] = [];

  // Helper to push a spec with a chosen recommended flag + optional reason.
  const push = (key: string, recommended: boolean, reason?: string) => {
    const spec = cat[key];
    if (!spec) return;
    out.push({
      name: spec.name,
      label: spec.label,
      emoji: spec.emoji,
      summary: spec.summary,
      reason: reason ?? spec.reason,
      recommended,
      starterGoals: [...spec.starterGoals],
      suggestedSkills: [...spec.suggestedSkills],
    });
  };

  // --- CORE pillars (always proposed) ---
  // Wealth: always pre-selected; investments make the case even stronger.
  push(
    "wealth",
    true,
    hasInvestments
      ? "You hold investments — a wealth domain anchors net worth, accounts, and portfolio cash flow."
      : undefined,
  );

  // Health: pre-selected when the user tracks health; otherwise still offered.
  push(
    "health",
    tracksHealth,
    tracksHealth
      ? "You actively track your health — activity, weight, and appointments get a dedicated home."
      : "A balanced life-OS usually includes health; offered in case you want activity and weight tracking.",
  );

  // Career: pre-selected for W-2 employees; offered otherwise.
  push(
    "career",
    employedW2,
    employedW2
      ? "You're employed (W-2) — career anchors your primary income, comp, and growth."
      : "Career is offered for primary-income tracking even if you're not currently W-2.",
  );

  // Home: pre-selected when they own property; offered otherwise.
  push(
    "home",
    ownsProperty,
    ownsProperty
      ? "You own property — home keeps household maintenance, utilities, and logistics in order."
      : "Home is offered for household logistics — maintenance, utilities, and recurring chores.",
  );

  // Records: offered by default; pre-selected only if the user asked for it.
  push("records", wantsRecords);

  // --- CONDITIONAL adds ---
  if (hasInvestments || selfEmployed) {
    push("tax", true);
  }
  if (ownsProperty) {
    push("real-estate", true);
  }
  if (hasDependents || ownsProperty) {
    push("insurance", true);
  }
  if (selfEmployed) {
    push("business", true);
  }
  if (employedW2 && hasDependents) {
    push("benefits", true);
  }

  const recommendedNames = out.filter((d) => d.recommended).map((d) => d.label);
  const focusNote = typeof a.focus === "string" && a.focus.trim().length > 0
    ? ` You described your focus as "${a.focus.trim()}".`
    : "";
  const rationale =
    `Based on your answers, the recommended starter set is ${joinList(recommendedNames)}.` +
    ` These are pre-selected; the rest are offered as optional adds you can pick or skip.` +
    focusNote;

  return {
    domains: out,
    rationale: clamp(rationale, 2000),
    generated_at: new Date().toISOString(),
  };
}

function joinList(items: string[]): string {
  if (items.length === 0) return "(none — pick from the optional list)";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// =============================================================================
// applyOnboarding — scaffold the picked domains. Idempotent.
//
// For each pick (deduped, slug-validated):
//   1. scaffoldDomain (skipped if it already exists — that's fine).
//   2. ensureManifest (creates manifest.json + seeds MEMORY.md).
//   3. seed starter goals + suggested skills onto the manifest IF the manifest
//      was freshly created / still empty (never clobbers a user's edits).
//   4. overwrite the generic config.md with the richer starter config IF the
//      config.md is still the scaffold default (heuristic: empty key/value row).
//   5. create the _drop/ inbox.
//
// Returns the Domain[] for the picked names by re-scanning the vault — the same
// shape `prevail domains --json` emits, filtered to the picks.
// =============================================================================

export function applyOnboarding(vaultPath: string, picks: string[]): Domain[] {
  const cat = catalog();

  // Normalize + dedupe picks, preserving order, dropping unsafe/empty names.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of picks ?? []) {
    if (typeof raw !== "string") continue;
    const slug = slugify(raw);
    if (!slug || !isSafeEntryName(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    names.push(slug);
  }

  for (const name of names) {
    const dir = join(vaultPath, name);
    const existedBefore = existsSync(dir);

    // 1. Scaffold. If it already exists, scaffoldDomain returns ok:false — we
    //    treat that as "already there" and continue filling in the rest.
    scaffoldDomain(vaultPath, name);

    const spec = cat[name];

    // For a freshly scaffolded *known* domain, replace the generic starter
    // state.md / config.md with the richer, purpose-specific versions. We only
    // do this when the domain did not exist before, so we never overwrite a
    // human's content.
    if (!existedBefore && spec) {
      safeWrite(join(dir, "state.md"), spec.state);
      safeWrite(join(dir, "config.md"), spec.config);
    } else if (spec) {
      // Domain pre-existed: only upgrade config.md if it's still the bare
      // scaffold default (an empty key/value table), never otherwise.
      maybeUpgradeConfig(join(dir, "config.md"), spec.config);
    }

    // 2. Manifest (creates manifest.json + MEMORY.md). Idempotent.
    const manifest = ensureManifest(vaultPath, name);

    // 3. Seed identity + starter goals/skills onto the manifest, but only fill
    //    blanks — never clobber values the user (or an earlier apply) set.
    if (spec) {
      let changed = false;
      if (!manifest.identity.label || manifest.identity.label === defaultLabelOf(name)) {
        manifest.identity.label = spec.label;
        changed = true;
      }
      if (!manifest.identity.emoji) {
        manifest.identity.emoji = spec.emoji;
        changed = true;
      }
      if (!manifest.identity.summary) {
        manifest.identity.summary = spec.summary;
        changed = true;
      }
      if (manifest.goals.length === 0 && spec.starterGoals.length > 0) {
        manifest.goals = [...spec.starterGoals];
        changed = true;
      }
      if (manifest.config.skills.length === 0 && spec.suggestedSkills.length > 0) {
        manifest.config.skills = [...spec.suggestedSkills];
        changed = true;
      }
      if (changed) writeManifest(vaultPath, name, manifest);
    }

    // 5. Create the _drop/ inbox (immutable-zone for agents, but the
    //    onboarding scaffolder may create the directory itself).
    const drop = join(dir, "_drop");
    if (!existsSync(drop)) {
      try {
        mkdirSync(drop, { recursive: true });
      } catch {
        /* best effort — a missing _drop never blocks onboarding */
      }
    }
  }

  // Return the Domain records (same shape as `prevail domains`) for the picks.
  const all = scanVault(vaultPath);
  const want = new Set(names);
  return all.filter((d) => want.has(d.name));
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function defaultLabelOf(domain: string): string {
  return domain
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function safeWrite(file: string, body: string): void {
  try {
    writeFileSync(file, body);
  } catch {
    /* best effort */
  }
}

// True when config.md looks like the untouched scaffold default: it contains an
// empty key/value table row (`|  |  |`) and no filled summary line.
function maybeUpgradeConfig(file: string, body: string): void {
  if (!existsSync(file)) {
    safeWrite(file, body);
    return;
  }
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const looksDefault = /\|\s*\|\s*\|/.test(current) && !/^\s*summary\s*:/im.test(current);
  if (looksDefault) safeWrite(file, body);
}

// =============================================================================
// Command handlers — argv-driven, reading their JSON payload from stdin and
// writing the frozen --json contract (success value or error envelope) to
// stdout. Return the process exit code (0 success, 1 failure). The index
// dispatcher wires `onboard recommend` / `onboard apply` to these.
//
// commands: ["onboard recommend", "onboard apply"]
// =============================================================================

interface OnboardSubArgs {
  json: boolean;
  vaultPath: string | null;
}

function parseOnboardArgs(args: string[], vaultOverride: string | null): OnboardSubArgs {
  let json = false;
  let vaultPath = vaultOverride;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--vault" || a === "-d") {
      const next = args[i + 1];
      if (next) {
        vaultPath = resolve(process.cwd(), next);
        i++;
      }
    } else if (a.startsWith("--vault=")) {
      vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    }
  }
  return { json, vaultPath };
}

async function readJsonStdin(): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitError(message: string, code: string): void {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, code })}\n`);
}

/**
 * Handler for `prevail onboard recommend --json`.
 * Reads `{ "answers": { ... } }` (or a bare answers object) from stdin and
 * writes an OnboardingRecommendation. Returns the exit code.
 */
export async function onboardRecommendCommand(
  args: string[],
  vaultOverride: string | null,
): Promise<number> {
  const { json } = parseOnboardArgs(args, vaultOverride);
  if (!json) {
    console.error("prevail onboard recommend is a machine-only command — pass --json.");
    return 1;
  }

  let payload: unknown;
  try {
    payload = await readJsonStdin();
  } catch (err) {
    emitError(`invalid JSON on stdin: ${(err as Error).message}`, "BAD_JSON");
    return 1;
  }

  // Accept either `{ answers: {...} }` or a bare answers object.
  const answers = extractAnswers(payload);
  try {
    const rec = recommendDomains(answers);
    emitJson(rec);
    return 0;
  } catch (err) {
    emitError((err as Error).message, "RECOMMEND_FAILED");
    return 1;
  }
}

/**
 * Handler for `prevail onboard apply --json`.
 * Reads `{ "picks": ["wealth", ...] }` (or a bare array) from stdin, scaffolds
 * the domains, and writes the resulting Domain[]. Returns the exit code.
 */
export async function onboardApplyCommand(
  args: string[],
  vaultOverride: string | null,
): Promise<number> {
  const { json, vaultPath } = parseOnboardArgs(args, vaultOverride);
  if (!json) {
    console.error("prevail onboard apply is a machine-only command — pass --json.");
    return 1;
  }
  if (!vaultPath) {
    emitError("no vault path configured", "VAULT_NOT_FOUND");
    return 1;
  }
  if (!existsSync(vaultPath)) {
    emitError(`vault path not found: ${vaultPath}`, "VAULT_NOT_FOUND");
    return 1;
  }

  let payload: unknown;
  try {
    payload = await readJsonStdin();
  } catch (err) {
    emitError(`invalid JSON on stdin: ${(err as Error).message}`, "BAD_JSON");
    return 1;
  }

  const picks = extractPicks(payload);
  if (picks.length === 0) {
    emitError("no picks provided (expected { \"picks\": [\"wealth\", ...] })", "MISSING_ARG");
    return 1;
  }

  try {
    const domains = applyOnboarding(vaultPath, picks);
    emitJson(domains);
    return 0;
  } catch (err) {
    emitError((err as Error).message, "APPLY_FAILED");
    return 1;
  }
}

function extractAnswers(payload: unknown): OnboardingAnswers {
  if (!payload || typeof payload !== "object") return {};
  const o = payload as Record<string, unknown>;
  if (o.answers && typeof o.answers === "object" && !Array.isArray(o.answers)) {
    return o.answers as OnboardingAnswers;
  }
  return o as OnboardingAnswers;
}

function extractPicks(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter((x): x is string => typeof x === "string");
  }
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.picks)) {
      return o.picks.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}
