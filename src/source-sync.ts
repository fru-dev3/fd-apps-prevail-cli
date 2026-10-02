// Connected sources (metrics plan M3): each reader turns one source into
// content-free events. Every reader checks consent first (sources.ts).
//
// Wave 2 (connected, sync only):
//   - gmail: message headers through the gws CLI (format=metadata: From, To,
//     Cc, Subject, Date, In-Reply-To, Message-ID; never a body). Headers are
//     kept on this Mac only, in build/_meta/mail/headers.<account>.jsonl, for
//     the readers that need them (Today's commitments and waiting-fors, the
//     stack's receipts); events carry counts and hashed people only.
//   - calendar: events through gws (calendarList + events.list, -90 to +60
//     days), kept on this Mac in build/_meta/calendar/events.<account>.json
//     (id, calendar, title, start, end, attendees count, own response) for
//     Today, missions and the time review; events carry hours only.
//   - github: pull requests and issues you opened and merged, through `gh api`.
//   - youtube: channel analytics with a read-only token the user put in this
//     Mac's Keychain (never in the vault); off until turned on.
// Waves 3 and 4 live in source-files.ts and source-mac.ts.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayOf, hostSlug, type MetricEvent } from "./metrics.ts";
import { runtimePath } from "./path-safety.ts";
import { ConsentError, eventsDirFor, recordSourceState, requireConsent, sourceDef } from "./sources.ts";

export interface SyncResult { state: string; events?: number; note?: string; accounts?: Record<string, string> }
export interface SyncOpts { backfill?: boolean; now?: number; host?: string; run?: Runner; fetch?: typeof fetch; secret?: (service: string) => string | null; google?: { gws: string | null; accounts: GoogleAccountRef[] }; home?: string }
type Reader = (vault: string, opts: SyncOpts) => Promise<SyncResult> | SyncResult;

/** Run a command and return stdout, or throw with its error text. Injected in tests. */
export type Runner = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => { ok: boolean; out: string; err: string };
export const defaultRunner: Runner = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: env ?? process.env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  return { ok: r.status === 0 && !r.error, out: r.stdout ?? "", err: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
};

/** A secret from this Mac's Keychain (service prevail-<id>) or the environment; never written anywhere. */
export function keychainSecret(service: string, run: Runner = defaultRunner): string | null {
  const env = process.env[service.toUpperCase().replace(/[^A-Z0-9]/g, "_")];
  if (env) return env;
  const r = run("/usr/bin/security", ["find-generic-password", "-s", service, "-w"]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

export const hashWho = (addr: string) => createHash("sha256").update(`prevail:${addr.trim().toLowerCase()}`).digest("hex").slice(0, 12);

const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** Rewrite this host's month files of one source for the months its events cover (and the current one). */
export function writeSourceEvents(vault: string, id: string, events: MetricEvent[], host: string, now: number, src = id): number {
  const dir = eventsDirFor(vault, id, src);
  const months = new Set(events.map((e) => e.ts.slice(0, 7)));
  months.add(monthKey(new Date(now)));
  let n = 0;
  for (const m of months) {
    const rows = events.filter((e) => e.ts.startsWith(m)).sort((a, b) => a.ts.localeCompare(b.ts) || a.kind.localeCompare(b.kind) || (a.project ?? "").localeCompare(b.project ?? ""));
    const file = join(dir, `${m}.${host}.jsonl`);
    if (!rows.length && !existsSync(file)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, rows.map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : ""));
    renameSync(`${file}.tmp`, file);
    n += rows.length;
  }
  return n;
}

/** Events per (day, kind, project): sums n and numeric attrs. */
export class EventBag {
  private by = new Map<string, MetricEvent>();
  constructor(private src: string, private host: string, private tier: MetricEvent["tier"] = "measured") {}
  add(day: string, kind: string, opts: { project?: string; n?: number; attrs?: Record<string, number>; tier?: MetricEvent["tier"] } = {}): void {
    const k = `${day}\t${kind}\t${opts.project ?? ""}`;
    const e = this.by.get(k) ?? { ts: day, src: this.src, kind, n: 0, ...(opts.project ? { project: opts.project } : {}), host: this.host, tier: opts.tier ?? this.tier, attrs: {} };
    e.n += opts.n ?? 1;
    for (const [a, v] of Object.entries(opts.attrs ?? {})) e.attrs[a] = Math.round((Number(e.attrs[a] ?? 0) + v) * 100) / 100;
    this.by.set(k, e);
  }
  events(): MetricEvent[] { return [...this.by.values()]; }
}

// ── Google accounts through gws ─────────────────────────────────────────────

export interface GoogleAccountRef { label: string; env: NodeJS.ProcessEnv }

async function googleAccounts(): Promise<{ gws: string | null; accounts: GoogleAccountRef[] }> {
  const cs = await import("./calendar-sync.ts");
  const gws = cs.resolveGwsBinary();
  const profiles = cs.listGwsProfiles();
  return { gws, accounts: profiles.map((p) => ({ label: p.label, env: cs.gwsSpawnEnv(p.label) })) };
}

/** A gws failure as a short, honest class: what is wrong and who can fix it. */
export function classifyGoogleError(text: string): string {
  if (/disabled_client/i.test(text)) return "the Google sign-in client Prevail uses is disabled (Google Cloud); sign in with a new client";
  if (/Account Restricted|servicerestricted/i.test(text)) return "Google restricted this account's Cloud access; appeal at accounts.google.com/info/servicerestricted";
  if (/invalid_grant|expired|revoked/i.test(text)) return "sign-in expired; sign in again";
  if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(text)) return "this account did not grant read access for this service";
  if (/SERVICE_DISABLED|accessNotConfigured/i.test(text)) return "the API is disabled on the Google Cloud project";
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "failed";
}

