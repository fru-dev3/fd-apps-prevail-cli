// The source registry and consent. Metrics plan M3, apps plan A2.
//
// Every source Prevail can read is listed here with its wave, what it reads,
// whether it stays on this Mac, and whether it needs a local model. Consent is
// per source and per Mac (build/_meta/consent.json, machine-managed, never
// synced: a Mac's own photos or messages are that Mac's to allow). Sources
// that need nothing new are on by default; every wave 2 source that needs a
// connection and every wave 3 and 4 source starts off and runs only after the
// user turns it on. Enforced in code: each reader calls requireConsent first.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePath } from "./path-safety.ts";
import { hostSlug } from "./metrics.ts";

export interface SourceDef {
  id: string;
  title: string;
  wave: 1 | 2 | 3 | 4;
  /** What it reads, in plain words, shown on the consent screen. */
  reads: string;
  /** What it never reads. */
  never: string;
  /** On without asking: the source needs nothing new (files already on disk, or a connection the user already made). */
  defaultOn: boolean;
  /** Events stay on this Mac (build/_meta/events-local), never synced. */
  localOnly?: boolean;
  /** Content is read by a local model only (never a cloud model). */
  localModel?: boolean;
  /** Needs macOS Full Disk Access for Prevail. */
  fda?: boolean;
  /** How to connect it when it needs a connection. */
  connect?: string;
  emits: string[];
}

