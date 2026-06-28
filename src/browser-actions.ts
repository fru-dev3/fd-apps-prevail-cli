// browser-actions — the pure, Playwright-free core of the agentic browser runner.
//
// Two related action vocabularies live here:
//
//   AgentAction  — what the model emits, ONE per turn, during a learn run. It
//                  targets an ephemeral element ref ("e12") from the latest
//                  page snapshot. The model never sees or writes raw selectors.
//   ReplayStep   — the DETERMINISTIC step recorded from a successful learn run.
//                  It targets a stable Locator (role+name first), carries an
//                  `expect` success marker, and replays with zero model calls.
//
// Everything here is synchronous and dependency-light so it is unit-testable
// without launching a browser. Validation, the read-only guard, secret
// redaction, and locator-robustness ranking all live here — the security
// properties of the runner are enforced in this module, in code, never in a
// prompt. The driver (Playwright) and the agent loop import these.

import { classifyAction, isConsequential } from "./action-policy.ts";
import { redact } from "./privacy.ts";

// ---------------------------------------------------------------------------
// Observation (what the driver emits → what the model consumes)
// ---------------------------------------------------------------------------

export interface SnapshotElement {
  ref: string; // "e12" — single-turn-scoped handle the model targets
  role: string; // ARIA role or tag fallback
  name: string; // accessible name (trimmed/truncated)
  value?: string; // current value, ALREADY redacted/masked by the driver
  isPassword?: boolean;
  href?: string;
  testid?: string; // data-testid, for a robust replay fallback locator
}

export interface PageSnapshot {
  url: string;
  title: string;
  aria: string; // ariaSnapshot() YAML, redacted
  elements: SnapshotElement[]; // interactive elements with stable refs
  note?: string;
}

// ---------------------------------------------------------------------------
// Agent action space (live, ref-targeted, one per model turn)
// ---------------------------------------------------------------------------

export type AgentActionKind =
  | "navigate"
  | "click"
  | "fill"
  | "select"
  | "press_key"
  | "scroll"
  | "wait_for"
  | "download"
  | "read"
  | "request_screenshot"
  | "ask_user"
  | "done"
  | "fail";

export interface AgentAction {
  thought?: string;
  action: AgentActionKind;
  ref?: string; // for click/fill/select/scroll/download/read
  url?: string; // navigate
  text?: string; // fill value / wait_for text
  option?: string; // select
  key?: AllowedKey; // press_key
  dir?: "up" | "down"; // scroll
  to?: "top" | "bottom"; // scroll
  expect?: string; // download glob hint
  timeout_ms?: number;
  reason?: string; // ask_user / fail
  kind?: "twofa" | "captcha" | "choice" | "confirm"; // ask_user
  summary?: string; // done
}

export type AllowedKey = "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp" | "PageDown";
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "PageDown"]);

const REF_RE = /^e[0-9]+$/;
const MAX_FILL_LEN = 2000;
const MAX_THOUGHT_LEN = 280;

// Actions that target an element ref (must carry a valid ref).
const REF_ACTIONS: ReadonlySet<AgentActionKind> = new Set([
  "click",
  "fill",
  "select",
  "scroll",
  "download",
  "read",
]);

export interface ParseResult {
  ok: boolean;
  action?: AgentAction;
  error?: string;
}

// Tolerant extraction of the single JSON action object the model is asked to
// emit. Noisier CLIs (codex/gemini/ollama) wrap the object in prose or fences,
// so we pull the first balanced {...} block rather than JSON.parse the whole
// reply. Returns the raw object (unvalidated) or null.
export function extractFirstJsonObject(reply: string): unknown | null {
  const s = reply ?? "";
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          start = -1; // keep scanning for the next candidate
        }
      }
    }
  }
  return null;
}

