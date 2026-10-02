// App and web usage on this Mac (and the iPhone through Screen Time sharing),
// as content-free counts. Apps plan A2.
//
// Signals, in the order they need permission:
//   - Spotlight's app inventory (last used, use count, category): none.
//   - Chromium-family history (Chrome, Atlas, Arc, Brave, Edge): daily visit
//     counts per registrable domain; readable without Full Disk Access.
//   - Live focus: the desktop app samples the frontmost app and idle time
//     (no permission) into ~/.prevail/cache/app-focus-live.json.
//   - With Full Disk Access: Screen Time's Biome streams (App.InFocus for the
//     Mac and, under remote/<device>, the iPhone; App.WebUsage), knowledgeC
//     (/app/usage, a local-only fallback) and Safari's History.db.
//
// Everything becomes events: build/_meta/events/apps/<YYYY-MM>.<host>.jsonl
// (app.focus minutes per bundle id, device and day; app.last_used from the
// inventory) and build/_meta/events/web/<YYYY-MM>.<host>.jsonl (web.visits per
// domain and day). No URL, title, path or query is ever written; health,
// finance, adult and dating domains are never recorded (domains.ts rules in
// app-map.ts). Stores are opened read-only from a private copy.

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dayOf, eventsRoot, hostSlug, type MetricEvent } from "./metrics.ts";
import { registrableDomain, webDomainAllowed } from "./app-map.ts";
import { runtimePath } from "./path-safety.ts";

// Seconds between 1970 and 2001-01-01 (Core Foundation absolute time).
export const CF_EPOCH = 978_307_200;
const cfToMs = (s: number) => (s + CF_EPOCH) * 1000;
const PLAUSIBLE = (ms: number) => ms > Date.UTC(2015, 0, 1) && ms < Date.UTC(2040, 0, 1);

export interface UsageRoots { home: string; apps: string[]; cache: string }
export function defaultUsageRoots(home = homedir()): UsageRoots {
  return { home, apps: ["/Applications", join(home, "Applications"), "/System/Applications"], cache: join(home, ".prevail", "cache") };
}

/** Open a SQLite store read-only from a private copy (with its WAL), so the live app is never touched. */
export function withCopy<T>(path: string, fn: (db: Database) => T): T | null {
  if (!existsSync(path)) return null;
  const tmp = join(tmpdir(), `prevail-usage-${process.pid}-${Math.random().toString(36).slice(2, 8)}-${basename(path).replace(/[^A-Za-z0-9.]/g, "_")}`);
  try {
    copyFileSync(path, tmp);
    for (const x of ["-wal", "-shm"]) if (existsSync(path + x)) copyFileSync(path + x, tmp + x);
    const db = new Database(tmp);
    try { return fn(db); } finally { db.close(); }
  } finally {
    for (const x of ["", "-wal", "-shm"]) rmSync(tmp + x, { force: true });
  }
}

// ── Permission: Full Disk Access ────────────────────────────────────────────

export type Access = "ok" | "needs-fda" | "absent";
/** Can this process read a TCC-protected folder? EPERM means Full Disk Access is missing. */
export function accessOf(path: string): Access {
  try { readdirSync(path); return "ok"; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES" ? "needs-fda" : "absent";
  }
}

// ── Spotlight inventory (no permission) ─────────────────────────────────────

export interface InstalledApp { bundle: string; name: string; path: string; category?: string; last_used?: string; use_count?: number }

