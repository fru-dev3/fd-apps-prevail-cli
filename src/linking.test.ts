import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatJson } from "./chat-json.ts";
import { readAutosave, setAutosave } from "./config.ts";
import { buildIndex, findEntity, readIndex, readPage, readRelations, refreshEntities, saveEntity, scoreRelation, setRelation } from "./entities.ts";
import { catchUpCount, consolidate, readUnhomed, readUpdates, recordTouch, replaceSection, replyIsError, runTouchStep, TOUCH_MAX_ENTITIES, touchSkipReason, touchedEntities, userText } from "./linking.ts";
import { fromUpdates } from "./recommendations.ts";
import { classifyTouches, parseTouchReply, TOUCH_FACT_CHARS, type TouchOptions, type TouchResult } from "./route.ts";
import type { DecisionProvider } from "./decision.ts";

// Linking: touches, update lines, Yours vs Reference, consolidation. No model
// is ever called: every classifier and runner here is a stand-in.
let vault: string;
let cfgDir: string;
let savedCfg: string | undefined;
const NOW = Date.parse("2026-09-20T12:00:00Z");
const DAY = 864e5;
const DOMAINS = ["general", "realestate", "insurance", "legal"];

const dom = (...p: string[]) => join(vault, "data", "domains", ...p);
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function thread(domain: string, name: string, user: string, reply: string, updated = "2026-09-18T10:00:00Z") {
  const dir = dom(domain, "memory", "threads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ntitle: ${name}\nupdated: ${updated}\n---\n\n## You\n\n${user}\n\n## claude\n\n${reply}\n`);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-linking-"));
  cfgDir = mkdtempSync(join(tmpdir(), "prevail-linking-cfg-"));
  savedCfg = process.env.PREVAIL_CONFIG_DIR;
  process.env.PREVAIL_CONFIG_DIR = cfgDir;
  mkdirSync(join(vault, "build"), { recursive: true });
  for (const d of DOMAINS) {
    mkdirSync(dom(d, "memory"), { recursive: true });
    writeFileSync(dom(d, "manifest.json"), JSON.stringify({ identity: { name: d, summary: `the ${d} area` } }));
    writeFileSync(dom(d, ".prevail-layout-v4"), "");
  }
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
  if (savedCfg === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = savedCfg;
});

