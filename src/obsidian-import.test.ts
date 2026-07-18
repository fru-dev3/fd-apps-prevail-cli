import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertWikilinks, extractTags, hasFrontmatter, transformNote,
  listObsidianNotes, importObsidianVault,
} from "./obsidian-import";

describe("convertWikilinks", () => {
  test("plain, alias, and heading links", () => {
    expect(convertWikilinks("see [[Note]]")).toBe("see [Note](Note.md)");
    expect(convertWikilinks("[[Note|Alias]]")).toBe("[Alias](Note.md)");
    expect(convertWikilinks("[[Note#Section]]")).toBe("[Note > Section](Note.md#section)");
    expect(convertWikilinks("[[Note#Section|Alias]]")).toBe("[Alias](Note.md#section)");
  });
  test("embeds: image stays an image, note embed becomes a link", () => {
    expect(convertWikilinks("![[diagram.png]]")).toBe("![diagram.png](diagram.png)");
    expect(convertWikilinks("![[Some Note]]")).toBe("[Some Note](Some%20Note.md)");
  });
  test("spaces in names are URL-encoded in the href", () => {
    expect(convertWikilinks("[[Daily Note]]")).toBe("[Daily Note](Daily%20Note.md)");
  });
  test("leaves wikilinks inside code untouched", () => {
    expect(convertWikilinks("`[[Note]]`")).toBe("`[[Note]]`");
    const fenced = "```\n[[Note]]\n```";
    expect(convertWikilinks(fenced)).toBe(fenced);
  });
  test("multiple links on a line", () => {
    expect(convertWikilinks("[[A]] and [[B|b]]")).toBe("[A](A.md) and [b](B.md)");
  });
});

describe("extractTags", () => {
  test("finds hashtags, ignores code and headings", () => {
    expect(extractTags("hello #work and #deep/focus").sort()).toEqual(["deep/focus", "work"]);
    expect(extractTags("`#notacode`")).toEqual([]);
    // A markdown heading (# at line start followed by space) is not a tag.
    expect(extractTags("# Heading")).toEqual([]);
  });
});

describe("hasFrontmatter", () => {
  test("detects YAML frontmatter", () => {
    expect(hasFrontmatter("---\ntitle: X\n---\nbody")).toBe(true);
    expect(hasFrontmatter("no fm here")).toBe(false);
  });
  test("transformNote preserves frontmatter verbatim", () => {
    const md = "---\ntitle: X\ntags: [a]\n---\nsee [[Y]]";
    const out = transformNote(md);
    expect(out.startsWith("---\ntitle: X\ntags: [a]\n---")).toBe(true);
    expect(out).toContain("[Y](Y.md)");
  });
});

describe("importObsidianVault (end to end on a temp vault)", () => {
  test("walks notes, skips .obsidian, transforms, writes under source/obsidian, idempotent", () => {
    const ob = mkdtempSync(join(tmpdir(), "obsidian-"));
    const pv = mkdtempSync(join(tmpdir(), "prevail-"));
    mkdirSync(join(ob, "folder"), { recursive: true });
    mkdirSync(join(ob, ".obsidian"), { recursive: true });
    writeFileSync(join(ob, "Home.md"), "# Home\nlink to [[folder/Deep]] #home");
    writeFileSync(join(ob, "folder", "Deep.md"), "deep #work");
    writeFileSync(join(ob, ".obsidian", "app.json"), "{}"); // must be skipped
    writeFileSync(join(ob, "notes.md"), "");

    // The walker skips .obsidian and finds only the 3 .md notes.
    expect(listObsidianNotes(ob).length).toBe(3);

    const r = importObsidianVault({ from: ob, vault: pv, domain: "notes" });
    expect(r.imported).toBe(3);
    expect(r.tags.sort()).toEqual(["home", "work"]);

    const home = readFileSync(join(pv, "data/domains/notes/source/obsidian/Home.md"), "utf8");
    expect(home).toContain("[folder/Deep](folder/Deep.md)");
    // .obsidian config was NOT imported.
    expect(existsSync(join(pv, "data/domains/notes/source/obsidian/.obsidian/app.json"))).toBe(false);
    // An index note was written.
    expect(existsSync(join(pv, "data/domains/notes/source/obsidian/_index.md"))).toBe(true);

    // Idempotent: re-running succeeds and reports the same count.
    const r2 = importObsidianVault({ from: ob, vault: pv, domain: "notes" });
    expect(r2.imported).toBe(3);
  });

  test("throws on a missing source folder", () => {
    const pv = mkdtempSync(join(tmpdir(), "prevail-"));
    expect(() => importObsidianVault({ from: "/no/such/dir", vault: pv, domain: "notes" })).toThrow();
  });
});

describe("adoptObsidianApp", () => {
  test("writes an obsidian app manifest and unions domains on re-run", async () => {
    const { adoptObsidianApp } = await import("./obsidian-import");
    const pv = mkdtempSync(join(tmpdir(), "prevail-"));
    adoptObsidianApp(pv, "notes", "/Users/me/Obsidian");
    let m = JSON.parse(readFileSync(join(pv, "data/apps/obsidian/manifest.json"), "utf8"));
    expect(m.id).toBe("obsidian");
    expect(m.integration).toBe("manual");
    expect(m.enabled).toBe(true);
    expect(m.domains).toEqual(["notes"]);
    expect(m.source.path).toBe("/Users/me/Obsidian");
    // Re-run into a second domain unions, does not clobber.
    adoptObsidianApp(pv, "learning", "/Users/me/Obsidian");
    m = JSON.parse(readFileSync(join(pv, "data/apps/obsidian/manifest.json"), "utf8"));
    expect(m.domains.sort()).toEqual(["learning", "notes"]);
  });
});