/** Parse plain `mdls` output for several files at once: one block per file, a repeated key starts the next. */
export function parseMdls(text: string): Record<string, string | number | null>[] {
  const out: Record<string, string | number | null>[] = [];
  let cur: Record<string, string | number | null> = {};
  for (const line of text.split("\n")) {
    const m = /^(kMDItem\w+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, raw] = m as unknown as [string, string, string];
    if (k in cur) { out.push(cur); cur = {}; }
    let v: string | number | null = raw;
    if (raw === "(null)") v = null;
    else if (/^".*"$/.test(raw)) v = raw.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
    cur[k] = v;
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}

const MDLS_KEYS = ["kMDItemCFBundleIdentifier", "kMDItemDisplayName", "kMDItemAppStoreCategory", "kMDItemLastUsedDate", "kMDItemUseCount"];

export function spotlightInventory(roots: UsageRoots, run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] })): InstalledApp[] {
  const paths: string[] = [];
  for (const dir of roots.apps) {
    let es: string[] = [];
    try { es = readdirSync(dir); } catch { continue; }
    for (const e of es) {
      if (e.endsWith(".app")) paths.push(join(dir, e));
      else if (!e.startsWith(".") && !e.startsWith("archived-")) {
        // One level down (Utilities, vendor folders); never archived copies.
        try { for (const f of readdirSync(join(dir, e))) if (f.endsWith(".app")) paths.push(join(dir, e, f)); } catch { /* not a folder */ }
      }
    }
  }
  const out: InstalledApp[] = [];
  for (let i = 0; i < paths.length; i += 80) {
    const chunk = paths.slice(i, i + 80);
    let text = "";
    // mdls stops at a file it cannot read and exits 1; the blocks before it are still good.
    try { text = run("mdls", [...MDLS_KEYS.flatMap((k) => ["-name", k]), ...chunk]); } catch (e) { text = String((e as { stdout?: string }).stdout ?? ""); }
    const recs = parseMdls(text);
    // mdls prints the keys of each file in alphabetical order, one block per file.
    recs.forEach((r, j) => {
      const bundle = typeof r.kMDItemCFBundleIdentifier === "string" ? r.kMDItemCFBundleIdentifier : "";
      if (!bundle || !chunk[j]) return;
      const last = typeof r.kMDItemLastUsedDate === "string" ? r.kMDItemLastUsedDate.slice(0, 10) : undefined;
      out.push({
        bundle, name: typeof r.kMDItemDisplayName === "string" ? r.kMDItemDisplayName.replace(/\.app$/, "") : basename(chunk[j]!, ".app"), path: chunk[j]!,
        ...(typeof r.kMDItemAppStoreCategory === "string" ? { category: r.kMDItemAppStoreCategory } : {}),
        ...(last && /^\d{4}-\d{2}-\d{2}$/.test(last) ? { last_used: last } : {}),
        ...(typeof r.kMDItemUseCount === "number" ? { use_count: r.kMDItemUseCount } : {}),
      });
    });
  }
  return out;
}

// ── Chromium-family history (no permission) ─────────────────────────────────

export interface BrowserHistory { browser: string; file: string }

const CHROMIUM: [string, string][] = [
  ["chrome", "Library/Application Support/Google/Chrome"],
  ["atlas", "Library/Application Support/com.openai.atlas/browser-data/host"],
  ["arc", "Library/Application Support/Arc/User Data"],
  ["brave", "Library/Application Support/BraveSoftware/Brave-Browser"],
  ["edge", "Library/Application Support/Microsoft Edge"],
  ["chromium", "Library/Application Support/Chromium"],
  ["vivaldi", "Library/Application Support/Vivaldi"],
];

export function chromiumHistories(home: string): BrowserHistory[] {
  const out: BrowserHistory[] = [];
  for (const [browser, rel] of CHROMIUM) {
    const root = join(home, rel);
    let profiles: string[] = [];
    try { profiles = readdirSync(root); } catch { continue; }
    for (const p of profiles) {
      if (p === "System Profile" || p === "Guest Profile") continue;
      const f = join(root, p, "History");
      if (existsSync(f)) out.push({ browser, file: f });
    }
  }
  return out;
}

// Chromium stores visit_time as microseconds since 1601-01-01.
const WEBKIT_EPOCH_US = 11_644_473_600_000_000n;
export const chromeTimeToMs = (us: number | bigint) => Number((BigInt(us) - WEBKIT_EPOCH_US) / 1000n);
export const msToChromeTime = (ms: number) => (BigInt(ms) * 1000n + WEBKIT_EPOCH_US).toString();

export interface DomainDay { day: string; domain: string; n: number; via: string }

/** Visits per (day, registrable domain) since `sinceMs`. URLs are reduced to their domain in memory and dropped. */
export function chromiumDomainDays(h: BrowserHistory, sinceMs: number): DomainDay[] {
  const by = new Map<string, DomainDay>();
  withCopy(h.file, (db) => {
    const rows = db.query("SELECT v.visit_time AS t, u.url AS url FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time > ?").all(msToChromeTime(sinceMs)) as { t: number | bigint; url: string }[];
    for (const r of rows) addVisit(by, chromeTimeToMs(r.t), r.url, h.browser);
  });
  return [...by.values()];
}

