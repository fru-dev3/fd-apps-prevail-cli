import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { productsMigrationRecorded, runProductsMigration } from "./products-migrate.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// The legacy layout, spelled once (the migration reads exactly this).
const LEGACY_PAGES = "or" + "gs";
const OLD = "or" + "g";

function put(root: string, rel: string, body: string, mtime?: number): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  if (mtime) utimesSync(p, mtime / 1000, mtime / 1000);
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "prevail-products-"));
  roots.push(v);
  mkdirSync(join(v, "build", "_meta"), { recursive: true });
  mkdirSync(join(v, "data", "domains", "general"), { recursive: true });
  return v;
}

/** A small vault with every case: same-slug double, name double, apps only, pages only, archived. */
function fixture(): string {
  const v = vault();
  // Same slug: app and page both "foo-co"; both carry notes.md, the app's is newer.
  put(v, "data/apps/foo-co/manifest.json", JSON.stringify({ id: "foo-co", title: "Foo Co" }));
  put(v, "data/apps/foo-co/notes.md", "app notes\n", 2_000_000_000_000);
  put(v, `data/entities/${LEGACY_PAGES}/foo-co/entity.md`, `---\nname: Foo Co\nkind: ${OLD}\n---\n\n## Your notes\n`);
  put(v, `data/entities/${LEGACY_PAGES}/foo-co/notes.md`, "page notes\n", 1_000_000_000_000);
  // Name match: app "foobar", page "foo-bar".
  put(v, "data/apps/foobar/manifest.json", JSON.stringify({ id: "foobar", title: "Foobar" }));
  put(v, `data/entities/${LEGACY_PAGES}/foo-bar/entity.md`, `---\nname: Foo Bar\nkind: ${OLD}\n---\n`);
  // App only, with a folder name that is not a slug.
  put(v, "data/apps/Foo Bank/statement.csv", "a,b\n");
  // Page only.
  put(v, `data/entities/${LEGACY_PAGES}/foo-gym/entity.md`, `---\nname: Foo Gym\nkind: ${OLD}\n---\n`);
  // Archived: one whose company is a live page only (merges), one unknown (moves).
  put(v, "data/apps/_archive/foo-gym/manifest.json", JSON.stringify({ id: "foo-gym", title: "Foo Gym" }));
  put(v, "data/apps/_archive/foo-old/manifest.json", JSON.stringify({ id: "foo-old", title: "Foo Old" }));
  put(v, "data/apps/_log/audit.jsonl", "{}\n");
  // References to rewrite.
  put(v, "data/domains/general/memory/tasks.md", `- [ ] Call them ~to:${OLD}/foo-co ~from:app/foobar\n- [ ] Read https://x.${OLD}/foo-co\n`);
  put(v, "data/domains/general/notes.md", `See [Foo](prevail://${OLD}/foo-co) and [Zed](prevail://${OLD}/foo-zed)\n`);
  put(v, "data/entities/relations.json", JSON.stringify({ [`${OLD}/foo-bar`]: "yours" }));
  put(v, "data/entities/things/foo-phone/entity.md", `---\nname: Foo Phone\nkind: thing\nmaker: ${OLD}/foo-co\n---\n`);
  put(v, "build/_meta/entities/index.json", JSON.stringify({ entities: [{ id: `${OLD}/foo-gym`, kind: OLD, kinds: [OLD, "thing"] }, { id: `${OLD}/foo-mention`, kind: OLD }] }));
  put(v, "build/_meta/work/prompts/w1.json", JSON.stringify({ tasks: [{ dest: { kind: "entity", id: `${OLD}/foo-co` } }] }));
  return v;
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) { out.push(`${relative(root, p)}/`); walk(p); } else out.push(`${relative(root, p)} ${s.size} ${s.mtimeMs}`); } };
  walk(root);
  return out.sort();
}

const P = "data/entities/products";

