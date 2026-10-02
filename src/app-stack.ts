// The stack: every app the user uses, what it is used for and from where.
// Apps plan A2 (records, usage, unknown inbox) and the command `prevail apps
// scan|usage|unknown|map|records`. Money (A3) and the doctor (A4) build on the
// per-app usage computed here.
//
// Usage per app comes from the events every Mac writes (app focus minutes,
// Spotlight last-used, web domain visits, AI sessions), merged across hosts
// and mapped to app ids by app-map.ts. Computed values are cached in
// build/_meta/apps/usage.json and unknown.json (machine-managed).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMatcher, correctSignal, KNOWN_APPS, readRecords, slugApp, upsertRecord, type AppKind, type SignalKind } from "./app-map.ts";
import { readInventory, scanAppUsage, type InstalledApp } from "./app-usage.ts";
import { dayOf, readMachineEvents, type MetricEvent } from "./metrics.ts";
import { runtimePath } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";
import { recordSourceState } from "./sources.ts";
import { cardCharges, detectSeries, moneyScan, readUnknownMerchants, type MoneyScan } from "./app-money.ts";

const AI_TOOLS: Record<string, string> = { claude: "anthropic", codex: "openai", antigravity: "google", opencode: "opencode", cursor: "cursor", hermes: "hermes", aionui: "aionui", wispr: "wispr-flow" };
const DAY = 86_400_000;

export interface AppUsage {
  id: string;
  active_days: { d7: number; d30: number; d90: number };
  minutes_30d: number;
  device_minutes_30d: Record<string, number>;
  web_visits_30d: number;
  ai_sessions_30d: number;
  last_used?: string;
  /** The first day of real use in the window (focus, web or AI; a Spotlight last-used date alone says nothing about when it started). */
  first_seen?: string;
  /** First seen in this Mac's inventory after the baseline. */
  installed?: string;
  trend: "up" | "down" | "flat" | "new";
  signals: { kind: SignalKind | "ai"; value: string }[];
  hosts: string[];
}

export interface UnknownSignal { kind: SignalKind; value: string; days: number; last: string; n: number; suggestion?: string }

export interface UsageModel { ts: number; apps: Record<string, AppUsage>; unknown: UnknownSignal[]; days: string[] }

const isApple = (b: string) => b.startsWith("com.apple.");

