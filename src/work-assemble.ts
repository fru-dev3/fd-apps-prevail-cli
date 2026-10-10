// Work mode's assembly step: before a task is dispatched, the chief of staff
// brings in the specialists the work needs (by what it asks: a search, a
// draft, numbers, a plan) and gathers what the vault already knows that the
// work will need (the user's home city for "near me", a person's page, an
// app's connection, the destination's notes). It all goes into the brief, so
// the agent never has to ask for something the vault knows; the panel shows
// each item as one plain line ("Your home city, from your profile").

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { domainDir } from "./decisions.ts";
import { listPages } from "./entities.ts";
import { readProfile } from "./goals.ts";
import { appRecords } from "./ia.ts";
import { loadSpecialists } from "./specialists.ts";
import type { RouteRunner } from "./route.ts";
import { topicOf, type KnownAnswer, type PlanKind } from "./work-learn.ts";
import { noDash, type RoutedTask } from "./work-router.ts";

/** One thing the vault knows that the work needs: `label` is the plain line on the card, `text` goes in the brief. */
export interface ContextItem { label: string; text: string }

// What the task asks for, by its words, and the specialist who does that.
const NEEDS: [RegExp, string][] = [
  [/\b(find|search|look (?:up|for|into)|research|any good|recommend|best|compare|where (?:is|are|can)|options for)\b/i, "researcher"],
  [/\b(draft|reply|respond|write|email|letter|message|note to)\b/i, "writer"],
  [/\b(numbers?|budget|costs?|prices?|spend|how much|analy[sz]e|calculate|totals?)\b/i, "analyst"],
  [/\b(plan|schedule|itinerary|steps|roadmap)\b/i, "planner"],
];

/** The specialists the work needs, by what it asks, added to the router's (three at most, only ones that are on). */
export function neededSpecialists(vault: string, t: Pick<RoutedTask, "text" | "shape" | "flags" | "specialists">): string[] {
  const on = new Set(loadSpecialists(vault).filter((s) => s.on).map((s) => s.id));
  const want = [...t.specialists];
  for (const [re, id] of NEEDS) if (re.test(t.text)) want.push(id);
  if (t.shape === "find") want.push("researcher");
  if (t.flags.numbers || t.flags.money) want.push("analyst");
  return [...new Set(want)].filter((id) => on.has(id)).slice(0, 3);
}

const NEAR = /\b(near me|around me|nearby|close to me|close by|in my area|local(?:ly)?|around here|near here|where i live)\b/i;
const LOCATION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:home city|location|city|hometown|lives? in|based in|home)(?:\*\*)?\s*[:=-]\s*(.{2,80}?)\s*$/im;
const LOCATION_SAID = /\b(?:I live in|I'm based in|I am based in|lives in|based in)\s+([A-Z][\w .,'-]{1,60}?)(?:[.;\n]|$)/;

