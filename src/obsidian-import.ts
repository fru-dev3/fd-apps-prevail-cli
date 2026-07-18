// Obsidian import: bring an existing Obsidian vault into Prevail as AI-readable
// source. A Prevail vault is already markdown, so this is a light, honest
// transform + copy: notes land under data/domains/<domain>/source/obsidian/,
// wikilinks/embeds become standard markdown links, tags + YAML frontmatter are
// preserved, and re-import is idempotent (a sync). The whole point: after this,
// every Prevail surface (chat grounding, memory, search) can use the notes.
//
// The transforms below are pure and unit-tested; the walker/writer at the bottom
// does the filesystem work.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, dirname, basename, extname, sep } from "node:path";

// Slugify a note/target name to the filename we write it as (Obsidian allows
// spaces; we keep the name but make the LINK target a .md path). We do NOT
// rename files - we keep the original relative path - so links resolve by name.
function noteHref(target: string): string {
  const clean = target.trim().replace(/\\/g, "/");
  // Already has an extension (an attachment link) -> leave the path as-is.
  if (/\.[a-z0-9]{1,5}$/i.test(clean)) return encodeURI(clean);
  return encodeURI(clean) + ".md";
}

// Convert Obsidian wikilinks + embeds to standard markdown so the content stays
// readable and links are plausible:
//   [[Note]]            -> [Note](Note.md)
//   [[Note|Alias]]      -> [Alias](Note.md)
//   [[Note#Heading]]    -> [Note > Heading](Note.md#heading)
//   [[Note#H|Alias]]    -> [Alias](Note.md#h)
//   ![[Note]]           -> [Note](Note.md)          (embed -> link; content isn't inlined)
//   ![[image.png]]      -> ![image.png](image.png)  (image embed stays an image)
// Anything inside fenced/inline code is left untouched.
export function convertWikilinks(md: string): string {
  const segments = splitByCode(md);
  return segments
    .map((seg) => (seg.code ? seg.text : convertOutsideCode(seg.text)))
    .join("");
}

function convertOutsideCode(text: string): string {
  const WIKILINK = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g;
  return text.replace(WIKILINK, (_m, bang: string, target: string, hash?: string, alias?: string) => {
    const t = target.trim();
    const heading = hash ? hash.slice(1).trim() : "";
    const label = alias ? alias.slice(1).trim() : heading ? `${t} > ${heading}` : t;
    const isImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(t);
    const anchor = heading ? "#" + heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "";
    if (bang === "!" && isImage) return `![${label}](${encodeURI(t)})`;
    return `[${label}](${noteHref(t)}${anchor})`;
  });
}

// Split markdown into code and non-code segments so wikilink conversion never
// touches ``` fenced blocks or `inline code`.
interface Seg { text: string; code: boolean }
export function splitByCode(md: string): Seg[] {
  const out: Seg[] = [];
  // Fenced blocks first (``` ... ```), then inline `code` within the rest.
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushInline = (chunk: string) => {
    const inline = /`[^`]*`/g;
    let l = 0, im: RegExpExecArray | null;
    while ((im = inline.exec(chunk))) {
      if (im.index > l) out.push({ text: chunk.slice(l, im.index), code: false });
      out.push({ text: im[0], code: true });
      l = im.index + im[0].length;
    }
    if (l < chunk.length) out.push({ text: chunk.slice(l), code: false });
  };
  while ((m = fence.exec(md))) {
    if (m.index > last) pushInline(md.slice(last, m.index));
    out.push({ text: m[0], code: true });
    last = m.index + m[0].length;
  }
  if (last < md.length) pushInline(md.slice(last));
  return out;
}

// Extract #tags (outside code) - returned for the import summary, left in place
// in the body (they are valid markdown text and useful context for agents).
export function extractTags(md: string): string[] {
  const tags = new Set<string>();
  for (const seg of splitByCode(md)) {
    if (seg.code) continue;
    const re = /(^|\s)#([A-Za-z][\w/-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg.text))) tags.add(m[2]!);
  }
  return [...tags];
}

// Does this note have YAML frontmatter? (kept verbatim on import.)
export function hasFrontmatter(md: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(md);
}

// The full per-note transform: convert links, keep everything else.
export function transformNote(md: string): string {
  return convertWikilinks(md);
}

// Directories Obsidian keeps that should never be imported.
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export interface ImportResult {
  imported: number;
  attachments: number;
  skipped: number;
  tags: string[];
  files: string[]; // vault-relative destination paths
  destDir: string;
}

// Walk an Obsidian vault directory and return every markdown note (relative
// paths), skipping Obsidian's own dirs. Pure-ish (reads fs, no writes).
export function listObsidianNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (extname(name).toLowerCase() === ".md") out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

// Import an Obsidian vault into a Prevail domain's source/obsidian/ directory.
// Idempotent: re-running re-transforms and overwrites (a sync).
export function importObsidianVault(opts: {
  from: string;
  vault: string;
  domain: string;
}): ImportResult {
  const { from, vault, domain } = opts;
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    throw new Error(`Obsidian vault not found or not a folder: ${from}`);
  }
  const destDir = join(vault, "data", "domains", domain, "source", "obsidian");
  mkdirSync(destDir, { recursive: true });

  const notes = listObsidianNotes(from);
  const allTags = new Set<string>();
  const files: string[] = [];
  let imported = 0;

  for (const rel of notes) {
    const raw = readFileSync(join(from, rel), "utf8");
    for (const t of extractTags(raw)) allTags.add(t);
    const transformed = transformNote(raw);
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, transformed);
    files.push(relative(vault, dest));
    imported++;
  }

  // A small index so the domain (and agents) know what was imported and when.
  const vaultName = basename(from.replace(new RegExp(`${sep}+$`), "")) || "Obsidian";
  const index = [
    `# Obsidian import: ${vaultName}`,
    "",
    `Imported ${imported} note${imported === 1 ? "" : "s"} from your Obsidian vault into this domain.`,
    `Source folder: \`${from}\``,
    allTags.size ? `\nTags seen: ${[...allTags].sort().slice(0, 60).map((t) => "#" + t).join(" ")}` : "",
    "",
    "Wikilinks and embeds were converted to standard markdown links; tags and",
    "frontmatter were preserved. Re-run the import to sync new or changed notes.",
    "",
  ].join("\n");
  writeFileSync(join(destDir, "_index.md"), index);
  files.push(relative(vault, join(destDir, "_index.md")));

  return { imported, attachments: 0, skipped: 0, tags: [...allTags], files, destDir };
}

// Register (or refresh) an `obsidian` connector app so the Map + Apps list show
// it as connected and it can be re-synced. Merges into any existing manifest,
// unions the domain, and records the source folder. Idempotent.
export function adoptObsidianApp(vault: string, domain: string, from: string): void {
  const dir = join(vault, "data", "apps", "obsidian");
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  let manifest: Record<string, unknown> = {};
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { manifest = {}; }
  }
  const domains = new Set<string>([...(Array.isArray(manifest.domains) ? (manifest.domains as string[]) : []), domain]);
  const next = {
    ...manifest,
    id: "obsidian",
    name: manifest.name || "Obsidian",
    integration: "manual", // a local folder import, not an api/oauth/browser/mcp connector
    domains: [...domains],
    enabled: true,
    source: { kind: "obsidian-vault", path: from },
  };
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
}
