import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

import { runtimePath, validateVaultPath } from "./path-safety.ts";

// =============================================================================
// Prompt capture - the single ingest point for prompts typed into ANY harness.
//
// Every AI CLI the user drives (Claude Code, Codex, Gemini, opencode,
// Antigravity, Pi, …) plus prevail's own cockpit writes the prompts the user
// submits into one uniform stream per tool:
//
//   <vault>/_meta/prompts.<tool>.jsonl
//
// One record per submitted prompt, identical shape across every tool, so the
// intents distiller can later glob `prompts.*.jsonl` and distill across tools
// (the same wealth question asked in three harnesses → one high-confidence
// recurring intent). This file owns the schema, the vault resolution, the
// dedup, and the safe-slug rules so adapters stay dumb: a harness hook just
// pipes the prompt to `prevail capture --tool <t>` and this does the rest.
//
// SAFE BY DESIGN. Ingest never throws to its caller and never writes to stdout
// unless asked for --json - a capture hook must never block or pollute the
// harness it runs inside. Errors are swallowed into a structured result.
// =============================================================================

/** The uniform capture record. One per submitted prompt, one JSONL line.
 *  `ts` is an ISO-8601Z string (human-readable); `epoch_ms` is the numeric
 *  sort key the distiller uses. Both are always present. */
export type CaptureSource = "push" | "sync";

export interface CaptureRecord {
  ts: string;
  epoch_ms: number;
  tool: string;
  session: string;
  cwd: string;
  prompt: string;
  /** How this prompt was captured: "push" = a live harness submit hook (clean,
   *  exactly what the user typed); "sync" = scraped from a transcript by the
   *  backstop (may include harness-injected/programmatic prompts). Lets the
   *  distiller weight clean human prompts over backstop noise. */
  source: CaptureSource;
  /** The machine this prompt was typed on (os.hostname() of the capturing
   *  process). Multi-machine vaults use it to attribute activity per host. */
  host?: string;
}

export interface IngestInput {
  vault: string;
  tool: string;
  prompt: string;
  session?: string | null;
  cwd?: string | null;
  /** Capture origin; defaults to "push" (the live hook keystone). */
  source?: CaptureSource;
  /** Override the clock - tests pass a fixed Date. */
  now?: Date;
}

export interface IngestResult {
  ok: boolean;
  /** True when a record was appended; false when skipped (empty/dupe) or failed. */
  written: boolean;
  /** Absolute path of the stream file this prompt targets. */
  path: string;
  tool: string;
  /** Why nothing was written, when written === false. */
  reason?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// Known tools. The slug is the file infix (prompts.<slug>.jsonl) and matches
// the desktop's clis.rs ids so the UI and engine agree on names. `transcript`
// is the native session/transcript dir the pull-backstop (`capture sync`) will
// scan for tools whose hook we can't wire - recorded here now so the registry
// is the single source of truth even before sync lands.
// -----------------------------------------------------------------------------

export interface KnownTool {
  slug: string;
  label: string;
  /** Native transcript dir under $HOME, for the future `capture sync` backstop. */
  transcript?: string;
}

export const KNOWN_TOOLS: readonly KnownTool[] = [
  { slug: "claude", label: "Claude Code", transcript: ".claude/projects" },
  { slug: "codex", label: "Codex", transcript: ".codex/sessions" },
  { slug: "gemini", label: "Gemini", transcript: ".gemini/tmp" },
  { slug: "antigravity", label: "Antigravity" },
  { slug: "opencode", label: "opencode" },
  { slug: "openclaw", label: "Openclaw" },
  { slug: "hermes", label: "Hermes" },
  { slug: "pi", label: "Pi" },
  { slug: "prevail", label: "Prevail" },
];

/** Normalize a tool name to a filesystem-safe slug. Lowercased, non
 *  `[a-z0-9-]` collapsed to `-`, trimmed. Returns null when nothing usable
 *  remains, so a bad `--tool` value can never escape the `_meta` dir. */
export function safeToolSlug(tool: string | null | undefined): string | null {
  if (!tool || typeof tool !== "string") return null;
  const slug = tool
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 40) return null;
  return slug;
}

/** What a harness hook hands us on stdin, normalized. */
export interface HookPayload {
  prompt: string;
  session?: string;
  cwd?: string;
}

/** Try to read a harness hook payload out of raw stdin. Command-type hooks (e.g.
 *  Claude Code's UserPromptSubmit) pipe a JSON object - `{prompt, session_id,
 *  cwd, hook_event_name, ...}` - rather than the bare prompt text. We treat
 *  stdin as such a payload ONLY when it parses to an object carrying the
 *  hook-shaped keys, so a user who literally types JSON as their prompt isn't
 *  misread. Returns null when stdin is just raw prompt text (use it verbatim). */
