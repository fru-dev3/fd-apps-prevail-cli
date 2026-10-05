// The connection doctor and the proactive stack (apps plan A4).
//
//   prevail doctor apps   every probe on this Mac: each CLI's --version, gh
//                         and gws sign-in, the AI adapters' shapes, capture
//                         gaps, connected sources' last sync, the connector
//                         mirror, and vendor status pages. Results go to
//                         build/_meta/apps/health.<host>.json with last_ok,
//                         first_fail, the class and the fix; version output
//                         and error text are compared with the last run to
//                         catch eligibility changes.
//   prevail apps stack    the stack view: every app with usage, what it
//                         costs, value, health and a verdict, plus what
//                         needs you.
//   prevail apps cards    the detection rules as cards: new, unused,
//                         duplicate, failing, renewal, price, trial, AI plan
//                         value. Broken capture may use the interruption
//                         budget (three a week); everything else waits for
//                         the weekly line and the monthly stack review.
//   prevail apps review   the monthly stack review page (numbers by code).
//   prevail apps offboard <id>   a drafted checklist, never an action.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { KNOWN_APPS, readRecords } from "./app-map.ts";
import { readUsageHealth } from "./app-usage.ts";
import { computeUsage, type AppUsage } from "./app-stack.ts";
import { aiUsageReport, VENDOR } from "./ai-usage.ts";
import { tryInterrupt } from "./interruptions.ts";
import { dayOf, hostSlug, readMachineEvents } from "./metrics.ts";
import { productDir, productsContainer, productWriteDir, runtimePath } from "./path-safety.ts";
import { classifyGoogleError } from "./source-sync.ts";
import { vwriteFile } from "./vault-session.ts";

const DAY = 86_400_000;

// ── Probes ──────────────────────────────────────────────────────────────────

export type HealthClass = "ok" | "auth_expired" | "ineligible" | "vendor_down" | "missing" | "degraded" | "unknown_shape" | "capture_gap";
export interface Probe { app: string; check: string; status: HealthClass; detail: string; fix?: string; version?: string }
export interface HealthRow { app: string; status: HealthClass; checks: Probe[]; last_ok?: string; first_fail?: string; checked: string; changed?: string }

export type Exec = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => { ok: boolean; out: string; err: string; missing?: boolean };
export const defaultExec: Exec = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, env: env ?? process.env });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { ok: r.status === 0 && !r.error, out: r.stdout ?? "", err: `${r.stderr ?? ""}${r.error && !missing ? String(r.error) : ""}`, missing };
};

