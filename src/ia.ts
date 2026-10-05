// The information architecture (ia-plan.md, phase IA0): everything the user
// keeps belongs to one of two groups and one of six kinds.
//
//   Entities    People    data/entities/people/<slug>/
//               Places    data/entities/places/<slug>/
//               Products  data/entities/products/<slug>/ (page and app parts in one folder)
//               Things    data/entities/things/<slug>/ (items the user owns)
//   Activities  Events    data/entities/events/<slug>/
//               Projects  data/missions/<slug>/ (stored as missions)
//
// Tasks, decisions and routines are not kinds: they stay where they are and
// relate to these objects by links. This module is a registry and a set of
// adapters over the stores.
//
//   Products   one folder per company (data/entities/products/<slug>/) holds
//              its page and, when it has a connector, its app parts; "app" is
//              a property (manifest.integration), not a place. An app record
//              whose folder differs from its company (same title, web domain
//              or the manifest's `company`) still shows on that company's row;
//              an app with no company is its own row under product/<id>, and
//              its page is written only when the user saves or notes it.
//   Things     owned items: purchased, warranty, value, maker (a Product),
//              place (a Place) and a service history, in the page frontmatter.
//   Events     dated happenings: date, end, time, place, people, project, and
//              whether it went to the user's calendar (only on their yes).
//              The calendar strip also shows the connected calendar
//              (build/calendar-external.json), every project's dated
//              milestones and its holds; opening one adopts it as a page.
//   Links      any object to any other, kept once in data/entities/links.json
//              and shown on both sides, beside the links a page's own fields
//              and a project's people, entities and apps already make.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildIndex, findEntity, listPages, newPage, parseEntityId, parseList, readIndex, readPage, saveEntity, setNotes, setWebsite, slugify, writePage, yamlStr,
  type EntityIndex, type EntityKind, type PageDoc,
} from "./entities.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { moneyOf, oneQuestion, parseModelJson, realYmd } from "./mission-draft.ts";
import { attach, createMission, detach, listMissionSlugs, missionSlugify, readLinks, readMilestones, readMission } from "./missions.ts";
import { buildRoot, entitiesContainer, hasAppContent, isAppFolder, productFolders } from "./path-safety.ts";
import type { RouteRunner } from "./route.ts";
import { vreadFile, vwriteFileAtomic } from "./vault-session.ts";

// ── The registry ────────────────────────────────────────────────────────────

export type Group = "entities" | "activities";
export type KindId = "people" | "places" | "products" | "things" | "events" | "projects";
export interface KindDef {
  id: KindId; group: Group; label: string; singular: string;
  /** A lucide icon name, the same in every client. */
  icon: string;
  /** The id prefix of its objects (person/<slug>, mission/<slug>, ...). */
  prefix: string;
  /** Where its objects live, vault-relative. */
  store: string;
}

export const GROUPS: readonly { id: Group; label: string }[] = [{ id: "entities", label: "Entities" }, { id: "activities", label: "Activities" }];
export const KINDS: readonly KindDef[] = [
  { id: "people", group: "entities", label: "People", singular: "Person", icon: "Users", prefix: "person", store: "data/entities/people/" },
  { id: "places", group: "entities", label: "Places", singular: "Place", icon: "MapPin", prefix: "place", store: "data/entities/places/" },
  { id: "products", group: "entities", label: "Products", singular: "Product", icon: "Package", prefix: "product", store: "data/entities/products/" },
  { id: "things", group: "entities", label: "Things", singular: "Thing", icon: "Watch", prefix: "thing", store: "data/entities/things/" },
  { id: "events", group: "activities", label: "Events", singular: "Event", icon: "CalendarDays", prefix: "event", store: "data/entities/events/" },
  { id: "projects", group: "activities", label: "Projects", singular: "Project", icon: "FolderKanban", prefix: "mission", store: "data/missions/" },
];

