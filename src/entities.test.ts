import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex, buildTagPrompt, entityContextText, entityDetail, extractLinks, newSittings, pagePath, parseEntityId, parsePage,
  readIndex, readTags, refreshEntities, renderPage, saveEntity, searchEntities, setNotes, slugify, tagSittings, untaggedSittings,
  type SittingLike,
} from "./entities.ts";
import type { ModelRunner } from "./prompt-projects.ts";

let vault: string;
const NOW = Date.parse("2026-09-20T12:00:00Z");
const DAY = 864e5;

function thread(domain: string, name: string, title: string, body: string, updated = "2026-09-18T10:00:00Z") {
  const dir = join(vault, "data", "domains", domain, "memory", "threads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ntitle: ${title}\ndomain: ${domain}\ncreated: ${updated}\nupdated: ${updated}\n---\n\n## You\n\nq\n\n## claude\n\n${body}\n`);
}

function sitting(id: string, texts: string[], start: number, project = "maple"): SittingLike {
  return { id, tool: "claude", project, project_title: "Maple St rental", start_ts: start, end_ts: start + 60_000, prompts: texts.map((t, i) => ({ ts: start + i, text: t })) };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-entities-"));
  mkdirSync(join(vault, "build"), { recursive: true });
  mkdirSync(join(vault, "data", "domains"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("ids and links", () => {
  test("slugify and parse ids", () => {
    expect(slugify("Sam Rivera")).toBe("sam-rivera");
    expect(slugify("Café Acme & Co.")).toBe("cafe-acme-and-co");
    expect(parseEntityId("person/Sam%20Rivera")).toEqual({ kind: "person", slug: "sam-rivera" });
    expect(parseEntityId("people/sam-rivera")).toEqual({ kind: "person", slug: "sam-rivera" });
    expect(parseEntityId("Maple St")).toEqual({ kind: null, slug: "maple-st" });
    expect(parseEntityId("prevail://org/acme")).toEqual({ kind: "org", slug: "acme" });
  });

  test("extracts entity links with a snippet and ignores other kinds", () => {
    const md = "We met [Sam](prevail://person/Sam%20Rivera) at [Maple St](prevail://place/Maple%20St) about the [lease](prevail://file/x.md) with [acme](prevail://org/acme).";
    const links = extractLinks(md);
    expect(links.map((l) => `${l.kind}:${l.value}`)).toEqual(["person:Sam Rivera", "place:Maple St", "org:acme"]);
    expect(links[0].label).toBe("Sam");
    expect(links[0].snippet).toBe("We met Sam at Maple St about the lease with acme.");
  });
});

describe("index", () => {
  test("aggregates thread links and sitting tags with co-mentions", async () => {
    thread("home", "t1", "Lease questions", "Ask [Sam](prevail://person/Sam%20Rivera) about [Maple St](prevail://place/Maple%20St).");
    thread("money", "t2", "Rent plan", "[Sam Rivera](prevail://person/Sam%20Rivera) pays rent to [acme](prevail://org/acme).", "2026-09-19T10:00:00Z");
    const run: ModelRunner = async (prompt) => {
      expect(prompt).toContain("## Sitting s1");
      return JSON.stringify({ s1: [{ name: "Sam Rivera", kind: "person" }, { name: "Maple St", kind: "place" }, { name: "x", kind: "planet" }] });
    };
    const t = await tagSittings(vault, [sitting("s1", ["Draft a note to Sam Rivera about the Maple St roof"], NOW - DAY)], { run, now: NOW, domainOf: () => "home" });
    expect(t).toEqual({ tagged: 1, calls: 1, failed: 0, entities: 2 });

    const idx = buildIndex(vault, { now: NOW });
    const sam = idx.entities.find((e) => e.id === "person/sam-rivera")!;
    expect(sam.name).toBe("Sam Rivera");
    expect(sam.aliases).toContain("Sam");
    expect(sam.conversations).toBe(3);
    expect(sam.mentions[0].source).toBe("prompt");
    expect(sam.mentions[0].snippet).toContain("Sam Rivera");
    expect(sam.mentions.find((m) => m.source === "thread")?.ref).toBe("data/domains/money/memory/threads/t2.md");
    expect(sam.co_mentions[0]).toMatchObject({ id: "place/maple-st", count: 2 });
    expect(existsSync(join(vault, "build", "_meta", "entities", "index.json"))).toBe(true);
    expect(searchEntities(idx, "map").map((e) => e.id)).toEqual(["place/maple-st"]);
  });

  test("thread files are re-read only when they change", () => {
    thread("home", "t1", "One", "[Sam](prevail://person/Sam)");
    buildIndex(vault, { now: NOW });
    const cache = JSON.parse(readFileSync(join(vault, "build", "_meta", "entities", "threads.json"), "utf8"));
    expect(Object.keys(cache.files)).toEqual(["data/domains/home/memory/threads/t1.md"]);
    thread("home", "t1", "One", "[Sam](prevail://person/Sam) and [acme](prevail://org/acme)");
    const idx = buildIndex(vault, { now: NOW });
    expect(idx.entities.map((e) => e.id).sort()).toEqual(["org/acme", "person/sam"]);
  });
});

describe("tagging checkpoints", () => {
  test("refresh tags only new sittings; backfill sees the rest; cache is per sitting", async () => {
    const old = sitting("old", ["about acme"], NOW - 30 * DAY);
    const fresh = sitting("new", ["about acme"], NOW - 60_000);
    expect(newSittings(vault, [old, fresh], NOW).map((s) => s.id)).toEqual(["new"]);
    let calls = 0;
    const run: ModelRunner = async (prompt) => {
      calls++;
      const ids = [...prompt.matchAll(/## Sitting (\S+)/g)].map((m) => m[1]);
      return JSON.stringify(Object.fromEntries(ids.map((id) => [id, [{ name: "acme", kind: "org" }]])));
    };
    await tagSittings(vault, newSittings(vault, [old, fresh], NOW), { run, now: NOW });
    expect(newSittings(vault, [old, fresh], NOW)).toEqual([]);
    expect(untaggedSittings(vault, [old, fresh]).map((s) => s.id)).toEqual(["old"]);
    await tagSittings(vault, untaggedSittings(vault, [old, fresh]), { run, now: NOW, batch: 10 });
    expect(calls).toBe(2);
    expect(Object.keys(readTags(vault).sittings).sort()).toEqual(["new", "old"]);
    // A recent sitting that grew is tagged again; an old one never is.
    const grown = { ...fresh, prompts: [...fresh.prompts, { ts: NOW, text: "and Sam" }] };
    expect(newSittings(vault, [old, grown], NOW).map((s) => s.id)).toEqual(["new"]);
  });

  test("a failed batch is left for next time", async () => {
    const run: ModelRunner = async () => "not json";
    const r = await tagSittings(vault, [sitting("s1", ["acme"], NOW)], { run, now: NOW });
    expect(r.failed).toBe(1);
    expect(readTags(vault).sittings.s1).toBeUndefined();
  });

  test("tag prompt names every sitting", () => {
    const p = buildTagPrompt([{ id: "a1", text: "- hi" }, { id: "b2", text: "- yo" }]);
    expect(p).toContain("## Sitting a1");
    expect(p).toContain("## Sitting b2");
  });
});

describe("pages", () => {
  test("round-trips a page and keeps the owner's notes verbatim", () => {
    const md = "---\nname: Sam Rivera\nkind: person\naliases: [Sam]\nsaved: true\ncreated: 2026-09-01T00:00:00Z\nupdated: 2026-09-01T00:00:00Z\nmention_count: 2\nmood: calm\n---\n\n## What you've discussed\n\nold\n\n## Your notes\n\nLikes early calls.\n\n## Ideas\n- a user heading stays in notes\n\n## Conversations\n\n- x\n";
    const d = parsePage(md, { kind: "person", slug: "sam-rivera" });
    expect(d.name).toBe("Sam Rivera");
    expect(d.aliases).toEqual(["Sam"]);
    expect(d.saved).toBe(true);
    expect(d.notes).toBe("Likes early calls.\n\n## Ideas\n- a user heading stays in notes");
    const again = parsePage(renderPage(d), { kind: "person", slug: "sam-rivera" });
    expect(again.notes).toBe(d.notes);
    expect(again.extra.mood).toBe("calm");
    const blank = parsePage(renderPage({ ...d, discussed: "", conversations: "" }), { kind: "person", slug: "sam-rivera" });
    expect(blank.discussed).toBe("");
    expect(blank.conversations).toBe("");
  });

  test("auto page at 3 conversations, digest only when mentions change, notes untouched", async () => {
    for (const n of ["a", "b", "c"]) thread("home", n, `Chat ${n}`, `Talked to [Sam](prevail://person/Sam) about ${n}.`);
    thread("home", "d", "Chat d", "Visited [Maple St](prevail://place/Maple%20St).");
    let digestCalls = 0;
    const run: ModelRunner = async (prompt) => {
      digestCalls++;
      expect(prompt).toContain("state only what these excerpts say");
      return "You talked to Sam about a, b and c.";
    };
    const r = await refreshEntities(vault, { run, now: NOW });
    expect(r.pages_created).toBe(1);
    const p = pagePath(vault, "person", "sam");
    expect(existsSync(p)).toBe(true);
    expect(existsSync(pagePath(vault, "place", "maple-st"))).toBe(false);
    let page = readFileSync(p, "utf8");
    expect(page).toContain("saved: false");
    expect(page).toContain("mention_count: 3");
    expect(page).toContain("You talked to Sam about a, b and c.");
    expect(page).toContain("prevail://file/data/domains/home/memory/threads/a.md");

    setNotes(vault, "person/sam", "Prefers text over calls.", { now: NOW });
    await refreshEntities(vault, { run, now: NOW });
    expect(digestCalls).toBe(1);

    thread("home", "e", "Chat e", "[Sam](prevail://person/Sam) again.");
    await refreshEntities(vault, { run, now: NOW });
    expect(digestCalls).toBe(2);
    page = readFileSync(p, "utf8");
    expect(page).toContain("mention_count: 4");
    expect(page).toContain("## Your notes\n\nPrefers text over calls.");
  });

  test("save creates a saved page; detail and context text read it back", () => {
    thread("home", "a", "Chat a", "[acme](prevail://org/acme) quoted the roof.");
    buildIndex(vault, { now: NOW });
    const d = saveEntity(vault, "org/acme", { now: NOW });
    expect(d.saved).toBe(true);
    expect(d.page_path).toBe("data/entities/orgs/acme.md");
    expect(readIndex(vault).entities.find((e) => e.id === "org/acme")?.saved).toBe(true);
    const saved = saveEntity(vault, "thing/blue-kayak", { name: "Blue kayak", now: NOW });
    expect(saved.name).toBe("Blue kayak");
    const detail = entityDetail(vault, readIndex(vault), "Blue kayak")!;
    expect(detail.id).toBe("thing/blue-kayak");
    const text = entityContextText(entityDetail(vault, readIndex(vault), "org/acme")!);
    expect(text).toContain("# acme (Company or product, id org/acme)");
    expect(text).toContain("quoted the roof");
    expect(() => saveEntity(vault, "nobody-known", { now: NOW })).toThrow(/kind person, place, org or thing/);
  });

  test("a page alias folds other names into the page's entity", () => {
    mkdirSync(join(vault, "data", "entities", "people"), { recursive: true });
    writeFileSync(join(vault, "data", "entities", "people", "sam-rivera.md"), "---\nname: Sam Rivera\nkind: person\naliases: [Sammy]\nsaved: true\ncreated: x\nupdated: x\nmention_count: 0\n---\n\n## Your notes\n\nhi\n");
    thread("home", "a", "Chat a", "[Sammy](prevail://person/Sammy) called.");
    const idx = buildIndex(vault, { now: NOW });
    expect(idx.entities.map((e) => e.id)).toEqual(["person/sam-rivera"]);
    expect(idx.entities[0].mention_count).toBe(1);
  });
});
