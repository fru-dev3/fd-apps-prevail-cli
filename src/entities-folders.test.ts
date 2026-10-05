import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEntityFile, buildIndex, entityDetail, entityFiles, mergeEntities, migrateEntityFolders, pagePath, readIndex, readPage, refreshEntities, setNotes,
  setPicture, setWebsite, summarize,
} from "./entities.ts";

let vault: string;
let scratch: string;
const NOW = Date.parse("2026-09-20T12:00:00Z");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const ents = (...p: string[]) => join(vault, "data", "entities", ...p);
const page = (name: string, notes: string) => `---\nname: ${name}\nkind: person\naliases: []\nsaved: true\ncreated: x\nupdated: x\nmention_count: 0\n---\n\n## Your notes\n\n${notes}\n`;
function flat(dir: string, slug: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body);
}
function thread(name: string, body: string) {
  const dir = join(vault, "data", "domains", "home", "memory", "threads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ntitle: ${name}\nupdated: 2026-09-18T10:00:00Z\n---\n\n## You\n\n${body}\n`);
}
function scratchFile(name: string, content: Buffer | string): string {
  const p = join(scratch, name);
  writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-efold-"));
  scratch = mkdtempSync(join(tmpdir(), "prevail-efold-src-"));
  mkdirSync(join(vault, "build"), { recursive: true });
  mkdirSync(join(vault, "data", "domains"), { recursive: true });
});
afterEach(() => { rmSync(vault, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); });

describe("folders", () => {
  test("migration moves flat pages into folders, is idempotent and never overwrites", () => {
    flat(ents("people"), "foo", page("Foo", "Flat notes."));
    flat(ents("people"), "bar", page("Bar", "Old flat."));
    mkdirSync(ents("people", "bar"), { recursive: true });
    writeFileSync(ents("people", "bar", "entity.md"), page("Bar", "New folder."));
    flat(ents("_merged", "people"), "baz", page("Baz", "Archived."));

    const r = migrateEntityFolders(vault);
    expect(r).toEqual({ moved: 2, conflicts: ["data/entities/people/bar/entity.conflict.md"] });
    expect(readFileSync(ents("people", "foo", "entity.md"), "utf8")).toContain("Flat notes.");
    expect(readFileSync(ents("people", "bar", "entity.md"), "utf8")).toContain("New folder.");
    expect(readFileSync(ents("people", "bar", "entity.conflict.md"), "utf8")).toContain("Old flat.");
    expect(readFileSync(ents("_merged", "people", "baz", "entity.md"), "utf8")).toContain("Archived.");
    expect(existsSync(ents("people", "foo.md"))).toBe(false);
    expect(migrateEntityFolders(vault)).toEqual({ moved: 0, conflicts: [] });
    expect(buildIndex(vault, { now: NOW }).entities.map((e) => e.id).sort()).toEqual(["person/bar", "person/foo"]);
  });

  test("an unmigrated flat page is still read, and moves into its folder on the next write", () => {
    flat(ents("people"), "foo", page("Foo", "Flat notes."));
    const idx = buildIndex(vault, { now: NOW });
    expect(idx.entities[0].page).toBe("data/entities/people/foo.md");
    const d = entityDetail(vault, idx, "person/foo")!;
    expect(d.notes).toBe("Flat notes.");
    expect(d.page_path).toBe("data/entities/people/foo.md");
    setNotes(vault, "person/foo", "Flat notes.\n\nMore.", { now: NOW });
    expect(existsSync(ents("people", "foo.md"))).toBe(false);
    expect(readPage(vault, "person", "foo")!.notes).toBe("Flat notes.\n\nMore.");
    expect(pagePath(vault, "person", "foo")).toBe(ents("people", "foo", "entity.md"));
  });

  test("refresh migrates", async () => {
    flat(ents("products"), "foo-co", page("Foo Co", "x").replace("kind: person", "kind: product"));
    await refreshEntities(vault, { run: null, now: NOW, autosave: "all" });
    expect(existsSync(ents("products", "foo-co", "entity.md"))).toBe(true);
  });
});

