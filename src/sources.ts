// Sources: where Prevail gets context for a conversation.
//
// Four kinds, as many of each as the user wants:
//   prevail   a Prevail vault. The one the app runs on is built in (domains,
//             entities, ideals, state, memory, source files); more vaults can
//             be added by folder and are read, never written.
//   obsidian  an Obsidian vault folder, imported one way into
//             data/domains/<domain>/source/obsidian/<id>/ exactly as
//             `prevail obsidian import` does, then indexed.
//   folder    any local folder of notes and text files, read in place.
//   website   a canonical site (fru.dev). sources-web.ts discovers its
//             machine-readable surface and indexes the tables.
//
// Where things live:
//   <vault>/build/sources.json            the list (vault-global config, syncs)
//   ~/.prevail/sources/<vault-key>/        the index + status per source. A
//                                          derived, rebuildable cache per
//                                          machine (paths differ per Mac), sealed
//                                          with the vault key when the vault is
//                                          encrypted.
//
// Retrieval is keyword BM25 over every enabled source, run at chat time with
// no model call and no network: websites answer from the last indexed copy.
// formatSourcesContext() turns the hits into a cited block that the desktop
// and runChatTurn place ahead of the user's message.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";

import { configDir, readBunker } from "./config.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { adoptObsidianApp, importObsidianVault } from "./obsidian-import.ts";
import { buildRoot, dataRoot } from "./path-safety.ts";
import { isVaultLocked, vreadFile, vreadSealed, vwriteFile, vwriteSealed } from "./vault-session.ts";
import { fieldsFor, normalizeSiteUrl, refreshWebsite, summarizeWeb, webDocs, type Fetcher, type SourceDoc, type WebState, type WebSummary } from "./sources-web.ts";

export type { SourceDoc } from "./sources-web.ts";

export type SourceKind = "prevail" | "obsidian" | "folder" | "website";
export const SOURCE_KINDS: readonly SourceKind[] = ["prevail", "obsidian", "folder", "website"];
export const SOURCES_HEADER = "# CONTEXT FROM YOUR SOURCES";
export const DEFAULT_VAULT_SOURCE_ID = "vault";

export interface SourceConfig {
  id: string;
  kind: SourceKind;
  name: string;
  // Folder path (~ allowed) or site URL. Empty for the built-in vault, which
  // always means "the vault this app runs on".
  location: string;
  enabled: boolean;
  added: string;
  // Obsidian: the domain the notes are imported into (default "notes").
  domain?: string;
  builtin?: boolean;
}

export type SourceState = "never" | "ready" | "indexing" | "error" | "missing" | "locked" | "paused";

export interface SourceStatus {
  state: SourceState;
  lastIndexed: string | null;
  items: number;
  files?: number;
  nextRefresh: string | null;
  error: string | null;
  // One line about what was found, e.g. "47 trackers, 61,204 rows".
  detail?: string;
  web?: WebSummary;
}

export interface SourceRow extends SourceConfig {
  resolvedLocation: string;
  status: SourceStatus;
}

interface SourcesFile { version: 1; sources: SourceConfig[] }

interface IndexFile {
  v: 1;
  id: string;
  kind: SourceKind;
  builtAt: string;
  fingerprint?: string;
  docs?: SourceDoc[];
  web?: WebState;
}

const LOCAL_REFRESH_MS = 30 * 60_000;
const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 300_000;
const MAX_DOCS = 60_000;
const CHUNK_CHARS = 1_200;

// ── Paths ───────────────────────────────────────────────────────────────

export function sourcesFile(vault: string): string {
  return join(buildRoot(vault), "sources.json");
}

export function sourcesCacheDir(vault: string): string {
  const key = createHash("sha1").update(resolve(vault)).digest("hex").slice(0, 12);
  return join(configDir(), "sources", key);
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function shortenHome(p: string): string {
  const h = homedir();
  const abs = resolve(p);
  return abs === h ? "~" : abs.startsWith(h + "/") ? `~/${abs.slice(h.length + 1)}` : abs;
}

export function resolveLocation(vault: string, s: SourceConfig): string {
  if (s.kind === "website") return s.location;
  if (s.builtin || !s.location) return resolve(vault);
  return resolve(expandHome(s.location));
}

// ── The list ────────────────────────────────────────────────────────────

function defaultVaultSource(): SourceConfig {
  return { id: DEFAULT_VAULT_SOURCE_ID, kind: "prevail", name: "Prevail vault", location: "", enabled: true, added: "", builtin: true };
}

function validConfig(x: unknown): x is SourceConfig {
  const s = x as SourceConfig;
  return !!s && typeof s.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s.id)
    && SOURCE_KINDS.includes(s.kind) && typeof s.name === "string" && typeof s.location === "string";
}

