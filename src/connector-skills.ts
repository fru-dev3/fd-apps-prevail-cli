import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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

export type SkillRunner = "llm" | "api" | "browser" | "mcp" | "a2a";

export interface SkillSpec {
  id: string;
  filePath: string;
  runner: SkillRunner;
  trigger?: string;             // "on-demand", "cron(...)" or "webhook(...)"
  panelist?: string;            // for llm runner: claude|codex|gemini|ollama
  auth: string[];               // env-var names this skill may read
  inputs: SkillInput[];
  outputs: SkillOutput[];
  description: string;          // body markdown — also serves as the LLM prompt
  // Connector this skill belongs to. Populated by loadSkillsForConnector.
  connectorId: string;
  connectorDir: string;         // absolute path to the connector folder
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
}

// Load every skill declared by a connector. Reads connector/skills/*.md
// and parses the frontmatter. Skills without a valid id or runner are
// silently skipped — a malformed skill file shouldn't break the whole
// list. Caller can list the parse errors via parseSkillFile directly if
// they need diagnostics.
export function loadSkillsForConnector(app: AppSkill): SkillSpec[] {
  const skillsDir = join(app.path, "skills");
  if (!existsSync(skillsDir)) return [];
  const out: SkillSpec[] = [];
  for (const f of readdirSync(skillsDir)) {
    // Skip non-markdown + the connector's SKILL.md overview file.
    if (!f.endsWith(".md") || f === "SKILL.md") continue;
    try {
      const raw = readFileSync(join(skillsDir, f), "utf8");
      const spec = parseSkillFile(raw, join(skillsDir, f), app);
      if (spec) out.push(spec);
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
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
  };
}

function isSafeId(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s);
}

function isValidRunner(s: string): s is SkillRunner {
  return s === "llm" || s === "api" || s === "browser" || s === "mcp" || s === "a2a";
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
  // Check if it's a list of items (each line starts with -)
  const allItems = lines.every((l) => l.trimStart().startsWith("- "));
  if (allItems) {
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
    appendFileSync(absPath, content.endsWith("\n") ? content : content + "\n");
  } else if (kind === "markdown") {
    const stamp = new Date().toISOString().slice(0, 16);
    const block = `\n\n## ${stamp}\n\n${content}\n`;
    appendFileSync(absPath, block);
  } else {
    writeFileSync(absPath, content);
  }
  try { chmodSync(absPath, 0o600); } catch { /* best-effort */ }
}

// Top-level dispatcher. For now only `llm` is implemented; other runners
// return a "not yet implemented" result so the UI can show what's there
// without crashing.
export async function runSkill(
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<SkillRunResult> {
  if (skill.runner === "llm") return runSkillLLM(skill, inputs, opts);
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
  appendFileSync(file, line);
}
