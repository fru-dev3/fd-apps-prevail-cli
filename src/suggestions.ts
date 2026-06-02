import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SuggestionSource =
  | "stale-state"
  | "open-loops"
  | "prompts-md"
  | "history"
  | "llm"
  | "default";

export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
  source: SuggestionSource;
  score: number;
}

export interface SuggestionContext {
  kind: "domain" | "app";
  name: string;
  path: string;
  openLoopCount: number;
  stateMtime: number | null;
  recentChatPrompts: string[];
  promptsMdEntries: { label: string; prompt: string }[];
}

interface ClickRecord {
  count: number;
  last_clicked: number;
}

interface ClickStore {
  clicks: Record<string, ClickRecord>;
}

const DATA_DIR = join(homedir(), ".prevail");
const CLICK_FILE = join(DATA_DIR, "suggestions.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_MS = 14 * DAY_MS;
const HALF_LIFE_MS = 7 * DAY_MS;
const MAX_CHIPS = 5;
const LABEL_MAX = 50;

const COMMON_VERBS = new Set([
  "pull",
  "check",
  "review",
  "find",
  "show",
  "list",
  "calculate",
  "build",
  "draft",
  "summarize",
  "track",
  "compare",
  "flag",
  "scan",
  "audit",
  "sync",
  "fetch",
  "look",
  "run",
  "analyze",
  "extract",
  "search",
  "update",
  "open",
  "tally",
]);

function ensureDir(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function readClickStore(): ClickStore {
  try {
    if (!existsSync(CLICK_FILE)) return { clicks: {} };
    const raw = readFileSync(CLICK_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ClickStore>;
    if (!parsed || typeof parsed !== "object") return { clicks: {} };
    const clicks: Record<string, ClickRecord> = {};
    const src = parsed.clicks ?? {};
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src)) {
        if (!v || typeof v !== "object") continue;
        const r = v as Partial<ClickRecord>;
        const count = typeof r.count === "number" && r.count > 0 ? r.count : 0;
        const last_clicked =
          typeof r.last_clicked === "number" ? r.last_clicked : 0;
        if (count > 0) clicks[k] = { count, last_clicked };
      }
    }
    return { clicks };
  } catch {
    return { clicks: {} };
  }
}

function writeClickStore(store: ClickStore): void {
  try {
    ensureDir();
    writeFileSync(CLICK_FILE, JSON.stringify(store, null, 2));
  } catch {}
}

// Effective click weight after time-decay (halve weekly via last_clicked).
function decayedCount(rec: ClickRecord, now: number): number {
  const age = Math.max(0, now - rec.last_clicked);
  const halvings = age / HALF_LIFE_MS;
  const factor = Math.pow(0.5, halvings);
  return rec.count * factor;
}

export function loadClickCounts(): Record<string, number> {
  const store = readClickStore();
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const [id, rec] of Object.entries(store.clicks)) {
    out[id] = decayedCount(rec, now);
  }
  return out;
}

export function recordSuggestionClick(suggestionId: string): void {
  if (!suggestionId) return;
  const store = readClickStore();
  const now = Date.now();
  const prev = store.clicks[suggestionId];
  let count = 1;
  if (prev) {
    // apply decay to the existing count, then add one fresh click
    count = decayedCount(prev, now) + 1;
  }
  store.clicks[suggestionId] = { count, last_clicked: now };
  writeClickStore(store);
}

