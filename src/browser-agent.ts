// browser-agent — the agentic learn loop. An LLM (the user's own model CLI,
// via runChatTurn) drives a headed browser to accomplish a natural-language
// goal on a login-walled site, then the run is recorded into a deterministic
// replay skill (browser-record). This is the EXPENSIVE path: it runs once on
// first-connect and again only when replay drifts.
//
// Design constraints baked in:
//   * The model is a text-in/text-out subprocess. No function-calling. So the
//     protocol is ReAct: render the page as text, ask for exactly ONE JSON
//     action, parse it tolerantly (extractFirstJsonObject), validate strictly.
//   * The model targets opaque refs ("e12") from the snapshot; the driver maps
//     ref → element. Selectors never round-trip through the model.
//   * Guardrails (read-only, credential refusal, consequential confirm) are
//     enforced in code via browser-actions.guardAgentAction — never the prompt.
//   * Everything the model sees is redacted by the driver before it arrives.
//
// The loop is written against the DriverLike + askModel interfaces so it is
// unit-testable with mocks (no real browser, no real model).

import { join, relative } from "node:path";
import { browserProfileDir } from "./path-safety.ts";
import {
  validateAgentAction,
  extractFirstJsonObject,
  guardAgentAction,
  type PageSnapshot,
  type SnapshotElement,
} from "./browser-actions.ts";
import type { TraceEntry } from "./browser-record.ts";
import type { SkillSpec, SkillRunResult, SkillRunOpts } from "./connector-skills.ts";
import { PLAYWRIGHT_UNAVAILABLE_MESSAGE, isPlaywrightUnavailable } from "./playwright-resolve.ts";

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface DriverActResult {
  ok: boolean;
  targetName?: string;
  error?: string;
  downloads: number; // downloads captured DURING this action
  snapshot: PageSnapshot; // page state after the action
}

export interface DriverLike {
  open(req: { startUrl: string; profileDir?: string; statePath?: string; downloadsDir: string; headed: boolean; domainAllow?: string[] }): Promise<{ url: string }>;
  snapshot(): Promise<PageSnapshot>;
  act(cmd: { ref?: string; kind: string; url?: string; text?: string; option?: string; key?: string; to?: string; timeout_ms?: number }): Promise<DriverActResult>;
  waitUser(opts: { successUrlContains?: string; successSelector?: string; timeout_ms: number }): Promise<boolean>;
  close(): Promise<void>;
}

export type AskModel = (prompt: string) => Promise<string>;

export interface AgentEvent {
  phase: "started" | "browser_open" | "step" | "nav" | "await_user" | "user_resumed" | "blocked" | "download" | "done" | "error";
  n?: number;
  action?: string;
  target?: string;
  thought?: string;
  url?: string;
  reason?: string;
  message?: string;
  ok?: boolean;
}

export interface SuccessCheck {
  type: "files_match" | "page_contains" | "url_matches";
  glob?: string;
  text?: string;
  contains?: string;
  min?: number;
}

export interface AgentGoal {
  objective: string;
  startUrl: string;
  profileDir?: string;
  statePath?: string;
  downloadsDir: string;
  domainAllow?: string[];
  successUrlContains?: string; // post-login marker, for the initial human gate
  successCheck?: SuccessCheck;
  maxTurns?: number;
  wallClockMs?: number;
  headed?: boolean;
  loginTimeoutMs?: number;
}

