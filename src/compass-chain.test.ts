// The Compass chain (goals-plan.md G1b): the schema 2 migration, the tree and
// what is not linked, proposed links that need quotes, Today's walk, and the
// chat context carrying the chain. Invented people and goals only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compassBlock, compassJson, confirm, items, migrateCompass, parseCompass, readCompass, readLedger, serializeCompass } from "./compass.ts";
import { acceptLink, applyChainDraft, compassTree, declineLink, proposeCodeLinks, proposeLink, readLinks, walkUp, chainText } from "./compass-chain.ts";
import { createMission } from "./missions.ts";
import { composeToday } from "./today.ts";
import { tReadCompass } from "./mcp-server.ts";
import { jobCompass } from "./compass-align.ts";

const ROOT = join("/tmp", `prevail-chain-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const C = () => join(V, "build", "compass.md");
const NOW = Date.UTC(2026, 9, 2, 14);

const OLD = `# Compass

## Mission
Live a calm foo life.

## Values
- Peace of mind ~id:v-peace ~rank:1

## Goals
- [ ] Bar independence ~id:g-fi ~serves:v-peace ~status:active ~domain:money
  path: Foo buffer ~id:p-buffer ~status:chosen ~until:2027-06-30
    expect: twelve months in cash
  path: Foo equity ~id:p-equity ~status:proposed
`;

const CHAIN = `# Compass
~schema:2

## Purpose
Live a calm foo life.

## Values
- Peace of mind ~id:v-peace ~rank:1
- Family presence ~id:v-family ~rank:2

## Mission statement
- Build calm foo tools for families ~id:st-tools ~serves:v-peace,v-family

## Vision
- A foo home that runs on its own ~id:vi-home

## Objectives
- Twelve months of costs in cash ~id:o-cash ~metric:cash_months ~target:12 ~due:2028-12-31
- Weekly foo hikes with the kids ~id:o-hikes ~vision:vi-home

## Goals
- [ ] Bar cash buffer ~id:g-buffer ~objective:o-cash ~serves:v-peace ~status:active ~domain:money
  initiative: Automatic foo savings ~id:p-auto ~status:chosen ~until:2027-06-30
  initiative: Sell the bar boat ~id:p-boat ~status:proposed
- [ ] Hike the foo ridge with my son ~id:g-ridge ~serves:v-family ~status:active ~domain:family

## Roles
- Parent ~id:r-parent
`;

function seed(compass: string) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "money", "family"]) mkdirSync(join(D(d), "memory"), { recursive: true });
  mkdirSync(join(D("money"), "source"), { recursive: true });
  if (compass) writeFileSync(C(), compass);
}

describe("schema 2: the one-time migration", () => {
  beforeEach(() => seed(OLD));

  test("an old file: Mission becomes Purpose, path: becomes initiative:, ids kept, a snapshot first", () => {
    const r = migrateCompass(V, NOW);
    expect(r).toMatchObject({ migrated: true, renamedPurpose: true, initiatives: 2 });
    const t = readFileSync(C(), "utf8");
    expect(t.startsWith("# Compass\n~schema:2\n\n## Purpose\nLive a calm foo life.")).toBe(true);
    expect(t).toContain("  initiative: Foo buffer ~id:p-buffer ~status:chosen ~until:2027-06-30\n    expect: twelve months in cash");
    expect(t).not.toMatch(/^\s+path:/m);
    // Every other byte is the same: undo the three edits and it is the old file.
    expect(t.replace("~schema:2\n", "").replace("## Purpose", "## Mission").replace(/initiative:/g, "path:")).toBe(OLD);
    const versions = readdirSync(join(V, "build", "compass.versions"));
    expect(versions.length).toBe(1);
    expect(readFileSync(join(V, "build", "compass.versions", versions[0]!), "utf8")).toBe(OLD);
    expect(readLedger(V).at(-1)).toMatchObject({ id: "compass", from: "schema 1", to: "schema 2", by: "groom" });
    // The same goal and initiatives read back, with the same ids.
    const doc = readCompass(V);
    expect(items(doc, "goal")[0]!.paths.map((p) => p.id)).toEqual(["p-buffer", "p-equity"]);
  });

  test("idempotent: a second run changes nothing; a schema 2 file is never touched", () => {
    migrateCompass(V, NOW);
    const once = readFileSync(C(), "utf8");
    expect(migrateCompass(V, NOW + 1000).migrated).toBe(false);
    expect(readFileSync(C(), "utf8")).toBe(once);
    expect(readdirSync(join(V, "build", "compass.versions")).length).toBe(1);
    seed(CHAIN);
    expect(migrateCompass(V, NOW).migrated).toBe(false);
    expect(readFileSync(C(), "utf8")).toBe(CHAIN);
    expect(existsSync(join(V, "build", "compass.versions"))).toBe(false);
  });

  test("a file already on Purpose with no paths only gains ~schema:2; no file, nothing happens", () => {
    seed("# Compass\n\n## Purpose\nFoo.\n\n## Values\n- Calm ~id:v-calm\n");
    expect(migrateCompass(V, NOW)).toMatchObject({ migrated: true, renamedPurpose: false, initiatives: 0 });
    expect(readFileSync(C(), "utf8")).toBe("# Compass\n~schema:2\n\n## Purpose\nFoo.\n\n## Values\n- Calm ~id:v-calm\n");
    seed("");
    expect(migrateCompass(V, NOW).migrated).toBe(false);
    expect(existsSync(C())).toBe(false);
  });

  test("readers accept both: old path: lines and new initiative: lines parse the same; ## Mission in a schema 2 file is the mission statement", () => {
    const a = items(parseCompass(OLD), "goal")[0]!;
    const b = items(parseCompass(OLD.replace(/path:/g, "initiative:")), "goal")[0]!;
    expect(a.paths).toEqual(b.paths);
    const doc = parseCompass("# Compass\n~schema:2\n\n## Purpose\nFoo.\n\n## Mission\n- Make foo for bar ~id:st-x\n");
    expect(items(doc, "statement").map((x) => x.id)).toEqual(["st-x"]);
    expect(doc.sections.find((s) => s.kind === "mission")?.mission?.text).toBe("Foo.");
    // Untouched files round-trip byte for byte.
    expect(serializeCompass(parseCompass(CHAIN))).toBe(CHAIN);
  });
});

describe("the tree", () => {
  beforeEach(() => {
    seed(CHAIN);
    writeFileSync(join(D("money"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Set up the foo transfer @2026-10-02 ~id:t1 ~initiative:p-auto\n- [ ] Call the bar bank ~id:t2\n- [x] Done thing ~id:t3 ~initiative:p-auto\n");
    writeFileSync(join(D("money"), "source", "goals.md"), "# Goals\n\n- [ ] Pay off the foo card ~id:g-card ~objective:o-cash ~status:active\n- [ ] Learn bar taxes ~id:g-tax ~status:active\n");
  });

  test("every node with parents and children; implicit links; what is not linked per level", () => {
    createMission(V, { name: "Foo savings drive", path: "p-auto", domains: [{ slug: "money", role: "owner" }], now: NOW });
    createMission(V, { name: "Bar loose end", domains: [{ slug: "money", role: "owner" }], now: NOW });
    const t = compassTree(V);
    const n = (id: string) => t.nodes.find((x) => x.id === id)!;
    expect(n("v-peace").parents).toEqual(["purpose"]);
    expect(n("v-peace").implicit).toBe(true);
    expect(n("st-tools").parents).toEqual(["v-peace", "v-family"]);
    expect(n("vi-home")).toMatchObject({ parents: ["st-tools"], implicit: true });
    expect(n("o-cash")).toMatchObject({ parents: ["vi-home"], implicit: true, metric: "cash_months", target: "12" });
    expect(n("o-hikes")).toMatchObject({ parents: ["vi-home"], needs: ["metric"] });
    expect(n("g-buffer").parents).toEqual(["o-cash"]);
    expect(n("g-card")).toMatchObject({ parents: ["o-cash"], domain: "money" });
    expect(n("o-cash").children).toEqual(["g-buffer", "g-card"]);
    expect(n("p-auto")).toMatchObject({ parents: ["g-buffer"], mission: { slug: "foo-savings-drive", status: "active" } });
    expect(n("mission/foo-savings-drive").parents).toEqual(["p-auto"]);
    expect(n("p-auto").children).toEqual(["mission/foo-savings-drive", "task:money:t1"]);
    const nl = Object.fromEntries(t.levels.map((l) => [l.level, l.notLinked]));
    expect(nl).toMatchObject({ purpose: 0, value: 0, statement: 0, vision: 0, objective: 0, goal: 1, initiative: 0, mission: 1, task: 1 });
    expect(t.domainGoals).toEqual({ total: 2, linked: 1 });
    expect(t.tasks).toEqual({ open: 2, linked: 1 });
    // Walk up from the task: initiative, goal, objective, vision.
    expect(chainText(walkUp(t, "task:money:t1"))).toBe("Automatic foo savings > Bar cash buffer > Twelve months of costs in cash > A foo home that runs on its own");
    expect(chainText(walkUp(t, "mission/foo-savings-drive"))).toBe("Automatic foo savings > Bar cash buffer > Twelve months of costs in cash > A foo home that runs on its own");
  });

  test("confirmed only: proposed lines and proposed initiatives drop out of what chats and Today walk", () => {
    writeFileSync(C(), CHAIN.replace("~id:o-cash", "~id:o-cash ~status:proposed"));
    const t = compassTree(V, { confirmedOnly: true, tasks: false });
    expect(t.nodes.some((x) => x.id === "o-cash")).toBe(false);
    expect(t.nodes.some((x) => x.id === "p-boat")).toBe(false);
    expect(t.nodes.find((x) => x.id === "g-buffer")!.parents).toEqual([]);
  });

  test("Today names a task's chain in one line; MCP returns the tree; a job serves the objective too", async () => {
    const c = composeToday(V, { now: NOW, refresh: true });
    const it = c.items.find((x) => x.ref.id === "t1")!;
    expect(it.thread).toEqual(["Automatic foo savings", "Bar cash buffer", "Twelve months of costs in cash", "A foo home that runs on its own"]);
    expect(it.unlinked).toBe(false);
    const tree = JSON.parse(await tReadCompass({ format: "tree" }, V));
    expect(tree.levels.find((l: { level: string }) => l.level === "goal").notLinked).toBe(1);
    expect(JSON.parse(await tReadCompass({ format: "json" }, V)).tree.nodes.length).toBe(tree.nodes.length);
    expect(jobCompass(V, { ask: "foo", domains: { owner: "money", consulted: [] } }).serves.map((s) => s.title)).toEqual(["Bar cash buffer", "Twelve months of costs in cash", "A foo home that runs on its own", "Peace of mind"]);
  });
});

describe("links are proposed with quotes, never forced", () => {
  beforeEach(() => {
    seed(CHAIN);
    writeFileSync(join(D("money"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Turn on automatic foo savings transfer ~id:t9\n- [ ] Unrelated bar errand ~id:t8\n");
  });

  test("no quote, no link; an unknown end is refused; a duplicate is refused", () => {
    expect(proposeLink(V, { kind: "goal-objective", from: "g-ridge", to: "o-hikes", quote: "", source: "x", by: "code" })).toEqual({ ok: false, why: "a link needs the quote that suggests it" });
    expect(proposeLink(V, { kind: "goal-objective", from: "g-ridge", to: "o-nope", quote: "weekly hikes", source: "x", by: "code" })).toMatchObject({ ok: false });
    expect(proposeLink(V, { kind: "goal-objective", from: "g-buffer", to: "o-cash", quote: "already there", source: "x", by: "code" })).toEqual({ ok: false, why: "already linked" });
    const r = proposeLink(V, { kind: "goal-objective", from: "g-ridge", to: "o-hikes", quote: "hike the foo ridge", source: "notes", by: "bootstrap" });
    expect(r.ok).toBe(true);
    expect(proposeLink(V, { kind: "goal-objective", from: "g-ridge", to: "o-hikes", quote: "again", source: "notes", by: "bootstrap" })).toEqual({ ok: false, why: "already proposed" });
    // Proposed is not linked: the tree still says so.
    expect(compassTree(V).nodes.find((n) => n.id === "g-ridge")!.parents).toEqual([]);
  });

  test("accept writes the token (versioned, ledger); decline is remembered", () => {
    const r = proposeLink(V, { kind: "goal-objective", from: "g-ridge", to: "o-hikes", quote: "hike the foo ridge", source: "notes", by: "bootstrap" });
    if (!r.ok) throw new Error(r.why);
    expect(acceptLink(V, r.link.id, NOW)).toEqual({ ok: true });
    expect(readFileSync(C(), "utf8")).toContain("- [ ] Hike the foo ridge with my son ~id:g-ridge ~serves:v-family ~status:active ~domain:family ~objective:o-hikes");
    expect(readLedger(V).at(-1)).toMatchObject({ id: "g-ridge", to: "objective o-hikes", evidence: ["hike the foo ridge"] });
    expect(acceptLink(V, r.link.id).ok).toBe(false);
    expect(compassTree(V).levels.find((l) => l.level === "goal")!.notLinked).toBe(0);
  });

  test("code proposes goal-to-objective and task-to-initiative links from shared words, quoting the line", () => {
    const got = proposeCodeLinks(V, NOW);
    expect(got.map((l) => `${l.kind}:${l.from}>${l.to}`)).toEqual(["goal-objective:g-ridge>o-hikes", "task-initiative:task:money:t9>p-auto"]);
    expect(got[1]!.quote).toBe("Turn on automatic foo savings transfer");
    // Proposing again finds nothing new; declining keeps it from coming back.
    expect(proposeCodeLinks(V, NOW)).toEqual([]);
    expect(declineLink(V, got[0]!.id)).toBe(true);
    expect(readLinks(V).find((l) => l.id === got[0]!.id)!.status).toBe("declined");
    // Accepting the task link puts ~initiative: on that one line; the task now walks the chain.
    expect(acceptLink(V, got[1]!.id, NOW).ok).toBe(true);
    const board = readFileSync(join(D("money"), "memory", "tasks.md"), "utf8");
    expect(board).toContain("- [ ] Turn on automatic foo savings transfer ~id:t9 ~initiative:p-auto\n- [ ] Unrelated bar errand ~id:t8\n");
    expect(chainText(walkUp(compassTree(V), "task:money:t9"))).toContain("Automatic foo savings > Bar cash buffer");
  });

  test("a chain draft lands as proposed lines only with quotes from the notes; its links need quotes too", () => {
    seed("# Compass\n~schema:2\n\n## Values\n- Calm ~id:v-calm ~rank:1\n\n## Goals\n- [ ] Foo buffer ~id:g-buf ~status:active\n");
    const sources = [{ path: "build/ideal-state.md", text: "We build calm foo tools for families. One day a foo home that runs on its own. Twelve months of costs in cash by 2028." }];
    const r = applyChainDraft(V, {
      statements: [{ title: "Calm foo tools for families", quote: "We build calm foo tools for families.", serves: ["v-calm", "v-nope"] }],
      visions: [{ title: "Foo home that runs on its own", quote: "One day a foo home that runs on its own." }, { title: "Galactic empire", quote: "Rule the galaxy" }],
      objectives: [{ title: "Twelve months of costs in cash", quote: "Twelve months of costs in cash by 2028.", metric: "cash_months", target: "12", due: "2028-12-31" }, { title: "Costs in cash", quote: "x", metric: "made_up" }],
      links: [{ goal: "g-buf", objective: "Twelve months of costs in cash", quote: "Twelve months of costs in cash" }, { goal: "g-buf", objective: "Twelve months of costs in cash", quote: "invented words" }],
    }, sources, "model", { metrics: ["cash_months"], now: NOW });
    expect(r.added.map((a) => `${a.kind}:${a.title}`)).toEqual(["statement:Calm foo tools for families", "vision:Foo home that runs on its own", "objective:Twelve months of costs in cash"]);
    expect(r.rejected.map((x) => x.why)).toEqual(["quote not found in the user's notes", "quote not found in the user's notes", "quote not found in the user's notes"]);
    const j = compassJson(V);
    expect(j.statements[0]).toMatchObject({ status: "proposed", tokens: { serves: "v-calm" } });
    expect(j.visions[0]!.tokens.statement).toBe(j.statements[0]!.id);
    expect(j.objectives[0]!.tokens).toMatchObject({ vision: j.visions[0]!.id, metric: "cash_months", target: "12", due: "2028-12-31" });
    expect(r.links.map((l) => `${l.from}>${l.to}:${l.status}`)).toEqual([`g-buf>${j.objectives[0]!.id}:proposed`]);
    // Proposed lines never reach a chat until confirmed.
    expect(compassBlock(V)).not.toContain("Twelve months");
  });
});

describe("chat context carries the chain for confirmed lines", () => {
  test("snapshot of the # COMPASS block with the chain", () => {
    seed(CHAIN);
    confirm(V, "all");
    writeFileSync(C(), readFileSync(C(), "utf8").replace("~id:g-ridge", "~id:g-ridge ~objective:o-hikes"));
    expect(compassBlock(V)).toMatchSnapshot();
  });
});
