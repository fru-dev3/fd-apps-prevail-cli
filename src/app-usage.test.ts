import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMatcher, correctSignal, registrableDomain, upsertRecord, webDomainAllowed } from "./app-map.ts";
import { appsScan, computeUsage, ensureRecords, suggestFor } from "./app-stack.ts";
import {
  accessOf, CF_EPOCH, chromiumDomainDays, decodeProto, focusMinutes, inFocusOf, looksLikeHost, msToChromeTime, parseMdls, parseSegb, readBiome,
  readKnowledgeC, readLiveFocus, safariDomainDays, scanAppUsage, spotlightInventory,
} from "./app-usage.ts";
import { consented, ConsentError, requireConsent, setConsent } from "./sources.ts";

const ROOT = join("/tmp", `prevail-appusage-${process.pid}`);
const V = join(ROOT, "vault");
const HOME = join(ROOT, "home");
afterAll(() => { try { chmodSync(join(HOME, "Library", "Biome"), 0o755); } catch { /* ok */ } rmSync(ROOT, { recursive: true, force: true }); });

// Wednesday 2026-09-30, noon local.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m, 0).getTime();
const cf = (ms: number) => ms / 1000 - CF_EPOCH;

// ── Fixture writers: protobuf and SEGB v1/v2 ────────────────────────────────
function varint(n: number): number[] { const out: number[] = []; let v = n; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return out; }
function pb(fields: [number, "v" | "s" | "d", number | string][]): Uint8Array {
  const out: number[] = [];
  for (const [f, t, v] of fields) {
    if (t === "v") out.push(...varint((f << 3) | 0), ...varint(v as number));
    else if (t === "s") { const b = new TextEncoder().encode(v as string); out.push(...varint((f << 3) | 2), ...varint(b.length), ...b); }
    else { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v as number, true); out.push(...varint((f << 3) | 1), ...b); }
  }
  return new Uint8Array(out);
}
function segbV1(recs: { ts: number; data: Uint8Array; state?: number }[]): Uint8Array {
  const parts: number[] = new Array(56).fill(0);
  for (const r of recs) {
    const h = new Uint8Array(32); const dv = new DataView(h.buffer);
    dv.setInt32(0, r.data.length, true); dv.setInt32(4, r.state ?? 1, true); dv.setFloat64(8, cf(r.ts), true); dv.setFloat64(16, cf(r.ts), true);
    parts.push(...h, ...r.data);
    while (parts.length % 8) parts.push(0);
  }
  const buf = new Uint8Array(parts);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, buf.length, true);
  buf.set([0x53, 0x45, 0x47, 0x42], 52);
  return buf;
}
function segbV2(recs: { ts: number; data: Uint8Array }[]): Uint8Array {
  const body: number[] = [];
  const table: number[] = [];
  for (const r of recs) {
    body.push(0, 0, 0, 0, 0, 0, 0, 0, ...r.data);
    const end = body.length;
    while (body.length % 4) body.push(0);
    const e = new Uint8Array(16); const dv = new DataView(e.buffer);
    dv.setInt32(0, end, true); dv.setInt32(4, 1, true); dv.setFloat64(8, cf(r.ts), true);
    table.push(...e);
  }
  const head = new Uint8Array(32); head.set([0x53, 0x45, 0x47, 0x42], 0); new DataView(head.buffer).setInt32(4, recs.length, true);
  return new Uint8Array([...head, ...body, ...table]);
}
const focus = (bundle: string, starting: boolean) => pb([[1, "v", starting ? 1 : 0], [3, "s", bundle]]);

