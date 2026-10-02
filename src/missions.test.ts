import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { gateAction } from "./broker.ts";
import { missionGate } from "./act-gate.ts";
import { applyCloseout, planCloseout, readReceipts, undoCloseout } from "./closeout.ts";
import { runChatJson } from "./chat-json.ts";
import type { ChatTurn } from "./cli-bridge.ts";
import { buildUserContext } from "./cli-bridge.ts";
import { dispatch, missionDraftFrom, runJob, saveJob, readReceipts as jobReceipts, undoFiled } from "./jobs.ts";
import {
  attach, checkMilestones, createMission, linkEvent, listMissions, migrateProjects, milestone, missionTasks, missionView,
  parseMission, readMission, renamePurposeHeading, serializeMission, setBudgetLine, spend, transition,
} from "./missions.ts";
import { resolveScope } from "./scope.ts";

// Missions, end to end in code. Invented missions, domains and people only;
// no model is ever called (every runner is a stand-in).
const ROOT = join("/tmp", `prevail-missions-${process.pid}`);
const V = join(ROOT, "vault");
const D = (d: string) => join(V, "data", "domains", d);
const M = (s: string) => join(V, "data", "missions", s);
const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY = 864e5;
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const read = (p: string) => readFileSync(p, "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])) : []);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "hobbies", "money", "family", "taxes", "secrets"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state for ${d}.\n`);
  }
  writeFileSync(join(D("hobbies"), "memory", "memory.md"), "# Hobbies\nWeekend practice sticks.\n");
  writeFileSync(join(D("hobbies"), "ideal-state.md"), "Play music every week.\n");
  writeFileSync(join(V, "build", "chief-of-staff.md"), "---\nname: Foo\n---\n## Limits\n- usd: 1\n- minutes: 10\n\n## Never pull in\n- secrets\n");
  writeFileSync(join(V, "build", "compass.md"), "# Compass\n\n## Mission\nMake things that last.\n\n## Values\n- Craft ~id:v-craft ~rank:1\n");
}

const cello = () => createMission(V, {
  name: "Learn the cello", outcome: "Play three pieces for the family by June", target: "2027-06-30", start: "2026-10-01",
  domains: [{ slug: "hobbies", role: "owner" }, { slug: "money", role: "consulted" }, { slug: "family", role: "informed" }],
  apps: ["paint-shop"], specialists: ["researcher", "scout"], people: ["person/tutor-example"], budgetUsd: 1500,
  milestones: [{ title: "Instrument at home", due: "2026-10-05" }, { title: "Term one finished", due: "2026-12-15", weight: 2 }],
  now: NOW,
});