function addVisit(by: Map<string, DomainDay>, ms: number, url: string, via: string): void {
  if (!PLAUSIBLE(ms)) return;
  let host = "";
  try { const u = new URL(url); if (u.protocol !== "http:" && u.protocol !== "https:") return; host = u.hostname; } catch { return; }
  const domain = registrableDomain(host);
  if (!domain || !webDomainAllowed(host, domain)) return;
  const day = dayOf(ms);
  const k = `${day}\t${domain}`;
  const d = by.get(k) ?? { day, domain, n: 0, via };
  d.n += 1;
  if (!d.via.split(",").includes(via)) d.via += `,${via}`;
  by.set(k, d);
}

/** Safari's History.db (Full Disk Access): visit_time is Core Foundation seconds. */
export function safariDomainDays(file: string, sinceMs: number): DomainDay[] {
  const by = new Map<string, DomainDay>();
  withCopy(file, (db) => {
    const rows = db.query("SELECT v.visit_time AS t, i.url AS url FROM history_visits v JOIN history_items i ON i.id = v.history_item WHERE v.visit_time > ?").all(sinceMs / 1000 - CF_EPOCH) as { t: number; url: string }[];
    for (const r of rows) addVisit(by, cfToMs(r.t), r.url, "safari");
  });
  return [...by.values()];
}

// ── Screen Time: Biome SEGB streams (Full Disk Access) ──────────────────────
//
// SEGB is Apple's segmented record file. Version 1 has a 56-byte header whose
// last four bytes are "SEGB" and records with a 32-byte header (length,
// state, two CF timestamps, crc). Version 2 starts with "SEGB", a 32-byte
// header, then records (8-byte crc header, data) whose end offsets, states and
// timestamps sit in a 16-byte-per-entry table at the end of the file. The
// payload of App.InFocus and App.WebUsage is a protobuf; it is decoded
// generically (field numbers are not documented), and a record whose shape
// does not yield a bundle id or a domain is counted as unknown, never guessed.

export interface SegbRecord { ts: number; state: number; data: Uint8Array }
export interface SegbFile { version: 1 | 2; records: SegbRecord[]; bad: number }

export function parseSegb(buf: Uint8Array): SegbFile | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = (o: number) => o + 4 <= buf.length && buf[o] === 0x53 && buf[o + 1] === 0x45 && buf[o + 2] === 0x47 && buf[o + 3] === 0x42;
  const records: SegbRecord[] = [];
  let bad = 0;
  if (magic(52)) {
    const end = Math.min(dv.getInt32(0, true), buf.length);
    let o = 56;
    while (o + 32 <= end) {
      const len = dv.getInt32(o, true);
      const state = dv.getInt32(o + 4, true);
      const t1 = dv.getFloat64(o + 8, true);
      if (len <= 0 || o + 32 + len > buf.length) { bad++; break; }
      const ms = cfToMs(t1);
      if (PLAUSIBLE(ms)) records.push({ ts: ms, state, data: buf.subarray(o + 32, o + 32 + len) });
      else bad++;
      o += 32 + len;
      o = (o + 7) & ~7;
    }
    return { version: 1, records, bad };
  }
  if (magic(0)) {
    const count = dv.getInt32(4, true);
    if (count < 0 || count > 1_000_000 || 32 + count * 16 > buf.length) return { version: 2, records, bad: 1 };
    const table = buf.length - count * 16;
    let start = 32;
    for (let i = 0; i < count; i++) {
      const e = table + i * 16;
      const endOff = dv.getInt32(e, true) + 32;
      const state = dv.getInt32(e + 4, true);
      const ms = cfToMs(dv.getFloat64(e + 8, true));
      if (endOff < start + 8 || endOff > table) { bad++; continue; }
      if (PLAUSIBLE(ms)) records.push({ ts: ms, state, data: buf.subarray(start + 8, endOff) });
      else bad++;
      start = (endOff + 3) & ~3;
    }
    return { version: 2, records, bad };
  }
  return null;
}

