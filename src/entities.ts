// Entities: the people, places, companies/products and things the owner talks
// about, with the context of every conversation that touched them.
//
// No database and no model in the index. Two sources feed it:
//   (a) prevail://person|place|org|thing/<name> links the chat model writes
//       into thread (and brief) markdown across every domain, and
//   (b) entity tags on prompt sittings, one cheap model call per new sitting
//       during the Intent refresh (cached by sitting id, so a sitting is
//       only ever tagged once unless it grows while still recent).
//
// Writes:
//   build/_meta/entities/index.json     the aggregate (machine-managed)
//   build/_meta/entities/threads.json   per-file link cache (mtime checkpoints)
//   build/_meta/entities/tags.json      per-sitting tag cache
//   build/_meta/entities/digests.json   which mention set each digest covered
//   data/entities/<kind dir>/<slug>.md  pages (the user's "Your notes" section
//                                       is never rewritten by any code here)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sanitizeEmDashes } from "./cli-bridge.ts";
import { dataRoot, DOMAINS_DIR, APPS_DIR, entitiesContainer, runtimePath } from "./path-safety.ts";
import { displayLine, parseJsonAnswer, runModelOnce, SYNTH_DEFAULTS, type ModelChoice, type ModelRunner } from "./prompt-projects.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";

// ---------------------------------------------------------------------------
// contract types

export type EntityKind = "person" | "place" | "org" | "thing";
export const ENTITY_KINDS: EntityKind[] = ["person", "place", "org", "thing"];
export const KIND_DIR: Record<EntityKind, string> = { person: "people", place: "places", org: "orgs", thing: "things" };

export type MentionSource = "thread" | "prompt" | "brief";

export interface Mention {
  source: MentionSource;
  ref: string; // vault-relative path (thread/brief) or sitting id (prompt)
  domain: string;
  project: string;
  title: string; // thread title or project title, for display
  tool?: string; // prompt sittings: the tool the sitting ran in
  ts: number;
  snippet: string; // <= 240 chars
}

export interface CoMention { id: string; name: string; kind: EntityKind; count: number }

export interface EntityRec {
  id: string; // <kind>/<slug>
  name: string;
  kind: EntityKind;
  aliases: string[];
  kinds: EntityKind[];
  mention_count: number;
  conversations: number; // distinct threads + sittings
  last_ts: number;
  mentions: Mention[]; // newest first, capped
  co_mentions: CoMention[]; // top 10
  page?: string; // vault-relative page path when a page exists
  saved?: boolean;
  domain?: string; // company/product web domain when one is known (org chips)
}

export interface EntityIndex { version: 1; generated_ts: number; entities: EntityRec[] }

export interface EntitySummary {
  id: string; name: string; kind: EntityKind; aliases: string[]; mention_count: number; conversations: number;
  last_ts: number; saved: boolean; has_page: boolean; domain?: string;
}

// ---------------------------------------------------------------------------
// small helpers

const META = (vault: string, name: string) => runtimePath(vault, join("_meta", "entities", name));
const MAX_MENTIONS = 200;
const AUTO_PAGE_AT = 3;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(vreadFile(path)) as T; } catch { return fallback; }
}

