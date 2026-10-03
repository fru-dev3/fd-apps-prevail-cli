// Money for the stack (apps plan A3): what each app costs, when it renews,
// trials and price changes.
//
// Sources, all matched to app records (apps plan decision 3: bank data keeps
// only charges matched to apps):
//   - card statement CSVs already in the vault (data/apps/<bank>/*.csv), read
//     in place: recurring series are detected per merchant (weekly, monthly,
//     quarterly, yearly; similar amounts). Unmatched recurring merchants go to
//     the unknown inbox on this Mac; nothing else about other charges is kept.
//   - Plaid recurring streams (source-files.ts), when connected.
//   - receipt and lifecycle emails from senders that map to an app (headers
//     only: receipts, renewal notices, trials ending, welcome, price changes,
//     cancellations), from the Gmail headers kept on this Mac.
// The result goes on each record: cost (unless the user stated one),
// renewal, trial, price_history; and money.charge events
// (build/_meta/events/... are not used: card rows are vault files, read in
// place by metrics through chargeEvents()).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildMatcher, KNOWN_APPS, readRecords, type Matcher } from "./app-map.ts";
import { csvRows, dayOf, hostSlug, mdy, readMachineEvents, type MetricEvent } from "./metrics.ts";
import { appsContainer, runtimePath } from "./path-safety.ts";
import { readMailHeaders, writeSourceEvents, type MailHeader } from "./source-sync.ts";
import { vreadFile } from "./vault-session.ts";

const DAY = 86_400_000;
const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };

// ── Card rows (in memory only) ──────────────────────────────────────────────

export interface CardCharge { id: string; date: string; usd: number; merchant: string; raw: string; file: string; category?: string }

