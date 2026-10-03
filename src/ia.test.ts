import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildIndex, readPage, saveEntity, setNotes } from "./entities.ts";
import {
  KINDS, GROUPS, addService, adoptEvent, canonId, checkDraft, createEvent, createFromObjectDraft, draftObject, eventToCalendar, eventToProject,
  kindOf, linkObjects, linksOf, listEvents, listProducts, objectContextText, readFields, setFields, unlinkObjects,
} from "./ia.ts";
import { createMission, linkEvent, readMission } from "./missions.ts";
import { resolveScope } from "./scope.ts";

// The two groups and six kinds (ia-plan.md, IA0). Invented people, places,
// products and events only; no model and no calendar is ever called.
const ROOT = join("/tmp", `prevail-ia-${process.pid}`);
const V = join(ROOT, "vault");
const NOW = Date.parse("2026-10-02T12:00:00Z");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const w = (rel: string, text: string) => { const p = join(V, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])) : []);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "home"]) { mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true }); w(`data/domains/${d}/manifest.json`, JSON.stringify({ identity: { name: d } })); }
  // Products: a company the user talks about, its app, and an app with no company page.
  saveEntity(V, "org/foo-bank", { name: "Foo Bank", now: NOW });
  w("data/apps/foo-bank/manifest.json", JSON.stringify({ id: "foo-bank", title: "Foo Bank", kind: "service", identifiers: { domains: ["foobank.example"] } }));
  w("data/apps/bar-notes/manifest.json", JSON.stringify({ id: "bar-notes", title: "Bar Notes", kind: "app" }));
  w("data/apps/baz-mobile/manifest.json", JSON.stringify({ id: "baz-mobile", title: "Baz Mobile", company: "Foo Bank" }));
  saveEntity(V, "person/sam-foo", { name: "Sam Foo", now: NOW });
  saveEntity(V, "place/foo-house", { name: "Foo House", now: NOW });
  buildIndex(V, { now: NOW });
}

describe("the registry", () => {
  test("exactly six kinds in two groups, each with an icon", () => {
    expect(GROUPS.map((g) => g.label)).toEqual(["Entities", "Activities"]);
    expect(KINDS.map((k) => `${k.group}:${k.label}:${k.icon}`)).toEqual([
      "entities:People:Users", "entities:Places:MapPin", "entities:Products:Package", "entities:Things:Watch",
      "activities:Events:CalendarDays", "activities:Projects:FolderKanban",
    ]);
    expect(kindOf("app/foo-bank")?.id).toBe("products");
    expect(kindOf("project/plan-foo")?.id).toBe("projects");
    expect(kindOf("task/foo")).toBeNull();
  });
});

describe("products", () => {
  beforeEach(seed);
  test("companies and apps are one list; an app shows on its company's row and nothing is copied", () => {
    const before = files(join(V, "data")).length;
    const rows = listProducts(V);
    const bank = rows.find((r) => r.id === "org/foo-bank")!;
    expect(bank.company).toBe(true);
    // Matched by slug, and by the manifest's company field.
    expect(bank.apps.map((a) => a.id).sort()).toEqual(["baz-mobile", "foo-bank"]);
    const notes = rows.find((r) => r.id === "org/bar-notes")!;
    expect(notes).toMatchObject({ name: "Bar Notes", company: false, has_page: false, relation: "yours" });
    expect(rows.filter((r) => r.name === "Foo Bank").length).toBe(1);
    expect(files(join(V, "data")).length).toBe(before);
    expect(canonId(V, "app/baz-mobile")).toBe("org/foo-bank");
  });

  test("a product's chat carries its app records and their read tools", async () => {
    const s = await resolveScope(V, { domain: "general", entity: ["org/foo-bank"] });
    expect(s.kind).toBe("entity");
    expect(s.appIds.sort()).toEqual(["baz-mobile", "foo-bank"]);
    const text = s.blocks.map((b) => b.text).join("\n");
    expect(text).toContain("Its app record: Foo Bank (app foo-bank, service)");
  });
});

describe("things", () => {
  beforeEach(seed);
  test("an owned thing keeps purchase, warranty, value, maker, place and a service history", () => {
    const r = setFields(V, "thing/foo-watch", { purchased: "2025-03-01", warranty: "2027-03-01", value: "$420", maker: "Foo Bank", place: "Foo House" }, { name: "Foo Watch", now: NOW });
    expect(r.fields).toMatchObject({ purchased: "2025-03-01", warranty: "2027-03-01", value: 420, maker: "org/foo-bank", place: "place/foo-house" });
    addService(V, "thing/foo-watch", { date: "2026-01-10", what: "Battery replaced", cost: "35" }, NOW);
    const doc = readPage(V, "thing", "foo-watch")!;
    expect(readFields(doc).service).toEqual([{ date: "2026-01-10", what: "Battery replaced", cost: 35 }]);
    expect(() => setFields(V, "thing/foo-watch", { purchased: "2026-02-31" })).toThrow(/real date/);
    expect(() => setFields(V, "thing/foo-watch", { date: "2026-12-25" })).toThrow(/a thing has no date/);
    // Its maker and place see it from their side.
    expect(linksOf(V, "org/foo-bank").links.find((l) => l.id === "thing/foo-watch")).toMatchObject({ via: "field", role: "made", kind: "things" });
    expect(linksOf(V, "place/foo-house").links.map((l) => l.id)).toContain("thing/foo-watch");
    expect(objectContextText(V, "thing/foo-watch")).toContain("Warranty until: 2027-03-01");
  });
});

