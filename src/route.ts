// Domain routing: which of the vault's domains is a General conversation about?
//
// General is where most work starts. When a message is plainly about real
// estate, or money, or health, the desktop tags the thread with that domain so
// the conversation also shows up there and the next turn carries that
// domain's context. This module answers the one question behind that:
//
//   routeMessage(text) -> { domains: [{ slug, confidence }], reason }
//
// Two ways to answer, tried in order:
//   1. The decision layer (decision.ts), as a single `choice` question over the
//      vault's domains, when a TypeSafe key is configured. Fast and cheap.
//   2. A small model classification with a strict JSON reply. The runner is
//      injectable so tests never spawn anything.
//
// Privacy. The only user content that leaves the machine is the message text
// itself (plus, on the model path, short excerpts of earlier messages the user
// corrected, which are the user's own words already in the vault). No domain
// files, memory, state or profile are sent: domain options are described by
// their slug alone. Nothing here writes message text anywhere except the
// vault's own decision log, and only when the user corrects a route.
//
// Learning. `recordRouteCorrection` appends a `route_correction` record to
// General's decision log (memory/decisions.jsonl). The newest few are fed back
// to the model path as examples, and a correction on the same thread pins that
// thread's domains outright.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { vaultDomains } from "./apps-mirror.ts";
import { appendDecision, readDecisions } from "./decisions.ts";
import { evaluateDecision, type ChoiceQuestion, type DecisionProvider, type NoulQuestion } from "./decision.ts";

export interface RouteHit {
  slug: string;
  /** 0..1 */
  confidence: number;
}

export type RouteSource = "typesafe" | "model" | "correction" | "none";

export interface RouteResult {
  domains: RouteHit[];
  reason: string;
  source: RouteSource;
}

export interface RouteExample {
  excerpt: string;
  domains: string[];
}

/** A model call: system instructions plus one prompt in, raw text out. */
export type RouteRunner = (req: { system: string; prompt: string; timeoutMs: number }) => Promise<string>;

export interface RouteOptions {
  vault: string;
  text: string;
  thread?: string | null;
  /** The decision layer provider. Null or unavailable skips straight to the model. */
  provider?: DecisionProvider | null;
  /** Model runner. Defaults to a claude-haiku-4-5 call with no tools and no session. */
  runner?: RouteRunner | null;
  /** Override the vault's domain list (tests). */
  domains?: string[];
  /** Deadline for the model path. */
  timeoutMs?: number;
}

/** The domain General stands for itself; it is never a routing target. */
const GENERAL = "general";
/** Characters of the message that are ever sent anywhere. */
export const ROUTE_MAX_TEXT = 4_000;
/** Excerpt kept in the vault log for a correction, and reused as an example. */
export const ROUTE_EXCERPT_CHARS = 160;
/** How many recent corrections ride along as examples. */
export const ROUTE_EXAMPLES = 5;
/** A domain below this is noise, not a candidate. */
export const ROUTE_FLOOR = 0.15;
/** At most this many domains per message. */
export const ROUTE_MAX_HITS = 3;
/** The model this job uses. The job is `route`; the model is only a version string. */
export const ROUTE_MODEL = "claude-haiku-4-5";
export const ROUTE_TIMEOUT_MS = 20_000;

export const CORRECTION_TYPE = "route_correction";

// ── Domains ────────────────────────────────────────────────────────────

/** The vault's real domains a General conversation can be routed to. */
export function routableDomains(vault: string): string[] {
  return vaultDomains(vault).filter((d) => d !== GENERAL);
}

export function labelFor(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}

// ── Corrections ────────────────────────────────────────────────────────

export function excerptOf(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > ROUTE_EXCERPT_CHARS ? `${t.slice(0, ROUTE_EXCERPT_CHARS - 3)}...` : t;
}

