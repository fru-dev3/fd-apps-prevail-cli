// rubrics — domain-intelligent relevance scoring.
//
// The 6 frozen dimensions in score.ts measure STRUCTURE (does the domain have
// state/config/logs, is it fresh, is it dense). They are domain-agnostic: a
// perfectly-structured Taxes domain and a perfectly-structured Health domain
// score the same even if Taxes is missing every tax document that matters.
//
// This module adds the missing half: a curated, per-domain RUBRIC of the
// context that is actually RELEVANT to that domain — for Taxes, a recent
// return and W-2s; for Health, the insurance card, deductible, premium, PCP.
// It detects which expected items are present (and fresh) from the domain's
// files, scores domain-fit 0-100, and emits concrete recommendations for the
// gaps. score.ts blends this into the headline ONLY when a rubric matches, so
// unknown/custom domains and the deterministic golden tests are unaffected.
//
// Detection is heuristic (keyword match over data/ filenames + the domain's
// state/config/soul/goals text). It is deliberately deterministic and
// network-free; the optional LLM audit in score.ts can refine it further.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RubricItem {
  id: string;
  /** Human label, e.g. "Most recent tax return". */
  label: string;
  /** Lowercased substrings; item is "present" if any appears in the haystack. */
  detect: string[];
  /** If set, a present item older than this many days is "stale" (half credit). */
  freshDays?: number;
  /** Relative importance within the domain. */
  weight: number;
  severity: "critical" | "warn" | "info";
  /** Shown when the item is missing or stale — the concrete next action. */
  recommend: string;
}

export interface RelevanceItem {
  id: string;
  label: string;
  present: boolean;
  stale: boolean;
  severity: string;
  detail: string;
  recommend: string;
}