function seedHome() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "entities", "products"), { recursive: true });
  // Biome: this Mac (v1) and a phone (v2).
  const st = join(HOME, "Library", "Biome", "streams", "restricted");
  mkdirSync(join(st, "App.InFocus", "local"), { recursive: true });
  mkdirSync(join(st, "App.InFocus", "remote", "ABCDEF12-PHONE"), { recursive: true });
  writeFileSync(join(st, "App.InFocus", "local", "100"), segbV1([
    { ts: at(29, 9), data: focus("com.example.FooEditor", true) },
    { ts: at(29, 9, 30), data: focus("com.example.FooEditor", false) },
    { ts: at(29, 10), data: focus("com.example.BarChat", true) },
    { ts: at(29, 10, 20), data: focus("us.zoom.xos", true) }, // ends BarChat at 20 min
    { ts: at(29, 10, 50), data: focus("us.zoom.xos", false) },
    { ts: at(29, 11), data: pb([[2, "s", "not a bundle"]]) }, // unknown shape
  ]));
  writeFileSync(join(st, "App.InFocus", "remote", "ABCDEF12-PHONE", "200"), segbV2([
    { ts: at(30, 8), data: focus("com.example.FooPhoneApp", true) },
    { ts: at(30, 8, 15), data: focus("com.example.FooPhoneApp", false) },
  ]));
  mkdirSync(join(st, "App.WebUsage", "local"), { recursive: true });
  writeFileSync(join(st, "App.WebUsage", "local", "300"), segbV1([{ ts: at(29, 12), data: pb([[1, "s", "com.apple.Safari"], [2, "s", "news.example.org"]]) }]));
  // Chromium history (Chrome, one profile).
  const ch = join(HOME, "Library", "Application Support", "Google", "Chrome", "Default");
  mkdirSync(ch, { recursive: true });
  const db = new Database(join(ch, "History"));
  db.run("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)");
  db.run("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
  const urls = ["https://mail.google.com/mail/u/0/#inbox?secret=1", "https://github.com/foo/bar/pull/1", "https://www.mybank-example.com/acct", "https://foo.vercel.app/x", "https://accounts.google.com/signin", "https://news.example.co.uk/a?b", "https://chase.com/x", "chrome://settings"];
  urls.forEach((u, i) => db.run("INSERT INTO urls VALUES (?, ?, ?)", [i + 1, u, `title ${i}`]));
  let id = 1;
  for (const day of [27, 28, 29]) for (let u = 1; u <= urls.length; u++) db.run("INSERT INTO visits VALUES (?, ?, ?)", [id++, u, msToChromeTime(at(day, 14))]);
  db.run("INSERT INTO visits VALUES (?, ?, ?)", [id++, 2, msToChromeTime(at(1, 1) - 200 * 86_400_000)]); // too old
  db.close();
  // knowledgeC and Safari fixtures.
  mkdirSync(join(HOME, "Library", "Application Support", "Knowledge"), { recursive: true });
  const kc = new Database(join(HOME, "Library", "Application Support", "Knowledge", "knowledgeC.db"));
  kc.run("CREATE TABLE ZOBJECT (Z_PK INTEGER PRIMARY KEY, ZSTREAMNAME TEXT, ZVALUESTRING TEXT, ZSTARTDATE REAL, ZENDDATE REAL)");
  kc.run("INSERT INTO ZOBJECT VALUES (1, '/app/usage', 'com.example.KcApp', ?, ?)", [cf(at(28, 9)), cf(at(28, 9, 45))]);
  kc.run("INSERT INTO ZOBJECT VALUES (2, '/app/usage', 'com.example.FooEditor', ?, ?)", [cf(at(29, 15)), cf(at(29, 15, 10))]); // Biome has the 29th: skipped
  kc.run("INSERT INTO ZOBJECT VALUES (3, '/safari/history', 'x', ?, ?)", [cf(at(28, 9)), cf(at(28, 10))]);
  kc.close();
  mkdirSync(join(HOME, "Library", "Safari"), { recursive: true });
  const sf = new Database(join(HOME, "Library", "Safari", "History.db"));
  sf.run("CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, domain_expansion TEXT)");
  sf.run("CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)");
  sf.run("INSERT INTO history_items VALUES (1, 'https://www.github.com/foo', 'github')");
  sf.run("INSERT INTO history_visits VALUES (1, 1, ?, 'a title')", [cf(at(30, 7))]);
  sf.close();
  // The live sampler (Mac; the 29th is covered by Biome, so only the 30th counts).
  mkdirSync(join(HOME, ".prevail", "cache"), { recursive: true });
  writeFileSync(join(HOME, ".prevail", "cache", "app-focus-live.json"), JSON.stringify({ v: 1, days: { "2026-09-29": { "com.example.FooEditor": 600 }, "2026-09-30": { "com.example.LiveApp": 900, "not-a-bundle": 30 } } }));
}

const roots = () => ({ home: HOME, apps: [join(HOME, "Applications")], cache: join(HOME, ".prevail", "cache") });
const inventory = [
  { bundle: "com.example.FooEditor", name: "Foo Editor", path: "/x", category: "Developer Tools", last_used: "2026-09-29", use_count: 12 },
  { bundle: "com.example.OldThing", name: "Old Thing", path: "/y", last_used: "2026-01-02" },
  { bundle: "com.apple.Notes", name: "Notes", path: "/z", last_used: "2026-09-30" },
];