/** Map every usage event of the last 90 days to apps; unmatched signals become the unknown inbox. */
export function computeUsage(vault: string, opts: { now?: number; events?: MetricEvent[] } = {}): UsageModel {
  const now = opts.now ?? Date.now();
  const from = dayOf(now - 90 * DAY);
  const d30 = dayOf(now - 30 * DAY);
  const d7 = dayOf(now - 7 * DAY);
  const d60 = dayOf(now - 60 * DAY);
  const events = opts.events ?? readMachineEvents(vault, from).events;
  const m = buildMatcher(vault);
  const apps = new Map<string, AppUsage & { _days: Set<string>; _prev: Set<string>; _sig: Set<string>; _hosts: Set<string> }>();
  const unknown = new Map<string, UnknownSignal & { _days: Set<string> }>();
  const get = (id: string) => {
    let a = apps.get(id);
    if (!a) { a = { id, active_days: { d7: 0, d30: 0, d90: 0 }, minutes_30d: 0, device_minutes_30d: {}, web_visits_30d: 0, ai_sessions_30d: 0, trend: "flat", signals: [], hosts: [], _days: new Set(), _prev: new Set(), _sig: new Set(), _hosts: new Set() }; apps.set(id, a); }
    return a;
  };
  const touch = (id: string, e: MetricEvent, kind: SignalKind | "ai", value: string) => {
    const a = get(id);
    if (e.ts >= from) a._days.add(e.ts);
    if (e.kind !== "app.last_used" && (!a.first_seen || e.ts < a.first_seen)) a.first_seen = e.ts;
    if (typeof e.attrs.installed === "string" && (!a.installed || e.attrs.installed < a.installed)) a.installed = e.attrs.installed;
    if (e.ts >= d60 && e.ts < d30) a._prev.add(e.ts);
    if (!a.last_used || e.ts > a.last_used) a.last_used = e.ts;
    a._hosts.add(e.host);
    const sk = `${kind}\t${value}`;
    if (!a._sig.has(sk)) { a._sig.add(sk); a.signals.push({ kind, value }); }
    return a;
  };
  const miss = (kind: SignalKind, value: string, e: MetricEvent) => {
    if (m.ignored(kind, value)) return;
    const k = `${kind}\t${value}`;
    const u = unknown.get(k) ?? { kind, value, days: 0, last: e.ts, n: 0, _days: new Set() };
    u._days.add(e.ts); u.n += e.n; if (e.ts > u.last) u.last = e.ts;
    unknown.set(k, u);
  };
  for (const e of events) {
    if (e.ts < from) continue;
    if (e.src === "apps" && e.project) {
      const id = m.match("bundle", e.project);
      if (!id) { if (!isApple(e.project)) miss("bundle", e.project, e); continue; }
      const a = touch(id, e, "bundle", e.project);
      if (e.kind === "app.focus" && e.ts >= d30) {
        const min = Number(e.attrs.minutes ?? 0);
        a.minutes_30d += min;
        const dev = String(e.attrs.device ?? "mac");
        a.device_minutes_30d[dev] = Math.round(((a.device_minutes_30d[dev] ?? 0) + min) * 10) / 10;
      }
    } else if (e.src === "web" && e.project) {
      const id = m.match("domain", e.project);
      if (!id) { miss("domain", e.project, e); continue; }
      const a = touch(id, e, "domain", e.project);
      if (e.ts >= d30) a.web_visits_30d += e.n;
    } else if (AI_TOOLS[e.src] && e.kind === "ai.session") {
      const a = touch(AI_TOOLS[e.src]!, e, "ai", e.src);
      if (e.ts >= d30) a.ai_sessions_30d += Number(e.attrs.sessions ?? e.n) || e.n;
    }
  }
  const out: Record<string, AppUsage> = {};
  for (const a of apps.values()) {
    const days = [...a._days];
    a.active_days = { d7: days.filter((d) => d >= d7).length, d30: days.filter((d) => d >= d30).length, d90: days.length };
    a.trend = a._prev.size === 0 ? (a.active_days.d30 ? "new" : "flat") : a.active_days.d30 > a._prev.size * 1.25 ? "up" : a.active_days.d30 < a._prev.size * 0.75 ? "down" : "flat";
    a.minutes_30d = Math.round(a.minutes_30d);
    a.hosts = [...a._hosts].sort();
    const { _days, _prev, _sig, _hosts, ...rest } = a;
    out[a.id] = rest;
  }
  // The inbox: a domain on 3+ days in 30, any unmatched third-party app; most days first.
  const records = readRecords(vault);
  const inbox = [...unknown.values()]
    .map(({ _days, ...u }) => ({ ...u, days: [..._days].filter((d) => d >= d30).length }))
    .filter((u) => (u.kind === "domain" ? u.days >= 3 : u.days >= 1))
    .map((u) => { const s = suggestFor(u.value, records.map((r) => ({ id: r.id, name: r.name }))); return s ? { ...u, suggestion: s } : u; })
    .sort((a, b) => b.days - a.days || b.n - a.n)
    .slice(0, 100);
  const daySet = new Set<string>();
  for (const e of events) if (e.src === "apps" || e.src === "web") daySet.add(e.ts);
  return { ts: now, apps: out, unknown: inbox, days: [...daySet].sort() };
}

/** A code-only suggestion (no model): an existing record whose id or name is a word of the signal. */
export function suggestFor(value: string, records: { id: string; name: string }[]): string | undefined {
  const words = new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  return records.find((r) => words.has(r.id) || words.has(r.name.toLowerCase().replace(/[^a-z0-9]/g, "")))?.id;
}