function writeJson(path: string, v: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  vwriteFile(path, `${JSON.stringify(v, null, 2)}\n`);
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function isKind(k: unknown): k is EntityKind {
  return typeof k === "string" && (ENTITY_KINDS as string[]).includes(k);
}

// Accepts person/sam, people/sam, org/acme and a bare slug (kind unknown).
export function parseEntityId(id: string): { kind: EntityKind | null; slug: string } | null {
  const s = id.trim().replace(/^prevail:\/\//, "");
  const i = s.indexOf("/");
  if (i < 0) { const slug = slugify(s); return slug ? { kind: null, slug } : null; }
  const head = s.slice(0, i).toLowerCase();
  let rest = s.slice(i + 1);
  try { rest = decodeURIComponent(rest); } catch { /* keep raw */ }
  const kind = isKind(head) ? head : ((Object.entries(KIND_DIR).find(([, d]) => d === head)?.[0] as EntityKind | undefined) ?? null);
  if (!kind) {
    // Not a kind prefix: the whole string is a name.
    const whole = slugify(s);
    return whole ? { kind: null, slug: whole } : null;
  }
  const slug = slugify(rest);
  return slug ? { kind, slug } : null;
}

const clean = (s: string) => sanitizeEmDashes(s.replace(/\s+/g, " ").trim());

// Company/product web domain written in a name or alias ("acme.com").
function webDomainOf(names: string[]): string | undefined {
  for (const n of names) {
    const m = n.trim().toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\/?$/);
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// (a) links in thread / brief markdown

const LINK_RE = /\[([^\]\n]{1,200})\]\(prevail:\/\/(person|place|org|thing)\/([^)\s]+)\)/gi;

export interface RawLink { kind: EntityKind; value: string; label: string; snippet: string }

// Every entity link in a markdown document, with the sentence around it.
export function extractLinks(md: string): RawLink[] {
  const out: RawLink[] = [];
  const lines = md.split("\n");
  for (const line of lines) {
    if (!line.includes("prevail://")) continue;
    const plain = line.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
    LINK_RE.lastIndex = 0;
    for (let m = LINK_RE.exec(line); m; m = LINK_RE.exec(line)) {
      let value = m[3];
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      value = value.replace(/\/+$/, "").trim();
      const label = m[1].replace(/[*_`]+/g, "").trim();
      if (!value) continue;
      out.push({ kind: m[2].toLowerCase() as EntityKind, value, label, snippet: windowAround(plain, label, 240) });
    }
  }
  return out;
}

function windowAround(text: string, needle: string, n: number): string {
  if (text.length <= n) return text;
  const at = Math.max(0, text.toLowerCase().indexOf(needle.toLowerCase()));
  let start = Math.max(0, at - Math.floor((n - needle.length) / 2));
  if (start + n > text.length) start = Math.max(0, text.length - n);
  let s = text.slice(start, start + n - 2).trim();
  if (start > 0) s = `…${s}`;
  if (start + n - 2 < text.length) s = `${s}…`;
  return s.slice(0, n);
}

function frontmatterField(md: string, key: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const m = fm[1].match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
}

interface FileLinks { mtime: number; size: number; title: string; ts: number; domain: string; source: MentionSource; links: RawLink[] }
interface ThreadCache { files: Record<string, FileLinks> }

// Markdown files that may carry entity links, per domain (and app scope).
function linkSources(vault: string): { path: string; domain: string; source: MentionSource }[] {
  const out: { path: string; domain: string; source: MentionSource }[] = [];
  const root = dataRoot(vault);
  const scan = (dir: string, domain: string, source: MentionSource) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) if (n.endsWith(".md") && !n.startsWith(".")) out.push({ path: join(dir, n), domain, source });
  };
  const domainsDir = existsSync(join(root, DOMAINS_DIR)) ? join(root, DOMAINS_DIR) : root;
  let domains: string[] = [];
  try { domains = readdirSync(domainsDir); } catch { /* none */ }
  for (const d of domains) {
    if (d.startsWith(".") || d === "apps" || d === "entities" || d === "build") continue;
    const base = join(domainsDir, d);
    try { if (!statSync(base).isDirectory()) continue; } catch { continue; }
    scan(join(base, "memory", "threads"), d, "thread");
    scan(join(base, "_threads"), d, "thread");
    scan(join(base, "memory", "briefs"), d, "brief");
  }
  let apps: string[] = [];
  try { apps = readdirSync(join(root, APPS_DIR)); } catch { /* none */ }
  for (const a of apps) {
    if (a.startsWith(".")) continue;
    scan(join(root, APPS_DIR, a, "_scope", "_threads"), `_app-${a}`, "thread");
    scan(join(root, APPS_DIR, a, "_scope", "memory", "threads"), `_app-${a}`, "thread");
  }
  return out;
}

// Re-reads only files whose mtime or size moved since the last pass.
export function scanLinks(vault: string): { cache: ThreadCache; read: number } {
  const path = META(vault, "threads.json");
  const prev = readJson<ThreadCache>(path, { files: {} });
  const next: ThreadCache = { files: {} };
  let read = 0;
  for (const src of linkSources(vault)) {
    const rel = relative(vault, src.path);
    let st;
    try { st = statSync(src.path); } catch { continue; }
    const have = prev.files[rel];
    if (have && have.mtime === st.mtimeMs && have.size === st.size) { next.files[rel] = have; continue; }
    let md = "";
    try { md = vreadFile(src.path); } catch { continue; }
    read++;
    const title = frontmatterField(md, "title") || src.path.split("/").pop()!.replace(/\.md$/, "");
    const ts = Date.parse(frontmatterField(md, "updated")) || Date.parse(frontmatterField(md, "created")) || st.mtimeMs;
    next.files[rel] = { mtime: st.mtimeMs, size: st.size, title: displayLine(title, 120), ts, domain: src.domain, source: src.source, links: extractLinks(md) };
  }
  if (read || Object.keys(prev.files).length !== Object.keys(next.files).length) writeJson(path, next);
  return { cache: next, read };
}

// ---------------------------------------------------------------------------
// (b) entity tags on prompt sittings

export interface TagEntity { name: string; kind: EntityKind }
export interface SittingTag {
  n: number; // prompts seen when tagged
  ts: number; // sitting start
  end_ts: number;
  tool: string;
  project: string;
  project_title: string;
  domain: string;
  model: string;
  tagged_ts: number;
  entities: TagEntity[];
  snippets: Record<string, string>; // entity name -> the prompt line that mentions it
}
export interface TagCache { enabled_ts: number; sittings: Record<string, SittingTag> }

export interface SittingLike {
  id: string; tool: string; project: string; project_title: string; start_ts: number; end_ts: number;
  prompts: { ts: number; text: string }[];
}

export const TAG_DEFAULT: ModelChoice = { cli: "claude", model: "claude-haiku-4-5" };

export function readTags(vault: string): TagCache {
  const t = readJson<Partial<TagCache>>(META(vault, "tags.json"), {});
  return { enabled_ts: t.enabled_ts ?? 0, sittings: t.sittings ?? {} };
}

// Merge with whatever is on disk so a backfill and a refresh running at the
// same time never drop each other's work.
function writeTags(vault: string, mine: TagCache) {
  const disk = readTags(vault);
  const merged: TagCache = { enabled_ts: disk.enabled_ts || mine.enabled_ts, sittings: { ...disk.sittings } };
  for (const [id, t] of Object.entries(mine.sittings)) {
    const d = merged.sittings[id];
    if (!d || d.tagged_ts <= t.tagged_ts) merged.sittings[id] = t;
  }
  writeJson(META(vault, "tags.json"), merged);
}

function sittingText(s: SittingLike, cap = 3000): string {
  const parts: string[] = [];
  let used = 0;
  for (const p of s.prompts) {
    const line = displayLine(p.text, 500);
    if (!line) continue;
    if (used + line.length > cap) break;
    parts.push(`- ${line}`);
    used += line.length;
  }
  return parts.join("\n");
}

export function buildTagPrompt(items: { id: string; text: string }[]): string {
  return `Extract the specific named entities a person mentions in their own prompts to AI tools.

Kinds:
- person: a named individual (not "I", "you", "the user", roles, or AI assistants)
- place: a named city, country, region, address, street, venue or landmark
- org: a named company, product, brand, app, service or institution
- thing: a specific named object or work (a book, a vehicle model, a property, a device, an event)

Skip generic concepts, programming terms, file names, paths, code identifiers, commands and URLs. Use the fullest proper name as written. At most 12 per sitting. An empty list is fine.

Answer with JSON only: {"<sitting id>": [{"name": "...", "kind": "person|place|org|thing"}], ...} with every sitting id below as a key.

${items.map((i) => `## Sitting ${i.id}\n${i.text}`).join("\n\n")}
`;
}

function parseTagAnswer(out: string, ids: string[]): Record<string, TagEntity[]> {
  const ans = parseJsonAnswer<Record<string, unknown>>(out);
  const res: Record<string, TagEntity[]> = {};
  for (const id of ids) {
    const raw = ans[id];
    const list: TagEntity[] = [];
    const seen = new Set<string>();
    if (Array.isArray(raw)) {
      for (const e of raw) {
        const name = typeof (e as TagEntity)?.name === "string" ? clean((e as TagEntity).name).slice(0, 120) : "";
        const kind = (e as TagEntity)?.kind;
        const slug = slugify(name);
        if (!name || !slug || !isKind(kind) || seen.has(slug)) continue;
        seen.add(slug);
        list.push({ name, kind });
      }
    }
    res[id] = list.slice(0, 12);
  }
  return res;
}

function snippetFor(s: SittingLike, name: string): string {
  const low = name.toLowerCase();
  const hit = s.prompts.find((p) => p.text.toLowerCase().includes(low));
  if (!hit) return displayLine(s.prompts[0]?.text ?? "", 240);
  const flat = displayLine(hit.text, 100000);
  return windowAround(flat, name, 240);
}

export interface TagOptions {
  run: ModelRunner | null;
  model?: ModelChoice;
  limit?: number;
  batch?: number;
  log?: (m: string) => void;
  domainOf?: (projectSlug: string) => string;
  now?: number;
}

// Tag the given sittings (already chosen by the caller), `batch` per model
// call. Saves after every batch, so an interrupted run resumes where it
// stopped.
export async function tagSittings(vault: string, sittings: SittingLike[], o: TagOptions): Promise<{ tagged: number; calls: number; failed: number; entities: number }> {
  const res = { tagged: 0, calls: 0, failed: 0, entities: 0 };
  if (!o.run || !sittings.length) return res;
  const model = o.model ?? TAG_DEFAULT;
  const size = Math.max(1, o.batch ?? 1);
  const cache = readTags(vault);
  for (let i = 0; i < sittings.length; i += size) {
    const batch = sittings.slice(i, i + size).map((s) => ({ s, text: sittingText(s) })).filter((b) => b.text);
    if (!batch.length) continue;
    res.calls++;
    let ans: Record<string, TagEntity[]>;
    try {
      ans = parseTagAnswer(await o.run(buildTagPrompt(batch.map((b) => ({ id: b.s.id, text: b.text }))), model), batch.map((b) => b.s.id));
    } catch (e) {
      res.failed += batch.length;
      o.log?.(`entity tags: batch failed (${(e as Error).message}); retry next time`);
      continue;
    }
    const now = o.now ?? Date.now();
    for (const { s } of batch) {
      const ents = ans[s.id] ?? [];
      cache.sittings[s.id] = {
        n: s.prompts.length, ts: s.start_ts, end_ts: s.end_ts, tool: s.tool, project: s.project, project_title: s.project_title,
        domain: s.project ? (o.domainOf?.(s.project) ?? "") : "", model: model.model, tagged_ts: now, entities: ents,
        snippets: Object.fromEntries(ents.map((e) => [e.name, clean(snippetFor(s, e.name))])),
      };
      res.tagged++;
      res.entities += ents.length;
    }
    writeTags(vault, cache);
  }
  return res;
}

const RECENT_GROWTH = 3 * 864e5;

// The sittings an Intent refresh should tag: every sitting that started after
// tagging was switched on and has no tag yet, plus a recent one that grew.
// Everything older is the backfill's job, so a refresh never pays for history.
export function newSittings(vault: string, sittings: SittingLike[], now = Date.now()): SittingLike[] {
  const cache = readTags(vault);
  if (!cache.enabled_ts) {
    cache.enabled_ts = now - 2 * 864e5;
    writeTags(vault, cache);
  }
  return sittings.filter((s) => {
    const t = cache.sittings[s.id];
    if (!t) return s.start_ts >= cache.enabled_ts;
    return t.n < s.prompts.length && s.end_ts >= now - RECENT_GROWTH;
  }).sort((a, b) => b.start_ts - a.start_ts);
}

export function untaggedSittings(vault: string, sittings: SittingLike[]): SittingLike[] {
  const cache = readTags(vault);
  return sittings.filter((s) => !cache.sittings[s.id]).sort((a, b) => b.start_ts - a.start_ts);
}

// ---------------------------------------------------------------------------
// pages

export interface PageDoc {
  name: string;
  kind: EntityKind;
  aliases: string[];
  saved: boolean;
  created: string;
  updated: string;
  mention_count: number;
  domain?: string;
  preamble: string; // anything above the first known section, kept verbatim
  discussed: string;
  notes: string;
  conversations: string;
  extra: Record<string, string>; // unknown frontmatter keys, kept verbatim
}

const H_DISCUSSED = "What you've discussed";
const H_NOTES = "Your notes";
const H_CONVOS = "Conversations";
const EMPTY_DISCUSSED = "_Nothing summarized yet._";
const EMPTY_CONVOS = "_No conversations yet._";

export function pagePath(vault: string, kind: EntityKind, slug: string): string {
  return join(entitiesContainer(vault), KIND_DIR[kind], `${slug}.md`);
}

function parseList(v: string): string[] {
  const s = v.trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String).map((x) => x.trim()).filter(Boolean); } catch { /* yaml flow list */ }
    return s.slice(1, s.lastIndexOf("]") > 0 ? s.lastIndexOf("]") : undefined).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return [s.replace(/^["']|["']$/g, "")];
}

export function parsePage(md: string, fallback: { kind: EntityKind; slug: string }): PageDoc {
  const doc: PageDoc = {
    name: fallback.slug, kind: fallback.kind, aliases: [], saved: false, created: "", updated: "", mention_count: 0,
    preamble: "", discussed: "", notes: "", conversations: "", extra: {},
  };
  let body = md;
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = md.slice(fm[0].length);
    const lines = fm[1].split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      let val = rawVal.trim();
      if (key === "aliases" && !val) {
        const items: string[] = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        doc.aliases = items.filter(Boolean);
        continue;
      }
      val = val.replace(/^["']|["']$/g, "");
      if (key === "name") doc.name = val || doc.name;
      else if (key === "kind") { if (isKind(val)) doc.kind = val; }
      else if (key === "aliases") doc.aliases = parseList(rawVal);
      else if (key === "saved") doc.saved = val === "true";
      else if (key === "created") doc.created = val;
      else if (key === "updated") doc.updated = val;
      else if (key === "mention_count") doc.mention_count = Number(val) || 0;
      else if (key === "domain") doc.domain = val || undefined;
      else doc.extra[key] = rawVal;
    }
  }
  // Split on the three known headings only; a user's own "## " inside notes
  // stays part of the notes.
  const known = [H_DISCUSSED, H_NOTES, H_CONVOS];
  const re = /^## (.+?)\s*$/gm;
  const cuts: { h: string; start: number; end: number }[] = [];
  for (let m = re.exec(body); m; m = re.exec(body)) if (known.includes(m[1])) cuts.push({ h: m[1], start: m.index, end: m.index + m[0].length });
  doc.preamble = (cuts.length ? body.slice(0, cuts[0].start) : body).trim();
  for (let i = 0; i < cuts.length; i++) {
    const text = body.slice(cuts[i].end, i + 1 < cuts.length ? cuts[i + 1].start : body.length).replace(/^\n+|\s+$/g, "");
    if (cuts[i].h === H_DISCUSSED) doc.discussed = text === EMPTY_DISCUSSED ? "" : text;
    else if (cuts[i].h === H_NOTES) doc.notes = text;
    else doc.conversations = text === EMPTY_CONVOS ? "" : text;
  }
  return doc;
}

const yamlStr = (s: string) => (/^[\w .,'()&+-]*$/.test(s) && !/^[\s-]|:\s|\s$/.test(s) && s !== "" && !/^(true|false|null|\d)/i.test(s) ? s : JSON.stringify(s));

export function renderPage(d: PageDoc): string {
  const fm = [
    "---",
    `name: ${yamlStr(d.name)}`,
    `kind: ${d.kind}`,
    `aliases: [${d.aliases.map(yamlStr).join(", ")}]`,
    `saved: ${d.saved}`,
    `created: ${d.created}`,
    `updated: ${d.updated}`,
    `mention_count: ${d.mention_count}`,
    ...(d.domain ? [`domain: ${d.domain}`] : []),
    ...Object.entries(d.extra).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
  ];
  return [
    ...fm,
    ...(d.preamble ? [d.preamble, ""] : []),
    `## ${H_DISCUSSED}`, "", d.discussed || EMPTY_DISCUSSED, "",
    `## ${H_NOTES}`, "", d.notes, ...(d.notes ? [""] : []),
    `## ${H_CONVOS}`, "", d.conversations || EMPTY_CONVOS, "",
  ].join("\n");
}

export function readPage(vault: string, kind: EntityKind, slug: string): PageDoc | null {
  const p = pagePath(vault, kind, slug);
  if (!existsSync(p)) return null;
  try { return parsePage(vreadFile(p), { kind, slug }); } catch { return null; }
}

function writePage(vault: string, kind: EntityKind, slug: string, d: PageDoc) {
  const p = pagePath(vault, kind, slug);
  mkdirSync(dirname(p), { recursive: true });
  vwriteFile(p, renderPage(d));
}

export interface PageRef { id: string; kind: EntityKind; slug: string; path: string; doc: PageDoc }

export function listPages(vault: string): PageRef[] {
  const out: PageRef[] = [];
  const root = entitiesContainer(vault);
  for (const kind of ENTITY_KINDS) {
    let names: string[] = [];
    try { names = readdirSync(join(root, KIND_DIR[kind])); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md") || n.startsWith(".")) continue;
      const slug = n.slice(0, -3);
      const doc = readPage(vault, kind, slug);
      if (doc) out.push({ id: `${kind}/${slug}`, kind, slug, path: relative(vault, pagePath(vault, kind, slug)), doc });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// index

export function readIndex(vault: string): EntityIndex {
  const i = readJson<Partial<EntityIndex>>(META(vault, "index.json"), {});
  return { version: 1, generated_ts: i.generated_ts ?? 0, entities: i.entities ?? [] };
}

interface Acc {
  slug: string;
  names: Map<string, number>;
  kindVotes: Map<EntityKind, number>;
  mentions: Mention[];
}

export function buildIndex(vault: string, opts: { now?: number } = {}): EntityIndex {
  const { cache } = scanLinks(vault);
  const tags = readTags(vault);
  const pages = listPages(vault);

  // A page fixes an entity's kind and folds its aliases in.
  const pageBySlug = new Map<string, PageRef>();
  const aliasToSlug = new Map<string, string>();
  for (const p of pages) {
    pageBySlug.set(p.slug, p);
    for (const a of [p.doc.name, ...p.doc.aliases]) { const s = slugify(a); if (s && s !== p.slug) aliasToSlug.set(s, p.slug); }
  }
  const acc = new Map<string, Acc>();
  const add = (rawName: string, kind: EntityKind, m: Mention, label?: string) => {
    let slug = slugify(rawName);
    if (!slug) return;
    slug = aliasToSlug.get(slug) ?? slug;
    const a: Acc = acc.get(slug) ?? { slug, names: new Map(), kindVotes: new Map(), mentions: [] };
    acc.set(slug, a);
    // A slug-shaped link value (prevail://person/sam-rivera) names nothing
    // new; the label carries the display name then.
    const display = rawName === slug && label ? label : rawName;
    a.names.set(display, (a.names.get(display) ?? 0) + 1);
    if (label && label !== display && slugify(label) !== slug) a.names.set(label, (a.names.get(label) ?? 0) + 0.5);
    a.kindVotes.set(kind, (a.kindVotes.get(kind) ?? 0) + 1);
    a.mentions.push(m);
  };

  for (const [rel, f] of Object.entries(cache.files)) {
    const seen = new Set<string>();
    for (const l of f.links) {
      const key = `${l.kind}:${slugify(l.value)}`;
      if (seen.has(key)) continue; // one mention per entity per file
      seen.add(key);
      add(l.value, l.kind, { source: f.source, ref: rel, domain: f.domain, project: "", title: f.title, ts: f.ts, snippet: l.snippet }, l.label);
    }
  }
  for (const [id, t] of Object.entries(tags.sittings)) {
    for (const e of t.entities) {
      add(e.name, e.kind, { source: "prompt", ref: id, domain: t.domain, project: t.project, title: t.project_title, tool: t.tool, ts: t.ts, snippet: t.snippets[e.name] ?? "" });
    }
  }
  for (const p of pages) if (!acc.has(p.slug)) acc.set(p.slug, { slug: p.slug, names: new Map([[p.doc.name, 1]]), kindVotes: new Map([[p.kind, 1]]), mentions: [] });

  const recs: EntityRec[] = [];
  const refsOf = new Map<string, Set<string>>();
  for (const a of acc.values()) {
    const page = pageBySlug.get(a.slug);
    const kinds = [...a.kindVotes.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
    const kind = page?.kind ?? kinds[0];
    const names = [...a.names.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length).map(([n]) => n);
    const name = page?.doc.name ?? names[0];
    const aliases = [...new Set([...(page?.doc.aliases ?? []), ...names.filter((n) => n !== name)])].slice(0, 12);
    a.mentions.sort((x, y) => y.ts - x.ts);
    const refs = new Set(a.mentions.map((m) => `${m.source === "prompt" ? "p" : "f"}:${m.ref}`));
    const id = `${kind}/${a.slug}`;
    refsOf.set(id, refs);
    recs.push({
      id, name, kind, aliases, kinds, mention_count: a.mentions.length, conversations: refs.size,
      last_ts: a.mentions[0]?.ts ?? 0, mentions: a.mentions.slice(0, MAX_MENTIONS), co_mentions: [],
      ...(page ? { page: page.path, saved: page.doc.saved } : {}),
      ...((page?.doc.domain ?? (kind === "org" ? webDomainOf([name, ...aliases]) : undefined)) ? { domain: page?.doc.domain ?? webDomainOf([name, ...aliases]) } : {}),
    });
  }

  // Co-mentions: entities sharing a conversation.
  const byRef = new Map<string, string[]>();
  for (const [id, refs] of refsOf) for (const r of refs) (byRef.get(r) ?? byRef.set(r, []).get(r)!).push(id);
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const r of recs) {
    const counts = new Map<string, number>();
    for (const ref of refsOf.get(r.id) ?? []) for (const other of byRef.get(ref) ?? []) if (other !== r.id) counts.set(other, (counts.get(other) ?? 0) + 1);
    r.co_mentions = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([id, count]) => {
      const o = byId.get(id)!;
      return { id, name: o.name, kind: o.kind, count };
    });
  }
  recs.sort((a, b) => b.conversations - a.conversations || b.last_ts - a.last_ts || a.name.localeCompare(b.name));
  const idx: EntityIndex = { version: 1, generated_ts: opts.now ?? Date.now(), entities: recs };
  writeJson(META(vault, "index.json"), idx);
  return idx;
}

export function summarize(r: EntityRec): EntitySummary {
  return {
    id: r.id, name: r.name, kind: r.kind, aliases: r.aliases, mention_count: r.mention_count, conversations: r.conversations,
    last_ts: r.last_ts, saved: !!r.saved, has_page: !!r.page, ...(r.domain ? { domain: r.domain } : {}),
  };
}

export function findEntity(idx: EntityIndex, idOrName: string): EntityRec | null {
  const p = parseEntityId(idOrName);
  if (!p) return null;
  const exact = idx.entities.find((e) => e.id === `${p.kind}/${p.slug}`);
  if (exact) return exact;
  const bySlug = idx.entities.filter((e) => e.id.endsWith(`/${p.slug}`) && (!p.kind || e.kind === p.kind || e.kinds.includes(p.kind)));
  if (bySlug.length) return bySlug[0];
  const q = idOrName.toLowerCase().trim();
  return idx.entities.find((e) => e.name.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q)) ?? null;
}

export function searchEntities(idx: EntityIndex, q: string, o: { kind?: string; limit?: number; savedOnly?: boolean } = {}): EntityRec[] {
  const needle = q.toLowerCase().trim();
  const slug = slugify(q);
  const hits = idx.entities.filter((e) =>
    (!o.kind || e.kind === o.kind)
    && (!o.savedOnly || e.saved)
    && (!needle || e.name.toLowerCase().includes(needle) || e.aliases.some((a) => a.toLowerCase().includes(needle)) || (!!slug && e.id.includes(slug))));
  if (needle) hits.sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)) || b.conversations - a.conversations);
  return hits.slice(0, Math.max(1, o.limit ?? 500));
}

// ---------------------------------------------------------------------------
// page sync + digests

function iso(ts: number) { return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z") }
function day(ts: number) { return new Date(ts).toISOString().slice(0, 10) }

export function conversationsSection(r: EntityRec, max = 50): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of r.mentions) {
    const key = `${m.source}:${m.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= max) break;
    if (m.source === "prompt") {
      lines.push(`- ${day(m.ts)} · ${m.tool ?? "prompt"} sitting${m.title && m.title !== "Other" ? ` in ${m.title}` : ""} (history ${m.ref})`);
    } else {
      const label = (m.title || m.ref.split("/").pop() || "").replace(/[[\]]/g, "");
      lines.push(`- ${day(m.ts)} · ${m.source === "brief" ? "Brief" : "Chat"}${m.domain && !m.domain.startsWith("_") ? ` in ${m.domain}` : ""}: [${label}](prevail://file/${m.ref.split("/").map(encodeURIComponent).join("/")})`);
    }
  }
  return lines.join("\n");
}

function newPage(r: { name: string; kind: EntityKind; aliases: string[] }, saved: boolean, now: number): PageDoc {
  return {
    name: r.name, kind: r.kind, aliases: r.aliases.slice(0, 8), saved, created: iso(now), updated: iso(now), mention_count: 0,
    preamble: "", discussed: "", notes: "", conversations: "", extra: {},
  };
}

// Create auto pages for entities seen in AUTO_PAGE_AT+ conversations and keep
// every page's count + Conversations list current. Never touches notes.
export function syncPages(vault: string, idx: EntityIndex, now = Date.now()): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  for (const r of idx.entities) {
    const slug = r.id.slice(r.id.indexOf("/") + 1);
    let doc = readPage(vault, r.kind, slug);
    const isNew = !doc;
    if (!doc) {
      if (r.conversations < AUTO_PAGE_AT) continue;
      doc = newPage(r, false, now);
    }
    const convos = conversationsSection(r);
    if (!isNew && doc.mention_count === r.mention_count && doc.conversations === convos) continue;
    doc.mention_count = r.mention_count;
    doc.conversations = convos;
    doc.updated = iso(now);
    writePage(vault, r.kind, slug, doc);
    r.page = relative(vault, pagePath(vault, r.kind, slug));
    r.saved = doc.saved;
    if (isNew) created++;
    else updated++;
  }
  if (created || updated) writeJson(META(vault, "index.json"), idx);
  return { created, updated };
}