// Strict validation of a model-proposed action. Anything malformed, off-schema,
// or unsafe (non-http navigate, over-long value, unknown key, missing ref) is
// rejected so the loop can re-prompt rather than execute garbage.
export function validateAgentAction(obj: unknown): ParseResult {
  if (!obj || typeof obj !== "object") return { ok: false, error: "not an object" };
  const o = obj as Record<string, unknown>;
  const kind = o.action;
  if (typeof kind !== "string" || !isAgentActionKind(kind)) {
    return { ok: false, error: `unknown action: ${String(kind)}` };
  }
  const a: AgentAction = { action: kind };
  if (typeof o.thought === "string") a.thought = o.thought.slice(0, MAX_THOUGHT_LEN);

  if (REF_ACTIONS.has(kind)) {
    if (typeof o.ref !== "string" || !REF_RE.test(o.ref)) {
      return { ok: false, error: `${kind} requires a ref like "e3"` };
    }
    a.ref = o.ref;
  }
  switch (kind) {
    case "navigate": {
      if (typeof o.url !== "string" || !/^https?:\/\//i.test(o.url)) {
        return { ok: false, error: "navigate requires an http(s) url" };
      }
      a.url = o.url;
      break;
    }
    case "fill": {
      if (typeof o.text !== "string") return { ok: false, error: "fill requires text" };
      if (o.text.length > MAX_FILL_LEN) return { ok: false, error: "fill text too long" };
      a.text = o.text;
      break;
    }
    case "select": {
      if (typeof o.option !== "string") return { ok: false, error: "select requires an option" };
      a.option = o.option;
      break;
    }
    case "press_key": {
      if (typeof o.key !== "string" || !ALLOWED_KEYS.has(o.key)) {
        return { ok: false, error: "press_key requires an allowed key" };
      }
      a.key = o.key as AllowedKey;
      break;
    }
    case "scroll": {
      if (o.dir === "up" || o.dir === "down") a.dir = o.dir;
      if (o.to === "top" || o.to === "bottom") a.to = o.to;
      break;
    }
    case "wait_for": {
      if (typeof o.text === "string") a.text = o.text.slice(0, MAX_FILL_LEN);
      if (typeof o.timeout_ms === "number") a.timeout_ms = clampTimeout(o.timeout_ms);
      break;
    }
    case "download": {
      if (typeof o.expect === "string") a.expect = o.expect.slice(0, 120);
      break;
    }
    case "ask_user": {
      a.kind = o.kind === "twofa" || o.kind === "captcha" || o.kind === "choice" || o.kind === "confirm" ? o.kind : "choice";
      if (typeof o.reason === "string") a.reason = o.reason.slice(0, 500);
      break;
    }
    case "fail": {
      if (typeof o.reason === "string") a.reason = o.reason.slice(0, 500);
      break;
    }
    case "done": {
      if (typeof o.summary === "string") a.summary = o.summary.slice(0, 500);
      break;
    }
  }
  return { ok: true, action: a };
}

function isAgentActionKind(s: string): s is AgentActionKind {
  return (
    s === "navigate" ||
    s === "click" ||
    s === "fill" ||
    s === "select" ||
    s === "press_key" ||
    s === "scroll" ||
    s === "wait_for" ||
    s === "download" ||
    s === "read" ||
    s === "request_screenshot" ||
    s === "ask_user" ||
    s === "done" ||
    s === "fail"
  );
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return 15000;
  return Math.max(500, Math.min(60000, Math.round(ms)));
}

// ---------------------------------------------------------------------------
// Read-only guard — enforced in code at the action boundary, never the prompt.
// ---------------------------------------------------------------------------

// Hard denylist of element accessible-names that must NEVER be auto-clicked,
// regardless of what the model intends. Money movement, account destruction,
// and credential/settings changes are out of scope for read-only sync.
const DENY_NAME_RE =
  /\b(pay|send money|transfer|wire|confirm payment|place order|buy now|checkout|withdraw|delete|close account|deactivate|change (?:password|email|settings)|add (?:card|bank|payee))\b/i;

// Field name/placeholder shapes that indicate a credential entry. The agent is
// NEVER allowed to type into these — login/2FA is the human's job (ask_user).
const SECRET_FIELD_RE = /\b(password|passcode|otp|one[- ]?time|2fa|cvv|cvc|ssn|social security|pin|secret|security code)\b/i;

export interface GuardVerdict {
  block: boolean;
  needConfirm: boolean;
  why?: string;
}

// Decide whether a validated action may execute, given the accessible name of
// its target element (resolved by the driver from the ref). `targetName` is the
// element's a11y name for ref actions, or "" for refless actions.
export function guardAgentAction(action: AgentAction, targetName: string, targetIsPassword = false): GuardVerdict {
  // Credential fields: refuse outright. Creds only ever enter via human ask_user.
  if (action.action === "fill") {
    if (targetIsPassword || SECRET_FIELD_RE.test(targetName) || SECRET_FIELD_RE.test(action.text ?? "")) {
      return { block: true, needConfirm: false, why: "refusing to type into a credential field — that is the user's job (ask_user)" };
    }
  }
  // Consequential clicks/keys: block, escalate to a human confirm.
  if (action.action === "click" || action.action === "press_key") {
    if (DENY_NAME_RE.test(targetName)) {
      return { block: true, needConfirm: true, why: `blocked consequential control: "${targetName.slice(0, 60)}"` };
    }
    const cls = classifyAction(targetName);
    if (isConsequential(cls)) {
      return { block: false, needConfirm: true, why: `"${targetName.slice(0, 60)}" looks ${cls}; needs confirmation` };
    }
  }
  return { block: false, needConfirm: false };
}

// ---------------------------------------------------------------------------
// Secret redaction (belt-and-suspenders on top of privacy.redact)
// ---------------------------------------------------------------------------

// Shapes that should never reach the model or be written to a recorded skill /
// transcript, even when privacy.redact misses them in a UI-fragment context.
const SECRET_VALUE_RES: RegExp[] = [
  /\b\d{12,19}\b/g, // long card/account numbers
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{6}\b/g, // 6-digit OTP (greedy but safe to mask)
];

export function isSecretText(s: string): boolean {
  if (!s) return false;
  return SECRET_VALUE_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}

