// Generic pattern runners. The connector system is PATTERN-FIRST: any of the
// user's hundreds of apps connects through one of a small set of patterns
// (api / cli / oauth-auth / browser / mcp / llm), and a new app should need
// only a manifest + skill files — no TypeScript. These runners implement the
// two workhorse patterns:
//
//   cli  — the app has a command-line tool. The skill declares a command
//          template; we run it with a scoped env and capture its output.
//   http — the app has a REST API. The skill declares the request (url,
//          method, headers, body) declaratively; we execute it, save the
//          response, and advance an opaque cursor via a JSON path.
//
// Both honor the same contract as every other runner: outputs sandboxed to
// the connector dir, ===SUMMARY=== extraction, cursor updates returned (never
// written directly — the sync daemon owns sync-state.json).

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { SkillSpec, SkillRunResult, SkillRunOpts } from "./connector-skills.ts";
import { substitute, safeOutputPath, buildSkillEnv } from "./connector-skills.ts";

const MAX_CAPTURE = 512 * 1024; // 512KB stdout/response cap
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// ${...} substitution shared by both runners, extending the base substitute()
// with ${cursor.x} (sync cursor) and ${auth.token} (OAuth access token for
// the connector, resolved lazily so read-only template parsing never hits the
// network).
async function substituteFull(
  template: string,
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: SkillRunOpts,
): Promise<string> {
  const needsToken = template.includes("${auth.token}");
  let token = "";
  if (needsToken) {
    const { refreshAccessToken } = await import("./oauth-flow.ts");
    const r = await refreshAccessToken(skill.connectorId);
    if (!r.ok || !r.accessToken) throw new Error(r.message ?? `oauth refresh failed for ${skill.connectorId}`);
    token = r.accessToken;
  }
  const env = buildSkillEnv(skill);
  return template.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const t = expr.trim();
    if (t === "auth.token") return token;
    if (t.startsWith("cursor.")) {
      const key = t.slice("cursor.".length);
      const v = opts.cursor?.[key];
      return v === undefined || v === null ? "" : String(v);
    }
    // Delegate the base forms (ts, date, input.*, env.*) to substitute() so
    // the semantics stay identical everywhere.
    return substitute(whole, { inputs, env });
  });
}

// Pull a ===SUMMARY=== block out of runner output; fall back to the last
// non-empty line so every run yields something routable.
export function extractSummary(text: string): string {
  const m = text.match(/===SUMMARY===\s*\n([\s\S]*?)(?:\n===|$)/);
  if (m && m[1].trim()) return m[1].trim().slice(0, 600);
  const lines = text.trim().split("\n").filter((l) => l.trim());
  return (lines[lines.length - 1] ?? "").slice(0, 600);
}

