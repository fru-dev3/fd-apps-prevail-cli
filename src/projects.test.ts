import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, readIndex, searchEntities, setRelation, summarize } from "./entities.ts";
import { runTouchStep } from "./linking.ts";
import { createProject, parseGoalLine, projectDetail, projectGoals, setProject } from "./projects.ts";
import { buildRecommendations } from "./recommendations.ts";
import { parseTouchReply, type TouchOptions, type TouchResult } from "./route.ts";
import { acceptSuggestion, candidateSuggestions, dismissSuggestion, readDecisions, suggestStructure, NOT_NOW_DAYS } from "./structure.ts";

// Projects and structure suggestions. No model is ever called: every
// classifier here is a stand-in. Invented names only.
let vault: string;
let cfgDir: string;
let savedCfg: string | undefined;
const NOW = Date.parse("2026-09-20T12:00:00Z");
const DAY = 864e5;
const DOMAINS = ["general", "hobbies", "travel"];

const dom = (...p: string[]) => join(vault, "data", "domains", ...p);
const projDir = (slug: string) => join(vault, "data", "entities", "projects", slug);
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const unhomedFile = () => join(vault, "build", "_meta", "linking", "unhomed.jsonl");

function makeVault(root: string) {
  mkdirSync(join(root, "build"), { recursive: true });
  for (const d of DOMAINS) {
    mkdirSync(join(root, "data", "domains", d, "memory"), { recursive: true });
    writeFileSync(join(root, "data", "domains", d, "manifest.json"), JSON.stringify({ identity: { name: d, summary: `the ${d} area` } }));
    writeFileSync(join(root, "data", "domains", d, ".prevail-layout-v4"), "");
  }
}

function unhomed(rows: { ts: number; thread: string; label: string; fact?: string; home?: string; effort?: boolean }[]) {
  mkdirSync(join(vault, "build", "_meta", "linking"), { recursive: true });
  writeFileSync(unhomedFile(), rows.map((r) => JSON.stringify({ home: "general", fact: `${r.label} fact in ${r.thread}`, ...r })).join("\n") + "\n");
}

