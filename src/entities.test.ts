import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNote, buildIndex, buildTagPrompt, entityChatBlock, entityContextText, entityDetail, entityThreads, extractLinks, newSittings, pagePath, parseEntityId, parsePage,
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

  test("every entity gets a page; digest only at 3+ conversations or saved, and when mentions change; notes untouched", async () => {
    for (const n of ["a", "b", "c"]) thread("home", n, `Chat ${n}`, `Talked to [Sam](prevail://person/Sam) about ${n}.`);
    thread("home", "d", "Chat d", "Visited [Maple St](prevail://place/Maple%20St).");
    let digestCalls = 0;
    const run: ModelRunner = async (prompt) => {
      digestCalls++;
      expect(prompt).toContain("state only what these excerpts say");
      return "You talked to Sam about a, b and c.";
    };
    const r = await refreshEntities(vault, { run, now: NOW, autosave: "all" });
    expect(r.pages_created).toBe(2);
    const p = pagePath(vault, "person", "sam");
    expect(existsSync(p)).toBe(true);
    // One conversation: a page with its Conversations list, no digest section.
    const maple = readFileSync(pagePath(vault, "place", "maple-st"), "utf8");
    expect(maple).toContain("saved: false");
    expect(maple).toContain("## Your notes");
    expect(maple).toContain("## Conversations\n\n- 2026-09-18");
    expect(maple).not.toContain("What you've discussed");
    expect(digestCalls).toBe(1);
    let page = readFileSync(p, "utf8");
    expect(page).toContain("saved: false");
    expect(page).toContain("mention_count: 3");
    expect(page).toContain("You talked to Sam about a, b and c.");
    expect(page).toContain("prevail://file/data/domains/home/memory/threads/a.md");

    setNotes(vault, "person/sam", "Prefers text over calls.", { now: NOW });
    await refreshEntities(vault, { run, now: NOW, autosave: "all" });
    expect(digestCalls).toBe(1);

    thread("home", "e", "Chat e", "[Sam](prevail://person/Sam) again.");
    await refreshEntities(vault, { run, now: NOW, autosave: "all" });
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
    expect(d.page_path).toBe("data/entities/orgs/acme/entity.md");
    expect(readIndex(vault).entities.find((e) => e.id === "org/acme")?.saved).toBe(true);
    const saved = saveEntity(vault, "thing/blue-kayak", { name: "Blue kayak", now: NOW });
    expect(saved.name).toBe("Blue kayak");
    const detail = entityDetail(vault, readIndex(vault), "Blue kayak")!;
    expect(detail.id).toBe("thing/blue-kayak");
    const text = entityContextText(entityDetail(vault, readIndex(vault), "org/acme")!);
    expect(text).toContain("# acme (Product, id org/acme)");
    expect(text).toContain("quoted the roof");
    expect(() => saveEntity(vault, "nobody-known", { now: NOW })).toThrow(/kind person, place, org, thing or event/);
  });

  test("saving a one-conversation entity makes it digest-worthy", async () => {
    thread("home", "a", "Chat a", "Rode the [Blue kayak](prevail://thing/Blue%20kayak) out.");
    let calls = 0;
    const run: ModelRunner = async () => { calls++; return "You took the kayak out."; };
    await refreshEntities(vault, { run, now: NOW, autosave: "all" });
    expect(calls).toBe(0);
    saveEntity(vault, "thing/blue-kayak", { now: NOW });
    await refreshEntities(vault, { run, now: NOW, autosave: "all" });
    expect(calls).toBe(1);
    expect(readFileSync(pagePath(vault, "thing", "blue-kayak"), "utf8")).toContain("## What you've discussed\n\nYou took the kayak out.");
  });

  test("an alias never folds in a name that has its own page", async () => {
    thread("home", "a", "Chat a", "[Sam](prevail://person/Sam%20Rivera) and later [Sam](prevail://person/Sam).");
    thread("home", "b", "Chat b", "Only [Sam](prevail://person/Sam) here.");
    const before = buildIndex(vault, { now: NOW }).entities.map((e) => e.id).sort();
    await refreshEntities(vault, { run: null, now: NOW, autosave: "all" });
    const after = buildIndex(vault, { now: NOW }).entities.map((e) => `${e.id}:${e.mention_count}`).sort();
    expect(before).toEqual(["person/sam", "person/sam-rivera"]);
    expect(after).toEqual(["person/sam-rivera:1", "person/sam:2"]);
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

function entityChat(domain: string, name: string, entity: string, title: string, updated: string, turns: string[]) {
  const dir = join(vault, "data", "domains", domain, "memory", "threads");
  mkdirSync(dir, { recursive: true });
  const body = turns.map((t, i) => `## ${i % 2 ? "claude · m1" : "You"}\n\n${t}\n`).join("\n");
  writeFileSync(join(dir, `${name}.md`), `---\ntitle: ${title}\nentity: ${entity}\ncreated: ${updated}\nupdated: ${updated}\n---\n\n${body}`);
}

describe("entity chats", () => {
  test("a thread tagged entity: counts as a conversation, is listed on the page and feeds the digest", async () => {
    entityChat("general", "c1", "person/foo", "Foo plans", "2026-09-19T10:00:00Z", ["When does Foo move?", "In May.", "And the lease?", "Ends in June."]);
    thread("home", "t1", "Other", "Met [Foo](prevail://person/foo) today.");
    const prompts: string[] = [];
    const run: ModelRunner = async (p) => { prompts.push(p); return "You asked when Foo moves."; };
    saveEntity(vault, "person/foo", { now: NOW });
    await refreshEntities(vault, { run, now: NOW, autosave: "all" });
    const rec = readIndex(vault).entities.find((e) => e.id === "person/foo")!;
    expect(rec.conversations).toBe(2);
    expect(rec.mentions[0].snippet).toBe("When does Foo move? / And the lease?");
    const page = readFileSync(pagePath(vault, "person", "foo"), "utf8");
    expect(page).toContain("- 2026-09-19 · Chat in general: [Foo plans](prevail://file/data/domains/general/memory/threads/c1.md)");
    expect(prompts[0]).toContain("When does Foo move?");
  });

  test("a tag and a link to the same entity in one thread count once", () => {
    entityChat("general", "c1", "person/foo", "Foo", "2026-09-19T10:00:00Z", ["hi", "Ask [Foo](prevail://person/foo)."]);
    expect(buildIndex(vault, { now: NOW }).entities.find((e) => e.id === "person/foo")!.mention_count).toBe(1);
  });

  test("threads lists an entity's chats newest first with turn counts", () => {
    entityChat("general", "old", "person/foo", "Older", "2026-09-10T10:00:00Z", ["a", "b"]);
    entityChat("home", "new", "person/foo", "Newer", "2026-09-19T10:00:00Z", ["a", "b", "c", "d"]);
    entityChat("home", "else", "place/foo-st", "Elsewhere", "2026-09-19T11:00:00Z", ["a"]);
    thread("home", "plain", "Plain", "[Foo](prevail://person/foo)");
    buildIndex(vault, { now: NOW });
    const rows = entityThreads(vault, "person/foo");
    expect(rows).toEqual([
      { slug: "new", domain: "home", title: "Newer", updated: Date.parse("2026-09-19T10:00:00Z"), turns: 4 },
      { slug: "old", domain: "general", title: "Older", updated: Date.parse("2026-09-10T10:00:00Z"), turns: 2 },
    ]);
    expect(entityThreads(vault, "person/nobody")).toEqual([]);
  });

  test("an older link cache without entity fields is re-read", () => {
    entityChat("general", "c1", "person/foo", "Foo", "2026-09-19T10:00:00Z", ["hi"]);
    buildIndex(vault, { now: NOW });
    const path = join(vault, "build", "_meta", "entities", "threads.json");
    const cache = JSON.parse(readFileSync(path, "utf8"));
    for (const f of Object.values(cache.files) as Record<string, unknown>[]) { delete f.entity; delete f.turns; }
    delete cache.v;
    writeFileSync(path, JSON.stringify(cache));
    expect(entityThreads(vault, "person/foo").map((t) => t.slug)).toEqual(["c1"]);
  });

  test("note --append adds dated paragraphs and keeps what was there", () => {
    setNotes(vault, "person/foo", "First thought.", { now: NOW });
    appendNote(vault, "person/foo", "  Moves in May.\n", { now: NOW + DAY });
    const d = appendNote(vault, "person/foo", "Lease ends in June.", { now: NOW + 2 * DAY });
    expect(d.notes).toBe("First thought.\n\n2026-09-21: Moves in May.\n\n2026-09-22: Lease ends in June.");
    const fresh = appendNote(vault, "org/foo-co", "Quoted the roof.", { now: NOW });
    expect(fresh.saved).toBe(true);
    expect(fresh.notes).toBe("2026-09-20: Quoted the roof.");
    expect(() => appendNote(vault, "person/foo", "  ")).toThrow(/empty note/);
  });

  test("chat block: page sections, 10 newest conversations, labeled as the subject", async () => {
    for (let i = 0; i < 12; i++) thread("home", `t${i}`, `Chat ${i}`, "[Foo](prevail://person/foo)", `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00Z`);
    const run: ModelRunner = async () => "You planned a trip with Foo.";
    await refreshEntities(vault, { run, now: NOW, autosave: "all" });
    setNotes(vault, "person/foo", "Likes mornings.", { now: NOW });
    const b = entityChatBlock(vault, "person/foo");
    expect(b.startsWith("# ENTITY CONTEXT\nThis conversation is about Foo (Person, id person/foo).")).toBe(true);
    expect(b).toContain("## What you've discussed\nYou planned a trip with Foo.");
    expect(b).toContain("## Your notes\nLikes mornings.");
    const convos = b.split("## Recent conversations\n")[1].split("\n");
    expect(convos.length).toBe(10);
    expect(convos[0]).toContain("Chat 11");
    expect(b).not.toContain("Chat 1]");
  });

  test("chat block is capped and drops the oldest material first", () => {
    for (let i = 0; i < 10; i++) thread("home", `t${i}`, `Chat ${i}`, "[Foo](prevail://person/foo)", `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00Z`);
    buildIndex(vault, { now: NOW });
    setNotes(vault, "person/foo", `OLDEST ${"x".repeat(3000)} NEWEST`, { now: NOW });
    const b = entityChatBlock(vault, "person/foo", 1000);
    expect(b.length).toBeLessThanOrEqual(1000);
    expect(b).not.toContain("## Recent conversations");
    expect(b).not.toContain("OLDEST");
    expect(b).toContain("NEWEST");
    expect(b).toContain("This conversation is about Foo");
    const some = entityChatBlock(vault, "person/foo", 3400);
    expect(some).toContain("Chat 9");
    expect(some).not.toContain("Chat 0]");
  });

  test("chat block without a page comes from the index; unknown ids still get a label", () => {
    thread("home", "t1", "Chat", "Met [Foo](prevail://person/foo) at noon.");
    buildIndex(vault, { now: NOW });
    const b = entityChatBlock(vault, "person/foo");
    expect(b).toContain("This conversation is about Foo (Person, id person/foo)");
    expect(b).toContain("## Recent mentions");
    expect(b).toContain("Met Foo at noon.");
    expect(entityChatBlock(vault, "place/foo-st")).toContain("about foo-st (Place, id place/foo-st). Answer");
  });
});