export function parsePromptsMd(content: string): { label: string; prompt: string }[] {
  const out: { label: string; prompt: string }[] = [];
  if (!content) return out;
  const lines = content.split("\n");
  // Group consecutive lines belonging to the same numbered entry. A new entry
  // starts at a line matching /^\s*N\.\s+/. Entry text continues until the next
  // numbered line or a blank-line followed by a section header.
  let cur: { num: number; lines: string[] } | null = null;
  const entries: { num: number; text: string }[] = [];
  const startRe = /^\s*(\d+)\.\s+(.*)$/;
  for (const raw of lines) {
    const m = raw.match(startRe);
    if (m) {
      if (cur) entries.push({ num: cur.num, text: cur.lines.join(" ").trim() });
      cur = { num: Number(m[1]), lines: [m[2]] };
      continue;
    }
    if (cur) {
      const trimmed = raw.trim();
      // stop the current entry on a header line; blank lines are tolerated
      if (/^#/.test(trimmed)) {
        entries.push({ num: cur.num, text: cur.lines.join(" ").trim() });
        cur = null;
        continue;
      }
      if (trimmed.length === 0) {
        cur.lines.push("");
        continue;
      }
      cur.lines.push(trimmed);
    }
  }
  if (cur) entries.push({ num: cur.num, text: cur.lines.join(" ").trim() });

  // Take the first three numbered entries in document order.
  for (const e of entries.slice(0, 3)) {
    const cleaned = e.text.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const label = firstSentenceLabel(cleaned);
    out.push({ label, prompt: cleaned });
  }
  return out;
}

