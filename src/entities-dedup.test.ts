import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNote, buildIndex, entityChatBlock, entityDetail, entityDuplicates, entityThreads, markNotSame, mergeEntities, pagePath, readIndex, readMerges,
  refreshEntities, saveEntity, setNotes,
} from "./entities.ts";

let vault: string;
const NOW = Date.parse("2026-09-20T12:00:00Z");

// One thread per call; each link is [label](prevail://kind/value).
function thread(name: string, links: string[], extra = "", updated = "2026-09-18T10:00:00Z") {
  const dir = join(vault, "data", "domains", "home", "memory", "threads");
  mkdirSync(dir, { recursive: true });
  const fm = `---\ntitle: ${name}\ncreated: ${updated}\nupdated: ${updated}\n${extra}---\n\n`;
  writeFileSync(join(dir, `${name}.md`), `${fm}## You\n\nq\n\n## claude\n\n${links.join(" and ")}.\n`);
}
const link = (kind: string, value: string, label = value) => `[${label}](prevail://${kind}/${encodeURIComponent(value)})`;
const pairs = () => entityDuplicates(vault).map((d) => `${d.a.id}|${d.b.id}`);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-dedup-"));
  mkdirSync(join(vault, "build"), { recursive: true });
  mkdirSync(join(vault, "data", "domains"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("detection", () => {
  test("same name written differently is clear; org suffixes are ignored", () => {
    thread("t1", [link("person", "Foo Bar"), link("org", "Foo Co")]);
    thread("t2", [link("person", "FooBar"), link("org", "Foo")]);
    buildIndex(vault, { now: NOW });
    const d = entityDuplicates(vault).sort((x, y) => x.pair.localeCompare(y.pair));
    expect(d.map((x) => [x.a.id, x.b.id, x.confidence])).toEqual([
      ["org/foo-co", "org/foo", 0.97],
      ["person/foo-bar", "person/foobar", 0.97],
    ]);
    expect(d[1].reason).toBe('"Foo Bar" and "FooBar" are the same name written differently');
    expect(d[1].a).toEqual({ id: "person/foo-bar", name: "Foo Bar", kind: "person", mentions: 1 });
  });

  test("a multi-word alias is clear; a bare first name alias is only proposed", () => {
    thread("t1", [link("person", "Foo Bar", "Chip Foo")]);
    thread("t2", [link("person", "Chip Foo")]);
    buildIndex(vault, { now: NOW });
    const [d] = entityDuplicates(vault);
    expect(d.pair).toBe("person/chip-foo|person/foo-bar");
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d.reason).toBe('"Chip Foo" is already another name for "Foo Bar"');

    thread("t3", [link("person", "Baz Qux", "Baz")]);
    thread("t4", [link("person", "Baz")]);
    buildIndex(vault, { now: NOW });
    const alias = entityDuplicates(vault).find((x) => x.a.id === "person/baz-qux")!;
    expect(alias.confidence).toBe(0.75);
    expect(alias.reason).toBe('"Baz Qux" is also called "Baz"');
  });

  test("a one-word name inside a longer one is proposed, never clear; shared conversations support it", () => {
    thread("t1", [link("person", "Foo")]);
    thread("t2", [link("person", "Foo Bar")]);
    buildIndex(vault, { now: NOW });
    let [d] = entityDuplicates(vault);
    expect([d.a.id, d.b.id, d.confidence]).toEqual(["person/foo-bar", "person/foo", 0.65]);
    thread("t3", [link("person", "Foo"), link("person", "Foo Bar")]);
    thread("t4", [link("person", "Foo"), link("person", "Foo Bar")]);
    thread("t5", [link("person", "Foo"), link("person", "Foo Bar")]);
    buildIndex(vault, { now: NOW });
    [d] = entityDuplicates(vault);
    expect(d.confidence).toBe(0.75);
    expect(d.confidence).toBeLessThan(0.9);
    expect(d.reason).toBe('"Foo" could be short for "Foo Bar"; both come up in 3 of the same conversations');
  });

  test("likely typos are proposed", () => {
    thread("t1", [link("person", "Fooley"), link("place", "Barnaby Street")]);
    thread("t2", [link("person", "Foolee"), link("place", "Barnabi Street")]);
    buildIndex(vault, { now: NOW });
    const d = entityDuplicates(vault);
    expect(d.map((x) => x.pair).sort()).toEqual(["person/foolee|person/fooley", "place/barnabi-street|place/barnaby-street"]);
    expect(d.every((x) => x.confidence === 0.65)).toBe(true);
  });

  test("false positives: different surnames, short words, other kinds, a first name shared by many", () => {
    thread("t1", [link("person", "Foo Bar"), link("person", "Foo Baz"), link("place", "Foo Bay")]);
    thread("t3", [link("person", "Foo")]);
    thread("t2", [link("person", "Qux"), link("person", "Quz"), link("thing", "Foo Bar Deluxe")]);
    buildIndex(vault, { now: NOW });
    const d = entityDuplicates(vault);
    expect(pairs()).not.toContain("person/foo-bar|person/foo-baz");
    expect(pairs().some((p) => p.includes("qu"))).toBe(false);
    expect(d.some((x) => x.a.kind !== x.b.kind)).toBe(false);
    // "Foo" could be either Foo Bar or Foo Baz: proposed, weaker, never clear.
    const foo = d.filter((x) => x.b.id === "person/foo");
    expect(foo.map((x) => x.a.id).sort()).toEqual(["person/foo-bar", "person/foo-baz"]);
    expect(foo.every((x) => x.confidence === 0.55)).toBe(true);
    expect(d.some((x) => x.confidence >= 0.9)).toBe(false);
  });
});

describe("merging", () => {
  test("refresh auto-merges clear pairs only and counts the rest as pending", async () => {
    thread("t1", [link("person", "Foo Bar")]);
    thread("t2", [link("person", "FooBar")]);
    thread("t3", [link("person", "Baz")]);
    thread("t4", [link("person", "Baz Qux")]);
    const r = await refreshEntities(vault, { run: null, now: NOW });
    expect(r.merged).toBe(1);
    expect(r.duplicates_pending).toBe(1);
    const idx = readIndex(vault);
    expect(idx.entities.find((e) => e.id === "person/foobar")).toBeUndefined();
    const keep = idx.entities.find((e) => e.id === "person/foo-bar")!;
    expect(keep.mention_count).toBe(2);
    expect(keep.aliases).toContain("FooBar");
    const m = readMerges(vault);
    expect(m.merges).toEqual([{ from: "person/foobar", into: "person/foo-bar", ts: "2026-09-20T12:00:00Z", auto: true, reason: '"Foo Bar" and "FooBar" are the same name written differently' }]);
    expect(m.notSame).toEqual([]);
    // No page existed yet for the merged one, so there is nothing to archive
    // and none is created for it.
    expect(existsSync(pagePath(vault, "person", "foobar"))).toBe(false);
    // Stable: a second refresh merges nothing more.
    expect((await refreshEntities(vault, { run: null, now: NOW })).merged).toBe(0);
  });

  test("a merge keeps aliases, mentions, conversations and notes, and archives the page", async () => {
    thread("t1", [link("person", "Foo")]);
    thread("t2", [link("person", "Foo Bar")]);
    thread("t3", [link("person", "Foo", "Chip")]);
    await refreshEntities(vault, { run: null, now: NOW });
    saveEntity(vault, "person/foo", { now: NOW });
    setNotes(vault, "person/foo", "Likes tea.", { now: NOW });
    setNotes(vault, "person/foo-bar", "Met in May.", { now: NOW });
    const res = mergeEntities(vault, "person/foo-bar", "person/foo", { now: NOW });
    expect(res).toEqual({ ok: true, id: "person/foo-bar" });

    const page = readFileSync(pagePath(vault, "person", "foo-bar"), "utf8");
    expect(page).toContain("name: Foo Bar");
    expect(page).toContain("aliases: [Foo, Chip]");
    expect(page).toContain("saved: true");
    expect(page).toContain("## Your notes\n\nMet in May.\n\n2026-09-20: Merged from Foo:\nLikes tea.\n");
    expect(page).toContain("mention_count: 3");
    expect(page).toContain("[t1]");
    expect(page).toContain("[t3]");
    expect(existsSync(pagePath(vault, "person", "foo"))).toBe(false);
    const archived = readFileSync(join(vault, "data", "entities", "_merged", "people", "foo", "entity.md"), "utf8");
    expect(archived).toContain("Likes tea.");

    const rec = readIndex(vault).entities.find((e) => e.id === "person/foo-bar")!;
    expect(rec.conversations).toBe(3);
    expect(readIndex(vault).entities.some((e) => e.id === "person/foo")).toBe(false);
    expect(readMerges(vault).merges[0]).toMatchObject({ from: "person/foo", into: "person/foo-bar", auto: false, reason: "merged by you" });
    expect(() => mergeEntities(vault, "person/foo-bar", "person/foo")).toThrow(/already/);
    expect(() => mergeEntities(vault, "person/foo-bar", "person/nobody")).toThrow(/no entity/);
  });

  test("the keeper picked explicitly keeps its name", () => {
    thread("t1", [link("person", "Foo")]);
    thread("t2", [link("person", "Foo Bar")]);
    buildIndex(vault, { now: NOW });
    expect(mergeEntities(vault, "person/foo", "person/foo-bar", { now: NOW }).id).toBe("person/foo");
    const d = entityDetail(vault, readIndex(vault), "person/foo-bar")!;
    expect(d.name).toBe("Foo");
    expect(d.aliases).toContain("Foo Bar");
    expect(d.mention_count).toBe(2);
  });

  test("a merged id resolves to its keeper: show, threads, chat block, entity tags, notes", () => {
    thread("t1", [link("person", "Foo")]);
    thread("t2", [link("person", "Foo Bar")]);
    thread("c1", ["hi"], "entity: person/foo\n", "2026-09-19T10:00:00Z");
    thread("c2", ["hi"], "entity: person/foo-bar\n", "2026-09-19T11:00:00Z");
    buildIndex(vault, { now: NOW });
    const before = readFileSync(join(vault, "data", "domains", "home", "memory", "threads", "c1.md"), "utf8");
    mergeEntities(vault, "person/foo-bar", "person/foo", { now: NOW });

    expect(entityDetail(vault, readIndex(vault), "person/foo")!.id).toBe("person/foo-bar");
    expect(entityThreads(vault, "person/foo").map((t) => t.slug)).toEqual(["c2", "c1"]);
    expect(entityThreads(vault, "person/foo-bar").map((t) => t.slug)).toEqual(["c2", "c1"]);
    expect(entityChatBlock(vault, "person/foo")).toContain("This conversation is about Foo Bar (Person, id person/foo-bar)");
    expect(readIndex(vault).entities.find((e) => e.id === "person/foo-bar")!.conversations).toBe(4);
    // Threads are never rewritten.
    expect(readFileSync(join(vault, "data", "domains", "home", "memory", "threads", "c1.md"), "utf8")).toBe(before);
    // Writes to the old id land on the keeper; the old page is not recreated.
    appendNote(vault, "person/foo", "Call back.", { now: NOW });
    expect(existsSync(pagePath(vault, "person", "foo"))).toBe(false);
    expect(readFileSync(pagePath(vault, "person", "foo-bar"), "utf8")).toContain("2026-09-20: Call back.");
  });

  test("not-same suppresses a pair for good, across refreshes", async () => {
    thread("t1", [link("person", "Foo")]);
    thread("t2", [link("person", "Foo Bar")]);
    buildIndex(vault, { now: NOW });
    expect(pairs()).toEqual(["person/foo-bar|person/foo"]);
    expect(markNotSame(vault, "person/foo", "person/foo-bar")).toEqual({ ok: true });
    markNotSame(vault, "person/foo-bar", "person/foo");
    expect(readMerges(vault).notSame).toEqual([["person/foo", "person/foo-bar"]]);
    expect(entityDuplicates(vault)).toEqual([]);
    const r = await refreshEntities(vault, { run: null, now: NOW });
    expect(r.duplicates_pending).toBe(0);
    expect(r.merged).toBe(0);
    expect(() => markNotSame(vault, "person/foo", "person/foo")).toThrow();
    // merges.json sits beside the pages, not under build/_meta.
    const raw = JSON.parse(readFileSync(join(vault, "data", "entities", "merges.json"), "utf8"));
    expect(Object.keys(raw)).toEqual(["merges", "notSame"]);
  });
});