function gwsJson(run: Runner, gws: string, args: string[], env: NodeJS.ProcessEnv): { ok: true; json: Record<string, unknown> } | { ok: false; error: string } {
  const r = run(gws, args, env);
  let json: Record<string, unknown> | null = null;
  try { const i = r.out.indexOf("{"); json = i >= 0 ? (JSON.parse(r.out.slice(i)) as Record<string, unknown>) : null; } catch { json = null; }
  if (!r.ok || !json || "error" in json) {
    const msg = json && typeof json.error === "object" ? String((json.error as { message?: string }).message ?? "") : "";
    return { ok: false, error: classifyGoogleError(`${msg} ${r.err} ${r.out.slice(0, 400)}`) };
  }
  return { ok: true, json };
}

// ── Gmail headers ───────────────────────────────────────────────────────────

export interface MailHeader {
  id: string; thread: string; ts: number; account: string;
  dir: "sent" | "received";
  from: string; to: string[]; cc: string[];
  subject: string; in_reply_to?: string; labels: string[];
}

const ADDR = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const addrs = (s: string | undefined) => [...new Set((s ?? "").match(ADDR)?.map((a) => a.toLowerCase()) ?? [])];

export function mailDir(vault: string): string { return join(runtimePath(vault, "_meta"), "mail"); }
const acctSlug = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";

/** Every header kept on this Mac (all accounts), oldest first. Readers in other plans use this. */
export function readMailHeaders(vault: string): MailHeader[] {
  const dir = mailDir(vault);
  const out: MailHeader[] = [];
  let fs: string[] = [];
  try { fs = readdirSync(dir).filter((f) => f.startsWith("headers.") && f.endsWith(".jsonl")); } catch { return out; }
  const seen = new Set<string>();
  for (const f of fs) for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!l) continue;
    try { const h = JSON.parse(l) as MailHeader; const k = `${h.account}\t${h.id}`; if (!seen.has(k)) { seen.add(k); out.push(h); } } catch { /* skip */ }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** A metadata message (users.messages.get format=metadata) as a header record. */
