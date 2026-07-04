// Calendar sync (Stage A): a one-way, READ-ONLY pull of the user's Google
// Calendar events into the local vault so the desktop Calendar view can show
// them. NOTHING is ever written back to Google here.
//
// The desktop reads <vaultRoot>/calendar-external.json as PLAINTEXT via a
// generic text-file reader, expecting an array of:
//   { id, title, date: "YYYY-MM-DD", domain?, url? }
//
// Source: the official Google Workspace CLI (`gws`, github.com/googleworkspace/cli),
// which the user authenticates separately (`gws auth login`). We shell out to it
// read-only (`gws calendar events list`); its output is the standard Google
// Calendar API events.list response. This module:
//   1. resolves the `gws` binary (PATH + well-known install locations),
//   2. runs the read-only events.list command and parses its JSON,
//   3. normalizes that response into the desktop shape, and
//   4. writes calendar-external.json at the vault root in PLAINTEXT (plain fs,
//      never the encrypting vault writer, because the desktop reads it raw).

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildRoot } from "./path-safety.ts";

// The normalized event shape the desktop Calendar view reads. `domain` is
// optional in the contract and left unset by an external pull. `account` is the
// optional account label an event came from — set only on a multi-account pull,
// so a single-account pull keeps the original {id,title,date,url} shape exactly.
export interface NormalizedEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  url: string;
  account?: string;
}

// Pure, unit-testable normalizer. Takes a parsed Google Calendar API response
// ({ items: [{ id, summary, start: { date?, dateTime? }, htmlLink }] }) and
// returns the desktop event shape. Items with no usable date are skipped.
//
// When `account` is given (a multi-account pull), each event is TAGGED with that
// account label and its id is namespaced (`<account>:<id>`) so events from
// different accounts never collide. With no `account` the output is the original
// {id,title,date,url} shape, byte-for-byte unchanged.
export function normalizeGoogleEvents(raw: unknown, account?: string): NormalizedEvent[] {
  const items =
    raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  const tag = (account || "").trim();
  const out: NormalizedEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const start = o.start && typeof o.start === "object" ? (o.start as Record<string, unknown>) : {};
    const date = dateFromStart(start);
    if (!date) continue; // no usable date — skip
    const rawId = typeof o.id === "string" ? o.id : "";
    const ev: NormalizedEvent = {
      id: tag ? `${tag}:${rawId}` : rawId,
      title: typeof o.summary === "string" && o.summary.trim() ? o.summary : "(untitled)",
      date,
      url: typeof o.htmlLink === "string" ? o.htmlLink : "",
    };
    if (tag) ev.account = tag;
    out.push(ev);
  }
  return out;
}

// Pull a "YYYY-MM-DD" date out of a Google Calendar event start block:
// all-day events carry `start.date`; timed events carry `start.dateTime`
// (an ISO timestamp whose leading date part we keep).
function dateFromStart(start: Record<string, unknown>): string {
  const allDay = start.date;
  if (typeof allDay === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(allDay);
    if (m) return m[1]!;
  }
  const timed = start.dateTime;
  if (typeof timed === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(timed);
    if (m) return m[1]!;
  }
  return "";
}

export interface PullResult {
  ok: boolean;
  count: number;
  source?: string;
  reason?: string;
  // Per-account breakdown, set only by the multi-account pull.
  accounts?: { account: string; ok: boolean; count: number; reason?: string }[];
}

const SOURCE = "gws";
const NOT_INSTALLED = "Google Workspace CLI (gws) is not installed";
const NOT_AUTHED = "Google Calendar access was not granted for this account. You may be signed in, but the Calendar scope is missing. Re-authorize from the Google panel and approve ALL requested permissions. If it still fails, your OAuth client is not enabled for Calendar (set one up with `gws auth setup`).";

// One-line, human, no-secrets failure reason. Kept short for the desktop JSON.
function shortReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").trim().slice(0, 200) || "calendar pull failed";
}

// A PATH that includes the common package-manager bin dirs, so a `gws` installed
// by Homebrew / a user-local install is found even when the desktop spawns us
// with a sparse env.
function augmentedPath(): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin")];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  const seen = new Set(current);
  for (const d of extra) if (!seen.has(d)) { current.push(d); seen.add(d); }
  return current.join(":");
}

