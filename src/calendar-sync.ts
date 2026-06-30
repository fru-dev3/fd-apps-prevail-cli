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
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The normalized event shape the desktop Calendar view reads. `domain` is
// optional in the contract and left unset by an external pull.
export interface NormalizedEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  url: string;
}

// Pure, unit-testable normalizer. Takes a parsed Google Calendar API response
// ({ items: [{ id, summary, start: { date?, dateTime? }, htmlLink }] }) and
// returns the desktop event shape. Items with no usable date are skipped.
export function normalizeGoogleEvents(raw: unknown): NormalizedEvent[] {
  const items =
    raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  const out: NormalizedEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const start = o.start && typeof o.start === "object" ? (o.start as Record<string, unknown>) : {};
    const date = dateFromStart(start);
    if (!date) continue; // no usable date — skip
    out.push({
      id: typeof o.id === "string" ? o.id : "",
      title: typeof o.summary === "string" && o.summary.trim() ? o.summary : "(untitled)",
      date,
      url: typeof o.htmlLink === "string" ? o.htmlLink : "",
    });
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
}

const SOURCE = "gws";
const NOT_INSTALLED = "Google Workspace CLI (gws) is not installed";
const NOT_AUTHED = "Google Workspace CLI is not authenticated yet (run: gws auth login)";

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

// Stage A entry point. Resolves the gws binary, runs the read-only
// `calendar events list`, normalizes, and writes <vaultRoot>/calendar-external.json.
// ALWAYS resolves with a parseable PullResult — it never throws — so the desktop
// gets JSON, never a crash.
export async function pullGoogleCalendar(vaultRoot: string): Promise<PullResult> {
  try {
    const vault = (vaultRoot || "").trim();
    if (!vault || !existsSync(vault)) {
      return { ok: false, reason: "vault is missing or locked", count: 0 };
    }

    // 1. Resolve the gws binary.
    const gws = resolveGwsBinary();
    if (!gws) {
      return { ok: false, reason: NOT_INSTALLED, count: 0 };
    }

    // 2. Run the READ-ONLY events.list. gws emits the standard Google Calendar API
    //    events.list response as JSON on stdout.
    const timeMin = new Date().toISOString();
    const params = JSON.stringify({
      calendarId: "primary",
      singleEvents: true,
      orderBy: "startTime",
      timeMin,
      maxResults: 250,
    });
    const run = spawnSync(gws, ["calendar", "events", "list", "--params", params], {
      encoding: "utf8",
      env: { ...process.env, PATH: augmentedPath() },
      maxBuffer: 16 * 1024 * 1024,
    });

    // Spawn failure (binary vanished, not executable, etc.).
    if (run.error) {
      return { ok: false, reason: NOT_AUTHED, count: 0 };
    }

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
      if (parsed === undefined) {
        return { ok: false, reason: NOT_AUTHED, count: 0 };
      }
    }
    const hasItems =
      !!parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items);
    const hasError = !!parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>);
    if (run.status !== 0 || hasError || !hasItems) {
      return { ok: false, reason: NOT_AUTHED, count: 0 };
    }

    // 3. Normalize into the desktop event shape.
    const events = normalizeGoogleEvents(parsed);

    // 4. Write the normalized array to <vaultRoot>/calendar-external.json as
    //    PLAINTEXT (plain fs — the desktop reads this file raw, not decrypted).
    const outPath = join(vault, "calendar-external.json");
    try {
      writeFileSync(outPath, `${JSON.stringify(events, null, 2)}\n`);
    } catch (e) {
      return { ok: false, reason: shortReason(e), count: 0 };
    }

    return { ok: true, count: events.length, source: SOURCE };
  } catch (e) {
    return { ok: false, reason: shortReason(e), count: 0 };
  }
}
