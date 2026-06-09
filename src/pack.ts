// Role packages — `prevail.pack/v1`. A portable, importable bundle that
// pre-populates a vault with starter domains for a persona (small business
// owner, family, student, high-income, …). Feature 3 of the master build plan.
//
// A pack carries only DECLARED INTENT — soul.md / goals.md / config.md /
// PROMPTS.md / skills — never derived or private content (state, journal,
// decisions, logs). So importing a pack is safe and exporting one never leaks
// personal data. The format is plain JSON so packs can be hosted as static
// files and downloaded.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { BUNDLED_PACKS } from "./packs/index.ts";

export const PACK_SCHEMA = "prevail.pack/v1";

export interface PackSkill {
  name: string;
  body: string; // SKILL.md contents
}

export interface PackDomain {
  slug: string;
  title?: string;
  soul?: string; // soul.md — declared intent
  goals?: string; // goals.md
  config?: string; // config.md
  prompts?: string[]; // PROMPTS.md, one entry per prompt
  skills?: PackSkill[];
}

export interface PrevailPack {
  schema: typeof PACK_SCHEMA;
  name: string;
  version: string;
  description?: string;
  domains: PackDomain[];
}

export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Parse + validate a pack from JSON text. Throws with a clear message. */
export function parsePack(jsonText: string): PrevailPack {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`pack is not valid JSON: ${(e as Error).message}`);
  }
  const p = raw as Partial<PrevailPack>;
  if (!p || typeof p !== "object") throw new Error("pack must be a JSON object");
  if (p.schema !== PACK_SCHEMA) {
    throw new Error(`unsupported pack schema ${JSON.stringify(p.schema)} (expected ${PACK_SCHEMA})`);
  }
  if (!p.name || typeof p.name !== "string") throw new Error("pack is missing a name");
  if (!p.version || typeof p.version !== "string") throw new Error("pack is missing a version");
  if (!Array.isArray(p.domains) || p.domains.length === 0) {
    throw new Error("pack has no domains");
  }
  for (const d of p.domains) {
    if (!d || typeof d !== "object" || !d.slug || typeof d.slug !== "string") {
      throw new Error("every pack domain needs a slug");
    }
  }
  return p as PrevailPack;
}

export interface ApplyResult {
  created: string[];
  skipped: string[]; // domains that already existed (and overwrite was false)
}

/**
 * Materialize a pack into `vaultPath`. Each domain becomes a folder with its
 * intent files. Existing domains are skipped unless `overwrite` is set, so an
 * import never clobbers a user's real domain by accident.
 */
export function applyPack(
  vaultPath: string,
  pack: PrevailPack,
  opts: { overwrite?: boolean } = {},
): ApplyResult {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const d of pack.domains) {
    const slug = slugify(d.slug);
    if (!slug) continue;
    const dir = join(vaultPath, slug);
    if (existsSync(dir) && !opts.overwrite) {
      skipped.push(slug);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    // soul.md is what v2 uses to detect a domain — always write at least a stub.
    writeFileSync(join(dir, "soul.md"), d.soul ?? `# ${d.title ?? slug}\n`);
    if (d.goals != null) writeFileSync(join(dir, "goals.md"), d.goals);
    if (d.config != null) writeFileSync(join(dir, "config.md"), d.config);
    if (d.prompts && d.prompts.length > 0) {
      const body = `# ${d.title ?? slug} — Prompts\n\n${d.prompts.map((p) => `- ${p}`).join("\n")}\n`;
      writeFileSync(join(dir, "PROMPTS.md"), body);
    }
    for (const s of d.skills ?? []) {
      const sdir = join(dir, "_skills", slugify(s.name));
      mkdirSync(sdir, { recursive: true });
      writeFileSync(join(sdir, "SKILL.md"), s.body);
    }
    created.push(slug);
  }
  return { created, skipped };
}

/**
 * Build a pack from an existing vault — only the intent files, never derived or
 * private content. Useful for sharing your domain structure without leaking
 * personal data.
 */
export function exportPack(vaultPath: string, name: string, version = "1.0.0"): PrevailPack {
  const domains: PackDomain[] = [];
  if (!existsSync(vaultPath)) return { schema: PACK_SCHEMA, name, version, domains };
  for (const entry of readdirSync(vaultPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dir = join(vaultPath, entry.name);
    const soulPath = join(dir, "soul.md");
    if (!existsSync(soulPath)) continue; // not a domain
    const read = (f: string): string | undefined => {
      const p = join(dir, f);
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    };
    domains.push({
      slug: entry.name,
      soul: read("soul.md"),
      goals: read("goals.md"),
      config: read("config.md"),
    });
  }
  return { schema: PACK_SCHEMA, name, version, domains };
}

/**
 * The packs bundled with the engine. Sourced from statically-imported JSON
 * (src/packs/index.ts) so they survive `bun build --compile` into the sidecar
 * binary — a runtime fs read of src/packs would not. Each is validated; a
 * malformed bundled pack is skipped rather than crashing the list.
 */
export function listBundledPacks(): { file: string; pack: PrevailPack }[] {
  const out: { file: string; pack: PrevailPack }[] = [];
  for (const { file, pack } of BUNDLED_PACKS) {
    try {
      out.push({ file, pack: parsePack(JSON.stringify(pack)) });
    } catch {
      /* skip a malformed bundled pack rather than crash listing */
    }
  }
  return out;
}

/** Look up a bundled pack's JSON text by file name or pack name. */
export function bundledPackText(ref: string): string | null {
  const match = BUNDLED_PACKS.find(
    (p) => p.file === ref || p.file === `${ref}.json` || p.pack.name.toLowerCase() === ref.toLowerCase(),
  );
  return match ? JSON.stringify(match.pack) : null;
}