export function parseHookPayload(raw: string): HookPayload | null {
  const s = (raw ?? "").trim();
  if (!s.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const looksLikeHook =
    "hook_event_name" in obj || ("prompt" in obj && ("session_id" in obj || "session" in obj));
  if (!looksLikeHook) return null;
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  const session =
    typeof obj.session_id === "string"
      ? obj.session_id
      : typeof obj.session === "string"
        ? obj.session
        : undefined;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  return { prompt, session, cwd };
}

/** Absolute path of a tool's capture stream. Routes through `runtimePath` so it
 *  lands in `<vault>/build/_meta` on a migrated vault, else `<vault>/_meta` -
 *  the same resolution every other runtime file uses. */
export function captureStreamPath(vault: string, slug: string): string {
  // One dedicated folder, one file per tool: <vault>/_meta/prompts/<tool>.jsonl
  // (keeps _meta clean rather than scattering prompts.<tool>.jsonl loose).
  return join(runtimePath(vault, "_meta"), "prompts", `${slug}.jsonl`);
}

// ── Per-tool on/off ───────────────────────────────────────────────────────────
// A tool the user has turned OFF is recorded in <vault>/_meta/prompts/.off.json
// as { disabled: [slug, ...] }. Both the live push path (ingest) and the
// automatic reader (ingestBatch / sync) honor it, so "off" means off everywhere.

function captureConfigPath(vault: string): string {
  return join(runtimePath(vault, "_meta"), "prompts", ".off.json");
}

/** Is capture turned OFF for this tool? */
export function isCaptureDisabled(vault: string, slug: string): boolean {
  try {
    const d = (JSON.parse(readFileSync(captureConfigPath(vault), "utf8")) as { disabled?: string[] }).disabled;
    return Array.isArray(d) && d.includes(slug);
  } catch {
    return false;
  }
}

/** Turn capture on (on=true) or off (on=false) for a tool. */
export function setCaptureEnabled(vault: string, slug: string, on: boolean): void {
  const p = captureConfigPath(vault);
  const set = new Set<string>();
  try {
    for (const s of (JSON.parse(readFileSync(p, "utf8")) as { disabled?: string[] }).disabled ?? []) set.add(s);
  } catch {
    /* no file yet */
  }
  if (on) set.delete(slug);
  else set.add(slug);
  try {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, `${JSON.stringify({ disabled: [...set] }, null, 2)}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

/** Dedup key for a prompt: tool + session + content hash. Two identical prompts
 *  in the same session collapse (push hook + pull sync writing the same line),
 *  but the same prompt in a different session is kept (it's a real re-ask). */
function dedupKey(tool: string, session: string, prompt: string): string {
  const h = createHash("sha256").update(prompt).digest("hex");
  return `${tool}\u0000${session}\u0000${h}`;
}

/** Has this exact (tool, session, prompt) already been recorded recently?
 *  Scans only the tail of the stream - push and pull racing on the same prompt
 *  land within a handful of lines, so a bounded scan is enough and keeps ingest
 *  O(1) amortized rather than O(file). */
function isRecentDuplicate(path: string, key: string, scan = 100): boolean {
  if (!existsSync(path)) return false;
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines.slice(-scan)) {
    let rec: Partial<CaptureRecord>;
    try {
      rec = JSON.parse(line) as Partial<CaptureRecord>;
    } catch {
      continue;
    }
    if (
      typeof rec.tool === "string" &&
      typeof rec.session === "string" &&
      typeof rec.prompt === "string" &&
      dedupKey(rec.tool, rec.session, rec.prompt) === key
    ) {
      return true;
    }
  }
  return false;
}

/** Append one prompt to its tool stream. The keystone every adapter calls.
 *  Never throws: all failure is folded into the returned result so a capture
 *  hook can ignore it and let the user's prompt proceed untouched. */
export function ingest(input: IngestInput): IngestResult {
  const slug = safeToolSlug(input.tool);
  const now = input.now ?? new Date();

  // Skip capture for Prevail's OWN internal model calls (distill/taskgen/
  // skillgen/surface). Those spawn a CLI with PREVAIL_INTERNAL=1, which the
  // CLI's own prompt-capture hook subprocess inherits - so without this guard
  // they self-record as "what the user asked", flooding the journal with the
  // injected ideal-state preamble.
  if (process.env.PREVAIL_INTERNAL === "1") {
    return { ok: true, written: false, path: "", tool: slug ?? "", reason: "internal Prevail call — not captured" };
  }

  // Resolve the path defensively even on the error paths so the result always
  // points somewhere meaningful for diagnostics.
  const path = slug
    ? captureStreamPath(input.vault, slug)
    : captureStreamPath(input.vault, "unknown");

  const v = validateVaultPath(input.vault);
  if (!v.ok) return { ok: false, written: false, path, tool: slug ?? "", reason: v.reason };
  if (!slug)
    return { ok: false, written: false, path, tool: "", reason: "missing or invalid --tool" };
  // Honor the per-tool on/off switch (push path).
  if (isCaptureDisabled(input.vault, slug))
    return { ok: true, written: false, path, tool: slug, reason: "disabled" };

  const prompt = (input.prompt ?? "").trim();
  // Empty prompt (e.g. a slash-command-only line, or a hook firing on a blank
  // submit) is a no-op, not an error - exactly like the original hook.
  if (!prompt) return { ok: true, written: false, path, tool: slug, reason: "empty prompt" };

  const session = (input.session ?? "").trim() || "unknown";
  const cwd = (input.cwd ?? "").trim() || process.cwd();

  const key = dedupKey(slug, session, prompt);
  if (isRecentDuplicate(path, key)) {
    return { ok: true, written: false, path, tool: slug, reason: "duplicate" };
  }

  const record: CaptureRecord = {
    ts: now.toISOString(),
    epoch_ms: now.getTime(),
    tool: slug,
    session,
    cwd,
    prompt,
    source: input.source ?? "push",
    host: hostname(),
  };

  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    return { ok: false, written: false, path, tool: slug, error: (err as Error).message };
  }
  return { ok: true, written: true, path, tool: slug };
}

// -----------------------------------------------------------------------------
// Batch ingest - for the pull backstop (`capture sync`), which replays whole
// transcripts. Unlike single ingest's bounded tail-scan, this builds the FULL
// dedup set of the target stream once, so re-scanning a historical transcript
// can never re-append prompts the push hook already captured (their sessions
// match). Original timestamps are preserved from each item.
// -----------------------------------------------------------------------------

export interface BatchItem {
  prompt: string;
  session?: string | null;
  cwd?: string | null;
  /** Original epoch-ms of the prompt; falls back to now when absent. */
  epochMs?: number | null;
}

export interface BatchResult {
  ok: boolean;
  tool: string;
  path: string;
  written: number;
  skipped: number;
  error?: string;
}

/** Load every (tool,session,prompt) key already in a stream into a Set. */
function loadKeySet(path: string, tool: string): Set<string> {
  const set = new Set<string>();
  if (!existsSync(path)) return set;
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return set;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Partial<CaptureRecord>;
      if (typeof rec.session === "string" && typeof rec.prompt === "string") {
        set.add(dedupKey(tool, rec.session, rec.prompt));
      }
    } catch {
      /* tolerate malformed lines */
    }
  }
  return set;
}

/** Append a batch of prompts to a tool stream, de-duplicating against the whole
 *  existing stream (and within the batch). One read + one append, never throws. */
export function ingestBatch(vault: string, tool: string, items: BatchItem[]): BatchResult {
  const slug = safeToolSlug(tool);
  const path = slug ? captureStreamPath(vault, slug) : captureStreamPath(vault, "unknown");
  const v = validateVaultPath(vault);
  if (!v.ok) return { ok: false, tool: slug ?? "", path, written: 0, skipped: 0, error: v.reason };
  if (!slug) return { ok: false, tool: "", path, written: 0, skipped: 0, error: "invalid tool" };
  // Honor the per-tool on/off switch (automatic/sync path).
  if (isCaptureDisabled(vault, slug)) return { ok: true, tool: slug, path, written: 0, skipped: items.length };

  const seen = loadKeySet(path, slug);
  const lines: string[] = [];
  let skipped = 0;
  for (const item of items) {
    const prompt = (item.prompt ?? "").trim();
    if (!prompt) {
      skipped++;
      continue;
    }
    const session = (item.session ?? "").trim() || "unknown";
    const key = dedupKey(slug, session, prompt);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const ms = typeof item.epochMs === "number" && item.epochMs > 0 ? item.epochMs : Date.now();
    const record: CaptureRecord = {
      ts: new Date(ms).toISOString(),
      epoch_ms: ms,
      tool: slug,
      session,
      cwd: (item.cwd ?? "").trim() || "",
      prompt,
      source: "sync",
      host: hostname(),
    };
    lines.push(JSON.stringify(record));
  }

  if (lines.length === 0) return { ok: true, tool: slug, path, written: 0, skipped };
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
  } catch (err) {
    return { ok: false, tool: slug, path, written: 0, skipped, error: (err as Error).message };
  }
  return { ok: true, tool: slug, path, written: lines.length, skipped };
}

// -----------------------------------------------------------------------------
// Status - count what's been captured per stream. Cheap line count; tolerant of
// a missing `_meta` dir (returns empty). Used by `prevail capture status --json`
// and, later, the desktop Integrations panel.
// -----------------------------------------------------------------------------

export interface StreamStatus {
  tool: string;
  path: string;
  count: number;
}

export interface CaptureStatus {
  ok: true;
  meta: string;
  streams: StreamStatus[];
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Report a row per known tool that has a stream on disk. Tools with no stream
 *  yet are omitted so the report reflects reality, not the registry. */
export function statusReport(vault: string): CaptureStatus {
  const meta = runtimePath(vault, "_meta");
  const streams: StreamStatus[] = [];
  for (const t of KNOWN_TOOLS) {
    const path = captureStreamPath(vault, t.slug);
    if (!existsSync(path)) continue;
    streams.push({ tool: t.slug, path, count: countLines(path) });
  }
  return { ok: true, meta, streams };
}