/** Where the user lives, from their profile, then General's memory and notes. */
export function ownerLocation(vault: string): { text: string; from: string } | null {
  const read = (p: string) => { try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
  const general = domainDir(vault, "general");
  const sources: [string, string][] = [
    [readProfile(vault), "your profile"],
    [read(join(general, "memory", "memory.md")), "your General memory"],
    [read(join(general, "memory", "state.md")), "your General notes"],
  ];
  for (const [text, from] of sources) {
    const m = LOCATION_LINE.exec(text) ?? LOCATION_SAID.exec(text);
    const place = m?.[1]?.replace(/[*_`]+/g, "").trim();
    if (place) return { text: place, from };
  }
  return null;
}

const body = (raw: string, n: number) => maskIdentifiers(raw.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\s+/g, " ").trim().slice(0, n));

// ── Identifiers never reach the screen or a brief ──────────────────────────
// Vault notes hold account and card numbers, routing numbers, IBANs, SSNs
// and street addresses. Work mode quotes notes in plans, context lines and
// outcomes, so every such number is hidden before it is shown or stored.
const HIDDEN = "••••";
const ID_RULES: RegExp[] = [
  // An account, card or routing number by its label: "Savings 1234567890123", "acct #4521", "ending in 4521", "x4521", "****4521".
  /\b(?:acct|account|card|routing|aba|iban|member|policy|loan|checking|savings)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*(?:ending(?: in)?\s*)?[x*•]*\d[\d -]{2,}\d\b/gi,
  /\bending(?: in)?\s+\d{3,}\b/gi,
  /(?:\b[xX]{1,4}|[*•]{2,})[ -]?\d{3,}\b/g,
  // A long digit run (7+ digits, spaces or dashes allowed), not money and not a date: accounts, cards, SSNs, phones, ZIP+4.
  /(?<![$€£\d.,])\b\d(?:[ -]?\d){6,}\b(?![.,]\d)/g,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  // A street address: "1234 Foo Way".
  /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Way|St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Pl|Place|Cir|Circle|Pkwy|Parkway|Ter|Terrace|Trl|Trail|Hwy|Highway)\b\.?/g,
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The text with account, card and routing numbers, SSNs, IBANs and street addresses hidden. */
export function maskIdentifiers(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of ID_RULES) out = out.replace(re, (m) => (ISO_DATE.test(m.trim()) ? m : m.replace(/[x*•]*\d[\d x*•-]*\d|[x*•]*\d+/gi, HIDDEN)));
  return out;
}

/** The same, over everything a task shows: its updates, outcome, waiting line, context and activity. */
export function maskTask<T extends { updates?: { text: string; questions?: string[] }[]; outcome?: string; waiting?: string; context?: ContextItem[]; log?: { detail?: string; more?: string }[] }>(t: T): T {
  for (const u of t.updates ?? []) { u.text = maskIdentifiers(u.text); if (u.questions) u.questions = u.questions.map(maskIdentifiers); }
  if (t.outcome) t.outcome = maskIdentifiers(t.outcome);
  if (t.waiting) t.waiting = maskIdentifiers(t.waiting);
  for (const c of t.context ?? []) { c.label = maskIdentifiers(c.label); c.text = maskIdentifiers(c.text); }
  for (const l of t.log ?? []) { if (l.detail) l.detail = maskIdentifiers(l.detail); if (l.more) l.more = maskIdentifiers(l.more); }
  return t;
}

/** What the vault knows that this task will need. Never throws; an empty list when nothing fits. */
export function gatherContext(vault: string, t: Pick<RoutedTask, "text" | "dest">): ContextItem[] {
  const out: ContextItem[] = [];
  try {
    if (NEAR.test(t.text)) {
      const loc = ownerLocation(vault);
      if (loc) out.push({ label: `Your home city, from ${loc.from}`, text: `The user's home city: ${loc.text}. "Near me" means near there.` });
    }
  } catch { /* no profile */ }
  const d = t.dest;
  try {
    if (d?.entity) {
      const p = listPages(vault).find((x) => x.id === d.entity);
      if (p) {
        const text = body(readFileSync(join(vault, p.path), "utf8"), 800);
        if (text) out.push({ label: `${p.doc.name}'s page`, text: `About ${p.doc.name}: ${text}` });
      }
    }
  } catch { /* no page */ }
  try {
    if (d?.kind === "app") {
      const a = appRecords(vault).find((x) => x.id === d.id);
      if (a) out.push({ label: `Your ${a.title} connection`, text: `The user's ${a.title} app is connected in Prevail${a.domains.length ? ` (${a.domains.join(", ")})` : ""}; its records are in data/apps/${a.id}/.` });
    }
  } catch { /* no apps */ }
  try {
    if (d?.kind === "domain" && d.id !== "general") {
      const state = body(readFileSync(join(domainDir(vault, d.id), "memory", "state.md"), "utf8"), 600);
      if (state) out.push({ label: `${d.label} notes`, text: `Where ${d.label} stands: ${state}` });
    }
  } catch { /* no notes */ }
  return out;
}

// ── Plan before doing ───────────────────────────────────────────────────────
// A task that spends money or time, commits the user, or touches their health
// is never just done: the chief of staff first reads what the vault knows,
// names the domains it touches, and asks the two to four things it cannot
// know (where, when, budget, what for). The task waits as Needs you with that
// plan in its updates; the owner's one reply starts the work, which then
// proposes before anything spends money. A small, fully specified ask (a
// summary, a lookup, a draft) goes straight through.

const TRAVEL = /\b(trip|travel|vacation|holiday|getaway|flights?|hotels?|itinerary|cruise|visit (?:to )?[A-Z])\b/i;
const SPEND = /\b(book|buy|purchase|order|pay|reserve|subscribe|invest|donate|transfer|hire|rent|lease|sign up|enrol+)\b/i;
const HEALTH = /\b(appointment|doctor|dentist|surgery|clinic|therapy|prescription|vaccin\w*)\b/i;
const WHEN = /\b(today|tomorrow|tonight|this (?:week|weekend|month)|next (?:week|weekend|month|year)|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;
const BUDGET = /(\$|€|£|\busd\b|\beur\b|\bbudget\b|\bunder \d|\bat most \d|\bup to \d)/i;
const WHY = /\b(for (?:my|our|the|a|an)|because|so (?:that|we|i)|to (?:see|visit|celebrate|rest|meet|attend))\b/i;

/** Domain slugs that exist in this vault, first match per concept (money, then wealth...). */
function pickDomains(vault: string, wanted: string[][]): string[] {
  const out: string[] = [];
  for (const options of wanted) {
    const hit = options.find((d) => existsSync(join(vault, "data", "domains", d)));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Lines in a domain's memory and notes that match, for the plan's "what I found". */
function domainLines(vault: string, slug: string, re: RegExp, n = 2): string[] {
  const out: string[] = [];
  for (const f of ["memory.md", "state.md"]) {
    try {
      for (const raw of readFileSync(join(domainDir(vault, slug), "memory", f), "utf8").split("\n")) {
        const l = maskIdentifiers(raw.replace(/^[\s>*#-]+/, "").replace(/[*_`]+/g, "").trim());
        if (l.length > 6 && l.length < 220 && re.test(l) && !out.includes(l)) out.push(l);
        if (out.length >= n) return out;
      }
    } catch { /* no file */ }
  }
  return out;
}

/** A note about an account rather than a budget: its balance, rate, interest or number. */
const ACCOUNT_LINE = /\b(balance|apy|apr|interest|account|acct|routing|iban|statement|net worth|card)\b/i;

const READ_ONLY = new Set(["understand", "find", "learn", "reflect"]);

export interface TaskPlan {
  /** What kind of plan: its answers are remembered per kind (travel, purchase, health). */
  kind: PlanKind;
  /** Every domain it touches, by concept (money, travel, health...), that exists in the vault. */
  domains: string[];
  /** What the vault already knows that bears on it: into the task's context and the brief. */
  found: ContextItem[];
  /** Two to four things only the user can say; none when what he said before answers them all. */
  questions: string[];
  /** The plan as the task says it, one short paragraph. */
  say: string;
  /** The lessons it used (answers the owner gave before), for the learned line and "forget that". */
  used: KnownAnswer[];
}

/** The model's judgement: does the task need a plan with the owner first? */
export interface PlanJudgement { underSpecified: boolean; highImpact: boolean; questions: string[]; domains: string[] }

const PLAN_SYSTEM = [
  "You decide whether a task needs a short plan with its owner before an agent does it.",
  "under_specified: the ask leaves out something only the owner can say (where, when, budget, who, what for) and it changes the result.",
  "high_impact: it spends money or much time, commits the owner, affects other people, or touches health, legal matters or identity.",
  "A small, fully specified, low-stakes ask (summarise a note, look something up, draft a reply) is neither.",
  "A question about the owner's own life, work, priorities, notes or records is answered from the vault: it is never under-specified. Never ask where something is kept or tracked; the agent looks.",
  "When either is true, give 2 to 4 short, specific questions only the owner can answer, and the life areas it touches from the list.",
  'Reply with ONLY JSON: {"under_specified":<bool>,"high_impact":<bool>,"questions":["..."],"domains":["<listed area>"]}',
  "No em dashes. Plain words.",
].join("\n");

/** Read the judgement from a reply; null when it is not one. */
export function parsePlanJudgement(raw: string): PlanJudgement | null {
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
    if (typeof j.under_specified !== "boolean" || typeof j.high_impact !== "boolean") return null;
    const list = (x: unknown, n: number, len: number) => (Array.isArray(x) ? x : []).filter((q): q is string => typeof q === "string" && !!q.trim()).map((q) => noDash(q.replace(/\s+/g, " ")).trim().slice(0, len)).slice(0, n);
    return { underSpecified: j.under_specified, highImpact: j.high_impact, questions: list(j.questions, 4, 200), domains: list(j.domains, 4, 40).map((d) => d.toLowerCase()) };
  } catch { return null; }
}

/**
 * The model judges under-specified or not, high or low impact (the cheap
 * router runner). Null with no model (runner null, bunker mode) or on any
 * failure: the keyword check in planTask decides then.
 */
export async function judgePlan(text: string, domains: string[], runner?: RouteRunner | null): Promise<PlanJudgement | null> {
  if (runner === null || process.env.PREVAIL_BUNKER === "1") return null;
  try {
    const run = runner ?? (await import("./route.ts")).claudeRouteRunner;
    return parsePlanJudgement(await run({ system: PLAN_SYSTEM, prompt: `Life areas: ${domains.join(", ")}\nTask: ${text.slice(0, 2000)}`, timeoutMs: 20_000, maxChars: 1200 }));
  } catch { return null; }
}

/**
 * The plan for an under-specified or high-impact task; null when it can go
 * straight through. The model's judgement decides when there is one, the
 * keywords otherwise. What the owner said before (`known`) answers its
 * questions, so they get fewer. Never throws.
 */
export function planTask(vault: string, t: Pick<RoutedTask, "text" | "flags"> & { shape?: RoutedTask["shape"] }, o: { judged?: PlanJudgement | null; known?: (kind: PlanKind) => KnownAnswer[] } = {}): TaskPlan | null {
  const text = t.text;
  const travel = TRAVEL.test(text);
  const spend = SPEND.test(text) || !!t.flags.money;
  const health = HEALTH.test(text);
  const judged = o.judged ?? null;
  if (judged ? !judged.underSpecified && !judged.highImpact : !travel && !spend && !health) return null;
  // A read-only ask (what are my priorities, what did I note) commits nothing: it is answered from the vault, never planned first,
  // whatever the model says of its impact. A decision, travel, money or health still plans.
  if (READ_ONLY.has(t.shape ?? "") && !travel && !spend && !health && !t.flags.decision) return null;
  const kind: PlanKind = travel ? "travel" : spend ? "purchase" : health ? "health" : "other";
  try {
    const domains = pickDomains(vault, [
      ...(travel ? [["travel", "dreams", "adventures", "trips"]] : []),
      ...(spend || travel ? [["money", "wealth", "finance", "finances"]] : []),
      ...(health || travel ? [["health", "fitness"]] : []),
      ...(judged?.domains ?? []).map((d) => [d]),
    ]);
    const found: ContextItem[] = [];
    if (travel) {
      const trips = listPages(vault).filter((p) => (p.kind === "event" || p.kind === "place") && /\b(trip|travel|vacation|holiday|visit|flight)\b/i.test(`${p.doc.name} ${body(readFileSync(join(vault, p.path), "utf8"), 400)}`));
      for (const p of trips.slice(0, 2)) found.push({ label: `Your past trip: ${p.doc.name}`, text: `A past trip in the vault: ${p.doc.name}: ${body(readFileSync(join(vault, p.path), "utf8"), 300)}` });
      for (const d of domains.filter((x) => !["money", "wealth", "finance", "finances", "health", "fitness"].includes(x))) for (const l of domainLines(vault, d, /\b(trip|travel|visit|prefer|love|want|dream)\w*\b/i)) found.push({ label: `From your ${d} notes: ${l}`, text: `From the user's ${d} notes: ${l}` });
    }
    // Money and health lines go in the brief only, never quoted on screen; a line about an account (its balance, rate, number) is left out entirely.
    for (const d of domains.filter((x) => ["money", "wealth", "finance", "finances"].includes(x))) for (const l of domainLines(vault, d, /\b(budget|savings?|spend|fund|allowance|limit)\w*\b/i).filter((x) => !ACCOUNT_LINE.test(x))) found.push({ label: `Your ${d} notes on budget`, text: `From the user's ${d} notes: ${l}` });
    for (const d of domains.filter((x) => ["health", "fitness"].includes(x))) for (const l of domainLines(vault, d, /\b(allerg\w*|condition|avoid|knee|back|diet|medication|can't|cannot)\b/i, 1)) found.push({ label: `Your ${d} notes`, text: `From the user's ${d} notes: ${l}` });
    if (spend || travel) found.push({ label: "It proposes before paying", text: "Never buy, book or pay. Prepare options and a proposal (holds or drafts only) and ask the user before anything spends money." });

    let questions: string[] = [];
    if (judged?.questions.length) questions = [...judged.questions];
    else if (travel || spend || health) {
      const where = /\b(?:to|in|at)\s+([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)/.exec(text)?.[1];
      if (travel) questions.push(where ? `Where in ${where}: which cities or places?` : "Where would you like to go?");
      if (travel || health) { if (!WHEN.test(text)) questions.push(travel ? "When, and for how long?" : "When would suit you?"); }
      else if (!WHEN.test(text)) questions.push("When do you need it by?");
      if ((spend || travel) && !BUDGET.test(text)) questions.push("What budget should I keep to?");
      if (!WHY.test(text)) questions.push(travel ? "What is it for: rest, people, sights or work?" : "What is it for, so I pick the right one?");
    } else questions.push("What outcome do you want from it?", "When do you need it by?");
    // What the owner said before answers its question: fewer, sharper questions.
    const known = o.known?.(kind) ?? [];
    const used = known;
    questions = questions.filter((q) => !known.some((k) => k.topic === topicOf(q)));
    if (questions.length === 1 && !judged?.questions.length && !known.some((k) => k.topic === "prefs")) questions.push("Anything I should avoid or must include?");
    for (const k of known) found.push({ label: `What you told me before: ${k.text}`, text: `The user said before, for ${kind} plans: ${k.text}` });

    const touched = domains.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", ");
    const cited = found.filter((f) => f.label !== "It proposes before paying" && !f.label.startsWith("What you told me before"));
    const sayRaw = [
      `Before I start: this ${spend || travel ? "spends money and time" : judged?.highImpact ? "affects your plans" : "needs a few details"}${touched ? `, so I brought in ${touched}` : ""}.`,
      cited.length ? `From your vault: ${cited.map((f) => f.label.replace(/^From your \w+ notes: /, "")).slice(0, 3).join("; ")}.` : "",
      "A few things only you can tell me:",
    ].filter(Boolean).join(" ");
    const say = noDash(sayRaw);
    return { kind, domains, found, questions: questions.slice(0, 4), say, used };
  } catch { return null; }
}