export interface RecordsResult { created: string[]; updated: string[]; archived_seen: string[] }

/**
 * App records for every vendor seen: each matched app with an active day in
 * 90, and each third-party Mac app the user opened (Spotlight last used or
 * focus time) in 90 days. Existing records gain identifiers only; archived
 * apps are never recreated (they are reported as seen again).
 */
export function ensureRecords(vault: string, usage: UsageModel, inventory: InstalledApp[], opts: { now?: number } = {}): RecordsResult {
  const now = opts.now ?? Date.now();
  const res: RecordsResult = { created: [], updated: [], archived_seen: [] };
  const m = buildMatcher(vault);
  const records = new Map(readRecords(vault).map((r) => [r.id, r]));
  const note = (id: string, r: ReturnType<typeof upsertRecord>) => { if (r === "created") res.created.push(id); else if (r === "updated") res.updated.push(id); else if (r === "archived") res.archived_seen.push(id); };
  const field: Record<string, string> = { bundle: "bundle_ids", domain: "domains", ai: "binaries" };
  for (const a of Object.values(usage.apps)) {
    if (!a.active_days.d90) continue;
    const known = KNOWN_APPS.find((k) => k.id === a.id);
    const rec = records.get(a.id);
    if (rec?.archived) { res.archived_seen.push(a.id); continue; }
    const identifiers: Record<string, string[]> = {};
    for (const s of a.signals) if (s.kind !== "ai") (identifiers[field[s.kind]!] ??= []).push(s.value);
    const surfaces: string[] = [...new Set(a.signals.map((s) => (s.kind === "bundle" ? "mac" : s.kind === "domain" ? "web" : "cli")))];
    if (Object.keys(a.device_minutes_30d).some((d) => d !== "mac")) surfaces.push("phone");
    note(a.id, upsertRecord(vault, { id: a.id, name: known?.name ?? rec?.name ?? a.id, kind: known?.kind, category: known?.category, surfaces, identifiers, found_by: `seen in use (${surfaces.join(", ")})`, first_seen: a.first_seen }));
  }
  const cutoff = dayOf(now - 90 * DAY);
  for (const app of inventory) {
    if (isApple(app.bundle) || m.match("bundle", app.bundle) || m.ignored("bundle", app.bundle)) continue;
    const used = (app.last_used && app.last_used >= cutoff) || usage.unknown.some((u) => u.kind === "bundle" && u.value === app.bundle);
    if (!used) continue;
    let id = slugApp(app.name);
    const clash = records.get(id);
    if (clash && !(clash.identifiers.bundle_ids ?? []).includes(app.bundle) && clash.identifiers.bundle_ids?.length) id = slugApp(`${app.name} app`);
    const kind: AppKind = "app";
    note(id, upsertRecord(vault, { id, name: app.name, kind, category: (app.category ?? "other").toLowerCase().replace(/[^a-z0-9]+/g, "-"), surfaces: ["mac"], identifiers: { bundle_ids: [app.bundle] }, found_by: "Spotlight: installed and opened in the last 90 days" }));
  }
  return res;
}