function firstSentenceLabel(text: string): string {
  // Strip bold/italic markers used in PROMPTS.md ("**Title:**").
  let t = text.replace(/\*\*/g, "").replace(/[`_]/g, "");
  // Pull "Title:" prefix as the label when present.
  const titleMatch = t.match(/^([^:]{3,80})\s*:\s*(.*)$/);
  if (titleMatch) t = titleMatch[1];
  // Take the first sentence: split on ". " (period + space).
  const dot = t.indexOf(". ");
  if (dot > 0) t = t.slice(0, dot);
  t = t.trim();
  if (t.endsWith(".")) t = t.slice(0, -1);
  if (t.length > LABEL_MAX) t = t.slice(0, LABEL_MAX - 1) + "…";
  return t;
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

function formatStaleDate(mtime: number): string {
  try {
    const d = new Date(mtime);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return "earlier";
  }
}

// Extract a candidate noun for a verb by scanning past prompts that begin with
// that verb. Picks the most common 1–2 word phrase following the verb.
function extractNounForVerb(verb: string, prompts: string[]): string | null {
  const tally = new Map<string, number>();
  const re = new RegExp(`^${verb}\\s+(.+)$`, "i");
  for (const p of prompts) {
    const cleaned = p.trim().replace(/^[/\s]+/, "");
    const m = cleaned.match(re);
    if (!m) continue;
    const rest = m[1].trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "");
    if (!rest) continue;
    const words = rest.split(/\s+/).slice(0, 2).join(" ");
    if (words.length === 0) continue;
    tally.set(words, (tally.get(words) ?? 0) + 1);
  }
  let best: { phrase: string; n: number } | null = null;
  for (const [phrase, n] of tally) {
    if (!best || n > best.n) best = { phrase, n };
  }
  return best ? best.phrase : null;
}

function tallyOpeningVerbs(prompts: string[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const p of prompts) {
    const cleaned = p.trim().replace(/^[/\s]+/, "").toLowerCase();
    const word = cleaned.split(/\s+/)[0];
    if (!word) continue;
    if (!COMMON_VERBS.has(word)) continue;
    tally.set(word, (tally.get(word) ?? 0) + 1);
  }
  return tally;
}

function applyClickBoost(suggestions: Suggestion[], clicks: Record<string, number>): Suggestion[] {
  return suggestions.map((s) => {
    const c = clicks[s.id] ?? 0;
    const boost = Math.min(c * 5, 25);
    return { ...s, score: s.score + boost };
  });
}

export function buildSuggestions(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = [];
  const now = Date.now();

  // stale state
  if (ctx.stateMtime !== null && now - ctx.stateMtime > STALE_THRESHOLD_MS) {
    const date = formatStaleDate(ctx.stateMtime);
    out.push({
      id: `stale-state:${ctx.name}`,
      label: truncate(`sync ${ctx.name} state — what's changed since ${date}`, LABEL_MAX),
      prompt: `Sync the ${ctx.name} ${ctx.kind === "app" ? "app" : "domain"} state. The last update was on ${date}. Walk me through what has likely changed since then, surface anything I should action now, and propose specific edits to state.md so it reflects today's reality.`,
      source: "stale-state",
      score: 80,
    });
  }

  // open loops
  if (ctx.openLoopCount > 0) {
    const n = ctx.openLoopCount;
    out.push({
      id: `open-loops:${ctx.name}`,
      label: truncate(`triage ${ctx.name} open items (${n} waiting)`, LABEL_MAX),
      prompt: `Triage the ${n} open item${n === 1 ? "" : "s"} in the ${ctx.name} ${ctx.kind === "app" ? "app" : "domain"}. Read open-loops.md and the Open Items section of state.md. Order them by urgency × impact, recommend which to drop, flag any blockers, and tell me the single most important next action.`,
      source: "open-loops",
      score: 70 + Math.min(n * 2, 20),
    });
  }

  // prompts.md top 3
  const baseScores = [60, 55, 50];
  ctx.promptsMdEntries.slice(0, 3).forEach((entry, idx) => {
    const label = truncate(entry.label, LABEL_MAX);
    out.push({
      id: `prompts-md:${ctx.name}:${idx}:${slugify(label)}`,
      label,
      prompt: entry.prompt,
      source: "prompts-md",
      score: baseScores[idx] ?? 50,
    });
  });

  // history — most-repeated opening verbs
  const verbCounts = tallyOpeningVerbs(ctx.recentChatPrompts);
  const sortedVerbs = Array.from(verbCounts.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);
  for (const [verb] of sortedVerbs) {
    const noun = extractNounForVerb(verb, ctx.recentChatPrompts) ?? "what's new";
    const label = truncate(`${verb} ${noun} for ${ctx.name}`, LABEL_MAX);
    out.push({
      id: `history:${ctx.name}:${verb}:${slugify(noun)}`,
      label,
      prompt: `${capitalize(verb)} ${noun} for the ${ctx.name} ${ctx.kind === "app" ? "app" : "domain"}. Use the latest state.md and any relevant files under ${ctx.path} for context.`,
      source: "history",
      score: 65,
    });
  }

  // default fallback if nothing else qualified
  if (out.length === 0) {
    out.push(
      {
        id: `default:${ctx.name}:walk`,
        label: truncate(`walk me through ${ctx.name} state`, LABEL_MAX),
        prompt: `Walk me through the current state of the ${ctx.name} ${ctx.kind === "app" ? "app" : "domain"}. Start with state.md, surface what stands out, and tell me what to act on first.`,
        source: "default",
        score: 40,
      },
      {
        id: `default:${ctx.name}:next`,
        label: truncate(`what should I do next in ${ctx.name}`, LABEL_MAX),
        prompt: `Look at the ${ctx.name} ${ctx.kind === "app" ? "app" : "domain"} (state.md, open-loops.md, recent files under ${ctx.path}) and tell me the single most important next action.`,
        source: "default",
        score: 35,
      },
      {
        id: `default:${ctx.name}:summarize`,
        label: truncate(`summarize ${ctx.name} in 5 bullets`, LABEL_MAX),
        prompt: `Summarize the current state of the ${ctx.name} ${ctx.kind === "app" ? "app" : "domain"} in 5 tight bullets. Use only what's in ${ctx.path}.`,
        source: "default",
        score: 30,
      },
    );
  }

  const clicks = loadClickCounts();
  const boosted = applyClickBoost(out, clicks);

  // de-duplicate by id, keep highest score
  const byId = new Map<string, Suggestion>();
  for (const s of boosted) {
    const prev = byId.get(s.id);
    if (!prev || s.score > prev.score) byId.set(s.id, s);
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHIPS);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// Merge ranked lists (e.g. deterministic + LLM) into one capped list. Boosts
// from click counts are applied here too so callers don't have to reimplement.
export function mergeSuggestions(...lists: Suggestion[][]): Suggestion[] {
  const clicks = loadClickCounts();
  const byId = new Map<string, Suggestion>();
  for (const list of lists) {
    const boosted = applyClickBoost(list, clicks);
    for (const s of boosted) {
      const prev = byId.get(s.id);
      if (!prev || s.score > prev.score) byId.set(s.id, s);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHIPS);
}