export interface DomainRelevance {
  /** Which rubric matched (canonical key), e.g. "taxes". */
  matched: string;
  /** 0-100 domain-fit score. */
  score: number;
  detail: string;
  items: RelevanceItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// The rubrics. Each entry is the context a well-formed instance of that domain
// SHOULD contain. Keyed by canonical domain; aliases resolve in resolveRubricKey.
// =============================================================================

export const DOMAIN_RUBRICS: Record<string, RubricItem[]> = {
  chief: [
    { id: "mission", label: "Mission / vision statement", detect: ["mission", "vision", "north star", "purpose"], weight: 3, severity: "warn", recommend: "Write a one-paragraph mission for your life — the north star everything else serves." },
    { id: "priorities", label: "Current top priorities / OKRs", detect: ["priorit", "okr", "objective", "focus", "q1", "q2", "q3", "q4"], freshDays: 90, weight: 3, severity: "warn", recommend: "Record this quarter's 3-5 priorities so the agent can align every domain to them." },
    { id: "review", label: "Weekly / monthly review cadence", detect: ["weekly review", "monthly review", "retro", "cadence", "check-in"], freshDays: 30, weight: 2, severity: "info", recommend: "Log a recurring review cadence — when you step back and reassess." },
    { id: "stakeholders", label: "Key people / stakeholders", detect: ["stakeholder", "contacts", "people", "team", "family", "partner"], weight: 1, severity: "info", recommend: "List the key people in your life and their roles." },
  ],
  taxes: [
    { id: "recent_return", label: "Most recent filed return", detect: ["return", "1040", "filed", "filing"], freshDays: 420, weight: 3, severity: "critical", recommend: "Add your most recent tax return (1040) to data/ — it anchors everything." },
    { id: "income_docs", label: "Income documents (W-2 / 1099)", detect: ["w-2", "w2", "1099", "income statement", "wage"], freshDays: 420, weight: 3, severity: "warn", recommend: "Add this year's W-2 / 1099 income documents." },
    { id: "filing_status", label: "Filing status", detect: ["filing status", "married", "single", "head of household", "jointly"], weight: 1, severity: "info", recommend: "Record your filing status (single / married filing jointly / etc.)." },
    { id: "quarterly", label: "Estimated quarterly payments", detect: ["quarterly", "estimated payment", "1040-es", "estimated tax"], freshDays: 120, weight: 2, severity: "warn", recommend: "Track estimated quarterly payments and due dates if you owe them." },
    { id: "deductions", label: "Deductions / credits tracked", detect: ["deduction", "credit", "write-off", "itemiz", "charitable"], weight: 2, severity: "info", recommend: "Log deductions and credits you're claiming so nothing is left on the table." },
    { id: "preparer", label: "CPA / preparer contact", detect: ["cpa", "preparer", "accountant", "tax advisor"], weight: 1, severity: "info", recommend: "Save your CPA or preparer's contact details." },
    { id: "deadlines", label: "Upcoming tax deadlines", detect: ["deadline", "april 15", "due date", "extension"], freshDays: 200, weight: 1, severity: "info", recommend: "Note the next filing and payment deadlines." },
  ],
  wealth: [
    { id: "net_worth", label: "Net worth figure", detect: ["net worth", "networth", "net-worth"], freshDays: 90, weight: 3, severity: "warn", recommend: "Record your current net worth — the single number this domain orbits." },
    { id: "accounts", label: "Account inventory", detect: ["account", "checking", "savings", "brokerage", "401k", "ira", "balance"], weight: 3, severity: "warn", recommend: "List your accounts (checking, savings, brokerage, retirement) and balances." },
    { id: "allocation", label: "Asset allocation", detect: ["allocation", "portfolio", "stocks", "bonds", "70/30", "60/40", "equities"], freshDays: 120, weight: 2, severity: "info", recommend: "Capture your target and current asset allocation." },
    { id: "savings_rate", label: "Savings rate / cash flow", detect: ["savings rate", "cash flow", "income", "expenses", "budget"], freshDays: 60, weight: 2, severity: "info", recommend: "Track your savings rate or monthly cash flow." },
    { id: "statements", label: "Recent statements", detect: ["statement", ".pdf", "december", "january", "monthly"], freshDays: 60, weight: 1, severity: "info", recommend: "Drop in a recent account statement so figures stay current." },
    { id: "goals", label: "Financial goals with targets", detect: ["goal", "target", "retire", "milestone", "fire", "freedom"], weight: 2, severity: "warn", recommend: "Define financial goals with concrete dollar targets and dates." },
  ],
  calendar: [
    { id: "upcoming", label: "Upcoming events / commitments", detect: ["event", "meeting", "appointment", "upcoming", "schedule"], freshDays: 14, weight: 3, severity: "warn", recommend: "List your upcoming commitments so the agent can plan around them." },
    { id: "routines", label: "Recurring routines", detect: ["routine", "recurring", "weekly", "daily", "habit"], weight: 2, severity: "info", recommend: "Capture your recurring routines (gym, standups, family time)." },
    { id: "key_dates", label: "Key dates / deadlines", detect: ["birthday", "anniversary", "deadline", "due", "renewal"], weight: 2, severity: "info", recommend: "Record key dates — birthdays, renewals, deadlines." },
    { id: "timeblocks", label: "Time-blocking plan", detect: ["time block", "time-block", "focus block", "calendar plan"], freshDays: 14, weight: 1, severity: "info", recommend: "Define how you want your week time-blocked." },
  ],
  health: [
    { id: "insurance_card", label: "Health insurance plan / card", detect: ["insurance card", "health plan", "member id", "policy number", "carrier", "blue cross", "aetna", "cigna", "united"], freshDays: 400, weight: 3, severity: "critical", recommend: "Add your health insurance plan details (carrier, member ID) — critical in an emergency." },
    { id: "deductible", label: "Deductible", detect: ["deductible", "out-of-pocket", "out of pocket", "oop max"], weight: 2, severity: "warn", recommend: "Record your annual deductible and out-of-pocket max." },
    { id: "premium", label: "Premium", detect: ["premium", "monthly cost", "per month"], weight: 1, severity: "info", recommend: "Note your monthly health insurance premium." },
    { id: "pcp", label: "Primary care physician", detect: ["pcp", "primary care", "doctor", "physician", "dr."], weight: 2, severity: "warn", recommend: "Save your primary care physician's name and contact." },
    { id: "medications", label: "Medications", detect: ["medication", "prescription", "rx", "dose", "mg "], freshDays: 180, weight: 2, severity: "warn", recommend: "List current medications and dosages." },
    { id: "allergies", label: "Allergies", detect: ["allerg", "reaction", "intoleran"], weight: 2, severity: "warn", recommend: "Record any allergies — another emergency-critical fact." },
    { id: "labs", label: "Recent labs / vitals", detect: ["lab", "blood", "vitals", "cholesterol", "a1c", "blood pressure", "weight", "bmi"], freshDays: 365, weight: 1, severity: "info", recommend: "Add recent lab results or vitals to track trends." },
    { id: "emergency", label: "Emergency contact", detect: ["emergency contact", "ice ", "next of kin"], weight: 1, severity: "info", recommend: "Set an emergency contact." },
  ],
  home: [
    { id: "address", label: "Address", detect: ["address", "street", "zip", "apt", "unit"], weight: 1, severity: "info", recommend: "Record your home address." },
    { id: "mortgage", label: "Mortgage / lease terms", detect: ["mortgage", "lease", "rent", "loan", "interest rate", "landlord"], weight: 3, severity: "warn", recommend: "Capture mortgage or lease terms (rate, payment, term, landlord)." },
    { id: "value", label: "Home value", detect: ["home value", "appraisal", "zestimate", "market value", "equity"], freshDays: 180, weight: 1, severity: "info", recommend: "Note your home's current value or recent appraisal." },
    { id: "maintenance", label: "Maintenance log", detect: ["maintenance", "repair", "serviced", "hvac", "furnace", "roof", "gutter"], freshDays: 180, weight: 2, severity: "info", recommend: "Start a maintenance log — what was serviced and when." },
    { id: "warranties", label: "Warranties / appliances", detect: ["warranty", "appliance", "model number", "serial"], weight: 1, severity: "info", recommend: "Inventory appliances and their warranties." },
    { id: "providers", label: "Service providers / contractors", detect: ["plumber", "electrician", "contractor", "handyman", "cleaner", "lawn"], weight: 2, severity: "info", recommend: "Save trusted service providers (plumber, electrician, etc.)." },
    { id: "insurance", label: "Home insurance policy", detect: ["home insurance", "homeowner", "policy", "coverage"], freshDays: 400, weight: 2, severity: "warn", recommend: "Add your homeowner / renter insurance policy." },
  ],
  insurance: [
    { id: "policies", label: "Policy inventory", detect: ["policy", "auto insurance", "home insurance", "life insurance", "health insurance", "coverage"], weight: 3, severity: "critical", recommend: "List every policy you hold (auto, home, life, health) in one place." },
    { id: "premiums", label: "Premiums", detect: ["premium", "monthly cost", "annual cost", "per month"], weight: 2, severity: "warn", recommend: "Record each policy's premium." },
    { id: "deductibles", label: "Deductibles", detect: ["deductible", "out-of-pocket"], weight: 2, severity: "warn", recommend: "Record each policy's deductible." },
    { id: "limits", label: "Coverage limits", detect: ["coverage limit", "limit", "liability", "dwelling", "bodily injury"], weight: 2, severity: "info", recommend: "Note coverage limits so you know if you're under-insured." },
    { id: "renewals", label: "Renewal dates", detect: ["renewal", "expires", "expiration", "renew", "term ends"], freshDays: 365, weight: 2, severity: "warn", recommend: "Track renewal / expiration dates to avoid lapses." },
    { id: "agent", label: "Agent / broker contact", detect: ["agent", "broker", "representative", "claims number"], weight: 1, severity: "info", recommend: "Save your agent or broker's contact and the claims line." },
  ],
  learning: [
    { id: "goals", label: "Learning goals", detect: ["goal", "want to learn", "objective", "skill to"], weight: 3, severity: "warn", recommend: "Define what you're trying to learn and why." },
    { id: "in_progress", label: "Courses / books in progress", detect: ["course", "book", "reading", "tutorial", "currently", "studying"], freshDays: 30, weight: 3, severity: "warn", recommend: "List the courses or books you're working through now." },
    { id: "skills", label: "Skills to develop", detect: ["skill", "competency", "proficien", "master"], weight: 1, severity: "info", recommend: "Name the specific skills you want to build." },
    { id: "milestones", label: "Completed milestones", detect: ["completed", "finished", "milestone", "certificate", "done"], freshDays: 90, weight: 1, severity: "info", recommend: "Log what you've completed to see momentum." },
    { id: "resources", label: "Resources / reading list", detect: ["resource", "reading list", "bookmark", "link", "reference"], weight: 2, severity: "info", recommend: "Keep a running resource / reading list." },
  ],
  explore: [
    { id: "interests", label: "Interests / hobbies", detect: ["interest", "hobby", "hobbies", "passion", "curious"], weight: 2, severity: "info", recommend: "Capture your current interests and hobbies." },
    { id: "bucket", label: "Bucket list", detect: ["bucket", "wishlist", "want to", "someday", "dream"], weight: 2, severity: "info", recommend: "Start a bucket list of things you want to experience." },
    { id: "places", label: "Places to visit", detect: ["place", "travel", "trip", "visit", "destination", "city", "country"], weight: 2, severity: "info", recommend: "List places you want to visit." },
    { id: "activities", label: "Activities to try", detect: ["activity", "try", "class", "experience", "adventure"], freshDays: 90, weight: 2, severity: "info", recommend: "Note activities or experiences you want to try." },
    { id: "log", label: "Experiences log", detect: ["did", "went", "visited", "tried", "loved", "rated"], freshDays: 90, weight: 1, severity: "info", recommend: "Log experiences you've had and what you thought." },
  ],
  mail: [
    { id: "accounts", label: "Connected accounts", detect: ["account", "@", "gmail", "outlook", "inbox", "email address"], weight: 2, severity: "warn", recommend: "List the email accounts this domain covers." },
    { id: "contacts", label: "Important contacts", detect: ["contact", "from:", "sender", "important people"], weight: 2, severity: "info", recommend: "Note the senders that always matter." },
    { id: "followups", label: "Follow-ups / waiting-on", detect: ["follow up", "follow-up", "waiting on", "awaiting", "reply", "respond"], freshDays: 7, weight: 3, severity: "warn", recommend: "Track what you're waiting on and what needs a reply." },
    { id: "subscriptions", label: "Subscriptions / newsletters", detect: ["subscription", "newsletter", "unsubscribe", "digest"], weight: 1, severity: "info", recommend: "Inventory subscriptions and newsletters to prune." },
    { id: "filing", label: "Filing / label scheme", detect: ["label", "folder", "filter", "archive", "filing"], weight: 1, severity: "info", recommend: "Define a labeling / filing scheme so mail stays sorted." },
  ],
};

// Aliases → canonical rubric key. Lowercased domain name is matched first
// exactly, then against this map.
const ALIASES: Record<string, string> = {
  tax: "taxes",
  finance: "wealth",
  financial: "wealth",
  money: "wealth",
  investing: "wealth",
  schedule: "calendar",
  scheduling: "calendar",
  agenda: "calendar",
  wellness: "health",
  fitness: "health",
  medical: "health",
  house: "home",
  household: "home",
  property: "home",
  education: "learning",
  learn: "learning",
  study: "learning",
  growth: "learning",
  fun: "explore",
  adventure: "explore",
  travel: "explore",
  email: "mail",
  emails: "mail",
  inbox: "mail",
  exec: "chief",
  executive: "chief",
  overview: "chief",
  command: "chief",
};

export function resolveRubricKey(domain: string): string | null {
  const d = domain.trim().toLowerCase();
  if (d in DOMAIN_RUBRICS) return d;
  if (d in ALIASES) return ALIASES[d];
  // singular/plural tolerance
  if (d.endsWith("s") && d.slice(0, -1) in DOMAIN_RUBRICS) return d.slice(0, -1);
  if (`${d}s` in DOMAIN_RUBRICS) return `${d}s`;
  return null;
}

// -----------------------------------------------------------------------------
// Detection helpers.
// -----------------------------------------------------------------------------

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function safeMtime(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// Walk data/ (+ a couple of legacy tiers) up to `depth` levels, collecting
// { name, mtime } for every file. Names feed keyword detection; mtimes feed
// per-item freshness. Bounded and error-swallowing.
function collectDataFiles(dir: string, depth = 3): Array<{ name: string; mtime: number }> {
  const roots = [join(dir, "data"), join(dir, "00_current"), join(dir, "01_prior")];
  const out: Array<{ name: string; mtime: number }> = [];
  const walk = (p: string, left: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(full, left - 1);
      } else if (e.isFile()) {
        out.push({ name: e.name, mtime: safeMtime(full) ?? 0 });
      }
    }
  };
  for (const r of roots) {
    if (existsSync(r)) walk(r, depth);
  }
  return out;
}