// Resolve the `gws` binary the same way the desktop does: `which gws` first,
// then the well-known install locations. Returns the absolute path, or null.
// An explicit PREVAIL_GWS_BIN wins when set (the desktop already resolves gws,
// so it can hand us the path directly); a set-but-missing path means "not found".
export function resolveGwsBinary(): string | null {
  const override = process.env.PREVAIL_GWS_BIN;
  if (typeof override === "string" && override.trim()) {
    const p = override.trim();
    return existsSync(p) ? p : null;
  }
  const path = augmentedPath();
  const which = spawnSync("which", ["gws"], { encoding: "utf8", env: { ...process.env, PATH: path } });
  if (which.status === 0) {
    const p = (which.stdout || "").trim().split("\n")[0]?.trim();
    if (p && existsSync(p)) return p;
  }
  const candidates = [
    "/opt/homebrew/bin/gws",
    "/usr/local/bin/gws",
    join(homedir(), ".local", "bin", "gws"),
    join(homedir(), ".cargo", "bin", "gws"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ── Google account / profile selection ──────────────────────────────────────
// gws is single-account per config dir but honors GOOGLE_WORKSPACE_CLI_CONFIG_DIR,
// so each Google account is one dir under ~/.config: the default profile (`gws`)
// and labeled profiles (`gws-<label>`). These helpers mirror the desktop's
// google.rs so the CLI can target one account, or fan out across all of them.

// One Google account = one gws config dir. `label` is the human handle (the dir
// suffix after "gws-", or "default" for the base dir).
export interface GwsProfile {
  label: string;
  configDir: string;
}

const GWS_BASE = (): string => join(homedir(), ".config");

// A config dir counts as a profile once gws has written auth material there
// (token cache / encrypted creds / OAuth client). Matches google.rs.
function isGwsProfileDir(dir: string): boolean {
  return (
    existsSync(join(dir, "token_cache.json")) ||
    existsSync(join(dir, "credentials.enc")) ||
    existsSync(join(dir, "client_secret.json"))
  );
}

function labelFromDir(name: string): string {
  if (name === "gws") return "default";
  const rest = name.startsWith("gws-") ? name.slice("gws-".length) : "";
  return rest || "default";
}

// Every Google profile (config dir) gws has on this machine, sorted by dir so the
// order is stable. Used by the multi-account calendar pull and to validate a
// requested account label.
export function listGwsProfiles(): GwsProfile[] {
  const base = GWS_BASE();
  const out: GwsProfile[] = [];
  try {
    for (const name of readdirSync(base)) {
      if (name !== "gws" && !name.startsWith("gws-")) continue;
      const dir = join(base, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!isGwsProfileDir(dir)) continue;
      out.push({ label: labelFromDir(name), configDir: dir });
    }
  } catch {
    /* no ~/.config — return empty */
  }
  out.sort((a, b) => a.configDir.localeCompare(b.configDir));
  return out;
}

// Pure decision: given the connected profiles on this machine, which account
// should a caller that passed NO explicit account target? Machine-agnostic on
// purpose - profiles are whatever gws config dirs exist on THIS machine, never
// specific labels/addresses. Rules ("never guess between identities"):
//   - no connected profiles -> undefined (nothing to target; the caller still
//     fails, but with an honest, account-named error);
//   - exactly ONE connected profile -> that profile, whatever its label
//     (including the bare "default" dir). Unambiguous, so zero friction;
//   - TWO OR MORE connected profiles -> undefined: acting as the wrong identity
//     is worse than asking, so no auto-pick. Callers that can ask (the chat
//     connector) refuse with the connected labels (see resolveGwsAccounts);
//     background callers fall back to gws's own default dir as before.
// NOTE: "connected" here means "has auth material on disk" (see isGwsProfileDir),
// not a live per-scope probe, so a pick can still hit an account whose specific
// scope was not granted; that surfaces as an honest, account-named auth error
// downstream (see gws-gateway).
export function pickDefaultGwsAccount(profiles: GwsProfile[]): string | undefined {
  if (profiles.length === 1) return profiles[0]!.label;
  return undefined;
}

// The full no-explicit-account resolution, for callers that can ask the user:
// none / a single unambiguous account / ambiguous with the connected labels.
export type GwsAccountResolution =
  | { kind: "none" }
  | { kind: "single"; label: string }
  | { kind: "ambiguous"; labels: string[] };

export function resolveGwsAccounts(profiles: GwsProfile[] = listGwsProfiles()): GwsAccountResolution {
  if (profiles.length === 0) return { kind: "none" };
  if (profiles.length === 1) return { kind: "single", label: profiles[0]!.label };
  return { kind: "ambiguous", labels: profiles.map((p) => p.label) };
}

// The connected/authorized Google account to target when a caller passes none.
// Reads the live profile list and applies pickDefaultGwsAccount. Returns a label
// (or undefined to mean the default profile / ~/.config/gws).
export function resolveDefaultGwsAccount(): string | undefined {
  return pickDefaultGwsAccount(listGwsProfiles());
}

// Resolve an account selector to a gws config dir, or undefined for the default
// profile (caller then leaves GOOGLE_WORKSPACE_CLI_CONFIG_DIR unset → ~/.config/gws).
// Accepts a label ("work"), the literal "default", or an absolute config-dir path.
export function resolveGwsConfigDir(account?: string): string | undefined {
  const a = (account || "").trim();
  if (!a || a.toLowerCase() === "default") return undefined;
  // An explicit, existing absolute path wins.
  if (a.startsWith("/") && existsSync(a)) return a;
  // Otherwise treat it as a label, matching a known profile first.
  for (const p of listGwsProfiles()) {
    if (p.label === a) return p.configDir;
  }
  // Fall back to the conventional dir for the label (may be created by login).
  const safe = a.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "default") return undefined;
  return join(GWS_BASE(), `gws-${safe}`);
}

// Build the spawn env for a gws call, augmenting PATH and (when an account is
// given) pointing gws at that account's config dir. Centralized so reads, the
// approval path, and the calendar pull all target accounts the same way.
export function gwsSpawnEnv(account?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  // An explicit account (a picked chip, a model `account:` arg, or a per-account
  // fan-out label) always wins. When NONE is given, target a CONNECTED account
  // rather than gws's arbitrary on-disk default, so a domain chat with the Google
  // app attached authenticates as the same account the app chat would use.
  const explicit = (account || "").trim();
  const effective = explicit ? account : resolveDefaultGwsAccount();
  const dir = resolveGwsConfigDir(effective);
  if (dir) env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = dir;
  return env;
}

// Run the READ-ONLY events.list for ONE account (or the default profile when
// `account` is undefined) and return its normalized events, or a short reason on
// failure. Stays read-only and never throws. When `account` is given the events
// are tagged with that label so a fan-out can merge them without id collisions.
function fetchAccountEvents(
  gws: string,
  account?: string,
): { ok: true; events: NormalizedEvent[] } | { ok: false; reason: string } {
  const timeMin = new Date().toISOString();
  const params = JSON.stringify({
    calendarId: "primary",
    singleEvents: true,
    orderBy: "startTime",
    timeMin,
    maxResults: 250,
  });
  // gws is single-account per config dir; gwsSpawnEnv points it at the chosen
  // account's dir (or the default profile when account is undefined).
  const run = spawnSync(gws, ["calendar", "events", "list", "--params", params], {
    encoding: "utf8",
    env: gwsSpawnEnv(account),
    maxBuffer: 16 * 1024 * 1024,
  });

  // Spawn failure (binary vanished, not executable, etc.).
  if (run.error) return { ok: false, reason: NOT_AUTHED };

  // Non-zero exit, or output that doesn't parse, or an error object instead of
  // an items array → treat as not-authenticated / provider error. gws prints
  // diagnostics (e.g. "Using keyring backend: keyring") to stderr, so stdout is
  // clean JSON; we still slice from the first brace defensively in case a future
  // version prepends a line to stdout.
  const out = run.stdout || "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    const brace = out.indexOf("{");
    try {
      parsed = brace >= 0 ? JSON.parse(out.slice(brace)) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) return { ok: false, reason: NOT_AUTHED };
  }
  const hasItems =
    !!parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items);
  const hasError = !!parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>);
  if (run.status !== 0 || hasError || !hasItems) {
    return { ok: false, reason: NOT_AUTHED };
  }
  return { ok: true, events: normalizeGoogleEvents(parsed, account) };
}