function intent(projects: { slug: string; title: string; domain: string; status?: string }[], sittings: Record<string, number>) {
  const meta = join(vault, "build", "_meta");
  mkdirSync(join(meta, "projects"), { recursive: true });
  writeFileSync(join(meta, "projects.json"), JSON.stringify({
    generated_ts: NOW, model: "stub", stats: {}, months: {}, recommendations: [], recommendations_model: "",
    projects: projects.map((p) => ({ status: "active", prompt_count: 10, first_ts: NOW - 20 * DAY, last_ts: NOW - DAY, ...p })),
  }));
  const sessions: Record<string, string> = {};
  for (const [slug, n] of Object.entries(sittings)) for (let i = 0; i < n; i++) sessions[`claude:${slug}-${i}`] = slug;
  writeFileSync(join(meta, "projects", "state.json"), JSON.stringify({ version: 1, catalog: [], catalog_model: "", sessions, packs: {} }));
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-projects-"));
  cfgDir = mkdtempSync(join(tmpdir(), "prevail-projects-cfg-"));
  savedCfg = process.env.PREVAIL_CONFIG_DIR;
  process.env.PREVAIL_CONFIG_DIR = cfgDir;
  makeVault(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
  if (savedCfg === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = savedCfg;
});

describe("projects: CRUD and the folder", () => {
  test("create writes the entity folder with the project frontmatter; it lists as a yours project", () => {
    const p = createProject(vault, { name: "Foo Trip", outcome: "Back home with photos: done", target: "2026-12-01", domains: ["travel", "Hobbies"], now: NOW });
    expect(p).toMatchObject({ id: "project/foo-trip", kind: "project", name: "Foo Trip", status: "active", outcome: "Back home with photos: done", target: "2026-12-01", domains: ["travel", "hobbies"], goals: [], relation: "yours", saved: true });
    const md = readFileSync(join(projDir("foo-trip"), "entity.md"), "utf8");
    expect(md).toContain("kind: project");
    expect(md).toContain("status: active");
    expect(md).toContain("domains: [travel, hobbies]");
    expect(md).toContain("target: 2026-12-01");

    const listed = searchEntities(readIndex(vault), "", { kind: "project" }).map((e) => summarize(e, vault));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "project/foo-trip", status: "active", target: "2026-12-01", domains: ["travel", "hobbies"], relation: "yours" });

    // Always yours, even against an override.
    setRelation(vault, "project/foo-trip", "reference");
    expect(buildIndex(vault).entities.find((e) => e.id === "project/foo-trip")!.relation).toBe("yours");
  });

  test("set edits fields; archive is a status and nothing is deleted; bad input is refused", () => {
    createProject(vault, { name: "Bar Build", now: NOW });
    const p = setProject(vault, "project/bar-build", { status: "paused", outcome: "A working bar", target: "2027-01-31", domains: ["hobbies"] });
    expect(p).toMatchObject({ status: "paused", outcome: "A working bar", target: "2027-01-31", domains: ["hobbies"] });
    const cleared = setProject(vault, "bar-build", { target: "", domains: [] });
    expect(cleared.target).toBeUndefined();
    expect(cleared.domains).toEqual([]);
    expect(setProject(vault, "project/bar-build", { status: "archived" }).status).toBe("archived");
    expect(existsSync(join(projDir("bar-build"), "entity.md"))).toBe(true);
    expect(projectDetail(vault, "project/bar-build")!.outcome).toBe("A working bar");

    expect(() => setProject(vault, "project/bar-build", { status: "gone" })).toThrow(/status must be/);
    expect(() => setProject(vault, "project/bar-build", { target: "soon" })).toThrow(/YYYY-MM-DD/);
    expect(() => setProject(vault, "project/bar-build", { domains: ["nowhere"] })).toThrow(/no domain "nowhere"/);
    expect(() => setProject(vault, "project/nope", { status: "done" })).toThrow(/no project/);
    expect(() => setProject(vault, "person/bar-build", { status: "done" })).toThrow(/not a project/);
    expect(() => createProject(vault, { name: "Bar Build" })).toThrow(/already exists/);
  });

  test("an Intent project is tracked once", () => {
    const p = createProject(vault, { name: "Qux App", fromIntent: "qux-app", now: NOW });
    expect(p.intent_project).toBe("qux-app");
    expect(() => createProject(vault, { name: "Qux App Two", fromIntent: "qux-app" })).toThrow(/already tracked as project\/qux-app/);
  });
});

describe("projects: touches and updates", () => {
  const MSG = "Booked the ferry for the Foo Trip and the bar build needs a new saw blade.";
  test("the classifier's active projects and named projects get update lines; paused ones never; unhomed topics are recorded", async () => {
    createProject(vault, { name: "Foo Trip", outcome: "Visit the islands", now: NOW });
    createProject(vault, { name: "Bar Build", now: NOW });
    setProject(vault, "project/bar-build", { status: "paused" });
    let seen: TouchOptions | null = null;
    const classify = async (o: TouchOptions): Promise<TouchResult> => {
      seen = o;
      return {
        domains: [{ slug: "travel", confidence: 0.9, fact: "Ferry booked" }], entity_facts: { "project/foo-trip": "Ferry booked for the trip" },
        projects: ["project/foo-trip", "project/bar-build"], unhomed: [{ label: "woodworking", fact: "Needs a saw blade", effort: false }], source: "model",
      };
    };
    const r = await runTouchStep({ vault, home: "general", thread: "t-1", message: MSG, reply: "ok", localOnly: false, incognito: false, classify, now: NOW });
    expect(seen!.projects!.map((p) => p.id)).toEqual(["project/foo-trip"]);
    expect(seen!.projects![0]!.outcome).toBe("Visit the islands");
    expect(r!.entities).toEqual(["project/foo-trip"]);
    expect(lines(join(projDir("foo-trip"), "updates.jsonl"))).toEqual([{ ts: NOW, from_domain: "general", thread: "t-1", fact: "Ferry booked for the trip" }]);
    expect(existsSync(join(projDir("bar-build"), "updates.jsonl"))).toBe(false);
    expect(lines(unhomedFile())).toEqual([{ ts: NOW, thread: "t-1", home: "general", label: "woodworking", fact: "Needs a saw blade" }]);
  });

  test("a turn that only has a topic with no home still records it", async () => {
    const classify = async (): Promise<TouchResult> => ({ domains: [], entity_facts: {}, unhomed: [{ label: "pets", fact: "Adopting a cat", effort: false }], source: "model" });
    expect(await runTouchStep({ vault, home: "general", thread: "t-2", message: "We are adopting a cat next month, what do we need?", reply: "ok", localOnly: false, incognito: false, classify, now: NOW })).toBeNull();
    expect(lines(unhomedFile()).map((l) => l.label)).toEqual(["pets"]);
  });

  test("the reply parser keeps listed projects and new labels only", () => {
    const r = parseTouchReply(JSON.stringify({
      domains: [], entity_facts: {}, projects: ["project/foo-trip", "project/unknown", "project/foo-trip"],
      unhomed: [{ label: "Pets", fact: "Cat", effort: false }, { label: "travel", fact: "a domain already" }, { label: "pets", fact: "dupe" }, { label: "boats", fact: "Sail", effort: true }, { label: "third", fact: "over the cap" }],
    }), ["travel"], [], ["project/foo-trip"]);
    expect(r!.projects).toEqual(["project/foo-trip"]);
    expect(r!.unhomed).toEqual([{ label: "pets", fact: "Cat" }, { label: "boats", fact: "Sail", effort: true }]);
  });
});