export function recordRouteCorrection(
  vault: string,
  c: { thread: string; domains: string[]; from?: string[]; text?: string; source?: string },
): { id: string; domains: string[] } {
  const known = new Set(routableDomains(vault));
  const domains = uniq(c.domains.map(norm)).filter((d) => known.has(d));
  const from = uniq((c.from ?? []).map(norm)).filter((d) => known.has(d));
  const rec = appendDecision(vault, GENERAL, {
    type: CORRECTION_TYPE,
    domain: GENERAL,
    thread: c.thread,
    domains,
    from,
    prompt: c.text ? excerptOf(c.text) : undefined,
    source: c.source ?? "cli",
  } as Record<string, unknown>);
  return { id: rec.id, domains };
}

interface CorrectionRow {
  thread?: string;
  domains?: unknown;
  prompt?: string;
  ts?: number;
}

function corrections(vault: string): CorrectionRow[] {
  try {
    return readDecisions(vault, GENERAL)
      .filter((r) => r.type === CORRECTION_TYPE)
      .map((r) => r as unknown as CorrectionRow);
  } catch {
    return [];
  }
}

function slugList(v: unknown, known: Set<string>): string[] {
  return Array.isArray(v) ? uniq(v.filter((x): x is string => typeof x === "string").map(norm)).filter((d) => known.has(d)) : [];
}

/** Newest corrections with an excerpt, as few-shot examples. */
export function recentRouteExamples(vault: string, known: string[], limit = ROUTE_EXAMPLES): RouteExample[] {
  const k = new Set(known);
  const out: RouteExample[] = [];
  for (const r of corrections(vault)) {
    if (!r.prompt) continue;
    out.push({ excerpt: r.prompt, domains: slugList(r.domains, k) });
    if (out.length >= limit) break;
  }
  return out;
}

/** The newest correction on this thread, if any: the user already said where it belongs. */
export function threadCorrection(vault: string, thread: string, known: string[]): string[] | null {
  const k = new Set(known);
  for (const r of corrections(vault)) {
    if (r.thread === thread) return slugList(r.domains, k);
  }
  return null;
}

// ── Decision layer path ────────────────────────────────────────────────

export function buildRouteQuestion(domains: string[]): ChoiceQuestion {
  const criteria: Record<string, string> = {
    [GENERAL]: "Not about any one of these life areas; general conversation.",
  };
  for (const d of domains) criteria[d] = `About the user's ${labelFor(d).toLowerCase()} life area.`;
  return {
    type: "choice",
    instructions: "Which of the user's life areas is this message mainly about?",
    criteria,
  };
}

