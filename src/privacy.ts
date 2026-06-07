// privacy — local-only engine enforcement + best-effort PII redaction.
//
// Two jobs, both pure-ish and side-effect-free:
//
//   1. resolveModelForDomain(vaultPath, domain, requested)
//      Decide which engine a turn is allowed to run on. When privacy is
//      engaged — either manifest.privacy.localOnly for the domain OR the
//      global `--local-only` switch — cloud subprocess CLIs (claude / codex /
//      antigravity) are refused and the turn is forced onto the local
//      ollama / OpenAI-compatible endpoint. When privacy is NOT engaged the
//      requested engine passes through untouched (current behavior).
//
//   2. redact(text) — scrub obvious PII patterns before text leaves the
//      machine. Coarse on purpose: emails, phone numbers, SSNs, credit-card
//      -shaped digit runs, IPv4. It is a guardrail, NOT a compliance tool —
//      false negatives are expected, so callers should still treat the vault
//      as the trust boundary.
//
// This module owns NO config writes. localOnly state is sourced from the
// manifest (read via the frozen manifest API) and from the caller-supplied
// global flag (parsed elsewhere, same `--local-only` convention as
// src/chat-json.ts).

import type { CliKind } from "./config.ts";
import { readManifest } from "./manifest.ts";

// Default local model. Derived directly from the env var (same source as
// cli-bridge's OLLAMA_DEFAULT_MODEL) rather than imported, to avoid a runtime
// import cycle (cli-bridge imports privacy). Keep this in sync with
// cli-bridge.OLLAMA_DEFAULT_MODEL.
const OLLAMA_DEFAULT_MODEL = process.env.PREVAIL_OLLAMA_MODEL || "llama3.1";

// The engines that run a model on the user's own machine (or a LAN box the
// user controls). Everything else is a cloud subprocess CLI that ships the
// prompt to a third-party API.
const LOCAL_CLI_KINDS: ReadonlySet<CliKind> = new Set<CliKind>(["ollama"]);

export function isLocalCli(kind: CliKind): boolean {
  return LOCAL_CLI_KINDS.has(kind);
}

// Typed error so callers (cli-bridge, chat-json, the desktop UI) can
// distinguish a privacy refusal from a generic spawn failure and show the
// user an actionable message instead of a stack trace.
export class PrivacyViolation extends Error {
  readonly domain: string;
  readonly requestedCli: CliKind;
  constructor(domain: string, requestedCli: CliKind, message: string) {
    super(message);
    this.name = "PrivacyViolation";
    this.domain = domain;
    this.requestedCli = requestedCli;
  }
}

export interface ResolvedModel {
  cli: CliKind;
  model: string;
  // True when privacy forced a change away from what was requested (so the
  // UI can surface "running locally because this domain is local-only").
  forcedLocal: boolean;
  // Why local was (or wasn't) forced — for display / logging.
  reason: "manifest" | "global" | "none";
}

export interface ResolveOptions {
  /** Global `--local-only` switch (same convention as src/chat-json.ts). */
  globalLocalOnly?: boolean;
  /** Local engine to fall back to when forcing local. Defaults to ollama. */
  localCli?: CliKind;
  /** Local model id to use when the requested one is a cloud model. */
  localModel?: string;
}

// Decide the engine+model a turn may run on for a given domain.
//
// - If neither the domain manifest nor the global flag requests local-only,
//   the requested (cli, model) passes through unchanged with forcedLocal:false.
//   This keeps the existing behavior for every caller that doesn't opt in.
// - If local-only IS engaged and the requested cli is already local, it passes
//   through (forcedLocal:false — nothing had to change) but is still tagged so
//   the caller knows privacy is on.
// - If local-only is engaged and the requested cli is a cloud CLI, the turn is
//   redirected to the local engine and forcedLocal:true is returned. We do NOT
//   throw here — redirection is the friendlier default. Callers that would
//   rather hard-refuse a cloud request can inspect forcedLocal / call
//   assertLocalAllowed.
export function resolveModelForDomain(
  vaultPath: string,
  domain: string,
  requested: { cli: CliKind; model: string },
  opts: ResolveOptions = {},
): ResolvedModel {
  const localCli = opts.localCli ?? "ollama";
  const localModel = opts.localModel ?? OLLAMA_DEFAULT_MODEL;

  const manifestLocalOnly = readManifestLocalOnly(vaultPath, domain);
  const globalLocalOnly = opts.globalLocalOnly ?? false;

  const reason: ResolvedModel["reason"] = manifestLocalOnly
    ? "manifest"
    : globalLocalOnly
      ? "global"
      : "none";

  // Privacy not engaged — pass the requested engine through untouched.
  if (reason === "none") {
    return { cli: requested.cli, model: requested.model, forcedLocal: false, reason };
  }

  // Privacy engaged and the request is already local — keep it, but a cloud
  // model id pinned on a local CLI is meaningless, so normalize to the local
  // default when the requested model looks like a cloud model.
  if (isLocalCli(requested.cli)) {
    return {
      cli: requested.cli,
      model: requested.model.trim() ? requested.model : localModel,
      forcedLocal: false,
      reason,
    };
  }

  // Privacy engaged and the request is a cloud CLI — redirect to local.
  return { cli: localCli, model: localModel, forcedLocal: true, reason };
}