describe("projects: goals", () => {
  test("goal lines with ~project: link to the project from any domain", () => {
    createProject(vault, { name: "Foo Trip", now: NOW });
    mkdirSync(dom("travel", "source"), { recursive: true });
    writeFileSync(dom("travel", "source", "goals.md"), "# Goals\n\n- [ ] Book the ferry ~id:g-1 ~status:active ~project:foo-trip\n  why: to get there\n- [x] Pack a bag ~project:foo-trip\n- [ ] Unrelated ~id:g-3\n");
    writeFileSync(dom("hobbies", "goals.md"), "- [ ] Film the trip ~status:archived ~project:foo-trip\n");
    expect(parseGoalLine("- [x] Pack a bag ~project:foo-trip")).toEqual({ title: "Pack a bag", status: "done", tokens: { project: "foo-trip" } });
    expect(parseGoalLine("why: nope")).toBeNull();
    const goals = projectGoals(vault, "foo-trip");
    expect(goals).toContainEqual({ title: "Book the ferry", status: "active", domain: "travel", id: "g-1" });
    expect(goals).toContainEqual({ title: "Pack a bag", status: "done", domain: "travel" });
    expect(goals).toContainEqual({ title: "Film the trip", status: "archived", domain: "hobbies" });
    expect(goals).toHaveLength(3);
    expect(projectDetail(vault, "project/foo-trip")!.goals).toHaveLength(3);
  });
});