export interface RelevanceInputs {
  domain: string;
  dir: string;
  /** Already-read state/config text from the snapshot (avoids re-reading). */
  stateText: string;
  configText: string;
  /** mtime of the freshest knowledge file, for text-only freshness fallback. */
  textMtime: number | null;
}

// Evaluate the domain's rubric. Returns null when no rubric matches the domain
// (custom domains) — score.ts then leaves the headline as the structural-only
// roll-up.
export function evaluateRelevance(inp: RelevanceInputs): DomainRelevance | null {
  const key = resolveRubricKey(inp.domain);
  if (!key) return null;
  const rubric = DOMAIN_RUBRICS[key];

  const dataFiles = collectDataFiles(inp.dir);
  const soulText = safeRead(join(inp.dir, "soul.md"));
  const goalsText = safeRead(join(inp.dir, "goals.md"));
  const fileNamesLower = dataFiles.map((f) => f.name.toLowerCase());
  const newestDataMtime = dataFiles.reduce((m, f) => Math.max(m, f.mtime), 0);

  const haystack = [
    fileNamesLower.join(" "),
    inp.stateText,
    inp.configText,
    soulText,
    goalsText,
  ]
    .join(" \n ")
    .toLowerCase();

  const now = Date.now();
  const items: RelevanceItem[] = [];
  let gotWeight = 0;
  let totalWeight = 0;
  let presentCount = 0;
  let staleCount = 0;

  for (const it of rubric) {
    totalWeight += it.weight;
    const matchedFile = it.detect.some((k) => fileNamesLower.some((n) => n.includes(k)));
    const present = it.detect.some((k) => haystack.includes(k));

    let stale = false;
    let freshnessNote = "";
    if (present && it.freshDays != null) {
      // Prefer a matching data file's mtime; else the freshest knowledge file.
      const basis = matchedFile && newestDataMtime > 0 ? newestDataMtime : inp.textMtime ?? 0;
      if (basis > 0) {
        const ageDays = Math.floor((now - basis) / DAY_MS);
        stale = ageDays > it.freshDays;
        freshnessNote = stale ? ` · ${ageDays}d old (stale)` : ` · ${ageDays}d old`;
      }
    }

    if (present) {
      presentCount += 1;
      gotWeight += stale ? it.weight * 0.5 : it.weight;
      if (stale) staleCount += 1;
    }

    items.push({
      id: it.id,
      label: it.label,
      present,
      stale,
      severity: it.severity,
      detail: present ? `present${freshnessNote}` : "not found",
      recommend: it.recommend,
    });
  }

  const score = totalWeight === 0 ? 0 : Math.max(0, Math.min(100, Math.round((gotWeight / totalWeight) * 100)));
  const stalePart = staleCount > 0 ? ` (${staleCount} stale)` : "";
  const detail = `${presentCount} of ${rubric.length} expected ${key} items present${stalePart}`;

  return { matched: key, score, detail, items };
}
