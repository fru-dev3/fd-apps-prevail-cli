// The Sensitive Egress Guard: keeps the user's sensitive information (PII,
// money figures, health, legal status, salary, strategies, verbatim quotes)
// from leaving the system in ANY outbound communication unless the user
// explicitly approves that exact release. See docs/sensitive-egress-guard.md.
//
// Design rules this file must never break:
//   - DETERMINISTIC. Regex + checksum + lexicon only. No model calls: a model
//     can fail open, fail closed, or be prompt-injected; a pure function can't.
//   - Bias toward HOLDING. A false positive costs one approval tap; a false
//     negative leaks the user's life.
//   - AUDIENCE decides, not channel. Self-directed content (own inbox, own
//     Telegram chat, a Gmail draft) passes; external/public/unknown is scanned.
// Enforced at execution choke points (runGwsApproved, browser-agent act
// dispatch), never by prompt.

import { readConfig, writeConfig } from "./config.ts";

export type EgressGuardMode = "on" | "off";

export const DEFAULT_EGRESS_GUARD: EgressGuardMode = "on";

export function readEgressGuard(): EgressGuardMode {
  try {
    const raw = (readConfig() as { egressGuard?: string } | null)?.egressGuard;
    if (raw === "on" || raw === "off") return raw;
  } catch { /* default */ }
  return DEFAULT_EGRESS_GUARD;
}

export function writeEgressGuard(mode: EgressGuardMode): void {
  const cfg = readConfig() ?? ({} as NonNullable<ReturnType<typeof readConfig>>);
  (cfg as { egressGuard?: string }).egressGuard = mode;
  writeConfig(cfg);
}

export type EgressCategory =
  | "ssn" | "ein" | "card" | "bank" | "money" | "phone" | "dob" | "secret"
  | "salary" | "wealth" | "health" | "legal" | "identity" | "strategy" | "quote"
  | "document-share";

export interface EgressFinding {
  category: EgressCategory;
  /** Human label for approval UIs ("salary details", "a Social Security number"). */
  label: string;
  /** Masked preview of the match (never the full value), or the trigger word. */
  preview: string;
  /** Span in the scanned text for pattern findings; lexicon hits have no span. */
  start?: number;
  end?: number;
}

const mask = (s: string) => (s.length <= 4 ? "****" : `${s.slice(0, 2)}${"*".repeat(Math.max(3, s.length - 4))}${s.slice(-2)}`);