export type PbValue = { f: number; t: 0 | 1 | 2 | 5; v: number | bigint | Uint8Array };
/** A tolerant protobuf walk: top-level fields only; returns null when the bytes are not a protobuf. */
export function decodeProto(b: Uint8Array): PbValue[] | null {
  const out: PbValue[] = [];
  let o = 0;
  const varint = (): bigint | null => {
    let r = 0n; let s = 0n;
    for (let i = 0; i < 10 && o < b.length; i++) { const x = b[o++]!; r |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) return r; s += 7n; }
    return null;
  };
  while (o < b.length) {
    const key = varint();
    if (key === null) return null;
    const f = Number(key >> 3n); const t = Number(key & 7n);
    if (f <= 0) return null;
    if (t === 0) { const v = varint(); if (v === null) return null; out.push({ f, t: 0, v: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v }); }
    else if (t === 1) { if (o + 8 > b.length) return null; out.push({ f, t: 1, v: new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true) }); o += 8; }
    else if (t === 2) { const l = varint(); if (l === null || o + Number(l) > b.length) return null; out.push({ f, t: 2, v: b.subarray(o, o + Number(l)) }); o += Number(l); }
    else if (t === 5) { if (o + 4 > b.length) return null; out.push({ f, t: 5, v: new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true) }); o += 4; }
    else return null;
  }
  return out;
}

const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9_-]+){2,}$/;
// A bundle id leads with its reverse domain (com.example.App); a host ends with a TLD.
const REVERSE_LEAD = new Set(["com", "org", "net", "io", "us", "app", "dev", "co", "me", "ai", "so", "sh"]);
export function looksLikeHost(s: string): boolean {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) || s.length > 253) return false;
  const labels = s.toLowerCase().split(".");
  return /^[a-z]{2,12}$/.test(labels[labels.length - 1]!) && !REVERSE_LEAD.has(labels[0]!);
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
const strOf = (v: PbValue["v"]): string | null => { if (!(v instanceof Uint8Array) || !v.length || v.length > 300) return null; try { return utf8.decode(v); } catch { return null; } };

export interface FocusEvent { ts: number; bundle: string; starting: boolean | null }
/** One App.InFocus record: the bundle id is the reverse-DNS string field; field 1 as 0/1 is the start flag when present. */
export function inFocusOf(rec: SegbRecord): FocusEvent | null {
  const pb = decodeProto(rec.data);
  if (!pb) return null;
  const bundle = pb.map((x) => (x.t === 2 ? strOf(x.v) : null)).find((s): s is string => !!s && BUNDLE.test(s) && !s.includes("/"));
  if (!bundle) return null;
  const flag = pb.find((x) => x.f === 1 && x.t === 0 && (x.v === 0 || x.v === 1));
  const when = pb.find((x) => x.t === 1 && typeof x.v === "number" && PLAUSIBLE(cfToMs(x.v)));
  return { ts: when ? cfToMs(when.v as number) : rec.ts, bundle, starting: flag ? flag.v === 1 : null };
}

const CAP_MS = 60 * 60_000; // one focus stretch counts at most an hour (an idle screen)

/** Focus intervals from start/stop events: focus is exclusive, so the next app's start ends the last. */
export function focusMinutes(events: FocusEvent[]): Map<string, number> {
  const by = new Map<string, number>();
  const add = (bundle: string, from: number, to: number) => {
    const ms = Math.min(CAP_MS, Math.max(0, to - from));
    if (!ms) return;
    const k = `${dayOf(from)}\t${bundle}`;
    by.set(k, (by.get(k) ?? 0) + ms / 60_000);
  };
  let cur: { bundle: string; from: number } | null = null;
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.starting === false) { if (cur && cur.bundle === e.bundle) { add(cur.bundle, cur.from, e.ts); cur = null; } continue; }
    if (cur) add(cur.bundle, cur.from, e.ts);
    cur = { bundle: e.bundle, from: e.ts };
  }
  return by;
}

export interface BiomeRead { device: string; minutes: Map<string, number>; web: DomainDay[]; files: number; records: number; unknown: number; versions: number[] }

function segbFiles(dir: string): string[] {
  let es: string[] = [];
  try { es = readdirSync(dir); } catch { return []; }
  return es.filter((f) => !f.startsWith(".") && f !== "tombstone").map((f) => join(dir, f)).filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}

