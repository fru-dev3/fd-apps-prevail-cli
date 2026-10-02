// Specialists Phase 3: standing work. The Operator behind the autonomy
// policy (every action through the broker, Allow and Deny from the Inbox),
// the Coach, Skeptic, Interviewer and Mechanic, loops that run playbooks on
// their clock (domains and missions) and the Sentinel's event triggers.
// Invented names only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actOnAction, readJob, runJob, saveJob, teamFor, undoFiled, type Job } from "./jobs.ts";
import { builtInSpecialists, getSpecialist } from "./specialists.ts";
import { approvePendingAct, denyPendingAct, OPERATOR_TOOL, readPendingActs } from "./act-gate.ts";
import { setAutonomyState, setPolicyFor } from "./autonomy.ts";
import { fireEventTriggers, loopsOnce, triggerMatches } from "./daemon-loops.ts";
import { markSeen, playbookInbox, setTrigger } from "./playbooks.ts";
import { runtimePath } from "./path-safety.ts";
import { specialistFacts } from "./specialist-facts.ts";
import { topCandidates } from "./said.ts";

const ROOT = join("/tmp", `prevail-standing-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo", "bar"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state for ${d}.\n`);
  }
  writeFileSync(join(D("foo"), "memory", "memory.md"), "# Foo memory\n\nI want to read one foo book a month, it keeps me calm.\n");
}

const fakeCli = { kind: "claude" as const, bin: "/bin/false", label: "claude" };
const detectClis = async () => [fakeCli] as never;
const reply = (o: Record<string, unknown>) => JSON.stringify({ sources: [], check: { ok: true, missing: [] }, notebook: [], ...o });