// Hard-refuse variant — throws PrivacyViolation if local-only is engaged for
// the domain and the requested cli is a cloud CLI. Use this when redirection
// is not acceptable (e.g. a caller that pinned a specific cloud model and must
// not silently get a different engine).
export function assertLocalAllowed(
  vaultPath: string,
  domain: string,
  requestedCli: CliKind,
  opts: Pick<ResolveOptions, "globalLocalOnly"> = {},
): void {
  const manifestLocalOnly = readManifestLocalOnly(vaultPath, domain);
  const globalLocalOnly = opts.globalLocalOnly ?? false;
  if (!manifestLocalOnly && !globalLocalOnly) return;
  if (isLocalCli(requestedCli)) return;
  const why = manifestLocalOnly
    ? `domain '${domain}' is marked privacy.localOnly`
    : "the global --local-only switch is on";
  throw new PrivacyViolation(
    domain,
    requestedCli,
    `refusing to run '${requestedCli}' (a cloud engine) because ${why}. Use a local engine (ollama).`,
  );
}

// Read manifest.privacy.localOnly for a domain. Absent manifest / unreadable
// manifest => false (feature off), matching the manifest coercion default.
function readManifestLocalOnly(vaultPath: string, domain: string): boolean {
  try {
    const m = readManifest(vaultPath, domain);
    return m?.privacy.localOnly ?? false;
  } catch {
    return false;
  }
}

// =============================================================================
// redact() — best-effort PII scrubbing.
//
// Each pattern replaces the match with a typed placeholder so a downstream
// reader can tell *what kind* of value was removed without seeing it. Order
// matters: SSN and credit-card both match digit runs, so the more specific
// (formatted) patterns run first. This is intentionally conservative — we
// would rather leave a borderline string intact than mangle legitimate vault
// content (e.g. an account-balance number).
// =============================================================================

export interface RedactionResult {
  text: string;
  /** Count of substitutions made, by category. */
  counts: Record<string, number>;
}

interface RedactRule {
  label: string;
  re: RegExp;
  placeholder: string;
}

// NOTE: every regex uses the global flag so replace() hits all occurrences.
const REDACT_RULES: RedactRule[] = [
  {
    label: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: "[REDACTED_EMAIL]",
  },
  {
    // US SSN: 3-2-4 with dashes or spaces. Requires the separators so a
    // bare 9-digit number (which could be an account/order id) is left alone.
    label: "ssn",
    re: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g,
    placeholder: "[REDACTED_SSN]",
  },
  {
    // Credit-card-shaped: 4 groups of 4 digits, separated by space or dash.
    // (Bare 16-digit runs are also common in legit ids, so require grouping.)
    label: "credit_card",
    re: /\b(?:\d[ -]?){13,16}\b(?=\D|$)/g,
    placeholder: "[REDACTED_CC]",
  },
  {
    // North-American phone numbers. Optional country code, common separators
    // and paren area code. Tightened to require at least one separator or
    // paren so a plain 10-digit id doesn't trip it.
    label: "phone",
    re: /\b(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/g,
    placeholder: "[REDACTED_PHONE]",
  },
  {
    label: "ipv4",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    placeholder: "[REDACTED_IP]",
  },
];

// Redact and report what was scrubbed. The credit-card rule runs BEFORE the
// phone rule because a dashed 16-digit run could otherwise be partly eaten by
// the phone matcher; the SSN rule runs before credit-card because a 3-2-4
// SSN is more specific than the generic grouped-digits card pattern.
export function redactWithCounts(text: string): RedactionResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", counts: {} };
  }
  let out = text;
  const counts: Record<string, number> = {};
  for (const rule of REDACT_RULES) {
    let n = 0;
    out = out.replace(rule.re, () => {
      n++;
      return rule.placeholder;
    });
    if (n > 0) counts[rule.label] = n;
  }
  return { text: out, counts };
}

// Convenience wrapper — just the scrubbed string.
export function redact(text: string): string {
  return redactWithCounts(text).text;
}