export function buildDigestPrompt(r: EntityRec): string {
  const lines = r.mentions.slice(0, 40).map((m) => `- ${day(m.ts)} (${m.source === "prompt" ? `their prompt${m.title && m.title !== "Other" ? `, ${m.title}` : ""}` : `chat: ${m.title}`}): ${m.snippet}`);
  return `Below are excerpts from one person's own conversations with AI tools that mention ${r.name} (${r.kind}). Write what they have discussed about ${r.name}, in second person ("You asked about..."), as 2 to 5 short plain sentences or bullets.

Rules: state only what these excerpts say. Add no outside knowledge, no background facts, no guesses and no advice. If the excerpts say little, say little. No headings. No em dashes.

Excerpts, newest first:
${lines.join("\n")}
`;
}

interface DigestState { hash: string; model: string; ts: number }

export async function refreshDigests(vault: string, idx: EntityIndex, o: { run: ModelRunner | null; model?: ModelChoice; limit?: number; log?: (m: string) => void; now?: number }): Promise<{ written: number; pending: number }> {
  if (!o.run) return { written: 0, pending: 0 };
  const model = o.model ?? { cli: "claude", model: SYNTH_DEFAULTS.claude };
  const state = readJson<Record<string, DigestState>>(META(vault, "digests.json"), {});
  const due = idx.entities.filter((r) => r.page && r.mentions.length && state[r.id]?.hash !== hash(r.mentions.map((m) => `${m.ref}|${m.snippet}`).join("\n")));
  due.sort((a, b) => Number(!!b.saved) - Number(!!a.saved) || b.last_ts - a.last_ts);
  const limit = o.limit ?? 5;
  let written = 0;
  for (const r of due.slice(0, limit)) {
    const slug = r.id.slice(r.id.indexOf("/") + 1);
    try {
      const text = sanitizeEmDashes((await o.run(buildDigestPrompt(r), model)).trim().replace(/^```(?:markdown)?\n|\n```$/g, "")).trim();
      if (!text) continue;
      const doc = readPage(vault, r.kind, slug);
      if (!doc) continue;
      doc.discussed = text;
      doc.updated = iso(o.now ?? Date.now());
      writePage(vault, r.kind, slug, doc);
      state[r.id] = { hash: hash(r.mentions.map((m) => `${m.ref}|${m.snippet}`).join("\n")), model: model.model, ts: o.now ?? Date.now() };
      writeJson(META(vault, "digests.json"), state);
      written++;
    } catch (e) { o.log?.(`digest ${r.id} failed (${(e as Error).message})`); }
  }
  return { written, pending: Math.max(0, due.length - written) };
}