describe("structure suggestions: the rules", () => {
  test("new domain: the same label in 3+ distinct conversations within 30 days", () => {
    unhomed([
      { ts: NOW - 1 * DAY, thread: "a", label: "Pets" },
      { ts: NOW - 2 * DAY, thread: "a", label: "pets" }, // same conversation: counts once
      { ts: NOW - 3 * DAY, thread: "b", label: "pets" },
      { ts: NOW - 40 * DAY, thread: "c", label: "pets" }, // outside the window
      { ts: NOW - 1 * DAY, thread: "x", label: "travel" }, // a domain already
      { ts: NOW - 2 * DAY, thread: "y", label: "travel" },
      { ts: NOW - 3 * DAY, thread: "z", label: "travel" },
    ]);
    expect(candidateSuggestions(vault, NOW).filter((s) => s.kind === "domain")).toEqual([]);
    unhomed([
      { ts: NOW - 1 * DAY, thread: "a", label: "pets" },
      { ts: NOW - 3 * DAY, thread: "b", label: "pets" },
      { ts: NOW - 10 * DAY, thread: "c", label: "pets", home: "hobbies" },
    ]);
    const [s] = suggestStructure(vault, NOW).filter((x) => x.kind === "domain");
    expect(s).toEqual({
      id: "domain:pets", kind: "domain", title: "Create a Pets domain?", reason: "3 conversations about pets since Sep 10",
      evidence: [{ thread: "a", ts: NOW - DAY, domain: "general" }, { thread: "b", ts: NOW - 3 * DAY, domain: "general" }, { thread: "c", ts: NOW - 10 * DAY, domain: "hobbies" }],
      confidence: 0.7,
    });
    // 30 days later the window has moved on.
    expect(suggestStructure(vault, NOW + 30 * DAY).filter((x) => x.kind === "domain")).toEqual([]);
  });

  test("new project: an effort topic, or an Intent project with 3+ sittings and no project entity", () => {
    unhomed(["a", "b", "c"].map((thread, i) => ({ ts: NOW - i * DAY, thread, label: "boat build", effort: true })));
    intent([
      { slug: "qux-app", title: "Qux App", domain: "hobbies" },
      { slug: "two-sits", title: "Two Sits", domain: "hobbies" },
      { slug: "finished", title: "Finished", domain: "hobbies", status: "done" },
      { slug: "tracked", title: "Tracked", domain: "hobbies" },
      { slug: "bad slug?", title: "Bad", domain: "hobbies" }, // an id the desktop would refuse: never suggested
    ], { "qux-app": 3, "two-sits": 2, finished: 5, tracked: 4, "bad slug?": 6 });
    createProject(vault, { name: "Already", fromIntent: "tracked", now: NOW });
    const got = suggestStructure(vault, NOW).filter((s) => s.kind === "project");
    expect(got.map((s) => s.id).sort()).toEqual(["project:intent:qux-app", "project:topic:boat-build"]);
    expect(got.find((s) => s.id === "project:intent:qux-app")).toMatchObject({ title: "Track Qux App as a project?", reason: "3 sittings in your prompts since Aug 31", evidence: [{ ts: NOW - DAY, domain: "hobbies" }] });
    expect(got.find((s) => s.id === "project:topic:boat-build")!.title).toBe("Track Boat Build as a project?");
  });

  test("archive: a domain with no threads, touches or updates in 365 days; never General", () => {
    const now = Date.now() + 400 * DAY;
    // travel had a thread 10 days before "now"; hobbies has had nothing.
    mkdirSync(dom("travel", "memory", "threads"), { recursive: true });
    writeFileSync(dom("travel", "memory", "threads", "t.md"), "---\ntitle: t\n---\n");
    utimesSync(dom("travel", "memory", "threads", "t.md"), (now - 10 * DAY) / 1000, (now - 10 * DAY) / 1000);
    const got = suggestStructure(vault, now).filter((s) => s.kind === "archive_domain");
    expect(got.map((s) => s.id)).toEqual(["archive:hobbies"]);
    expect(got[0]!.title).toBe("Archive Hobbies?");
    // An update line from elsewhere keeps a domain alive too.
    mkdirSync(dom("hobbies", "memory"), { recursive: true });
    writeFileSync(dom("hobbies", "memory", "updates.jsonl"), `${JSON.stringify({ ts: now - DAY, from_domain: "general", thread: "x", fact: "f", entities: [] })}\n`);
    expect(suggestStructure(vault, now).filter((s) => s.kind === "archive_domain")).toEqual([]);
  });
});