// Dotted-path lookup into parsed JSON: "historyId" or "data.items.0.id".
export function jsonPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ────────────────────────────────────────────────────────────────────
// cli runner. Frontmatter:
//   runner: cli
//   command: gh api notifications --paginate
//   timeout_sec: 120          (optional)
//   cursor_from: last line    (optional: "stdout:<json path>" to advance cursor)
// The command runs through the shell WITH A SCOPED ENV (only declared auth
// vars + a minimal base, via buildSkillEnv) and cwd = the connector dir, so
// relative writes land inside the sandbox. Output is captured (capped) and
// written to the skill's declared outputs.
export async function runSkillCli(
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: SkillRunOpts = {},
): Promise<SkillRunResult> {
  const started = Date.now();
  const commandTpl = typeof skill.extra?.command === "string" ? skill.extra.command : "";
  if (!commandTpl) {
    return { ok: false, message: `cli skill "${skill.id}" is missing a command: field`, outputsWritten: [], durationMs: 0 };
  }
  let command: string;
  try {
    command = await substituteFull(commandTpl, skill, inputs, opts);
  } catch (e) {
    return { ok: false, message: String(e instanceof Error ? e.message : e), outputsWritten: [], durationMs: 0 };
  }
  const timeoutSec = typeof skill.extra?.timeout_sec === "number" ? skill.extra.timeout_sec : 0;
  const timeoutMs = timeoutSec > 0 ? Math.min(timeoutSec, 1800) * 1000 : DEFAULT_TIMEOUT_MS;

  const env = buildSkillEnv(skill);
  let stdout = "";
  let stderr = "";
  let code: number;
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: skill.connectorDir,
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(), timeoutMs);
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    code = await proc.exited;
    clearTimeout(killer);
    opts.signal?.removeEventListener("abort", onAbort);
  } catch (e) {
    return { ok: false, message: `spawn failed: ${e}`, outputsWritten: [], durationMs: Date.now() - started };
  }
  stdout = stdout.slice(0, MAX_CAPTURE);

  if (code !== 0) {
    return {
      ok: false,
      message: `command exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`,
      outputsWritten: [],
      durationMs: Date.now() - started,
      raw: stdout.slice(0, 8192),
    };
  }

  // Write declared outputs (the whole capped stdout; templating in paths).
  const written: string[] = [];
  for (const o of skill.outputs) {
    let rel: string;
    try {
      rel = await substituteFull(o.path, skill, inputs, opts);
    } catch (e) {
      return { ok: false, message: String(e instanceof Error ? e.message : e), outputsWritten: written, durationMs: Date.now() - started };
    }
    const abs = safeOutputPath(skill.connectorDir, rel);
    if (!abs) {
      return { ok: false, message: `output path escapes connector dir: ${rel}`, outputsWritten: written, durationMs: Date.now() - started };
    }
    mkdirSync(dirname(abs), { recursive: true });
    if (o.kind === "append") appendFileSync(abs, stdout.endsWith("\n") ? stdout : stdout + "\n");
    else if (o.kind === "markdown") appendFileSync(abs, `\n## ${new Date().toISOString()}\n\n${stdout}\n`);
    else writeFileSync(abs, stdout);
    written.push(relative(skill.connectorDir, abs));
  }

  // Optional cursor advance from stdout JSON.
  const cursor: Record<string, unknown> = {};
  const cursorFrom = typeof skill.extra?.cursor_from === "string" ? skill.extra.cursor_from : "";
  if (cursorFrom.startsWith("stdout:")) {
    try {
      const v = jsonPath(JSON.parse(stdout), cursorFrom.slice("stdout:".length));
      if (v !== undefined) cursor[cursorFrom.slice("stdout:".length)] = v;
    } catch { /* non-JSON stdout: no cursor */ }
  }

  return {
    ok: true,
    message: `ok (${written.length} output${written.length === 1 ? "" : "s"})`,
    outputsWritten: written,
    durationMs: Date.now() - started,
    raw: stdout.slice(0, 8192),
    summary: extractSummary(stdout),
    cursor: Object.keys(cursor).length ? cursor : undefined,
    artifacts: written,
  };
}