// ---------------------------------------------------------------------------
// user actions

export interface EntityDetail extends EntityRec {
  digest: string;
  notes: string;
  page_path?: string;
}

export function entityDetail(vault: string, idx: EntityIndex, idOrName: string): EntityDetail | null {
  let r = findEntity(idx, idOrName);
  if (!r) {
    // A saved page that the index has not seen yet.
    const p = parseEntityId(idOrName);
    if (!p?.kind) return null;
    const doc = readPage(vault, p.kind, p.slug);
    if (!doc) return null;
    r = { id: `${p.kind}/${p.slug}`, name: doc.name, kind: p.kind, aliases: doc.aliases, kinds: [p.kind], mention_count: 0, conversations: 0, last_ts: 0, mentions: [], co_mentions: [], page: relative(vault, pagePath(vault, p.kind, p.slug)), saved: doc.saved };
  }
  const slug = r.id.slice(r.id.indexOf("/") + 1);
  const doc = readPage(vault, r.kind, slug);
  return { ...r, digest: doc?.discussed ?? "", notes: doc?.notes ?? "", ...(doc ? { page_path: relative(vault, pagePath(vault, r.kind, slug)), saved: doc.saved } : {}) };
}

function resolveForWrite(idx: EntityIndex, idOrName: string, kindHint?: string): { kind: EntityKind; slug: string; rec: EntityRec | null } {
  const rec = findEntity(idx, idOrName);
  if (rec) return { kind: rec.kind, slug: rec.id.slice(rec.id.indexOf("/") + 1), rec };
  const p = parseEntityId(idOrName);
  const kind = p?.kind ?? (isKind(kindHint) ? kindHint : null);
  if (!p || !kind) throw new Error(`unknown entity "${idOrName}": use <kind>/<name> with kind person, place, org or thing`);
  return { kind, slug: p.slug, rec: null };
}

