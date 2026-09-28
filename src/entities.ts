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
//   data/entities/<kind dir>/<slug>/    one folder per entity:
//     entity.md                         the page (the user's "Your notes"
//                                       section is never rewritten here)
//     picture.<png|jpg|webp|svg>        optional picture
//     files/                            optional attachments
//                                       (a pre-folder vault has <slug>.md;
//                                       it is read as a fallback and moved
//                                       into the folder on refresh)
//   data/entities/merges.json           merge decisions (synced, not _meta):
//                                       which ids were folded into which, and
//                                       pairs the user said are not the same
//   data/entities/_merged/<kind dir>/<slug>/  merged entities' folders, archived
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { sanitizeEmDashes } from "./cli-bridge.ts";
import { dataRoot, DOMAINS_DIR, APPS_DIR, entitiesContainer, runtimePath } from "./path-safety.ts";
import { displayLine, parseJsonAnswer, runModelOnce, SYNTH_DEFAULTS, type ModelChoice, type ModelRunner } from "./prompt-projects.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { vreadFile, vwriteFile, vwriteFileAtomic } from "./vault-session.ts";

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
  website?: string; // the page's `website:` (set by the user, or inferred for an org)
  picture?: string; // vault-relative picture path when the folder has one
}

export interface EntityIndex {
  version: 1; generated_ts: number; entities: EntityRec[];
  // merged id -> the id it now resolves to (from data/entities/merges.json,
  // re-read on every readIndex/buildIndex, never trusted from the cache)
  merged?: Record<string, string>;
}

export interface EntitySummary {
  id: string; name: string; kind: EntityKind; aliases: string[]; mention_count: number; conversations: number;
  last_ts: number; saved: boolean; has_page: boolean; domain?: string;
  website?: string; picture?: string; // picture: absolute path
}

// ---------------------------------------------------------------------------
// small helpers

const META = (vault: string, name: string) => runtimePath(vault, join("_meta", "entities", name));
const MAX_MENTIONS = 200;
// Every indexed entity gets a page; the "What you've discussed" digest is
// written only for saved entities and those seen in DIGEST_AT+ conversations.
const DIGEST_AT = 3;
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

// `entity` is the thread's `entity: <kind>/<slug>` frontmatter tag (an entity
// chat); `excerpt` is its user turns, the mention snippet for that tag.
interface FileLinks {
  mtime: number; size: number; title: string; ts: number; domain: string; source: MentionSource; links: RawLink[];
  entity?: string; excerpt?: string; turns?: number;
}
// v2 added entity/excerpt/turns; an older cache is re-read in full once.
const CACHE_V = 2;
interface ThreadCache { v?: number; files: Record<string, FileLinks> }

// Turn headers exactly as the desktop serializer writes them: "## You", or
// "## <cli>" / "## <cli> · <model>" with a lowercase, space-free cli token.
const TURN_RE = /^## (You|[a-z0-9][a-z0-9._-]*(?: · .+)?)\s*$/;

function threadShape(md: string): { turns: number; excerpt: string } {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const fmTurns = Number(frontmatterField(md, "turns"));
  let turns = 0;
  let role: "user" | "other" | null = null;
  const user: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(TURN_RE);
    if (m) { turns++; role = m[1] === "You" ? "user" : "other"; continue; }
    if (role === "user" && line.trim()) user.push(line.trim());
  }
  return { turns: Number.isFinite(fmTurns) && fmTurns > 0 ? fmTurns : turns, excerpt: displayLine(user.join(" / "), 240) };
}

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
  const disk = readJson<ThreadCache>(path, { files: {} });
  const prev: ThreadCache = disk.v === CACHE_V ? disk : { files: {} };
  const next: ThreadCache = { v: CACHE_V, files: {} };
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
    const entity = src.source === "thread" ? frontmatterField(md, "entity") : "";
    next.files[rel] = {
      mtime: st.mtimeMs, size: st.size, title: displayLine(title, 120), ts, domain: src.domain, source: src.source, links: extractLinks(md),
      ...(src.source === "thread" ? threadShape(md) : {}), ...(entity ? { entity } : {}),
    };
  }
  if (read || disk.v !== CACHE_V || Object.keys(prev.files).length !== Object.keys(next.files).length) writeJson(path, next);
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
    } catch {
      res.failed += batch.length;
      // Logs can land outside the vault (daemon logs), so they carry counts
      // only: no entity names, ids, excerpts or model output.
      o.log?.("entity tags: a batch failed; retry next time");
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
  website?: string; // a bare domain or URL
  picture?: string; // file name inside the entity folder
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

export const PAGE_FILE = "entity.md";

export function entityDir(vault: string, kind: EntityKind, slug: string): string {
  return join(entitiesContainer(vault), KIND_DIR[kind], slug);
}

// Where a page is written: the entity folder's entity.md.
export function pagePath(vault: string, kind: EntityKind, slug: string): string {
  return join(entityDir(vault, kind, slug), PAGE_FILE);
}

const flatPath = (vault: string, kind: EntityKind, slug: string) => join(entitiesContainer(vault), KIND_DIR[kind], `${slug}.md`);

// The page file that exists: the folder's entity.md, else a pre-folder
// <slug>.md, else null.
export function pageFile(vault: string, kind: EntityKind, slug: string): string | null {
  const p = pagePath(vault, kind, slug);
  if (existsSync(p)) return p;
  const flat = flatPath(vault, kind, slug);
  return existsSync(flat) ? flat : null;
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
      else if (key === "website") doc.website = val || undefined;
      else if (key === "picture") doc.picture = val || undefined;
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
    ...(d.website ? [`website: ${yamlStr(d.website)}`] : []),
    ...(d.picture ? [`picture: ${yamlStr(d.picture)}`] : []),
    ...Object.entries(d.extra).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
  ];
  return [
    ...fm,
    ...(d.preamble ? [d.preamble, ""] : []),
    // The digest section appears once there is a digest to show.
    ...(d.discussed ? [`## ${H_DISCUSSED}`, "", d.discussed, ""] : []),
    `## ${H_NOTES}`, "", d.notes, ...(d.notes ? [""] : []),
    `## ${H_CONVOS}`, "", d.conversations || EMPTY_CONVOS, "",
  ].join("\n");
}

