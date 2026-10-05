// `prevail migrate products`: one store for companies.
//
// Before: a company could live twice, as an app record (data/apps/<id>/) and
// as an entity page (data/entities/<legacy pages dir>/<slug>/). After: one
// folder per company at data/entities/products/<slug>/ with id product/<slug>.
//
// Rules (never overwrite):
// - A legacy page whose slug equals an app id, or matches the app by name,
//   merges INTO the app's slug (app ids key connectors, browser profiles and
//   keychain items, so they never change). A folder name that is not a valid
//   slug is slugified.
// - Merges are recursive. On a file clash with different bytes the newer file
//   keeps the canonical name and the older sits beside it as <name>.conflict
//   (.conflict-2, -3 ... when taken). Identical bytes keep one copy.
// - Archived apps merge into the live product of the same company, else move
//   to products/_archive/<slug>/. A manifest that came only from an archived
//   app gets lifecycle "archived" so it is never listed as a live connector.
// - The legacy trees are copied to build/_archive/products-migration-<date>/
//   and the copy verified before anything moves.
// - Ids are rewritten to product/<slug> in every text file under the data
//   root and build/_meta. A record in build/_meta/migrations/products.<host>.json
//   tells other Macs it ran; a client that sees it just reads the new store.
// - Dry run writes nothing. A second run is a no-op.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative, resolve } from "node:path";

import { readMachineRole, type MachineRole } from "./config.ts";
import { slugify } from "./entities.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { buildRoot, dataRoot, entitiesContainer } from "./path-safety.ts";
import { productsMigrationRecorded } from "./path-safety.ts";
import { vreadFile, vwriteFileAtomic } from "./vault-session.ts";

// ── Layout ──────────────────────────────────────────────────────────────────

const PRODUCTS = "products";
// Legacy layout, read only by this migration: the apps container and the old
// entity pages directory (and its _merged twin). Kept private on purpose.
const LEGACY_APPS = "apps";
const LEGACY_PAGES = "orgs";
const LEGACY_PREFIX = "org"; // legacy entity id prefix (org/<slug>)

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TEXT_EXT = /\.(md|json|jsonl|txt|ya?ml)$/i;
const MAX_TEXT = 5 * 1024 * 1024;

function legacyAppsDir(vault: string): string | null {
  const v4 = join(dataRoot(vault), LEGACY_APPS);
  if (existsSync(v4)) return v4;
  const v3 = join(vault, LEGACY_APPS);
  return existsSync(v3) && v3 !== v4 ? v3 : null;
}
const legacyPagesDir = (vault: string) => join(entitiesContainer(vault), LEGACY_PAGES);
const legacyMergedDir = (vault: string) => join(entitiesContainer(vault), "_merged", LEGACY_PAGES);
export const productsDir = (vault: string) => join(entitiesContainer(vault), PRODUCTS);
const recordsDir = (vault: string) => join(buildRoot(vault), "_meta", "migrations");

export function hostTag(): string {
  return hostname().toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}

export { productsMigrationRecorded };

const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const ls = (p: string) => { try { return readdirSync(p).sort(); } catch { return [] as string[]; } };
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const slugOf = (name: string) => (APP_ID_RE.test(name) ? name : slugify(name));

// ── Plan ────────────────────────────────────────────────────────────────────

interface Source { src: string; dest: string; kind: "app" | "page" | "archived" | "other" | "merged-pages"; name: string }
export interface MigrationPlan {
  legacy: { apps: string | null; pages: string | null; merged: string | null };
  liveApps: number; pages: number; archivedApps: number; otherDirs: number;
  doublesBySlug: string[]; doublesByName: string[]; ambiguous: string[];
  archivedMerged: string[]; archivedMoved: string[];
  sources: Source[];
  /** legacy id (org/<slug>, app/<id>) to product/<slug> */
  ids: Map<string, string>;
}

function manifestNames(dir: string): string[] {
  try {
    const m = JSON.parse(vreadFile(join(dir, "manifest.json"))) as Record<string, unknown>;
    return ["title", "name", "company"].map((k) => m[k]).filter((v): v is string => typeof v === "string" && !!v.trim());
  } catch { return []; }
}