export function saveEntity(vault: string, idOrName: string, o: { name?: string; kind?: string; now?: number } = {}): EntityDetail {
  const now = o.now ?? Date.now();
  const idx = readIndex(vault);
  const { kind, slug, rec } = resolveForWrite(idx, idOrName, o.kind);
  let doc = readPage(vault, kind, slug);
  if (!doc) {
    const nm = o.name?.trim() || rec?.name || idOrName.slice(idOrName.indexOf("/") + 1).trim() || slug;
    doc = newPage({ name: nm, kind, aliases: rec?.aliases ?? [] }, true, now);
  }
  doc.saved = true;
  if (rec) { doc.mention_count = rec.mention_count; doc.conversations = conversationsSection(rec); }
  doc.updated = iso(now);
  writePage(vault, kind, slug, doc);
  const next = buildIndex(vault, { now });
  return entityDetail(vault, next, `${kind}/${slug}`)!;
}

export function setNotes(vault: string, idOrName: string, text: string, o: { kind?: string; name?: string; now?: number } = {}): EntityDetail {
  const now = o.now ?? Date.now();
  const idx = readIndex(vault);
  const { kind, slug, rec } = resolveForWrite(idx, idOrName, o.kind);
  let doc = readPage(vault, kind, slug);
  if (!doc) {
    doc = newPage({ name: o.name?.trim() || rec?.name || slug, kind, aliases: rec?.aliases ?? [] }, true, now);
    if (rec) { doc.mention_count = rec.mention_count; doc.conversations = conversationsSection(rec); }
  }
  doc.notes = text.replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
  doc.updated = iso(now);
  writePage(vault, kind, slug, doc);
  const next = buildIndex(vault, { now });
  return entityDetail(vault, next, `${kind}/${slug}`)!;
}