describe("touch classification", () => {
  const known = ["insurance", "legal", "realestate"];

  test("multi-label parse keeps real slugs at 0.6+, at most 4, facts clipped", () => {
    const long = "x".repeat(400);
    const r = parseTouchReply(JSON.stringify({
      domains: [
        { slug: "insurance", confidence: 0.9, fact: "Water damage claim at 1 Foo Way: settlement not released" },
        { slug: "legal", confidence: 0.61, fact: long },
        { slug: "health", confidence: 0.99, fact: "not a domain" },
        { slug: "realestate", confidence: 0.4, fact: "below the bar" },
        { slug: "insurance", confidence: 0.8, fact: "duplicate" },
      ],
      entity_facts: { "place/1-foo-way": "Claim open", "person/nobody": "unknown id" },
    }), known, ["place/1-foo-way"]);
    expect(r!.domains.map((d) => d.slug)).toEqual(["insurance", "legal"]);
    expect(r!.domains[1].fact.length).toBe(TOUCH_FACT_CHARS);
    expect(r!.entity_facts).toEqual({ "place/1-foo-way": "Claim open" });
    expect(parseTouchReply("no json here", known)).toBeNull();
    const many = parseTouchReply(JSON.stringify({ domains: ["a", "b", "c", "d", "e"].map((slug) => ({ slug, confidence: 0.9, fact: slug })) }), ["a", "b", "c", "d", "e"]);
    expect(many!.domains.length).toBe(4);
  });

  test("the conversation's own domain is never a touch; the decision layer narrows and keeps its confidence", async () => {
    const asked: string[][] = [];
    const runner = async ({ system }: { system: string }) => {
      asked.push(DOMAINS.filter((d) => system.includes(`- ${d}:`)));
      return JSON.stringify({ domains: [{ slug: "realestate", confidence: 1, fact: "own domain" }, { slug: "insurance", confidence: 0.7, fact: "Claim filed" }] });
    };
    const opts: TouchOptions = { home: "realestate", message: "m", reply: "r", domains: DOMAINS.map((slug) => ({ slug, description: "" })), runner };
    const plain = await classifyTouches(opts);
    expect(plain.domains.map((d) => d.slug)).toEqual(["insurance"]);
    expect(asked[0]).toEqual(["insurance", "legal"]);

    const provider: DecisionProvider = {
      id: "stub", available: () => true, unavailableReason: () => null,
      evaluate: async (_s, q) => ({ answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul" as const, probability: k === "insurance" ? 0.83 : 0.2 }])) }) as never,
    };
    const narrowed = await classifyTouches({ ...opts, provider });
    expect(asked[1]).toEqual(["insurance"]);
    expect(narrowed).toMatchObject({ source: "typesafe", domains: [{ slug: "insurance", confidence: 0.83, fact: "Claim filed" }] });

    // Nothing clears the bar: the model is still asked, with no areas listed
    // (it may notice a topic with no home), and no domain comes back.
    const none: DecisionProvider = { ...provider, evaluate: async (_s, q) => ({ answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul" as const, probability: 0.1 }])) }) as never };
    const before = asked.length;
    expect((await classifyTouches({ ...opts, provider: none })).domains).toEqual([]);
    expect(asked.length).toBe(before + 1);
    expect(asked.at(-1)).toEqual([]);
  });

  test("skip rules: short, incognito, local-only unless the classifier is local", () => {
    const base = { message: "What does the water damage claim mean for the house?", localOnly: false, incognito: false };
    expect(touchSkipReason(base)).toBeNull();
    expect(touchSkipReason({ ...base, message: "thanks, got it" })).toBe("short message");
    expect(touchSkipReason({ ...base, incognito: true })).toBe("incognito");
    expect(touchSkipReason({ ...base, localOnly: true })).toBe("local only");
    expect(touchSkipReason({ ...base, localOnly: true, classifierLocal: true })).toBeNull();
  });

  test("entities: Yours linked in the reply or named in the user's text, never references", () => {
    const yours = [{ id: "place/1-foo-way", name: "1 Foo Way", aliases: ["the Foo house"] }, { id: "person/bar-lawyer", name: "Bar Qux", aliases: [] }];
    expect(touchedEntities(yours, "the foo house flooded again", "Ask [Bar Qux](prevail://person/Bar%20Qux) and [Seneca](prevail://person/Seneca).")).toEqual(["person/bar-lawyer", "place/1-foo-way"]);
    expect(touchedEntities(yours, "nothing here", "plain reply")).toEqual([]);
  });
});

describe("the touched event and update lines", () => {
  const MSG = "The water damage claim at the Foo house: my lawyer says the settlement is not released yet.";
  async function turn(classify: ((o: TouchOptions) => Promise<TouchResult>) | undefined, extra: Record<string, unknown> = {}) {
    const out: string[] = [];
    const code = await runChatJson({
      // General: a temp dir is not a scannable vault path, and General always resolves.
      vaultPath: vault, domain: "general", message: MSG, sessionId: "t-foo", write: (l) => out.push(l),
      deps: {
        detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
        runChatTurn: async () => "Noted. Keep the adjuster's letter.",
        persistMessage: () => {},
        ...(classify ? { classifyTouches: classify } : {}),
      },
      ...extra,
    });
    return { code, events: out.map((l) => JSON.parse(l)) };
  }
  const stub = async (o: TouchOptions): Promise<TouchResult> => ({
    domains: o.domains.filter((d) => d.slug === "insurance" || d.slug === "legal").sort((a, b) => a.slug.localeCompare(b.slug))
      .map((d) => ({ slug: d.slug, confidence: 0.9, fact: `${d.slug}: claim not released` })),
    entity_facts: {}, source: "model",
  });

  test("touched comes after done, and the lines land in every touched place: code first, the model only for a tie", async () => {
    writeFileSync(dom("insurance", "manifest.json"), JSON.stringify({ identity: { name: "insurance" }, routing: { keywords: ["claim", "adjuster"] } }));
    writeFileSync(dom("legal", "manifest.json"), JSON.stringify({ identity: { name: "legal" }, routing: { keywords: ["lawyer", "settlement"] } }));
    let asked: string[] = [];
    const r = await turn(async (o) => { asked = o.domains.map((d) => d.slug); return stub(o); });
    // Legal has two hits (code); insurance one (a tie: only it goes to the model).
    expect(asked).toEqual(["insurance"]);
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.type)).toEqual(["start", "user", "assistant", "usage", "done", "touched"]);
    const t = r.events.at(-1);
    expect(t).toMatchObject({ type: "touched", thread: "t-foo", by: "model", domains: [{ slug: "legal", fact: MSG }, { slug: "insurance", fact: "insurance: claim not released" }], entities: [] });
    const ins = lines(dom("insurance", "memory", "updates.jsonl"));
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from_domain: "general", thread: "t-foo", fact: "insurance: claim not released", entities: [] });
    expect(lines(dom("general", "memory", "touches.jsonl"))[0]).toMatchObject({ thread: "t-foo", domains: ["legal", "insurance"], entities: [] });
    expect(readFileSync(dom("legal", "memory", "memory.md"), "utf8")).toContain(`: ${MSG} (from General, thread t-foo)`);
  });

  test("a turn that names no domain routes nothing, but a small daily allowance still notices topics with no home", async () => {
    writeFileSync(dom("insurance", "manifest.json"), JSON.stringify({ identity: { name: "insurance" }, routing: { keywords: ["claim", "adjuster"] } }));
    const LONG = "I keep thinking about building a foo workbench in the garage over the winter, with proper vises and storage.";
    const seen: string[][] = [];
    const classify = async (o: TouchOptions): Promise<TouchResult> => { seen.push(o.domains.map((d) => d.slug)); return { domains: [{ slug: "insurance", confidence: 1, fact: "never taken" }], entity_facts: {}, unhomed: [{ label: "woodworking", fact: "a foo workbench" }], source: "model" }; };
    const step = { vault, home: "general", thread: "t-wood", reply: "Sounds good.", incognito: false, localOnly: false, classify };
    // Small talk with no domain asks nothing.
    await runTouchStep({ ...step, message: "ok, sounds good to me" });
    expect(seen).toEqual([]);
    // A real no-hit turn: the model sees no domains, routes nothing, and its topic is kept.
    const r = await runTouchStep({ ...step, message: LONG });
    expect(seen).toEqual([[]]);
    expect(r?.domains ?? []).toEqual([]);
    expect(readUnhomed(vault).map((u) => u.label)).toEqual(["woodworking"]);
    // The allowance is small: after ten looks today, no more.
    for (let n = 0; n < 12; n++) await runTouchStep({ ...step, thread: `t-${n}`, message: LONG });
    expect(seen.length).toBe(10);
  });

  test("no classifier in tests means no step; skips and timeouts emit nothing", async () => {
    expect((await turn(undefined)).events.at(-1).type).toBe("done");
    expect((await turn(stub, { incognito: true })).events.at(-1).type).toBe("done");
    const step = { vault, home: "general", thread: "t", message: MSG, reply: "r", incognito: false, classify: stub };
    expect(await runTouchStep({ ...step, localOnly: true })).toBeNull();
    expect(await runTouchStep({ ...step, localOnly: false, message: "ok thanks" })).toBeNull();
    expect(existsSync(dom("insurance", "memory", "updates.jsonl"))).toBe(false);
    const slow = await runTouchStep({
      vault, home: "realestate", thread: "t", message: MSG, reply: "r", localOnly: false, incognito: false,
      classify: () => new Promise((r) => setTimeout(() => r({ domains: [{ slug: "legal", confidence: 1, fact: "late" }], entity_facts: {}, source: "model" }), 200)),
      timeoutMs: 20,
    });
    expect(slow).toBeNull();
    expect(existsSync(dom("legal", "memory", "updates.jsonl"))).toBe(false);
  });

  test("entity update lines use the entity fact, else the domain fact; prevail updates reads newest first", () => {
    saveEntity(vault, "place/foo-house", { name: "Foo House" });
    recordTouch(vault, { home: "realestate", thread: "t1", domains: [{ slug: "insurance", confidence: 0.9, fact: "Claim open" }], entities: ["place/foo-house"], fallbackFact: "x", ts: NOW - DAY });
    recordTouch(vault, { home: "legal", thread: "t2", domains: [], entities: ["place/foo-house"], entityFacts: { "place/foo-house": "Lawyer engaged" }, fallbackFact: "x", ts: NOW });
    const ent = lines(join(vault, "data", "entities", "places", "foo-house", "updates.jsonl"));
    expect(ent.map((l) => l.fact)).toEqual(["Claim open", "Lawyer engaged"]);
    expect(ent[0]).toEqual({ ts: NOW - DAY, from_domain: "realestate", thread: "t1", fact: "Claim open" });
    const all = readUpdates(vault);
    expect(all.map((r) => [r.fact, r.target])).toEqual([
      ["Lawyer engaged", { kind: "entity", id: "place/foo-house" }],
      ["Claim open", { kind: "domain", slug: "insurance" }],
      ["Claim open", { kind: "entity", id: "place/foo-house" }],
    ]);
    expect(readUpdates(vault, { domain: "insurance" })).toHaveLength(1);
    expect(readUpdates(vault, { entity: "place/foo-house", since: NOW - 1 })).toHaveLength(1);
    expect(readUpdates(vault, { limit: 1 })).toHaveLength(1);
  });
});

describe("Yours vs Reference", () => {
  test("user words vs model-only, possessives, sticky actions, overrides", () => {
    // Model-only: an essay about a historical figure.
    thread("general", "t1", "write me an essay about ancient rome", "[Seneca](prevail://person/Seneca) advised the emperor.");
    // In the user's words with a possessive, in a real domain.
    thread("realestate", "t2", "my lawyer Bar Qux wants the claim papers", "Send [Bar Qux](prevail://person/Bar%20Qux) the letter.");
    // In the user's words, in passing, in General.
    thread("general", "t3", "what would Quux Corp think", "[Quux Corp](prevail://product/Quux%20Corp) is a firm.");
    const idx = buildIndex(vault, { now: NOW });
    const rel = (id: string) => findEntity(idx, id)!;
    expect(rel("person/seneca")).toMatchObject({ relation: "reference", relation_reason: "Only mentioned in replies, not in your own words." });
    expect(rel("person/bar-qux")).toMatchObject({ relation: "yours", home_domain: "realestate", user_mentions: 1 });
    expect(rel("product/quux-corp").relation).toBe("reference");

    // Sticky: a saved entity is yours whatever the signals.
    saveEntity(vault, "person/seneca");
    expect(findEntity(buildIndex(vault, { now: NOW }), "person/seneca")!.relation).toBe("yours");
    // An override always wins, and persists in relations.json.
    setRelation(vault, "person/seneca", "reference");
    setRelation(vault, "product/quux-corp", "yours");
    expect(readRelations(vault).overrides).toEqual({ "person/seneca": "reference", "product/quux-corp": "yours" });
    const again = buildIndex(vault, { now: NOW });
    expect(findEntity(again, "person/seneca")!.relation).toBe("reference");
    expect(findEntity(again, "product/quux-corp")).toMatchObject({ relation: "yours", relation_confidence: 1 });
    expect(() => setRelation(vault, "person/seneca", "maybe")).toThrow();
  });

  test("scoring: weak evidence means reference", () => {
    const s = { acted: false, userMentions: 0, possessive: false, inSources: false, nonGeneral: false };
    expect(scoreRelation(s).relation).toBe("reference");
    expect(scoreRelation({ ...s, userMentions: 2, nonGeneral: true }).relation).toBe("reference");
    expect(scoreRelation({ ...s, userMentions: 1, possessive: true }).relation).toBe("yours");
    expect(scoreRelation({ ...s, userMentions: 1, inSources: true }).relation).toBe("yours");
    expect(scoreRelation({ ...s, acted: true })).toMatchObject({ relation: "yours", confidence: 1 });
  });

  test("source files count as the user's own", () => {
    mkdirSync(dom("realestate", "source"), { recursive: true });
    writeFileSync(dom("realestate", "source", "notes.md"), "Lease signed with Zed Tenant in May.");
    thread("realestate", "t1", "did Zed Tenant pay", "[Zed Tenant](prevail://person/Zed%20Tenant) paid.");
    expect(findEntity(buildIndex(vault, { now: NOW }), "person/zed-tenant")!.relation).toBe("yours");
  });

  test("a reference with no user-word mention in 90 days fades from the index; yours never do", () => {
    const old = new Date(NOW - 120 * DAY).toISOString();
    thread("general", "t1", "tell me about rome", "[Seneca](prevail://person/Seneca) wrote letters.", old);
    thread("realestate", "t2", "my tenant Zed Tenant moved out", "[Zed Tenant](prevail://person/Zed%20Tenant) left.", old);
    const idx = buildIndex(vault, { now: NOW });
    expect(findEntity(idx, "person/seneca")).toBeNull();
    expect(findEntity(idx, "person/zed-tenant")!.relation).toBe("yours");
  });

  test("autosave: yours (default) pages only the user's own; all pages everything; off none", async () => {
    thread("general", "t1", "tell me about rome", "[Seneca](prevail://person/Seneca) wrote letters.");
    thread("realestate", "t2", "my tenant Zed Tenant moved out", "[Zed Tenant](prevail://person/Zed%20Tenant) left.");
    expect(readAutosave()).toBe("yours");
    await refreshEntities(vault, { run: null, now: NOW });
    expect(readPage(vault, "person", "zed-tenant")).not.toBeNull();
    expect(readPage(vault, "person", "seneca")).toBeNull();
    setAutosave("off");
    expect(readAutosave()).toBe("off");
    rmSync(join(vault, "data", "entities"), { recursive: true, force: true });
    await refreshEntities(vault, { run: null, now: NOW });
    expect(readPage(vault, "person", "zed-tenant")).toBeNull();
    await refreshEntities(vault, { run: null, now: NOW, autosave: "all" });
    expect(readPage(vault, "person", "seneca")).not.toBeNull();
    expect(() => setAutosave("some" as never)).toThrow();
  });
});

describe("daily consolidation", () => {
  const touch = (slug: string, from: string, fact: string, ts: number) =>
    recordTouch(vault, { home: from, thread: `t-${ts}`, domains: [{ slug, confidence: 0.9, fact }], entities: [], fallbackFact: fact, ts });

  test("folds into state.md, memory.md when durable, and the entity page; checkpoints; never deletes lines", () => {
    writeFileSync(dom("insurance", "memory", "state.md"), "# State\n\nPolicy active.\n\n## Open items\n\n- renew\n");
    touch("insurance", "realestate", "Claim open at the Foo house", NOW - 3 * DAY);
    touch("insurance", "realestate", "Adjuster visited", NOW - 2 * DAY);
    touch("insurance", "realestate", "Settlement not released", NOW - DAY);
    touch("insurance", "legal", "Lawyer engaged", NOW - DAY + 1);
    saveEntity(vault, "place/foo-house", { name: "Foo House" });
    recordTouch(vault, { home: "realestate", thread: "t9", domains: [], entities: ["place/foo-house"], entityFacts: { "place/foo-house": "Roof leak" }, fallbackFact: "x", ts: NOW - DAY });

    const r = consolidate(vault, { now: NOW, isClient: () => false });
    expect(r).toEqual({ ok: true, domains: ["insurance"], entities: ["place/foo-house"] });
    const state = readFileSync(dom("insurance", "memory", "state.md"), "utf8");
    expect(state).toContain("## Across your life\n\n- 2026-09-19 · from Legal: Lawyer engaged\n- 2026-09-19 · from Realestate: Settlement not released");
    expect(state).toContain("## Open items\n\n- renew");
    const mem = readFileSync(dom("insurance", "memory", "memory.md"), "utf8");
    expect(mem).toContain("## Across your life\n\n- 2026-09-19 · from Realestate: Settlement not released");
    expect(mem.split("## Across your life")[1]).not.toContain("Lawyer engaged");
    // Every touch is also a dated line in the domain's memory, with its thread.
    expect(mem).toContain("## Noted from conversations\n- 2026-09-17: Claim open at the Foo house (from Realestate, thread ");
    expect(readPage(vault, "place", "foo-house")!.discussed).toContain("**Across your life**\n- 2026-09-19 · from Realestate: Roof leak");
    expect(lines(dom("insurance", "memory", "updates.jsonl"))).toHaveLength(4);

    // Once a day: a new line the same day waits; nothing new, nothing runs.
    touch("insurance", "legal", "Hearing set", NOW + 1000);
    expect(consolidate(vault, { now: NOW + 2000, isClient: () => false }).domains).toEqual([]);
    expect(consolidate(vault, { now: NOW + DAY + 2000, isClient: () => false }).domains).toEqual(["insurance"]);
    expect(consolidate(vault, { now: NOW + 3 * DAY, isClient: () => false }).domains).toEqual([]);
    // Manual runs ignore the daily gate.
    touch("insurance", "legal", "Hearing moved", NOW + 3 * DAY);
    expect(consolidate(vault, { now: NOW + 3 * DAY + 1, force: true, domain: "insurance", isClient: () => false }).domains).toEqual(["insurance"]);
  });

  test("a client never consolidates", () => {
    touch("insurance", "realestate", "Claim open", NOW);
    const r = consolidate(vault, { now: NOW, isClient: () => true });
    expect(r.ok).toBe(false);
    expect(r.domains).toEqual([]);
    expect(existsSync(dom("insurance", "memory", "state.md"))).toBe(false);
  });

  test("replaceSection appends, replaces and clears", () => {
    expect(replaceSection("# A\n", "## X", "- 1")).toBe("# A\n\n## X\n\n- 1\n");
    expect(replaceSection("# A\n\n## X\n\n- old\n\n## Y\n\ny\n", "## X", "- new")).toBe("# A\n\n## X\n\n- new\n\n## Y\n\ny\n");
    expect(replaceSection("# A\n", "## X", "")).toBe("# A\n");
  });
});

describe("recommendation rule", () => {
  const touch = (fact: string, ts: number) =>
    recordTouch(vault, { home: "realestate", thread: `t-${ts}`, domains: [{ slug: "legal", confidence: 0.9, fact }], entities: [], fallbackFact: fact, ts });

  test("2+ lines newer than state.md, or one older than 3 days", () => {
    const state = dom("legal", "memory", "state.md");
    writeFileSync(state, "# State\n");
    utimesSync(state, new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    touch("Lawyer engaged", NOW - DAY);
    expect(catchUpCount(vault, "legal", NOW)).toBe(0);
    expect(catchUpCount(vault, "legal", NOW + 3 * DAY)).toBe(1);
    touch("Hearing set", NOW);
    expect(catchUpCount(vault, "legal", NOW)).toBe(2);
    // fromUpdates directly: a temp dir is not a scannable vault path, so the feed would see no domains.
    const recs = fromUpdates(vault, ["insurance", "legal"], NOW);
    expect(recs.map((r) => [r.title, r.action])).toEqual([["Catch Legal up: 2 updates from other domains", { kind: "open_domain", domain: "legal" }]]);
    // State written after the lines: caught up.
    utimesSync(state, new Date(NOW + 1000), new Date(NOW + 1000));
    expect(catchUpCount(vault, "legal", NOW + 2000)).toBe(0);
  });
});

test("index list carries relation fields for the CLI", () => {
  thread("realestate", "t2", "my tenant Zed Tenant moved out", "[Zed Tenant](prevail://person/Zed%20Tenant) left.");
  buildIndex(vault, { now: NOW });
  const e = readIndex(vault).entities.find((x) => x.id === "person/zed-tenant")!;
  expect(e).toMatchObject({ relation: "yours", home_domain: "realestate" });
  expect(typeof e.relation_confidence).toBe("number");
});

// Bug 2: "Also noted in" listed unrelated entities after a failed Gmail turn.
describe("touches come only from the user's words and the model's links", () => {
  const yours = [
    { id: "project/foo-herd", name: "Foo Herd", aliases: [] },
    { id: "place/foo-town", name: "Foo Town", aliases: [] },
    { id: "project/bar", name: "Bar", aliases: ["BQ"] },
    { id: "person/qux", name: "Qux Quxson", aliases: [] },
    { id: "person/zed", name: "Zed Zedson", aliases: [] },
    { id: "person/wim", name: "Wim Wimson", aliases: [] },
  ];

  test("regression: injected context blocks never produce touches", () => {
    const message = "# APP CONTEXT: Foo Mail\nApp id foo-mail. Foo Herd, Foo Town, Qux Quxson and Bar are mentioned here.\n\n---\n\n# REFERENCED DOMAIN: foo\nFoo Herd again.\n\n---\n\ncheck my unread email";
    expect(userText(message)).toBe("check my unread email");
    expect(touchedEntities(yours, message, "")).toEqual([]);
  });

  test("tool output and error text in the reply are never matched; only prevail:// links", () => {
    const reply = "Error: Foo Herd and Foo Town could not be reached (Qux Quxson).";
    expect(touchedEntities(yours, "check my unread email", reply)).toEqual([]);
    expect(touchedEntities(yours, "check my unread email", "See [Foo Town](prevail://place/Foo%20Town).")).toEqual(["place/foo-town"]);
  });

  test("short names (4 characters or fewer) match whole-word and case-sensitive", () => {
    expect(touchedEntities(yours, "the bar is open tonight", "")).toEqual([]);
    expect(touchedEntities(yours, "Barbara called about it", "")).toEqual([]);
    expect(touchedEntities(yours, "how is Bar going", "")).toEqual(["project/bar"]);
    expect(touchedEntities(yours, "the bq numbers", "")).toEqual([]);
    expect(touchedEntities(yours, "the BQ numbers", "")).toEqual(["project/bar"]);
    expect(touchedEntities(yours, "the foo herd grew", "")).toEqual(["project/foo-herd"]);
  });

  test("at most 4 entities per turn", () => {
    expect(TOUCH_MAX_ENTITIES).toBe(4);
    const all = "Foo Herd, Foo Town, Bar, Qux Quxson, Zed Zedson and Wim Wimson all came up";
    expect(touchedEntities(yours, all, "")).toHaveLength(4);
  });

  test("an error reply, or a turn whose tool calls all failed, records no touches", async () => {
    const base = { message: "check my unread email from the foo herd folks please", localOnly: false, incognito: false };
    expect(replyIsError("Claude requested permissions to use mcp__foo__search_threads, but you haven't granted it yet.")).toBe(true);
    expect(replyIsError("Error: the request failed.")).toBe(true);
    expect(replyIsError("")).toBe(true);
    expect(replyIsError("You have 3 unread emails from Foo, all about the herd.")).toBe(false);
    expect(touchSkipReason({ ...base, reply: "Error: the request failed." })).toBe("error reply");
    expect(touchSkipReason({ ...base, reply: "Three unread.", toolsAllFailed: true })).toBe("tool calls failed");
    let asked = 0;
    const classify = async (): Promise<TouchResult> => { asked++; return { domains: [{ slug: "legal", confidence: 1, fact: "x" }], entity_facts: {}, projects: ["project/foo-herd"], source: "model" }; };
    const step = { vault, home: "general", thread: "t", message: base.message, localOnly: false, incognito: false, classify };
    expect(await runTouchStep({ ...step, reply: "I couldn't read your email: permission was not granted." })).toBeNull();
    expect(await runTouchStep({ ...step, reply: "Three unread.", toolsAllFailed: true })).toBeNull();
    expect(asked).toBe(0);
    expect(existsSync(dom("legal", "memory", "updates.jsonl"))).toBe(false);
  });
});
