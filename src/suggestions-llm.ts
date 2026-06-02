import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";

export interface LlmSuggestion {
  id: string;
  label: string;
  prompt: string;
  domain: string;
  created_at: number;
}

export interface LlmCacheEntry {
  domain: string;
  ts: number;
  suggestions: LlmSuggestion[];
}

const DATA_DIR = join(homedir(), ".prevail");
const CACHE_FILE = join(DATA_DIR, "suggestions-cache.json");
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const LABEL_MAX = 50;

function ensureDir(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

export function loadLlmCache(): Record<string, LlmCacheEntry> {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, LlmCacheEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const entry = v as Partial<LlmCacheEntry>;
      if (
        typeof entry.domain !== "string" ||
        typeof entry.ts !== "number" ||
        !Array.isArray(entry.suggestions)
      )
        continue;
      const suggestions: LlmSuggestion[] = [];
      for (const s of entry.suggestions) {
        if (!s || typeof s !== "object") continue;
        const ss = s as Partial<LlmSuggestion>;
        if (
          typeof ss.id !== "string" ||
          typeof ss.label !== "string" ||
          typeof ss.prompt !== "string"
        )
          continue;
        suggestions.push({
          id: ss.id,
          label: ss.label,
          prompt: ss.prompt,
          domain: typeof ss.domain === "string" ? ss.domain : entry.domain,
          created_at: typeof ss.created_at === "number" ? ss.created_at : entry.ts,
        });
      }
      out[k] = { domain: entry.domain, ts: entry.ts, suggestions };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLlmCache(cache: Record<string, LlmCacheEntry>): void {
  try {
    ensureDir();
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

export function getCachedLlmSuggestions(
  domain: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): LlmSuggestion[] | null {
  const cache = loadLlmCache();
  const entry = cache[domain];
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.suggestions;
}

function readIfExists(p: string, maxChars = 2000): string {
  try {
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function summarizeClickHistory(clickHistory: Record<string, number>): string {
  // Group click counts by the source tag embedded in id ("stale-state:wealth").
  const bySource = new Map<string, number>();
  let total = 0;
  for (const [id, n] of Object.entries(clickHistory)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const source = id.split(":")[0] ?? "default";
    bySource.set(source, (bySource.get(source) ?? 0) + n);
    total += n;
  }
  if (total === 0) return "(no prior clicks)";
  const sorted = Array.from(bySource.entries()).sort((a, b) => b[1] - a[1]);
  return sorted
    .slice(0, 3)
    .map(([s, n]) => `${s} (${n.toFixed(1)})`)
    .join(", ");
}

function buildLlmPrompt(args: {
  domain: string;
  domainPath: string;
  clickHistory: Record<string, number>;
  recentMessages: { role: string; content: string }[];
}): string {
  const state = readIfExists(join(args.domainPath, "state.md"), 1800);
  const loops = readIfExists(join(args.domainPath, "open-loops.md"), 1200);
  const recent = args.recentMessages
    .slice(-5)
    .map((m) => `[${m.role}] ${m.content.slice(0, 400)}`)
    .join("\n");
  const prefs = summarizeClickHistory(args.clickHistory);
  return [
    `You are seeding a chat for the "${args.domain}" life domain. The vault for this domain lives at ${args.domainPath}.`,
    "",
    "Propose exactly 3 chat-starter prompts the user might want to send right now. Each starter has a short label (max 50 chars, no emoji, plain ASCII or basic unicode geometric shapes only) and a full prompt (1-3 sentences) the user could click to send.",
    "",
    "REQUIRED OUTPUT: a single JSON object, no preamble, no fences, no explanation. Shape:",
    `{"suggestions":[{"label":"...","prompt":"..."},{"label":"...","prompt":"..."},{"label":"...","prompt":"..."}]}`,
    "",
    "Constraints:",
    "- exactly 3 entries",
    "- label: max 50 chars, no emoji",
    "- prompt: 1-3 sentences, references the domain specifically",
    "- ground each suggestion in the state/loops/recent context below",
    "",
    `User suggestion-click preferences (most-clicked sources): ${prefs}`,
    "",
    "=== state.md ===",
    state || "(empty)",
    "",
    "=== open-loops.md ===",
    loops || "(empty)",
    "",
    "=== recent chat (last 5 messages) ===",
    recent || "(none)",
  ].join("\n");
}

interface ParsedRaw {
  label?: unknown;
  prompt?: unknown;
}

interface ParsedShape {
  suggestions?: unknown;
}

// Defensive parser: strip fences, find first '{', parse, validate shape.
// Returns [] on any failure. Never throws.
export function parseLlmResponse(raw: string, domain: string): LlmSuggestion[] {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim();
  // strip markdown fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const start = text.indexOf("{");
  if (start < 0) return [];
  // try shrinking the tail until JSON.parse succeeds
  let candidate = text.slice(start);
  let parsed: ParsedShape | null = null;
  // try the full candidate first; if it fails, scan back to last '}'
  try {
    parsed = JSON.parse(candidate) as ParsedShape;
  } catch {
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace > 0) {
      try {
        parsed = JSON.parse(candidate.slice(0, lastBrace + 1)) as ParsedShape;
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  if (!parsed || !Array.isArray(parsed.suggestions)) return [];
  const out: LlmSuggestion[] = [];
  const now = Date.now();
  for (let i = 0; i < parsed.suggestions.length && out.length < 3; i++) {
    const s = parsed.suggestions[i] as ParsedRaw;
    if (!s || typeof s !== "object") continue;
    const labelRaw = typeof s.label === "string" ? s.label.trim() : "";
    const promptRaw = typeof s.prompt === "string" ? s.prompt.trim() : "";
    if (!labelRaw || !promptRaw) continue;
    const label = labelRaw.length > LABEL_MAX ? labelRaw.slice(0, LABEL_MAX - 1) + "…" : labelRaw;
    out.push({
      id: `llm:${domain}:${i}:${slugify(label)}`,
      label,
      prompt: promptRaw,
      domain,
      created_at: now,
    });
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface PrecomputeArgs {
  domain: string;
  domainPath: string;
  cli: AvailableCli;
  model?: string;
  clickHistory: Record<string, number>;
  recentMessages?: { role: string; content: string }[];
}

// Precompute LLM-backed suggestions for a domain. Cached for 1 hour by default.
// Errors are swallowed (returns empty array). Caller may choose to fire-and-forget.
export async function precomputeLlmSuggestions(args: PrecomputeArgs): Promise<LlmSuggestion[]> {
  const cached = getCachedLlmSuggestions(args.domain);
  if (cached) return cached;
  const prompt = buildLlmPrompt({
    domain: args.domain,
    domainPath: args.domainPath,
    clickHistory: args.clickHistory,
    recentMessages: args.recentMessages ?? [],
  });
  let raw = "";
  try {
    raw = await runChatTurn({
      prompt,
      cwd: args.domainPath,
      cli: args.cli,
      model: args.model ?? "",
      isFirst: true,
    });
  } catch {
    return [];
  }
  const parsed = parseLlmResponse(raw, args.domain);
  if (parsed.length === 0) return [];
  // write back to cache
  const cache = loadLlmCache();
  cache[args.domain] = {
    domain: args.domain,
    ts: Date.now(),
    suggestions: parsed,
  };
  writeLlmCache(cache);
  return parsed;
}