/** Read Biome's App.InFocus and App.WebUsage streams: `local` is this Mac, `remote/<id>` another device (the iPhone with Screen Time sharing on). */
export function readBiome(streams: string, sinceMs: number): BiomeRead[] {
  const out = new Map<string, BiomeRead>();
  const get = (device: string) => { let r = out.get(device); if (!r) { r = { device, minutes: new Map(), web: [], files: 0, records: 0, unknown: 0, versions: [] }; out.set(device, r); } return r; };
  const devices = (stream: string): [string, string][] => {
    const base = join(streams, stream);
    const ds: [string, string][] = [["mac", join(base, "local")]];
    try { for (const d of readdirSync(join(base, "remote"))) if (!d.startsWith(".")) ds.push([`device-${d.slice(0, 8).toLowerCase()}`, join(base, "remote", d)]); } catch { /* no remote */ }
    return ds;
  };
  for (const [device, dir] of devices("App.InFocus")) {
    const evs: FocusEvent[] = [];
    const r = get(device);
    for (const f of segbFiles(dir)) {
      try { if (statSync(f).mtimeMs < sinceMs) continue; } catch { continue; }
      const seg = parseSegb(readFileSync(f));
      if (!seg) { r.unknown++; continue; }
      r.files++;
      if (!r.versions.includes(seg.version)) r.versions.push(seg.version);
      r.unknown += seg.bad;
      for (const rec of seg.records) {
        if (rec.ts < sinceMs || rec.state === 3) continue;
        const e = inFocusOf(rec);
        if (e) { evs.push(e); r.records++; } else r.unknown++;
      }
    }
    for (const [k, v] of focusMinutes(evs)) r.minutes.set(k, (r.minutes.get(k) ?? 0) + v);
  }
  for (const [device, dir] of devices("App.WebUsage")) {
    const r = get(device);
    const by = new Map<string, DomainDay>();
    for (const f of segbFiles(dir)) {
      try { if (statSync(f).mtimeMs < sinceMs) continue; } catch { continue; }
      const seg = parseSegb(readFileSync(f));
      if (!seg) continue;
      r.files++;
      for (const rec of seg.records) {
        if (rec.ts < sinceMs) continue;
        const pb = decodeProto(rec.data);
        const host = pb?.map((x) => (x.t === 2 ? strOf(x.v) : null)).find((s): s is string => !!s && looksLikeHost(s));
        if (host) addVisit(by, rec.ts, `https://${host}/`, `screentime-${device}`);
      }
    }
    r.web.push(...by.values());
  }
  return [...out.values()].filter((r) => r.files > 0);
}

/** knowledgeC.db (/app/usage), the local-only Screen Time store: a fallback when Biome cannot be read. */
export function readKnowledgeC(file: string, sinceMs: number): Map<string, number> | null {
  return withCopy(file, (db) => {
    const by = new Map<string, number>();
    const rows = db.query("SELECT ZVALUESTRING AS b, ZSTARTDATE AS s, ZENDDATE AS e FROM ZOBJECT WHERE ZSTREAMNAME = '/app/usage' AND ZSTARTDATE > ?").all(sinceMs / 1000 - CF_EPOCH) as { b: string | null; s: number; e: number }[];
    for (const r of rows) {
      if (!r.b || !(r.e > r.s)) continue;
      const k = `${dayOf(cfToMs(r.s))}\t${r.b}`;
      by.set(k, (by.get(k) ?? 0) + Math.min(CAP_MS, (r.e - r.s) * 1000) / 60_000);
    }
    return by;
  });
}

/** The desktop's live sampler: { v:1, days: { "YYYY-MM-DD": { "<bundle>": seconds } } }. */
export function readLiveFocus(cache: string): Map<string, number> {
  const by = new Map<string, number>();
  try {
    const j = JSON.parse(readFileSync(join(cache, "app-focus-live.json"), "utf8")) as { days?: Record<string, Record<string, number>> };
    for (const [day, apps] of Object.entries(j.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      for (const [b, s] of Object.entries(apps)) if (BUNDLE.test(b) && typeof s === "number" && s > 0) by.set(`${day}\t${b}`, s / 60);
    }
  } catch { /* no sampler yet */ }
  return by;
}

// ── The scan ────────────────────────────────────────────────────────────────

export interface SourceHealth { state: "ok" | "needs-fda" | "absent" | "unknown-shape" | "off"; note?: string; files?: number; events?: number }
export interface UsageScan { host: string; ms: number; installed: number; sources: Record<string, SourceHealth>; events: { apps: number; web: number } }

function writeMonths(dir: string, events: MetricEvent[], host: string, months: string[]): number {
  let n = 0;
  for (const m of months) {
    const rows = events.filter((e) => e.ts.startsWith(m)).sort((a, b) => a.ts.localeCompare(b.ts) || (a.project ?? "").localeCompare(b.project ?? "") || String(a.attrs.device ?? "").localeCompare(String(b.attrs.device ?? "")));
    const file = join(dir, `${m}.${host}.jsonl`);
    if (!rows.length && !existsSync(file)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, rows.map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : ""));
    renameSync(`${file}.tmp`, file);
    n += rows.length;
  }
  return n;
}