// ---------------------------------------------------------------------------
// refresh / backfill entry points

export interface RefreshEntitiesOptions {
  run?: ModelRunner | null; // digests; null = none
  digestModel?: ModelChoice;
  digestLimit?: number;
  log?: (m: string) => void;
  now?: number;
}

export async function refreshEntities(vault: string, o: RefreshEntitiesOptions = {}) {
  const now = o.now ?? Date.now();
  const idx = buildIndex(vault, { now });
  const pages = syncPages(vault, idx, now);
  const digests = await refreshDigests(vault, idx, { run: o.run === undefined ? runModelOnce : o.run, model: o.digestModel, limit: o.digestLimit, log: o.log, now });
  return { entities: idx.entities.length, pages_created: pages.created, pages_updated: pages.updated, digests_written: digests.written, digests_pending: digests.pending };
}

// ---------------------------------------------------------------------------
// text renderings (CLI + MCP)

const KIND_LABEL: Record<EntityKind, string> = { person: "Person", place: "Place", org: "Company or product", thing: "Thing" };

export function entityContextText(d: EntityDetail, maxMentions = 12): string {
  const out: string[] = [`# ${d.name} (${KIND_LABEL[d.kind]}, id ${d.id})`];
  if (d.aliases.length) out.push(`Also called: ${d.aliases.join(", ")}`);
  out.push(`Mentioned ${d.mention_count} times across ${d.conversations} conversations${d.last_ts ? `, last on ${day(d.last_ts)}` : ""}.`);
  if (d.page_path) out.push(`Vault page: ${d.page_path}${d.saved ? " (saved)" : ""}`);
  if (d.digest) out.push("", "## What they have discussed", d.digest);
  if (d.notes) out.push("", "## Their notes", d.notes);
  if (d.mentions.length) {
    out.push("", "## Recent mentions");
    for (const m of d.mentions.slice(0, maxMentions)) out.push(`- ${day(m.ts)} ${m.source === "prompt" ? `prompt (${m.title})` : `${m.source}: ${m.title}`}: ${m.snippet}`);
  }
  if (d.co_mentions.length) out.push("", `Often mentioned with: ${d.co_mentions.slice(0, 5).map((c) => c.name).join(", ")}`);
  return out.join("\n");
}