/** A bank description reduced to its merchant: no processor prefix, store number, phone or city tail. */
export function normMerchant(desc: string): string {
  return desc.toUpperCase()
    // Card processors' prefixes say who processed it, not who was paid (Google and PayPal stay: "GOOGLE *YOUTUBE").
    .replace(/^(SQ|TST|SP|PY|APL|DD|IN|BT|FS)\s*\*\s*/, "")
    .replace(/\b(HTTPS?:\/\/)?WWW\./, "")
    .replace(/\s+\d{3}[-.]?\d{3}[-.]?\d{4}\b.*$/, "")
    .replace(/\s+#?\d{3,}.*$/, "")
    .replace(/\s+[A-Z]{2}\s*$/, "")
    .replace(/[^A-Z0-9*.&/ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** Every purchase row in the card statement CSVs, in memory (never written anywhere). Missions match these by merchant. */
export function cardCharges(vault: string): CardCharge[] {
  const out: CardCharge[] = [];
  const apps = appsContainer(vault);
  let ids: string[] = [];
  try { ids = readdirSync(apps); } catch { return out; }
  for (const id of ids) {
    if (id.startsWith("_") || id.startsWith(".")) continue;
    let fs: string[] = [];
    try { fs = readdirSync(join(apps, id)).filter((f) => /\.csv$/i.test(f)); } catch { continue; }
    for (const f of fs) {
      const p = join(apps, id, f);
      const file = relative(vault, p);
      const rows = csvRows(readText(p));
      const head = (rows[0] ?? []).map((h) => h.toLowerCase());
      const col = (n: string) => head.indexOf(n);
      const push = (date: string | null, usd: number, desc: string, i: number, category?: string) => {
        if (!date || !(usd > 0)) return;
        out.push({ id: createHash("sha256").update(`${file}:${i}:${date}:${usd}:${desc}`).digest("hex").slice(0, 16), date, usd: Math.round(usd * 100) / 100, merchant: normMerchant(desc), raw: desc, file, ...(category ? { category } : {}) });
      };
      if (col("transaction date") >= 0 && col("amount") >= 0 && col("type") >= 0) {
        rows.slice(1).forEach((r, i) => { if ((r[col("type")] ?? "").toLowerCase() === "sale") push(mdy(r[col("transaction date")] ?? ""), -Number(r[col("amount")]), r[col("description")] ?? "", i, r[col("category")] || undefined); });
      } else if (head.join(",") === "date,description,amount") {
        rows.slice(1).forEach((r, i) => { if (!/payment/i.test(r[1] ?? "")) push(mdy(r[0] ?? ""), Number(r[2]), r[1] ?? "", i); });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Recurring series ────────────────────────────────────────────────────────

export type Freq = "weekly" | "monthly" | "quarterly" | "yearly";
export interface Series { merchant: string; app: string | null; freq: Freq; charges: CardCharge[]; last: CardCharge; avg: number; next: string; mature: boolean; price_changes: { date: string; from: number; to: number }[] }

const FREQ: [Freq, number, number][] = [["weekly", 6, 8], ["monthly", 26, 35], ["quarterly", 84, 98], ["yearly", 350, 380]];
const addDays = (day: string, n: number) => dayOf(Date.parse(`${day}T12:00:00`) + n * DAY);

/**
 * Recurring series per merchant: at least two charges whose gaps fit one
 * cadence and whose amounts stay within 25% of the median (a price change is
 * kept as a step). Mature after three. Next = last + the cadence.
 */
export function detectSeries(charges: CardCharge[], m?: Matcher): Series[] {
  const by = new Map<string, CardCharge[]>();
  for (const c of charges) (by.get(c.merchant) ?? by.set(c.merchant, []).get(c.merchant)!).push(c);
  const out: Series[] = [];
  for (const [merchant, cs] of by) {
    if (cs.length < 2) continue;
    cs.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = cs.slice(1).map((c, i) => (Date.parse(c.date) - Date.parse(cs[i]!.date)) / DAY);
    const fit = FREQ.find(([, lo, hi]) => gaps.filter((g) => g >= lo && g <= hi).length >= Math.max(1, Math.ceil(gaps.length * 0.6)));
    if (!fit) continue;
    const amounts = cs.map((c) => c.usd).sort((a, b) => a - b);
    const med = amounts[Math.floor(amounts.length / 2)]!;
    const steady = cs.filter((c) => Math.abs(c.usd - med) <= med * 0.25 + 0.01);
    if (steady.length < 2 || steady.length < cs.length * 0.6) continue;
    const last = steady[steady.length - 1]!;
    const changes: Series["price_changes"] = [];
    steady.forEach((c, i) => { const p = steady[i - 1]; if (p && Math.abs(c.usd - p.usd) > p.usd * 0.005 + 0.005) changes.push({ date: c.date, from: p.usd, to: c.usd }); });
    const days = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 }[fit[0]];
    out.push({ merchant, app: m ? m.match("merchant", merchant) ?? m.match("merchant", last.raw) : null, freq: fit[0], charges: steady, last, avg: Math.round((steady.reduce((a, c) => a + c.usd, 0) / steady.length) * 100) / 100, next: addDays(last.date, days), mature: steady.length >= 3, price_changes: changes });
  }
  return out.sort((a, b) => b.last.date.localeCompare(a.last.date));
}

// Vendors whose single charges count as paying for the app (a plan), not shopping.
const NOT_PLANS = new Set(["shopping", "travel", "money"]);

/**
 * money.charge events, read in place from the card CSVs: every charge of a
 * recurring series matched to an app, and single charges from known plan
 * vendors. Nothing else from the bank leaves memory.
 */
export function chargeEvents(vault: string, charges = cardCharges(vault), m = buildMatcher(vault)): { events: MetricEvent[]; series: Series[] } {
  const series = detectSeries(charges, m);
  const inSeries = new Map<string, Series>();
  for (const s of series) if (s.app) for (const c of s.charges) inSeries.set(c.id, s);
  const out: MetricEvent[] = [];
  for (const c of charges) {
    const s = inSeries.get(c.id);
    let app = s?.app ?? null;
    if (!app) {
      const hit = m.match("merchant", c.merchant) ?? m.match("merchant", c.raw);
      const k = hit ? KNOWN_APPS.find((x) => x.id === hit) : undefined;
      if (hit && (!k || !NOT_PLANS.has(k.category)) && c.usd < 1000) app = hit;
    }
    if (!app) continue;
    out.push({ ts: c.date, src: "charges", kind: "money.charge", n: 1, project: app, host: "vault", tier: "measured", attrs: { usd: c.usd, ...(s ? { freq: s.freq } : {}) }, file: c.file });
  }
  return { events: out, series };
}

// ── Receipt and lifecycle emails (headers only) ─────────────────────────────

export type Lifecycle = "receipt" | "renewal" | "trial" | "welcome" | "price" | "cancel";
const CLASSES: [Lifecycle, RegExp][] = [
  ["trial", /\b(trial (ends|is ending|will end|expires|ending)|free trial|your trial)\b/i],
  ["price", /\b(price (change|increase|update)|new price|pricing (change|update))\b/i],
  ["cancel", /\b(cancel(l)?ed|cancellation|subscription (has )?ended|we('re| are) sorry to see you go)\b/i],
  ["renewal", /\b(renew(s|al|ing)?|auto-?renew|upcoming (charge|payment)|will be charged|subscription reminder)\b/i],
  ["receipt", /\b(receipt|invoice|payment (received|confirmation|successful)|your order|billing statement|thanks for your payment|charged)\b/i],
  ["welcome", /\b(welcome to|thanks for (signing up|joining)|confirm your (email|account)|verify your email|get started with)\b/i],
];
export const lifecycleOf = (subject: string): Lifecycle | null => CLASSES.find(([, re]) => re.test(subject))?.[0] ?? null;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A date named in a subject ("ends in 3 days", "renews on Nov 12", "on 2026-11-12"), relative to when it arrived. */
export function dateIn(subject: string, sentMs: number): string | null {
  const inDays = /\bin (\d{1,2}) days?\b/i.exec(subject) ?? (/\btomorrow\b/i.test(subject) ? ["", "1"] : null);
  if (inDays) return dayOf(sentMs + Number(inDays[1]) * DAY);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(subject);
  if (iso) return iso[1]!;
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/i.exec(subject);
  if (md) {
    const sent = new Date(sentMs);
    const d = new Date(sent.getFullYear(), MONTHS.indexOf(md[1]!.toLowerCase()), Number(md[2]));
    if (d.getTime() < sentMs - 60 * DAY) d.setFullYear(d.getFullYear() + 1);
    return dayOf(d.getTime());
  }
  return null;
}

export interface LifecycleMail { app: string; kind: Lifecycle; ts: number; until?: string }

/** Received mail from a sender that maps to an app, classified by subject. Senders that map to nothing are never read further. */
export function lifecycleMail(headers: MailHeader[], m: Matcher): LifecycleMail[] {
  const out: LifecycleMail[] = [];
  for (const h of headers) {
    if (h.dir !== "received" || !h.from) continue;
    const app = m.match("sender", h.from);
    if (!app) continue;
    const kind = lifecycleOf(h.subject);
    if (!kind) continue;
    const until = kind === "trial" || kind === "renewal" ? dateIn(h.subject, h.ts) : null;
    out.push({ app, kind, ts: h.ts, ...(until ? { until } : {}) });
  }
  return out;
}

export function lifecycleEvents(mail: LifecycleMail[], host: string): MetricEvent[] {
  const by = new Map<string, MetricEvent>();
  for (const l of mail) {
    const ts = dayOf(l.ts);
    const k = `${ts}\t${l.kind}\t${l.app}`;
    const e = by.get(k) ?? { ts, src: "receipts", kind: `app.${l.kind}`, n: 0, project: l.app, host, tier: "derived" as const, attrs: {} };
    e.n++;
    if (l.until) e.attrs.until = l.until;
    by.set(k, e);
  }
  return [...by.values()];
}

// ── Onto the records ────────────────────────────────────────────────────────

export interface MoneyRecord { app: string; cost?: { amount: number; period: "month" | "year"; source: string; confidence: number; set: string }; renewal?: { next: string; period: string; source: string }; trial?: { ends: string; source: string }; price_history?: { date: string; amount: number }[]; last_charge?: string; billed_twice?: boolean }

const PERIOD: Record<Freq, ["month" | "year", number]> = { weekly: ["month", 52 / 12], monthly: ["month", 1], quarterly: ["year", 4], yearly: ["year", 1] };

/** What the money sources say about each app, newest evidence first. */
/** The newest charge in the statements: series are live as of the statements, which are exported by hand and may end months ago. */
export const statementsThrough = (series: Series[]) => series.reduce((a, s) => (s.last.date > a ? s.last.date : a), "");

export function moneyByApp(series: Series[], plaid: MetricEvent[], mail: LifecycleMail[], now: number): Map<string, MoneyRecord> {
  const out = new Map<string, MoneyRecord>();
  const get = (app: string) => out.get(app) ?? out.set(app, { app }).get(app)!;
  const today = dayOf(now);
  const asOf = statementsThrough(series) || today;
  const stale = Date.parse(today) - Date.parse(asOf) > 45 * DAY;
  // Two live series for one app in the same period = billed twice.
  const live = series.filter((s) => s.app && s.next >= addDays(asOf, -15));
  for (const s of live) {
    const r = get(s.app!);
    const [period, mult] = PERIOD[s.freq];
    const amount = Math.round(s.last.usd * mult * 100) / 100;
    if (r.cost) { r.billed_twice = true; r.cost.amount = Math.round((r.cost.amount + (r.cost.period === period ? amount : period === "year" ? amount / 12 : amount * 12)) * 100) / 100; continue; }
    r.cost = { amount, period, source: stale ? `card statements through ${asOf}` : "card statements", confidence: stale ? 0.4 : s.mature ? 0.9 : 0.7, set: today };
    if (!stale) r.renewal = { next: s.next, period: s.freq, source: "card statements" };
    r.last_charge = s.last.date;
    if (s.price_changes.length) r.price_history = [{ date: s.charges[0]!.date, amount: s.charges[0]!.usd }, ...s.price_changes.map((p) => ({ date: p.date, amount: p.to }))];
  }
  for (const e of plaid) {
    if (!e.project || Number(e.attrs.active ?? 1) === 0) continue;
    const r = get(e.project);
    const monthly = Number(e.attrs.monthly ?? 0);
    const yearly = String(e.attrs.frequency) === "annually" || String(e.attrs.frequency) === "yearly";
    // Plaid sees the bank directly: it wins over a statement guess.
    r.cost = { amount: yearly ? Math.round(monthly * 12 * 100) / 100 : monthly, period: yearly ? "year" : "month", source: "plaid", confidence: String(e.attrs.status) === "mature" ? 0.95 : 0.8, set: today };
    if (e.attrs.next) r.renewal = { next: String(e.attrs.next), period: String(e.attrs.frequency), source: "plaid" };
    r.last_charge = e.ts;
  }
  for (const l of [...mail].sort((a, b) => a.ts - b.ts)) {
    const r = get(l.app);
    if (l.kind === "trial" && l.until) r.trial = { ends: l.until, source: "email" };
    if (l.kind === "renewal" && l.until && (!r.renewal || r.renewal.source === "email" || l.until > r.renewal.next)) r.renewal = { next: l.until, period: r.renewal?.period ?? "unknown", source: "email" };
  }
  return out;
}

/** Write cost, renewal, trial and price history onto the records. A cost the user stated is never replaced. */
export function applyMoney(vault: string, money: Map<string, MoneyRecord>): { updated: string[] } {
  const updated: string[] = [];
  const recs = new Map(readRecords(vault).filter((r) => !r.archived).map((r) => [r.id, r]));
  for (const [app, mr] of money) {
    if (!recs.has(app)) continue;
    const p = join(appsContainer(vault), app, "manifest.json");
    let m: Record<string, unknown>;
    try { m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { continue; }
    const before = JSON.stringify(m);
    const stated = (m.cost as { source?: string } | undefined)?.source === "stated";
    if (mr.cost && !stated) m.cost = mr.cost;
    if (mr.renewal) m.renewal = mr.renewal;
    if (mr.trial) m.trial = mr.trial;
    if (mr.last_charge) m.last_charge = mr.last_charge;
    if (mr.billed_twice) m.billed_twice = true;
    if (mr.price_history?.length) {
      const prior = Array.isArray(m.price_history) ? (m.price_history as { date: string; amount: number }[]) : [];
      const all = new Map([...prior, ...mr.price_history].map((x) => [x.date, x]));
      m.price_history = [...all.values()].sort((a, b) => a.date.localeCompare(b.date));
    }
    if (JSON.stringify(m) === before) continue;
    writeFileSync(`${p}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
    renameSync(`${p}.tmp`, p);
    updated.push(app);
  }
  return { updated };
}

export interface MoneyScan { series: number; matched: number; unmatched_recurring: number; lifecycle: number; updated: string[]; monthly_total: number; statements_through: string }

/** The A3 pass: card series, Plaid streams and lifecycle mail onto the records; unmatched recurring merchants to the inbox. */
export function moneyScan(vault: string, opts: { now?: number; host?: string } = {}): MoneyScan {
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const m = buildMatcher(vault);
  const charges = cardCharges(vault);
  const { series } = chargeEvents(vault, charges, m);
  const plaid = readMachineEvents(vault, dayOf(now - 400 * DAY)).events.filter((e) => e.src === "plaid" && e.kind === "money.recurring");
  const mail = lifecycleMail(readMailHeaders(vault), m);
  if (mail.length) writeSourceEvents(vault, "gmail", lifecycleEvents(mail, host), host, now, "receipts");
  const money = moneyByApp(series, plaid, mail, now);
  const { updated } = applyMoney(vault, money);
  // Recurring merchants that match no app: the unknown inbox on this Mac (merchant text only, nothing else).
  const asOf = statementsThrough(series) || dayOf(now);
  const unmatched = series.filter((s) => !s.app && !m.ignored("merchant", s.merchant) && s.next >= addDays(asOf, -15));
  const p = join(runtimePath(vault, "_meta"), "apps", "unknown-merchants.json");
  try { writeFileSync(p, `${JSON.stringify({ ts: new Date(now).toISOString(), merchants: unmatched.map((s) => ({ kind: "merchant", value: s.merchant, days: s.charges.length, last: s.last.date, n: s.charges.length, freq: s.freq })) }, null, 2)}\n`); } catch { /* the apps folder appears with the first scan */ }
  const monthly = [...money.values()].reduce((a, r) => a + (r.cost ? (r.cost.period === "year" ? r.cost.amount / 12 : r.cost.amount) : 0), 0);
  return { series: series.length, matched: series.filter((s) => s.app).length, unmatched_recurring: unmatched.length, lifecycle: mail.length, updated, monthly_total: Math.round(monthly * 100) / 100, statements_through: asOf };
}

export function readUnknownMerchants(vault: string): { kind: "merchant"; value: string; days: number; last: string; n: number; freq: string }[] {
  try { return (JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "apps", "unknown-merchants.json"), "utf8")) as { merchants: never[] }).merchants ?? []; } catch { return []; }
}