export function readPage(vault: string, kind: EntityKind, slug: string): PageDoc | null {
  const p = pageFile(vault, kind, slug);
  if (!p) return null;
  try { return parsePage(vreadFile(p), { kind, slug }); } catch { return null; }
}

function writePage(vault: string, kind: EntityKind, slug: string, d: PageDoc) {
  const p = pagePath(vault, kind, slug);
  // A pre-folder page moves into its folder first, so nothing is left behind.
  const flat = flatPath(vault, kind, slug);
  if (!existsSync(p) && existsSync(flat)) migrateOne(flat, p);
  mkdirSync(dirname(p), { recursive: true });
  vwriteFile(p, renderPage(d));
}

// Move one flat page into its folder. Never overwrites: when entity.md is
// already there the flat file lands beside it as entity.conflict[-N].md.
function migrateOne(flat: string, target: string): "moved" | string {
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) { renameSync(flat, target); return "moved"; }
  let n = 1;
  let to = join(dirname(target), "entity.conflict.md");
  while (existsSync(to)) to = join(dirname(target), `entity.conflict-${++n}.md`);
  renameSync(flat, to);
  return to;
}

// Pre-folder vaults: move every <kind dir>/<slug>.md (and the same in
// _merged/) to <slug>/entity.md. Idempotent; never deletes or overwrites.
export function migrateEntityFolders(vault: string): { moved: number; conflicts: string[] } {
  const res = { moved: 0, conflicts: [] as string[] };
  const root = entitiesContainer(vault);
  for (const base of [root, join(root, "_merged")]) {
    for (const kind of ENTITY_KINDS) {
      const dir = join(base, KIND_DIR[kind]);
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".md") || n.startsWith(".")) continue;
        const flat = join(dir, n);
        try { if (!statSync(flat).isFile()) continue; } catch { continue; }
        const r = migrateOne(flat, join(dir, n.slice(0, -3), PAGE_FILE));
        if (r === "moved") res.moved++;
        else res.conflicts.push(relative(vault, r));
      }
    }
  }
  return res;
}

export interface PageRef { id: string; kind: EntityKind; slug: string; path: string; doc: PageDoc }