// Write the normalized events to calendar-external.json as PLAINTEXT (plain fs —
// the desktop reads this file raw, not decrypted). Canonical layout keeps it
// under build/ (buildRoot falls back to the vault root on a legacy vault); the
// desktop reader prefers build/ then the root.
function writeExternalCalendar(vault: string, events: NormalizedEvent[]): void {
  const outPath = join(buildRoot(vault), "calendar-external.json");
  writeFileSync(outPath, `${JSON.stringify(events, null, 2)}\n`);
}

// Stage A entry point. Resolves the gws binary, runs the read-only
// `calendar events list`, normalizes, and writes <vaultRoot>/calendar-external.json.
// ALWAYS resolves with a parseable PullResult — it never throws — so the desktop
// gets JSON, never a crash.
//
// `opts.account` targets a specific Google account (label or config dir); when
// omitted the default profile is used and the events keep the original
// {id,title,date,url} shape (no account tag).
export async function pullGoogleCalendar(
  vaultRoot: string,
  opts?: { account?: string },
): Promise<PullResult> {
  try {
    const vault = (vaultRoot || "").trim();
    if (!vault || !existsSync(vault)) {
      return { ok: false, reason: "vault is missing or locked", count: 0 };
    }
    const gws = resolveGwsBinary();
    if (!gws) {
      return { ok: false, reason: NOT_INSTALLED, count: 0 };
    }
    const r = fetchAccountEvents(gws, opts?.account);
    if (!r.ok) {
      return { ok: false, reason: r.reason, count: 0 };
    }
    try {
      writeExternalCalendar(vault, r.events);
    } catch (e) {
      return { ok: false, reason: shortReason(e), count: 0 };
    }
    return { ok: true, count: r.events.length, source: SOURCE };
  } catch (e) {
    return { ok: false, reason: shortReason(e), count: 0 };
  }
}