export function headerOf(msg: Record<string, unknown>, account: string, self: Set<string>): MailHeader | null {
  const id = String(msg.id ?? "");
  if (!id) return null;
  const hs = ((msg.payload as { headers?: { name: string; value: string }[] } | undefined)?.headers ?? []);
  const h = (n: string) => hs.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const labels = Array.isArray(msg.labelIds) ? (msg.labelIds as string[]) : [];
  const ts = Number(msg.internalDate ?? 0) || Date.parse(h("Date")) || 0;
  const from = addrs(h("From"))[0] ?? "";
  const sent = labels.includes("SENT") || self.has(from);
  return { id, thread: String(msg.threadId ?? id), ts, account, dir: sent ? "sent" : "received", from, to: addrs(h("To")), cc: addrs(h("Cc")), subject: h("Subject").slice(0, 200), ...(h("In-Reply-To") ? { in_reply_to: h("In-Reply-To").slice(0, 200) } : {}), labels };
}

// Hiring systems and recruiting addresses: a sent application or its confirmation.
const HIRING = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkday(jobs|site)?\.com|workday\.com|smartrecruiters\.com|jobvite\.com|icims\.com|workable\.com|recruitee\.com|bamboohr\.com|teamtailor\.com|rippling\.com|wellfound\.com|hired\.com)$/i;
const APPLIED = /(application (received|submitted)|thank(s| you) for (applying|your application|your interest)|we('ve| have) received your application|your application (to|for))/i;
export function isJobApplication(h: MailHeader): boolean {
  const doms = [h.from, ...h.to].map((a) => a.split("@")[1] ?? "");
  if (h.dir === "received") return doms.slice(0, 1).some((d) => HIRING.test(d)) && APPLIED.test(h.subject);
  return doms.slice(1).some((d) => HIRING.test(d) || /^(jobs|careers|recruiting|talent|hiring)\./.test(d)) || /^(jobs|careers|recruiting|talent)@/.test(h.to[0] ?? "");
}

// Machines are not people: no-reply and notification senders are not counted as people.
const ROBOT = /^(no-?reply|noreply|do-?not-?reply|notifications?|notify|mailer-daemon|bounces?|postmaster|alerts?|updates?|news(letter)?)\b/i;
const person = (a: string) => !ROBOT.test(a.split("@")[0] ?? "");
const BULK = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"];

/**
 * Header records to events: sent, received (personal mail, not promotions,
 * social, updates or forums), replies you got to threads you wrote in, your
 * own reply times (minutes from their message to your answer), people you
 * exchanged mail with (hashed), and job applications (inferred).
 */
export function mailEvents(headers: MailHeader[], host: string): MetricEvent[] {
  const bag = new EventBag("gmail", host);
  const byThread = new Map<string, MailHeader[]>();
  for (const h of headers) { const k = `${h.account}\t${h.thread}`; (byThread.get(k) ?? byThread.set(k, []).get(k)!).push(h); }
  for (const msgs of byThread.values()) {
    msgs.sort((a, b) => a.ts - b.ts);
    msgs.forEach((h, i) => {
      if (!h.ts) return;
      const day = dayOf(h.ts);
      const prev = msgs[i - 1];
      if (h.dir === "sent") {
        bag.add(day, "email.sent");
        for (const a of new Set([...h.to, ...h.cc])) if (person(a)) bag.add(day, "email.person", { project: hashWho(a) });
        if (prev && prev.dir === "received") bag.add(day, "email.replied", { attrs: { minutes: Math.max(0, Math.round((h.ts - prev.ts) / 60_000)) } });
        if (isJobApplication(h)) bag.add(day, "email.job_application", { tier: "inferred" });
      } else {
        if (h.labels.some((l) => BULK.includes(l))) return;
        bag.add(day, "email.received");
        if (h.from && person(h.from)) bag.add(day, "email.person", { project: hashWho(h.from) });
        if (msgs.slice(0, i).some((m) => m.dir === "sent")) bag.add(day, "email.reply");
        if (isJobApplication(h)) bag.add(day, "email.job_application", { tier: "inferred" });
      }
    });
  }
  return bag.events();
}

const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "In-Reply-To", "Message-ID"];
const GETS_PER_RUN = 400;

export async function syncGmail(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const run = opts.run ?? defaultRunner;
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const { gws, accounts } = opts.google ?? (await googleAccounts());
  if (!gws) return { state: "needs-connection", note: "the Google Workspace CLI (gws) is not installed on this Mac" };
  if (!accounts.length) return { state: "needs-connection", note: "no Google account is signed in for Prevail on this Mac" };
  const days = opts.backfill ? 180 : 30;
  const have = new Set(readMailHeaders(vault).map((h) => `${h.account}\t${h.id}`));
  const status: Record<string, string> = {};
  let fetched = 0;
  mkdirSync(mailDir(vault), { recursive: true });
  for (const acct of accounts) {
    const prof = gwsJson(run, gws, ["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })], acct.env);
    if (!prof.ok) { status[acct.label] = prof.error; continue; }
    const self = new Set([String(prof.json.emailAddress ?? "").toLowerCase()].filter(Boolean));
    const ids: string[] = [];
    let page: string | undefined;
    for (let p = 0; p < 20; p++) {
      const l = gwsJson(run, gws, ["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: "me", q: `newer_than:${days}d`, maxResults: 500, ...(page ? { pageToken: page } : {}) })], acct.env);
      if (!l.ok) { status[acct.label] = l.error; break; }
      for (const m of (l.json.messages as { id: string }[] | undefined) ?? []) ids.push(m.id);
      page = typeof l.json.nextPageToken === "string" ? l.json.nextPageToken : undefined;
      if (!page) break;
    }
    const want = ids.filter((id) => !have.has(`${acct.label}\t${id}`));
    const file = join(mailDir(vault), `headers.${acctSlug(acct.label)}.jsonl`);
    let n = 0;
    for (const id of want) {
      if (fetched >= GETS_PER_RUN) break;
      const g = gwsJson(run, gws, ["gmail", "users", "messages", "get", "--params", JSON.stringify({ userId: "me", id, format: "metadata", metadataHeaders: META_HEADERS })], acct.env);
      fetched++;
      if (!g.ok) { status[acct.label] = g.error; break; }
      const h = headerOf(g.json, acct.label, self);
      if (h) { appendFileSync(file, `${JSON.stringify(h)}\n`); n++; }
    }
    status[acct.label] ??= `ok: ${n} new of ${ids.length} in ${days} days${want.length > n ? `, ${want.length - n} next run` : ""}`;
  }
  const headers = readMailHeaders(vault);
  const events = mailEvents(headers.filter((h) => h.ts >= now - 400 * 86_400_000), host);
  const written = writeSourceEvents(vault, "gmail", events, host, now);
  const okAny = Object.values(status).some((s) => s.startsWith("ok"));
  return { state: okAny ? "ok" : "auth-failed", events: written, accounts: status, ...(okAny ? {} : { note: Object.values(status)[0] }) };
}

// ── Calendar ────────────────────────────────────────────────────────────────

export interface CalEvent { id: string; account: string; calendar: string; title: string; start: string; end: string; all_day: boolean; attendees: number; self_response?: string; focus?: boolean; recurring?: boolean }

export function calendarDir(vault: string): string { return join(runtimePath(vault, "_meta"), "calendar"); }

/** Every calendar event kept on this Mac (all accounts). Today, missions and the time review read this. */
export function readCalendarEvents(vault: string): CalEvent[] {
  const dir = calendarDir(vault);
  let fs: string[] = [];
  try { fs = readdirSync(dir).filter((f) => f.startsWith("events.") && f.endsWith(".json")); } catch { return []; }
  return fs.flatMap((f) => { try { return (JSON.parse(readFileSync(join(dir, f), "utf8")) as { events: CalEvent[] }).events ?? []; } catch { return []; } }).sort((a, b) => a.start.localeCompare(b.start));
}

export function calEventOf(it: Record<string, unknown>, account: string, calendar: string): CalEvent | null {
  const start = it.start as { date?: string; dateTime?: string } | undefined;
  const end = it.end as { date?: string; dateTime?: string } | undefined;
  if (!start || it.status === "cancelled") return null;
  const atts = Array.isArray(it.attendees) ? (it.attendees as { self?: boolean; responseStatus?: string; resource?: boolean }[]) : [];
  const self = atts.find((a) => a.self);
  return {
    id: String(it.id ?? ""), account, calendar,
    title: String(it.summary ?? "").slice(0, 160),
    start: start.dateTime ?? start.date ?? "", end: end?.dateTime ?? end?.date ?? start.dateTime ?? start.date ?? "",
    all_day: !start.dateTime, attendees: atts.filter((a) => !a.self && !a.resource).length,
    ...(self?.responseStatus ? { self_response: self.responseStatus } : {}),
    ...(it.eventType === "focusTime" ? { focus: true } : {}),
    ...(it.recurringEventId ? { recurring: true } : {}),
  };
}

const FOCUS = /\b(focus|deep work|heads[ -]down|no meetings|maker time|writing block|build time)\b/i;
const FAMILY = /\b(family|kids?|son|daughter|wife|husband|partner|mom|dad|parents|date night|dinner at home|school|recital|birthday|anniversary|church|mass)\b/i;

/** Hours per day: meetings (with at least one other person, not declined), focus blocks, meetings outside 8:00 to 18:00 or on weekends, family time (inferred from titles and calendar names). */
export function calendarMetricEvents(evs: CalEvent[], host: string, nowMs: number): MetricEvent[] {
  const bag = new EventBag("calendar", host);
  for (const e of evs) {
    if (e.all_day || e.self_response === "declined") continue;
    const s = Date.parse(e.start); const en = Date.parse(e.end);
    if (!(en > s) || s > nowMs) continue;
    const hours = Math.min(12, (en - s) / 3_600_000);
    const day = dayOf(s);
    const d = new Date(s);
    if (e.attendees > 0) {
      bag.add(day, "cal.meeting", { attrs: { hours } });
      const h = d.getHours() + d.getMinutes() / 60;
      if (h < 8 || h >= 18 || d.getDay() === 0 || d.getDay() === 6) bag.add(day, "cal.after_hours", { attrs: { hours } });
    }
    if (e.focus || FOCUS.test(e.title)) bag.add(day, "cal.focus", { attrs: { hours } });
    if (FAMILY.test(e.title) || /family|home|kids/i.test(e.calendar)) bag.add(day, "cal.family", { attrs: { hours }, tier: "inferred" });
  }
  return bag.events();
}

export async function syncCalendar(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const run = opts.run ?? defaultRunner;
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const { gws, accounts } = opts.google ?? (await googleAccounts());
  if (!gws) return { state: "needs-connection", note: "the Google Workspace CLI (gws) is not installed on this Mac" };
  if (!accounts.length) return { state: "needs-connection", note: "no Google account is signed in for Prevail on this Mac" };
  const back = opts.backfill ? 365 : 90;
  const timeMin = new Date(now - back * 86_400_000).toISOString();
  const timeMax = new Date(now + 60 * 86_400_000).toISOString();
  const status: Record<string, string> = {};
  mkdirSync(calendarDir(vault), { recursive: true });
  for (const acct of accounts) {
    const cl = gwsJson(run, gws, ["calendar", "calendarList", "list", "--params", JSON.stringify({ maxResults: 50 })], acct.env);
    if (!cl.ok) { status[acct.label] = cl.error; continue; }
    const cals = ((cl.json.items as { id: string; summary?: string; selected?: boolean; accessRole?: string }[] | undefined) ?? []).filter((c) => c.selected !== false && c.accessRole !== "freeBusyReader").slice(0, 12);
    const out: CalEvent[] = [];
    for (const c of cals) {
      let page: string | undefined;
      for (let p = 0; p < 10; p++) {
        const r = gwsJson(run, gws, ["calendar", "events", "list", "--params", JSON.stringify({ calendarId: c.id, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 2500, ...(page ? { pageToken: page } : {}) })], acct.env);
        if (!r.ok) break;
        for (const it of (r.json.items as Record<string, unknown>[] | undefined) ?? []) { const e = calEventOf(it, acct.label, c.summary ?? c.id); if (e) out.push(e); }
        page = typeof r.json.nextPageToken === "string" ? r.json.nextPageToken : undefined;
        if (!page) break;
      }
    }
    const p = join(calendarDir(vault), `events.${acctSlug(acct.label)}.json`);
    writeFileSync(`${p}.tmp`, `${JSON.stringify({ ts: new Date(now).toISOString(), from: timeMin, to: timeMax, events: out }, null, 1)}\n`);
    renameSync(`${p}.tmp`, p);
    status[acct.label] = `ok: ${out.length} events from ${cals.length} calendars`;
  }
  const events = calendarMetricEvents(readCalendarEvents(vault), host, now);
  const written = writeSourceEvents(vault, "calendar", events, host, now);
  const okAny = Object.values(status).some((s) => s.startsWith("ok"));
  return { state: okAny ? "ok" : "auth-failed", events: written, accounts: status, ...(okAny ? {} : { note: Object.values(status)[0] }) };
}

// ── GitHub through gh ───────────────────────────────────────────────────────

export function githubEvents(items: Record<string, unknown>[], host: string): MetricEvent[] {
  const bag = new EventBag("github", host);
  for (const it of items) {
    const repo = String(it.repository_url ?? "").split("/").pop() || undefined;
    const isPr = !!it.pull_request;
    const created = Date.parse(String(it.created_at ?? ""));
    if (created) bag.add(dayOf(created), isPr ? "gh.pr_opened" : "gh.issue_opened", { project: repo });
    const merged = Date.parse(String((it.pull_request as { merged_at?: string } | undefined)?.merged_at ?? ""));
    if (isPr && merged) bag.add(dayOf(merged), "gh.pr_merged", { project: repo });
  }
  return bag.events();
}

export async function syncGithub(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const run = opts.run ?? defaultRunner;
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const auth = run("gh", ["auth", "status"]);
  if (!auth.ok) return { state: "needs-connection", note: "gh is not signed in on this Mac (gh auth login)" };
  const since = dayOf(now - (opts.backfill ? 365 : 120) * 86_400_000);
  const items: Record<string, unknown>[] = [];
  for (const q of [`author:@me type:pr created:>=${since}`, `author:@me type:issue created:>=${since}`]) {
    for (let page = 1; page <= 10; page++) {
      const r = run("gh", ["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=100", "-f", `page=${page}`]);
      if (!r.ok) return { state: "failed", note: (r.err || r.out).replace(/\s+/g, " ").slice(0, 160) };
      let j: { items?: Record<string, unknown>[] } = {};
      try { j = JSON.parse(r.out); } catch { break; }
      items.push(...(j.items ?? []));
      if ((j.items ?? []).length < 100) break;
    }
  }
  const events = githubEvents(items, host);
  return { state: "ok", events: writeSourceEvents(vault, "github", events, host, now), note: `${items.length} pull requests and issues since ${since}` };
}

// ── YouTube channel analytics (a token the user put in the Keychain) ────────

/** reports.query rows (dimension day) to events: views, watch minutes, subscribers gained and lost. */
export function youtubeEvents(report: { columnHeaders?: { name: string }[]; rows?: (string | number)[][] }, published: string[], host: string): MetricEvent[] {
  const bag = new EventBag("youtube", host);
  const cols = (report.columnHeaders ?? []).map((c) => c.name);
  const at = (n: string) => cols.indexOf(n);
  for (const r of report.rows ?? []) {
    const day = String(r[at("day")] ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const views = Number(r[at("views")] ?? 0);
    bag.add(day, "yt.views", { n: views, attrs: { minutes: Number(r[at("estimatedMinutesWatched")] ?? 0) } });
    const net = Number(r[at("subscribersGained")] ?? 0) - Number(r[at("subscribersLost")] ?? 0);
    bag.add(day, "yt.subscribers", { n: 1, attrs: { net } });
  }
  for (const p of published) { const d = Date.parse(p); if (d) bag.add(dayOf(d), "yt.published"); }
  return bag.events();
}

export async function syncYoutube(vault: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const token = (opts.secret ?? ((s: string) => keychainSecret(s, opts.run)))("prevail-youtube");
  if (!token) return { state: "needs-connection", note: sourceDef("youtube")!.connect };
  const f = opts.fetch ?? fetch;
  const start = dayOf(now - (opts.backfill ? 365 : 90) * 86_400_000);
  const end = dayOf(now);
  const h = { Authorization: `Bearer ${token}` };
  const rep = await f(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views,estimatedMinutesWatched,subscribersGained,subscribersLost&dimensions=day&sort=day`, { headers: h });
  if (!rep.ok) return { state: rep.status === 401 ? "auth-failed" : "failed", note: `YouTube Analytics answered ${rep.status}` };
  const report = (await rep.json()) as Parameters<typeof youtubeEvents>[0];
  const vids = await f(`https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&maxResults=50&order=date&publishedAfter=${start}T00:00:00Z`, { headers: h });
  const published = vids.ok ? (((await vids.json()) as { items?: { snippet?: { publishedAt?: string } }[] }).items ?? []).map((v) => v.snippet?.publishedAt ?? "").filter(Boolean) : [];
  const events = youtubeEvents(report, published, host);
  return { state: "ok", events: writeSourceEvents(vault, "youtube", events, host, now) };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export const READERS: Record<string, Reader> = { gmail: syncGmail, calendar: syncCalendar, github: syncGithub, youtube: syncYoutube };

/** Register more readers (waves 3 and 4) without a circular import. */
export function registerReaders(more: Record<string, Reader>): void { Object.assign(READERS, more); }

/** Run one source's reader on this Mac, if the user allowed it; records the outcome. */
export async function syncSource(vault: string, id: string, opts: SyncOpts = {}): Promise<SyncResult> {
  if (!sourceDef(id)) return { state: "unknown source" };
  await import("./source-files.ts").then((m) => m.register()).catch(() => undefined);
  await import("./source-mac.ts").then((m) => m.register()).catch(() => undefined);
  let r: SyncResult;
  try {
    requireConsent(vault, id);
    const reader = READERS[id];
    r = reader ? await reader(vault, opts) : { state: "no reader on this Mac" };
  } catch (e) {
    r = e instanceof ConsentError ? { state: "off", note: "turn it on in Sources" } : { state: "failed", note: String((e as Error).message ?? e).slice(0, 200) };
  }
  if (r.state !== "off") recordSourceState(vault, id, { state: r.state, ...(r.note ? { note: r.note } : {}), ...(r.events !== undefined ? { events: r.events } : {}) });
  return r;
}

// How often each source is read when its turn comes (the capture sync runs every 30 minutes).
const EVERY_H: Record<string, number> = { gmail: 1, calendar: 1, github: 6, youtube: 24, plaid: 24, "apple-health": 24, timeline: 24, oura: 12, strava: 12, garmin: 24, photos: 24, messages: 6, calls: 6, "browser-topics": 168, "writing-themes": 168 };

/** Run every allowed source whose last sync is older than its interval. Never throws. */
export async function syncDue(vault: string, opts: SyncOpts = {}): Promise<Record<string, string>> {
  const { listSources } = await import("./sources.ts");
  const now = opts.now ?? Date.now();
  const out: Record<string, string> = {};
  for (const s of listSources(vault)) {
    const every = EVERY_H[s.id];
    if (!every || !s.on) continue;
    if (s.last_sync && now - Date.parse(s.last_sync) < every * 3_600_000) continue;
    try { out[s.id] = (await syncSource(vault, s.id, opts)).state; } catch (e) { out[s.id] = `failed: ${String(e).slice(0, 80)}`; }
  }
  return out;
}