/** The kind an id belongs to: person/ place/ product/ thing/ event/ mission/ project/ (legacy app/ reads as product/). */
export function kindOf(id: string): KindDef | null {
  const head = (id.trim().replace(/^prevail:\/\//, "").split("/")[0] ?? "").toLowerCase();
  // Legacy heads from before products (app/, org/) read as product/.
  const p = head === "app" || head === "org" ? "product" : head === "project" ? "mission" : head;
  return KINDS.find((k) => k.prefix === p || k.id === head) ?? null;
}

export { IA_VOCABULARY } from "./chief-of-staff.ts";

const now0 = () => Date.now();
const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, " ").replace(/\s*[\u2013\u2014]\s*/g, ", ").trim().slice(0, n);
const unq = (v: string | undefined) => (v ?? "").trim().replace(/^["']|["']$/g, "").trim();
const hostOf = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";

function indexOf(vault: string): EntityIndex {
  const i = readIndex(vault);
  return i.generated_ts ? i : buildIndex(vault);
}

/** An id in its one canonical form: project/ to mission/, app/<id> to its product, a name to <kind>/<slug>. */
export function canonId(vault: string, raw: string, kindHint?: EntityKind): string {
  const s = raw.trim().replace(/^prevail:\/\//, "");
  if (/^(mission|project)\//i.test(s)) return `mission/${missionSlugify(s.slice(s.indexOf("/") + 1))}`;
  if (/^app\//i.test(s)) {
    const appId = s.slice(4);
    const row = listProducts(vault).find((p) => p.apps.some((a) => a.id === appId));
    return row?.id ?? `product/${slugify(appId)}`;
  }
  const p = parseEntityId(s);
  if (!p) return "";
  const kind = p.kind ?? kindHint ?? null;
  return kind ? `${kind === "project" ? "mission" : kind}/${p.slug}` : "";
}

// ── Products: one list over product folders (page and app parts) ────────────

export interface AppRecord { id: string; title: string; kind?: string; category?: string; domains: string[]; company?: string; integration?: string; archived?: boolean }
export interface ProductRow {
  id: string; name: string;
  /** A company the user talks about (a product in the index or with a page). */
  company: boolean;
  /** The app records this product carries (data/entities/products/<id>), first is primary. */
  apps: AppRecord[];
  website?: string; domain?: string; picture?: string;
  saved: boolean; has_page: boolean; conversations: number; last_ts: number;
  relation: "yours" | "reference"; home_domain?: string;
}

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
/** Every app record under data/entities/products: id, title and identity from its manifest, never its data. */
export function appRecords(vault: string): AppRecord[] {
  const out: AppRecord[] = [];
  for (const { id: name, dir } of productFolders(vault)) {
    if (!hasAppContent(dir)) continue; // a page-only product carries no app
    const e = { name };
    let m: Record<string, unknown> = {};
    const mp = join(dir, "manifest.json");
    if (existsSync(mp)) { try { m = JSON.parse(vreadFile(mp)) as Record<string, unknown>; } catch { m = {}; } }
    const ids = (m.identifiers && typeof m.identifiers === "object" ? m.identifiers : {}) as { domains?: unknown };
    const domains = Array.isArray(ids.domains) ? ids.domains.filter((d): d is string => typeof d === "string").map(hostOf).filter(Boolean) : [];
    const title = typeof m.title === "string" && m.title.trim() ? m.title.trim() : typeof m.name === "string" && m.name.trim() ? m.name.trim() : e.name;
    out.push({
      id: e.name, title, domains,
      ...(typeof m.kind === "string" ? { kind: m.kind } : {}),
      ...(typeof m.category === "string" ? { category: m.category } : {}),
      ...(typeof m.company === "string" && m.company.trim() ? { company: m.company.trim() } : {}),
      ...(typeof m.integration === "string" && m.integration.trim() ? { integration: m.integration.trim() } : {}),
      ...(isAppFolder(dir) ? {} : { archived: true }),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Products: every company and every app, one row each, an app shown on its company's row. */
export function listProducts(vault: string, idx: EntityIndex = indexOf(vault)): ProductRow[] {
  const rows = new Map<string, ProductRow>();
  const byHost = new Map<string, string>();
  for (const e of idx.entities) {
    if (e.kind !== "product") continue;
    rows.set(e.id, {
      id: e.id, name: e.name, company: true, apps: [], saved: !!e.saved, has_page: !!e.page, conversations: e.conversations, last_ts: e.last_ts,
      relation: e.relation ?? "yours", ...(e.website ? { website: e.website } : {}), ...(e.domain ? { domain: e.domain } : {}),
      ...(e.picture ? { picture: join(vault, e.picture) } : {}), ...(e.home_domain ? { home_domain: e.home_domain } : {}),
    });
    for (const h of [hostOf(e.domain), hostOf(e.website)]) if (h && !byHost.has(h)) byHost.set(h, e.id);
  }
  for (const a of appRecords(vault)) {
    const keys = [`product/${a.id}`, ...[a.company, a.id, a.title].map((x) => (x ? `product/${slugify(x)}` : ""))].filter(Boolean);
    const id = keys.find((k) => rows.has(k)) ?? a.domains.map((h) => byHost.get(h)).find((x): x is string => !!x);
    if (id) {
      const r = rows.get(id)!;
      r.apps.push(a);
      r.relation = "yours"; // the user keeps an app for it
      if (!r.domain && a.domains[0]) r.domain = a.domains[0];
      continue;
    }
    const own = APP_ID_RE.test(a.id) ? `product/${a.id}` : `product/${slugify(a.id) || slugify(a.title)}`;
    if (own === "product/") continue;
    rows.set(own, { id: own, name: a.title, company: false, apps: [a], saved: false, has_page: false, conversations: 0, last_ts: 0, relation: "yours", ...(a.domains[0] ? { domain: a.domains[0], website: a.domains[0] } : {}) });
    for (const h of a.domains) if (!byHost.has(h)) byHost.set(h, own);
  }
  // A product folder with neither a page in the index nor app parts (files
  // only, e.g. a statement) is still a product.
  const carried = new Set([...rows.values()].flatMap((r) => r.apps.map((x) => x.id)));
  for (const { id: name } of productFolders(vault)) {
    const id = `product/${APP_ID_RE.test(name) ? name : slugify(name)}`;
    if (id === "product/" || rows.has(id) || carried.has(name)) continue;
    rows.set(id, { id, name, company: false, apps: [], saved: false, has_page: false, conversations: 0, last_ts: 0, relation: "yours" });
  }
  return [...rows.values()].sort((x, y) => y.conversations - x.conversations || y.last_ts - x.last_ts || x.name.localeCompare(y.name));
}

/** The app ids a product carries that a chat can open (valid app ids only). */
export function productAppIds(vault: string, id: string): string[] {
  if (!/^product\//.test(id)) return [];
  const row = listProducts(vault).find((p) => p.id === id);
  return (row?.apps ?? []).map((a) => a.id).filter((x) => APP_ID_RE.test(x));
}

// ── Fields: what a Thing or an Event knows about itself ─────────────────────

export interface ServiceEntry { date: string; what: string; cost?: number }
export interface ObjectFields {
  // events
  date?: string; end?: string; time?: string; people?: string[]; project?: string;
  calendar?: "ask" | "synced" | "declined"; calendar_event?: string; milestone?: string;
  // things
  purchased?: string; warranty?: string; value?: number; maker?: string; service?: ServiceEntry[];
  // both
  place?: string;
}
const FIELD_KINDS: Record<string, EntityKind[]> = {
  date: ["event"], end: ["event"], time: ["event"], people: ["event"], project: ["event"], calendar: ["event"], calendar_event: ["event"], milestone: ["event"],
  purchased: ["thing"], warranty: ["thing"], value: ["thing"], maker: ["thing"], service: ["thing"],
  place: ["event", "thing"],
};
export const FIELD_NAMES = Object.keys(FIELD_KINDS);
/** Fields whose value is another object's id: a link that shows on both sides. */
const REF_FIELDS = ["place", "maker", "project", "people"] as const;

export function readFields(doc: PageDoc): ObjectFields {
  const x = doc.extra;
  const f: ObjectFields = {};
  for (const k of ["date", "end", "purchased", "warranty"] as const) { const v = realYmd(unq(x[k])); if (v) f[k] = v; }
  const t = unq(x.time); if (/^\d{2}:\d{2}$/.test(t)) f.time = t;
  for (const k of ["place", "maker", "project", "calendar_event", "milestone"] as const) { const v = unq(x[k]); if (v) f[k] = v; }
  const cal = unq(x.calendar); if (cal === "ask" || cal === "synced" || cal === "declined") f.calendar = cal;
  const val = moneyOf(unq(x.value)); if (x.value != null && val !== null) f.value = val;
  if (x.people) f.people = parseList(x.people);
  if (x.service) { try { const s = JSON.parse(x.service.trim()) as unknown; if (Array.isArray(s)) f.service = s.filter((e): e is ServiceEntry => !!e && typeof (e as ServiceEntry).date === "string" && typeof (e as ServiceEntry).what === "string"); } catch { /* kept verbatim */ } }
  return f;
}

/** One field's value checked and normalized for the page, or null to clear it. Throws on a bad value. */
function normField(vault: string, key: string, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (["date", "end", "purchased", "warranty"].includes(key)) { const d = realYmd(v); if (!d) throw new Error(`${key} must be a real date (YYYY-MM-DD), not "${v}"`); return yamlStr(d); }
  if (key === "time") { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`time must be HH:MM, not "${v}"`); return yamlStr(v); }
  if (key === "value") { const n = moneyOf(v); if (n === null) throw new Error(`value must be an amount, not "${v}"`); return String(n); }
  if (key === "calendar") { if (!["ask", "synced", "declined"].includes(v)) throw new Error("calendar is ask, synced or declined"); return v; }
  if (key === "place") { const id = canonId(vault, v.includes("/") ? v : `place/${v}`); if (!id.startsWith("place/")) throw new Error(`place must be a place, not "${v}"`); return yamlStr(id); }
  if (key === "maker") { const id = canonId(vault, v.includes("/") ? v : `product/${v}`); if (!id.startsWith("product/")) throw new Error(`maker must be a product, not "${v}"`); return yamlStr(id); }
  if (key === "project") {
    const id = canonId(vault, v.includes("/") ? v : `mission/${v}`);
    if (!id.startsWith("mission/") || !readMission(vault, id)) throw new Error(`no project "${v}"`);
    return yamlStr(id);
  }
  if (key === "people") {
    const ids = [...new Set(parseList(v.startsWith("[") ? v : `[${v}]`).map((p) => canonId(vault, p.includes("/") ? p : `person/${p}`)).filter((p) => p.startsWith("person/")))];
    return ids.length ? `[${ids.map(yamlStr).join(", ")}]` : null;
  }
  if (key === "service") return v; // JSON, written by addService only
  return yamlStr(oneLine(v, 200));
}

/** The page for an id, made (saved) when there is none yet. */
function pageFor(vault: string, id: string, now: number, name?: string): { kind: EntityKind; slug: string; doc: PageDoc } {
  const p = parseEntityId(id);
  if (!p?.kind || p.kind === "project") throw new Error(`"${id}" is not a person, place, product, thing or event`);
  const rec = findEntity(indexOf(vault), `${p.kind}/${p.slug}`);
  const kind = (rec?.kind ?? p.kind) as EntityKind;
  const slug = rec ? rec.id.slice(rec.id.indexOf("/") + 1) : p.slug;
  const doc = readPage(vault, kind, slug) ?? newPage({ name: name?.trim() || rec?.name || slug, kind, aliases: rec?.aliases ?? [] }, true, now);
  return { kind, slug, doc };
}

/** Set (or, with "", clear) fields on a Thing or an Event. The page is written once; a project link is mirrored on the project. */
export function setFields(vault: string, id: string, patch: Record<string, string | null | undefined>, o: { now?: number; name?: string } = {}): { id: string; fields: ObjectFields } {
  const now = o.now ?? now0();
  const { kind, slug, doc } = pageFor(vault, id, now, o.name);
  const oid = `${kind}/${slug}`;
  const before = readFields(doc).project;
  for (const [k, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (!FIELD_KINDS[k]) throw new Error(`unknown field "${k}": one of ${FIELD_NAMES.join(", ")}`);
    if (!FIELD_KINDS[k]!.includes(kind)) throw new Error(`a ${kind} has no ${k}`);
    const v = normField(vault, k, raw ?? "");
    if (v === null) delete doc.extra[k]; else doc.extra[k] = v;
  }
  doc.saved = true;
  doc.updated = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  writePage(vault, kind, slug, doc);
  const after = readFields(doc).project;
  // The project's own list names the event too, so its chat brings it along.
  if (before !== after) {
    if (before) { try { detach(vault, before, "entity", oid, now); } catch { /* the project is gone */ } }
    if (after) { try { attach(vault, after, "entity", oid, now); } catch { /* checked above */ } }
  }
  buildIndex(vault, { now });
  return { id: oid, fields: readFields(doc) };
}

/** Add one dated line to a Thing's service history. */
export function addService(vault: string, id: string, e: { date?: string; what: string; cost?: string | number }, now = now0()): ServiceEntry[] {
  const { kind, slug, doc } = pageFor(vault, id, now);
  if (kind !== "thing") throw new Error("a service history belongs to a thing");
  const date = realYmd(e.date ?? ymd(now));
  if (!date) throw new Error(`date must be a real date, not "${e.date}"`);
  const what = oneLine(e.what ?? "", 160);
  if (what.length < 2) throw new Error("say what was done");
  const cost = e.cost == null || e.cost === "" ? null : moneyOf(e.cost);
  if (e.cost != null && e.cost !== "" && cost === null) throw new Error(`cost must be an amount, not "${e.cost}"`);
  const list = [...(readFields(doc).service ?? []), { date, what, ...(cost !== null ? { cost } : {}) }].sort((a, b) => a.date.localeCompare(b.date));
  doc.extra.service = JSON.stringify(list);
  doc.saved = true;
  writePage(vault, kind, slug, doc);
  return list;
}

// ── Links: any object to any other, both ways ───────────────────────────────

export interface LinkRec { a: string; b: string; ts: string }
const linksPath = (vault: string) => join(entitiesContainer(vault), "links.json");

export function readLinkRecs(vault: string): LinkRec[] {
  try {
    const j = JSON.parse(vreadFile(linksPath(vault))) as { links?: unknown };
    return Array.isArray(j.links) ? j.links.filter((r): r is LinkRec => !!r && typeof (r as LinkRec).a === "string" && typeof (r as LinkRec).b === "string") : [];
  } catch { return []; }
}

function updateLinks(vault: string, fn: (l: LinkRec[]) => LinkRec[]): void {
  const p = linksPath(vault);
  const lock = tryAcquireLock(`${p}.lock`);
  try { vwriteFileAtomic(p, `${JSON.stringify({ links: fn(readLinkRecs(vault)) }, null, 2)}\n`); } finally { lock?.release(); }
}

function checkLinkable(vault: string, raw: string): string {
  const id = canonId(vault, raw);
  if (!id || !kindOf(id)) throw new Error(`"${raw}" is not a person, place, product, thing, event or project`);
  if (id.startsWith("mission/") && !readMission(vault, id)) throw new Error(`no project "${raw}"`);
  return id;
}

/** Link two objects. Kept once; shown on both. Linking twice is a no-op. */
export function linkObjects(vault: string, rawA: string, rawB: string, now = now0()): { a: string; b: string; added: boolean } {
  const a = checkLinkable(vault, rawA);
  const b = checkLinkable(vault, rawB);
  if (a === b) throw new Error("an object cannot link to itself");
  let added = false;
  updateLinks(vault, (l) => {
    if (l.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))) return l;
    added = true;
    return [...l, { a, b, ts: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z") }];
  });
  return { a, b, added };
}

export function unlinkObjects(vault: string, rawA: string, rawB: string): { removed: boolean } {
  const a = canonId(vault, rawA);
  const b = canonId(vault, rawB);
  let removed = false;
  updateLinks(vault, (l) => l.filter((r) => { const hit = (r.a === a && r.b === b) || (r.a === b && r.b === a); if (hit) removed = true; return !hit; }));
  return { removed };
}

export interface LinkView {
  id: string; name: string; kind: KindId;
  /** link: kept in links.json (removable); field: a page field; project: a project's own list. */
  via: "link" | "field" | "project";
  /** The field that makes it, seen from this side (maker, place, project, people), or the other side's (made, here, ...). */
  role?: string;
}
const ROLE_IN: Record<string, string> = { place: "here", maker: "made", project: "event", people: "with" };

/** Everything an object is linked to, from both sides, one row per object. */
export function linksOf(vault: string, raw: string): { id: string; links: LinkView[] } {
  const id = canonId(vault, raw);
  if (!id) return { id: raw, links: [] };
  const idx = indexOf(vault);
  const products = listProducts(vault, idx);
  const out = new Map<string, Omit<LinkView, "name" | "kind">>();
  const put = (other: string, v: Omit<LinkView, "id" | "name" | "kind">) => {
    if (!other || other === id || !kindOf(other)) return;
    const cur = out.get(other);
    // A removable link wins over a derived one: the user can take it back.
    if (!cur || (v.via === "link" && cur.via !== "link")) out.set(other, { id: other, ...v });
  };
  for (const r of readLinkRecs(vault)) { if (r.a === id) put(r.b, { via: "link" }); else if (r.b === id) put(r.a, { via: "link" }); }
  // Page fields: this page's own references, and every page that names it.
  const refsOf = (doc: PageDoc): [string, string][] => {
    const f = readFields(doc);
    return [
      ...(f.place ? [["place", f.place] as [string, string]] : []), ...(f.maker ? [["maker", f.maker] as [string, string]] : []),
      ...(f.project ? [["project", f.project] as [string, string]] : []), ...(f.people ?? []).map((p) => ["people", p] as [string, string]),
    ];
  };
  for (const p of listPages(vault)) {
    const pid = `${p.kind}/${p.slug}`;
    for (const [field, ref] of refsOf(p.doc)) {
      const target = canonId(vault, ref);
      if (pid === id) put(target, { via: "field", role: field });
      else if (target === id) put(pid, { via: "field", role: ROLE_IN[field] ?? field });
    }
  }
  // Projects: their people, entities and apps.
  const myApps = new Set(products.find((p) => p.id === id)?.apps.map((a) => a.id) ?? []);
  for (const slug of listMissionSlugs(vault)) {
    const m = readMission(vault, slug);
    if (!m) continue;
    const members = [...m.people, ...m.entities].map((x) => canonId(vault, x)).filter(Boolean);
    const appRows = m.apps.map((a) => products.find((p) => p.apps.some((x) => x.id === a))?.id ?? "").filter(Boolean);
    if (m.id === id) { for (const x of [...members, ...appRows]) put(x, { via: "project" }); continue; }
    if (members.includes(id) || m.apps.some((a) => myApps.has(a))) put(m.id, { via: "project" });
  }
  const links: LinkView[] = [...out.values()].map((l) => ({ ...l, name: nameOf(vault, l.id, idx, products), kind: kindOf(l.id)!.id }));
  links.sort((x, y) => KINDS.findIndex((k) => k.id === x.kind) - KINDS.findIndex((k) => k.id === y.kind) || x.name.localeCompare(y.name));
  return { id, links };
}

/** A display name for any id. */
export function nameOf(vault: string, id: string, idx: EntityIndex = indexOf(vault), products?: ProductRow[]): string {
  if (id.startsWith("mission/")) return readMission(vault, id)?.name ?? id.slice(8);
  const rec = findEntity(idx, id);
  if (rec) return rec.name;
  const p = parseEntityId(id);
  if (p?.kind) { const doc = readPage(vault, p.kind, p.slug); if (doc) return doc.name; }
  if (id.startsWith("product/")) { const row = (products ?? listProducts(vault, idx)).find((r) => r.id === id); if (row) return row.name; }
  return (p?.slug ?? id).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Events: the calendar strip ──────────────────────────────────────────────

export type EventSource = "prevail" | "calendar" | "milestone" | "hold";
export interface EventRow {
  /** event/<slug> for a page; calendar:<id>, milestone:<slug>:<ms> or hold:<slug>:<id> until it is opened. */
  id: string; name: string; date: string; end?: string; time?: string;
  source: EventSource; has_page: boolean;
  project?: { id: string; name: string }; place?: { id: string; name: string };
  calendar?: ObjectFields["calendar"]; account?: string; url?: string; done?: boolean;
}

interface ExternalEvent { id: string; title: string; date: string; url?: string; account?: string }
function externalEvents(vault: string): ExternalEvent[] {
  try {
    const j = JSON.parse(readFileSync(join(buildRoot(vault), "calendar-external.json"), "utf8")) as unknown;
    return Array.isArray(j) ? j.filter((e): e is ExternalEvent => !!e && typeof (e as ExternalEvent).id === "string" && typeof (e as ExternalEvent).title === "string" && !!realYmd((e as ExternalEvent).date)) : [];
  } catch { return []; }
}

/** Every dated happening: event pages, the connected calendar, project milestones and holds. Sorted by date. */
export function listEvents(vault: string, o: { from?: string; to?: string } = {}): EventRow[] {
  const idx = indexOf(vault);
  const rows: EventRow[] = [];
  const adopted = new Set<string>();
  const projectName = new Map<string, string>();
  const proj = (pid?: string) => {
    if (!pid) return undefined;
    if (!projectName.has(pid)) projectName.set(pid, readMission(vault, pid)?.name ?? "");
    const name = projectName.get(pid);
    return name ? { id: pid, name } : undefined;
  };
  for (const p of listPages(vault)) {
    if (p.kind !== "event") continue;
    const f = readFields(p.doc);
    if (f.calendar_event) adopted.add(f.calendar_event);
    if (f.milestone) adopted.add(f.milestone);
    const pr = proj(f.project);
    rows.push({
      id: `event/${p.slug}`, name: p.doc.name, date: f.date ?? "", source: "prevail", has_page: true,
      ...(f.end ? { end: f.end } : {}), ...(f.time ? { time: f.time } : {}), ...(pr ? { project: pr } : {}),
      ...(f.place ? { place: { id: f.place, name: nameOf(vault, f.place, idx) } } : {}), ...(f.calendar ? { calendar: f.calendar } : {}),
    });
  }
  for (const e of externalEvents(vault)) {
    if (adopted.has(e.id)) continue;
    rows.push({ id: `calendar:${e.id}`, name: e.title, date: e.date, source: "calendar", has_page: false, calendar: "synced", ...(e.account ? { account: e.account } : {}), ...(e.url ? { url: e.url } : {}) });
  }
  for (const slug of listMissionSlugs(vault)) {
    const m = readMission(vault, slug);
    if (!m || m.status === "archived") continue;
    const pr = { id: m.id, name: m.name };
    for (const ms of readMilestones(vault, slug)) {
      const key = `${slug}:${ms.id}`;
      if (!ms.due || adopted.has(key)) continue;
      rows.push({ id: `milestone:${key}`, name: ms.title, date: ms.due, source: "milestone", has_page: false, project: pr, done: ms.done });
    }
    for (const c of readLinks(vault, slug).calendar) {
      if (c.source !== "created" || adopted.has(c.event)) continue;
      const date = c.start.slice(0, 10);
      if (!realYmd(date)) continue;
      const time = /T(\d{2}:\d{2})/.exec(c.start)?.[1];
      rows.push({ id: `hold:${slug}:${c.event}`, name: c.title, date, ...(time ? { time } : {}), source: "hold", has_page: false, project: pr, calendar: c.event.startsWith("pending-") ? "ask" : "synced" });
    }
  }
  const inRange = (r: EventRow) => !r.date || ((!o.from || (r.end ?? r.date) >= o.from) && (!o.to || r.date <= o.to));
  return rows.filter(inRange).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.time ?? "").localeCompare(b.time ?? "") || a.name.localeCompare(b.name));
}

export interface EventInput { name: string; date: string; end?: string; time?: string; place?: string; people?: string[]; project?: string; notes?: string; calendarEvent?: string; milestone?: string; calendar?: "ask" | "synced" }

/** A new event page. The same name on the same date is the same event (returned, not duplicated). */
export function createEvent(vault: string, i: EventInput, now = now0()): { id: string; created: boolean } {
  const name = oneLine(i.name ?? "", 120);
  if (name.length < 2) throw new Error("an event needs a name");
  const date = realYmd(i.date);
  if (!date) throw new Error(`an event needs a real date (YYYY-MM-DD), not "${i.date}"`);
  let slug = slugify(name);
  for (let n = 1; ; n++) {
    const doc = readPage(vault, "event", slug);
    if (!doc) break;
    if (readFields(doc).date === date) return { id: `event/${slug}`, created: false };
    slug = n === 1 ? slugify(`${name} ${date.slice(0, 4)}`) : slugify(`${name} ${date} ${n}`);
  }
  const doc = newPage({ name, kind: "event", aliases: [] }, true, now);
  writePage(vault, "event", slug, doc);
  const id = `event/${slug}`;
  setFields(vault, id, {
    date, end: i.end, time: i.time, place: i.place, people: i.people?.join(", "), project: i.project,
    calendar_event: i.calendarEvent, milestone: i.milestone, calendar: i.calendar,
  }, { now });
  if (i.notes?.trim()) setNotes(vault, id, i.notes, { kind: "event", now });
  return { id, created: true };
}

/** Open a strip row as a first-class event: a calendar entry, a milestone or a hold gets its page (once). */
export function adoptEvent(vault: string, rowId: string, now = now0()): { id: string; created: boolean } {
  if (/^event\//.test(rowId)) return { id: canonId(vault, rowId), created: false };
  const row = listEvents(vault).find((r) => r.id === rowId);
  if (!row) throw new Error(`no event "${rowId}"`);
  if (row.source === "calendar") return createEvent(vault, { name: row.name, date: row.date, calendarEvent: rowId.slice("calendar:".length), calendar: "synced" }, now);
  if (row.source === "milestone") return createEvent(vault, { name: row.name, date: row.date, project: row.project?.id, milestone: rowId.slice("milestone:".length) }, now);
  const ev = rowId.split(":").slice(2).join(":");
  return createEvent(vault, { name: row.name, date: row.date, time: row.time, project: row.project?.id, calendarEvent: ev, calendar: row.calendar === "synced" ? "synced" : "ask" }, now);
}

export interface CalendarWrite { title: string; date: string; time?: string; end?: string }
export type CalendarWriter = (e: CalendarWrite) => Promise<{ ok: boolean; id?: string; error?: string }>;

/** Put an event on the user's own primary calendar through the gws CLI. */
export async function gwsEventWriter(e: CalendarWrite): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const cs = await import("./calendar-sync.ts");
    const gws = cs.resolveGwsBinary();
    if (!gws) return { ok: false, error: "no Google calendar is connected on this Mac" };
    const allDay = !e.time;
    const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const startDt = allDay ? null : new Date(`${e.date}T${e.time}:00`);
    const body = allDay
      ? { summary: e.title, start: { date: e.date }, end: { date: next(e.end ?? e.date) } }
      : { summary: e.title, start: { dateTime: startDt!.toISOString() }, end: { dateTime: new Date(startDt!.getTime() + 3_600_000).toISOString() } };
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(gws, ["calendar", "events", "insert", "--params", JSON.stringify({ calendarId: "primary" }), "--json", JSON.stringify(body)], { encoding: "utf8", timeout: 30_000, env: cs.gwsSpawnEnv() });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "the calendar refused").slice(0, 160) };
    try { return { ok: true, id: String((JSON.parse(r.stdout) as { id?: string }).id ?? "") || undefined }; } catch { return { ok: true }; }
  } catch (err) { return { ok: false, error: String(err).slice(0, 160) }; }
}

/**
 * The calendar question for an event. Without the user's yes nothing touches a
 * calendar: the event is only marked as asked (or declined, on their no). With
 * yes, it is written to their own calendar once.
 */
export async function eventToCalendar(vault: string, id: string, o: { yes?: boolean; no?: boolean; write?: CalendarWriter; now?: number } = {}): Promise<{ id: string; calendar: "ask" | "synced" | "declined"; note?: string }> {
  const now = o.now ?? now0();
  const cid = canonId(vault, id, "event");
  const p = parseEntityId(cid);
  const doc = p?.kind === "event" ? readPage(vault, "event", p.slug) : null;
  if (!doc) throw new Error(`no event "${id}"`);
  const f = readFields(doc);
  if (f.calendar === "synced") return { id: cid, calendar: "synced" };
  if (o.no) { setFields(vault, cid, { calendar: "declined" }, { now }); return { id: cid, calendar: "declined" }; }
  if (!o.yes) { setFields(vault, cid, { calendar: "ask" }, { now }); return { id: cid, calendar: "ask", note: "waiting for your yes; nothing was added to a calendar" }; }
  if (!f.date) throw new Error("the event has no date");
  const r = await (o.write ?? gwsEventWriter)({ title: doc.name, date: f.date, ...(f.time ? { time: f.time } : {}), ...(f.end ? { end: f.end } : {}) });
  if (!r.ok) { setFields(vault, cid, { calendar: "ask" }, { now }); return { id: cid, calendar: "ask", note: `not added: ${r.error ?? "the calendar could not be reached"}` }; }
  setFields(vault, cid, { calendar: "synced", calendar_event: r.id ?? "" }, { now });
  return { id: cid, calendar: "synced" };
}

/**
 * An event becomes (or joins) a project: "Christmas" the event, "Plan
 * Christmas" the project, due on the event's date. With `project`, the event
 * links to that existing project instead.
 */
export function eventToProject(vault: string, id: string, o: { project?: string; now?: number } = {}): { event: string; project: { id: string; name: string }; created: boolean } {
  const now = o.now ?? now0();
  const cid = canonId(vault, id, "event");
  const p = parseEntityId(cid);
  const doc = p?.kind === "event" ? readPage(vault, "event", p.slug) : null;
  if (!doc) throw new Error(`no event "${id}"`);
  const f = readFields(doc);
  if (o.project) {
    const pid = canonId(vault, o.project.includes("/") ? o.project : `mission/${o.project}`);
    const m = readMission(vault, pid);
    if (!m) throw new Error(`no project "${o.project}"`);
    setFields(vault, cid, { project: m.id }, { now });
    return { event: cid, project: { id: m.id, name: m.name }, created: false };
  }
  if (f.project) { const m = readMission(vault, f.project); if (m) return { event: cid, project: { id: m.id, name: m.name }, created: false }; }
  if (!f.date) throw new Error("the event needs a date first");
  if (f.date < ymd(now)) throw new Error("the event has passed");
  const name = `Plan ${doc.name}`;
  const existing = readMission(vault, `mission/${missionSlugify(name)}`);
  const m = existing ?? createMission(vault, { name, outcome: `${doc.name} is ready`, target: f.date, from: `the event ${doc.name}`, now });
  setFields(vault, cid, { project: m.id }, { now });
  return { event: cid, project: { id: m.id, name: m.name }, created: !existing };
}

// ── Chat: what a person, product, thing or event adds to a turn ─────────────

/** The fields and links of one object, for its chat. Empty when there is nothing beyond its page. */
export function objectContextText(vault: string, raw: string): string {
  const id = canonId(vault, raw);
  const p = parseEntityId(id);
  if (!p?.kind) return "";
  const out: string[] = [];
  const doc = readPage(vault, p.kind, p.slug);
  const f = doc ? readFields(doc) : {};
  const idx = indexOf(vault);
  const nm = (x: string) => `${nameOf(vault, x, idx)} (${x})`;
  const details: string[] = [];
  if (f.date) details.push(`When: ${f.date}${f.time ? ` at ${f.time}` : ""}${f.end && f.end !== f.date ? ` to ${f.end}` : ""}`);
  if (f.place) details.push(`${p.kind === "thing" ? "Kept at" : "Where"}: ${nm(f.place)}`);
  if (f.people?.length) details.push(`With: ${f.people.map(nm).join(", ")}`);
  if (f.project) details.push(`Project: ${nm(f.project)}`);
  if (f.calendar) details.push(`Calendar: ${f.calendar === "synced" ? "on the user's calendar" : f.calendar === "ask" ? "not on the calendar; offered, waiting for the user's yes" : "the user chose to keep it off the calendar"}`);
  if (f.maker) details.push(`Made by: ${nm(f.maker)}`);
  if (f.purchased) details.push(`Bought: ${f.purchased}`);
  if (f.warranty) details.push(`Warranty until: ${f.warranty}`);
  if (f.value != null) details.push(`Value: $${f.value}`);
  if (f.service?.length) details.push(`Service history: ${f.service.slice(-8).map((s) => `${s.date} ${s.what}${s.cost != null ? ` ($${s.cost})` : ""}`).join("; ")}`);
  if (p.kind === "product") {
    const row = listProducts(vault, idx).find((r) => r.id === id);
    for (const a of row?.apps ?? []) details.push(`Its app record: ${a.title} (app ${a.id}${a.kind ? `, ${a.kind}` : ""}${a.category ? `, ${a.category}` : ""})`);
  }
  if (details.length) out.push(`## Details\n${details.map((d) => `- ${d}`).join("\n")}`);
  const links = linksOf(vault, id).links.filter((l) => l.via !== "field" || !["place", "maker", "project", "people"].includes(l.role ?? ""));
  if (links.length) out.push(`## Linked\n${links.slice(0, 20).map((l) => `- ${KINDS.find((k) => k.id === l.kind)!.singular}: ${l.name} (${l.id})`).join("\n")}`);
  return out.join("\n\n");
}

// ── Creating by talking ─────────────────────────────────────────────────────

export type DraftKind = "person" | "place" | "product" | "thing" | "event";
export const DRAFT_KINDS: DraftKind[] = ["person", "place", "product", "thing", "event"];
export interface ObjectDraft {
  name?: string; notes?: string; website?: string;
  date?: string; end?: string; time?: string; place?: string; people?: string[];
  purchased?: string; warranty?: string; value?: number; maker?: string;
}
export interface ObjectDraftReply { draft: ObjectDraft; filled: string[]; dropped: { field: string; value: string; why: string }[]; question: string | null; reply: string; ready: boolean; missing: string[]; go: boolean }

const DRAFT_FIELDS: Record<DraftKind, (keyof ObjectDraft)[]> = {
  person: ["name", "notes"],
  place: ["name", "notes"],
  product: ["name", "website", "notes"],
  thing: ["name", "purchased", "warranty", "value", "maker", "place", "notes"],
  event: ["name", "date", "end", "time", "place", "people", "notes"],
};
const REQUIRED_OF: Record<DraftKind, (keyof ObjectDraft)[]> = { person: ["name"], place: ["name"], product: ["name"], thing: ["name"], event: ["name", "date"] };
const ASK: Partial<Record<keyof ObjectDraft, string>> = { name: "What should we call it?", date: "When is it?" };
const GO_RE = /^\s*(?:ok(?:ay)?[, ]+|yes[, ]+)?(?:go|go ahead|save(?: it)?|create(?: it)?|add(?: it)?|make it|do it|that'?s it|done)\s*[.!]*\s*$/i;

/** Check what the model proposed; drop what fails, never guess. */
export function checkDraft(vault: string, kind: DraftKind, raw: unknown, userText: string): { fields: ObjectDraft; dropped: ObjectDraftReply["dropped"] } {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const allowed = DRAFT_FIELDS[kind];
  const out: ObjectDraft = {};
  const dropped: ObjectDraftReply["dropped"] = [];
  const drop = (field: string, v: unknown, why: string) => dropped.push({ field, value: typeof v === "string" ? v : JSON.stringify(v), why });
  const said = userText.toLowerCase();
  for (const k of allowed) {
    const v = f[k];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (k === "name" || k === "notes" || k === "website") {
      const s = typeof v === "string" ? oneLine(v, k === "notes" ? 600 : 120) : "";
      if (s.length >= 2) out[k] = s; else drop(k, v, "not a short line of text");
    } else if (k === "date" || k === "end" || k === "purchased" || k === "warranty") {
      const d = realYmd(v); if (d) out[k] = d; else drop(k, v, "not a real date (YYYY-MM-DD)");
    } else if (k === "time") {
      if (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) out.time = v.trim(); else drop(k, v, "not a time (HH:MM)");
    } else if (k === "value") {
      const n = moneyOf(v); if (n !== null) out.value = n; else drop(k, v, "not an amount");
    } else if (k === "place" || k === "maker") {
      // A name the user said, filed as a place or a product.
      const s = typeof v === "string" ? v.trim().replace(/^(place|product)\//, "").replace(/-/g, " ") : "";
      if (s && said.includes(s.toLowerCase())) out[k] = s; else drop(k, v, "you did not name it");
    } else if (k === "people") {
      const keep = (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "string" ? x.trim().replace(/^person\//, "").replace(/-/g, " ") : "")).filter((x) => { const ok = !!x && said.includes(x.toLowerCase()); if (!ok && x) drop("people", x, "you did not name them"); return ok; });
      if (keep.length) out.people = [...new Set(keep)];
    }
  }
  if (out.end && out.date && out.end < out.date) { drop("end", out.end, "before the start"); delete out.end; }
  void vault;
  return { fields: out, dropped };
}

const LABEL: Record<DraftKind, string> = { person: "person", place: "place", product: "product (a company, app or service)", thing: "thing the user owns (a phone, a watch, a car, gear)", event: "event (a dated happening: a birthday, a holiday, a dinner, an appointment)" };

/** One turn of the "new <kind>" conversation: the fields so far and the one question that matters next. */
export async function draftObject(vault: string, i: { kind: string; turns: { role: "user" | "assistant"; text: string }[]; draft?: ObjectDraft; runner?: RouteRunner; now?: number }): Promise<ObjectDraftReply> {
  if (!(DRAFT_KINDS as string[]).includes(i.kind)) throw new Error(`kind must be one of ${DRAFT_KINDS.join(", ")}`);
  const kind = i.kind as DraftKind;
  const today = ymd(i.now ?? now0());
  const turns = (i.turns ?? []).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim());
  const userText = turns.filter((t) => t.role === "user").map((t) => t.text).join("\n");
  const prev = checkDraft(vault, kind, i.draft ?? {}, userText).fields;
  let parsed: Record<string, unknown> | null = null;
  if (turns.some((t) => t.role === "user")) {
    const runner = i.runner ?? (await import("./route.ts")).claudeRouteRunner;
    const shape = Object.fromEntries(DRAFT_FIELDS[kind].map((k) => [k, k === "people" ? ["name"] : k === "value" ? 0 : ["date", "end", "purchased", "warranty"].includes(k) ? "YYYY-MM-DD" : k === "time" ? "HH:MM" : "..."]));
    const system = [
      `You help a person add a ${LABEL[kind]} to their records. Read the conversation and fill its fields.`,
      `Reply with ONE JSON object and nothing else: {"fields": ${JSON.stringify(shape)}, "say": "one short sentence", "question": "the ONE question that matters most now, or null"}`,
      "Include only fields the conversation supports. Resolve relative dates (\"next Friday\", \"Christmas\") against today. Names stay as the user wrote them. Never invent a person, a place or an amount.",
      `Ask for ${REQUIRED_OF[kind].join(" and ")} first, then at most one useful detail. When the required fields are known, set question to null and say it is ready to save.`,
      "No em dashes. Plain words.",
    ].join("\n");
    const prompt = [`Today: ${today}`, `Draft so far: ${JSON.stringify(prev)}`, "Conversation:", ...turns.slice(-12).map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text.slice(0, 1200)}`)].join("\n");
    for (let n = 0; n < 2 && !parsed; n++) { try { parsed = parseModelJson(await runner({ system, prompt, timeoutMs: 45_000 })); } catch { parsed = null; } }
  }
  const { fields, dropped } = checkDraft(vault, kind, parsed?.fields ?? {}, userText);
  const draft: ObjectDraft = { ...prev };
  const filled: string[] = [];
  for (const [k, v] of Object.entries(fields)) { if (JSON.stringify((prev as Record<string, unknown>)[k]) !== JSON.stringify(v)) filled.push(k); (draft as Record<string, unknown>)[k] = v; }
  const missing = REQUIRED_OF[kind].filter((k) => !draft[k]);
  const ready = !missing.length;
  const last = [...turns].reverse().find((t) => t.role === "user")?.text ?? "";
  const go = ready && GO_RE.test(last);
  let question = oneQuestion(parsed?.question);
  if (!question && missing.length) question = ASK[missing[0]!] ?? null;
  if (go) question = null;
  const say = typeof parsed?.say === "string" ? oneLine(parsed.say, 240) : "";
  const reply = !parsed && turns.some((t) => t.role === "user")
    ? `I could not read that just now. ${question ?? "Tell me a little more?"}`
    : [say, question ?? (ready ? "Say save to keep it, or add more." : "")].filter(Boolean).join(" ");
  return { draft, filled, dropped, question, reply: reply || (question ?? ""), ready, missing, go };
}

/** Save the drafted object (the user said go). Checked again here. */
export function createFromObjectDraft(vault: string, kindRaw: string, raw: unknown, now = now0()): { id: string; dropped: ObjectDraftReply["dropped"] } {
  if (!(DRAFT_KINDS as string[]).includes(kindRaw)) throw new Error(`kind must be one of ${DRAFT_KINDS.join(", ")}`);
  const kind = kindRaw as DraftKind;
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  // Names were checked against the user's words when drafted; here they only need to be there.
  const said = [r.place, r.maker, ...(Array.isArray(r.people) ? r.people : [])].filter((x) => typeof x === "string").join(" ");
  const { fields: d, dropped } = checkDraft(vault, kind, raw, said);
  if (!d.name) throw new Error("it needs a name");
  if (kind === "event") {
    if (!d.date) throw new Error("an event needs a date");
    const e = createEvent(vault, { name: d.name, date: d.date, end: d.end, time: d.time, place: d.place, people: d.people, notes: d.notes }, now);
    return { id: e.id, dropped };
  }
  const saved = saveEntity(vault, `${kind}/${slugify(d.name)}`, { name: d.name, kind, now });
  if (kind === "thing") setFields(vault, saved.id, { purchased: d.purchased, warranty: d.warranty, value: d.value != null ? String(d.value) : undefined, maker: d.maker, place: d.place }, { now });
  if (kind === "product" && d.website) { try { setWebsite(vault, saved.id, d.website, { now }); } catch (e) { dropped.push({ field: "website", value: d.website, why: (e as Error).message }); } }
  if (d.notes) setNotes(vault, saved.id, d.notes, { now });
  return { id: saved.id, dropped };
}
