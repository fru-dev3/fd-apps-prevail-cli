import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, entityDetail, mergeEntities, normalizeNames, pagePath, readIndex, renameEntity, saveEntity, titleCaseName } from "./entities.ts";

let vault: string;
const NOW = Date.parse("2026-09-20T12:00:00Z");
const link = (kind: string, value: string) => `[${value}](prevail://${kind}/${encodeURIComponent(value)})`;
function thread(name: string, links: string[]) {
  const dir = join(vault, "data", "domains", "home", "memory", "threads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ntitle: ${name}\nupdated: 2026-09-18T10:00:00Z\n---\n\n## You\n\nq\n\n## claude\n\n${links.join(" and ")}.\n`);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-names-"));
  mkdirSync(join(vault, "build"), { recursive: true });
  mkdirSync(join(vault, "data", "domains"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("Title Case", () => {
  test("words are capitalized; inner capitals, acronyms, domains and small words are respected", () => {
    expect(titleCaseName("foo bar")).toBe("Foo Bar");
    expect(titleCaseName("bank of the west")).toBe("Bank of the West");
    expect(titleCaseName("the foo")).toBe("The Foo");
    expect(titleCaseName("my iPhone")).toBe("My iPhone");
    expect(titleCaseName("McDonald farm")).toBe("McDonald Farm");
    expect(titleCaseName("foo LLC")).toBe("Foo LLC");
    expect(titleCaseName("foo.com")).toBe("foo.com");
    expect(titleCaseName("jean-luc o'brien")).toBe("Jean-Luc O'Brien");
    expect(titleCaseName("it's foo")).toBe("It's Foo");
    expect(titleCaseName("3m tape")).toBe("3m Tape");
  });

  test("the index shows Title Case and ids never change", () => {
    thread("t1", [link("person", "sam rivera")]);
    const idx = buildIndex(vault, { now: NOW });
    const e = idx.entities.find((x) => x.id === "person/sam-rivera")!;
    expect(e.name).toBe("Sam Rivera");
    expect(e.aliases).not.toContain("sam rivera");
  });

  test("normalize keeps the old name as an alias; dry run writes nothing; rename too", () => {
    thread("t1", [link("place", "foo lake cabin")]);
    buildIndex(vault, { now: NOW });
    saveEntity(vault, "place/foo-lake-cabin", { now: NOW });
    // A page written by hand in lowercase.
    const p = pagePath(vault, "place", "foo-lake-cabin");
    writeFileSync(p, readFileSync(p, "utf8").replace(/^name: .*$/m, "name: foo lake cabin"));
    expect(normalizeNames(vault, { dryRun: true }).changed).toEqual([{ id: "place/foo-lake-cabin", from: "foo lake cabin", to: "Foo Lake Cabin" }]);
    expect(readFileSync(p, "utf8")).toContain("name: foo lake cabin");
    normalizeNames(vault, { now: NOW });
    const text = readFileSync(p, "utf8");
    expect(text).toContain("name: Foo Lake Cabin");
    expect(text).toMatch(/aliases: \[.*foo lake cabin/);
    expect(normalizeNames(vault).changed).toEqual([]);
    const d = renameEntity(vault, "place/foo-lake-cabin", "the lake house", { now: NOW });
    expect(d.id).toBe("place/foo-lake-cabin");
    expect(d.name).toBe("The Lake House");
    expect(d.aliases).toContain("Foo Lake Cabin");
  });
});

describe("merge provenance", () => {
  test("an entity lists what was merged into it, with the date, across merges", () => {
    thread("t1", [link("person", "Sam Rivera"), link("person", "Sammy R"), link("person", "S Rivera")]);
    buildIndex(vault, { now: NOW });
    mergeEntities(vault, "person/sam-rivera", "person/sammy-r", { now: NOW });
    mergeEntities(vault, "person/sam-rivera", "person/s-rivera", { now: NOW + 86_400_000 });
    const d = entityDetail(vault, readIndex(vault), "person/sam-rivera")!;
    expect(d.merged_from.map((m) => [m.id, m.name, m.ts.slice(0, 10)])).toEqual([
      ["person/sammy-r", "Sammy R", "2026-09-20"],
      ["person/s-rivera", "S Rivera", "2026-09-21"],
    ]);
  });
});