const pad = (n: number) => String(n).padStart(2, "0");
function monthsBack(now: number, back: number): string[] {
  const out: string[] = [];
  const d = new Date(now);
  for (let i = back; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}`); }
  return out;
}

export interface UsageOpts { roots?: UsageRoots; host?: string; now?: number; days?: number; inventory?: InstalledApp[]; consent?: (id: string) => boolean }

/**
 * Read every app and web signal this Mac allows and rewrite this host's
 * apps/ and web/ event files for the months the window covers (90 days by
 * default, the Chromium history horizon; Screen Time keeps about four weeks,
 * so older months are kept as written). Health per source goes to
 * build/_meta/apps/usage-sources.<host>.json.
 */
export function scanAppUsage(vault: string, opts: UsageOpts = {}): UsageScan {
  const t0 = Date.now();
  const roots = opts.roots ?? defaultUsageRoots();
  const host = opts.host ?? hostSlug();
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 90;
  const since = now - days * 86_400_000;
  const on = opts.consent ?? (() => true);
  const sources: Record<string, SourceHealth> = {};
  const appEv: MetricEvent[] = [];
  const webBy = new Map<string, DomainDay>();
  const mergeWeb = (ds: DomainDay[]) => { for (const d of ds) { const k = `${d.day}\t${d.domain}`; const c = webBy.get(k); if (c) { c.n += d.n; for (const v of d.via.split(",")) if (!c.via.split(",").includes(v)) c.via += `,${v}`; } else webBy.set(k, { ...d }); } };

  // Inventory.
  const inv = opts.inventory ?? (on("spotlight") ? spotlightInventory(roots) : []);
  sources.spotlight = on("spotlight") ? { state: inv.length ? "ok" : "absent", files: inv.length } : { state: "off" };
  for (const a of inv) {
    if (!a.last_used || Date.parse(a.last_used) < since) continue;
    appEv.push({ ts: a.last_used, src: "apps", kind: "app.last_used", n: a.use_count ?? 1, project: a.bundle, host, tier: "measured", attrs: { device: "mac", via: "spotlight", ...(a.category ? { category: a.category } : {}) } });
  }

  // Focus minutes: Biome first, then knowledgeC, then the live sampler (Mac only, never twice for one day).
  const focus = new Map<string, number>(); // device \t day \t bundle -> minutes
  const macDays = new Set<string>();
  const biomeRoot = join(roots.home, "Library", "Biome", "streams", "restricted");
  if (on("screentime")) {
    const acc = accessOf(biomeRoot);
    if (acc === "ok") {
      try {
        const reads = readBiome(biomeRoot, since);
        let rec = 0; let unknown = 0;
        for (const r of reads) {
          rec += r.records; unknown += r.unknown;
          for (const [k, v] of r.minutes) { focus.set(`${r.device}\t${k}`, v); if (r.device === "mac") macDays.add(k.split("\t")[0]!); }
          mergeWeb(r.web);
        }
        sources.screentime = rec === 0 && unknown > 0
          ? { state: "unknown-shape", note: `Biome records found (${unknown}) but none read as app focus; the stream format may have changed`, files: reads.reduce((a, r) => a + r.files, 0) }
          : { state: reads.length ? "ok" : "absent", files: reads.reduce((a, r) => a + r.files, 0), events: rec, ...(unknown ? { note: `${unknown} records skipped` } : {}) };
      } catch (e) { sources.screentime = { state: "unknown-shape", note: String(e).slice(0, 160) }; }
    } else sources.screentime = { state: acc === "needs-fda" ? "needs-fda" : "absent", note: acc === "needs-fda" ? "grant Full Disk Access to Prevail to read Screen Time" : undefined };
    const kc = join(roots.home, "Library", "Application Support", "Knowledge", "knowledgeC.db");
    const kacc = accessOf(join(roots.home, "Library", "Application Support", "Knowledge"));
    if (kacc === "ok") {
      try {
        const m = readKnowledgeC(kc, since);
        let n = 0;
        for (const [k, v] of m ?? []) { const day = k.split("\t")[0]!; if (macDays.has(day)) continue; focus.set(`mac\t${k}`, (focus.get(`mac\t${k}`) ?? 0) + v); n++; }
        for (const k of m?.keys() ?? []) macDays.add(k.split("\t")[0]!);
        sources.knowledgec = { state: m ? "ok" : "absent", events: n };
      } catch (e) { sources.knowledgec = { state: "unknown-shape", note: String(e).slice(0, 160) }; }
    } else sources.knowledgec = { state: kacc === "needs-fda" ? "needs-fda" : "absent" };
  } else { sources.screentime = { state: "off" }; sources.knowledgec = { state: "off" }; }
  if (on("live-focus")) {
    const live = readLiveFocus(roots.cache);
    let n = 0;
    for (const [k, v] of live) { const day = k.split("\t")[0]!; if (macDays.has(day) || Date.parse(day) < since) continue; focus.set(`mac\t${k}`, v); n++; }
    sources["live-focus"] = { state: live.size ? "ok" : "absent", events: n, ...(live.size ? {} : { note: "the desktop app samples the frontmost app while it runs" }) };
  } else sources["live-focus"] = { state: "off" };
  for (const [k, min] of focus) {
    const [device, day, bundle] = k.split("\t") as [string, string, string];
    if (min < 0.5) continue;
    appEv.push({ ts: day, src: "apps", kind: "app.focus", n: 1, project: bundle, host, tier: "measured", attrs: { minutes: Math.round(min * 10) / 10, device: device === "mac" ? "mac" : device, via: sources.screentime?.state === "ok" ? "screentime" : sources.knowledgec?.state === "ok" ? "knowledgec" : "live" } });
  }

  // Web: Chromium-family histories and Safari.
  if (on("browsers")) {
    const hs = chromiumHistories(roots.home);
    let read = 0;
    for (const h of hs) { try { mergeWeb(chromiumDomainDays(h, since)); read++; } catch { /* a locked or odd profile */ } }
    sources.browsers = { state: hs.length ? "ok" : "absent", files: read, note: [...new Set(hs.map((h) => h.browser))].join(", ") || undefined };
    const safariDir = join(roots.home, "Library", "Safari");
    const sacc = accessOf(safariDir);
    if (sacc === "ok" && existsSync(join(safariDir, "History.db"))) {
      try { mergeWeb(safariDomainDays(join(safariDir, "History.db"), since)); sources.safari = { state: "ok" }; } catch (e) { sources.safari = { state: "needs-fda", note: String(e).slice(0, 120) }; }
    } else sources.safari = { state: sacc === "needs-fda" ? "needs-fda" : "absent" };
  } else { sources.browsers = { state: "off" }; sources.safari = { state: "off" }; }
  const webEv: MetricEvent[] = [...webBy.values()].map((d) => ({ ts: d.day, src: "web", kind: "web.visits", n: d.n, project: d.domain, host, tier: "measured", attrs: { via: d.via } }));

  // Months covered by the window; Screen Time's older months stay as written.
  const months = monthsBack(now, Math.ceil(days / 30));
  const root = eventsRoot(vault);
  const apps = writeMonths(join(root, "apps"), appEv, host, months.slice(-2));
  const web = writeMonths(join(root, "web"), webEv, host, months);
  const report: UsageScan = { host, ms: Date.now() - t0, installed: inv.length, sources, events: { apps, web } };
  try {
    const dir = join(runtimePath(vault, "_meta"), "apps");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `usage-sources.${host}.json`), `${JSON.stringify({ ts: new Date(now).toISOString(), ...report, inventory: inv.map(({ path: _p, ...a }) => a) }, null, 2)}\n`);
  } catch { /* best-effort */ }
  return report;
}

/** This host's last inventory (from the usage scan), for records and the stack view. */
export function readInventory(vault: string, host = hostSlug()): InstalledApp[] {
  try { return (JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "apps", `usage-sources.${host}.json`), "utf8")) as { inventory?: InstalledApp[] }).inventory ?? []; } catch { return []; }
}

/** Every host's usage-source health (what each Mac could read). */
export function readUsageHealth(vault: string): Record<string, Record<string, SourceHealth> & { _ts?: never }> {
  const dir = join(runtimePath(vault, "_meta"), "apps");
  const out: Record<string, Record<string, SourceHealth>> = {};
  let fs: string[] = [];
  try { fs = readdirSync(dir).filter((f) => /^usage-sources\..+\.json$/.test(f)); } catch { return out; }
  for (const f of fs) { try { out[f.slice(14, -5)] = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { sources: Record<string, SourceHealth> }).sources; } catch { /* skip */ } }
  return out;
}