export function listPages(vault: string): PageRef[] {
  const out: PageRef[] = [];
  const root = entitiesContainer(vault);
  for (const kind of ENTITY_KINDS) {
    let names: string[] = [];
    try { names = readdirSync(join(root, KIND_DIR[kind])); } catch { continue; }
    // Folders (<slug>/entity.md) and pre-folder <slug>.md pages, once each.
    const slugs = new Set<string>();
    for (const n of names) {
      if (n.startsWith(".")) continue;
      if (n.endsWith(".md")) slugs.add(n.slice(0, -3));
      else if (existsSync(join(root, KIND_DIR[kind], n, PAGE_FILE))) slugs.add(n);
    }
    for (const slug of slugs) {
      const doc = readPage(vault, kind, slug);
      const file = pageFile(vault, kind, slug);
      if (doc && file) out.push({ id: `${kind}/${slug}`, kind, slug, path: relative(vault, file), doc });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// index

export function readIndex(vault: string): EntityIndex {
  const i = readJson<Partial<EntityIndex>>(META(vault, "index.json"), {});
  return { version: 1, generated_ts: i.generated_ts ?? 0, entities: i.entities ?? [], merged: mergeMap(readMerges(vault)) };
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
  const merged = mergeMap(readMerges(vault));
  const redirect = slugRedirects(merged);
  // A merged entity's page is archived; one still here (sync lag) is ignored.
  const pages = listPages(vault).filter((p) => !redirect.has(p.slug));

  // A page fixes an entity's kind and folds its aliases in.
  const pageBySlug = new Map<string, PageRef>();
  const aliasToSlug = new Map<string, string>();
  for (const p of pages) {
    pageBySlug.set(p.slug, p);
    for (const a of [p.doc.name, ...p.doc.aliases]) { const s = slugify(a); if (s && s !== p.slug) aliasToSlug.set(s, p.slug); }
  }
  // An alias never swallows a name that has a page of its own.
  for (const s of pageBySlug.keys()) aliasToSlug.delete(s);
  const acc = new Map<string, Acc>();
  const add = (rawName: string, kind: EntityKind, m: Mention, label?: string) => {
    let slug = slugify(rawName);
    if (!slug) return;
    slug = redirect.get(slug) ?? aliasToSlug.get(slug) ?? slug;
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
    // An entity chat (entity: <kind>/<slug> tag) is a conversation about that
    // entity even when the model never linked it.
    const tag = f.entity ? parseEntityId(f.entity) : null;
    if (tag?.kind && !seen.has(`${tag.kind}:${tag.slug}`)) {
      add(tag.slug, tag.kind, { source: f.source, ref: rel, domain: f.domain, project: "", title: f.title, ts: f.ts, snippet: f.excerpt ?? "" });
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
      ...(page?.doc.website ? { website: page.doc.website } : {}),
      ...(page ? pictureOf(vault, page.kind, page.slug, page.doc) : {}),
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
  const idx: EntityIndex = { version: 1, generated_ts: opts.now ?? Date.now(), entities: recs, merged };
  writeJson(META(vault, "index.json"), idx);
  return idx;
}

// `vault` turns the picture into an absolute path (CLI JSON).
export function summarize(r: EntityRec, vault?: string): EntitySummary {
  return {
    id: r.id, name: r.name, kind: r.kind, aliases: r.aliases, mention_count: r.mention_count, conversations: r.conversations,
    last_ts: r.last_ts, saved: !!r.saved, has_page: !!r.page, ...(r.domain ? { domain: r.domain } : {}),
    ...(r.website ? { website: r.website } : {}), ...(r.picture ? { picture: vault ? join(vault, r.picture) : r.picture } : {}),
  };
}

function pictureOf(vault: string, kind: EntityKind, slug: string, doc: PageDoc): { picture?: string } {
  if (!doc.picture || doc.picture.includes("/") || doc.picture.includes("\\")) return {};
  const p = join(entityDir(vault, kind, slug), doc.picture);
  return existsSync(p) ? { picture: relative(vault, p) } : {};
}

export function findEntity(idx: EntityIndex, idOrName: string): EntityRec | null {
  const p = redirectParsed(idx.merged, parseEntityId(idOrName));
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

// Give every indexed entity a page and keep every page's count +
// Conversations list current. Never touches notes.
export function syncPages(vault: string, idx: EntityIndex, now = Date.now()): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  for (const r of idx.entities) {
    const slug = r.id.slice(r.id.indexOf("/") + 1);
    let doc = readPage(vault, r.kind, slug);
    const isNew = !doc;
    if (!doc) doc = newPage(r, false, now);
    const convos = conversationsSection(r);
    const site = r.kind === "org" && !doc.website ? inferWebsite(r) : undefined;
    if (!isNew && !site && doc.mention_count === r.mention_count && doc.conversations === convos) continue;
    if (site) { doc.website = site; r.website = site; }
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

// An org's website, only from a URL in its own mentions whose registrable
// domain spells the org's name ("Foo Co" <- https://www.fooco.com/x or
// foo.com). Never guessed from the name alone; never for other kinds.
const URL_RE = /\b(?:https?:\/\/|www\.)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const SLD = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

export function registrableLabel(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const i = parts.length >= 3 && parts[parts.length - 1].length === 2 && SLD.has(parts[parts.length - 2]) ? parts.length - 3 : parts.length - 2;
  return parts[i] ?? "";
}

export function inferWebsite(r: EntityRec): string | undefined {
  if (r.kind !== "org") return undefined;
  const want = new Set([r.name, ...r.aliases].map((n) => nameTokens(n, "org").join("")).filter((n) => n.length >= 3));
  for (const m of r.mentions) {
    URL_RE.lastIndex = 0;
    for (let x = URL_RE.exec(m.snippet); x; x = URL_RE.exec(m.snippet)) {
      const host = x[1].toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
      if (want.has(registrableLabel(host))) return host;
    }
  }
  return undefined;
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
  const due = idx.entities.filter((r) => r.page && r.mentions.length && (r.saved || r.conversations >= DIGEST_AT) && state[r.id]?.hash !== hash(r.mentions.map((m) => `${m.ref}|${m.snippet}`).join("\n")));
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
    } catch { o.log?.("entities: a digest failed; retry next refresh"); }
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
    const p = redirectParsed(idx.merged, parseEntityId(idOrName));
    if (!p?.kind) return null;
    const doc = readPage(vault, p.kind, p.slug);
    if (!doc) return null;
    r = { id: `${p.kind}/${p.slug}`, name: doc.name, kind: p.kind, aliases: doc.aliases, kinds: [p.kind], mention_count: 0, conversations: 0, last_ts: 0, mentions: [], co_mentions: [], page: relative(vault, pageFile(vault, p.kind, p.slug) ?? pagePath(vault, p.kind, p.slug)), saved: doc.saved };
  }
  const slug = r.id.slice(r.id.indexOf("/") + 1);
  const doc = readPage(vault, r.kind, slug);
  const pic = doc ? pictureOf(vault, r.kind, slug, doc).picture : undefined;
  return {
    ...r, digest: doc?.discussed ?? "", notes: doc?.notes ?? "",
    ...(doc ? { page_path: relative(vault, pageFile(vault, r.kind, slug) ?? pagePath(vault, r.kind, slug)), saved: doc.saved, website: doc.website } : {}),
    // Absolute, for the CLI/desktop.
    picture: pic ? join(vault, pic) : undefined,
  };
}

function resolveForWrite(idx: EntityIndex, idOrName: string, kindHint?: string): { kind: EntityKind; slug: string; rec: EntityRec | null } {
  const rec = findEntity(idx, idOrName);
  if (rec) return { kind: rec.kind, slug: rec.id.slice(rec.id.indexOf("/") + 1), rec };
  const p = redirectParsed(idx.merged, parseEntityId(idOrName));
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

// Add a dated paragraph to the end of "Your notes" (the chat's "Add to notes").
// Creates a saved page when there is none yet, like setNotes.
export function appendNote(vault: string, idOrName: string, text: string, o: { kind?: string; name?: string; now?: number } = {}): EntityDetail {
  const now = o.now ?? Date.now();
  const para = text.replace(/\r\n/g, "\n").trim();
  if (!para) throw new Error("empty note");
  const { kind, slug } = resolveForWrite(readIndex(vault), idOrName, o.kind);
  const have = readPage(vault, kind, slug)?.notes ?? "";
  return setNotes(vault, `${kind}/${slug}`, `${have ? `${have}\n\n` : ""}${day(now)}: ${para}`, { ...o, kind, now });
}

// Entity chats: threads whose frontmatter carries `entity: <id>`, newest first.
export interface EntityThread { slug: string; domain: string; title: string; updated: number; turns: number }

export function entityThreads(vault: string, idOrName: string): EntityThread[] {
  const idx = readIndex(vault);
  const rec = findEntity(idx, idOrName);
  const want = rec ? { kind: rec.kind as EntityKind | null, slug: rec.id.slice(rec.id.indexOf("/") + 1) } : redirectParsed(idx.merged, parseEntityId(idOrName));
  if (!want) return [];
  const out: EntityThread[] = [];
  for (const [rel, f] of Object.entries(scanLinks(vault).cache.files)) {
    // Threads are never rewritten: an `entity:` tag naming a merged id counts
    // for its keeper through the merge map.
    const raw = f.entity ? parseEntityId(f.entity) : null;
    const tag = redirectParsed(idx.merged, raw);
    if (!tag || tag.slug !== want.slug || (tag === raw && want.kind && tag.kind && tag.kind !== want.kind)) continue;
    out.push({ slug: rel.split("/").pop()!.replace(/\.md$/, ""), domain: f.domain, title: f.title, updated: f.ts, turns: f.turns ?? 0 });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// ---------------------------------------------------------------------------
// duplicates: find entities that are the same one, merge them, remember
// "not the same" answers. Precision over recall: only a name that is the same
// once normalized (or a multi-word alias) merges on its own; a shared first
// name, a short form or a likely typo is only ever proposed.

export interface MergeRec { from: string; into: string; ts: string; auto: boolean; reason: string }
export interface MergesFile { merges: MergeRec[]; notSame: [string, string][] }

export const AUTO_MERGE = 0.9;
export const PROPOSE_AT = 0.5;

const mergesPath = (vault: string) => join(entitiesContainer(vault), "merges.json");

export function readMerges(vault: string): MergesFile {
  const m = readJson<Partial<MergesFile>>(mergesPath(vault), {});
  return {
    merges: Array.isArray(m.merges) ? m.merges.filter((r) => typeof r?.from === "string" && typeof r?.into === "string") : [],
    notSame: Array.isArray(m.notSame) ? m.notSame.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string")) : [],
  };
}

// Read-modify-write of merges.json under its lock, written atomically.
function updateMerges(vault: string, fn: (m: MergesFile) => void) {
  const path = mergesPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  const lock = tryAcquireLock(`${path}.lock`);
  try {
    const m = readMerges(vault);
    fn(m);
    vwriteFileAtomic(path, `${JSON.stringify(m, null, 2)}\n`);
  } finally { lock?.release(); }
}

// from id -> the id it finally resolves to (merge chains followed, cycle-safe).
export function mergeMap(m: MergesFile): Record<string, string> {
  const next = new Map(m.merges.map((r) => [r.from, r.into]));
  const out: Record<string, string> = {};
  for (const from of next.keys()) {
    let at = from;
    const seen = new Set([at]);
    while (next.has(at) && !seen.has(next.get(at)!)) { at = next.get(at)!; seen.add(at); }
    if (at !== from) out[from] = at;
  }
  return out;
}

const slugOf = (id: string) => id.slice(id.indexOf("/") + 1);

// The index keys entities by slug, so redirects are by slug too.
function slugRedirects(merged: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(merged).map(([f, t]) => [slugOf(f), slugOf(t)]));
}

function redirectParsed(merged: Record<string, string> | undefined, p: { kind: EntityKind | null; slug: string } | null): { kind: EntityKind | null; slug: string } | null {
  if (!p || !merged) return p;
  const into = (p.kind ? merged[`${p.kind}/${p.slug}`] : undefined) ?? Object.entries(merged).find(([f]) => slugOf(f) === p.slug)?.[1];
  return into ? parseEntityId(into) : p;
}

export const resolveEntityId = (vault: string, id: string): string => {
  const p = redirectParsed(mergeMap(readMerges(vault)), parseEntityId(id));
  return p ? (p.kind ? `${p.kind}/${p.slug}` : p.slug) : id;
};

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface DuplicateSide { id: string; name: string; kind: EntityKind; mentions: number }
export interface DuplicateCandidate { pair: string; a: DuplicateSide; b: DuplicateSide; confidence: number; reason: string }

const ORG_SUFFIX = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "the", "gmbh", "plc", "ag"]);

function nameTokens(name: string, kind: EntityKind): string[] {
  const t = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  const kept = kind === "org" ? t.filter((w) => !ORG_SUFFIX.has(w)) : t;
  return kept.length ? kept : t;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// A likely typo or speech-to-text variant: one short word off by one letter
// (two for 8+ letters), or one word off by one letter in a same-length name
// where that word has 5+ letters. "Foo Bar" vs "Foo Baz" never qualifies.
function typoOf(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length > 3) return false;
  const diff = a.map((w, i) => [w, b[i]] as const).filter(([x, y]) => x !== y);
  if (diff.length !== 1) return false;
  const [x, y] = diff[0];
  const len = Math.min(x.length, y.length);
  if (a.length === 1) return len >= 4 && editDistance(x, y) <= (len >= 8 ? 2 : 1);
  return len >= 5 && editDistance(x, y) === 1;
}

interface Shape { rec: EntityRec; toks: string[]; norm: string; compact: string; aliasNorms: Set<string>; refs: Set<string> }

const quote = (s: string) => `"${s}"`;

function scorePair(x: Shape, y: Shape, containers: Map<string, number>): { confidence: number; reason: string } | null {
  const [A, B] = [x.rec, y.rec];
  if (x.norm === y.norm || x.compact === y.compact) return { confidence: 0.97, reason: `${quote(A.name)} and ${quote(B.name)} are the same name written differently` };
  // One name is listed as the other's alias.
  const aliasHit = y.aliasNorms.has(x.norm) ? { alias: x, of: y } : x.aliasNorms.has(y.norm) ? { alias: y, of: x } : null;
  let score = 0;
  let reason = "";
  if (aliasHit && aliasHit.alias.toks.length > 1) {
    return { confidence: 0.93, reason: `${quote(aliasHit.alias.rec.name)} is already another name for ${quote(aliasHit.of.rec.name)}` };
  }
  if (aliasHit) { score = 0.75; reason = `${quote(aliasHit.of.rec.name)} is also called ${quote(aliasHit.alias.rec.name)}`; }
  // A one-word name inside a longer one ("Foo" in "Foo Bar"). A bare shared
  // first name: weaker when several longer names contain the same word, and
  // weaker still for places, orgs and things ("Foo" vs "Foo Maps").
  const [short, long] = x.toks.length === 1 ? [x, y] : [y, x];
  if (!score && short.toks.length === 1 && long.toks.length > 1 && short.norm.length >= 3 && long.toks.includes(short.norm)) {
    const ambiguous = (containers.get(`${A.kind}:${short.norm}`) ?? 0) > 1;
    score = (A.kind === "person" ? 0.65 : 0.55) - (ambiguous ? 0.1 : 0);
    reason = `${quote(short.rec.name)} could be short for ${quote(long.rec.name)}${ambiguous ? " (other names contain it too)" : ""}`;
  }
  if (!score && typoOf(x.toks, y.toks)) { score = 0.65; reason = `${quote(A.name)} and ${quote(B.name)} look like spellings of one name`; }
  if (!score) return null;
  // Supporting evidence only: never lifts a proposal to an automatic merge.
  let shared = 0;
  for (const r of x.refs) if (y.refs.has(r)) shared++;
  if (shared) { score = Math.min(0.85, score + Math.min(0.1, 0.05 * shared)); reason += `; both come up in ${shared > 1 ? `${shared} of the same conversations` : "the same conversation"}`; }
  return { confidence: Math.round(score * 100) / 100, reason };
}

// "The fuller name": more words, then longer, then more mentions.
function fuller(a: EntityRec, b: EntityRec, ta: string[], tb: string[]): boolean {
  return ta.length !== tb.length ? ta.length > tb.length : a.name.length !== b.name.length ? a.name.length > b.name.length : a.mention_count >= b.mention_count;
}

// Candidate pairs, same kind only, confidence >= PROPOSE_AT, minus pairs the
// user said are not the same. `a` is the side with the fuller name (the
// default keeper). Sorted by confidence.
export function findDuplicates(idx: EntityIndex, merges: MergesFile): DuplicateCandidate[] {
  const map = mergeMap(merges);
  const res = (id: string) => map[id] ?? id;
  const blocked = new Set(merges.notSame.map(([a, b]) => pairKey(res(a), res(b))));
  const shapes: Shape[] = [];
  for (const r of idx.entities) {
    const toks = nameTokens(r.name, r.kind);
    if (!toks.length) continue;
    shapes.push({
      rec: r, toks, norm: toks.join(" "), compact: toks.join(""),
      aliasNorms: new Set(r.aliases.map((a) => nameTokens(a, r.kind).join(" ")).filter(Boolean)),
      refs: new Set(r.mentions.map((m) => `${m.source}:${m.ref}`)),
    });
  }
  const containers = new Map<string, number>();
  for (const s of shapes) if (s.toks.length > 1) for (const t of new Set(s.toks)) containers.set(`${s.rec.kind}:${t}`, (containers.get(`${s.rec.kind}:${t}`) ?? 0) + 1);
  const side = (r: EntityRec): DuplicateSide => ({ id: r.id, name: r.name, kind: r.kind, mentions: r.mention_count });
  const out: DuplicateCandidate[] = [];
  // ponytail: all pairs within a kind, O(n^2) with cheap checks first; block by
  // token if entity counts reach the tens of thousands.
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const x = shapes[i];
      const y = shapes[j];
      if (x.rec.kind !== y.rec.kind || blocked.has(pairKey(x.rec.id, y.rec.id))) continue;
      const s = scorePair(x, y, containers);
      if (!s || s.confidence < PROPOSE_AT) continue;
      const [a, b] = fuller(x.rec, y.rec, x.toks, y.toks) ? [x.rec, y.rec] : [y.rec, x.rec];
      out.push({ pair: pairKey(a.id, b.id), a: side(a), b: side(b), confidence: s.confidence, reason: s.reason });
    }
  }
  return out.sort((p, q) => q.confidence - p.confidence || q.a.mentions + q.b.mentions - p.a.mentions - p.b.mentions);
}

export function entityDuplicates(vault: string): DuplicateCandidate[] {
  const idx = readIndex(vault).generated_ts ? readIndex(vault) : buildIndex(vault);
  return findDuplicates(idx, readMerges(vault));
}

// Fold `mergeId` into `keepId`. Nothing is lost: the keeper gains the other's
// name and aliases as aliases, its notes (appended under a dated "Merged from"
// line) and, through merges.json, every mention, conversation and `entity:`
// tag. The merged page moves to data/entities/_merged/. The keeper keeps its
// own display name (auto-merges pick the fuller name as keeper).
export function mergeEntities(vault: string, keepId: string, mergeId: string, o: { auto?: boolean; reason?: string; now?: number; idx?: EntityIndex; rebuild?: boolean } = {}): { ok: true; id: string } {
  const now = o.now ?? Date.now();
  const idx = o.idx ? { ...o.idx, merged: mergeMap(readMerges(vault)) } : readIndex(vault).generated_ts ? readIndex(vault) : buildIndex(vault, { now });
  const keep = entityDetail(vault, idx, keepId);
  const gone = entityDetail(vault, idx, mergeId);
  if (!keep) throw new Error(`no entity "${keepId}"`);
  if (!gone) throw new Error(`no entity "${mergeId}"`);
  if (keep.id === gone.id) throw new Error(`"${mergeId}" is already ${keep.id}`);
  const kSlug = slugOf(keep.id);
  const gSlug = slugOf(gone.id);
  const kDoc = readPage(vault, keep.kind, kSlug) ?? { ...newPage(keep, false, now), mention_count: keep.mention_count, conversations: conversationsSection(keep) };
  const gDoc = readPage(vault, gone.kind, gSlug);

  const seen = new Set([kDoc.name.toLowerCase()]);
  const aliases: string[] = [];
  for (const a of [...kDoc.aliases, gDoc?.name ?? gone.name, ...(gDoc?.aliases ?? []), ...gone.aliases]) {
    const t = a.trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); aliases.push(t); }
  }
  kDoc.aliases = aliases;
  // User text is never dropped: the other page's notes (and anything it had
  // above its sections) land at the end of the keeper's notes.
  const carried = [gDoc?.preamble ?? "", gDoc?.notes ?? ""].filter((t) => t.trim()).join("\n\n");
  if (carried) kDoc.notes = `${kDoc.notes ? `${kDoc.notes}\n\n` : ""}${day(now)}: Merged from ${gDoc?.name ?? gone.name}:\n${carried}`;
  if (gDoc?.saved) kDoc.saved = true;
  if (!kDoc.domain && gDoc?.domain) kDoc.domain = gDoc.domain;
  for (const [k, v] of Object.entries(gDoc?.extra ?? {})) if (!(k in kDoc.extra)) kDoc.extra[k] = v;
  kDoc.updated = iso(now);
  writePage(vault, keep.kind, kSlug, kDoc);

  updateMerges(vault, (m) => {
    m.merges.push({ from: gone.id, into: keep.id, ts: iso(now), auto: !!o.auto, reason: o.reason ?? "merged by you" });
  });

  // The merged entity's files are copied to the keeper (its picture too when
  // the keeper has none); then its whole folder is archived under _merged/.
  const gDir = entityDir(vault, gone.kind, gSlug);
  const kDir = entityDir(vault, keep.kind, kSlug);
  for (const f of listEntityFiles(gDir)) copyInto(join(gDir, "files", f.name), join(kDir, "files"), f.name);
  const gPic = gDoc ? pictureOf(vault, gone.kind, gSlug, gDoc).picture : undefined;
  if (gPic && !pictureOf(vault, keep.kind, kSlug, kDoc).picture) {
    const name = `picture${extname(gPic)}`;
    mkdirSync(kDir, { recursive: true });
    if (!existsSync(join(kDir, name))) { copyFileSync(join(vault, gPic), join(kDir, name)); kDoc.picture = name; writePage(vault, keep.kind, kSlug, kDoc); }
  }
  const archive = join(entitiesContainer(vault), "_merged", KIND_DIR[gone.kind]);
  let to = join(archive, gSlug);
  if (existsSync(to)) to = join(archive, `${gSlug}-${day(now)}-${hash(String(now)).slice(0, 6)}`);
  const flat = flatPath(vault, gone.kind, gSlug);
  if (existsSync(gDir)) {
    mkdirSync(archive, { recursive: true });
    renameSync(gDir, to);
  }
  if (existsSync(flat)) migrateOne(flat, join(to, PAGE_FILE));
  if (o.rebuild !== false) syncPages(vault, buildIndex(vault, { now }), now);
  return { ok: true, id: keep.id };
}

// ---------------------------------------------------------------------------
// entity folder: picture, website, files

const PICTURE_TYPES: Record<string, string> = { ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp", ".svg": "svg" };
export const PICTURE_MAX = 5 * 1024 * 1024;

function pictureType(buf: Buffer, ext: string): string | null {
  const want = PICTURE_TYPES[ext.toLowerCase()];
  if (!want) return null;
  const ok = want === "png" ? buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : want === "jpg" ? buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    : want === "webp" ? buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP"
    : /<svg[\s>]/i.test(buf.toString("utf8", 0, 4096));
  return ok ? want : null;
}

// The page for a write: resolves merges, creates a saved page when there is
// none yet (like setNotes).
function pageForWrite(vault: string, idOrName: string, now: number): { kind: EntityKind; slug: string; doc: PageDoc } {
  const { kind, slug, rec } = resolveForWrite(readIndex(vault), idOrName);
  let doc = readPage(vault, kind, slug);
  if (!doc) {
    doc = newPage({ name: rec?.name || slug, kind, aliases: rec?.aliases ?? [] }, true, now);
    if (rec) { doc.mention_count = rec.mention_count; doc.conversations = conversationsSection(rec); }
  }
  return { kind, slug, doc };
}

// Copy `src` into `dir` as `name`, never overwriting: "a.pdf" becomes
// "a (2).pdf" when taken. Returns the name used.
function copyInto(src: string, dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 1;
  let use = name;
  while (existsSync(join(dir, use))) use = `${stem} (${++n})${ext}`;
  copyFileSync(src, join(dir, use));
  return use;
}

// ponytail: pictures and files are copied as-is (binary), not through the
// vault's text encryption; add a binary vault writer if encrypted vaults need them sealed.
export function setPicture(vault: string, idOrName: string, file: string, o: { now?: number } = {}): { ok: true; path: string } {
  const now = o.now ?? Date.now();
  let st;
  try { st = statSync(file); } catch { throw new Error(`no file "${file}"`); }
  if (!st.isFile()) throw new Error(`not a file: "${file}"`);
  if (st.size > PICTURE_MAX) throw new Error("picture is over 5 MB");
  const type = pictureType(readFileSync(file), extname(file));
  if (!type) throw new Error("picture must be a png, jpg, webp or svg image");
  const { kind, slug, doc } = pageForWrite(vault, idOrName, now);
  const dir = entityDir(vault, kind, slug);
  const name = `picture.${type}`;
  // A previous picture is kept in files/, never overwritten.
  const prev = doc.picture && !doc.picture.includes("/") ? join(dir, doc.picture) : "";
  if (prev && existsSync(prev)) {
    copyInto(prev, join(dir, "files"), `previous-${day(now)}${extname(prev)}`);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, join(dir, name));
  doc.picture = name;
  doc.updated = iso(now);
  writePage(vault, kind, slug, doc);
  buildIndex(vault, { now });
  return { ok: true, path: join(dir, name) };
}

export function setWebsite(vault: string, idOrName: string, url: string, o: { now?: number } = {}): { ok: true } {
  const now = o.now ?? Date.now();
  const u = url.trim();
  if (u && !/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(u)) throw new Error(`not a website: "${url}"`);
  const { kind, slug, doc } = pageForWrite(vault, idOrName, now);
  doc.website = u || undefined;
  doc.updated = iso(now);
  writePage(vault, kind, slug, doc);
  buildIndex(vault, { now });
  return { ok: true };
}

export interface EntityFile { name: string; size: number; mtime: number }

function listEntityFiles(dir: string): EntityFile[] {
  const fdir = join(dir, "files");
  let names: string[] = [];
  try { names = readdirSync(fdir); } catch { return []; }
  const out: EntityFile[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try { const st = statSync(join(fdir, name)); if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function entityFiles(vault: string, idOrName: string): EntityFile[] {
  const { kind, slug } = resolveForWrite(readIndex(vault), idOrName);
  return listEntityFiles(entityDir(vault, kind, slug));
}

export function addEntityFile(vault: string, idOrName: string, file: string, o: { now?: number } = {}): { ok: true; name: string } {
  let st;
  try { st = statSync(file); } catch { throw new Error(`no file "${file}"`); }
  if (!st.isFile()) throw new Error(`not a file: "${file}"`);
  const now = o.now ?? Date.now();
  const { kind, slug, doc } = pageForWrite(vault, idOrName, now);
  if (!pageFile(vault, kind, slug)) writePage(vault, kind, slug, doc);
  const safe = basename(file).replace(/[\/\\:\0]/g, "-").replace(/^\.+/, "") || "file";
  return { ok: true, name: copyInto(file, join(entityDir(vault, kind, slug), "files"), safe) };
}

// Record that two entities are different; the pair is never proposed again.
export function markNotSame(vault: string, idA: string, idB: string): { ok: true } {
  const idx = readIndex(vault).generated_ts ? readIndex(vault) : buildIndex(vault);
  const ids = [idA, idB].map((id) => findEntity(idx, id)?.id ?? resolveEntityId(vault, id));
  if (ids[0] === ids[1]) throw new Error("that is one entity");
  updateMerges(vault, (m) => {
    const key = pairKey(ids[0], ids[1]);
    if (!m.notSame.some(([a, b]) => pairKey(a, b) === key)) m.notSame.push(ids[0] < ids[1] ? [ids[0], ids[1]] : [ids[1], ids[0]]);
  });
  return { ok: true };
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
  const mig = migrateEntityFolders(vault);
  if (mig.conflicts.length) o.log?.(`entities: ${mig.conflicts.length} pages kept beside an existing entity.md as entity.conflict*.md`);
  let idx = buildIndex(vault, { now });
  // Fold clear duplicates (confidence >= AUTO_MERGE) before pages are synced.
  // A few rounds, since one merge can make the next pair clear.
  let merged = 0;
  for (let round = 0; round < 5; round++) {
    const clear = findDuplicates(idx, readMerges(vault)).filter((c) => c.confidence >= AUTO_MERGE);
    if (!clear.length) break;
    const used = new Set<string>();
    for (const c of clear) {
      if (used.has(c.a.id) || used.has(c.b.id)) continue;
      used.add(c.a.id); used.add(c.b.id);
      mergeEntities(vault, c.a.id, c.b.id, { auto: true, reason: c.reason, now, idx, rebuild: false });
      merged++;
    }
    idx = buildIndex(vault, { now });
  }
  const pages = syncPages(vault, idx, now);
  const pending = findDuplicates(idx, readMerges(vault)).length;
  const digests = await refreshDigests(vault, idx, { run: o.run === undefined ? runModelOnce : o.run, model: o.digestModel, limit: o.digestLimit, log: o.log, now });
  return {
    entities: idx.entities.length, pages_created: pages.created, pages_updated: pages.updated, digests_written: digests.written, digests_pending: digests.pending,
    merged, duplicates_pending: pending,
  };
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

// The context block `prevail chat --entity <id>` puts ahead of every turn:
// who or what the conversation is about, from the entity's page (digest,
// notes, the 10 newest Conversations lines), or from the index when there is
// no page yet. Capped at `cap` chars; the oldest material goes first (older
// conversation lines, then the oldest notes).
export function entityChatBlock(vault: string, idOrName: string, cap = 6000): string {
  const idx = readIndex(vault).generated_ts ? readIndex(vault) : buildIndex(vault);
  const d = entityDetail(vault, idx, idOrName);
  const p = parseEntityId(idOrName);
  const head = "# ENTITY CONTEXT";
  const about = (name: string, kind: EntityKind | null, id: string) =>
    `This conversation is about ${name}${kind ? ` (${KIND_LABEL[kind]}, id ${id})` : ""}. Answer with it in mind; the notes below are what the user has recorded.`;
  if (!d) {
    const name = idOrName.slice(idOrName.indexOf("/") + 1).trim() || idOrName;
    return `${head}\n${about(name, p?.kind ?? null, p?.kind ? `${p.kind}/${p.slug}` : "")}\nNothing is recorded about it yet.`;
  }
  const slug = d.id.slice(d.id.indexOf("/") + 1);
  const doc = readPage(vault, d.kind, slug);
  if (!doc) return clip(`${head}\n${about(d.name, d.kind, d.id)}\n\n${entityContextText(d, 10)}`, cap);

  const top = [head, about(doc.name, d.kind, d.id)];
  if (doc.aliases.length) top.push(`Also called: ${doc.aliases.join(", ")}`);
  const convos = doc.conversations.split("\n").filter((l) => l.startsWith("- ")).slice(0, 10);
  let notes = doc.notes;
  const render = () => [
    top.join("\n"),
    ...(doc.discussed ? [`## What you've discussed\n${doc.discussed}`] : []),
    ...(notes ? [`## Your notes\n${notes}`] : []),
    ...(convos.length ? [`## Recent conversations\n${convos.join("\n")}`] : []),
  ].join("\n\n");
  let text = render();
  while (text.length > cap && convos.length) { convos.pop(); text = render(); }
  if (text.length > cap && notes) {
    // Notes are appended with dates, so their oldest part is the head.
    const keep = Math.max(0, notes.length - (text.length - cap) - 2);
    notes = keep ? `…${notes.slice(notes.length - keep)}` : "";
    text = render();
  }
  return clip(text, cap);
}

function clip(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap - 1)}…`;
}