// Multi-account entry point: pull READ-ONLY across EVERY connected Google account
// (one gws config dir each), tag each event with its account label, merge, and
// write the single calendar-external.json the desktop reads. Accounts whose token
// is expired / under-scoped are skipped (recorded in `accounts`) rather than
// failing the whole pull. With zero profiles it falls back to a default-profile
// pull so behavior is unchanged on a single-account setup.
export async function pullAllGoogleCalendars(vaultRoot: string): Promise<PullResult> {
  try {
    const vault = (vaultRoot || "").trim();
    if (!vault || !existsSync(vault)) {
      return { ok: false, reason: "vault is missing or locked", count: 0 };
    }
    const gws = resolveGwsBinary();
    if (!gws) {
      return { ok: false, reason: NOT_INSTALLED, count: 0 };
    }
    const profiles = listGwsProfiles();
    if (profiles.length === 0) {
      // No labeled profiles detected — behave like the default single-account pull.
      return pullGoogleCalendar(vault);
    }

    const merged: NormalizedEvent[] = [];
    const accounts: { account: string; ok: boolean; count: number; reason?: string }[] = [];
    for (const p of profiles) {
      // The default profile reads with no account tag would collide ids across
      // accounts, so even the default is tagged by its label here.
      const r = fetchAccountEvents(gws, p.label);
      if (r.ok) {
        merged.push(...r.events);
        accounts.push({ account: p.label, ok: true, count: r.events.length });
      } else {
        accounts.push({ account: p.label, ok: false, count: 0, reason: r.reason });
      }
    }

    try {
      writeExternalCalendar(vault, merged);
    } catch (e) {
      return { ok: false, reason: shortReason(e), count: 0 };
    }
    const anyOk = accounts.some((a) => a.ok);
    return {
      ok: anyOk,
      count: merged.length,
      source: SOURCE,
      accounts,
      reason: anyOk ? undefined : NOT_AUTHED,
    };
  } catch (e) {
    return { ok: false, reason: shortReason(e), count: 0 };
  }
}