export function planProductsMigration(vault: string): MigrationPlan {
  const appsDir = legacyAppsDir(vault);
  const pagesDir = existsSync(legacyPagesDir(vault)) ? legacyPagesDir(vault) : null;
  const mergedDir = existsSync(legacyMergedDir(vault)) ? legacyMergedDir(vault) : null;
  const out = productsDir(vault);
  const plan: MigrationPlan = {
    legacy: { apps: appsDir, pages: pagesDir, merged: mergedDir },
    liveApps: 0, pages: 0, archivedApps: 0, otherDirs: 0,
    doublesBySlug: [], doublesByName: [], ambiguous: [], archivedMerged: [], archivedMoved: [], sources: [], ids: new Map(),
  };

  // Live apps: each keeps its id as the product slug.
  const live = new Map<string, Set<string>>(); // slug -> compact names
  for (const n of appsDir ? ls(appsDir) : []) {
    const p = join(appsDir!, n);
    if (n.startsWith("_") || n.startsWith(".") || !isDir(p)) {
      if (n === "_archive" && isDir(p)) continue;
      plan.otherDirs++;
      plan.sources.push({ src: p, dest: join(out, n), kind: "other", name: n });
      continue;
    }
    const slug = slugOf(n);
    if (!slug) continue;
    plan.liveApps++;
    const names = live.get(slug) ?? new Set<string>();
    for (const x of [n, slug, ...manifestNames(p)]) if (compact(x)) names.add(compact(x));
    live.set(slug, names);
    plan.sources.push({ src: p, dest: join(out, slug), kind: "app", name: n });
    plan.ids.set(`app/${n}`, `product/${slug}`);
  }

  // Pages: same slug or same name merges into the app's folder.
  for (const n of pagesDir ? ls(pagesDir) : []) {
    const p = join(pagesDir!, n);
    if (n.startsWith(".")) continue;
    const flat = !isDir(p) && n.endsWith(".md");
    if (!isDir(p) && !flat) { plan.sources.push({ src: p, dest: join(out, n), kind: "other", name: n }); plan.otherDirs++; continue; }
    const slug = flat ? n.slice(0, -3) : n;
    plan.pages++;
    let target = slug;
    if (live.has(slug)) plan.doublesBySlug.push(slug);
    else {
      const hits = [...live.entries()].filter(([, names]) => names.has(compact(slug))).map(([s]) => s).sort();
      if (hits.length) {
        target = hits[0]!;
        plan.doublesByName.push(`${slug} -> ${target}`);
        if (hits.length > 1) plan.ambiguous.push(`${slug}: ${hits.join(", ")}`);
      }
    }
    plan.sources.push({ src: p, dest: flat ? join(out, target, "entity.md") : join(out, target), kind: "page", name: n });
    plan.ids.set(`${LEGACY_PREFIX}/${slug}`, `product/${target}`);
  }

  // Every live product after the merge, with the names it answers to.
  const liveNames = new Map(live);
  for (const s of plan.sources) if (s.kind === "page") {
    const slug = relative(out, s.dest).split(/[\\/]/)[0]!;
    const set = liveNames.get(slug) ?? new Set<string>();
    set.add(compact(slug));
    set.add(compact(s.name.replace(/\.md$/, "")));
    liveNames.set(slug, set);
  }

  // Archived apps: merge into the live company, else archive as a product.
  const arch = appsDir ? join(appsDir, "_archive") : "";
  for (const n of arch ? ls(arch) : []) {
    const p = join(arch, n);
    if (n.startsWith(".")) continue;
    if (!isDir(p)) { plan.sources.push({ src: p, dest: join(out, "_archive", n), kind: "other", name: n }); plan.otherDirs++; continue; }
    const slug = slugOf(n);
    if (!slug) continue;
    plan.archivedApps++;
    const keys = [n, slug, ...manifestNames(p)].map(compact).filter(Boolean);
    const target = liveNames.has(slug) ? slug : [...liveNames.entries()].filter(([, names]) => keys.some((k) => names.has(k))).map(([s]) => s).sort()[0];
    if (target) {
      plan.archivedMerged.push(`${n} -> ${target}`);
      plan.sources.push({ src: p, dest: join(out, target), kind: "archived", name: n });
      if (!plan.ids.has(`app/${n}`)) plan.ids.set(`app/${n}`, `product/${target}`);
    } else {
      plan.archivedMoved.push(n);
      plan.sources.push({ src: p, dest: join(out, "_archive", slug), kind: "archived", name: n });
      if (!plan.ids.has(`app/${n}`)) plan.ids.set(`app/${n}`, `product/${slug}`);
    }
  }

  // Merged (deduplicated) pages keep their archive, under the new kind dir.
  if (mergedDir) {
    plan.sources.push({ src: mergedDir, dest: join(entitiesContainer(vault), "_merged", PRODUCTS), kind: "merged-pages", name: "_merged" });
    for (const n of ls(mergedDir)) {
      const slug = n.replace(/\.md$/, "");
      if (!plan.ids.has(`${LEGACY_PREFIX}/${slug}`)) plan.ids.set(`${LEGACY_PREFIX}/${slug}`, `product/${slug}`);
    }
  }

  // Ids the entity index knows (mentioned companies with no page yet).
  try {
    const idx = JSON.parse(vreadFile(join(buildRoot(vault), "_meta", "entities", "index.json"))) as { entities?: { id?: string }[] };
    for (const e of idx.entities ?? []) {
      const m = typeof e.id === "string" ? new RegExp(`^${LEGACY_PREFIX}/([a-z0-9][a-z0-9-]*)$`).exec(e.id) : null;
      if (m && !plan.ids.has(e.id!)) plan.ids.set(e.id!, `product/${m[1]}`);
    }
  } catch { /* no index */ }
  return plan;
}