describe("formats", () => {
  test("SEGB v1 and v2 records parse with their timestamps", () => {
    const v1 = parseSegb(segbV1([{ ts: at(29, 9), data: focus("com.example.A", true) }, { ts: at(29, 10), data: focus("com.example.B", true) }]))!;
    expect(v1.version).toBe(1);
    expect(v1.records.map((r) => r.ts)).toEqual([at(29, 9), at(29, 10)]);
    const v2 = parseSegb(segbV2([{ ts: at(30, 8), data: focus("com.example.C", true) }]))!;
    expect(v2.version).toBe(2);
    expect(inFocusOf(v2.records[0]!)).toEqual({ ts: at(30, 8), bundle: "com.example.C", starting: true });
    expect(parseSegb(new Uint8Array(64))).toBeNull();
  });
  test("a protobuf without a bundle id is unknown, never guessed", () => {
    expect(inFocusOf({ ts: at(29, 9), state: 1, data: pb([[2, "s", "hello world"]]) })).toBeNull();
    expect(decodeProto(new Uint8Array([0xff, 0xff]))).toBeNull();
  });
  test("focus is exclusive; a stretch counts at most an hour", () => {
    const m = focusMinutes([
      { ts: at(29, 9), bundle: "a.b.c", starting: true }, { ts: at(29, 9, 10), bundle: "d.e.f", starting: true },
      { ts: at(29, 9, 25), bundle: "d.e.f", starting: false }, { ts: at(29, 12), bundle: "g.h.i", starting: true }, { ts: at(29, 15), bundle: "a.b.c", starting: true },
    ]);
    expect(m.get("2026-09-29\ta.b.c")).toBe(10);
    expect(m.get("2026-09-29\td.e.f")).toBe(15);
    expect(m.get("2026-09-29\tg.h.i")).toBe(60);
  });
  test("domains: registrable domain, private suffixes, never-recorded classes", () => {
    expect(registrableDomain("mail.google.com")).toBe("google.com");
    expect(registrableDomain("news.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("foo.vercel.app")).toBe("foo.vercel.app");
    expect(registrableDomain("192.168.1.2")).toBe("");
    expect(webDomainAllowed("www.mybank-example.com")).toBe(false);
    expect(webDomainAllowed("chase.com")).toBe(false);
    expect(webDomainAllowed("accounts.google.com")).toBe(false);
    expect(webDomainAllowed("fonts.gstatic.com")).toBe(false);
    expect(webDomainAllowed("github.com")).toBe(true);
    expect(looksLikeHost("news.example.org")).toBe(true);
    expect(looksLikeHost("com.apple.Safari")).toBe(false);
  });
  test("mdls output for several apps splits into one block each", () => {
    const t = 'kMDItemAppStoreCategory = "Productivity"\nkMDItemCFBundleIdentifier = "com.example.A"\nkMDItemDisplayName = "A.app"\nkMDItemLastUsedDate = 2026-09-29 10:00:00 +0000\nkMDItemUseCount = 4\nkMDItemAppStoreCategory = (null)\nkMDItemCFBundleIdentifier = "com.example.B"\nkMDItemDisplayName = "B"\nkMDItemLastUsedDate = (null)\nkMDItemUseCount = (null)\n';
    const r = parseMdls(t);
    expect(r).toHaveLength(2);
    expect(r[0]!.kMDItemUseCount).toBe(4);
    expect(r[1]!.kMDItemLastUsedDate).toBeNull();
    mkdirSync(join(ROOT, "apps", "A.app"), { recursive: true });
    mkdirSync(join(ROOT, "apps", "B.app"), { recursive: true });
    const inv = spotlightInventory({ home: HOME, apps: [join(ROOT, "apps")], cache: "" }, () => t);
    expect(inv.map((a) => [a.bundle, a.name, a.last_used ?? null])).toEqual([["com.example.A", "A", "2026-09-29"], ["com.example.B", "B", null]]);
  });
});

describe("reading this Mac", () => {
  beforeEach(seedHome);
  test("Biome: minutes per app and device; an unreadable record is counted, not guessed", () => {
    const r = readBiome(join(HOME, "Library", "Biome", "streams", "restricted"), at(1, 0));
    const mac = r.find((x) => x.device === "mac")!;
    expect(mac.minutes.get("2026-09-29\tcom.example.FooEditor")).toBe(30);
    expect(mac.minutes.get("2026-09-29\tcom.example.BarChat")).toBe(20);
    expect(mac.minutes.get("2026-09-29\tus.zoom.xos")).toBe(30);
    expect(mac.unknown).toBe(1);
    expect(mac.web.map((w) => w.domain)).toEqual(["example.org"]);
    const phone = r.find((x) => x.device.startsWith("device-"))!;
    expect(phone.minutes.get("2026-09-30\tcom.example.FooPhoneApp")).toBe(15);
  });
  test("Chromium, Safari, knowledgeC and the live sampler", () => {
    const d = chromiumDomainDays({ browser: "chrome", file: join(HOME, "Library", "Application Support", "Google", "Chrome", "Default", "History") }, at(1, 0));
    expect(d.filter((x) => x.day === "2026-09-29").map((x) => x.domain).sort()).toEqual(["example.co.uk", "foo.vercel.app", "github.com", "google.com"]);
    expect(safariDomainDays(join(HOME, "Library", "Safari", "History.db"), at(1, 0)).map((x) => x.domain)).toEqual(["github.com"]);
    const kc = readKnowledgeC(join(HOME, "Library", "Application Support", "Knowledge", "knowledgeC.db"), at(1, 0))!;
    expect(kc.get("2026-09-28\tcom.example.KcApp")).toBe(45);
    const live = readLiveFocus(join(HOME, ".prevail", "cache"));
    expect(live.get("2026-09-30\tcom.example.LiveApp")).toBe(15);
    expect(live.has("2026-09-30\tnot-a-bundle")).toBe(false);
  });
  test("the scan writes counts only: no URL, path, query or title, no finance site", () => {
    const r = scanAppUsage(V, { roots: roots(), host: "mac-a", now: NOW, inventory });
    expect(r.sources.screentime!.state).toBe("ok");
    expect(r.sources.safari!.state).toBe("ok");
    const files = ["apps", "web"].flatMap((s) => readdirSync(join(V, "build", "_meta", "events", s)).map((f) => readFileSync(join(V, "build", "_meta", "events", s, f), "utf8"))).join("");
    for (const bad of ["inbox", "secret", "pull/1", "title", "/acct", "mybank", "chase", "accounts.google", "signin"]) expect(files).not.toContain(bad);
    const ev = files.trim().split("\n").map((l) => JSON.parse(l));
    const focusRows = ev.filter((e) => e.kind === "app.focus");
    expect(focusRows.find((e) => e.project === "com.example.FooEditor" && e.ts === "2026-09-29").attrs.minutes).toBe(30); // Biome wins over knowledgeC and live
    expect(focusRows.find((e) => e.project === "com.example.KcApp")).toBeTruthy(); // a day Biome lacks
    expect(focusRows.find((e) => e.project === "com.example.LiveApp" && e.ts === "2026-09-30")).toBeTruthy();
    expect(focusRows.find((e) => e.project === "com.example.FooPhoneApp").attrs.device).toMatch(/^device-/);
    expect(ev.filter((e) => e.kind === "web.visits" && e.project === "google.com").map((e) => e.n)).toEqual([1, 1, 1]);
    expect(ev.find((e) => e.kind === "app.last_used" && e.project === "com.example.FooEditor").n).toBe(12);
    expect(ev.find((e) => e.project === "com.example.OldThing")).toBeUndefined();
  });
  test("without Full Disk Access the state says so", () => {
    const b = join(HOME, "Library", "Biome");
    chmodSync(b, 0o000);
    try {
      expect(accessOf(join(b, "streams", "restricted"))).toBe("needs-fda");
      const r = scanAppUsage(V, { roots: roots(), host: "mac-a", now: NOW, inventory });
      expect(r.sources.screentime!.state).toBe("needs-fda");
      expect(r.sources.screentime!.note).toContain("Full Disk Access");
    } finally { chmodSync(b, 0o755); }
  });
  test("consent off: the source is not read at all", () => {
    const r = scanAppUsage(V, { roots: roots(), host: "mac-a", now: NOW, inventory, consent: (id) => id !== "browsers" && id !== "screentime" });
    expect(r.sources.browsers!.state).toBe("off");
    expect(r.sources.screentime!.state).toBe("off");
    expect(r.events.web).toBe(0);
  });
});

describe("mapping, records and the unknown inbox", () => {
  beforeEach(seedHome);
  test("records for vendors seen; never overwritten; archived never recreated", () => {
    mkdirSync(join(V, "data", "entities", "products", "zoom"), { recursive: true });
    writeFileSync(join(V, "data", "entities", "products", "zoom", "manifest.json"), JSON.stringify({ id: "zoom", name: "My Zoom", integration: "mcp", domains: ["work"] }));
    mkdirSync(join(V, "data", "entities", "products", "_archive", "github"), { recursive: true });
    writeFileSync(join(V, "data", "entities", "products", "_archive", "github", "manifest.json"), JSON.stringify({ id: "github" }));
    scanAppUsage(V, { roots: roots(), host: "mac-a", now: NOW, inventory });
    const u = computeUsage(V, { now: NOW });
    expect(u.apps.zoom!.minutes_30d).toBe(30);
    const r = ensureRecords(V, u, inventory, { now: NOW });
    expect(r.updated).toContain("zoom");
    expect(r.archived_seen).toContain("github");
    expect(existsSync(join(V, "data", "entities", "products", "github"))).toBe(false);
    const z = JSON.parse(readFileSync(join(V, "data", "entities", "products", "zoom", "manifest.json"), "utf8"));
    expect(z.name).toBe("My Zoom");
    expect(z.integration).toBe("mcp");
    expect(z.domains).toEqual(["work"]);
    expect(z.identifiers.bundle_ids).toEqual(["us.zoom.xos"]);
    expect(z.first_seen).toBeUndefined(); // only on creation
    expect(r.created).toContain("foo-editor"); // a third-party app opened in 90 days
    expect(r.created).not.toContain("old-thing");
    expect(r.created).not.toContain("notes"); // Apple's own apps are the OS
    const again = ensureRecords(V, computeUsage(V, { now: NOW }), inventory, { now: NOW });
    expect(again.created).toEqual([]);
  });
  test("a correction becomes a rule on the record and wins; an ignore leaves the inbox", () => {
    scanAppUsage(V, { roots: roots(), host: "mac-a", now: NOW, inventory });
    let u = computeUsage(V, { now: NOW });
    expect(u.unknown.find((x) => x.value === "example.co.uk")?.days).toBe(3);
    expect(u.unknown.find((x) => x.value === "com.example.BarChat")).toBeTruthy();
    correctSignal(V, "domain", "example.co.uk", "foo-news");
    correctSignal(V, "bundle", "com.example.BarChat", "ignore");
    u = computeUsage(V, { now: NOW });
    expect(u.apps["foo-news"]!.web_visits_30d).toBe(3);
    expect(u.unknown.find((x) => x.value === "com.example.BarChat")).toBeUndefined();
    const m = JSON.parse(readFileSync(join(V, "data", "entities", "products", "foo-news", "manifest.json"), "utf8"));
    expect(m.identifiers.domains).toEqual(["example.co.uk"]);
    // A record's identifier beats the alias table.
    upsertRecord(V, { id: "my-meetings", name: "Meetings", identifiers: { bundle_ids: ["us.zoom.xos"] } });
    expect(buildMatcher(V).match("bundle", "us.zoom.xos")).toBe("my-meetings");
    expect(buildMatcher(V).match("merchant", "SQ *ZOOM.US 888-799")).toBe("zoom");
    expect(buildMatcher(V).match("sender", "billing@mail.notion.so")).toBe("notion");
    expect(suggestFor("unrelated.example", [{ id: "news", name: "News" }])).toBeUndefined();
    expect(suggestFor("zoom-meetings.example", [{ id: "zoom", name: "Zoom" }])).toBe("zoom");
  });
  test("appsScan writes the usage and unknown caches", () => {
    const r = appsScan(V, { now: NOW, consent: () => false });
    expect(r.usage.events.web).toBe(0);
    expect(existsSync(join(V, "build", "_meta", "apps", "usage.json"))).toBe(true);
    expect(existsSync(join(V, "build", "_meta", "apps", "unknown.json"))).toBe(true);
  });
});

describe("consent", () => {
  beforeEach(seedHome);
  test("defaults: nothing-new sources on, connections and wave 3-4 off; unknown never", () => {
    expect(consented(V, "browsers")).toBe(true);
    expect(consented(V, "gmail")).toBe(true);
    expect(consented(V, "youtube")).toBe(false);
    expect(consented(V, "photos")).toBe(false);
    expect(consented(V, "messages")).toBe(false);
    expect(consented(V, "nope")).toBe(false);
    expect(() => requireConsent(V, "photos")).toThrow(ConsentError);
    setConsent(V, "photos", true);
    expect(() => requireConsent(V, "photos")).not.toThrow();
    setConsent(V, "browsers", false);
    expect(consented(V, "browsers")).toBe(false);
    expect(() => setConsent(V, "nope", true)).toThrow();
  });
});
