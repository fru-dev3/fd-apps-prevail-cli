import { existsSync, mkdirSync, readdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { vappendLine, vreadFile, vwriteFile } from "./vault-session.ts";
import { homedir } from "node:os";
import { detectClis, runChatTurn } from "./cli-bridge.ts";
import type { AppSkill } from "./vault.ts";

// Connector skill execution layer. A skill is a unit of work the connector
// knows how to do (sync transactions, fetch balance, list institutions).
// Each skill is one markdown file under <connector>/skills/<id>.md with a
// YAML-ish frontmatter block describing the runner, inputs, outputs, auth
// requirements, and trigger.
//
// Five runner types planned:
//   llm        — spawn a CLI with the skill prompt + connector context.
//                Covers 80% of skills. Shipped here.
//   api        — direct HTTP call. Deferred to phase 2.
//   browser    — Playwright. Deferred to phase 6 (heavy dep).
//   mcp        — call a local MCP server tool. Deferred to phase 5.
//   a2a        — call a remote MCP server tool over network. Phase 7.
//
// Security: every skill execution runs in a process with scrubbedEnv()
// applied PLUS only the auth keys the manifest explicitly declares it
// needs. Output writes are confined to the connector's data/ directory.

export type SkillRunner = "llm" | "api" | "cli" | "browser" | "browser-agent" | "mcp" | "a2a";

// --- Fix #8: per-app multi-method skill model ------------------------------
// An app can expose the SAME capability (e.g. "sync-inbox") through several
// ACCESS METHODS: browser automation, a local/remote MCP server, or a direct
// API. We collapse the seven runner kinds into the three external access
// methods the fallback engine reasons about ("other" = llm/cli, which are not
// app-access methods and never participate in fallback).
export type SkillAccessMethod = "browser" | "mcp" | "api" | "other";

export function accessMethodForRunner(runner: SkillRunner): SkillAccessMethod {
  if (runner === "browser" || runner === "browser-agent") return "browser";
  if (runner === "mcp" || runner === "a2a") return "mcp";
  if (runner === "api") return "api";
  return "other"; // llm, cli
}

export interface SkillSpec {
  id: string;
  filePath: string;
  runner: SkillRunner;
  trigger?: string;             // "on-demand", "refresh", "cron(...)" or "webhook(...)"
  panelist?: string;            // for llm runner: claude|codex|gemini|ollama
  auth: string[];               // env-var names this skill may read
  inputs: SkillInput[];
  outputs: SkillOutput[];
  description: string;          // body markdown — also serves as the LLM prompt
  // Connector this skill belongs to. Populated by loadSkillsForConnector.
  connectorId: string;
  connectorDir: string;         // absolute path to the connector folder
  // --- api-runner routing (provider registry) ---
  provider?: string;            // "gmail" | "gcal" | "garmin" — which provider module runs this
  op?: string;                  // provider-specific operation, e.g. "sync" | "createDraft" | "send"
  // Chain: run this skill automatically after the named skill succeeds in the
  // same sync pass (e.g. triage-inbox is `after: sync-inbox`). Can be a
  // comma-separated list of alternative predecessors — the skill chains if
  // any one of them ran (e.g. `after: sync-inbox, sync-inbox-mcp, sync-inbox-cli`).
  after?: string;
  // --- Fix #8: multi-method skill packs ---
  // These are OPTIONAL on the type (so existing literal SkillSpec construction
  // stays valid) but are always populated by parseSkillFile. Pack logic reads
  // them through effective-value getters that fall back to deriving from
  // runner/id, so a skill missing them still groups and orders correctly.
  //
  // The external access method this skill uses (derived from `runner`).
  method?: SkillAccessMethod;
  // Logical capability this skill implements. Skills that share a capability
  // form a "pack": one favorite/primary method plus fallbacks. Set explicitly
  // via frontmatter `capability:`; otherwise derived by stripping a trailing
  // method suffix from the id (so "sync-inbox" + "sync-inbox-mcp" group on their
  // own, preserving backward compatibility for single-method apps).
  capability?: string;
  // The designated favorite/primary method for the capability. Set via
  // frontmatter `favorite: true`. When no member of a pack is marked, the
  // browser-method skill is the default favorite (see orderSkillPack).
  isFavorite?: boolean;
  // The full parsed frontmatter, for pattern runners (cli/http) that read
  // their own declarative keys (command, url, headers, cursor_path, ...).
  extra?: Record<string, unknown>;
}

// Op classes for the autonomy gate. Anything not listed is a read op.
const DRAFT_OPS = new Set(["createDraft", "draft", "modifyLabels", "label"]);
const ACT_OPS = new Set(["send", "sendMessage", "delete", "act"]);

export type OpClass = "read" | "draft" | "act";

export function classifyOp(op: string | undefined): OpClass {
  if (!op) return "read";
  if (ACT_OPS.has(op)) return "act";
  if (DRAFT_OPS.has(op)) return "draft";
  return "read";
}

// The autonomy gate. Enforced in code at the runner boundary, never in the
// prompt: a connector at "read-only" cannot draft; only "act" can send.
export function autonomyAllows(autonomy: string | undefined, opClass: OpClass): boolean {
  const level = autonomy === "act" ? 2 : autonomy === "draft" ? 1 : 0;
  const need = opClass === "act" ? 2 : opClass === "draft" ? 1 : 0;
  return level >= need;
}

export interface SkillInput {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
}

export interface SkillOutput {
  // Path template under data/. Supports ${input.name} substitution.
  path: string;
  // append: JSONL append; replace: overwrite; markdown: append with header.
  kind: "append" | "replace" | "markdown";
  description?: string;
}

export interface SkillRunResult {
  ok: boolean;
  message: string;
  outputsWritten: string[];
  durationMs: number;
  // Raw LLM reply (or HTTP response body, for non-LLM runners). Truncated
  // to 8KB to keep TUI memory bounded.
  raw?: string;
  // One-paragraph human summary of what the run found/did. Routed into the
  // target domains' intent ledgers by the sync daemon. Runners populate it
  // from a ===SUMMARY=== block (llm/cli) or build it themselves (api).
  summary?: string;
  // Cursor updates to persist in sync-state.json (provider-opaque: a Gmail
  // historyId, a statement date, an etag). Merged over the previous cursor.
  cursor?: Record<string, unknown>;
  // New files this run created under the connector dir (relative paths).
  // The daemon matches routes[] against these for copy/pointer routing.
  artifacts?: string[];
  // Set by the browser REPLAY runner when a recorded skill drifts (a selector
  // missed, a success marker failed, the login wall reappeared). The daemon
  // uses this to queue a re-learn + notify the user, rather than auto-launching
  // a headed browser. Carries why it broke and which step.
  needsRelearn?: { reason: string; failedStep?: number };
}

// Load every skill declared by a connector. Reads connector/skills/*.md
// and parses the frontmatter. Skills without a valid id or runner are
// silently skipped — a malformed skill file shouldn't break the whole
// list. Caller can list the parse errors via parseSkillFile directly if
// they need diagnostics.
export function loadSkillsForConnector(app: AppSkill): SkillSpec[] {
  return loadSkillsFromDir(join(app.path, "skills"), app);
}

// Parse every skill file under an explicit `skills` directory, attributing each
// to `app` (connectorId/connectorDir). Used both for an app's own skills dir
// (loadSkillsForConnector) and for shipped starter-pack dirs that have not been
// seeded into the vault yet (listAvailableSkills).
export function loadSkillsFromDir(skillsDir: string, app: AppSkill): SkillSpec[] {
  if (!existsSync(skillsDir)) return [];
  const out: SkillSpec[] = [];
  // Two layouts supported: a flat `skills/<id>.md` file, or a
  // `skills/<id>/SKILL.md` subdirectory (mirrors how a connector itself is a
  // folder with a SKILL.md). Real community apps use the subdirectory form.
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    let filePath: string | null = null;
    if (entry.isDirectory()) {
      const inner = join(skillsDir, entry.name, "SKILL.md");
      if (existsSync(inner)) filePath = inner;
    } else if (entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
      filePath = join(skillsDir, entry.name);
    }
    if (!filePath) continue;
    try {
      const spec = parseSkillFile(vreadFile(filePath), filePath, app);
      if (spec) out.push(spec);
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// One entry in the AVAILABLE-skills listing the desktop renders. This is the
// stable wire contract for `prevail connectors skills <id> --json`: every field
// is required so the desktop can render + run a skill with no second call. The
// `spec` is carried for in-process callers (skill-run) and is NOT serialized.
export interface AvailableSkill {
  id: string;
  name: string;
  method: SkillAccessMethod;
  primary: boolean;                 // the favorite/lead of its capability pack
  source: "starter" | "learned";    // shipped pack vs browser-learned in the vault
  trigger: string;
  summary: string;
  spec: SkillSpec;
}

// A human label for a skill id: "sync-inbox-browser" -> "Sync Inbox Browser".
function niceSkillName(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || id;
}

// First real prose line of a skill body (skip headings, tables, code fences),
// capped, for the listing summary.
function skillSummary(description: string): string {
  for (const raw of (description ?? "").split("\n")) {
    const t = raw.trim();
    if (t && !t.startsWith("#") && !t.startsWith("|") && !t.startsWith("```") && !t.startsWith(">")) {
      return t.replace(/[*_`>]/g, "").replace(/^[-\s]+/, "").slice(0, 200);
    }
  }
  return "";
}

// The app's AVAILABLE skills: shipped starter-pack skills (parsed directly from
// the bundled `shippedDirs`, even when the app is not connected or seeded)
// MERGED with any skills already on disk in the app's own skills dir (seeded
// starters and browser-learned skills), deduped by id. The on-disk spec wins as
// the runnable spec; `source` is "starter" whenever the id ships in a pack, else
// "learned". `primary` marks the favorite/lead of each capability pack.
export function listAvailableSkills(app: AppSkill, shippedDirs: string[]): AvailableSkill[] {
  const byId = new Map<string, SkillSpec>();
  const shippedIds = new Set<string>();
  for (const dir of shippedDirs) {
    for (const s of loadSkillsFromDir(dir, app)) {
      shippedIds.add(s.id);
      if (!byId.has(s.id)) byId.set(s.id, s);
    }
  }
  // On-disk skills are authoritative (the seeded/edited/learned versions).
  for (const s of loadSkillsForConnector(app)) byId.set(s.id, s);

  const specs = [...byId.values()];
  const primaryIds = new Set(buildSkillPacks(specs).map((p) => p.skills[0]!.id));
  return specs
    .map((spec) => ({
      id: spec.id,
      name: niceSkillName(spec.id),
      method: effectiveMethod(spec),
      primary: primaryIds.has(spec.id),
      source: (shippedIds.has(spec.id) ? "starter" : "learned") as "starter" | "learned",
      trigger: spec.trigger ?? "on-demand",
      summary: skillSummary(spec.description),
      spec,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function parseSkillFile(raw: string, filePath: string, app: AppSkill): SkillSpec | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, unknown> = parseYamlish(m[1]!);
  const id = typeof fm.id === "string" ? fm.id : null;
  const runnerRaw = typeof fm.runner === "string" ? fm.runner : null;
  if (!id || !runnerRaw) return null;
  if (!isSafeId(id)) return null;
  if (!isValidRunner(runnerRaw)) return null;

  return {
    id,
    filePath,
    runner: runnerRaw,
    trigger: typeof fm.trigger === "string" ? fm.trigger : undefined,
    panelist: typeof fm.panelist === "string" ? fm.panelist : undefined,
    auth: Array.isArray(fm.auth)
      ? (fm.auth as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    inputs: Array.isArray(fm.inputs) ? coerceInputs(fm.inputs as unknown[]) : [],
    outputs: Array.isArray(fm.outputs) ? coerceOutputs(fm.outputs as unknown[]) : [],
    description: m[2]!.trim(),
    connectorId: app.id,
    connectorDir: app.path,
    provider: typeof fm.provider === "string" && isSafeId(fm.provider) ? fm.provider : undefined,
    op: typeof fm.op === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(fm.op) ? fm.op : undefined,
    // Allow comma-separated alternative predecessors: "sync-inbox, sync-inbox-mcp"
    after: typeof fm.after === "string"
      ? fm.after.split(",").map((s) => s.trim()).filter((s) => s && isSafeId(s)).join(",") || undefined
      : undefined,
    // Access method: honor an explicit frontmatter `method:` ONLY when it names a
    // valid access method (browser|mcp|api|other); otherwise derive it from the
    // runner. This keeps the api runner's `method: GET` HTTP-verb convention
    // intact (a verb is not a valid access method, so it falls through to the
    // runner-derived value) while letting a skill declare its method explicitly.
    method: coerceAccessMethod(fm.method) ?? accessMethodForRunner(runnerRaw),
    capability: deriveCapability(fm, id),
    isFavorite: fm.favorite === true,
    extra: fm,
  };
}

// Trailing method suffix on a skill id, stripped to derive its capability when
// no explicit `capability:` is declared. Keeps single-method apps unchanged
// (their id has no such suffix, so capability === id).
const METHOD_ID_SUFFIX = /-(?:browser|mcp|api|cli|llm|a2a|http)$/i;

function deriveCapability(fm: Record<string, unknown>, id: string): string {
  if (typeof fm.capability === "string" && isSafeId(fm.capability)) return fm.capability;
  const stripped = id.replace(METHOD_ID_SUFFIX, "");
  return stripped || id;
}

// A frontmatter `method:` value, accepted only when it names a real access
// method. Anything else (notably an HTTP verb like GET, which the api runner
// reads from the same key) returns undefined so the runner-derived method wins.
function coerceAccessMethod(v: unknown): SkillAccessMethod | undefined {
  return v === "browser" || v === "mcp" || v === "api" || v === "other" ? v : undefined;
}

function isSafeId(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s);
}

function isValidRunner(s: string): s is SkillRunner {
  return s === "llm" || s === "api" || s === "cli" || s === "browser" || s === "browser-agent" || s === "mcp" || s === "a2a";
}

function coerceInputs(items: unknown[]): SkillInput[] {
  const out: SkillInput[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : null;
    if (!name) continue;
    const type = o.type === "number" || o.type === "boolean" ? o.type : "string";
    out.push({
      name,
      type,
      required: o.required === true,
      description: typeof o.description === "string" ? o.description : undefined,
    });
  }
  return out;
}

function coerceOutputs(items: unknown[]): SkillOutput[] {
  const out: SkillOutput[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path : null;
    if (!path) continue;
    const kind = o.kind === "replace" || o.kind === "markdown" ? o.kind : "append";
    out.push({
      path,
      kind,
      description: typeof o.description === "string" ? o.description : undefined,
    });
  }
  return out;
}

// Tiny YAML-ish parser. Handles top-level scalars + arrays of strings +
// arrays of objects (one nested level deep), which is everything our skill
// frontmatter needs. NOT a real YAML parser — we deliberately don't pull
// in a dependency for this. Throws nothing; returns {} on garbage.
export function parseYamlish(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent !== 0) {
      i++;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const after = line.slice(colon + 1).trim();
    if (after === "") {
      // Block — collect indented children
      const children: string[] = [];
      i++;
      while (i < lines.length) {
        const nl = lines[i]!;
        if (nl.trim() === "" || nl.trim().startsWith("#")) {
          i++;
          continue;
        }
        const ind = nl.length - nl.trimStart().length;
        if (ind === 0) break;
        children.push(nl);
        i++;
      }
      out[key] = parseBlock(children);
      continue;
    }
    out[key] = parseScalar(after);
    i++;
  }
  return out;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  // Strict JSON flow object/array (e.g. an inline `success_check:` or
  // `domain_allow:` written by the recorder). Lenient handling follows below.
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      /* not strict JSON — fall through to lenient handling */
    }
  }
  // String — strip surrounding quotes if present.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  // Inline array: [a, b, c]
  if (t.startsWith("[") && t.endsWith("]")) {
    const body = t.slice(1, -1).trim();
    if (!body) return [];
    return body.split(",").map((s) => parseScalar(s));
  }
  return t;
}

function parseBlock(lines: string[]): unknown {
  if (lines.length === 0) return [];
  // A block whose FIRST child is a "- " item is a list; later lines without
  // the dash are continuation fields of the previous item (block-style
  // objects in a list), which the grouping loop below folds in. The old
  // every()-check misclassified those blocks as objects and produced keys
  // like "- path".
  const isList = lines[0]!.trimStart().startsWith("- ");
  if (isList) {
    const items: unknown[] = [];
    // Group consecutive items
    let current: string[] = [];
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (line.trimStart().startsWith("- ")) {
        if (current.length > 0) items.push(parseItem(current));
        current = [line.slice(indent + 2)];
      } else {
        current.push(line.slice(indent));
      }
    }
    if (current.length > 0) items.push(parseItem(current));
    return items;
  }
  // Object: key: value lines
  const obj: Record<string, unknown> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    obj[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1).trim());
  }
  return obj;
}

function parseItem(lines: string[]): unknown {
  // Inline object on a single line: { name: x, type: string }
  if (lines.length === 1) {
    const t = lines[0]!.trim();
    // Strict JSON flow object/array first (e.g. recorded browser `steps:` use
    // JSON.stringify, which has nested objects the loose splitter can't handle).
    // Falls through to the lenient unquoted-object parse for legacy skill files.
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.parse(t);
      } catch {
        /* not strict JSON — fall through */
      }
    }
    if (t.startsWith("{") && t.endsWith("}")) {
      const obj: Record<string, unknown> = {};
      const body = t.slice(1, -1);
      // Split on commas not inside nested braces (we don't have nesting yet).
      for (const pair of body.split(",")) {
        const colon = pair.indexOf(":");
        if (colon < 0) continue;
        obj[pair.slice(0, colon).trim()] = parseScalar(pair.slice(colon + 1).trim());
      }
      return obj;
    }
    return parseScalar(t);
  }
  // Multi-line object: each line "key: value"
  const obj: Record<string, unknown> = {};
  for (const line of lines) {
    const t = line.trim();
    const colon = t.indexOf(":");
    if (colon < 0) continue;
    obj[t.slice(0, colon).trim()] = parseScalar(t.slice(colon + 1).trim());
  }
  return obj;
}

// Substitute ${input.name} / ${env.VAR} / ${ts} in a string template. Used
// for the output path and (in future runners) the HTTP body. Strict —
// unknown variables throw so a skill can't accidentally write to a half-
// resolved path.
export function substitute(template: string, ctx: { inputs: Record<string, unknown>; env: NodeJS.ProcessEnv }): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const t = expr.trim();
    if (t === "ts") return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (t === "date") return new Date().toISOString().slice(0, 10);
    if (t.startsWith("input.")) {
      const key = t.slice("input.".length);
      if (!(key in ctx.inputs)) throw new Error(`unknown input: ${key}`);
      return String(ctx.inputs[key]);
    }
    if (t.startsWith("env.")) {
      const key = t.slice("env.".length);
      const v = ctx.env[key];
      if (v === undefined) throw new Error(`unset env var: ${key}`);
      return v;
    }
    throw new Error(`unknown template expression: ${expr}`);
  });
}

// Confirm a resolved output path lives under the connector's data/ dir.
// Refuses ../ escapes; returns null when not safe.
export function safeOutputPath(connectorDir: string, relPath: string): string | null {
  const dataRoot = resolve(connectorDir, "data");
  const target = resolve(dataRoot, relPath);
  if (target !== dataRoot && !target.startsWith(dataRoot + sep)) return null;
  return target;
}

// Confine the env passed to LLM runners. Start from prevail's already-
// scrubbed env (no secrets), then ADD BACK only the auth keys the skill
// explicitly declared. Belt-and-suspenders: even if a skill prompt-injects
// the model into trying to read other secrets, they aren't in the env.
import { scrubbedEnv } from "./cli-bridge.ts";

export function buildSkillEnv(skill: SkillSpec): NodeJS.ProcessEnv {
  const env = scrubbedEnv();
  for (const key of skill.auth) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

// Run an LLM-runner skill. Builds a prompt from the skill's description +
// inputs, picks a panelist CLI, fires runChatTurn, captures the reply,
// writes it to each declared output path. Returns a structured result the
// UI can render.
export async function runSkillLLM(
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<SkillRunResult> {
  const t0 = Date.now();
  // Validate inputs first.
  for (const i of skill.inputs) {
    if (i.required && !(i.name in inputs)) {
      return {
        ok: false,
        message: `missing required input: ${i.name}`,
        outputsWritten: [],
        durationMs: 0,
      };
    }
  }
  // Resolve outputs early so we fail before spending a model call if a
  // path is malformed or escapes the connector.
  const env = buildSkillEnv(skill);
  const resolved: { spec: SkillOutput; absPath: string }[] = [];
  for (const o of skill.outputs) {
    let rel: string;
    try {
      rel = substitute(o.path, { inputs, env });
    } catch (err) {
      return { ok: false, message: (err as Error).message, outputsWritten: [], durationMs: 0 };
    }
    const abs = safeOutputPath(skill.connectorDir, rel);
    if (!abs) {
      return {
        ok: false,
        message: `output path escapes connector data dir: ${rel}`,
        outputsWritten: [],
        durationMs: 0,
      };
    }
    resolved.push({ spec: o, absPath: abs });
  }

  // Pick a panelist.
  const clis = await detectClis();
  if (clis.length === 0) {
    return { ok: false, message: "no CLIs detected", outputsWritten: [], durationMs: 0 };
  }
  const wantKind = skill.panelist ?? "claude";
  const cli = clis.find((c) => c.kind === wantKind) ?? clis[0]!;

  // Build the LLM prompt. We pass the skill description verbatim so the
  // markdown body IS the spec. Inputs and connector context follow.
  const ctx = [
    `You are running the "${skill.id}" skill for the ${skill.connectorId} connector.`,
    `Connector directory: ${skill.connectorDir}`,
    `Auth available in env: ${skill.auth.join(", ") || "(none)"}`,
    `Inputs: ${JSON.stringify(inputs)}`,
    ``,
    `--- SKILL DESCRIPTION ---`,
    skill.description,
    ``,
    `--- INSTRUCTIONS ---`,
    `Produce the output that should be WRITTEN to each declared output path. If multiple outputs, separate them with a line like:`,
    ``,
    `===OUTPUT: <path>===`,
    ``,
    `Then the content. The output paths are:`,
    ...skill.outputs.map((o) => `  - ${o.path} (${o.kind})`),
    ``,
    `Do not include any preamble, explanation, or commentary outside the output blocks.`,
  ].join("\n");

  let raw: string;
  try {
    raw = await runChatTurn({
      prompt: ctx,
      cwd: skill.connectorDir,
      cli,
      model: "",
      isFirst: true,
      bare: true,
      signal: opts.signal,
    });
  } catch (err) {
    return { ok: false, message: (err as Error).message, outputsWritten: [], durationMs: Date.now() - t0 };
  }

  // Split the model's reply by output markers. Single-output skills just
  // get the whole reply (forgive the model for not using the marker).
  const written: string[] = [];
  if (resolved.length === 1) {
    const r = resolved[0]!;
    try {
      writeOutput(r.absPath, r.spec.kind, stripMarker(raw, r.spec.path));
      written.push(r.absPath);
    } catch (err) {
      return { ok: false, message: `write failed: ${(err as Error).message}`, outputsWritten: [], durationMs: Date.now() - t0, raw: raw.slice(0, 8000) };
    }
  } else {
    const parts = raw.split(/===OUTPUT:\s*([^=]+?)\s*===/);
    // parts: [pre, path1, body1, path2, body2, ...]
    for (let i = 1; i < parts.length; i += 2) {
      const declaredPath = parts[i]!.trim();
      const body = (parts[i + 1] ?? "").trim();
      const match = resolved.find((r) => r.spec.path === declaredPath || r.absPath.endsWith(declaredPath));
      if (!match) continue;
      try {
        writeOutput(match.absPath, match.spec.kind, body);
        written.push(match.absPath);
      } catch {
        /* skip individual write failures */
      }
    }
  }

  return {
    ok: written.length > 0,
    message:
      written.length > 0
        ? `wrote ${written.length} output${written.length === 1 ? "" : "s"}`
        : "model produced no output",
    outputsWritten: written,
    durationMs: Date.now() - t0,
    raw: raw.slice(0, 8000),
  };
}

function stripMarker(raw: string, path: string): string {
  // If the model used the marker even for a single output, peel it off.
  const re = new RegExp(`===OUTPUT:\\s*${path.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*===\\s*`, "m");
  return raw.replace(re, "").trim();
}

function writeOutput(absPath: string, kind: SkillOutput["kind"], content: string): void {
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (kind === "append") {
    vappendLine(absPath, content.endsWith("\n") ? content : content + "\n");
  } else if (kind === "markdown") {
    const stamp = new Date().toISOString().slice(0, 16);
    const block = `\n\n## ${stamp}\n\n${content}\n`;
    vappendLine(absPath, block);
  } else {
    vwriteFile(absPath, content);
  }
  try { chmodSync(absPath, 0o600); } catch { /* best-effort */ }
}

// Top-level dispatcher. For now only `llm` is implemented; other runners
// return a "not yet implemented" result so the UI can show what's there
// without crashing.
// Provider registry for the api runner. Each provider module registers a
// single entry point; the skill's `op` selects the operation inside it.
// Registered lazily by daemon-sync / CLI commands to avoid import cycles.
export type ApiProviderRun = (
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: SkillRunOpts,
) => Promise<SkillRunResult>;
const API_PROVIDERS = new Map<string, ApiProviderRun>();
export function registerApiProvider(name: string, run: ApiProviderRun): void {
  API_PROVIDERS.set(name, run);
}

export interface SkillRunOpts {
  signal?: AbortSignal;
  autonomy?: string;
  // Sync cursor from sync-state.json, exposed to templates as ${cursor.x}.
  cursor?: Record<string, unknown>;
  // Optional progress sink. The browser runners emit NDJSON-shaped step/download
  // events here so the desktop can stream a live learn/replay timeline.
  onProgress?: (event: Record<string, unknown>) => void;
}

export async function runSkill(
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: SkillRunOpts = {},
): Promise<SkillRunResult> {
  // Autonomy gate: applies to every runner. The op class comes from the
  // skill's declared op; llm-only skills are read-class by definition (they
  // can't touch the outside world except via a follow-up api skill, which
  // gets gated itself).
  const opClass = classifyOp(skill.op);
  if (!autonomyAllows(opts.autonomy, opClass)) {
    return {
      ok: false,
      message: `blocked: "${skill.id}" needs autonomy "${opClass}" but connector is "${opts.autonomy ?? "read-only"}". Raise it with: prevail connectors set ${skill.connectorId} autonomy ${opClass === "act" ? "act" : "draft"}`,
      outputsWritten: [],
      durationMs: 0,
    };
  }
  if (skill.runner === "llm") return runSkillLLM(skill, inputs, opts);
  if (skill.runner === "cli") {
    const { runSkillCli } = await import("./runners.ts");
    return runSkillCli(skill, inputs, opts);
  }
  if (skill.runner === "api") {
    // Pattern-first: a registered provider module is the ESCAPE HATCH for
    // providers whose cursor/pagination semantics need real code. The default
    // path is the generic declarative HTTP runner — any REST app works with
    // just a manifest + skill file, no code.
    const provider = skill.provider ? API_PROVIDERS.get(skill.provider) : undefined;
    if (provider) return provider(skill, inputs, opts);
    const { runSkillHttp } = await import("./runners.ts");
    return runSkillHttp(skill, inputs, opts);
  }
  if (skill.runner === "mcp") {
    const { runSkillMcp } = await import("./runners.ts");
    return runSkillMcp(skill, inputs, opts);
  }
  if (skill.runner === "a2a") {
    const { runSkillA2a } = await import("./runners.ts");
    return runSkillA2a(skill, inputs, opts);
  }
  if (skill.runner === "browser") {
    const { runSkillBrowser } = await import("./runners.ts");
    return runSkillBrowser(skill, inputs, opts);
  }
  if (skill.runner === "browser-agent") {
    const { runSkillBrowserAgent } = await import("./browser-agent.ts");
    return runSkillBrowserAgent(skill, inputs, opts);
  }
  return {
    ok: false,
    message: `runner "${skill.runner}" not yet implemented (shipping in v0.6 phase ${runnerPhase(skill.runner)})`,
    outputsWritten: [],
    durationMs: 0,
  };
}

function runnerPhase(runner: SkillRunner): number {
  if (runner === "api") return 2;
  if (runner === "mcp") return 5;
  if (runner === "browser") return 6;
  if (runner === "a2a") return 7;
  return 0;
}

// ---------------------------------------------------------------------------
// Fix #8: multi-method skill packs with favorite + automatic fallback
// ---------------------------------------------------------------------------
//
// A "pack" groups every skill that implements the same capability for an app.
// One method is the favorite/primary (default: browser automation). At run
// time we try the favorite first and, if it is blocked or fails, fall through
// to the next available method, in order of robustness. This is fully backward
// compatible: an app with a single skill per id forms a one-member pack whose
// favorite is that skill, so behavior is identical to calling runSkill directly.

export interface SkillPack {
  capability: string;
  connectorId: string;
  // Skills ordered for execution: favorite/primary first, then fallbacks.
  skills: SkillSpec[];
}

// Fallback robustness order for NON-favorite methods. MCP and direct API are
// preferred over browser automation (more stable, no headed login walls);
// "other" (llm/cli) is last. The favorite is always pulled to the front
// regardless of this rank.
const METHOD_FALLBACK_RANK: Record<SkillAccessMethod, number> = { mcp: 0, api: 1, browser: 2, other: 3 };

// Effective access method / capability for a skill: use the populated field,
// else derive it (keeps packs correct for literally-constructed SkillSpecs).
export function effectiveMethod(s: SkillSpec): SkillAccessMethod {
  return s.method ?? accessMethodForRunner(s.runner);
}
export function effectiveCapability(s: SkillSpec): string {
  if (s.capability) return s.capability;
  return s.id.replace(METHOD_ID_SUFFIX, "") || s.id;
}

// Order a pack's members: favorite first, then fallbacks by robustness rank,
// then id for stability. The default favorite (when none is flagged) is the
// browser-method skill, per #8.
export function orderSkillPack(members: SkillSpec[]): SkillSpec[] {
  if (members.length <= 1) return [...members];
  const favorite =
    members.find((m) => m.isFavorite) ?? members.find((m) => effectiveMethod(m) === "browser") ?? members[0]!;
  const rest = members
    .filter((m) => m !== favorite)
    .sort(
      (a, b) =>
        METHOD_FALLBACK_RANK[effectiveMethod(a)] - METHOD_FALLBACK_RANK[effectiveMethod(b)] ||
        a.id.localeCompare(b.id),
    );
  return [favorite, ...rest];
}

// Group a connector's skills into capability packs (each ordered for fallback).
export function buildSkillPacks(skills: SkillSpec[]): SkillPack[] {
  const byCapability = new Map<string, SkillSpec[]>();
  for (const s of skills) {
    const cap = effectiveCapability(s);
    const arr = byCapability.get(cap) ?? [];
    arr.push(s);
    byCapability.set(cap, arr);
  }
  const packs: SkillPack[] = [];
  for (const [capability, members] of byCapability) {
    packs.push({ capability, connectorId: members[0]!.connectorId, skills: orderSkillPack(members) });
  }
  return packs.sort((a, b) => a.capability.localeCompare(b.capability));
}

// Convenience: load an app's skills and return them grouped into packs.
export function loadSkillPacksForConnector(app: AppSkill): SkillPack[] {
  return buildSkillPacks(loadSkillsForConnector(app));
}

// One attempt within a fallback run, for auditing / UI.
export interface FallbackAttempt {
  skillId: string;
  method: SkillAccessMethod;
  ok: boolean;
  message: string;
}

export interface PackRunResult extends SkillRunResult {
  // The method that ultimately satisfied the capability (undefined if all failed).
  methodUsed?: SkillAccessMethod;
  // Every method tried, in order, with its outcome.
  attempts: FallbackAttempt[];
}

// Run a capability pack with automatic fallback: try the favorite first, and on
// a block/failure/drift fall through to the next available method. Returns the
// first success, or the LAST failure with the full attempt trail. Each method
// is run through the existing runSkill (autonomy gate, runners, logging hooks
// stay intact), so this is purely an ORCHESTRATION layer over the current flow.
export async function runSkillPackWithFallback(
  pack: SkillPack,
  inputs: Record<string, unknown>,
  opts: SkillRunOpts = {},
): Promise<PackRunResult> {
  const attempts: FallbackAttempt[] = [];
  let last: SkillRunResult | null = null;
  for (const skill of pack.skills) {
    const method = effectiveMethod(skill);
    const res = await runSkill(skill, inputs, opts);
    attempts.push({ skillId: skill.id, method, ok: res.ok, message: res.message });
    // Success (a browser replay that flags needsRelearn still "ran", so we keep
    // it as the result but stop here rather than burning another method).
    if (res.ok) return { ...res, methodUsed: method, attempts };
    last = res;
    // Blocked or failed: announce the fall-through and try the next method.
    if (pack.skills.length > attempts.length) {
      opts.onProgress?.({
        event: "method_fallback",
        capability: pack.capability,
        from: skill.id,
        method,
        reason: res.message,
      });
    }
  }
  return {
    ...(last ?? { ok: false, message: "no skills in pack", outputsWritten: [], durationMs: 0 }),
    attempts,
  };
}

// Build the capability pack that CONTAINS a chosen skill, ordered for a fallback
// run that LEADS with the explicitly chosen skill. Used by the autonomous call
// sites (daemon-sync refresh, orchestrator playbook step) so a blocked favorite
// (e.g. a browser login wall, an unconfigured MCP server) transparently falls
// through to the same capability's other method.
//
// Ordering: the explicitly chosen `primary` runs first (it encodes the manifest
// refresh.skill / connection override / playbook step's deliberate choice), then
// the remaining members of its capability follow in robustness order (see
// orderSkillPack / METHOD_FALLBACK_RANK). When `primary` is the only member of
// its capability this returns a one-skill pack, so runSkillPackWithFallback is
// byte-for-byte equivalent to a single runSkill call (backward compatible).
export function packForSkill(primary: SkillSpec, allSkills: SkillSpec[]): SkillPack {
  const cap = effectiveCapability(primary);
  const members = allSkills.filter((s) => effectiveCapability(s) === cap);
  // orderSkillPack puts the favorite first; we then pull the explicitly chosen
  // primary to the very front so an explicit method choice always leads, while
  // the favorite flag still governs the order of the remaining fallbacks.
  const ordered = orderSkillPack(members.length > 0 ? members : [primary]);
  const skills = [primary, ...ordered.filter((s) => s.id !== primary.id)];
  return { capability: cap, connectorId: primary.connectorId, skills };
}

// NOTE on the third #8 call site: the app-detail Skills-tab "Run" button is
// deliberately LEFT as a single runSkill. That UI lists every skill method as
// its own row with its own Run control, so a click is a user explicitly invoking
// ONE named method (often to test/debug a specific runner). Silently falling
// through to a different method there would be surprising and hide which method
// actually works. Autonomous paths (the sync daemon and the orchestrator) use
// packForSkill + runSkillPackWithFallback instead.

// Per-connector log of skill runs. Used by the UI's Sync tab and by
// downstream auditing.
export function logSkillRun(skill: SkillSpec, result: SkillRunResult): void {
  const logDir = join(skill.connectorDir, "_log");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const file = join(logDir, new Date().toISOString().slice(0, 10) + ".md");
  const stamp = new Date().toISOString().slice(11, 16);
  const status = result.ok ? "✓" : "✗";
  const line = [
    "",
    `## ${stamp}  ·  ${skill.id}  ·  ${status} ${result.message}`,
    `- runner: ${skill.runner}`,
    `- duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `- outputs: ${result.outputsWritten.length === 0 ? "(none)" : result.outputsWritten.map((p) => p.replace(homedir(), "~")).join(", ")}`,
    "",
  ].join("\n");
  vappendLine(file, line);
}