describe("structure suggestions: accept and dismiss", () => {
  test("accept a domain: created through the domain path and backfilled from the evidence conversations", async () => {
    unhomed([
      { ts: NOW - 3 * DAY, thread: "a", label: "pets", fact: "Adopting a cat" },
      { ts: NOW - 2 * DAY, thread: "b", label: "pets", fact: "Vet visit booked", home: "hobbies" },
      { ts: NOW - 1 * DAY, thread: "c", label: "pets", fact: "Cat food brand picked" },
    ]);
    const r = await acceptSuggestion(vault, "domain:pets", { now: NOW });
    expect(r).toMatchObject({ ok: true, id: "domain:pets", kind: "domain", domain: "pets", backfilled: 3 });
    expect(existsSync(dom("pets", "memory", "state.md"))).toBe(true);
    expect(lines(dom("pets", "memory", "updates.jsonl"))).toEqual([
      { ts: NOW - 3 * DAY, from_domain: "general", thread: "a", fact: "Adopting a cat", entities: [] },
      { ts: NOW - 2 * DAY, from_domain: "hobbies", thread: "b", fact: "Vet visit booked", entities: [] },
      { ts: NOW - 1 * DAY, from_domain: "general", thread: "c", fact: "Cat food brand picked", entities: [] },
    ]);
    expect(readDecisions(vault).accepted).toEqual(["domain:pets"]);
    expect(suggestStructure(vault, NOW)).toEqual([]);
    await expect(acceptSuggestion(vault, "domain:pets", { now: NOW })).rejects.toThrow(/no suggestion/);
  });

  test("accept a project: the project entity, linked to its Intent project", async () => {
    intent([{ slug: "qux-app", title: "Qux App", domain: "hobbies" }], { "qux-app": 4 });
    const r = await acceptSuggestion(vault, "project:intent:qux-app", { now: NOW });
    expect(r).toMatchObject({ ok: true, kind: "project", project: { id: "project/qux-app", intent_project: "qux-app", domains: ["hobbies"], status: "active" } });
    expect(existsSync(join(projDir("qux-app"), "entity.md"))).toBe(true);
    expect(suggestStructure(vault, NOW).filter((s) => s.kind === "project")).toEqual([]);
  });

  test("accept an archive: the domain moves through the archive path and nothing is deleted", async () => {
    // Manifest writes refuse system paths like /var, so this vault lives under home.
    const home = mkdtempSync(join(homedir(), ".prevail-structure-test-"));
    makeVault(home);
    writeFileSync(join(home, "data", "domains", "hobbies", "memory", "memory.md"), "keep me\n");
    let backup = "";
    try {
      const r = await acceptSuggestion(home, "archive:hobbies", { now: Date.now() + 400 * DAY });
      expect(r).toMatchObject({ ok: true, kind: "archive_domain", domain: "hobbies" });
      backup = r.kind === "archive_domain" ? r.backup : "";
      expect(existsSync(join(home, "data", "domains", "hobbies"))).toBe(false);
      expect(readFileSync(join(home, "data", "domains", "_archive", "hobbies", "memory", "memory.md"), "utf8")).toBe("keep me\n");
      expect(existsSync(backup)).toBe(true);
    } finally {
      if (backup) rmSync(backup, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("not now hides for 30 days; never hides for good", () => {
    unhomed(["a", "b", "c"].map((thread) => ({ ts: NOW - DAY, thread, label: "pets" })));
    const r = dismissSuggestion(vault, "domain:pets", { now: NOW });
    expect(r).toEqual({ ok: true, id: "domain:pets", until: NOW + NOT_NOW_DAYS * DAY });
    expect(suggestStructure(vault, NOW)).toEqual([]);
    expect(suggestStructure(vault, NOW + NOT_NOW_DAYS * DAY - DAY)).toEqual([]);
    // Back after the 30 days (rows re-dated so the 30-day window still holds them).
    const later = NOW + NOT_NOW_DAYS * DAY + DAY;
    unhomed(["a", "b", "c"].map((thread) => ({ ts: later - DAY, thread, label: "pets" })));
    expect(suggestStructure(vault, later).map((s) => s.id)).toEqual(["domain:pets"]);
    dismissSuggestion(vault, "domain:pets", { forever: true, now: later });
    expect(readDecisions(vault).dismissed).toEqual([{ id: "domain:pets" }]);
    expect(suggestStructure(vault, later + 1000 * DAY).filter((x) => x.kind === "domain")).toEqual([]);
    expect(JSON.parse(readFileSync(join(vault, "data", "suggestions.json"), "utf8"))).toEqual({ accepted: [], dismissed: [{ id: "domain:pets" }] });
  });

  test("pending suggestions appear in the recommendations feed under structure", () => {
    unhomed(["a", "b", "c"].map((thread) => ({ ts: NOW - DAY, thread, label: "pets" })));
    const recs = buildRecommendations(vault, { now: NOW, skip: { intent: true, projects: true, stuck: true, apps: true, entities: true, context: true, updates: true, domains: true, models: true } });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: "structure:domain:pets", category: "structure", source: "structure", title: "Create a Pets domain?",
      metric: { value: 3, unit: "conversations" }, action: { kind: "structure_suggestion", id: "domain:pets" },
    });
    dismissSuggestion(vault, "domain:pets", { now: NOW });
    expect(buildRecommendations(vault, { now: NOW, skip: { intent: true, projects: true, stuck: true, apps: true, entities: true, context: true, updates: true, domains: true, models: true } })).toEqual([]);
  });
});