// ────────────────────────────────────────────────────────────────────
// http runner (the default for runner: api with no registered provider).
// Frontmatter (flat, parseYamlish-friendly):
//   runner: api
//   url: https://api.example.com/v1/items?since=${cursor.since}
//   method: GET                       (default GET)
//   headers:
//     - "Authorization: Bearer ${auth.token}"
//     - "Accept: application/json"
//   body: '{"q": "${input.query}"}'   (optional; POST/PUT)
//   save: data/items/${date}.json     (optional; defaults to outputs[0])
//   cursor_path: nextCursor           (optional: JSON path in the response
//                                      whose value becomes ${cursor.<last seg>})
//   summary_path: summary             (optional: JSON path rendered as summary)
export async function runSkillHttp(
  skill: SkillSpec,
  inputs: Record<string, unknown>,
  opts: SkillRunOpts = {},
): Promise<SkillRunResult> {
  const started = Date.now();
  const urlTpl = typeof skill.extra?.url === "string" ? skill.extra.url : "";
  if (!urlTpl) {
    return { ok: false, message: `api skill "${skill.id}" has no provider and no url: field`, outputsWritten: [], durationMs: 0 };
  }
  let url: string;
  let body: string | undefined;
  const headers: Record<string, string> = {};
  try {
    url = await substituteFull(urlTpl, skill, inputs, opts);
    if (typeof skill.extra?.body === "string") body = await substituteFull(skill.extra.body, skill, inputs, opts);
    const hdrList = Array.isArray(skill.extra?.headers) ? skill.extra.headers : [];
    for (const h of hdrList) {
      if (typeof h !== "string") continue;
      const idx = h.indexOf(":");
      if (idx <= 0) continue;
      headers[h.slice(0, idx).trim()] = await substituteFull(h.slice(idx + 1).trim(), skill, inputs, opts);
    }
  } catch (e) {
    return { ok: false, message: String(e instanceof Error ? e.message : e), outputsWritten: [], durationMs: 0 };
  }
  if (!/^https:\/\//.test(url)) {
    return { ok: false, message: `http skill urls must be https:// (got ${url.slice(0, 40)})`, outputsWritten: [], durationMs: 0 };
  }
  const method = typeof skill.extra?.method === "string" ? skill.extra.method.toUpperCase() : "GET";

  let text = "";
  let status = 0;
  try {
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    status = res.status;
    text = (await res.text()).slice(0, MAX_CAPTURE);
    clearTimeout(killer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (!res.ok) {
      return {
        ok: false,
        message: `HTTP ${status}: ${text.trim().slice(0, 200)}`,
        outputsWritten: [],
        durationMs: Date.now() - started,
        raw: text.slice(0, 8192),
      };
    }
  } catch (e) {
    return { ok: false, message: `request failed: ${e}`, outputsWritten: [], durationMs: Date.now() - started };
  }

  // Save the response: explicit save: path, else first declared output.
  const written: string[] = [];
  const saveTpl = typeof skill.extra?.save === "string" ? skill.extra.save : skill.outputs[0]?.path;
  if (saveTpl) {
    let rel: string;
    try {
      rel = await substituteFull(saveTpl, skill, inputs, opts);
    } catch (e) {
      return { ok: false, message: String(e instanceof Error ? e.message : e), outputsWritten: [], durationMs: Date.now() - started };
    }
    const abs = safeOutputPath(skill.connectorDir, rel);
    if (!abs) {
      return { ok: false, message: `save path escapes connector dir: ${rel}`, outputsWritten: [], durationMs: Date.now() - started };
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written.push(relative(skill.connectorDir, abs));
  }

  // Cursor + summary extraction from the JSON response.
  const cursor: Record<string, unknown> = {};
  let summary: string | undefined;
  const cursorPath = typeof skill.extra?.cursor_path === "string" ? skill.extra.cursor_path : "";
  const summaryPath = typeof skill.extra?.summary_path === "string" ? skill.extra.summary_path : "";
  if (cursorPath || summaryPath) {
    try {
      const parsed = JSON.parse(text);
      if (cursorPath) {
        const v = jsonPath(parsed, cursorPath);
        const key = cursorPath.split(".").pop()!;
        if (v !== undefined) cursor[key] = v;
      }
      if (summaryPath) {
        const v = jsonPath(parsed, summaryPath);
        if (v !== undefined) summary = String(v).slice(0, 600);
      }
    } catch { /* non-JSON response: skip extraction */ }
  }

  return {
    ok: true,
    message: `HTTP ${status} ok${written.length ? ` (saved ${written[0]})` : ""}`,
    outputsWritten: written,
    durationMs: Date.now() - started,
    raw: text.slice(0, 8192),
    summary: summary ?? extractSummary(text),
    cursor: Object.keys(cursor).length ? cursor : undefined,
    artifacts: written,
  };
}