describe("events", () => {
  beforeEach(seed);
  test("an event is first class: a page, a chat, links both ways", async () => {
    const e = createEvent(V, { name: "Christmas", date: "2026-12-25", time: "18:00", place: "Foo House", people: ["Sam Foo"] }, NOW);
    expect(e).toEqual({ id: "event/christmas", created: true });
    expect(createEvent(V, { name: "Christmas", date: "2026-12-25" }, NOW).created).toBe(false);
    expect(createEvent(V, { name: "Christmas", date: "2027-12-25" }, NOW).id).toBe("event/christmas-2027");
    expect(linksOf(V, "person/sam-foo").links.map((l) => l.id)).toContain("event/christmas");
    const s = await resolveScope(V, { domain: "general", entity: ["event/christmas"] });
    const text = s.blocks.map((b) => b.text).join("\n");
    expect(text).toContain("Christmas (Event, id event/christmas)");
    expect(text).toContain("When: 2026-12-25 at 18:00");
    expect(text).toContain("With: Sam Foo (person/sam-foo)");
    expect(() => createEvent(V, { name: "Foo", date: "soon" }, NOW)).toThrow(/real date/);
  });

  test("the calendar strip: pages, the connected calendar, project milestones and holds, in date order", () => {
    createEvent(V, { name: "Christmas", date: "2026-12-25" }, NOW);
    w("build/calendar-external.json", JSON.stringify([{ id: "cal-1", title: "Foo dentist", date: "2026-10-20", url: "https://calendar.example/1" }]));
    createMission(V, { name: "Paint the foo shed", target: "2026-11-30", milestones: [{ title: "Paint bought", due: "2026-10-10" }], now: NOW });
    linkEvent(V, "paint-the-foo-shed", { title: "Painting hold", start: "2026-10-12T09:00", create: true }, NOW);
    const rows = listEvents(V, { from: "2026-10-01" });
    expect(rows.map((r) => `${r.date} ${r.source} ${r.name}`)).toEqual([
      "2026-10-10 milestone Paint bought", "2026-10-12 hold Painting hold", "2026-10-20 calendar Foo dentist", "2026-12-25 prevail Christmas",
    ]);
    expect(rows[0]!.project).toEqual({ id: "mission/paint-the-foo-shed", name: "Paint the foo shed" });
    // Opening a calendar row gives it a page, once; the strip then shows the page.
    const a = adoptEvent(V, "calendar:cal-1", NOW);
    expect(a.created).toBe(true);
    expect(adoptEvent(V, "event/foo-dentist", NOW).created).toBe(false);
    const after = listEvents(V, { from: "2026-10-01" });
    expect(after.filter((r) => r.name === "Foo Dentist").map((r) => r.source)).toEqual(["prevail"]);
    // A milestone opened as an event links to its project.
    const m = adoptEvent(V, "milestone:paint-the-foo-shed:ms-paint-bought", NOW);
    expect(readFields(readPage(V, "event", m.id.slice(6))!).project).toBe("mission/paint-the-foo-shed");
  });

  test("nothing reaches a calendar without the user's yes", async () => {
    createEvent(V, { name: "Foo birthday", date: "2026-11-02" }, NOW);
    const calls: unknown[] = [];
    const write = async (e: unknown) => { calls.push(e); return { ok: true, id: "g-1" }; };
    expect((await eventToCalendar(V, "event/foo-birthday", { write, now: NOW })).calendar).toBe("ask");
    expect(calls).toEqual([]);
    expect((await eventToCalendar(V, "event/foo-birthday", { no: true, write, now: NOW })).calendar).toBe("declined");
    expect(calls).toEqual([]);
    expect((await eventToCalendar(V, "event/foo-birthday", { yes: true, write, now: NOW })).calendar).toBe("synced");
    expect(calls).toEqual([{ title: "Foo Birthday", date: "2026-11-02" }]);
    expect(readFields(readPage(V, "event", "foo-birthday")!)).toMatchObject({ calendar: "synced", calendar_event: "g-1" });
    // A failed write stays asked and says why.
    createEvent(V, { name: "Foo trip", date: "2026-11-09" }, NOW);
    const r = await eventToCalendar(V, "event/foo-trip", { yes: true, write: async () => ({ ok: false, error: "offline" }), now: NOW });
    expect(r).toMatchObject({ calendar: "ask", note: "not added: offline" });
  });

  test("an event becomes a project due that day, linked both ways", async () => {
    createEvent(V, { name: "Christmas", date: "2026-12-25" }, NOW);
    const r = eventToProject(V, "event/christmas", { now: NOW });
    expect(r).toEqual({ event: "event/christmas", project: { id: "mission/plan-christmas", name: "Plan Christmas" }, created: true });
    const m = readMission(V, "plan-christmas")!;
    expect(m.target).toBe("2026-12-25");
    expect(m.entities).toContain("event/christmas");
    expect(eventToProject(V, "event/christmas", { now: NOW }).created).toBe(false);
    expect(linksOf(V, "mission/plan-christmas").links.map((l) => l.id)).toContain("event/christmas");
    expect(listEvents(V).find((e) => e.id === "event/christmas")?.project?.name).toBe("Plan Christmas");
    // The project's chat brings the event along.
    const s = await resolveScope(V, { mission: "plan-christmas" });
    expect(s.blocks.some((b) => b.source === "entity:event/christmas")).toBe(true);
    createEvent(V, { name: "Foo past", date: "2026-01-01" }, NOW);
    expect(() => eventToProject(V, "event/foo-past", { now: NOW })).toThrow(/passed/);
  });
});