// ── Merge (never overwrite) ─────────────────────────────────────────────────

interface Ctx {
  dry: boolean;
  /** dry run: files and dirs that would exist (path -> source file) */
  vfiles: Map<string, string>; vdirs: Set<string>;
  conflicts: string[]; moved: number;
}
const exists = (c: Ctx, p: string) => c.vfiles.has(p) || c.vdirs.has(p) || existsSync(p);
const dirLike = (c: Ctx, p: string) => c.vdirs.has(p) || (!c.vfiles.has(p) && isDir(p));
const real = (c: Ctx, p: string) => c.vfiles.get(p) ?? p;

function conflictName(c: Ctx, p: string): string {
  let n = `${p}.conflict`;
  for (let i = 2; exists(c, n); i++) n = `${p}.conflict-${i}`;
  return n;
}

function place(c: Ctx, src: string, dest: string): void {
  if (c.dry) {
    if (isDir(src)) { c.vdirs.add(dest); for (const n of ls(src)) place(c, join(src, n), join(dest, n)); }
    else c.vfiles.set(dest, src);
    return;
  }
  mkdirSync(join(dest, ".."), { recursive: true });
  renameSync(src, dest);
}

function sameBytes(a: string, b: string): boolean {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

function mergeInto(c: Ctx, src: string, dest: string): void {
  if (!exists(c, dest)) { place(c, src, dest); c.moved++; return; }
  const srcDir = isDir(src);
  const destDir = dirLike(c, dest);
  if (srcDir && destDir) {
    for (const n of ls(src)) mergeInto(c, join(src, n), join(dest, n));
    if (!c.dry) { try { rmdirSync(src); } catch { /* not empty: left as is */ } }
    return;
  }
  if (!srcDir && !destDir && sameBytes(src, real(c, dest))) { if (!c.dry) unlinkSync(src); return; }
  const side = conflictName(c, dest);
  const srcNewer = !srcDir && !destDir && statSync(src).mtimeMs > statSync(real(c, dest)).mtimeMs;
  if (srcNewer) {
    // The newer file takes the canonical name; the older one steps aside.
    if (c.dry) { c.vfiles.set(side, real(c, dest)); c.vfiles.set(dest, src); }
    else { renameSync(dest, side); renameSync(src, dest); }
  } else place(c, src, side);
  c.conflicts.push(side);
}

// ── Backup ──────────────────────────────────────────────────────────────────

function files(root: string, base = root, out = new Map<string, number>()): Map<string, number> {
  if (!isDir(root)) { try { out.set(relative(base, root) || ".", statSync(root).size); } catch { /* gone */ } return out; }
  for (const n of ls(root)) files(join(root, n), base, out);
  return out;
}

export function verifyCopy(src: string, dst: string): boolean {
  const a = files(src);
  const b = files(dst);
  if (a.size !== b.size) return false;
  for (const [k, size] of a) if (b.get(k) !== size) return false;
  return true;
}

// ── Id rewrite ──────────────────────────────────────────────────────────────

function typeOf(rel: string): string {
  const base = rel.split("/").pop() ?? "";
  if (base === "tasks.md" || base === "_tasks.md") return "boards";
  if (base === "relations.json") return "relations";
  if (base === "links.json") return "links";
  if (base === "merges.json") return "merges";
  if (/(^|\/)_meta\/entities\/index\.json$/.test(rel)) return "entity index";
  if (/(^|\/)_meta\/work\//.test(rel)) return "work";
  if (/\/(events|missions)\//.test(`/${rel}`)) return "events and missions";
  if (base.endsWith(".md")) return "frontmatter";
  return "other";
}

function walkText(root: string, skip: Set<string>, out: string[]): void {
  for (const n of ls(root)) {
    const p = join(root, n);
    if (n === ".git" || n === "node_modules" || skip.has(p)) continue;
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) walkText(p, skip, out);
    else if (st.isFile() && TEXT_EXT.test(n) && st.size < MAX_TEXT) out.push(p);
  }
}

function rewriteText(text: string, ids: Map<string, string>, entityPage: boolean, indexFile: boolean, meta = false): { text: string; n: number } {
  let n = 0;
  // Machine-managed files under build/_meta (the entity index's page and
  // picture paths, the trusted-source folder paths) name the old folders:
  // point them at the product folder, through the id map when a slug changed.
  let src = text;
  if (meta) {
    src = src.replace(new RegExp(`data/(?:entities/${LEGACY_PAGES}|${LEGACY_APPS})/(_archive/)?([A-Za-z0-9][A-Za-z0-9._-]*)`, "g"), (m, arch: string | undefined, slug: string) => {
      n++;
      if (arch) return `data/entities/products/_archive/${slug}`;
      const to = ids.get(`${m.includes(`/${LEGACY_PAGES}/`) ? LEGACY_PREFIX : "app"}/${slug}`);
      return `data/entities/products/${to ? to.slice("product/".length) : slug}`;
    });
  }
  let t = src.replace(/(?<![\w./-])(org|app)\/([A-Za-z0-9][A-Za-z0-9-]*)(?![A-Za-z0-9-])/g, (m) => {
    const to = ids.get(m);
    if (!to) return m;
    n++;
    return to;
  });
  // prevail:// links are ours: every legacy page link moves, apps only when known.
  t = t.replace(/prevail:\/\/(org|app)\/([A-Za-z0-9][A-Za-z0-9-]*)(?![A-Za-z0-9-])/g, (m, head: string, slug: string) => {
    const to = ids.get(`${head}/${slug}`) ?? (head === LEGACY_PREFIX ? `product/${slug}` : null);
    if (!to) return m;
    n++;
    return `prevail://${to}`;
  });
  if (entityPage) t = t.replace(new RegExp(`^kind:\\s*${LEGACY_PREFIX}\\s*$`, "m"), () => { n++; return "kind: product"; });
  if (indexFile) {
    t = t.replace(new RegExp(`("kinds?"\\s*:\\s*)"${LEGACY_PREFIX}"`, "g"), (_m, k: string) => { n++; return `${k}"product"`; });
    t = t.replace(new RegExp(`("kinds"\\s*:\\s*\\[[^\\]]*?)"${LEGACY_PREFIX}"`, "g"), (_m, k: string) => { n++; return `${k}"product"`; });
  }
  return { text: t, n };
}

function rewriteIds(vault: string, ids: Map<string, string>, dry: boolean, skip: Set<string>): { files: number; ids: number; byType: Record<string, number> } {
  const res = { files: 0, ids: 0, byType: {} as Record<string, number> };
  const list: string[] = [];
  const dr = dataRoot(vault);
  const br = buildRoot(vault);
  walkText(dr, new Set([...skip, br, join(dr, "build")]), list);
  if (existsSync(join(br, "_meta"))) walkText(join(br, "_meta"), skip, list);
  const pages = resolve(entitiesContainer(vault));
  for (const p of new Set(list)) {
    let text: string;
    try { text = vreadFile(p); } catch { continue; }
    if (text.includes("\u0000")) continue;
    const rel = relative(vault, p).split("\\").join("/");
    const r = rewriteText(text, ids, p.endsWith(".md") && resolve(p).startsWith(pages), /(^|\/)_meta\/entities\/index\.json$/.test(rel), /(^|\/)_meta\//.test(rel));
    if (!r.n) continue;
    res.files++; res.ids += r.n;
    const ty = typeOf(rel);
    res.byType[ty] = (res.byType[ty] ?? 0) + r.n;
    if (!dry) vwriteFileAtomic(p, r.text);
  }
  return res;
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface MigrationCounts {
  liveApps: number; pages: number; archivedApps: number;
  doubles: number; doublesBySlug: number; doublesByName: number;
  liveMoved: number; pagesMoved: number; archivedMerged: number; archivedMoved: number;
  conflicts: number; otherDirs: number;
  idRewrites: { files: number; ids: number; byType: Record<string, number> };
}
export interface MigrationResult {
  ok: boolean; dryRun: boolean; ran: boolean;
  skipped?: "nothing-to-do" | "already-migrated" | "client-waits-for-hub" | "locked";
  counts: MigrationCounts;
  plan?: { merges: { slug: string; from: string[] }[]; archivedMerged: string[]; archivedMoved: string[]; conflicts: string[]; ambiguous: string[] };
  backup?: string; record?: string; errors: string[];
}
export interface MigrationOptions {
  dryRun?: boolean; auto?: boolean; now?: Date;
  /** test seams */
  role?: MachineRole; verify?: (src: string, dst: string) => boolean;
}

const zero = (): MigrationCounts => ({ liveApps: 0, pages: 0, archivedApps: 0, doubles: 0, doublesBySlug: 0, doublesByName: 0, liveMoved: 0, pagesMoved: 0, archivedMerged: 0, archivedMoved: 0, conflicts: 0, otherDirs: 0, idRewrites: { files: 0, ids: 0, byType: {} } });

export function runProductsMigration(vault: string, opts: MigrationOptions = {}): MigrationResult {
  const dry = !!opts.dryRun;
  const plan = planProductsMigration(vault);
  const legacyRoots = [plan.legacy.apps, plan.legacy.pages, plan.legacy.merged].filter((x): x is string => !!x);
  const base: MigrationResult = { ok: true, dryRun: dry, ran: false, counts: zero(), errors: [] };
  if (!legacyRoots.length) return { ...base, skipped: "nothing-to-do" };
  if (opts.auto && productsMigrationRecorded(vault)) return { ...base, skipped: "already-migrated" };
  if (opts.auto && (opts.role ?? readMachineRole()) === "client") return { ...base, skipped: "client-waits-for-hub" };

  const counts = zero();
  counts.liveApps = plan.liveApps; counts.pages = plan.pages; counts.archivedApps = plan.archivedApps; counts.otherDirs = plan.otherDirs;
  counts.doublesBySlug = plan.doublesBySlug.length; counts.doublesByName = plan.doublesByName.length;
  counts.doubles = counts.doublesBySlug + counts.doublesByName;
  counts.archivedMerged = plan.archivedMerged.length; counts.archivedMoved = plan.archivedMoved.length;
  const result: MigrationResult = { ...base, counts };

  let lock: { release(): void } | null = null;
  const d0 = opts.now ?? new Date();
  const date = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`; // the user's local day
  let backup = join(buildRoot(vault), "_archive", `products-migration-${date}`);
  for (let i = 2; existsSync(backup); i++) backup = join(buildRoot(vault), "_archive", `products-migration-${date}-${i}`);
  try {
    if (!dry) {
      mkdirSync(recordsDir(vault), { recursive: true });
      lock = tryAcquireLock(join(recordsDir(vault), ".products.lock"));
      if (!lock) return { ...result, ok: false, skipped: "locked", errors: ["another products migration is running"] };
      // Backup first, verified, before a single move.
      const verify = opts.verify ?? verifyCopy;
      const pairs: [string | null, string][] = [[plan.legacy.apps, "apps"], [plan.legacy.pages, "entities-pages"], [plan.legacy.merged, "entities-merged-pages"]];
      for (const [src, name] of pairs) {
        if (!src) continue;
        const dst = join(backup, name);
        cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        if (!verify(src, dst)) return { ...result, ok: false, backup: relative(vault, backup), errors: [`backup of ${name} did not verify; nothing was moved`] };
      }
      result.backup = relative(vault, backup);
    }

    // Move and merge, manifests from archived apps marked archived.
    const ctx: Ctx = { dry, vfiles: new Map(), vdirs: new Set(), conflicts: [], moved: 0 };
    const merges = new Map<string, string[]>();
    const archivedManifests: string[] = [];
    for (const s of plan.sources) {
      if (s.kind === "archived" && !s.dest.includes(`${PRODUCTS}/_archive/`)) {
        const mf = join(s.dest, "manifest.json");
        if (!exists(ctx, mf) && existsSync(join(s.src, "manifest.json"))) archivedManifests.push(mf);
      }
      const before = ctx.moved;
      if (s.kind !== "other" && s.kind !== "merged-pages") {
        const slug = relative(productsDir(vault), s.dest).split(/[\\/]/).slice(0, s.dest.includes(`${PRODUCTS}/_archive/`) ? 2 : 1).join("/");
        merges.set(slug, [...(merges.get(slug) ?? []), `${s.kind}:${s.name}`]);
      }
      try { mergeInto(ctx, s.src, s.dest); } catch (e) { result.errors.push(`${s.name}: ${(e as Error).message}`); }
      if (ctx.moved > before && s.kind === "app") counts.liveMoved++;
      if (ctx.moved > before && s.kind === "page") counts.pagesMoved++;
    }
    for (const mf of archivedManifests) {
      if (dry) continue;
      try {
        const m = JSON.parse(vreadFile(mf)) as Record<string, unknown>;
        if (m.lifecycle !== "archived") vwriteFileAtomic(mf, `${JSON.stringify({ ...m, lifecycle: "archived" }, null, 2)}\n`);
      } catch (e) { result.errors.push(`lifecycle: ${(e as Error).message}`); }
    }
    counts.conflicts = ctx.conflicts.length;

    // Ids, then the now-empty legacy dirs.
    counts.idRewrites = rewriteIds(vault, plan.ids, dry, new Set([backup]));
    if (!dry) for (const r of legacyRoots) removeEmpty(r);
    if (!dry) for (const r of [join(entitiesContainer(vault), "_merged")]) { try { if (!ls(r).length) rmdirSync(r); } catch { /* keep */ } }

    result.plan = {
      merges: [...merges.entries()].filter(([, f]) => f.length > 1).map(([slug, from]) => ({ slug, from })),
      archivedMerged: plan.archivedMerged, archivedMoved: plan.archivedMoved,
      conflicts: ctx.conflicts.map((p) => relative(vault, p)), ambiguous: plan.ambiguous,
    };
    if (!dry) {
      const rec = join(recordsDir(vault), `products.${hostTag()}.json`);
      vwriteFileAtomic(rec, `${JSON.stringify({ migration: "products", host: hostTag(), ts: (opts.now ?? new Date()).toISOString(), counts, backup: result.backup }, null, 2)}\n`);
      result.record = relative(vault, rec);
    }
    result.ran = !dry;
    result.ok = result.errors.length === 0;
    return result;
  } finally {
    lock?.release();
  }
}

function removeEmpty(dir: string): void {
  if (!isDir(dir)) return;
  for (const n of ls(dir)) removeEmpty(join(dir, n));
  try { if (!ls(dir).length) rmdirSync(dir); } catch { /* keep */ }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = "usage: prevail migrate products [--dry-run] [--json] [--auto]";

export async function migrateCommand(args: string[], vault: string): Promise<number> {
  const [what, ...rest] = args.filter((a, i) => !(a === "--vault" || args[i - 1] === "--vault"));
  if (what !== "products") { console.error(USAGE); return 1; }
  const json = rest.includes("--json");
  const r = runProductsMigration(vault, { dryRun: rest.includes("--dry-run"), auto: rest.includes("--auto") });
  if (json) { process.stdout.write(`${JSON.stringify(r)}\n`); return r.ok ? 0 : 1; }
  const c = r.counts;
  const lines = [
    `${r.dryRun ? "Dry run (nothing written)" : r.ran ? "Migrated" : "Not run"}${r.skipped ? `: ${r.skipped}` : ""}`,
    `live apps ${c.liveApps}, pages ${c.pages}, archived apps ${c.archivedApps}, other folders ${c.otherDirs}`,
    `doubles ${c.doubles} (same slug ${c.doublesBySlug}, same name ${c.doublesByName})`,
    `archived merged ${c.archivedMerged}, archived moved ${c.archivedMoved}, conflicts ${c.conflicts}`,
    `ids rewritten ${c.idRewrites.ids} in ${c.idRewrites.files} files: ${Object.entries(c.idRewrites.byType).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  ];
  if (r.plan) {
    for (const m of r.plan.merges) lines.push(`  merge ${m.slug} <- ${m.from.join(", ")}`);
    for (const a of r.plan.archivedMoved) lines.push(`  archive ${a}`);
    for (const x of r.plan.conflicts) lines.push(`  conflict ${x}`);
    for (const x of r.plan.ambiguous) lines.push(`  ambiguous ${x}`);
  }
  if (r.backup) lines.push(`backup ${r.backup}`);
  if (r.record) lines.push(`record ${r.record}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return r.ok ? 0 : 1;
}