// Redact a full page snapshot (or transcript chunk) before it reaches the model
// or disk. Runs the shared vault redactor first, then masks numeric secret
// shapes that are common on account pages.
export function redactSnapshot(text: string): string {
  let out = redact(text ?? "");
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, (m) => "•".repeat(Math.min(m.length, 6)));
  }
  return out;
}

// Sanitize a value the agent typed before it is recorded into a replay step. A
// secret-shaped literal is replaced with a placeholder the user can wire to an
// input/env at replay time; everything else is passed through (it's a date,
// a search term, an account label the user chose).
export function redactActionValue(value: string): string {
  if (isSecretText(value)) return "${input.redacted}";
  return value;
}

// ---------------------------------------------------------------------------
// Replay steps (deterministic, locator-targeted, recorded from a learn run)
// ---------------------------------------------------------------------------

export interface Locator {
  role?: string; // ARIA role — primary, paired with name
  name?: string; // accessible name
  label?: string; // form label / placeholder
  text?: string; // visible text (links/buttons)
  testid?: string; // data-testid / stable data-* attr
  css?: string; // scoped CSS — last resort
  brittle?: boolean; // true when only positional/xpath was available
}

export type ReplayExpect =
  | { url_matches: string }
  | { text: string }
  | { gone: string } // selector/text that should disappear
  | { download: true }
  | { glob: string }
  | { min_downloads: number };

export type ReplayStepKind =
  | "navigate"
  | "click"
  | "fill"
  | "select"
  | "press"
  | "scroll"
  | "wait_for"
  | "download"
  | "download_all_links";

export interface ReplayStep {
  action: ReplayStepKind;
  url?: string;
  locator?: Locator;
  fallback?: Locator;
  value?: string; // fill (templated; never a raw secret)
  option?: string; // select
  key?: AllowedKey; // press
  selector?: string; // download_all_links anchor selector
  max?: number; // download_all_links cap
  saveAs?: string; // download target (relative to data/)
  to?: "top" | "bottom"; // scroll
  timeout_sec?: number;
  expect?: ReplayExpect;
}

// An element fingerprint captured by the driver at record time, from which we
// derive the most robust Locator. Ranking (highest → lowest): role+name →
// label/placeholder → visible text → data-testid → scoped css. A purely
// positional capture is flagged `brittle` so replay treats it as last-resort.
export interface ElementFingerprint {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testid?: string;
  css?: string;
  positionalOnly?: boolean;
}

export function buildLocator(fp: ElementFingerprint): Locator {
  const loc: Locator = {};
  if (fp.role && fp.name) {
    loc.role = fp.role;
    loc.name = clip(fp.name);
  } else if (fp.label) {
    loc.label = clip(fp.label);
  } else if (fp.text) {
    loc.text = clip(fp.text);
  } else if (fp.testid) {
    loc.testid = fp.testid;
  } else if (fp.css) {
    loc.css = fp.css;
    loc.brittle = true;
  }
  // Always record a secondary fallback if a distinct one is available.
  if (!loc.testid && fp.testid && (loc.role || loc.label || loc.text)) {
    // testid is a strong fallback — keep it on the step's `fallback`, not here.
  }
  if (fp.positionalOnly) loc.brittle = true;
  return loc;
}

// Best available fallback locator distinct from the primary (used by the
// recorder to populate ReplayStep.fallback).
export function buildFallbackLocator(fp: ElementFingerprint, primary: Locator): Locator | undefined {
  if (fp.testid && !primary.testid) return { testid: fp.testid };
  if (fp.css && !primary.css) return { css: fp.css, brittle: true };
  return undefined;
}

function clip(s: string): string {
  return s.trim().slice(0, 120);
}

export interface StepValidation {
  ok: boolean;
  errors: string[];
}

// Validate a recorded steps[] array before replay or before writing a skill.
export function validateReplaySteps(steps: unknown): StepValidation {
  const errors: string[] = [];
  if (!Array.isArray(steps)) return { ok: false, errors: ["steps is not an array"] };
  steps.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      errors.push(`step ${i}: not an object`);
      return;
    }
    const s = raw as Record<string, unknown>;
    const action = s.action;
    if (typeof action !== "string" || !isReplayStepKind(action)) {
      errors.push(`step ${i}: unknown action "${String(action)}"`);
      return;
    }
    if (action === "navigate" && (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url))) {
      errors.push(`step ${i}: navigate needs an http(s) url`);
    }
    if ((action === "click" || action === "fill" || action === "select") && !s.locator) {
      errors.push(`step ${i}: ${action} needs a locator`);
    }
    if (action === "fill" && typeof s.value === "string" && isSecretText(s.value)) {
      errors.push(`step ${i}: fill value looks like a secret; must be a placeholder`);
    }
  });
  return { ok: errors.length === 0, errors };
}

function isReplayStepKind(s: string): s is ReplayStepKind {
  return (
    s === "navigate" ||
    s === "click" ||
    s === "fill" ||
    s === "select" ||
    s === "press" ||
    s === "scroll" ||
    s === "wait_for" ||
    s === "download" ||
    s === "download_all_links"
  );
}