describe("picture, website, files", () => {
  test("set-picture copies a checked image into the folder and sets picture:", () => {
    thread("t1", "Met [Foo](prevail://person/foo).");
    buildIndex(vault, { now: NOW });
    const r = setPicture(vault, "person/foo", scratchFile("me.png", PNG), { now: NOW });
    expect(r).toEqual({ ok: true, path: ents("people", "foo", "picture.png") });
    expect(readFileSync(r.path).equals(PNG)).toBe(true);
    expect(readFileSync(pagePath(vault, "person", "foo"), "utf8")).toContain("picture: picture.png");
    expect(entityDetail(vault, readIndex(vault), "person/foo")!.picture).toBe(r.path);
    expect(summarize(readIndex(vault).entities[0], vault).picture).toBe(r.path);

    // Replacing keeps the old one in files/.
    setPicture(vault, "person/foo", scratchFile("svg.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { now: NOW });
    expect(readPage(vault, "person", "foo")!.picture).toBe("picture.svg");
    expect(entityFiles(vault, "person/foo").map((f) => f.name)).toEqual(["previous-2026-09-20.png"]);

    expect(() => setPicture(vault, "person/foo", scratchFile("fake.png", "not an image"))).toThrow(/png, jpg, webp or svg/);
    expect(() => setPicture(vault, "person/foo", scratchFile("a.gif", "GIF89a"))).toThrow(/png, jpg, webp or svg/);
    expect(() => setPicture(vault, "person/foo", scratchFile("big.png", Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])))).toThrow(/5 MB/);
    expect(() => setPicture(vault, "person/foo", join(scratch, "missing.png"))).toThrow(/no file/);
  });

  test("website is inferred for an org only from a matching URL in its mentions", async () => {
    thread("t1", "Pricing for [Fooco](prevail://product/Fooco) is at https://www.fooco.com/pricing today.");
    thread("t2", "[Barco](prevail://product/Barco) was mentioned next to https://bazco.com/x.");
    thread("t3", "[Quxco](prevail://person/Quxco) wrote from https://quxco.com.");
    thread("t4", "[Zedco Inc](prevail://product/Zedco%20Inc) sent a quote.");
    await refreshEntities(vault, { run: null, now: NOW, autosave: "all" });
    const idx = readIndex(vault);
    const site = (id: string) => idx.entities.find((e) => e.id === id)!.website;
    expect(site("product/fooco")).toBe("fooco.com");
    expect(readPage(vault, "product", "fooco")!.website).toBe("fooco.com");
    expect(site("product/barco")).toBeUndefined();
    expect(site("person/quxco")).toBeUndefined();
    expect(site("product/zedco-inc")).toBeUndefined();
  });

  test("set-website, add-file and files", () => {
    thread("t1", "[Foo Co](prevail://product/Foo%20Co).");
    buildIndex(vault, { now: NOW });
    expect(setWebsite(vault, "product/foo-co", "https://fooco.example/about", { now: NOW })).toEqual({ ok: true });
    expect(entityDetail(vault, readIndex(vault), "product/foo-co")!.website).toBe("https://fooco.example/about");
    expect(() => setWebsite(vault, "product/foo-co", "not a site")).toThrow(/not a website/);
    const src = scratchFile("quote.txt", "hello");
    expect(addEntityFile(vault, "product/foo-co", src, { now: NOW })).toEqual({ ok: true, name: "quote.txt" });
    expect(addEntityFile(vault, "product/foo-co", src, { now: NOW })).toEqual({ ok: true, name: "quote (2).txt" });
    const files = entityFiles(vault, "product/foo-co");
    expect(files.map((f) => [f.name, f.size])).toEqual([["quote (2).txt", 5], ["quote.txt", 5]]);
    expect(typeof files[0].mtime).toBe("number");
    expect(entityFiles(vault, "person/nobody")).toEqual([]);
  });

  test("a merge copies files and the picture to the keeper and archives the whole folder", () => {
    thread("t1", "[Foo](prevail://person/foo) and [Foo Bar](prevail://person/Foo%20Bar).");
    buildIndex(vault, { now: NOW });
    setPicture(vault, "person/foo", scratchFile("p.png", PNG), { now: NOW });
    addEntityFile(vault, "person/foo", scratchFile("a.txt", "a"), { now: NOW });
    addEntityFile(vault, "person/foo-bar", scratchFile("a.txt", "b"), { now: NOW });
    mergeEntities(vault, "person/foo-bar", "person/foo", { now: NOW });
    expect(entityFiles(vault, "person/foo-bar").map((f) => f.name)).toEqual(["a (2).txt", "a.txt"]);
    expect(readFileSync(ents("people", "foo-bar", "files", "a.txt"), "utf8")).toBe("b");
    expect(readPage(vault, "person", "foo-bar")!.picture).toBe("picture.png");
    expect(existsSync(ents("people", "foo"))).toBe(false);
    expect(existsSync(ents("_merged", "people", "foo", "entity.md"))).toBe(true);
    expect(existsSync(ents("_merged", "people", "foo", "files", "a.txt"))).toBe(true);
    expect(existsSync(ents("_merged", "people", "foo", "picture.png"))).toBe(true);
  });
});