function writeCache(vault: string, name: string, v: unknown): void {
  const dir = join(runtimePath(vault, "_meta"), "apps");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(`${p}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

export interface AppsScan { usage: ReturnType<typeof scanAppUsage>; records: RecordsResult; unknown: number; apps: number; money: MoneyScan | null }

/** The A2 pass: read this Mac's signals, create records for vendors seen, refresh the unknown inbox. */
export function appsScan(vault: string, opts: { now?: number; records?: boolean; consent?: (id: string) => boolean } = {}): AppsScan {
  const usage = scanAppUsage(vault, { now: opts.now, consent: opts.consent });
  const model = computeUsage(vault, { now: opts.now });
  const records = opts.records === false ? { created: [], updated: [], archived_seen: [] } : ensureRecords(vault, model, readInventory(vault, usage.host), { now: opts.now });
  // Each usage source's state, for the Sources screen.
  const st = usage.sources;
  const pick = (a?: { state: string; note?: string; events?: number }, b?: { state: string; note?: string }) => (a?.state === "ok" || !b ? a : b.state === "ok" ? b : a);
  const states: Record<string, { state: string; note?: string; events?: number } | undefined> = { spotlight: st.spotlight, browsers: st.browsers?.state === "ok" && st.safari?.state === "needs-fda" ? { ...st.browsers, note: `${st.browsers.note ?? ""}; Safari needs Full Disk Access`.replace(/^; /, "") } : st.browsers, screentime: pick(st.screentime, st.knowledgec), "live-focus": st["live-focus"] };
  for (const [id, v] of Object.entries(states)) if (v && v.state !== "off") recordSourceState(vault, id, { state: v.state, ...(v.note ? { note: v.note } : {}), ...(v.events !== undefined ? { events: v.events } : {}) });
  writeCache(vault, "usage.json", { ts: new Date(model.ts).toISOString(), apps: model.apps });
  writeCache(vault, "unknown.json", { ts: new Date(model.ts).toISOString(), unknown: model.unknown });
  // Money onto the records (A3): card series, Plaid, lifecycle mail.
  let money: MoneyScan | null = null;
  try { money = moneyScan(vault, { now: opts.now, host: usage.host }); } catch { money = null; }
  return { usage, records, unknown: model.unknown.length, apps: Object.keys(model.apps).length, money };
}

export async function appStackCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "usage";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    if (sub === "scan") {
      const { consented } = await import("./sources.ts");
      const r = appsScan(vault, { records: !args.has("no-records"), consent: (id) => consented(vault, id) });
      if (args.json) out(r);
      else {
        console.log(`${r.usage.installed} installed, ${r.usage.events.apps} app and ${r.usage.events.web} web events on ${r.usage.host} (${r.usage.ms} ms)`);
        for (const [k, v] of Object.entries(r.usage.sources)) console.log(`  ${k.padEnd(12)} ${v.state}${v.note ? `  (${v.note})` : ""}`);
        console.log(`${r.apps} apps in use; records created ${r.records.created.length}, updated ${r.records.updated.length}; ${r.unknown} unknown signals`);
      }
      return 0;
    }
    if (sub === "usage") {
      const u = computeUsage(vault);
      if (args.json) out(u.apps);
      else for (const a of Object.values(u.apps).sort((x, y) => y.active_days.d30 - x.active_days.d30)) console.log(`${a.id.padEnd(24)} ${String(a.active_days.d30).padStart(3)} days/30  ${String(a.minutes_30d).padStart(5)} min  ${a.trend}`);
      return 0;
    }
    if (sub === "unknown") {
      const u = computeUsage(vault);
      const all: (UnknownSignal & { freq?: string })[] = [...u.unknown, ...readUnknownMerchants(vault)];
      if (args.json) out(all);
      else for (const x of all) console.log(`${x.kind.padEnd(8)} ${x.value.padEnd(40)} ${x.days} days${x.suggestion ? `  maybe ${x.suggestion}` : ""}`);
      return 0;
    }
    if (sub === "map") {
      const [kind, value, target] = [args.pos[1], args.pos[2], args.pos[3]];
      if (!kind || !value || !target) { console.error("usage: prevail apps map bundle|domain|merchant|sender|binary <value> <app-id>|ignore"); return 1; }
      const r = correctSignal(vault, kind as SignalKind, value, target);
      if (args.json) out({ ok: true, ...r }); else console.log(r.ignored ? `Ignoring ${kind} ${value}.` : `${kind} ${value} is ${r.app} from now on.`);
      return 0;
    }
    if (sub === "money") {
      const r = moneyScan(vault);
      if (args.json) out(r); else console.log(`${r.series} recurring series (${r.matched} matched to apps, ${r.unmatched_recurring} to the inbox), ${r.lifecycle} lifecycle emails; ${r.updated.length} records updated; about $${r.monthly_total} a month`);
      return 0;
    }
    if (sub === "charges") {
      const m = (await import("./app-map.ts")).buildMatcher(vault);
      const s = detectSeries(cardCharges(vault), m).filter((x) => x.app || args.has("all"));
      const rows = s.map((x) => ({ app: x.app, freq: x.freq, last: x.last.date, usd: x.last.usd, next: x.next, mature: x.mature, charges: x.charges.length, price_changes: x.price_changes }));
      if (args.json) out(rows); else for (const r of rows) console.log(`${String(r.app).padEnd(20)} ${r.freq.padEnd(9)} $${r.usd}  last ${r.last}  next ${r.next}${r.mature ? "" : "  (new)"}`);
      return 0;
    }
    if (sub === "doctor") { const d = await import("./app-doctor.ts"); return d.appsDoctorCommand(argv, vault, args.json); }
    if (["stack", "cards", "card", "review", "offboard"].includes(sub)) {
      const d = await import("./app-doctor.ts");
      if (sub === "offboard") { const p = d.offboardingDraft(vault, args.pos[1] ?? ""); if (args.json) out({ ok: true, path: p }); else console.log(`Drafted ${p} (nothing was cancelled or sent).`); return 0; }
      const stack = d.buildStack(vault);
      const cards = d.visibleCards(d.detectCards(stack, Date.now()), d.readAnswers(vault), Date.now());
      if (sub === "stack") { if (args.json) out({ ...stack, cards }); else { console.log(`$${stack.month_total} a month known, ${stack.in_use} in use`); for (const a of stack.apps) console.log(`${a.name.padEnd(24)} ${String(a.usage?.active_days.d30 ?? 0).padStart(3)} days  ${a.monthly !== null ? `$${a.monthly}` : "-"}  ${a.health ?? ""}  ${a.verdict}`); } return 0; }
      if (sub === "cards") { if (args.json) out(cards); else for (const c of cards) console.log(`${c.key} ${c.kind.padEnd(10)} ${c.title}: ${c.why}`); return 0; }
      if (sub === "review") { const p = d.writeStackReview(vault, stack, cards); if (args.json) out({ ok: true, path: p, line: d.weeklyLine(cards, stack) }); else console.log(`Wrote ${p}`); return 0; }
      if (sub === "card") {
        const [key, ans] = [args.pos[1] ?? "", args.pos[2] ?? ""];
        const all = d.detectCards(stack, Date.now());
        const card = all.find((c) => c.key === key);
        if (!card) { console.error(`no card ${key}`); return 1; }
        const extra: Record<string, string> = {};
        if (ans === "cancel-steps") extra.draft = d.offboardingDraft(vault, card.app);
        if (ans === "archive") extra.archived = d.archiveRecord(vault, card.app);
        const a = d.answerCard(vault, key, ans);
        if (args.json) out({ ok: true, ...a, ...extra }); else console.log(`${card.title}: ${ans}${extra.draft ? ` (drafted ${extra.draft})` : ""}${extra.archived ? ` (moved to ${extra.archived})` : ""}`);
        return 0;
      }
    }
    if (sub === "records") {
      const recs = readRecords(vault).filter((r) => !r.archived);
      if (args.json) out(recs.map(({ manifest: _m, ...r }) => r));
      else for (const r of recs) console.log(`${r.id.padEnd(28)} ${(r.kind ?? "").padEnd(18)} ${r.category ?? ""}`);
      return 0;
    }
  } catch (e) {
    if (args.json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message);
    return 1;
  }
  console.error("usage: prevail apps scan | usage | unknown | map <kind> <value> <app-id|ignore> | records | money | charges [--all] | doctor | stack | cards | card <key> keep|snooze|done|review|fix|archive|cancel-steps | review | offboard <id> [--json]");
  return 1;
}

export const STACK_SUBCOMMANDS = ["scan", "usage", "unknown", "map", "records", "money", "charges", "doctor", "stack", "cards", "card", "review", "offboard"];