describe("the store", () => {
  beforeEach(seed);
  test("create writes the folder; roles, budget and milestones read back", () => {
    const v = cello();
    expect(v).toMatchObject({ id: "mission/learn-the-cello", status: "active", target: "2027-06-30", ceiling: "draft" });
    expect(v.domains).toEqual([{ slug: "hobbies", role: "owner" }, { slug: "money", role: "consulted" }, { slug: "family", role: "informed" }]);
    for (const f of ["mission.md", "milestones.md", "links.json", "memory/state.md", "memory/memory.md", "memory/log.md", ".prevail-layout-v4"]) expect(existsSync(join(M("learn-the-cello"), f))).toBe(true);
    expect(v.progress.milestones).toMatchObject({ done: 0, total: 2 });
    expect(v.progress.days).toEqual({ day: 2, total: 273, left: 271 });
    // Round trip keeps the user's notes and unknown sections.
    const m = readMission(V, "learn-the-cello")!;
    m.notes = "Bring rosin."; m.rest = "## Extra\nkept";
    expect(parseMission(serializeMission(m), m.slug)).toMatchObject({ notes: "Bring rosin.", rest: "## Extra\nkept", budget: { total_usd: 1500 } });
    expect(() => cello()).toThrow(/already exists/);
    expect(() => createMission(V, { name: "Bad", domains: [{ slug: "nowhere", role: "owner" }] })).toThrow(/no domain "nowhere"/);
    expect(() => createMission(V, { name: "Bad two", target: "soon" })).toThrow(/YYYY-MM-DD/);
  });

  test("no target: one is proposed; one owner only", () => {
    const v = createMission(V, { name: "Paint the shed", domains: [{ slug: "hobbies", role: "owner" }, { slug: "family", role: "owner" }], now: NOW });
    expect(v.target).toBe("2026-12-31");
    expect(v.domains.filter((d) => d.role === "owner").map((d) => d.slug)).toEqual(["family"]);
  });

  test("milestones, the ledger (a charge counts once), checks and events", () => {
    cello();
    milestone(V, "learn-the-cello", "done", { title: "Instrument at home" }, NOW);
    setBudgetLine(V, "learn-the-cello", "lessons", 800, "Lessons");
    expect(spend(V, "learn-the-cello", { line: "lessons", usd: 120, what: "Term one fee", ref: "plaid:txn-foo" }, NOW).added).toBe(true);
    expect(spend(V, "learn-the-cello", { line: "lessons", usd: 120, what: "Term one fee again", ref: "plaid:txn-foo" }, NOW).added).toBe(false);
    milestone(V, "learn-the-cello", "add", { title: "Ten lessons", check: "m-lessons>=10" }, NOW);
    expect(checkMilestones(V, "learn-the-cello", () => 4, NOW)).toEqual([]);
    expect(checkMilestones(V, "learn-the-cello", () => 10, NOW).map((x) => x.title)).toEqual(["Ten lessons"]);
    linkEvent(V, "learn-the-cello", { title: "Lesson", start: "2026-10-04T10:00", event: "ev-1" }, NOW);
    const v = missionView(V, "learn-the-cello", NOW)!;
    expect(v.progress.budget).toMatchObject({ planned: 1500, used: 120 });
    expect(v.progress.budget.byLine).toEqual([{ id: "lessons", label: "Lessons", planned: 800, used: 120 }]);
    expect(v.progress.milestones).toMatchObject({ done: 2, total: 3, share: 0.5 });
    expect(v.links.calendar.map((e) => e.event)).toEqual(["ev-1"]);
    expect(read(join(M("learn-the-cello"), "memory", "log.md"))).toContain("Spent $120.00 on lessons");
  });

  test("lifecycle: four states, reopen keeps the old close-out, nothing moves", () => {
    cello();
    expect(transition(V, "learn-the-cello", "pause", { now: NOW }).status).toBe("paused");
    expect(() => transition(V, "learn-the-cello", "pause", { now: NOW })).toThrow(/cannot pause/);
    expect(transition(V, "learn-the-cello", "resume", { now: NOW }).status).toBe("active");
    expect(transition(V, "learn-the-cello", "archive", { now: NOW }).status).toBe("archived");
    writeFileSync(join(M("learn-the-cello"), "closeout.md"), "old");
    const r = transition(V, "learn-the-cello", "reopen", { target: "2027-09-01", now: NOW });
    expect(r).toMatchObject({ status: "active", target: "2027-09-01" });
    expect(existsSync(join(M("learn-the-cello"), "closeout.md"))).toBe(false);
    expect(readdirSync(M("learn-the-cello")).some((f) => /^closeout-\d{4}-\d{2}-\d{2}\.md$/.test(f))).toBe(true);
    expect(listMissions(V).map((m) => m.slug)).toEqual(["learn-the-cello"]);
  });

  test("tasks: the mission's own and ~mission: lines in any domain", () => {
    cello();
    writeFileSync(join(M("learn-the-cello"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Buy rosin ~id:t1\n");
    writeFileSync(join(D("money"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Pay the term fee @2026-10-10 ~mission:learn-the-cello ~id:t2\n- [ ] Unrelated ~id:t3\n");
    expect(missionTasks(V, "learn-the-cello").map((t) => [t.text, t.domain, t.due ?? null])).toEqual([["Buy rosin", "mission/learn-the-cello", null], ["Pay the term fee", "money", "2026-10-10"]]);
  });
});

describe("migration from entity projects", () => {
  beforeEach(seed);
  const project = (slug: string, fm: string, body = "") => {
    const dir = join(V, "data", "entities", "projects", slug);
    mkdirSync(join(dir, "files"), { recursive: true });
    writeFileSync(join(dir, "entity.md"), `---\nname: ${slug}\nkind: project\nstatus: ${fm}\ncreated: 2026-09-01T12:00:00Z\noutcome: "Done when foo"\ndomains: [hobbies, money]\nintent_project: "foo-app"\n---\n${body}`);
    writeFileSync(join(dir, "files", "plan.txt"), `plan for ${slug}`);
    writeFileSync(join(dir, "updates.jsonl"), `{"ts":1,"from_domain":"general","thread":"t","fact":"noted"}\n`);
  };

  test("carries every project over with nothing lost, backs up first, and a second run changes nothing", () => {
    project("kitchen-remodel", "active", "## What you've discussed\nTiles chosen.\n\n## Your notes\nKeep the old sink.\n");
    project("paint-the-shed", "done");
    // An existing mission is never overwritten.
    createMission(V, { name: "Paint the shed", now: NOW });
    const srcDir = join(V, "data", "entities", "projects");
    const before = Object.fromEntries(files(srcDir).map((p) => [relative(srcDir, p), sha(p)]));
    const dry = migrateProjects(V, { dryRun: true, backupDir: ROOT, now: NOW });
    expect(dry.migrated.map((m) => [m.slug, m.conflict])).toEqual([["kitchen-remodel", false], ["paint-the-shed", true]]);
    expect(existsSync(srcDir)).toBe(true);

    const r = migrateProjects(V, { backupDir: ROOT, now: NOW, threadsOf: (id) => (id === "project/kitchen-remodel" ? [{ domain: "general", slug: "t-old", title: "Tiles" }] : []) });
    expect(r.ok).toBe(true);
    expect(existsSync(r.backup!)).toBe(true);
    // The old folders, whole and unchanged, beside the merged ones.
    const archived = join(V, "data", "entities", "_migrated", "projects-2026-10-02");
    const after = Object.fromEntries(files(archived).filter((p) => !p.includes("_empty-projects-dir")).map((p) => [relative(archived, p), sha(p)]));
    expect(after).toEqual(before);
    const k = readMission(V, "kitchen-remodel")!;
    expect(k).toMatchObject({ status: "active", outcome: "Done when foo", start: "2026-09-01", notes: "Keep the old sink.", prompt_projects: ["foo-app"] });
    expect(k.domains).toEqual([{ slug: "hobbies", role: "owner" }, { slug: "money", role: "consulted" }]);
    expect(read(join(M("kitchen-remodel"), "memory", "memory.md"))).toContain("## From the old project page\nTiles chosen.");
    expect(sha(join(M("kitchen-remodel"), "files", "plan.txt"))).toBe(before["kitchen-remodel/files/plan.txt"]!);
    expect(read(join(M("kitchen-remodel"), "memory", "updates.jsonl"))).toContain("noted");
    expect(missionView(V, "kitchen-remodel")!.links.threads).toEqual([{ domain: "general", thread: "t-old", title: "Tiles" }]);
    expect(readdirSync(join(M("kitchen-remodel"), "memory")).some((f) => f.startsWith("migrated-"))).toBe(true);
    // The conflict stays beside; the existing page is untouched.
    expect(existsSync(join(M("paint-the-shed"), "mission.conflict.md"))).toBe(true);
    expect(readMission(V, "paint-the-shed")!.status).toBe("active");
    expect(parseMission(read(join(M("paint-the-shed"), "mission.conflict.md")), "paint-the-shed").status).toBe("completed");
    // Old ids resolve.
    expect(readMission(V, "project/kitchen-remodel")!.id).toBe("mission/kitchen-remodel");

    const snapshot = Object.fromEntries(files(join(V, "data")).map((p) => [p, sha(p)]));
    const again = migrateProjects(V, { backupDir: ROOT, now: NOW + DAY });
    expect(again.migrated).toEqual([]);
    expect(Object.fromEntries(files(join(V, "data")).map((p) => [p, sha(p)]))).toEqual(snapshot);
  });

  test("a vault with no projects is a no-op; the Compass heading becomes Purpose with a snapshot", async () => {
    expect(migrateProjects(V, { backupDir: ROOT })).toEqual({ ok: true, dryRun: false, migrated: [], skipped: [] });
    const r = await renamePurposeHeading(V, NOW);
    expect(r.renamed).toBe(true);
    expect(read(join(V, "build", "compass.md"))).toContain("## Purpose\nMake things that last.");
    expect(read(r.snapshot!)).toContain("## Mission\nMake things that last.");
    expect((await renamePurposeHeading(V, NOW)).renamed).toBe(false);
  });
});

describe("chat: one scope resolver", () => {
  beforeEach(seed);
  test("parity: a mission turn carries every block kind a domain turn has, and more", async () => {
    cello();
    const dom = await resolveScope(V, { domain: "hobbies" });
    const mis = await resolveScope(V, { mission: "learn-the-cello" });
    expect(mis).toMatchObject({ kind: "mission", key: "_mission-learn-the-cello", cwd: M("learn-the-cello"), appIds: ["paint-shop"] });
    const kinds = (s: typeof mis) => new Set(s.blocks.map((b) => b.source.split(":")[0]));
    for (const k of kinds(dom)) expect(kinds(mis).has(k)).toBe(true);
    for (const k of ["mission", "progress", "memory", "app", "entity"]) expect(kinds(mis).has(k)).toBe(true);
    const text = mis.blocks.map((b) => b.text).join("\n");
    expect(text).toContain("Owner domain: hobbies. Reads: money. Tells: family.");
    expect(text).toContain("Weekend practice sticks.");
    expect(text).toContain("## money state (consulted)");
    expect(text).not.toContain("Foo state for taxes");
    // The cwd-built blocks: the chief of staff's voice and the Compass, like General.
    const ctx = buildUserContext(V, mis.cwd, "hi");
    expect(ctx).toContain("# COMPASS");
    expect(mis.dispatch).toMatchObject({ allowed: true, defaultOwner: "mission/learn-the-cello", ceiling: "draft", budgetLeftUsd: 1500 });
  });

  test("privacy: a local-only attached domain makes the mission local-only", async () => {
    cello();
    writeFileSync(join(D("family"), "manifest.json"), JSON.stringify({ identity: { name: "family" }, privacy: { localOnly: true } }));
    expect((await resolveScope(V, { mission: "learn-the-cello" })).privacy.localOnly).toBe(true);
    const lines: string[] = [];
    const code = await runChatJson({ vaultPath: V, domain: "general", mission: "learn-the-cello", message: "How is it going?", write: (l) => lines.push(l), deps: { detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }], runChatTurn: async () => "never", persistMessage: () => {} } });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("local-only");
  });

  test("a mission chat stores its thread in the mission, and dispatch is scoped", async () => {
    cello();
    const turns: ChatTurn[] = [];
    const seen: unknown[] = [];
    const lines: string[] = [];
    const code = await runChatJson({
      vaultPath: V, domain: "general", mission: "learn-the-cello", message: "How many lessons are left this term?", sessionId: "t-cello",
      write: (l) => lines.push(l),
      deps: {
        detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
        runChatTurn: async (t: ChatTurn) => { turns.push(t); return "Six."; },
        persistMessage: () => {}, mirrorApps: () => [],
        dispatch: async (i) => { seen.push(i.scope); return { kind: "answer", confident: true }; },
      },
    });
    expect(code).toBe(0);
    expect(turns[0]!.cwd).toBe(M("learn-the-cello"));
    expect(turns[0]!.prompt).toStartWith("# MISSION: Learn the cello");
    expect(seen[0]).toMatchObject({ slug: "learn-the-cello", specialists: ["researcher", "scout"], ceiling: "draft" });
    expect(existsSync(join(M("learn-the-cello"), "memory", "threads", "t-cello.jsonl"))).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "start", domain: "_mission-learn-the-cello" });
  });

  test("a domain turn that names an active mission gets a one-line pointer", async () => {
    cello();
    const s = await resolveScope(V, { domain: "money", message: "Can I afford Learn the cello this month?" });
    expect(s.blocks.map((b) => b.text).join("\n")).toContain("Active mission: Learn the cello (mission/learn-the-cello), next: Instrument at home by 2026-10-05");
    expect((await resolveScope(V, { domain: "money", message: "What is my balance?" })).blocks).toEqual([]);
    // @ a mission in any chat: a short brief.
    const at = await resolveScope(V, { domain: "money", entity: ["mission/learn-the-cello"] });
    expect(at.blocks[0]!.text).toStartWith("# MISSION REFERENCED: Learn the cello (mission/learn-the-cello), active");
  });
});

describe("the mission dispatches inside its scope", () => {
  beforeEach(seed);
  const scopeOf = (ceiling: "read" | "draft" = "draft") => {
    const m = readMission(V, "learn-the-cello")!;
    return { slug: m.slug, name: m.name, domains: m.domains, specialists: m.specialists, apps: m.apps, ceiling, budgetLeftUsd: 1500 };
  };
  const reply = (o: object) => async () => JSON.stringify({ effort: "quick", open_ended: true, decision: false, why: "find tutors", ...o });

  test("find me three tutors: a job owned by the mission, staffed from it, without naming a domain or a specialist", async () => {
    cello();
    const d = await dispatch({ vault: V, message: "Find me three weekend tutors within twenty minutes of home", domain: "_mission-learn-the-cello", scope: scopeOf(), runner: reply({ owner: "hobbies", consulted: ["money"], informed: ["family"] }), now: NOW });
    expect(d.kind).toBe("job");
    expect(d.job!.domains).toEqual({ owner: "mission/learn-the-cello", consulted: ["hobbies", "money"], informed: ["family"] });
    expect(d.job!.team.flatMap((t) => t.specialists)).toContain("researcher");
    expect(d.job!.mission).toEqual({ slug: "learn-the-cello", ceiling: "draft", budgetLeftUsd: 1500 });
    expect(d.job!.startsAlone).toBe(true);
  });

  test("outside the scope is a bring-in, never a read; never-read domains always ask", async () => {
    cello();
    const named = await dispatch({ vault: V, message: "What do my taxes say about lesson fees?", domain: "x", scope: scopeOf(), runner: null });
    expect(named).toMatchObject({ kind: "bring-in", bringIn: { domains: ["taxes"], never: false } });
    const model = await dispatch({ vault: V, message: "Find a cheaper way to pay for lessons this term", domain: "x", scope: scopeOf(), runner: reply({ owner: "taxes", consulted: ["money"] }) });
    expect(model).toMatchObject({ kind: "bring-in", bringIn: { domains: ["taxes"] } });
    // A domain the job would only consult is left out (never read) and named.
    const extra = await dispatch({ vault: V, message: "Find a cheaper way to pay for lessons this term", domain: "x", scope: scopeOf(), runner: reply({ owner: "hobbies", consulted: ["taxes", "money"] }) });
    expect(extra.kind).toBe("job");
    expect(extra.job!.domains.consulted).toEqual(["hobbies", "money"]);
    expect(extra.job!.why).toContain("left out, not in the mission: taxes");
    const never = await dispatch({ vault: V, message: "Do my secrets notes mention the tutor?", domain: "x", scope: scopeOf(), runner: null });
    expect(never).toMatchObject({ kind: "bring-in", bringIn: { domains: ["secrets"], never: true } });
  });

  test("ceilings and money, in code: a read mission cannot draft; over the budget asks", async () => {
    cello();
    const d = await dispatch({ vault: V, message: "Draft an email to the tutor asking about Saturday lessons", domain: "x", scope: scopeOf("read"), runner: reply({ owner: "hobbies" }), now: NOW });
    expect(d.job!.startsAlone).toBe(false);
    expect(d.job!.askReason).toMatch(/past this mission's ceiling \(read\)/);
    saveJob(V, d.job!);
    const ran = await runJob(V, d.job!.id, { detectClis: async () => [{ kind: "claude", bin: "x", label: "c" }] as never, runChatTurn: async () => JSON.stringify({ summary: "plan", body: "A plan for the email.", sources: [], check: { ok: true, missing: [] }, notebook: [] }) });
    expect(ran.status).toBe("needs-approval");
    expect(ran.note).toMatch(/mission's ceiling/);
    const big = await dispatch({ vault: V, message: "Find a used cello under $2,000 near home", domain: "x", scope: { ...scopeOf(), budgetLeftUsd: 300 }, runner: reply({ owner: "hobbies" }) });
    expect(big.job!.askReason).toMatch(/budget/);
    // The broker and the act gate: the same rules for anything that acts.
    expect(gateAction("pay $500 for the cello", { vault: V, autonomousActs: true, mission: { slug: "learn-the-cello", ceiling: "act", budgetLeftUsd: 300 } }).decision).toBe("ask");
    expect(gateAction("send the tutor an email", { vault: V, autonomousActs: true, mission: { slug: "learn-the-cello", ceiling: "read", budgetLeftUsd: null } }).decision).toBe("block");
    expect(missionGate(V, "_mission-learn-the-cello")).toEqual({ readOnly: false, askAlways: true });
    expect(missionGate(V, "_mission-nope")).toEqual({ readOnly: true, askAlways: true });
    expect(missionGate(V, "hobbies")).toBeNull();
  });

  test("a job owned by the mission files into the mission, with Undo", async () => {
    cello();
    const d = await dispatch({ vault: V, message: "Find me three weekend tutors within twenty minutes of home", domain: "x", scope: scopeOf(), runner: reply({ owner: "hobbies", consulted: ["money"], informed: ["family"] }), now: NOW });
    saveJob(V, d.job!);
    const done = await runJob(V, d.job!.id, {
      detectClis: async () => [{ kind: "claude", bin: "x", label: "c" }] as never,
      runChatTurn: async (t: { prompt: string }) => {
        const who = /You are the (\w+)/.exec(t.prompt)?.[1];
        if (who === "Editor") return JSON.stringify({ summary: "Three tutors", body: "## Tutors\nA, B, C.", sources: ["https://example.com"], check: { ok: true, missing: [] }, notebook: [], filed: { decision: "Try tutor A first", task: { text: "Email tutor A", due: "2026-10-09" }, notes: { family: "Lessons will be on Saturdays", taxes: "never written" } } });
        return JSON.stringify({ summary: "found", body: "Tutors A, B and C with prices.", sources: ["https://example.com"], check: { ok: true, missing: [] }, notebook: [] });
      },
    });
    expect(done.status).toBe("done");
    expect(done.result!.page).toStartWith("data/missions/learn-the-cello/memory/briefs/");
    expect(read(join(M("learn-the-cello"), "memory", "tasks.md"))).toContain("Email tutor A");
    expect(read(join(M("learn-the-cello"), "memory", "decisions.jsonl"))).toContain("Try tutor A first");
    expect(read(join(D("family"), "memory", "updates.jsonl"))).toContain("Saturdays");
    expect(existsSync(join(D("taxes"), "memory", "updates.jsonl"))).toBe(false);
    const filed = jobReceipts(V, d.job!.id);
    const task = filed.find((r) => r.kind === "task")!;
    undoFiled(V, d.job!.id, task.n);
    expect(read(join(M("learn-the-cello"), "memory", "tasks.md"))).not.toContain("Email tutor A");
  });

  test("start a mission from chat: a draft card, never started alone", () => {
    expect(missionDraftFrom("Start a mission to learn the cello by 2027-06-30", "hobbies", ["hobbies"])).toMatchObject({ name: "Learn the cello", owner: "hobbies", specialists: ["tutor", "coach", "researcher"], target: "2027-06-30" });
    expect(missionDraftFrom("I'm going to remodel the kitchen this winter", "general", [])).toMatchObject({ name: "Remodel the kitchen this winter", specialists: ["researcher", "analyst", "liaison"] });
    expect(missionDraftFrom("What should I cook tonight?", "general", [])).toBeNull();
  });
});

describe("close-out", () => {
  beforeEach(seed);
  test("files back to every domain with receipts; Undo restores the prior bytes; the Compass is untouched", () => {
    cello();
    attach(V, "learn-the-cello", "domain", "money:consulted");
    spend(V, "learn-the-cello", { line: "lessons", usd: 120, what: "Term one fee", ref: "plaid:txn-foo" }, NOW);
    milestone(V, "learn-the-cello", "done", { title: "Instrument at home" }, NOW);
    writeFileSync(join(M("learn-the-cello"), "memory", "memory.md"), "# What this mission has learned\n- Saturday lessons stuck; weekday practice did not\n");
    writeFileSync(join(M("learn-the-cello"), "files", "receipt.pdf"), "pdf");
    writeFileSync(join(M("learn-the-cello"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Book next term ~id:t9\n");
    const ownerMem = join(D("hobbies"), "memory", "memory.md");
    const beforeOwner = read(ownerMem);
    const compass = read(join(V, "build", "compass.md"));

    const plan = planCloseout(V, "learn-the-cello", { result: "partly", resultNote: "Played two pieces", now: NOW });
    expect(plan.filings.map((f) => [f.kind, f.domain])).toEqual([
      ["summary", "hobbies"], ["lesson", "hobbies"], ["note", "money"], ["note", "family"], ["money", "money"],
      ["person", "person/tutor-example"], ["file", "hobbies"], ["task", "hobbies"],
    ]);
    plan.filings.find((f) => f.kind === "note" && f.domain === "family")!.text = "Recital on June 14";
    const r = applyCloseout(V, plan, NOW);
    expect(r.mission).toMatchObject({ status: "completed", result: "partly", completed: "2026-10-02" });
    expect(read(ownerMem)).toContain("## Missions");
    expect(read(ownerMem)).toContain("Lesson from Learn the cello: Saturday lessons stuck");
    expect(read(join(D("family"), "memory", "updates.jsonl"))).toContain("Recital on June 14");
    expect(read(join(D("money"), "memory", "updates.jsonl"))).toContain("plaid:txn-foo");
    expect(read(join(D("hobbies"), "memory", "tasks.md"))).toContain("Book next term ~id:t9 ~mission:learn-the-cello");
    expect(existsSync(join(D("hobbies"), "source", "missions", "learn-the-cello", "receipt.pdf"))).toBe(true);
    expect(read(join(M("learn-the-cello"), "closeout.md"))).toContain("Result: partly");
    expect(read(join(V, "build", "compass.md"))).toBe(compass);
    expect(readReceipts(V, "learn-the-cello")).toHaveLength(8);

    // Undo each write: the prior bytes come back.
    for (const x of readReceipts(V, "learn-the-cello").reverse()) undoCloseout(V, "learn-the-cello", x.n, NOW + DAY);
    expect(read(ownerMem)).toBe(beforeOwner);
    expect(read(join(D("family"), "memory", "updates.jsonl")).trim()).toBe("");
    expect(existsSync(join(M("learn-the-cello"), "files", "receipt.pdf"))).toBe(true);
    expect(read(join(M("learn-the-cello"), "memory", "tasks.md"))).toContain("Book next term");
    expect(read(join(D("hobbies"), "memory", "tasks.md"))).not.toContain("Book next term");
    expect(() => undoCloseout(V, "learn-the-cello", 1, NOW + 8 * DAY)).not.toThrow(); // already undone: a no-op
    expect(() => planCloseout(V, "learn-the-cello")).toThrow(/already completed/);
  });

  test("Undo is kept for seven days", () => {
    cello();
    applyCloseout(V, planCloseout(V, "learn-the-cello", { now: NOW }), NOW);
    expect(() => undoCloseout(V, "learn-the-cello", 1, NOW + 8 * DAY)).toThrow(/7 days/);
  });
});