export interface AgentRunResult {
  ok: boolean;
  message: string;
  trace: TraceEntry[];
  summary?: string;
  turns: number;
  downloads: number;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a careful browser operator. You control a real web browser to accomplish ONE goal on a site the user is already logged into. You act READ-ONLY: you may navigate, read, select date ranges, and download statements/data. You must NEVER pay, send money, transfer, delete, change settings, or submit anything that moves money or changes the account.

Each turn you receive the current page as a structured list of elements. Each element has a stable ref like "e7". You reply with EXACTLY ONE JSON object and nothing else — no prose, no markdown fences. Schema:
  {"thought":"<one short line>","action":"navigate","url":"https://..."}
  {"action":"click","ref":"e7"}
  {"action":"fill","ref":"e7","text":"2026-01-01"}          // NEVER passwords/codes
  {"action":"select","ref":"e7","option":"Last 365 days"}
  {"action":"press_key","key":"Enter"}                       // Enter|Tab|Escape|ArrowDown|ArrowUp|PageDown
  {"action":"scroll","to":"bottom"}
  {"action":"wait_for","text":"Your statement is ready","timeout_ms":15000}
  {"action":"download","ref":"e7"}                            // click that triggers a file download
  {"action":"read","ref":"e7"}                               // return a region's text
  {"action":"request_screenshot"}                            // only if the text is ambiguous
  {"action":"ask_user","kind":"twofa","reason":"Enter your 2FA code in the browser, then I continue"}
  {"action":"done","summary":"Downloaded 3 statements"}      // only when the goal is achieved
  {"action":"fail","reason":"why it can't be done"}
Prefer the smallest number of steps. If a login/2FA wall appears, use ask_user — never type credentials yourself.`;

export function renderObservation(goal: string, snap: PageSnapshot, turn: number, note?: string): string {
  const lines: string[] = [];
  lines.push(`GOAL: ${goal}`);
  lines.push(`TURN: ${turn}`);
  lines.push(`URL: ${snap.url}`);
  if (snap.title) lines.push(`TITLE: ${snap.title}`);
  if (note) lines.push(`NOTE: ${note}`);
  lines.push("");
  lines.push("PAGE ELEMENTS (target these refs):");
  for (const el of snap.elements) {
    const bits = [`- ${el.ref} ${el.role}`];
    if (el.name) bits.push(`"${el.name}"`);
    if (el.value && !el.isPassword) bits.push(`= ${el.value}`);
    if (el.isPassword) bits.push("[password field]");
    lines.push(bits.join(" "));
  }
  lines.push("");
  lines.push("ARIA OUTLINE:");
  lines.push(snap.aria.slice(0, 4000));
  lines.push("");
  lines.push("Reply with ONE JSON action.");
  return lines.join("\n");
}

function elementByRef(snap: PageSnapshot, ref: string | undefined): SnapshotElement | undefined {
  if (!ref) return undefined;
  return snap.elements.find((e) => e.ref === ref);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runBrowserAgent(goal: AgentGoal, deps: { driver: DriverLike; askModel: AskModel; emit?: (e: AgentEvent) => void; now?: () => number }): Promise<AgentRunResult> {
  const emit = deps.emit ?? (() => {});
  const now = deps.now ?? Date.now;
  const maxTurns = goal.maxTurns ?? 25;
  const wallClock = goal.wallClockMs ?? 10 * 60_000;
  const trace: TraceEntry[] = [];
  let downloads = 0;
  const deadline = now() + wallClock;

  emit({ phase: "started" });
  let snap: PageSnapshot;
  try {
    const opened = await deps.driver.open({
      startUrl: goal.startUrl,
      profileDir: goal.profileDir,
      statePath: goal.statePath,
      downloadsDir: goal.downloadsDir,
      headed: goal.headed ?? true,
      domainAllow: goal.domainAllow,
    });
    emit({ phase: "browser_open", url: opened.url });
    snap = await deps.driver.snapshot();
  } catch (e) {
    // If the browser engine itself is missing (packaging miss in a release
    // build), the raw module-not-found dump is meaningless to the user. Show the
    // actionable message and degrade gracefully (fail() returns a normal result,
    // so the learn flow does not crash).
    if (isPlaywrightUnavailable(e)) return fail(PLAYWRIGHT_UNAVAILABLE_MESSAGE);
    return fail(`could not open browser: ${msg(e)}`);
  }

  // Stuck detector: if the observation hasn't changed across N non-wait turns,
  // nudge the model, then fail. Kills the classic infinite-click loop cheaply.
  let lastHash = "";
  let stuck = 0;
  let note: string | undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (now() > deadline) return fail("wall-clock budget exceeded", trace, downloads, turn - 1);

    let reply: string;
    try {
      reply = await deps.askModel(`${SYSTEM_PROMPT}\n\n${renderObservation(goal.objective, snap, turn, note)}`);
    } catch (e) {
      return fail(`model error: ${msg(e)}`, trace, downloads, turn - 1);
    }
    note = undefined;

    const parsed = extractFirstJsonObject(reply);
    const v = validateAgentAction(parsed);
    if (!v.ok || !v.action) {
      // One tolerant re-prompt happens implicitly next turn via the note.
      note = `Your last reply was not a single valid JSON action (${v.error}). Reply with exactly one JSON action object.`;
      emit({ phase: "error", message: v.error, n: turn });
      continue;
    }
    const action = v.action;
    emit({ phase: "step", n: turn, action: action.action, thought: action.thought, target: elementByRef(snap, action.ref)?.name });

    // Terminal actions.
    if (action.action === "done") {
      const ok = await checkSuccess(goal, downloads, snap);
      if (ok) {
        emit({ phase: "done", ok: true, message: action.summary });
        return { ok: true, message: action.summary || "goal achieved", trace, summary: action.summary, turns: turn, downloads };
      }
      note = `You said done but the success check did not pass (downloads=${downloads}). Continue working toward: ${goal.objective}`;
      continue;
    }
    if (action.action === "fail") return fail(action.reason || "agent gave up", trace, downloads, turn);

    // Human-in-the-loop: pause for 2FA/captcha/choice. No model spend while waiting.
    if (action.action === "ask_user") {
      emit({ phase: "await_user", n: turn, reason: action.kind, message: action.reason });
      const resumed = await deps.driver.waitUser({ successUrlContains: goal.successUrlContains, timeout_ms: goal.loginTimeoutMs ?? 180_000 });
      if (!resumed) return fail("user did not complete the required step in time", trace, downloads, turn);
      emit({ phase: "user_resumed" });
      snap = await deps.driver.snapshot();
      continue;
    }

    if (action.action === "request_screenshot") {
      note = "Screenshot fallback is not available; proceed using the structured elements.";
      continue;
    }
    if (action.action === "read") {
      const el = elementByRef(snap, action.ref);
      note = el ? `Text of ${action.ref}: ${el.name || "(no text)"}` : `No element ${action.ref}.`;
      continue;
    }

    // SENSITIVE EGRESS GUARD: an external website is a PUBLIC audience. Any
    // text the agent is about to type (or smuggle into a URL) is scanned in
    // code before it reaches the page; a hold blocks this single action and
    // tells the agent why, in categories only. docs/sensitive-egress-guard.md.
    const outbound = [action.text, action.action === "navigate" ? action.url : ""].filter(Boolean).join("\n");
    if (outbound) {
      const { evaluateEgress } = require("./egress-guard.ts") as typeof import("./egress-guard.ts");
      const egress = evaluateEgress("public", [outbound]);
      if (egress.verdict === "hold") {
        emit({ phase: "blocked", n: turn, reason: egress.reason });
        note = `That action was blocked: ${egress.reason}. Do NOT retype the sensitive value in any form. Proceed without it, or stop and tell the user what approval is needed.`;
        continue;
      }
    }

    // Guard executable actions in code, using the target element's name.
    const targetEl = elementByRef(snap, action.ref);
    const guard = guardAgentAction(action, targetEl?.name || "", targetEl?.isPassword);
    if (guard.block) {
      emit({ phase: "blocked", n: turn, reason: guard.why });
      note = `That action was blocked: ${guard.why}. Choose a different, read-only action.`;
      continue;
    }
    if (guard.needConfirm) {
      // Without an interactive confirm channel in the loop, refuse rather than
      // act on a consequential control. The user can do it manually.
      emit({ phase: "blocked", n: turn, reason: guard.why });
      note = `That control needs explicit user confirmation (${guard.why}) and cannot be auto-clicked. Find a read-only path instead.`;
      continue;
    }

    // Execute via the driver.
    let res: DriverActResult;
    try {
      res = await deps.driver.act({
        ref: action.ref,
        kind: action.action,
        url: action.url,
        text: action.text,
        option: action.option,
        key: action.key,
        to: action.to,
        timeout_ms: action.timeout_ms,
      });
    } catch (e) {
      note = `Action errored: ${msg(e)}. Try a different element.`;
      continue;
    }

    if (res.downloads > 0) {
      downloads += res.downloads;
      emit({ phase: "download", n: turn });
    }
    if (action.action === "navigate") emit({ phase: "nav", url: res.snapshot.url });

    if (!res.ok) {
      note = `Action failed: ${res.error || "unknown"}. Try a different element or approach.`;
    } else {
      // Record the executed step for the replay skill.
      trace.push({ action, target: targetEl, urlAfter: res.snapshot.url, downloads: res.downloads });
    }

    // Advance observation + stuck detection.
    snap = res.snapshot;
    const hash = snapshotHash(snap);
    if (action.action !== "wait_for" && hash === lastHash) {
      stuck++;
      if (stuck >= 3) return fail("no progress after repeated actions", trace, downloads, turn);
      note = (note ? note + " " : "") + "The page did not change; try a different element.";
    } else {
      stuck = 0;
    }
    lastHash = hash;
  }
  return fail("max turns exceeded", trace, downloads, maxTurns);

  function fail(message: string, tr: TraceEntry[] = trace, dl = downloads, turns = 0): AgentRunResult {
    emit({ phase: "error", message });
    return { ok: false, message, trace: tr, turns, downloads: dl };
  }
}

async function checkSuccess(goal: AgentGoal, downloads: number, snap: PageSnapshot): Promise<boolean> {
  const c = goal.successCheck;
  if (!c) return downloads > 0; // default: produced at least one artifact
  if (c.type === "files_match") return downloads >= (c.min ?? 1);
  if (c.type === "url_matches") return !!c.contains && snap.url.includes(c.contains);
  if (c.type === "page_contains") return !!c.text && (snap.aria.includes(c.text) || snap.elements.some((e) => e.name.includes(c.text!)));
  return downloads > 0;
}

function snapshotHash(snap: PageSnapshot): string {
  return `${snap.url}|${snap.elements.length}|${snap.elements.map((e) => e.ref + e.name).join(",").slice(0, 400)}`;
}

function msg(e: unknown): string {
  return String((e as Error)?.message || e).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Production wiring: skill → agent loop → recorded replay skill
// ---------------------------------------------------------------------------

// Build an AskModel backed by the user's installed model CLI (same channel as
// the llm runner). Each call is a one-shot bare turn returning ≤4KB of text.
export async function makeModelAsker(opts: { cwd: string; panelist?: string; signal?: AbortSignal }): Promise<AskModel> {
  const { detectClis, runChatTurn } = await import("./cli-bridge.ts");
  const clis = await detectClis();
  if (clis.length === 0) throw new Error("no model CLI detected (install claude/codex/gemini/ollama)");
  const cli = clis.find((c) => c.kind === (opts.panelist ?? "claude")) ?? clis[0]!;
  return (prompt: string) =>
    runChatTurn({ prompt, cwd: opts.cwd, cli, model: "", isFirst: true, bare: true, signal: opts.signal, maxOutputChars: 4000 });
}

// The `runner: browser-agent` entry. Drives the agent loop headed, then records
// the successful run as a deterministic `runner: browser` replay skill.
// Frontmatter keys read from skill.extra:
//   start_url / login_url   — where to begin
//   goal                    — natural-language objective
//   record_as               — id of the replay skill to (over)write (default <id>-replay)
//   domain_allow            — [hostnames] the browser may visit
//   success_url_contains    — post-login marker for the human gate
//   success_glob            — files_match glob for the success check
//   max_turns               — loop bound (default 25)
//   session                 — "profile" | "state" (default profile)
export async function runSkillBrowserAgent(
  skill: SkillSpec,
  _inputs: Record<string, unknown>,
  opts: SkillRunOpts = {},
): Promise<SkillRunResult> {
  const emitEvent = opts.onProgress;
  const t0 = Date.now();
  const ex = skill.extra ?? {};
  const startUrl = str(ex.start_url) || str(ex.login_url);
  const goal = str(ex.goal) || skill.description.split("\n").find((l) => l.trim()) || `run ${skill.id}`;
  if (!startUrl || !/^https?:\/\//.test(startUrl)) {
    return { ok: false, message: `browser-agent skill "${skill.id}" needs an http(s) start_url`, outputsWritten: [], durationMs: Date.now() - t0 };
  }
  const recordAs = str(ex.record_as) || `${skill.id.replace(/-learn$/, "")}-replay`;
  const domainAllow = Array.isArray(ex.domain_allow) ? (ex.domain_allow as unknown[]).filter((x): x is string => typeof x === "string") : startHost(startUrl);
  const session = ex.session === "state" ? "state" : "profile";
  const downloadsDir = join(skill.connectorDir, "data", "imports");
  // Machine-local profile (outside the vault), migrating any legacy in-vault one.
  const profileDir = browserProfileDir(skill.connectorId, join(skill.connectorDir, "auth", "profile"));
  const statePath = join(skill.connectorDir, "auth", "state.json");

  const { BrowserDriverHost, makeHostDriver } = await import("./browser-driver.ts");
  const host = new BrowserDriverHost();
  const downloads: string[] = [];
  const driver = makeHostDriver(host, (e) => {
    if (e.event === "download") downloads.push(relative(skill.connectorDir, e.path));
  });

  let askModel: AskModel;
  try {
    askModel = await makeModelAsker({ cwd: skill.connectorDir, panelist: skill.panelist, signal: opts.signal });
  } catch (e) {
    await driver.close();
    return { ok: false, message: msg(e), outputsWritten: [], durationMs: Date.now() - t0 };
  }

  let result: AgentRunResult;
  try {
    result = await runBrowserAgent(
      {
        objective: goal,
        startUrl,
        // Always a persistent Chrome profile so the Google sign-in persists.
        profileDir,
        downloadsDir,
        domainAllow,
        successUrlContains: str(ex.success_url_contains) || undefined,
        successCheck: str(ex.success_glob) ? { type: "files_match", glob: str(ex.success_glob), min: 1 } : undefined,
        maxTurns: typeof ex.max_turns === "number" ? ex.max_turns : 25,
        headed: true,
      },
      { driver, askModel, emit: emitEvent ? (e) => emitEvent(e as unknown as Record<string, unknown>) : undefined },
    );
  } finally {
    await driver.close();
  }

  if (!result.ok) {
    return { ok: false, message: result.message, outputsWritten: [], durationMs: Date.now() - t0, artifacts: downloads };
  }

  // Record the deterministic replay skill from the successful trace.
  const { writeReplaySkill } = await import("./browser-record.ts");
  const rec = writeReplaySkill(skill.connectorDir, {
    skillId: recordAs,
    connector: skill.connectorId,
    goal,
    startUrl,
    session,
    domainAllow,
    successGlob: str(ex.success_glob) || "data/imports/**/*",
  }, result.trace);

  return {
    ok: true,
    message: `learned ${result.trace.length} steps, ${result.downloads} download(s); ${rec.message}`,
    summary: result.summary || `Recorded ${recordAs} from ${skill.connectorId}`,
    outputsWritten: rec.path ? [relative(skill.connectorDir, rec.path)] : [],
    durationMs: Date.now() - t0,
    artifacts: downloads,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function startHost(url: string): string[] {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return [h];
  } catch {
    return [];
  }
}