export const SOURCES: SourceDef[] = [
  { id: "ai", title: "AI tools", wave: 1, reads: "token and session counts from each AI tool's own local records", never: "prompt or reply text", defaultOn: true, emits: ["ai.tokens", "ai.session"] },
  { id: "git", title: "Git repos", wave: 1, reads: "commits you authored and release tags, per day", never: "commit messages or code", defaultOn: true, emits: ["git.commit", "git.tag"] },
  { id: "spotlight", title: "Installed apps", wave: 1, reads: "the apps installed on this Mac, when each was last opened", never: "anything inside the apps", defaultOn: true, emits: ["app.last_used"] },
  { id: "browsers", title: "Browser domains", wave: 1, reads: "visits per website domain per day from Chrome, Atlas, Arc, Brave, Edge and Safari", never: "addresses, page titles or searches; health, finance, adult and dating sites are never counted", defaultOn: true, emits: ["web.visits"] },
  { id: "live-focus", title: "Live app focus", wave: 1, reads: "which app is in front while Prevail runs, in minutes", never: "window titles or screen contents", defaultOn: true, emits: ["app.focus"] },
  { id: "screentime", title: "Screen Time", wave: 2, reads: "minutes per app on this Mac and, with Screen Time sharing, the iPhone", never: "what you did inside an app", defaultOn: true, fda: true, emits: ["app.focus", "web.visits"] },
  { id: "gmail", title: "Gmail headers", wave: 2, reads: "who you emailed and when, replies and reply times, from message headers", never: "message bodies or attachments", defaultOn: true, connect: "Sign in to Google for Prevail (Settings, Google accounts)", emits: ["email.sent", "email.received", "email.reply"] },
  { id: "calendar", title: "Google Calendar", wave: 2, reads: "event times, attendee counts and titles, for meeting, focus and after-hours time", never: "descriptions, notes or attachments", defaultOn: true, connect: "Sign in to Google for Prevail (Settings, Google accounts)", emits: ["cal.meeting", "cal.focus", "cal.after_hours", "cal.family"] },
  { id: "github", title: "GitHub", wave: 2, reads: "pull requests and issues you opened and merged, from the gh command line tool", never: "code or comments", defaultOn: true, connect: "gh auth login", emits: ["gh.pr_opened", "gh.pr_merged", "gh.issue_opened"] },
  { id: "youtube", title: "YouTube channel analytics", wave: 2, reads: "daily views, watch minutes, subscribers and videos published on your channel", never: "comments or viewers", defaultOn: false, connect: "Connect YouTube Analytics with a read-only Google sign-in; the token stays in this Mac's Keychain (service prevail-youtube)", emits: ["yt.views", "yt.published", "yt.subscribers"] },
  { id: "plaid", title: "Bank charges (Plaid)", wave: 3, reads: "recurring charges: merchant, amount and date, matched to your apps", never: "balances or charges that match no app", defaultOn: false, connect: "Link an account with Plaid; keys stay in this Mac's Keychain (services prevail-plaid-*)", emits: ["money.charge"] },
  { id: "apple-health", title: "Apple Health export", wave: 3, reads: "daily steps, sleep, workouts and resting heart rate from a Health export you drop in", never: "anything else in the export", defaultOn: false, connect: "On the iPhone: Health, your picture, Export All Health Data; drop export.zip in data/apps/apple-health/inbox/", emits: ["health.steps", "health.sleep", "health.workout", "health.rhr"] },
  { id: "timeline", title: "Google Maps Timeline export", wave: 3, reads: "how many places you visited per day, new places, days away from home", never: "coordinates or addresses (places are kept as hashes)", defaultOn: false, connect: "On the phone: Settings, Location, Timeline, Export; drop the JSON in data/apps/timeline/inbox/ (monthly: the phone deletes after 3 months)", emits: ["place.visit", "place.new", "day.away"] },
  { id: "oura", title: "Oura", wave: 3, reads: "daily sleep, readiness and steps", never: "anything else", defaultOn: false, connect: "Create an Oura personal access token; keep it in this Mac's Keychain (service prevail-oura)", emits: ["health.sleep", "health.steps"] },
  { id: "strava", title: "Strava", wave: 3, reads: "activities: date, type, minutes and distance", never: "routes or maps", defaultOn: false, connect: "Strava API access token in this Mac's Keychain (service prevail-strava)", emits: ["health.workout"] },
  { id: "garmin", title: "Garmin export", wave: 3, reads: "activities from a Garmin Connect export you drop in", never: "routes or maps", defaultOn: false, connect: "Garmin Connect, Export Your Data; drop the activities file in data/apps/garmin-connect/inbox/", emits: ["health.workout"] },
  { id: "photos", title: "Apple Photos", wave: 4, reads: "photos taken per day and how many places, from the Photos library database", never: "the photos, faces or exact locations", defaultOn: false, localOnly: true, fda: true, emits: ["photo.taken", "photo.places"] },
  { id: "messages", title: "Messages counts", wave: 4, reads: "messages sent and received per day and how many people", never: "message text, names or numbers", defaultOn: false, localOnly: true, fda: true, emits: ["msg.sent", "msg.received"] },
  { id: "calls", title: "Call counts", wave: 4, reads: "calls per day and their minutes", never: "numbers or names", defaultOn: false, localOnly: true, fda: true, emits: ["call.made"] },
  { id: "browser-topics", title: "Browsing topics", wave: 4, reads: "the topics of the sites you visit this month, named by a local model", never: "addresses or pages; nothing goes to a cloud model", defaultOn: false, localOnly: true, localModel: true, emits: ["theme.reading"] },
  { id: "writing-themes", title: "Writing themes", wave: 4, reads: "the themes of what you write to AI tools this month, named by a local model", never: "the text itself leaves this Mac; nothing goes to a cloud model", defaultOn: false, localOnly: true, localModel: true, emits: ["theme.writing"] },
];

export const sourceDef = (id: string) => SOURCES.find((s) => s.id === id);

interface ConsentRow { on: boolean; ts: string; host: string }
const consentPath = (vault: string) => join(runtimePath(vault, "_meta"), "consent.json");

export function readConsent(vault: string): Record<string, ConsentRow> {
  try { return (JSON.parse(readFileSync(consentPath(vault), "utf8")) as { sources?: Record<string, ConsentRow> }).sources ?? {}; } catch { return {}; }
}

/** Is this source allowed to run on this Mac? The user's answer, else the source's default. Unknown ids are never allowed. */
export function consented(vault: string, id: string): boolean {
  const def = sourceDef(id);
  if (!def) return false;
  const row = readConsent(vault)[id];
  return row ? row.on : def.defaultOn;
}

export class ConsentError extends Error { constructor(public source: string) { super(`source ${source} is off on this Mac; turn it on with: prevail sources consent ${source} on`); } }

/** Every reader calls this first. Throws when the user has not allowed the source. */
export function requireConsent(vault: string, id: string): void {
  if (!consented(vault, id)) throw new ConsentError(id);
}