const PATHS = () => [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin"), join(homedir(), ".npm-global", "bin")];
export function which(bin: string): string | null {
  for (const d of PATHS()) { if (!d) continue; const p = join(d, bin); try { if (statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

// The command line tools worth probing: their app, and how to ask who is signed in when cheap.
export const CLI_PROBES: { bin: string; app: string; auth?: string[]; authOk?: RegExp }[] = [
  { bin: "claude", app: "anthropic" }, { bin: "codex", app: "openai" }, { bin: "agy", app: "google" }, { bin: "gemini", app: "google" },
  { bin: "opencode", app: "opencode" }, { bin: "cursor-agent", app: "cursor" }, { bin: "gh", app: "github", auth: ["auth", "status"], authOk: /Logged in/i },
  { bin: "vercel", app: "vercel" }, { bin: "turso", app: "turso" }, { bin: "op", app: "1password" }, { bin: "ollama", app: "ollama" }, { bin: "tailscale", app: "tailscale" }, { bin: "gws", app: "google" },
];

export function classifyText(text: string): { status: HealthClass; fix: string } {
  if (/disabled_client|client .*disabled|Account Restricted|restricted this account|servicerestricted|not (available|eligible)|no longer (available|supported)|ineligible|deprecated for/i.test(text)) return { status: "ineligible", fix: classifyGoogleError(text) };
  if (/invalid_grant|expired|revoked|not logged in|not signed in|login required|unauthori[sz]ed|401|re-?authenticate|sign in again/i.test(text)) return { status: "auth_expired", fix: "sign in again" };
  if (/503|502|504|unavailable|timed? ?out|ECONNREFUSED|ENOTFOUND/i.test(text)) return { status: "vendor_down", fix: "the service did not answer; it is checked again next run" };
  return { status: "degraded", fix: text.replace(/\s+/g, " ").trim().slice(0, 140) };
}

/** Statuspage /api/v2/status.json indicator to a class. */
export async function vendorStatus(url: string, f: typeof fetch = fetch): Promise<{ status: HealthClass; detail: string }> {
  try {
    const r = await f(`${url.replace(/\/$/, "")}/api/v2/status.json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { status: "ok", detail: `status page not readable (${r.status}); not counted` };
    const j = (await r.json()) as { status?: { indicator?: string; description?: string } };
    const ind = j.status?.indicator ?? "none";
    return { status: ind === "none" ? "ok" : ind === "minor" ? "degraded" : "vendor_down", detail: j.status?.description ?? ind };
  } catch (e) { return { status: "ok", detail: `status page unreachable (${String((e as Error).message).slice(0, 60)}); not counted` }; }
}

export interface DoctorOpts { exec?: Exec; fetch?: typeof fetch; now?: number; host?: string; status?: boolean; usage?: Record<string, AppUsage>; which?: (bin: string) => string | null }

/** Every probe this Mac can run. Only apps the user has (a record, a binary, use) are probed. */
export async function probeAll(vault: string, opts: DoctorOpts = {}): Promise<Probe[]> {
  const exec = opts.exec ?? defaultExec;
  const w = opts.which ?? which;
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const out: Probe[] = [];
  const records = new Map(readRecords(vault).map((r) => [r.id, r]));
  const usage = opts.usage ?? computeUsage(vault, { now }).apps;
  // 1. Command line tools: present, its version, and sign-in where it is cheap.
  for (const p of CLI_PROBES) {
    const bin = w(p.bin);
    const used = records.has(p.app) || !!usage[p.app];
    if (!bin) { if (used && (p.bin === "claude" || p.bin === "codex" || p.bin === "gh")) out.push({ app: p.app, check: `${p.bin} installed`, status: "missing", detail: `${p.bin} is not on this Mac`, fix: `install ${p.bin}` }); continue; }
    const v = exec(bin, ["--version"]);
    const text = `${v.out}\n${v.err}`.trim();
    if (!v.ok) out.push({ app: p.app, check: `${p.bin} --version`, ...classifyText(text), detail: text.slice(0, 200) });
    else out.push({ app: p.app, check: `${p.bin} --version`, status: "ok", detail: text.split("\n")[0]!.slice(0, 120), version: (/\d+\.\d+(\.\d+)?/.exec(text) ?? [""])[0] });
    if (p.auth) {
      const a = exec(bin, p.auth);
      const t = `${a.out}\n${a.err}`;
      out.push(a.ok && (!p.authOk || p.authOk.test(t)) ? { app: p.app, check: `${p.bin} ${p.auth.join(" ")}`, status: "ok", detail: "signed in" } : { app: p.app, check: `${p.bin} ${p.auth.join(" ")}`, ...classifyText(t), detail: t.replace(/\s+/g, " ").trim().slice(0, 200) });
    }
  }
  // 2. Google sign-in per account (gws): the cheapest authenticated read.
  const gws = w("gws");
  if (gws) {
    const cs = await import("./calendar-sync.ts");
    for (const prof of cs.listGwsProfiles()) {
      const r = exec(gws, ["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })], cs.gwsSpawnEnv(prof.label));
      const t = `${r.out}\n${r.err}`;
      const err = !r.ok || /"error"/.test(r.out);
      out.push(err ? { app: "google", check: `Google sign-in (${prof.label})`, ...classifyText(t), detail: classifyGoogleError(t) } : { app: "google", check: `Google sign-in (${prof.label})`, status: "ok", detail: "signed in" });
    }
  }
  // 3. AI adapters: an unknown shape is a health problem, never silent zeros.
  try {
    const ad = JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "apps", `adapters.${host}.json`), "utf8")) as { tools?: Record<string, { shape: string; note?: string; present: boolean }> };
    for (const [tool, h] of Object.entries(ad.tools ?? {})) {
      if (!h.present) continue;
      const app = VENDOR[tool] ?? tool;
      out.push(h.shape === "unknown" ? { app, check: `${tool} records`, status: "unknown_shape", detail: h.note ?? "a record shape this version does not know", fix: "update Prevail; until then this tool's tokens are not counted" } : { app, check: `${tool} records`, status: "ok", detail: "readable" });
    }
  } catch { /* no AI scan on this Mac yet */ }
  // 4. Capture gaps: a tool used in the last 3 days with no prompt captured for 7.
  const recent = readMachineEvents(vault, dayOf(now - 3 * DAY)).events.filter((e) => e.kind === "ai.session" && e.host === host);
  for (const tool of [...new Set(recent.map((e) => e.src))]) {
    if (!["claude", "codex", "antigravity", "opencode"].includes(tool)) continue;
    const dir = join(runtimePath(vault, "_meta"), "prompts");
    let last = 0;
    try { for (const f of readdirSync(dir)) if (f.startsWith(`${tool}.`) || f === `${tool}.jsonl`) last = Math.max(last, statSync(join(dir, f)).mtimeMs); } catch { /* none */ }
    if (now - last > 7 * DAY) out.push({ app: VENDOR[tool] ?? tool, check: `${tool} prompt capture`, status: "capture_gap", detail: last ? `no ${tool} prompt captured since ${dayOf(last)} though ${tool} ran this week` : `${tool} ran this week and no prompt was ever captured`, fix: "prevail capture install (adds the capture hook), then trust it in the tool" });
  }
  // 5. Connected sources: their last sync.
  try {
    const st = JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "source-state.json"), "utf8")) as Record<string, { state: string; note?: string }>;
    const appOf: Record<string, string> = { gmail: "google", calendar: "google", github: "github", youtube: "google", plaid: "plaid", oura: "oura-ring", strava: "strava", garmin: "garmin-connect" };
    for (const [src, s] of Object.entries(st)) {
      if (!appOf[src] || s.state === "ok" || s.state === "needs-connection" || s.state === "off") continue;
      out.push({ app: appOf[src]!, check: `${src} sync`, ...classifyText(s.note ?? s.state), detail: s.note ?? s.state });
    }
  } catch { /* no source has synced */ }
  // 6. Connectors in the AI runtimes that need sign-in.
  try {
    const mirror = JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "apps", "mirror.json"), "utf8")) as { apps?: { id: string; status?: string; runtime?: string }[] };
    for (const a of mirror.apps ?? []) if (a.status === "needs_auth") out.push({ app: a.id, check: `${a.runtime ?? "runtime"} connector`, status: "auth_expired", detail: "the connector needs sign-in", fix: `sign in to it in ${a.runtime ?? "its runtime"}` });
  } catch { /* no mirror */ }
  // 7. Vendor status pages for apps in use.
  if (opts.status !== false) {
    for (const k of KNOWN_APPS) {
      if (!k.status || !(records.has(k.id) || usage[k.id])) continue;
      const s = await vendorStatus(k.status, opts.fetch);
      out.push({ app: k.id, check: "vendor status", status: s.status, detail: s.detail });
    }
  }
  return out;
}

const RANK: HealthClass[] = ["ok", "degraded", "capture_gap", "unknown_shape", "missing", "auth_expired", "vendor_down", "ineligible"];
const worst = (ps: Probe[]): HealthClass => ps.reduce<HealthClass>((a, p) => (RANK.indexOf(p.status) > RANK.indexOf(a) ? p.status : a), "ok");

export const healthPath = (vault: string, host = hostSlug()) => join(runtimePath(vault, "_meta"), "apps", `health.${host}.json`);

export function readHealth(vault: string, host = hostSlug()): Record<string, HealthRow> {
  try { return (JSON.parse(readFileSync(healthPath(vault, host), "utf8")) as { apps: Record<string, HealthRow> }).apps ?? {}; } catch { return {}; }
}

/** Fold probes into health rows: last_ok, first_fail, and what changed since the last run (a version or an error text). */
export function foldHealth(prev: Record<string, HealthRow>, probes: Probe[], now: number): Record<string, HealthRow> {
  const out: Record<string, HealthRow> = {};
  const day = new Date(now).toISOString();
  const by = new Map<string, Probe[]>();
  for (const p of probes) (by.get(p.app) ?? by.set(p.app, []).get(p.app)!).push(p);
  for (const [app, ps] of by) {
    const before = prev[app];
    const status = worst(ps);
    const sig = (xs: Probe[]) => xs.map((p) => `${p.check}=${p.status}:${p.version ?? (p.status === "ok" ? "" : p.detail.slice(0, 80))}`).sort().join("|");
    const changed = before && sig(before.checks) !== sig(ps) ? ps.filter((p) => !before.checks.some((b) => b.check === p.check && b.status === p.status && (b.version ?? "") === (p.version ?? ""))).map((p) => `${p.check}: ${p.status === "ok" ? (p.version ? `now ${p.version}` : p.detail) : `${p.status}, ${p.detail}`}`).join("; ").slice(0, 300) : undefined;
    out[app] = {
      app, status, checks: ps, checked: day,
      ...(status === "ok" ? { last_ok: day } : before?.last_ok ? { last_ok: before.last_ok } : {}),
      ...(status !== "ok" ? { first_fail: before && before.status !== "ok" && before.first_fail ? before.first_fail : day } : {}),
      ...(changed ? { changed } : {}),
    };
  }
  return out;
}

export async function doctorApps(vault: string, opts: DoctorOpts = {}): Promise<Record<string, HealthRow>> {
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const prev = readHealth(vault, host);
  const rows = foldHealth(prev, await probeAll(vault, { ...opts, host }), now);
  const p = healthPath(vault, host);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify({ ts: new Date(now).toISOString(), host, apps: rows }, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return rows;
}

/** Every Mac's health, worst first per app. */
export function readAllHealth(vault: string): Record<string, HealthRow & { host: string }> {
  const dir = join(runtimePath(vault, "_meta"), "apps");
  const out: Record<string, HealthRow & { host: string }> = {};
  let fs: string[] = [];
  try { fs = readdirSync(dir).filter((f) => /^health\..+\.json$/.test(f)); } catch { return out; }
  for (const f of fs) {
    const host = f.slice(7, -5);
    for (const [app, r] of Object.entries(readHealth(vault, host))) if (!out[app] || RANK.indexOf(r.status) > RANK.indexOf(out[app]!.status)) out[app] = { ...r, host };
  }
  return out;
}

// ── The stack ───────────────────────────────────────────────────────────────

export type Verdict = "keep" | "review" | "cancel";
export interface StackApp {
  id: string; name: string; kind: string; category: string; lifecycle: string;
  usage: AppUsage | null; monthly: number | null; cost_source?: string; cost_confidence?: number;
  renewal?: { next: string; period: string }; trial?: { ends: string }; price_up?: { from: number; to: number; date: string };
  value_multiple?: number; api_equivalent_month?: number;
  health: HealthClass | null; health_detail?: string; verdict: Verdict; why: string[];
  cost_per_active_day?: number; first_seen?: string;
  /** A record the stack made or adopted (a kind, no live connector), so archiving it loses no connection. */
  stack_record?: boolean;
}

const monthlyOf = (c: { amount?: number; period?: string } | undefined) => (c && typeof c.amount === "number" ? (c.period === "year" ? c.amount / 12 : c.amount) : null);
const CATEGORY_TITLE: Record<string, string> = { ai: "AI tools", "ai-coding": "AI tools", dev: "Dev", notes: "Notes", design: "Design", content: "Content", chat: "Chat", meetings: "Meetings", music: "Music", video: "Video", storage: "Storage", productivity: "Productivity", network: "Network", security: "Security", social: "Social", shopping: "Shopping", travel: "Travel", fitness: "Fitness", money: "Money", platform: "Platform", audio: "Audio" };
export const categoryTitle = (c: string) => CATEGORY_TITLE[c] ?? (c ? c.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()) : "Other");

export interface Stack { ts: number; usage_since: string | null; month_total: number; in_use: number; apps: StackApp[]; categories: { id: string; title: string; count: number }[]; archived_seen: string[]; unknown: number; fda: { host: string; state: string }[]; ai: { paid_monthly: number | null; api_equivalent: number; value_multiple: number | null } }

/** One record per app with usage, money, value, health and a verdict. */
export function buildStack(vault: string, opts: { now?: number } = {}): Stack {
  const now = opts.now ?? Date.now();
  const model = computeUsage(vault, { now });
  const health = readAllHealth(vault);
  const month = dayOf(now).slice(0, 7);
  const ai = aiUsageReport(vault, month);
  const vendorApi = new Map<string, number>();
  for (const t of ai.by_tool) { const v = VENDOR[t.key]; if (v) vendorApi.set(v, (vendorApi.get(v) ?? 0) + t.usd_api); }
  const dayOfMonth = new Date(now).getDate();
  const recs = readRecords(vault);
  const apps: StackApp[] = [];
  for (const r of recs) {
    if (r.archived) continue;
    const m = r.manifest;
    const u = model.apps[r.id] ?? null;
    const known = KNOWN_APPS.find((k) => k.id === r.id);
    const kind = String(m.kind ?? known?.kind ?? (m.integration && m.integration !== "manual" ? "service" : "app"));
    // Records that are only connectors or bank folders, with no stack signal, stay off the stack.
    if (!m.kind && !u && !m.cost && !known) continue;
    const monthly = monthlyOf(m.cost as { amount?: number; period?: string } | undefined);
    const ph = Array.isArray(m.price_history) ? (m.price_history as { date: string; amount: number }[]) : [];
    const lastTwo = ph.slice(-2);
    const priceUp = lastTwo.length === 2 && lastTwo[1]!.amount > lastTwo[0]!.amount * 1.05 ? { from: lastTwo[0]!.amount, to: lastTwo[1]!.amount, date: lastTwo[1]!.date } : undefined;
    const apiEq = vendorApi.get(r.id);
    // Value is API-equivalent use so far this month against a month of the plan, scaled to the month.
    const value = apiEq !== undefined && monthly ? Math.round(((apiEq * 30) / Math.max(1, dayOfMonth) / monthly) * 10) / 10 : undefined;
    const h = health[r.id];
    const why: string[] = [];
    let verdict: Verdict = "keep";
    const active30 = u?.active_days.d30 ?? 0;
    const hasSignal = !!u && u.active_days.d90 > 0;
    if (monthly && hasSignal && active30 < 2) { verdict = "cancel"; why.push(`${active30} active day${active30 === 1 ? "" : "s"} in 30`); }
    if (priceUp) { verdict = verdict === "keep" ? "review" : verdict; why.push(`price up from $${priceUp.from} to $${priceUp.to}`); }
    if (m.billed_twice) { verdict = verdict === "keep" ? "review" : verdict; why.push("billed twice"); }
    if (value !== undefined && value < 1) { verdict = verdict === "keep" ? "review" : verdict; why.push(`value ${value}x what you pay`); }
    const trial = m.trial as { ends?: string } | undefined;
    if (trial?.ends && trial.ends >= dayOf(now)) why.push(`trial ends ${trial.ends}`);
    apps.push({
      id: r.id, name: r.name, kind, category: String(m.category ?? known?.category ?? "other"), lifecycle: String(m.lifecycle ?? (u?.active_days.d30 ? "in use" : "unused")),
      usage: u, monthly: monthly !== null ? Math.round(monthly * 100) / 100 : null,
      ...(m.cost ? { cost_source: String((m.cost as { source?: string }).source ?? ""), cost_confidence: Number((m.cost as { confidence?: number }).confidence ?? 1) } : {}),
      ...(m.renewal ? { renewal: m.renewal as { next: string; period: string } } : {}),
      ...(trial?.ends ? { trial: { ends: trial.ends } } : {}),
      ...(priceUp ? { price_up: priceUp } : {}),
      ...(value !== undefined ? { value_multiple: value } : {}),
      ...(apiEq !== undefined ? { api_equivalent_month: Math.round(apiEq * 100) / 100 } : {}),
      health: h?.status ?? null, ...(h && h.status !== "ok" ? { health_detail: h.checks.find((c) => c.status === h.status)?.detail } : {}),
      verdict, why,
      ...(monthly && active30 ? { cost_per_active_day: Math.round((monthly / active30) * 100) / 100 } : {}),
      ...(typeof m.first_seen === "string" ? { first_seen: m.first_seen } : {}),
      ...(m.kind && (!m.integration || m.integration === "manual") && !m.mirror ? { stack_record: true } : {}),
    });
  }
  apps.sort((a, b) => (b.usage?.active_days.d30 ?? 0) - (a.usage?.active_days.d30 ?? 0) || (b.monthly ?? 0) - (a.monthly ?? 0) || a.name.localeCompare(b.name));
  const cats = new Map<string, number>();
  for (const a of apps) { const t = categoryTitle(a.category); cats.set(t, (cats.get(t) ?? 0) + 1); }
  const fda = Object.entries(readUsageHealth(vault)).map(([host, s]) => ({ host, state: s.screentime?.state ?? "unknown" }));
  const archived_seen = recs.filter((r) => r.archived && model.apps[r.id]?.active_days.d30).map((r) => r.id);
  return {
    ts: now, usage_since: model.days[0] ?? null, month_total: Math.round(apps.reduce((a, x) => a + (x.monthly ?? 0), 0) * 100) / 100, in_use: apps.filter((a) => (a.usage?.active_days.d30 ?? 0) > 0).length, apps,
    categories: [...cats.entries()].map(([title, count]) => ({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, count })).sort((a, b) => b.count - a.count),
    archived_seen, unknown: model.unknown.length, fda,
    ai: { paid_monthly: ai.paid_monthly, api_equivalent: ai.total.usd_api, value_multiple: ai.value_multiple },
  };
}

// ── Detection rules and cards ───────────────────────────────────────────────

export type CardKind = "new" | "unused" | "archive" | "duplicate" | "failing" | "renewal" | "price" | "trial" | "ai-plan" | "seen-again";
export interface Card { key: string; kind: CardKind; app: string; title: string; why: string; actions: string[]; urgent: boolean; due?: string }

const cardKey = (kind: string, app: string, extra = "") => createHash("sha256").update(`${kind}:${app}:${extra}`).digest("hex").slice(0, 12);

/** The rules, over the stack. Pure: answers (keep, snooze) are applied by visibleCards. */
export function detectCards(stack: Stack, now: number): Card[] {
  const out: Card[] = [];
  const today = dayOf(now);
  const days = (d: string) => Math.round((Date.parse(`${d}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / DAY);
  const money = (x: number) => `$${x >= 100 ? Math.round(x) : x.toFixed(2)}`;
  // "New" needs history to be new against: three weeks of usage before the week.
  const history = !!stack.usage_since && days(stack.usage_since) <= -21;
  for (const a of stack.apps) {
    const u = a.usage;
    const first = u?.installed ?? (history ? u?.first_seen : undefined);
    if (first && days(first) >= -7 && u?.active_days.d7) out.push({ key: cardKey("new", a.id, first), kind: "new", app: a.id, title: `New this week: ${a.name}`, why: `${u.active_days.d7} active day${u.active_days.d7 === 1 ? "" : "s"}${u.minutes_30d ? `, ${u.minutes_30d} minutes` : ""}`, actions: ["keep", "review"], urgent: false });
    if (a.monthly && u && u.active_days.d90 > 0 && u.active_days.d30 < 2) out.push({ key: cardKey("unused", a.id, today.slice(0, 7)), kind: "unused", app: a.id, title: `${a.name}: ${money(a.monthly)} a month, ${u.active_days.d30} active day${u.active_days.d30 === 1 ? "" : "s"} in 30`, why: a.renewal ? `renews ${a.renewal.next}` : "paid and barely used", actions: ["keep", "cancel-steps", "snooze"], urgent: false, ...(a.renewal ? { due: a.renewal.next } : {}) });
    if (!a.monthly && (!u || u.active_days.d90 === 0) && a.stack_record && a.lifecycle !== "archived") out.push({ key: cardKey("archive", a.id), kind: "archive", app: a.id, title: `${a.name}: unused for 90 days`, why: "free and not seen in use; archive the record (moved, never deleted)?", actions: ["archive", "keep"], urgent: false });
    if (a.health && !["ok", "degraded"].includes(a.health)) {
      const broken = a.health === "capture_gap";
      out.push({ key: cardKey("failing", a.id, a.health), kind: "failing", app: a.id, title: broken ? `${a.name}: prompts are not being captured` : `${a.name}: ${a.health.replace(/_/g, " ")}`, why: a.health_detail ?? a.health, actions: ["fix", "snooze"], urgent: broken });
    }
    if (a.renewal && a.monthly) {
      const d = days(a.renewal.next);
      const stage = d < 0 ? null : d <= 1 ? 1 : d <= 7 ? 7 : d <= 30 ? 30 : null;
      if (stage) out.push({ key: cardKey("renewal", a.id, `${a.renewal.next}:${stage}`), kind: "renewal", app: a.id, title: `${a.name} renews ${d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`} (${a.renewal.next})`, why: `${money(a.renewal.period === "yearly" ? a.monthly * 12 : a.monthly)} ${a.renewal.period === "yearly" ? "a year" : "a month"}${u ? `; ${u.active_days.d30} active days in 30` : ""}`, actions: ["keep", "cancel-steps", "snooze"], urgent: false, due: a.renewal.next });
    }
    if (a.price_up) out.push({ key: cardKey("price", a.id, a.price_up.date), kind: "price", app: a.id, title: `${a.name}: price up from ${money(a.price_up.from)} to ${money(a.price_up.to)}`, why: `since ${a.price_up.date}`, actions: ["keep", "review", "cancel-steps"], urgent: false });
    if (a.trial) { const d = days(a.trial.ends); if (d >= 0 && d <= 3) out.push({ key: cardKey("trial", a.id, a.trial.ends), kind: "trial", app: a.id, title: `${a.name}: trial ends ${d === 0 ? "today" : `in ${d} day${d === 1 ? "" : "s"}`}`, why: u ? `${u.active_days.d30} active days in 30` : "decide before it bills", actions: ["keep", "cancel-steps"], urgent: false, due: a.trial.ends }); }
    if (a.value_multiple !== undefined && a.value_multiple < 1) out.push({ key: cardKey("ai-plan", a.id, today.slice(0, 7)), kind: "ai-plan", app: a.id, title: `${a.name}: ${a.value_multiple}x what you pay at API prices`, why: "a smaller plan or the API may cost less", actions: ["keep", "review"], urgent: false });
  }
  // Duplicates: two or more paid apps in one category, both used this month.
  const byCat = new Map<string, StackApp[]>();
  for (const a of stack.apps) if (a.monthly && (a.usage?.active_days.d30 ?? 0) > 0) (byCat.get(a.category) ?? byCat.set(a.category, []).get(a.category)!).push(a);
  for (const [cat, as] of byCat) if (as.length >= 2) {
    const least = [...as].sort((x, y) => (x.usage?.active_days.d30 ?? 0) - (y.usage?.active_days.d30 ?? 0))[0]!;
    out.push({ key: cardKey("duplicate", cat, as.map((a) => a.id).sort().join(",")), kind: "duplicate", app: least.id, title: `${as.length} paid ${categoryTitle(cat).toLowerCase()} apps: ${as.map((a) => a.name).join(", ")}`, why: `${least.name}: ${least.usage?.active_days.d30 ?? 0} active days in 30`, actions: ["keep", "review"], urgent: false });
  }
  for (const a of stack.apps) if (a.why.includes("billed twice")) out.push({ key: cardKey("duplicate", a.id, "twice"), kind: "duplicate", app: a.id, title: `${a.name} is billed twice`, why: "two live charges for one app", actions: ["review", "cancel-steps"], urgent: false });
  if (stack.archived_seen.length) out.push({ key: cardKey("seen-again", stack.archived_seen.join(",")), kind: "seen-again", app: stack.archived_seen[0]!, title: `${stack.archived_seen.length} archived app${stack.archived_seen.length === 1 ? " is" : "s are"} in use again: ${stack.archived_seen.join(", ")}`, why: "move the ones to track back from data/entities/products/_archive", actions: ["keep", "review"], urgent: false });
  return out;
}

interface Answer { ts: number; key: string; answer: string; until?: number }
const answersPath = (vault: string) => join(runtimePath(vault, "_meta"), "apps", "cards.jsonl");
export function readAnswers(vault: string): Answer[] {
  try { return readFileSync(answersPath(vault), "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l) as Answer] : []; } catch { return []; } }); } catch { return []; }
}

/** Cards still worth showing: not kept (90 days) or snoozed (30 days) or done. */
export function visibleCards(cards: Card[], answers: Answer[], now: number): Card[] {
  const last = new Map<string, Answer>();
  for (const a of answers) last.set(a.key, a);
  return cards.filter((c) => { const a = last.get(c.key); return !a || (a.until !== undefined && a.until < now); });
}

export function answerCard(vault: string, key: string, answer: string, now = Date.now()): Answer {
  if (!/^[a-f0-9]{12}$/.test(key)) throw new Error("not a card key");
  if (!["keep", "snooze", "done", "review", "fix", "archive", "cancel-steps"].includes(answer)) throw new Error("answer must be keep, snooze, done, review, fix, archive or cancel-steps");
  const a: Answer = { ts: now, key, answer, ...(answer === "keep" ? { until: now + 90 * DAY } : answer === "snooze" ? { until: now + 30 * DAY } : {}) };
  mkdirSync(join(answersPath(vault), ".."), { recursive: true });
  appendFileSync(answersPath(vault), `${JSON.stringify(a)}\n`);
  return a;
}

/** Urgent cards (broken capture) may use the interruption budget; everything else waits for the review. */
export function raiseUrgent(vault: string, cards: Card[], now = Date.now()): { raised: string[]; waited: string[] } {
  const raised: string[] = []; const waited: string[] = [];
  for (const c of cards) {
    if (!c.urgent) continue;
    const r = tryInterrupt(vault, { kind: "broken-capture", text: `${c.title}. ${c.why}`, key: `apps:${c.key}` }, now);
    (r.ok ? raised : waited).push(c.key);
  }
  return { raised, waited };
}

/** One line for the weekly review. */
export function weeklyLine(cards: Card[], stack: Stack): string {
  if (!cards.length) return `Apps: ${stack.in_use} in use${stack.month_total ? `, $${Math.round(stack.month_total)} a month known` : ""}; nothing needs you.`;
  const order: CardKind[] = ["failing", "trial", "renewal", "unused", "price", "duplicate", "ai-plan", "new", "seen-again", "archive"];
  const top = [...cards].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 3).map((c) => c.title);
  return `Apps: ${cards.length} need${cards.length === 1 ? "s" : ""} you: ${top.join("; ")}${cards.length > 3 ? `; and ${cards.length - 3} more in the stack review` : ""}.`;
}

// ── The monthly stack review and offboarding drafts ─────────────────────────

const money = (x: number) => `$${x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2)}`;

export function stackReviewMarkdown(stack: Stack, cards: Card[], month: string): string {
  const paid = stack.apps.filter((a) => a.monthly);
  const lines = [`# Stack review, ${month}`, "", `Written by Prevail from your app records, usage and charges; every number comes from code. Statements and sign-ins it could not read are named, not guessed.`, ""];
  lines.push("## Spend", "");
  lines.push(`- Known spend: ${money(stack.month_total)} a month across ${paid.length} paid app${paid.length === 1 ? "" : "s"}; ${stack.in_use} apps in use in the last 30 days.`);
  if (stack.ai.paid_monthly !== null) lines.push(`- AI: ${money(stack.ai.paid_monthly)} paid, ${money(stack.ai.api_equivalent)} of use at API prices this month${stack.ai.value_multiple !== null ? ` (${stack.ai.value_multiple}x)` : ""}.`);
  else lines.push(`- AI: ${money(stack.ai.api_equivalent)} of use at API prices this month; what you pay is not known yet (no charge matched; \`prevail ai plan <app> --usd N\` sets it).`);
  for (const a of [...paid].sort((x, y) => (y.monthly ?? 0) - (x.monthly ?? 0)).slice(0, 10)) lines.push(`  - ${a.name}: ${money(a.monthly!)} a month${a.cost_per_active_day ? `, ${money(a.cost_per_active_day)} per active day` : ""}${a.cost_source ? ` (${a.cost_source})` : ""}`);
  lines.push("", "## Top three to review", "");
  const review = stack.apps.filter((a) => a.verdict !== "keep").sort((a, b) => (a.verdict === "cancel" ? 0 : 1) - (b.verdict === "cancel" ? 0 : 1) || (b.monthly ?? 0) - (a.monthly ?? 0)).slice(0, 3);
  if (!review.length) lines.push("- Nothing paid looks unused, doubled or overpriced this month.");
  for (const a of review) lines.push(`- ${a.name}: ${a.verdict}, ${a.why.join("; ")}`);
  const section = (title: string, kinds: CardKind[]) => { const cs = cards.filter((c) => kinds.includes(c.kind)); if (cs.length) { lines.push("", `## ${title}`, ""); for (const c of cs) lines.push(`- ${c.title}: ${c.why}`); } };
  section("Renewals and trials coming", ["renewal", "trial"]);
  section("Not working", ["failing"]);
  section("New this month", ["new"]);
  section("Duplicates", ["duplicate"]);
  section("Archived, in use again", ["seen-again"]);
  section("Unused and free", ["archive"]);
  if (stack.unknown) lines.push("", `${stack.unknown} signal${stack.unknown === 1 ? "" : "s"} matched no app (\`prevail apps unknown\`); mapping one makes a rule.`);
  const noFda = stack.fda.filter((f) => f.state === "needs-fda");
  if (noFda.length) lines.push("", `Screen Time is not read on ${noFda.map((f) => f.host).join(", ")}: Prevail needs Full Disk Access there, so app minutes come from live focus only.`);
  return `${lines.join("\n")}\n`;
}

export function writeStackReview(vault: string, stack: Stack, cards: Card[], now = Date.now()): string {
  const month = dayOf(now).slice(0, 7);
  const dir = join(vault, "data", "domains", "general", "memory", "reviews");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `stack-${month}.md`);
  vwriteFile(p, stackReviewMarkdown(stack, cards, month));
  return p;
}

// Where to revoke third-party access, by the account it signs in with.
const REVOKE: Record<string, string> = { google: "https://myaccount.google.com/permissions", github: "https://github.com/settings/applications", microsoft: "https://account.live.com/consent/Manage", apple: "https://appleid.apple.com (Sign in with Apple)" };

/** A drafted offboarding checklist in the app's folder. Nothing is cancelled, sent or deleted. */
export function offboardingDraft(vault: string, id: string, now = Date.now()): string {
  const rec = readRecords(vault).find((r) => r.id === id && !r.archived);
  if (!rec) throw new Error(`no app record: ${id}`);
  const m = rec.manifest;
  const monthly = monthlyOf(m.cost as { amount?: number; period?: string } | undefined);
  const day = dayOf(now);
  const renew = (m.renewal as { next?: string } | undefined)?.next;
  const body = [
    `# Offboarding ${rec.name} (draft, ${day})`, "",
    "A checklist Prevail drafted. Nothing here has been done: you cancel, you send.", "",
    `- [ ] Cancel the plan${monthly ? ` (${money(monthly)} a month${renew ? `, renews ${renew}` : ""})` : ""} in ${rec.name}'s account or billing settings${renew ? ` before ${renew}` : ""}.`,
    `- [ ] Export your data from ${rec.name} first (account settings, export or download).`,
    "- [ ] Delete the account once the export is safe, if you will not come back.",
    `- [ ] Revoke ${rec.name}'s access to your other accounts: ${Object.values(REVOKE).join("; ")}.`,
    "- [ ] Remove the stored card from the account.",
    `- [ ] Archive the record: \`prevail apps card <key> archive\` or move data/entities/products/${id}/ to data/entities/products/_archive/ (never deleted).`,
    "", "## Draft message to the vendor (not sent)", "",
    `Subject: Please cancel my ${rec.name} subscription`, "",
    `Hello, please cancel my ${rec.name} subscription${renew ? ` before the renewal on ${renew}` : ""} and confirm by reply. Please also confirm that my stored payment details are removed. Thank you.`, "",
  ].join("\n");
  const p = join(productWriteDir(vault, id), `offboarding-${day}.md`);
  mkdirSync(join(p, ".."), { recursive: true });
  vwriteFile(p, body);
  return p;
}

/** Archive a record: moved to data/entities/products/_archive/<id>, never deleted. */
export function archiveRecord(vault: string, id: string): string {
  const from = productDir(vault, id);
  if (!existsSync(from)) throw new Error(`no product folder: ${id}`);
  let to = join(productsContainer(vault), "_archive", id);
  for (let n = 2; existsSync(to); n++) to = join(productsContainer(vault), "_archive", `${id}-${n}`);
  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
  return to;
}

export async function appsDoctorCommand(argv: string[], vault: string, json: boolean): Promise<number> {
  const rows = await doctorApps(vault, { status: !argv.includes("--no-status") });
  if (json) process.stdout.write(`${JSON.stringify(rows)}\n`);
  else for (const r of Object.values(rows).sort((a, b) => RANK.indexOf(b.status) - RANK.indexOf(a.status))) {
    console.log(`${r.status.padEnd(14)} ${r.app}${r.changed ? `  (changed: ${r.changed})` : ""}`);
    for (const c of r.checks) if (c.status !== "ok") console.log(`  ${c.check}: ${c.detail}${c.fix && c.fix !== c.detail ? `  fix: ${c.fix}` : ""}`);
  }
  return 0;
}


/** Once a day on each Mac (from the capture sync): the doctor, the cards, urgent ones through the budget, and on the first of the month the stack review. */
export async function dailyStackPass(vault: string, opts: DoctorOpts = {}): Promise<{ ran: boolean; cards?: number; raised?: string[]; review?: string }> {
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  try { const ts = Date.parse((JSON.parse(readFileSync(healthPath(vault, host), "utf8")) as { ts: string }).ts); if (now - ts < 20 * 3_600_000) return { ran: false }; } catch { /* first run */ }
  await doctorApps(vault, { ...opts, now, host });
  const stack = buildStack(vault, { now });
  const cards = visibleCards(detectCards(stack, now), readAnswers(vault), now);
  const { raised } = raiseUrgent(vault, cards, now);
  const month = dayOf(now).slice(0, 7);
  const reviewPath = join(vault, "data", "domains", "general", "memory", "reviews", `stack-${month}.md`);
  const review = existsSync(reviewPath) ? undefined : writeStackReview(vault, stack, cards, now);
  // Apps A5: with the month's review, the said vs used diff for tool-stack.md (waits for the user's yes).
  if (review) { try { await (await import("./stack-said.ts")).writeStackDiff(vault, now); } catch { /* no stated stack */ } }
  // Exports dropped in an app's inbox come in as quoted history.
  try { await (await import("./ai-imports.ts")).importInbox(vault, now); } catch { /* nothing waiting */ }
  return { ran: true, cards: cards.length, raised, ...(review ? { review } : {}) };
}