function job(team: string[][], ask = "Get the foo things done", owner = "foo"): Job {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`, ask, origin: { kind: "cli", domain: owner }, domains: { owner, consulted: [], informed: ["bar"] },
    entities: [], team: team.map((ids, i) => ({ step: i + 1, specialists: ids })), effort: "standard", budget: { usd: 1, minutes: 10 }, why: "test",
    playbook: null, status: "proposed", startsAlone: true, created: Date.now(),
  };
}

describe("the roster", () => {
  test("seventeen are on; the Operator may only ask, the Coach never writes the Compass", () => {
    const on = builtInSpecialists().filter((s) => s.on).map((s) => s.id);
    expect(on).toEqual(expect.arrayContaining(["operator", "coach", "skeptic", "interviewer", "mechanic"]));
    expect(on.length).toBe(17);
    expect(builtInSpecialists().length).toBe(21);
    expect(getSpecialist(V, "operator")!.ceiling).toBe("act-ask");
    expect(getSpecialist(V, "skeptic")!.returns).toBe("risks");
  });
  test("plans get a pre-mortem; doing things ends with the Operator behind a Steward gate", () => {
    const on = new Set(builtInSpecialists().filter((s) => s.on).map((s) => s.id));
    expect(teamFor("plan", on).map((s) => s.specialists.join("+"))).toEqual(["planner", "skeptic", "steward", "editor"]);
    expect(teamFor("act", on).map((s) => [s.specialists.join("+"), !!s.gate])).toEqual([["planner", false], ["steward", true], ["operator", false]]);
  });
});

describe("the Operator, behind the autonomy policy", () => {
  beforeEach(seed);
  const acts = ["Add a reminder to the Foo board for Friday", "Pay the $120 invoice from Foo Plumbing", "Delete the old account at Bar Bank"];
  const turn = async () => reply({ summary: "three actions", body: "1. a reminder 2. pay 3. delete", actions: acts.map((a) => ({ action: a, why: "the plan", undo: "remove it" })) });

  test("ask mode: each action asks or is blocked by policy; nothing runs; the Inbox holds the asks", async () => {
    const ran: string[] = [];
    const j = job([["operator"]]);
    saveJob(V, j);
    const done = await runJob(V, j.id, { detectClis, runChatTurn: turn as never, act: async (_v, _d, a) => { ran.push(a); return "ok"; } });
    expect(done.status).toBe("done");
    const x = readJob(V, j.id)!.actions!;
    expect(x.map((a) => [a.cls, a.status])).toEqual([["reversible", "asks"], ["financial", "asks"], ["irreversible", "blocked"]]);
    expect(ran).toEqual([]);
    const pend = readPendingActs(V).filter((p) => p.tool === OPERATOR_TOOL);
    expect(pend.map((p) => p.summary)).toEqual([`Operator: ${acts[0]}`, `Operator: ${acts[1]}`]);
  });

  test("Allow runs exactly that action; Deny marks it declined; a pause blocks even an approved one", async () => {
    const ran: string[] = [];
    const act = async (_v: string, _d: string, a: string) => { ran.push(a); return "done by the stub"; };
    const j = job([["operator"]]);
    saveJob(V, j);
    await runJob(V, j.id, { detectClis, runChatTurn: turn as never, act });
    const [p1, p2] = readPendingActs(V).filter((p) => p.tool === OPERATOR_TOOL);
    // Without the yes, nothing runs.
    expect((await actOnAction(V, j.id, 1, { deps: { act } })).status).toBe("asks");
    expect(approvePendingAct(V, p1!.id).ok).toBe(true);
    const a1 = await actOnAction(V, j.id, 1, { deps: { act } });
    expect([a1.status, a1.report]).toEqual(["done", "done by the stub"]);
    expect(ran).toEqual([acts[0]]);
    expect(denyPendingAct(V, p2!.id).ok).toBe(true);
    expect((await actOnAction(V, j.id, 2, { decline: true })).status).toBe("declined");
    // A second job, approved, then the brake: the pause wins over the yes.
    const j2 = job([["operator"]], "Get the other foo things done");
    saveJob(V, j2);
    await runJob(V, j2.id, { detectClis, runChatTurn: turn as never, act });
    const q = readPendingActs(V).find((p) => p.tool === OPERATOR_TOOL && p.argsJson.includes(j2.id))!;
    approvePendingAct(V, q.id);
    setAutonomyState(V, "paused");
    expect((await actOnAction(V, j2.id, 1, { deps: { act } })).status).toBe("blocked");
    expect(ran.length).toBe(1);
    setAutonomyState(V, "ask");
  });

  test("auto mode with a policy that allows the class: a reversible action runs alone, money still asks", async () => {
    setAutonomyState(V, "auto");
    setPolicyFor(V, "reversible", "allow");
    const ran: string[] = [];
    const j = job([["operator"]]);
    saveJob(V, j);
    await runJob(V, j.id, { detectClis, runChatTurn: turn as never, act: async (_v, _d, a) => { ran.push(a); return "ok"; } });
    expect(readJob(V, j.id)!.actions!.map((a) => a.status)).toEqual(["done", "asks", "blocked"]);
    expect(ran).toEqual([acts[0]]);
    setAutonomyState(V, "ask");
  });
});

describe("the Coach, Skeptic, Interviewer and Mechanic", () => {
  beforeEach(seed);
  test("the Coach proposes only in the user's own words; Undo takes the proposal back", async () => {
    const j = job([["coach"]], "Review my foo goals");
    saveJob(V, j);
    const turn = async () => reply({ summary: "one plan", body: "If it is Sunday evening, then pick the foo book.", plans: [{ goal: "foo reading", if_then: "If it is Sunday evening, then pick the foo book." }],
      candidates: [{ kind: "goal", title: "Read one foo book a month", quote: "I want to read one foo book a month" }, { kind: "value", title: "Serenity above all", quote: "Serenity is everything to me" }] });
    await runJob(V, j.id, { detectClis, runChatTurn: turn as never });
    const t = topCandidates(V, 10);
    expect(t.map((x) => x.title)).toEqual(["Read one foo book a month"]);
    const r = (await import("./jobs.ts")).readReceipts(V, j.id).find((x) => x.kind === "candidate")!;
    undoFiled(V, j.id, r.n);
    expect(topCandidates(V, 10)).toEqual([]);
    expect(existsSync(join(V, "build", "compass.md"))).toBe(false); // the Compass itself is never written
  });

  test("the Interviewer's questions wait in memory; Undo restores the exact bytes", async () => {
    const before = readFileSync(join(D("foo"), "memory", "memory.md"), "utf8");
    const j = job([["interviewer"]], "What is missing in foo");
    saveJob(V, j);
    await runJob(V, j.id, { detectClis, runChatTurn: (async () => reply({ summary: "two questions", body: "Two gaps.", questions: ["When does the foo lease end?", "Who is your foo agent?", "not a question"] })) as never });
    const after = readFileSync(join(D("foo"), "memory", "memory.md"), "utf8");
    expect(after).toMatch(/## Questions to ask you \(\d{4}-\d{2}-\d{2}\)\n- When does the foo lease end\?\n- Who is your foo agent\?\n/);
    expect(after).not.toContain("not a question");
    const r = (await import("./jobs.ts")).readReceipts(V, j.id).find((x) => x.kind === "memory")!;
    undoFiled(V, j.id, r.n);
    expect(readFileSync(join(D("foo"), "memory", "memory.md"), "utf8")).toBe(before);
  });

  test("the Skeptic needs early signs; the Mechanic reads code-computed health and files repairs", async () => {
    const j = job([["skeptic"]], "Pre-mortem the foo plan");
    saveJob(V, j);
    let calls = 0;
    const done = await runJob(V, j.id, { detectClis, runChatTurn: (async () => { calls++; return reply({ summary: "it fails on time", body: "Three ways.", risks: [{ risk: "no time", sign: "two missed weeks", odds: "high" }, { risk: "cost", sign: "quote over $500", odds: "low" }] }); }) as never });
    expect(done.status).toBe("done");
    expect(calls).toBe(1);
    // A failing loop and one that stopped running.
    writeFileSync(join(D("bar"), "_loops.json"), JSON.stringify({ loops: [{ id: "bar-watch", enabled: true, status: "active", cadence: "daily", lastRunTs: Date.now() - 9 * 86_400_000 }] }));
    writeFileSync(join(D("bar"), "_loops_runtime.json"), JSON.stringify({ schema: 1, loops: { "bar-watch": { history: [{ ts: Date.now(), note: "error: no CLI available" }], pending: [] } } }));
    const facts = await specialistFacts(V, "mechanic", "general");
    expect(facts).toContain("loop bar/bar-watch: last run said");
    expect(facts).toContain("has not run since");
    const m = job([["mechanic"]], "Check Prevail", "general");
    saveJob(V, m);
    await runJob(V, m.id, { detectClis, runChatTurn: (async () => reply({ summary: "one repair", body: "bar-watch fails.", filed: { tasks: [{ text: "Fix the bar-watch loop: no CLI on the hub", due: "2026-10-09" }] } })) as never });
    expect(readFileSync(join(D("general"), "memory", "tasks.md"), "utf8")).toContain("Fix the bar-watch loop: no CLI on the hub @2026-10-09");
  });
});

describe("loops run playbooks; the Sentinel fires them on events", () => {
  beforeEach(() => {
    seed();
    mkdirSync(join(V, "build", "playbooks"), { recursive: true });
    writeFileSync(join(V, "build", "playbooks", "foo-weekly.json"), JSON.stringify({ id: "foo-weekly", name: "Foo weekly", goal: "A foo check-in", steps: [{ kind: "task", id: "s1", text: "Check the foo plan" }] }));
  });

  test("a scheduled playbook loop runs the playbook (never the steward prompt) and its result lands in the Inbox", async () => {
    setTrigger(V, "foo-weekly", "foo", { cadence: "weekly" });
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8")).toContain("Check the foo plan");
    const inbox = playbookInbox(V);
    expect(inbox.map((x) => [x.playbook, x.trigger, x.ok])).toEqual([["foo-weekly", "schedule", true]]);
    markSeen(V, inbox[0]!.runId);
    expect(playbookInbox(V)).toEqual([]);
    // Not due again until a week has passed.
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8").match(/Check the foo plan/g)!.length).toBe(1);
  });

  test("an active mission runs its own playbook loop, as the mission; a paused one does not", async () => {
    const mdir = join(V, "data", "missions", "foo-trip");
    mkdirSync(join(mdir, "memory"), { recursive: true });
    writeFileSync(join(mdir, "mission.md"), "---\nname: Foo trip\nstatus: active\noutcome: Get to foo\ntarget: 2027-01-01\ndomains: [{\"slug\":\"foo\",\"role\":\"owner\"}]\n---\n## Outcome\nGet to foo\n");
    writeFileSync(join(mdir, "_loops.json"), JSON.stringify({ loops: [{ id: "check", name: "Check", playbook: "foo-weekly", cadence: "weekly", enabled: true, status: "active", lastRunTs: null }] }));
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    expect(readFileSync(join(mdir, "memory", "tasks.md"), "utf8")).toContain("Check the foo plan");
    writeFileSync(join(mdir, "mission.md"), readFileSync(join(mdir, "mission.md"), "utf8").replace("status: active", "status: paused"));
    writeFileSync(join(mdir, "memory", "tasks.md"), "# Tasks\n");
    const doc = JSON.parse(readFileSync(join(mdir, "_loops.json"), "utf8"));
    doc.loops[0].lastRunTs = null;
    writeFileSync(join(mdir, "_loops.json"), JSON.stringify(doc));
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    expect(readFileSync(join(mdir, "memory", "tasks.md"), "utf8")).not.toContain("Check the foo plan");
  });

  test("an event loop fires once per new radar item of its kind, in its own domain, never on the clock", async () => {
    setTrigger(V, "foo-weekly", "foo", { on: "admin:renew" });
    const items = [
      { key: "admin:task:foo:x1", kind: "admin", domain: "foo", text: "Renew the foo policy 2026-11-01" },
      { key: "admin:task:bar:x2", kind: "admin", domain: "bar", text: "Renew the bar policy 2026-11-01" },
      { key: "admin:task:foo:x3", kind: "admin", domain: "foo", text: "File the foo form" },
    ];
    const cfg = { vaultPath: V, intervalSec: 60, provider: "claude", model: "" };
    const r1 = await fireEventTriggers(cfg, items);
    expect(r1.fired.map((f) => f.item)).toEqual(["admin:task:foo:x1"]);
    expect((await fireEventTriggers(cfg, items)).fired).toEqual([]);
    expect(playbookInbox(V).map((x) => [x.trigger, x.event])).toEqual([["event", "Renew the foo policy 2026-11-01"]]);
    expect(triggerMatches("mission", "mission/foo-trip", { kind: "mission", domain: "foo", mission: "foo-trip", text: "Foo trip has gone quiet" })).toBe(true);
    expect(triggerMatches("admin", "general", { kind: "admin", domain: "bar", text: "x" })).toBe(true);
  });

  test("an Inbox result names the specialists each step staffed, so their faces show", () => {
    const dir = join(runtimePath(V, "_meta"), "jobs", "loop-foo-faces");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "loop-foo-faces", playbook: "foo-weekly", ok: true, note: "", trigger: "schedule", ts: 5,
      steps: [{ label: "researcher + scout: foo", ok: true, decision: "auto", note: "", specialists: ["researcher", "scout"] }, { label: "a task", ok: true, decision: "auto", note: "" }] }));
    const r = playbookInbox(V).find((x) => x.runId === "loop-foo-faces")!;
    expect(r.steps.map((x) => x.specialists ?? [])).toEqual([["researcher", "scout"], []]);
  });
});