export function setConsent(vault: string, id: string, on: boolean): ConsentRow {
  if (!sourceDef(id)) throw new Error(`unknown source: ${id}`);
  const all = readConsent(vault);
  const row = { on, ts: new Date().toISOString(), host: hostSlug() };
  all[id] = row;
  const p = consentPath(vault);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify({ sources: all }, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return row;
}

/** Where a source's events go: synced events, or this Mac only. */
export function eventsDirFor(vault: string, id: string, src = id): string {
  const local = sourceDef(id)?.localOnly;
  return join(runtimePath(vault, "_meta"), local ? "events-local" : "events", src);
}

export const consentFileExists = (vault: string) => existsSync(consentPath(vault));

// ── CLI: prevail sources list | consent <id> on|off ────────────────────────

export async function sourcesCommand(argv: string[], vault: string): Promise<number> {
  const { parseModArgs } = await import("./cli-args.ts");
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  // Knowledge sources (knowledge-sources.ts): add, list, check, remove, use,
  // read, query. The consent list below is `sources list --consent`.
  if (["add", "check", "remove", "use", "read", "query"].includes(sub) || (sub === "list" && !args.has("consent"))) {
    return (await import("./knowledge-cli.ts")).knowledgeCommand(sub, args, vault);
  }
  if (sub === "list" || (sub === "consent" && !args.pos[1])) {
    const rows = listSources(vault);
    if (args.json) out(rows);
    else for (const r of rows) console.log(`${r.on ? "on " : "off"} w${r.wave} ${r.id.padEnd(15)} ${r.state}${r.note ? `  (${r.note})` : ""}`);
    return 0;
  }
  if (sub === "consent") {
    const id = args.pos[1] ?? "";
    const v = args.pos[2];
    if (!sourceDef(id) || (v !== "on" && v !== "off")) { console.error("usage: prevail sources consent <id> on|off"); return 1; }
    const row = setConsent(vault, id, v === "on");
    if (args.json) out({ ok: true, id, ...row }); else console.log(`${id}: ${v} on this Mac`);
    return 0;
  }
  if (sub === "sync") {
    const { syncSource } = await import("./source-sync.ts");
    const ids = args.pos[1] ? [args.pos[1]] : SOURCES.filter((s) => s.wave >= 2 && s.id !== "screentime").map((s) => s.id);
    const res: Record<string, unknown> = {};
    for (const id of ids) res[id] = await syncSource(vault, id, { backfill: args.has("backfill") });
    if (args.json) out(res); else for (const [k, v] of Object.entries(res)) console.log(`${k.padEnd(15)} ${JSON.stringify(v)}`);
    return 0;
  }
  console.error("usage: prevail sources add|list|check|remove|use|read|query ... (knowledge sources) | list --consent | consent <id> on|off | sync [<id>] [--backfill] [--json]");
  return 1;
}

export interface SourceRow extends SourceDef { on: boolean; decided: boolean; state: string; note?: string; last_sync?: string; events?: number }

/** Every source with this Mac's consent and its last sync state (build/_meta/source-state.json). */
export function listSources(vault: string): SourceRow[] {
  const consent = readConsent(vault);
  let state: Record<string, { state: string; note?: string; ts?: string; events?: number }> = {};
  try { state = JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "source-state.json"), "utf8")) as typeof state; } catch { /* none yet */ }
  return SOURCES.map((s) => {
    const on = consented(vault, s.id);
    const st = state[s.id];
    return { ...s, on, decided: !!consent[s.id], state: on ? (st?.state ?? "not synced yet") : "off", ...(st?.note ? { note: st.note } : {}), ...(st?.ts ? { last_sync: st.ts } : {}), ...(st?.events !== undefined ? { events: st.events } : {}) };
  });
}

/** Record how a source's last sync went (machine-managed). */
export function recordSourceState(vault: string, id: string, st: { state: string; note?: string; events?: number }): void {
  const p = join(runtimePath(vault, "_meta"), "source-state.json");
  let all: Record<string, unknown> = {};
  try { all = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { /* first */ }
  all[id] = { ...st, ts: new Date().toISOString() };
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}