describe("links", () => {
  beforeEach(seed);
  test("any object links to any other; kept once, shown on both sides, removable", async () => {
    createMission(V, { name: "Move to foo house", target: "2027-01-31", now: NOW });
    expect(linkObjects(V, "person/sam-foo", "project/move-to-foo-house", NOW)).toEqual({ a: "person/sam-foo", b: "mission/move-to-foo-house", added: true });
    expect(linkObjects(V, "mission/move-to-foo-house", "person/sam-foo", NOW).added).toBe(false);
    linkObjects(V, "app/bar-notes", "place/foo-house", NOW);
    expect(linksOf(V, "person/sam-foo").links).toEqual([{ id: "mission/move-to-foo-house", name: "Move to foo house", kind: "projects", via: "link" }]);
    expect(linksOf(V, "org/bar-notes").links.map((l) => l.id)).toEqual(["place/foo-house"]);
    // The project's chat brings a linked person along.
    const s = await resolveScope(V, { mission: "move-to-foo-house" });
    expect(s.entityIds).toContain("person/sam-foo");
    expect(() => linkObjects(V, "person/sam-foo", "person/sam-foo")).toThrow(/itself/);
    expect(() => linkObjects(V, "person/sam-foo", "mission/nope")).toThrow(/no project/);
    expect(unlinkObjects(V, "mission/move-to-foo-house", "person/sam-foo").removed).toBe(true);
    expect(linksOf(V, "person/sam-foo").links).toEqual([]);
    expect(JSON.parse(readFileSync(join(V, "data", "entities", "links.json"), "utf8")).links.length).toBe(1);
  });
});

describe("new by talking", () => {
  beforeEach(seed);
  test("the draft keeps only what checks out; the user's go saves it", async () => {
    const runner = async () => JSON.stringify({ fields: { name: "Christmas dinner", date: "2026-12-25", time: "18:00", place: "Foo House", people: ["Sam Foo", "Nobody Said"] }, say: "Got it.", question: null });
    const r = await draftObject(V, { kind: "event", turns: [{ role: "user", text: "Christmas dinner at Foo House with Sam Foo" }], runner, now: NOW });
    expect(r.draft).toEqual({ name: "Christmas dinner", date: "2026-12-25", time: "18:00", place: "Foo House", people: ["Sam Foo"] });
    expect(r.dropped.map((d) => d.field)).toEqual(["people"]);
    expect(r.ready).toBe(true);
    const go = await draftObject(V, { kind: "event", turns: [{ role: "user", text: "Christmas dinner at Foo House with Sam Foo" }, { role: "assistant", text: r.reply }, { role: "user", text: "save it" }], draft: r.draft, runner, now: NOW });
    expect(go.go).toBe(true);
    const made = createFromObjectDraft(V, "event", go.draft, NOW);
    expect(made.id).toBe("event/christmas-dinner");
    expect(readFields(readPage(V, "event", "christmas-dinner")!)).toMatchObject({ date: "2026-12-25", place: "place/foo-house", people: ["person/sam-foo"] });
    expect(checkDraft(V, "thing", { name: "Foo phone", value: "lots" }, "").dropped[0]).toMatchObject({ field: "value" });
    const thing = createFromObjectDraft(V, "thing", { name: "Foo phone", purchased: "2026-05-01", value: 900, maker: "Foo Bank" }, NOW);
    expect(readFields(readPage(V, "thing", thing.id.slice(6))!)).toMatchObject({ purchased: "2026-05-01", value: 900, maker: "org/foo-bank" });
    expect(() => createFromObjectDraft(V, "event", { name: "No date" }, NOW)).toThrow(/needs a date/);
  });

  test("an unreadable model reply asks again instead of guessing", async () => {
    const r = await draftObject(V, { kind: "person", turns: [{ role: "user", text: "add someone" }], runner: async () => "not json", now: NOW });
    expect(r.reply).toContain("I could not read that just now.");
    expect(r.ready).toBe(false);
    setNotes(V, "person/sam-foo", "Lends a ladder.", { now: NOW });
  });
});