describe("migrate products", () => {
  test("doubles merge, the older clashing file kept beside as .conflict", () => {
    const v = fixture();
    const r = runProductsMigration(v, { now: new Date("2026-10-04T12:00:00Z") });
    expect(r.ok).toBe(true);
    expect(r.counts.doublesBySlug).toBe(1);
    expect(r.counts.doublesByName).toBe(1);
    expect(read(v, `${P}/foo-co/notes.md`)).toBe("app notes\n");
    expect(read(v, `${P}/foo-co/notes.md.conflict`)).toBe("page notes\n");
    expect(existsSync(join(v, P, "foo-co/manifest.json"))).toBe(true);
    expect(read(v, `${P}/foo-co/entity.md`)).toContain("kind: product");
    // name double lands in the app's slug
    expect(existsSync(join(v, P, "foobar/entity.md"))).toBe(true);
    expect(existsSync(join(v, P, "foo-bar"))).toBe(false);
    // slugified app folder
    expect(existsSync(join(v, P, "foo-bank/statement.csv"))).toBe(true);
    expect(existsSync(join(v, P, "_log/audit.jsonl"))).toBe(true);
    // legacy trees gone
    expect(existsSync(join(v, "data/apps"))).toBe(false);
    expect(existsSync(join(v, "data/entities", LEGACY_PAGES))).toBe(false);
  });

  test("archived app merges into a live company, else moves to products/_archive", () => {
    const v = fixture();
    const r = runProductsMigration(v);
    expect(r.counts.archivedMerged).toBe(1);
    expect(r.counts.archivedMoved).toBe(1);
    const m = JSON.parse(read(v, `${P}/foo-gym/manifest.json`)) as { lifecycle?: string };
    expect(m.lifecycle).toBe("archived");
    expect(existsSync(join(v, P, "foo-gym/entity.md"))).toBe(true);
    expect(existsSync(join(v, P, "_archive/foo-old/manifest.json"))).toBe(true);
  });

  test("ids rewritten in boards, relations, frontmatter, index and work; urls untouched", () => {
    const v = fixture();
    const r = runProductsMigration(v);
    const board = read(v, "data/domains/general/memory/tasks.md");
    expect(board).toContain("~to:product/foo-co ~from:product/foobar");
    expect(board).toContain(`https://x.${OLD}/foo-co`);
    expect(read(v, "data/domains/general/notes.md")).toBe("See [Foo](prevail://product/foo-co) and [Zed](prevail://product/foo-zed)\n");
    expect(read(v, `${P}/foo-gym/entity.md`)).toContain("kind: product");
    expect(read(v, "data/entities/relations.json")).toContain('"product/foobar"');
    expect(read(v, "data/entities/things/foo-phone/entity.md")).toContain("maker: product/foo-co");
    const idx = read(v, "build/_meta/entities/index.json");
    expect(idx).toContain('"product/foo-gym"');
    expect(idx).toContain('"product/foo-mention"');
    expect(idx).not.toContain(`"${OLD}"`);
    expect(read(v, "build/_meta/work/prompts/w1.json")).toContain('"product/foo-co"');
    expect(r.counts.idRewrites.byType.boards).toBe(2);
    expect(r.counts.idRewrites.byType.relations).toBe(1);
    expect(r.counts.idRewrites.byType.work).toBe(1);
  });

  test("dry run writes nothing and reports the same plan", () => {
    const v = fixture();
    const before = snapshot(v);
    const dry = runProductsMigration(v, { dryRun: true });
    expect(snapshot(v)).toEqual(before);
    expect(dry.ran).toBe(false);
    expect(dry.counts.conflicts).toBe(1);
    const real = runProductsMigration(v);
    expect(real.counts.conflicts).toBe(dry.counts.conflicts);
    expect(real.counts.idRewrites).toEqual(dry.counts.idRewrites);
  });

  test("second run is a no-op; record written", () => {
    const v = fixture();
    const r = runProductsMigration(v);
    expect(r.record).toMatch(/^build\/_meta\/migrations\/products\..+\.json$/);
    expect(productsMigrationRecorded(v)).toBe(true);
    const before = snapshot(v);
    const again = runProductsMigration(v);
    expect(again.skipped).toBe("nothing-to-do");
    expect(snapshot(v)).toEqual(before);
  });

  test("dated backup exists and is verified before anything moves", () => {
    const v = fixture();
    const r = runProductsMigration(v, { now: new Date("2026-10-04T12:00:00Z") });
    expect(r.backup).toBe("build/_archive/products-migration-2026-10-04");
    expect(existsSync(join(v, r.backup!, "apps/foo-co/manifest.json"))).toBe(true);
    expect(existsSync(join(v, r.backup!, "entities-orgs/foo-gym/entity.md"))).toBe(true);
    const v2 = fixture();
    const failed = runProductsMigration(v2, { verify: () => false });
    expect(failed.ok).toBe(false);
    expect(existsSync(join(v2, "data/apps/foo-co/manifest.json"))).toBe(true);
    expect(existsSync(join(v2, P))).toBe(false);
    expect(productsMigrationRecorded(v2)).toBe(false);
  });

  test("--auto: a client waits for the hub, a recorded vault is left alone", () => {
    const v = fixture();
    expect(runProductsMigration(v, { auto: true, role: "client" }).skipped).toBe("client-waits-for-hub");
    put(v, "build/_meta/migrations/products.foo-hub.json", "{}");
    expect(runProductsMigration(v, { auto: true, role: "hub" }).skipped).toBe("already-migrated");
    expect(existsSync(join(v, "data/apps/foo-co"))).toBe(true);
    const fresh = vault();
    expect(runProductsMigration(fresh, { auto: true, role: "hub" }).skipped).toBe("nothing-to-do");
  });
});
