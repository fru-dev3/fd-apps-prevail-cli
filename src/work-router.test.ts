import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMission } from "./missions.ts";
import { buildCatalog, buildWorkPrompt, cleanName, codeRoute, destination, folderOf, folderPath, isSystemName, MAX_GOALS, MAX_TASKS, nameFromText, oneTaskPerIntent, parseWorkReply, routeWork, splitGoals, type Catalog } from "./work-router.ts";

const ROOT = join("/tmp", `prevail-work-router-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "insurance", "money", "pets"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d, summary: `Foo ${d}` }, routing: { keywords: d === "insurance" ? ["policy", "premium"] : [] }, config: { cli: d === "money" ? "codex" : "claude" } }));
  }
  const p = join(V, "data", "entities", "people", "foo-bar");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "entity.md"), "---\nname: Foo Bar\nkind: person\nsaved: true\n---\n");
  mkdirSync(join(V, "data", "apps", "foo-inbox"), { recursive: true });
  writeFileSync(join(V, "data", "apps", "foo-inbox", "manifest.json"), JSON.stringify({ title: "Foo Inbox" }));
  createMission(V, { name: "Bar site", outcome: "Ship the bar site", domains: [{ slug: "money", role: "owner" }], repos: ["/tmp/foo-home/code/bar-site"] });
}

const cat = (): Catalog => buildCatalog(V, {
  here: "laptop",
  machines: [{ label: "laptop", current: true, herdr: "local" }, { label: "mini-foo", current: false, herdr: "saved", role: "hub" }, { label: "air-foo", current: false, herdr: "missing" }],
  agentKinds: ["claude", "codex", "gemini"],
  roots: { vault: V, home: "/tmp/foo-home", mono: "/tmp/foo-home/code" },
});

describe("the catalog and destinations", () => {
  beforeEach(seed);
  test("lists domains, projects with folders, entities, apps and specialists", () => {
    const c = cat();
    expect(c.domains.map((d) => d.slug)).toEqual(["general", "insurance", "money", "pets"]);
    expect(c.projects[0]).toMatchObject({ slug: "bar-site", repos: ["/tmp/foo-home/code/bar-site"], owner: "money" });
    expect(c.entities.map((e) => e.id)).toContain("person/foo-bar");
    expect(c.apps).toEqual([{ id: "foo-inbox", title: "Foo Inbox" }]);
    expect(c.specialists.some((s) => s.id === "researcher")).toBe(true);
  });
  test("each kind maps to its space and owner; unknown ids are null", () => {
    const c = cat();
    expect(destination(c, "domain", "insurance")).toMatchObject({ space: "insurance", owner: "insurance" });
    expect(destination(c, "project", "bar-site")).toMatchObject({ space: "_mission-bar-site", owner: "mission/bar-site", folder: { root: "mono", rel: "bar-site" } });
    expect(destination(c, "folder", "/tmp/foo-home/code/bar-site")).toMatchObject({ kind: "folder", owner: "mission/bar-site" });
    expect(destination(c, "entity", "person/foo-bar")).toMatchObject({ kind: "entity", space: "general", entity: "person/foo-bar", label: "Foo Bar" });
    expect(destination(c, "app", "foo-inbox")).toMatchObject({ space: "_app-foo-inbox", owner: "_app-foo-inbox" });
    expect(destination(c, "domain", "nope")).toBeNull();
    expect(destination(c, "project", "nope")).toBeNull();
  });
  test("folders are kept relative to a root and found again on another machine", () => {
    const roots = { vault: "/tmp/v", home: "/tmp/h", mono: "/tmp/h/code" };
    expect(folderOf("/tmp/h/code/foo", roots)).toEqual({ root: "mono", rel: "foo" });
    expect(folderOf("/tmp/v/data/x", roots)).toEqual({ root: "vault", rel: "data/x" });
    expect(folderOf("~/notes", roots)).toEqual({ root: "home", rel: "notes" });
    expect(folderOf("/opt/foo", roots)).toEqual({ root: "abs", rel: "/opt/foo" });
    expect(folderPath({ root: "mono", rel: "foo" }, { mono: "/tmp/other/code" })).toBe("/tmp/other/code/foo");
    expect(folderPath({ root: "mono", rel: "foo" }, { home: "/tmp/x" })).toBeNull();
  });
});

describe("the model path", () => {
  beforeEach(seed);
  test("the prompt lists every catalog id and the caps", () => {
    const { system, prompt } = buildWorkPrompt("foo", cat());
    expect(system).toContain(`at most ${MAX_GOALS} goals`);
    expect(prompt).toContain("person/foo-bar = Foo Bar");
    expect(prompt).toContain("bar-site = Bar site");
    expect(prompt).toContain("mini-foo (hub)");
  });
  test("ids are checked, specialists filtered, missing homes become suggestions, kinds and machines defaulted", () => {
    const reply = JSON.stringify({ goals: [
      { text: "Cover the foo rentals", tasks: [
        { text: "Find a cheaper foo policy", dest: { kind: "domain", id: "insurance" }, alternatives: [{ kind: "domain", id: "money" }, { kind: "domain", id: "ghost" }], confidence: 0.9, why: "a policy", specialists: ["researcher", "made-up"], shape: "find", flags: { money: true }, effort: "standard" },
      ] },
      { text: "Gift for Foo Bar", tasks: [
        { text: "Pick a gift for Foo Bar", dest: { kind: "entity", id: "person/foo-bar" }, shape: "nope", agent: "gemini", missing: [{ kind: "domain", name: "gifts", why: "no home for gifts" }, { kind: "domain", name: "money", why: "exists" }] },
      ] },
      { text: "Fix the site", tasks: [
        { text: "Fix the foo site header", dest: { kind: "folder", id: "/tmp/foo-home/code/bar-site" }, shape: "make", effort: "deep", machine: "mini-foo" },
        { text: "Something with a bad home", dest: { kind: "domain", id: "ghost" }, machine: "mini-foo" },
      ] },
    ] });
    const p = parseWorkReply(reply, cat(), { userText: "foo", fallback: () => destination(cat(), "domain", "general"), kindFor: () => "claude" })!;
    expect(p.source).toBe("model");
    const [a, b, c] = p.goals;
    expect(a!.tasks[0]).toMatchObject({ dest: { id: "insurance", confidence: 0.9 }, specialists: ["researcher"], shape: "find", flags: { money: true }, agentKind: "claude", machine: "laptop" });
    expect(a!.tasks[0]!.alternatives.map((x) => x.id)).toEqual(["money"]);
    expect(b!.tasks[0]).toMatchObject({ dest: { kind: "entity" }, agentKind: "gemini", suggestions: [{ kind: "domain", name: "gifts", state: "open" }] });
    expect(b!.tasks[0]!.shape).toBe("plan");
    // Deep work may go to the saved hub; otherwise another machine needs naming.
    expect(c!.tasks[0]).toMatchObject({ dest: { kind: "folder" }, machine: "mini-foo" });
    expect(c!.tasks[1]).toMatchObject({ dest: { id: "general" }, machine: "laptop" });
  });
  test("caps goals and tasks", () => {
    const goals = Array.from({ length: 9 }, (_, i) => ({ text: `g${i}`, tasks: [{ text: `Do foo ${i}`, dest: { kind: "domain", id: "money" } }, { text: `Do bar ${i}`, dest: { kind: "domain", id: "money" } }] }));
    const p = parseWorkReply(JSON.stringify({ goals }), cat())!;
    expect(p.goals.length).toBeLessThanOrEqual(MAX_GOALS);
    expect(p.goals.flatMap((g) => g.tasks).length).toBe(MAX_TASKS);
  });
  test("an unusable reply falls back to code; a runner that throws too", async () => {
    expect(parseWorkReply("no json", cat())).toBeNull();
    const p = await routeWork(V, "Find a cheaper foo policy. Pick a gift for Foo Bar.", { catalog: cat(), runner: async () => { throw new Error("down"); } });
    expect(p.source).toBe("code");
  });
});

describe("the code path", () => {
  beforeEach(seed);
  test("splits sentences, lines and 'also', and merges scraps", () => {
    expect(splitGoals("Find a cheaper foo policy. Also, pick a gift for Foo Bar\n- fix the foo site header; ok")).toEqual(["Find a cheaper foo policy", "pick a gift for Foo Bar", "fix the foo site header, ok"]);
    expect(splitGoals("ok a few things. Get foo quotes. So, two things. Email the foo club")).toEqual(["Get foo quotes", "Email the foo club"]);
    expect(splitGoals("one two three. four five six. seven eight nine. a b c. d e f. g h i. j k l").length).toBe(MAX_GOALS);
  });
  test("routes three goals by their words, with kinds and machines", async () => {
    const p = await codeRoute(V, "Compare the premium on my foo policy. Pick a gift for Foo Bar with gemini. Ship the bar site on mini-foo.", cat());
    expect(p.source).toBe("code");
    const t = p.goals.map((g) => g.tasks[0]!);
    expect(t[0]!.dest).toMatchObject({ kind: "domain", id: "insurance" });
    expect(t[1]).toMatchObject({ dest: { kind: "entity", id: "person/foo-bar" }, agentKind: "gemini" });
    expect(t[2]).toMatchObject({ dest: { kind: "project", id: "bar-site" }, machine: "mini-foo" });
  });
  test("the destination's own engine is the default kind; General when nothing matches", async () => {
    const p = await codeRoute(V, "Look at money this month and tell me. Think about the weather tomorrow please.", cat());
    expect(p.goals[0]!.tasks[0]).toMatchObject({ dest: { id: "money" }, agentKind: "codex" });
    expect(p.goals[1]!.tasks[0]).toMatchObject({ dest: { id: "general", confidence: 0.2 }, agentKind: "claude" });
  });
  test("runner null and bunker both route by code", async () => {
    expect((await routeWork(V, "Find a cheaper foo policy", { catalog: cat(), runner: null })).source).toBe("code");
    process.env.PREVAIL_BUNKER = "1";
    try { expect((await routeWork(V, "Find a cheaper foo policy", { catalog: cat(), runner: async () => "{}" })).source).toBe("code"); } finally { delete process.env.PREVAIL_BUNKER; }
  });
});

describe("names, systems and one task per intent", () => {
  beforeEach(seed);
  test("every task gets a short Title Case name: the model's when it is one, else made from the words", () => {
    const reply = JSON.stringify({ goals: [{ text: "Foo", tasks: [
      { name: "landlord reply", text: "Draft a reply to Foo Bar accepting the offer", dest: { kind: "entity", id: "person/foo-bar" } },
      { name: "Search for good foo restaurants near the office tonight", text: "Search for good restaurants near me", dest: { kind: "domain", id: "general" } },
      { text: "Compare the foo insurance quotes", dest: { kind: "domain", id: "insurance" } },
    ] }] });
    const plan = parseWorkReply(reply, cat())!;
    expect(plan.goals[0]!.tasks.map((t) => t.name)).toEqual(["Landlord Reply", "Nearby Restaurants", "Foo Insurance Comparison"]);
    expect(cleanName("Draft reply to Landlord accepting")).toBe("Draft Reply to Landlord");
    expect(cleanName("a name of far too many words here")).toBeNull();
    expect(nameFromText("Draft reply to Landlord accepting")).toBe("Landlord Reply");
    expect(nameFromText("Find good dinner spots near me")).toBe("Dinner Spots");
    for (const t of plan.goals[0]!.tasks) expect(t.name.length).toBeLessThanOrEqual(28);
  });
  test("Herdr, Prevail, Glyph, machines and agent tools are never suggested as new apps", () => {
    const reply = JSON.stringify({ goals: [{ text: "Foo", tasks: [{ text: "Open the foo notes in Herdr on mini-foo", dest: { kind: "domain", id: "general" }, missing: [
      { kind: "app", name: "Herdr", why: "x" }, { kind: "app", name: "Prevail", why: "x" }, { kind: "app", name: "Glyph", why: "x" }, { kind: "app", name: "mini-foo", why: "x" },
      { kind: "app", name: "Claude Code", why: "x" }, { kind: "app", name: "codex", why: "x" }, { kind: "app", name: "Foo Bank", why: "a real app" },
    ] }] }] });
    const s = parseWorkReply(reply, cat())!.goals[0]!.tasks[0]!.suggestions;
    expect(s.map((x) => x.name)).toEqual(["Foo Bank"]);
    expect(isSystemName("Herdr", cat())).toBe(true);
    expect(isSystemName("Foo Bank", cat())).toBe(false);
    expect(buildWorkPrompt("x", cat()).system).toMatch(/not apps: never list them/);
  });
  test("a reply is one task that ends at a draft: never a draft task plus a send task", async () => {
    const reply = JSON.stringify({ goals: [{ text: "Reply to Foo Bar", tasks: [
      { name: "Foo Reply", text: "Draft a reply to Foo Bar", dest: { kind: "entity", id: "person/foo-bar" } },
      { name: "Send Reply", text: "Send the reply to Foo Bar", dest: { kind: "entity", id: "person/foo-bar" } },
    ] }] });
    expect(parseWorkReply(reply, cat())!.goals[0]!.tasks.map((t) => t.text)).toEqual(["Draft a reply to Foo Bar"]);
    const code = await codeRoute(V, "Draft a reply to Foo Bar and then send it to him", cat());
    expect(code.goals.flatMap((g) => g.tasks.map((t) => t.text))).toEqual(["Draft a reply to Foo Bar"]);
    // A send with nothing drafted beside it is left alone (it ends at a draft by the rules).
    expect(oneTaskPerIntent([{ text: "Send the foo invoice" }])).toEqual([{ text: "Send the foo invoice" }]);
    expect(buildWorkPrompt("x", cat()).system).toMatch(/One task per intent/);
  });
});