export function readSources(vault: string): SourceConfig[] {
  let list: SourceConfig[] = [];
  const f = sourcesFile(vault);
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(vreadFile(f)) as Partial<SourcesFile>;
      list = (Array.isArray(parsed.sources) ? parsed.sources : []).filter(validConfig).map((s) => ({
        ...s,
        enabled: s.enabled !== false,
        added: typeof s.added === "string" ? s.added : "",
      }));
    } catch { list = []; }
  }
  const builtin = list.find((s) => s.id === DEFAULT_VAULT_SOURCE_ID);
  if (!builtin) list.unshift(defaultVaultSource());
  else Object.assign(builtin, { kind: "prevail", builtin: true, location: "" });
  return list;
}

export function writeSources(vault: string, list: SourceConfig[]): void {
  const f = sourcesFile(vault);
  mkdirSync(buildRoot(vault), { recursive: true });
  const body: SourcesFile = { version: 1, sources: list.map((s) => ({ ...s })) };
  const tmp = `${f}.${process.pid}.tmp`;
  vwriteFile(tmp, JSON.stringify(body, null, 2) + "\n");
  renameSync(tmp, f);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "source";
}

export interface AddSourceInput { kind: SourceKind; location: string; name?: string; domain?: string }

/** Validate and register a source. Returns the new entry (not yet indexed). */
export function addSource(vault: string, input: AddSourceInput): SourceConfig {
  const kind = input.kind;
  if (!SOURCE_KINDS.includes(kind)) throw new Error(`unknown source type: ${kind}`);
  const list = readSources(vault);
  let location = input.location.trim();
  let name = (input.name ?? "").trim();
  if (kind === "website") {
    const origin = normalizeSiteUrl(location);
    if (!origin) throw new Error("Enter a website address, like fru.dev");
    location = origin;
    if (!name) name = new URL(origin).hostname.replace(/^www\./, "");
  } else {
    if (!location) throw new Error("Choose a folder");
    const abs = resolve(expandHome(location));
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Folder not found: ${location}`);
    if (abs === "/" || abs === homedir()) throw new Error("Pick a specific folder, not your whole disk or home folder");
    const vroot = resolve(vault);
    if (abs === vroot || abs.startsWith(vroot + "/")) throw new Error("That folder is inside this vault, which is already a source");
    if (kind === "prevail" && !existsSync(join(abs, "data")) && !existsSync(join(abs, "VAULT.md")) && !existsSync(join(abs, "build"))) {
      throw new Error("That folder is not a Prevail vault (no data/ or VAULT.md)");
    }
    location = shortenHome(abs);
    if (!name) name = basename(abs);
  }
  const dup = list.find((s) => s.kind === kind && !s.builtin && resolveLocation(vault, s) === (kind === "website" ? location : resolve(expandHome(location))));
  if (dup) throw new Error(`${dup.name} is already a source`);
  const prefix = kind === "prevail" ? "vault" : kind === "obsidian" ? "obsidian" : kind === "folder" ? "folder" : "site";
  let id = `${prefix}-${slug(name)}`.slice(0, 60);
  for (let n = 2; list.some((s) => s.id === id); n++) id = `${prefix}-${slug(name)}-${n}`.slice(0, 63);
  const entry: SourceConfig = { id, kind, name, location, enabled: true, added: new Date().toISOString() };
  if (kind === "obsidian") {
    const d = (input.domain ?? "notes").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(d)) throw new Error("Domain must be a short lowercase name, like notes");
    entry.domain = d;
  }
  list.push(entry);
  writeSources(vault, list);
  return entry;
}

export function setSourceEnabled(vault: string, id: string, enabled: boolean): SourceConfig {
  const list = readSources(vault);
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`no source ${id}`);
  s.enabled = enabled;
  writeSources(vault, list);
  return s;
}

export function renameSource(vault: string, id: string, name: string): SourceConfig {
  const list = readSources(vault);
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`no source ${id}`);
  if (!name.trim()) throw new Error("Name cannot be empty");
  s.name = name.trim().slice(0, 80);
  writeSources(vault, list);
  return s;
}

/**
 * Remove a source from the list and drop its cached index. Never touches the
 * user's files: a folder or Obsidian vault stays as it is, and notes already
 * imported into the vault stay there. The built-in vault can only be turned off.
 */
export function removeSource(vault: string, id: string): { removed: SourceConfig; keptImport?: string } {
  const list = readSources(vault);
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`no source ${id}`);
  if (s.builtin) throw new Error("The Prevail vault is always a source. Turn it off instead.");
  writeSources(vault, list.filter((x) => x.id !== id));
  const dir = sourcesCacheDir(vault);
  for (const f of [`${id}.index.json`, `${id}.status.json`]) {
    try { rmSync(join(dir, f), { force: true }); } catch { /* cache only */ }
  }
  return { removed: s, ...(s.kind === "obsidian" ? { keptImport: obsidianDest(vault, s) } : {}) };
}

// ── Cache IO ────────────────────────────────────────────────────────────

function readJsonSealed<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(vreadSealed(path)) as T; } catch { return null; }
}

function writeJsonSealed(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  vwriteSealed(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function statusPath(vault: string, id: string): string { return join(sourcesCacheDir(vault), `${id}.status.json`); }
function indexPath(vault: string, id: string): string { return join(sourcesCacheDir(vault), `${id}.index.json`); }

function readStatus(vault: string, id: string): SourceStatus | null {
  // Status carries no source text, so it is stored plain: the list renders even
  // while an encrypted vault is locked.
  const p = statusPath(vault, id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as SourceStatus; } catch { return null; }
}

function writeStatus(vault: string, id: string, st: SourceStatus): void {
  const p = statusPath(vault, id);
  mkdirSync(sourcesCacheDir(vault), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, p);
}

const indexCache = new Map<string, { mtimeMs: number; index: IndexFile }>();

function readIndex(vault: string, id: string): IndexFile | null {
  const p = indexPath(vault, id);
  let mtimeMs = 0;
  try { mtimeMs = statSync(p).mtimeMs; } catch { return null; }
  const hit = indexCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.index;
  const index = readJsonSealed<IndexFile>(p);
  if (index) indexCache.set(p, { mtimeMs, index });
  return index;
}

// ── Listing ─────────────────────────────────────────────────────────────

export function listSourceRows(vault: string): SourceRow[] {
  // A pass that was killed mid-way leaves "indexing" behind; with no refresh
  // holding the lock, show the last good state instead of a spinner forever.
  const refreshing = existsSync(join(sourcesCacheDir(vault), ".refresh.lock"));
  return readSources(vault).map((s) => {
    const resolvedLocation = resolveLocation(vault, s);
    let status = readStatus(vault, s.id) ?? { state: "never" as const, lastIndexed: null, items: 0, nextRefresh: null, error: null };
    if (status.state === "indexing" && !refreshing) status = { ...status, state: status.lastIndexed ? "ready" : "never" };
    if (s.kind !== "website" && !existsSync(resolvedLocation)) status = { ...status, state: "missing", error: "Folder not found on this Mac" };
    return { ...s, resolvedLocation, status };
  });
}

// ── Text chunking ───────────────────────────────────────────────────────

function fileTitle(text: string, file: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const name = fm?.[1]?.match(/^(?:name|title):\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (name) return name;
  const h1 = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1) return h1;
  return basename(file, extname(file)).replace(/[-_]+/g, " ").trim();
}

/** Split a document into heading-scoped chunks of about CHUNK_CHARS. */
export function chunkDocument(text: string, file: string): { title: string; x: string }[] {
  const title = fileTitle(text, file);
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/<!--[\s\S]*?-->/g, "");
  const ext = extname(file).toLowerCase();
  const out: { title: string; x: string }[] = [];
  if (ext === ".csv" || ext === ".tsv") {
    const lines = body.split(/\r?\n/).filter((l) => l.trim());
    const header = lines.shift() ?? "";
    let buf: string[] = [];
    let len = 0;
    for (const l of lines) {
      if (len + l.length > CHUNK_CHARS && buf.length) { out.push({ title, x: `${header}\n${buf.join("\n")}` }); buf = []; len = 0; }
      buf.push(l); len += l.length + 1;
    }
    if (buf.length || header) out.push({ title, x: `${header}\n${buf.join("\n")}`.trim() });
    return out;
  }
  const sections: { heading: string; text: string }[] = [];
  let cur = { heading: "", lines: [] as string[] };
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence ? line.match(/^#{1,6}\s+(.+)$/) : null;
    if (h) {
      if (cur.lines.join("").trim()) sections.push({ heading: cur.heading, text: cur.lines.join("\n").trim() });
      cur = { heading: h[1]!.trim(), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.join("").trim()) sections.push({ heading: cur.heading, text: cur.lines.join("\n").trim() });
  // Merge tiny sections into the one before so a chunk carries real content.
  const merged: { heading: string; text: string }[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.length + s.text.length < 300) prev.text += `\n\n${s.heading ? `${s.heading}\n` : ""}${s.text}`;
    else merged.push({ ...s });
  }
  for (const s of merged) {
    const t = s.heading && s.heading !== title ? `${title} > ${s.heading}` : title;
    let buf = "";
    for (const para of s.text.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (buf && buf.length + p.length + 2 > CHUNK_CHARS) { out.push({ title: t, x: buf }); buf = ""; }
      if (p.length > CHUNK_CHARS) {
        for (let i = 0; i < p.length; i += CHUNK_CHARS) out.push({ title: t, x: p.slice(i, i + CHUNK_CHARS) });
        continue;
      }
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    if (buf) out.push({ title: t, x: buf });
  }
  return out;
}

// ── Local walkers ───────────────────────────────────────────────────────

interface WalkedFile { abs: string; rel: string; size: number; mtimeMs: number }

const NOTE_EXTS = new Set([".md", ".markdown", ".txt"]);
const FOLDER_EXTS = new Set([".md", ".markdown", ".txt", ".text", ".org", ".rst", ".adoc", ".csv", ".tsv", ".json", ".yaml", ".yml"]);
const JUNK_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache", ".DS_Store"]);

function walk(root: string, opts: { exts: Set<string>; skipDir?: (rel: string, name: string) => boolean; skipFile?: (rel: string) => boolean; max?: number }): WalkedFile[] {
  const out: WalkedFile[] = [];
  const max = opts.max ?? MAX_FILES;
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || JUNK_DIRS.has(e.name)) continue;
        if (opts.skipDir?.(rel, e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        if (!opts.exts.has(extname(e.name).toLowerCase())) continue;
        if (opts.skipFile?.(rel)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

function fingerprint(files: WalkedFile[]): string {
  let size = 0; let mt = 0;
  for (const f of files) { size += f.size; if (f.mtimeMs > mt) mt = f.mtimeMs; }
  return `${files.length}:${size}:${Math.round(mt)}`;
}

// A file from an encrypted vault is one AES-GCM JSON blob ({ iv, ct, tag }).
function looksSealed(text: string): boolean {
  return text.startsWith("{") && /"ct"\s*:/.test(text.slice(0, 400)) && /"tag"\s*:/.test(text);
}

function docsFromFiles(files: WalkedFile[], read: (abs: string) => string, label: (f: WalkedFile) => { l: string; u?: string; g?: string }): SourceDoc[] {
  const docs: SourceDoc[] = [];
  for (const f of files) {
    let text: string;
    try { text = read(f.abs); } catch { continue; }
    if (!text.trim() || looksSealed(text)) continue;
    const meta = label(f);
    for (const c of chunkDocument(text, f.rel)) {
      docs.push({ t: c.title, x: c.x, ...meta });
      if (docs.length >= MAX_DOCS) return docs;
    }
  }
  return docs;
}

// Domains the user pinned to local models never become sources: a cloud turn
// could otherwise quote them.
function localOnlyDomain(domainDir: string): boolean {
  try {
    const m = JSON.parse(vreadFile(join(domainDir, "manifest.json"))) as { privacy?: { localOnly?: boolean } };
    return m?.privacy?.localOnly === true;
  } catch { return false; }
}

const VAULT_SKIP_DIRS = new Set(["threads", "skills", "_archive", "_scope", "_log", "_meta", "_paste", "attachments", "_runtime"]);

/** The vault's own knowledge: domain ideals, state, memory, tasks, source files, entities. */
export function walkPrevailVault(root: string, obsidianSkips: string[] = []): { files: WalkedFile[]; domains: string[] } {
  const dr = dataRoot(root);
  const domainsDir = existsSync(join(dr, "domains")) ? join(dr, "domains") : dr;
  const files: WalkedFile[] = [];
  const domains: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(domainsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { names = []; }
  for (const d of names.sort()) {
    if (d.startsWith("_") || d.startsWith(".") || d === "entities" || d === "apps" || d === "build") continue;
    const dir = join(domainsDir, d);
    if (domainsDir === dr && !existsSync(join(dir, "manifest.json")) && !existsSync(join(dir, "ideal-state.md")) && !existsSync(join(dir, "memory"))) continue;
    if (localOnlyDomain(dir)) continue;
    domains.push(d);
    const skipRoots = obsidianSkips.filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1));
    for (const f of walk(dir, {
      exts: NOTE_EXTS,
      skipDir: (rel, name) => VAULT_SKIP_DIRS.has(name) || rel === ".system" || skipRoots.some((s) => rel === s || rel.startsWith(`${s}/`)),
      max: MAX_FILES - files.length,
    })) files.push({ ...f, rel: `${d}/${f.rel}` });
    if (files.length >= MAX_FILES) break;
  }
  const ent = join(dr, "entities");
  if (existsSync(ent) && files.length < MAX_FILES) {
    for (const f of walk(ent, { exts: NOTE_EXTS, max: MAX_FILES - files.length })) files.push({ ...f, rel: `entities/${f.rel}` });
  }
  return { files, domains };
}

function obsidianDest(vault: string, s: SourceConfig): string {
  return join(dataRoot(vault), "domains", s.domain || "notes", "source", "obsidian", s.id);
}

// ── Building one source ─────────────────────────────────────────────────

export interface RefreshOptions {
  ids?: string[];
  dueOnly?: boolean;
  force?: boolean;
  now?: Date;
  fetcher?: Fetcher;
  gapMs?: number;
  onProgress?: (id: string, msg: string) => void;
}

function fmtCount(n: number): string { return n.toLocaleString("en-US"); }

async function buildSource(vault: string, s: SourceConfig, all: SourceConfig[], opts: RefreshOptions): Promise<SourceStatus> {
  const nowMs = (opts.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const prev = readIndex(vault, s.id);
  const loc = resolveLocation(vault, s);
  const base: SourceStatus = { state: "ready", lastIndexed: nowIso, items: 0, nextRefresh: new Date(nowMs + LOCAL_REFRESH_MS).toISOString(), error: null };
  const keep = (st: SourceStatus): SourceStatus => ({ ...(readStatus(vault, s.id) ?? base), ...st });

  if (s.kind === "website") {
    if (readBunker() || process.env.PREVAIL_BUNKER === "1") {
      return keep({ state: "paused", lastIndexed: readStatus(vault, s.id)?.lastIndexed ?? null, items: readStatus(vault, s.id)?.items ?? 0, nextRefresh: new Date(nowMs + LOCAL_REFRESH_MS).toISOString(), error: "Paused while Bunker Mode is on" });
    }
    const web = await refreshWebsite(s.location, prev?.web ?? null, { name: s.name, force: opts.force, now: opts.now, fetcher: opts.fetcher, gapMs: opts.gapMs, onProgress: (m) => opts.onProgress?.(s.id, m) });
    writeJsonSealed(indexPath(vault, s.id), { v: 1, id: s.id, kind: s.kind, builtAt: nowIso, web } satisfies IndexFile);
    const sum = summarizeWeb(web);
    const rootSite = web.sites[web.root];
    const found = [
      sum.childSites ? `${sum.childSites} linked sites` : "",
      sum.rows ? `${fmtCount(sum.rows)} rows` : "",
      rootSite?.surface.llms ? "llms.txt" : "",
      sum.openapi ? `${sum.openapi} OpenAPI specs` : "",
    ].filter(Boolean).join(", ");
    const allFailed = sum.sites > 0 && sum.errors.length === sum.sites;
    return {
      state: allFailed ? "error" : "ready",
      lastIndexed: nowIso,
      items: sum.items,
      nextRefresh: sum.nextDue,
      error: allFailed ? sum.errors[0]!.error : sum.errors.length ? `${sum.errors.length} of ${sum.sites} sites could not be read` : null,
      detail: found || "Nothing machine-readable found",
      web: sum,
    };
  }

  if (!existsSync(loc)) return { ...base, state: "missing", items: prev?.docs?.length ?? 0, lastIndexed: readStatus(vault, s.id)?.lastIndexed ?? null, error: "Folder not found on this Mac" };
  if (isVaultLocked() && (s.kind === "prevail" || s.kind === "obsidian")) {
    return keep({ state: "locked", lastIndexed: readStatus(vault, s.id)?.lastIndexed ?? null, items: readStatus(vault, s.id)?.items ?? 0, nextRefresh: new Date(nowMs + LOCAL_REFRESH_MS).toISOString(), error: "Unlock the vault to index it" });
  }

  let files: WalkedFile[] = [];
  let docs: () => SourceDoc[];
  let detail = "";
  if (s.kind === "prevail") {
    const isThisVault = s.builtin || resolve(loc) === resolve(vault);
    const skips = isThisVault
      ? all.filter((o) => o.kind === "obsidian").map((o) => `${o.domain || "notes"}/source/obsidian/${o.id}`)
      : [];
    const w = walkPrevailVault(loc, skips);
    files = w.files;
    const read = isThisVault ? vreadFile : (p: string) => readFileSync(p, "utf8");
    // Location = the vault-relative path (data/domains/tax/memory/state.md);
    // group = the domain, or "entities".
    docs = () => docsFromFiles(files, read, (f) => ({ l: relative(loc, f.abs), u: f.abs, g: f.rel.split("/")[0] }));
    detail = `${w.domains.length} domains`;
  } else if (s.kind === "obsidian") {
    // One-way import, exactly like `prevail obsidian import`: the user's
    // Obsidian files are only read; the converted copy lands in the vault.
    const src = walk(loc, { exts: new Set([".md"]) });
    const fp = fingerprint(src);
    const dest = obsidianDest(vault, s);
    if (opts.force || prev?.fingerprint !== fp || !existsSync(dest)) {
      importObsidianVault({ from: loc, vault, domain: s.domain || "notes", subdir: s.id });
      try { adoptObsidianApp(vault, s.domain || "notes", loc); } catch { /* app listing is best effort */ }
    }
    files = walk(dest, { exts: new Set([".md"]), skipFile: (rel) => rel === "_index.md" });
    // The import writes plain files even into an encrypted vault (as
    // `prevail obsidian import` always has), so fall back to a plain read.
    const readNote = (p: string) => { try { return vreadFile(p); } catch { return readFileSync(p, "utf8"); } };
    docs = () => docsFromFiles(files, readNote, (f) => ({ l: f.rel, u: join(loc, f.rel), g: s.name }));
    detail = `imported into ${s.domain || "notes"}`;
    if (!opts.force && prev?.fingerprint === fp && prev.docs) {
      return { ...base, items: prev.docs.length, files: files.length, detail };
    }
    const built = docs();
    writeJsonSealed(indexPath(vault, s.id), { v: 1, id: s.id, kind: s.kind, builtAt: nowIso, fingerprint: fp, docs: built } satisfies IndexFile);
    return { ...base, items: built.length, files: files.length, detail };
  } else {
    files = walk(loc, { exts: FOLDER_EXTS });
    docs = () => docsFromFiles(files, (p) => readFileSync(p, "utf8"), (f) => ({ l: f.rel, u: f.abs, g: s.name }));
  }

  const fp = fingerprint(files);
  if (!opts.force && prev?.fingerprint === fp && prev.docs) {
    return { ...base, items: prev.docs.length, files: files.length, ...(detail ? { detail } : {}) };
  }
  const built = docs();
  writeJsonSealed(indexPath(vault, s.id), { v: 1, id: s.id, kind: s.kind, builtAt: nowIso, fingerprint: fp, docs: built } satisfies IndexFile);
  return { ...base, items: built.length, files: files.length, ...(detail ? { detail } : {}) };
}

/**
 * Index sources. `dueOnly` skips anything whose next refresh is still ahead
 * (the scheduler's mode); `ids` limits the pass; `force` rebuilds and
 * revalidates everything. One pass per vault at a time: a second caller
 * gets `{ busy: true }` and returns at once.
 */
export async function refreshSources(vault: string, opts: RefreshOptions = {}): Promise<{ busy: boolean; refreshed: string[]; rows: SourceRow[] }> {
  mkdirSync(sourcesCacheDir(vault), { recursive: true });
  const lock = tryAcquireLock(join(sourcesCacheDir(vault), ".refresh.lock"));
  if (!lock) return { busy: true, refreshed: [], rows: listSourceRows(vault) };
  const refreshed: string[] = [];
  try {
    const all = readSources(vault);
    const nowMs = (opts.now ?? new Date()).getTime();
    for (const s of all) {
      if (opts.ids && !opts.ids.includes(s.id)) continue;
      if (!s.enabled && !opts.ids) continue;
      const st = readStatus(vault, s.id);
      if (opts.dueOnly && st?.nextRefresh && Date.parse(st.nextRefresh) > nowMs && st.state !== "never") continue;
      writeStatus(vault, s.id, { ...(st ?? { lastIndexed: null, items: 0, nextRefresh: null, error: null }), state: "indexing", error: null });
      let next: SourceStatus;
      try {
        next = await buildSource(vault, s, all, opts);
      } catch (e) {
        next = { ...(st ?? { lastIndexed: null, items: 0 }), state: "error", nextRefresh: new Date(nowMs + LOCAL_REFRESH_MS).toISOString(), error: e instanceof Error ? e.message : String(e) } as SourceStatus;
      }
      writeStatus(vault, s.id, next);
      refreshed.push(s.id);
    }
  } finally {
    lock.release();
  }
  return { busy: false, refreshed, rows: listSourceRows(vault) };
}

// ── Search ──────────────────────────────────────────────────────────────

const STOP = new Set(("a an and are as at be been but by can could did do does for from get got had has have he her his how i if in into is it its just me my no not of on or our she so than that the their them then there these they this those to too up us was we were what when where which who whom why will with would you your yours about any all also some tell show give find please know like list more most much many out over one very should here").split(" "));

export function queryTerms(q: string): string[] {
  const words = q.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    let t = w;
    if (/\d/.test(t)) { /* numbers and years stay whole */ }
    else if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
    else if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -3);
    else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    if (t.length < 2) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

export interface SourceHit {
  tag: string;         // S1, S2, ...
  sourceId: string;
  sourceName: string;
  kind: SourceKind;
  title: string;
  location: string;
  url?: string;
  group?: string;
  columns?: string;
  snippet: string;
  score: number;
}

interface Corpus { source: SourceConfig; docs: SourceDoc[]; web?: WebState }

function loadCorpora(vault: string, opts: { kinds?: SourceKind[]; ids?: string[] }): Corpus[] {
  const out: Corpus[] = [];
  for (const s of readSources(vault)) {
    if (!s.enabled) continue;
    if (opts.kinds && !opts.kinds.includes(s.kind)) continue;
    if (opts.ids && !opts.ids.includes(s.id)) continue;
    const idx = readIndex(vault, s.id);
    if (!idx) continue;
    const docs = idx.web ? webDocs(idx.web) : idx.docs ?? [];
    if (docs.length) out.push({ source: s, docs, ...(idx.web ? { web: idx.web } : {}) });
  }
  return out;
}

const lcCache = new WeakMap<SourceDoc, string>();
function lcOf(d: SourceDoc): string {
  let s = lcCache.get(d);
  if (s === undefined) { s = `${d.t}\n${d.x}`.toLowerCase(); lcCache.set(d, s); }
  return s;
}

function countTerm(hay: string, term: string): number {
  let n = 0;
  let i = hay.indexOf(term);
  while (i !== -1 && n < 20) {
    const before = i === 0 ? "" : hay[i - 1]!;
    if (!before || !/[\p{L}\p{N}]/u.test(before)) n++;
    i = hay.indexOf(term, i + term.length);
  }
  return n;
}

/** Keyword BM25 over every enabled source's index. No network, no model call. */
export function searchSources(vault: string, query: string, opts: { k?: number; perGroup?: number; kinds?: SourceKind[]; ids?: string[] } = {}): SourceHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const corpora = loadCorpora(vault, opts);
  let total = 0; let lenSum = 0;
  for (const c of corpora) for (const d of c.docs) { total++; lenSum += d.x.length; }
  if (!total) return [];
  const avg = lenSum / total;
  // Document frequency per term, then score only the documents that match.
  const df = new Map<string, number>(terms.map((t) => [t, 0]));
  const matches: { c: Corpus; d: SourceDoc; tf: number[]; title: number }[] = [];
  for (const c of corpora) {
    for (const d of c.docs) {
      const lc = lcOf(d);
      let any = false;
      const tf = terms.map((t) => {
        if (!lc.includes(t)) return 0;
        const n = countTerm(lc, t);
        if (n) any = true;
        return n;
      });
      if (!any) continue;
      tf.forEach((n, i) => { if (n) df.set(terms[i]!, (df.get(terms[i]!) ?? 0) + 1); });
      const tl = `${d.t} ${d.g ?? ""}`.toLowerCase();
      matches.push({ c, d, tf, title: terms.filter((t) => tl.includes(t)).length });
    }
  }
  const k1 = 1.2; const b = 0.75;
  // Most of the question has to be there: 1 of 1, 2 of 2-3, 3 of 4+.
  const needed = terms.length <= 1 ? 1 : terms.length <= 3 ? 2 : 3;
  const scored = matches.map((m) => {
    let score = 0; let matched = 0;
    m.tf.forEach((n, i) => {
      if (!n) return;
      matched++;
      const dfi = df.get(terms[i]!) ?? 1;
      const idf = Math.log(1 + (total - dfi + 0.5) / (dfi + 0.5));
      score += idf * ((n * (k1 + 1)) / (n + k1 * (1 - b + (b * m.d.x.length) / avg)));
    });
    const coverage = matched / terms.length;
    // A term in the title or the group ("funding" -> the Funding tracker)
    // says the item is ABOUT it, not just mentioning it.
    return { m, matched, score: score * (0.4 + 0.6 * coverage) * (1 + 0.35 * m.title) };
  }).filter((s) => s.matched >= needed && s.score > 0);
  scored.sort((a, b2) => b2.score - a.score);
  // Drop the weak tail: an item far below the best match is noise, not context.
  const floor = (scored[0]?.score ?? 0) * 0.3;

  const k = opts.k ?? 8;
  const perGroup = opts.perGroup ?? 4;
  const groups = new Map<string, number>();
  const hits: SourceHit[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (hits.length >= k || s.score < floor) break;
    const g = `${s.m.c.source.id}:${s.m.d.g ?? ""}`;
    if ((groups.get(g) ?? 0) >= perGroup) continue;
    const dedupe = `${s.m.d.u ?? s.m.d.l ?? ""}|${s.m.d.x.slice(0, 80)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    groups.set(g, (groups.get(g) ?? 0) + 1);
    const columns = s.m.c.web && s.m.d.g ? fieldsFor(s.m.c.web, s.m.d.g) ?? undefined : undefined;
    hits.push({
      tag: `S${hits.length + 1}`,
      sourceId: s.m.c.source.id,
      sourceName: s.m.c.source.name,
      kind: s.m.c.source.kind,
      title: s.m.c.source.kind === "website" && s.m.d.g && !s.m.d.t.startsWith(s.m.d.g) ? `${s.m.d.g}: ${s.m.d.t}` : s.m.d.t,
      location: s.m.d.l ?? (s.m.d.u ? s.m.d.u.replace(/^https?:\/\//, "") : ""),
      ...(s.m.d.u ? { url: s.m.d.u } : {}),
      ...(s.m.d.g ? { group: s.m.d.g } : {}),
      ...(columns ? { columns } : {}),
      snippet: s.m.d.x.length > 900 ? `${s.m.d.x.slice(0, 897)}...` : s.m.d.x,
      score: Math.round(s.score * 1000) / 1000,
    });
  }
  return hits;
}

const KIND_LABEL: Record<SourceKind, string> = { prevail: "Prevail vault", obsidian: "Obsidian", folder: "Folder", website: "Website" };

/** The cited block placed ahead of the user's message. Empty when nothing matched. */
export function formatSourcesContext(hits: SourceHit[], maxChars = 6_000): string {
  if (!hits.length) return "";
  const head = `${SOURCES_HEADER}\nPrevail pulled these excerpts for this message from the sources the user set up (vault, Obsidian, folders, websites). Use them when they help. When you use one, cite it inline by its tag, like [S1], and name the source. Ignore excerpts that do not help, and never cite one you did not use.\n`;
  let body = "";
  const explained = new Set<string>();
  for (const h of hits) {
    const where = h.kind === "website"
      ? `${h.group ?? h.sourceName}${h.url ? `: ${h.url}` : ""}`
      : `${KIND_LABEL[h.kind]} "${h.sourceName}"${h.group && h.group !== h.sourceName ? `, ${h.group}` : ""}: ${h.location}`;
    const cols = h.columns && !explained.has(h.columns) ? `Columns: ${h.columns}\n` : "";
    if (h.columns) explained.add(h.columns);
    const block = `\n[${h.tag}] ${h.title}\nFrom ${where}\n${cols}${h.snippet}\n`;
    if (body && head.length + body.length + block.length > maxChars) break;
    body += block;
  }
  return `${head}${body}# END OF SOURCES\n\n`;
}

/**
 * The query to retrieve for, pulled from a fully assembled prompt: the text
 * after the last "User's next message:" when the desktop sent history, else
 * the prompt's tail (a TUI turn is just the message).
 */
export function queryFromPrompt(prompt: string): string {
  const marker = "User's next message:";
  const i = prompt.lastIndexOf(marker);
  const q = i >= 0 ? prompt.slice(i + marker.length) : prompt;
  return q.trim().slice(-1_500);
}

export function sourcesDisabledByEnv(): boolean {
  const v = (process.env.PREVAIL_SOURCES ?? "").toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

/** Retrieve + format in one call, for the chat paths. Never throws. */
export function sourcesContextFor(vault: string, query: string, opts: { k?: number; maxChars?: number } = {}): { context: string; hits: SourceHit[] } {
  if (sourcesDisabledByEnv()) return { context: "", hits: [] };
  try {
    const hits = searchSources(vault, query, { k: opts.k ?? 8 });
    const context = formatSourcesContext(hits, opts.maxChars);
    // Only report the hits that made it into the block.
    const used = hits.filter((h) => context.includes(`[${h.tag}] `));
    return { context, hits: used };
  } catch {
    return { context: "", hits: [] };
  }
}