/** Turn a choice distribution into ranked domain hits. */
export function hitsFromProbabilities(probs: Record<string, number>, domains: string[]): RouteHit[] {
  const k = new Set(domains);
  return Object.entries(probs)
    .filter(([slug, p]) => k.has(slug) && Number.isFinite(p) && p >= ROUTE_FLOOR)
    .map(([slug, p]) => ({ slug, confidence: round2(p) }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, ROUTE_MAX_HITS);
}

// ── Model path ─────────────────────────────────────────────────────────

export function buildRoutePrompt(text: string, domains: string[], examples: RouteExample[]): { system: string; prompt: string } {
  const system = [
    "You classify one message into the user's life areas. You never answer the message.",
    `The only valid area slugs are: ${domains.join(", ")}.`,
    "Reply with ONLY a JSON object, no prose and no code fence, shaped exactly:",
    '{"domains":[{"slug":"<one of the valid slugs>","confidence":<0..1>}],"reason":"<under 12 words>"}',
    "List only areas the message is clearly about, most likely first, at most 3.",
    "Confidence is your probability that the message belongs in that area.",
    'If it is general chat or not about any listed area, reply {"domains":[],"reason":"general"}.',
  ].join("\n");
  const ex = examples.length
    ? "Earlier messages the user filed themselves (follow these):\n" +
      examples.map((e) => `- "${e.excerpt}" -> ${e.domains.length ? e.domains.join(", ") : "general"}`).join("\n") +
      "\n\n"
    : "";
  const prompt = `${ex}Message:\n${text.slice(0, ROUTE_MAX_TEXT)}`;
  return { system, prompt };
}

/** Parse a model reply into hits limited to the real domains. Null when unusable. */
export function parseRouteReply(raw: string, domains: string[]): { domains: RouteHit[]; reason: string } | null {
  const s = raw.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: unknown;
  try {
    o = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;
  if (!Array.isArray(obj.domains)) return null;
  const k = new Set(domains);
  const seen = new Set<string>();
  const hits: RouteHit[] = [];
  for (const h of obj.domains) {
    if (!h || typeof h !== "object") continue;
    const slug = norm(String((h as Record<string, unknown>).slug ?? ""));
    const c = Number((h as Record<string, unknown>).confidence);
    if (!k.has(slug) || seen.has(slug) || !Number.isFinite(c)) continue;
    seen.add(slug);
    hits.push({ slug, confidence: round2(Math.min(1, Math.max(0, c))) });
  }
  hits.sort((a, b) => b.confidence - a.confidence);
  const reason = typeof obj.reason === "string" ? obj.reason.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { domains: hits.slice(0, ROUTE_MAX_HITS), reason };
}

/**
 * The default runner: one claude call with no tools, no MCP, no settings, no
 * session file, from a scratch directory so no project instructions ride
 * along. The prompt goes over stdin rather than argv so it never shows in a
 * process listing.
 */
export const claudeRouteRunner: RouteRunner = async ({ system, prompt, timeoutMs }) => {
  const { detectClis, scrubbedEnv } = await import("./cli-bridge.ts");
  const claude = (await detectClis()).find((c) => c.kind === "claude");
  if (!claude) throw new Error("no claude runtime");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      claude.bin,
      [
        "-p",
        "--model", ROUTE_MODEL,
        "--output-format", "text",
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--system-prompt", system,
      ],
      { cwd: tmpdir(), env: scrubbedEnv(), stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    child.stdout.on("data", (b) => { out += String(b); if (out.length > 4_000) child.kill("SIGKILL"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.stdin.end(prompt);
  });
};

// ── Entry point ────────────────────────────────────────────────────────

const none = (reason: string): RouteResult => ({ domains: [], reason, source: "none" });

/**
 * Route one message. Never throws: every failure is an empty result with a
 * reason, which the caller treats as "stay in General".
 */
export async function routeMessage(opts: RouteOptions): Promise<RouteResult> {
  const text = (opts.text ?? "").trim();
  if (!text) return none("empty message");
  const domains = (opts.domains ?? routableDomains(opts.vault)).map(norm).filter((d) => d && d !== GENERAL);
  if (domains.length === 0) return none("no domains in this vault");

  // The user already filed this thread: that answer stands until they change it.
  if (opts.thread) {
    const pinned = threadCorrection(opts.vault, opts.thread, domains);
    if (pinned) {
      return {
        domains: pinned.map((slug) => ({ slug, confidence: 1 })),
        reason: pinned.length ? "you filed this thread" : "you kept this thread in General",
        source: "correction",
      };
    }
  }

  if (opts.provider) {
    const res = await evaluateDecision(opts.provider, text.slice(0, ROUTE_MAX_TEXT), { route: buildRouteQuestion(domains) });
    const a = res?.answers.route;
    if (a && a.type === "choice") {
      const probs = Object.keys(a.probabilities).length ? a.probabilities : { [a.choice]: a.confidence };
      const hits = hitsFromProbabilities(probs, domains);
      return {
        domains: hits,
        reason: hits.length ? `decision layer picked ${labelFor(hits[0].slug).toLowerCase()}` : "decision layer: general",
        source: "typesafe",
      };
    }
  }

  const runner = opts.runner === undefined ? claudeRouteRunner : opts.runner;
  if (!runner) return none("no routing provider available");
  const { system, prompt } = buildRoutePrompt(text, domains, recentRouteExamples(opts.vault, domains));
  let raw = "";
  try {
    raw = await runner({ system, prompt, timeoutMs: opts.timeoutMs ?? ROUTE_TIMEOUT_MS });
  } catch {
    return none("routing model unavailable");
  }
  const parsed = parseRouteReply(raw, domains);
  if (!parsed) return none("routing reply was not usable");
  return { domains: parsed.domains, reason: parsed.reason || (parsed.domains.length ? "classified" : "general"), source: "model" };
}

// ── Touches: every place a conversation concerns ────────────────────────
//
// Routing answers "where does this General message belong". A touch answers
// the wider question for ANY conversation, after the reply: which OTHER
// domains (and which of the user's own entities) does this exchange concern,
// and what does it mean for each, in one line. A real estate chat about a
// water damage claim and a lawyer also touches insurance and legal.
//
// Same two paths as routing: the decision layer (one yes/no question per
// domain, cheap) narrows the candidates, and the small model writes the fact
// lines. With no decision provider the model does both. The runner is
// injectable; tests never spawn anything.

export interface TouchDomainOption {
  slug: string;
  /** One line: what the domain is about (its manifest summary). */
  description: string;
}

export interface TouchEntityOption {
  id: string;
  name: string;
  aliases: string[];
}

export interface TouchHit {
  slug: string;
  confidence: number;
  /** One line, at most TOUCH_FACT_CHARS: what this conversation means there. */
  fact: string;
}

export interface TouchResult {
  domains: TouchHit[];
  /** Entity-specific fact lines the model offered, by entity id. */
  entity_facts: Record<string, string>;
  source: "typesafe" | "model" | "none";
}

export interface TouchOptions {
  /** The conversation's own domain: never a touch target. */
  home: string;
  message: string;
  reply: string;
  domains: TouchDomainOption[];
  entities?: TouchEntityOption[];
  provider?: DecisionProvider | null;
  runner?: RouteRunner | null;
  timeoutMs?: number;
}

/** A touch below this is not recorded. */
export const TOUCH_MIN_CONFIDENCE = 0.6;
export const TOUCH_MAX_DOMAINS = 4;
export const TOUCH_FACT_CHARS = 200;
/** Characters of the reply the classifier sees. */
export const TOUCH_REPLY_CHARS = 3_000;
/** Shorter user messages ("thanks", "ok do it") are not worth a call. */
export const TOUCH_MIN_MESSAGE = 20;

export function clipFact(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/\s*\u2014\s*/g, ", ").trim();
  return t.length > TOUCH_FACT_CHARS ? `${t.slice(0, TOUCH_FACT_CHARS - 3)}...` : t;
}

export function buildTouchQuestions(domains: TouchDomainOption[]): Record<string, NoulQuestion> {
  const out: Record<string, NoulQuestion> = {};
  for (const d of domains) {
    out[d.slug] = {
      type: "noul",
      instructions: `Does this conversation carry news or a fact that matters to the user's ${labelFor(d.slug).toLowerCase()} life area${d.description ? ` (${d.description})` : ""}?`,
    };
  }
  return out;
}

export function buildTouchPrompt(o: { message: string; reply: string; domains: TouchDomainOption[]; entities: TouchEntityOption[] }): { system: string; prompt: string } {
  const system = [
    "You read one exchange between a user and an assistant and list which of the user's OTHER life areas it concerns. You never answer the message.",
    "Valid area slugs, each with what it covers:",
    ...o.domains.map((d) => `- ${d.slug}: ${d.description || labelFor(d.slug)}`),
    "Reply with ONLY a JSON object, no prose and no code fence, shaped exactly:",
    '{"domains":[{"slug":"<valid slug>","confidence":<0..1>,"fact":"<one line>"}],"entity_facts":{"<entity id>":"<one line>"}}',
    "List only areas the exchange clearly carries news or a fact for, most likely first, at most 4.",
    "fact: one plain line under 200 characters saying what this exchange means for that area, with concrete names, amounts and dates from the text. Never invent anything.",
    "entity_facts: optional, only for the listed entities the exchange is about, when a line specific to that entity says more than the area fact.",
    'If it concerns no listed area, reply {"domains":[],"entity_facts":{}}.',
  ].join("\n");
  const ents = o.entities.length
    ? `The user's own people, places and things (id = name):\n${o.entities.slice(0, 60).map((e) => `- ${e.id} = ${[e.name, ...e.aliases.slice(0, 3)].join(" / ")}`).join("\n")}\n\n`
    : "";
  const prompt = `${ents}User:\n${o.message.slice(0, ROUTE_MAX_TEXT)}\n\nAssistant:\n${o.reply.slice(0, TOUCH_REPLY_CHARS)}`;
  return { system, prompt };
}

/** Parse a touch reply: real slugs only, the threshold applied, at most 4. Null when unusable. */
export function parseTouchReply(raw: string, domains: string[], entityIds: string[] = []): Omit<TouchResult, "source"> | null {
  const s = raw.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: unknown;
  try {
    o = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || !Array.isArray((o as Record<string, unknown>).domains)) return null;
  const obj = o as Record<string, unknown>;
  const k = new Set(domains);
  const seen = new Set<string>();
  const hits: TouchHit[] = [];
  for (const h of obj.domains as unknown[]) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    const slug = norm(String(r.slug ?? ""));
    const c = Number(r.confidence);
    const fact = typeof r.fact === "string" ? clipFact(r.fact) : "";
    if (!k.has(slug) || seen.has(slug) || !Number.isFinite(c) || c < TOUCH_MIN_CONFIDENCE || !fact) continue;
    seen.add(slug);
    hits.push({ slug, confidence: round2(Math.min(1, c)), fact });
  }
  hits.sort((a, b) => b.confidence - a.confidence);
  const ids = new Set(entityIds);
  const entity_facts: Record<string, string> = {};
  const ef = obj.entity_facts;
  if (ef && typeof ef === "object" && !Array.isArray(ef)) {
    for (const [id, v] of Object.entries(ef as Record<string, unknown>)) {
      if (ids.has(id) && typeof v === "string" && v.trim()) entity_facts[id] = clipFact(v);
    }
  }
  return { domains: hits.slice(0, TOUCH_MAX_DOMAINS), entity_facts };
}

/**
 * Classify one finished exchange into the other domains it touches. Never
 * throws: every failure is an empty result, which the caller treats as "this
 * conversation stays where it is".
 */
export async function classifyTouches(opts: TouchOptions): Promise<TouchResult> {
  const empty: TouchResult = { domains: [], entity_facts: {}, source: "none" };
  const home = norm(opts.home);
  let domains = opts.domains.filter((d) => d.slug && norm(d.slug) !== home && norm(d.slug) !== GENERAL);
  const entities = opts.entities ?? [];
  if (!domains.length && !entities.length) return empty;
  const text = `User: ${opts.message.slice(0, ROUTE_MAX_TEXT)}\n\nAssistant: ${opts.reply.slice(0, TOUCH_REPLY_CHARS)}`;

  // Decision layer first: one yes/no per domain. It cannot write the fact
  // lines, so it only narrows which domains the model is asked about, and
  // spares the model call entirely when nothing clears the bar.
  let source: TouchResult["source"] = "model";
  const confidence = new Map<string, number>();
  if (opts.provider && domains.length) {
    const res = await evaluateDecision(opts.provider, text, buildTouchQuestions(domains));
    if (res) {
      for (const d of domains) {
        const a = res.answers[d.slug];
        if (a?.type === "noul" && a.probability >= TOUCH_MIN_CONFIDENCE) confidence.set(d.slug, round2(a.probability));
      }
      domains = domains.filter((d) => confidence.has(d.slug)).sort((a, b) => confidence.get(b.slug)! - confidence.get(a.slug)!).slice(0, TOUCH_MAX_DOMAINS);
      source = "typesafe";
      if (!domains.length && !entities.length) return { ...empty, source };
    }
  }

  const runner = opts.runner === undefined ? claudeRouteRunner : opts.runner;
  if (!runner) return empty;
  const { system, prompt } = buildTouchPrompt({ message: opts.message, reply: opts.reply, domains, entities });
  let raw = "";
  try {
    raw = await runner({ system, prompt, timeoutMs: opts.timeoutMs ?? ROUTE_TIMEOUT_MS });
  } catch {
    return empty;
  }
  const parsed = parseTouchReply(raw, domains.map((d) => d.slug), entities.map((e) => e.id));
  if (!parsed) return empty;
  // The decision layer's confidence stands where it answered.
  const hits = parsed.domains.map((h) => (confidence.has(h.slug) ? { ...h, confidence: confidence.get(h.slug)! } : h));
  return { domains: hits, entity_facts: parsed.entity_facts, source };
}

// ── helpers ────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