function luhnOk(digits: string): boolean {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function abaOk(digits: string): boolean {
  if (digits.length !== 9) return false;
  const d = [...digits].map((c) => c.charCodeAt(0) - 48);
  return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0;
}

interface PatternRule {
  category: EgressCategory;
  label: string;
  re: RegExp;
  /** Extra validation on the raw match (checksums, context). */
  ok?: (match: string, text: string, index: number) => boolean;
}

// Pattern detectors: precise spans, scrubbable.
const PATTERNS: PatternRule[] = [
  { category: "ssn", label: "a Social Security number", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    category: "ein", label: "an EIN", re: /\b\d{2}-\d{7}\b/g,
    // 2-7 shape collides with nothing common, but require it not be part of a
    // longer dashed run (dates like 2026-07-04 are 4-2-2 and don't match).
    ok: (m, text, i) => !/[\d-]/.test(text[i - 1] ?? "") && !/[\d-]/.test(text[i + m.length] ?? ""),
  },
  {
    category: "card", label: "a card number", re: /\b(?:\d[ -]?){13,19}\b/g,
    ok: (m) => { const d = m.replace(/[^\d]/g, ""); return d.length >= 13 && d.length <= 19 && luhnOk(d); },
  },
  {
    category: "bank", label: "a bank routing number", re: /\b\d{9}\b/g,
    ok: (m, text, i) => abaOk(m) && /rout|aba|wire|bank|account/i.test(text.slice(Math.max(0, i - 60), i + 60)),
  },
  { category: "bank", label: "an IBAN", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  {
    category: "money", label: "a money amount",
    re: /(?:[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB](?![a-z]))?)|(?:\b\d[\d,.]*\s?(?:USD|EUR|GBP|dollars)\b)/g,
  },
  {
    // Standalone 6+ digit figures: "specific numbers cannot go out unless I
    // approve". 6+ avoids ZIP codes and years; date/time shapes are excluded.
    category: "money", label: "a specific figure", re: /\b\d{6,}\b/g,
    ok: (m, text, i) => !/[\d:./-]/.test(text[i - 1] ?? "") && !/[\d:./-]/.test(text[i + m.length] ?? ""),
  },
  { category: "phone", label: "a phone number", re: /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
  {
    category: "dob", label: "a date of birth",
    re: /\b(?:born|birthday|birth date|dob|d\.o\.b\.)\b[^.\n]{0,40}?\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/gi,
  },
  {
    category: "secret", label: "a credential or key",
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    // Verbatim quoted spans of 40+ chars: "specific quotes cannot be done
    // unless I approve".
    category: "quote", label: "a verbatim quote",
    re: /["“]([^"“”]{40,})["”]/g,
  },
];

// Lexicon detectors: the presence of the topic holds the message for approval.
// No precise span to scrub, so a lexicon hit can only be released by the user.
const LEXICONS: Array<{ category: EgressCategory; label: string; re: RegExp }> = [
  { category: "salary", label: "salary or compensation details", re: /\b(salar(?:y|ies)|compensation|comp package|signing bonus|bonus target|equity grant|RSUs?|stock options?|offer letter|pay band|base pay)\b/i },
  { category: "wealth", label: "wealth or account details", re: /\b(net worth|portfolio|brokerage|account balance|holdings|assets under|retirement account|401\(?k\)?|IRA balance)\b/i },
  { category: "health", label: "health information", re: /\b(diagnos\w+|prescri\w+|medication|therap(?:y|ist)|surgery|mental health|blood test|lab result|chronic|treatment plan|symptom)\b/i },
  { category: "legal", label: "legal or immigration status", re: /\b(immigration|visa status|green card|citizenship|lawsuit|litigation|settlement agreement|felony|criminal record|attorney[- ]client|legal status)\b/i },
  { category: "identity", label: "government identifiers", re: /\b(social security|SSN|EIN|passport number|driver'?s license|tax id)\b/i },
  { category: "strategy", label: "internal plans or strategy", re: /\b(confidential|internal only|do not share|our strategy|strategic plan|roadmap|acquisition target|term sheet|negotiation position)\b/i },
];

/** Scan one text for sensitive content. Deterministic; safe on huge inputs. */
export function scanSensitive(text: string): EgressFinding[] {
  const out: EgressFinding[] = [];
  if (!text) return out;
  for (const rule of PATTERNS) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      if (rule.ok && !rule.ok(m[0], text, m.index)) continue;
      out.push({ category: rule.category, label: rule.label, preview: mask(m[0]), start: m.index, end: m.index + m[0].length });
      if (out.length > 200) return out; // bounded
    }
  }
  for (const lex of LEXICONS) {
    const m = lex.re.exec(text);
    if (m) out.push({ category: lex.category, label: lex.label, preview: m[0] });
  }
  return out;
}

/** The distinct categories in a finding set, for honest hold messages. */
export function findingCategories(findings: EgressFinding[]): string[] {
  return [...new Set(findings.map((f) => f.label))];
}

/** Replace pattern-detected spans with typed placeholders. Lexicon findings
 *  have no span and are NOT removed - callers must hold, not scrub, those. */
export function scrubText(text: string): { text: string; findings: EgressFinding[] } {
  const findings = scanSensitive(text);
  const spans = findings
    .filter((f) => typeof f.start === "number" && typeof f.end === "number")
    .sort((a, b) => b.start! - a.start!);
  let scrubbed = text;
  for (const f of spans) scrubbed = `${scrubbed.slice(0, f.start!)}[withheld: ${f.label}]${scrubbed.slice(f.end!)}`;
  return { text: scrubbed, findings };
}

export type EgressAudience = "self" | "external" | "public";

export interface EgressEvaluation {
  verdict: "allow" | "hold";
  findings: EgressFinding[];
  categories: string[];
  reason: string;
}

/** The core gate: given who will see the content and what it says, allow or
 *  hold. Self audience always passes (the user talking to themself is the
 *  product); external/public with any finding holds when the guard is on. */
export function evaluateEgress(
  audience: EgressAudience,
  texts: string[],
  mode: EgressGuardMode = readEgressGuard(),
): EgressEvaluation {
  if (mode === "off") return { verdict: "allow", findings: [], categories: [], reason: "egress guard is off" };
  if (audience === "self") return { verdict: "allow", findings: [], categories: [], reason: "self-directed" };
  const findings = texts.flatMap((t) => scanSensitive(t));
  if (findings.length === 0) return { verdict: "allow", findings, categories: [], reason: "no sensitive content detected" };
  const categories = findingCategories(findings);
  return {
    verdict: "hold",
    findings,
    categories,
    reason: `held by your sensitive-information guardrail: the outbound content contains ${categories.join("; ")}`,
  };
}

// ── gws-specific egress classification ──────────────────────────────────────
// Given a gws argv, work out WHO will see the result and WHICH strings leave.
// Used by the write executor (runGwsApproved) and the queue-time classifier.

export interface GwsEgress {
  audience: EgressAudience;
  texts: string[];
  /** Drive shares expose whole documents we cannot scan; always hold those. */
  unscannable?: boolean;
}

function flagValues(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    for (const n of names) {
      if (a === `--${n}`) { if (args[i + 1]) out.push(args[i + 1]!); }
      else if (a.startsWith(`--${n}=`)) out.push(a.slice(n.length + 3));
    }
  }
  return out;
}

function paramsStrings(args: string[]): { texts: string[]; recipients: string[]; attendees: boolean } {
  const texts: string[] = [];
  const recipients: string[] = [];
  let attendees = false;
  for (const raw of flagValues(args, ["params"])) {
    try {
      const walk = (v: unknown, key: string) => {
        if (typeof v === "string") {
          if (/^(to|cc|bcc)$/i.test(key)) { for (const p of v.split(",")) if (p.includes("@")) recipients.push(p.trim().toLowerCase()); }
          else texts.push(v);
        } else if (Array.isArray(v)) {
          if (/attendee/i.test(key) && v.length > 0) attendees = true;
          v.forEach((x) => walk(x, key));
        } else if (v && typeof v === "object") {
          if (/attendee/i.test(key)) attendees = true;
          for (const [k, x] of Object.entries(v)) walk(x, k);
        }
      };
      walk(JSON.parse(raw), "");
    } catch { texts.push(raw); } // unparseable params: scan the raw string
  }
  return { texts, recipients, attendees };
}

/** Classify one gws write for the egress gate. `selves` = the user's own
 *  connected addresses (from email-policy's selfAddresses). */
export function gwsEgress(args: string[], selves: Set<string>): GwsEgress {
  const svc = (args[0] ?? "").toLowerCase();
  const joined = args.join(" ").toLowerCase();
  const p = paramsStrings(args);

  if (svc === "gmail") {
    const isSend = args.some((a) => a === "+send" || a === "+reply" || a === "+reply-all" || a === "+forward" || a === "send");
    if (!isSend) return { audience: "self", texts: [] };
    // A draft never leaves the user's own account until they press Send.
    if (args.includes("--draft")) return { audience: "self", texts: [] };
    const flagRecipients = flagValues(args, ["to", "cc", "bcc"])
      .flatMap((v) => v.split(","))
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@"));
    const recipients = [...flagRecipients, ...p.recipients];
    const external = recipients.some((r) => !selves.has(r));
    // Replies/forwards without explicit recipients go to the thread's
    // participants - unknowable here, so external (conservative).
    const audience: EgressAudience = recipients.length === 0 ? "external" : external ? "external" : "self";
    return { audience, texts: [...flagValues(args, ["subject", "body", "message"]), ...p.texts] };
  }

  if (svc === "calendar") {
    const hasAttendees = args.some((a) => a === "--attendee" || a === "--attendees" || a.startsWith("--attendee=") || a.startsWith("--attendees=")) || p.attendees;
    if (!hasAttendees) return { audience: "self", texts: [] };
    // An invite emails its description to every attendee.
    return { audience: "external", texts: [...flagValues(args, ["summary", "description", "location", "title"]), ...p.texts] };
  }

  if (svc === "drive" || svc === "docs" || svc === "sheets") {
    if (/permission|share/.test(joined)) {
      // Sharing exposes the WHOLE document, which we cannot scan from here.
      return { audience: "external", texts: [...flagValues(args, ["message"]), ...p.texts], unscannable: true };
    }
    return { audience: "self", texts: [] };
  }

  // Labels, tasks, drafts management, everything else stays inside the account.
  return { audience: "self", texts: [] };
}

/** Full gws decision used by the executor. `allowSensitive` is the user's
 *  explicit per-action release (the --allow-sensitive re-approval). */
export function applyEgressGuardToGws(
  args: string[],
  selves: Set<string>,
  allowSensitive = false,
  mode: EgressGuardMode = readEgressGuard(),
): { action: "allow" | "hold"; categories: string[]; reason: string; unscannable?: boolean } {
  if (mode === "off" || allowSensitive) return { action: "allow", categories: [], reason: allowSensitive ? "released by your explicit approval" : "egress guard is off" };
  const eg = gwsEgress(args, selves);
  if (eg.audience === "self") return { action: "allow", categories: [], reason: "self-directed" };
  if (eg.unscannable) {
    return { action: "hold", categories: ["a shared document (contents cannot be scanned)"], reason: "held by your sensitive-information guardrail: sharing exposes the whole document", unscannable: true };
  }
  const ev = evaluateEgress(eg.audience, eg.texts, mode);
  if (ev.verdict === "allow") return { action: "allow", categories: [], reason: ev.reason };
  return { action: "hold", categories: ev.categories, reason: ev.reason };
}
