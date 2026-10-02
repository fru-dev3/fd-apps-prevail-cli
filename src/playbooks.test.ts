// Specialists Phase 2: the specialist step kind with typed returns, gates and
// ASK steps; Save as playbook (a Planner's plan becomes steps); the six new
// specialists' code checks; Clerk and Builder filing with Undo; the code half
// each folded feature gives its specialist.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFiles, codeCheck, dispatch, jobView, listJobs, readJob, readReceipts, runJob, saveJob, teamFor, undoFiled, type Job } from "./jobs.ts";
import { getSpecialist, loadSpecialists } from "./specialists.ts";
import { loadPlaybook, runPlaybook, type Playbook } from "./orchestrator.ts";
import { adoptPlaybook, planToSteps, playbookRows, playbookView, saveJobAsPlaybook } from "./playbooks.ts";
import { specialistFacts } from "./specialist-facts.ts";
import { openDecision, decide } from "./decision-records.ts";

const ROOT = join("/tmp", `prevail-playbooks-${process.pid}`);
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
  writeFileSync(join(D("foo"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Existing foo task ~id:abc1234\n");
}

const fakeCli = { kind: "claude" as const, bin: "/bin/false", label: "claude" };
const detectClis = async () => [fakeCli] as never;
const J = (o: Record<string, unknown>) => JSON.stringify({ sources: [], check: { ok: true, missing: [] }, notebook: [], ...o });

function turns(log: string[], over: Record<string, string> = {}) {
  return async (t: { prompt: string }) => {
    const who = /You are the (\w+)/.exec(t.prompt)?.[1] ?? "";
    log.push(who);
    if (over[who] !== undefined) return over[who]!;
    if (who === "Researcher") return J({ summary: "Option A", body: "Option A and B compared on foo facts.", sources: ["https://example.com/a"] });
    if (who === "Scout") return J({ summary: "a window", body: "A renewal window you did not ask about.", sources: ["https://example.com/b"] });
    if (who === "Sentinel") return J({ summary: "renews in 30 days", body: "- The foo plan renews on 2026-11-01." });
    if (who === "Historian") return J({ summary: "two renewals", body: "- 2024-11-01 renewed at $900\n- 2025-11-01 renewed at $960" });
    if (who === "Analyst") return J({ summary: "$2,880 over three years", body: "Staying costs $960 x 3 = $2,880.", sources: ["data/domains/foo/memory/state.md"] });
    if (who === "Steward") return J({ summary: "fits", verdict: "fits", body: "It fits the foo value." });
    if (who === "Auditor") return J({ summary: "verified", verdict: "verified", body: "Every number matches its file." });
    if (who === "Editor") return J({ summary: "Option A", body: "## Answer\nOption A.", sources: ["https://example.com/a"], filed: { task: { text: "Switch to option A", due: "2026-11-01" } } });
    if (who === "Planner") return J({ summary: "a plan", body: "1. Researcher compares the foo options by 2026-10-10\n2. Call the foo office to ask about the window\n3. Writer drafts the request to the provider (ASK)\n4. Steward checks the choice" });
    if (who === "Clerk") return J({ summary: "two changes", body: "Filed.", filed: { tasks: [{ text: "Renew the foo plan", due: "2026-11-01" }, { text: "Existing foo task" }], notes: { bar: "The foo plan renews in November" } } });
    if (who === "Builder") return J({ summary: "a script", body: "Here it is.\n```sh\npath: tools/check.sh\necho foo\n```\nRun it with sh; remove the folder to undo." });
    if (who === "Writer") return J({ summary: "one draft", body: "Draft.", drafts: [{ to: "provider", subject: "Quote", body: "Hello" }] });
    return "";
  };
}

describe("the six new specialists", () => {
  beforeEach(seed);
  test("teams: money brings the Analyst, numbers the Auditor; understanding pairs Analyst and Historian; make is Builder then Auditor", () => {
    const on = new Set(loadSpecialists(V).filter((s) => s.on).map((s) => s.id));
    expect(teamFor("find", on, { money: true }).map((s) => s.specialists)).toEqual([["researcher", "scout"], ["analyst"], ["steward"], ["auditor"], ["editor"]]);
    expect(teamFor("find", on, { numbers: true, decision: false }).map((s) => s.specialists)).toEqual([["researcher", "scout"], ["auditor"], ["editor"]]);
    expect(teamFor("understand", on).map((s) => s.specialists)).toEqual([["analyst", "historian"], ["editor"]]);
    expect(teamFor("make", on)).toEqual([{ step: 1, specialists: ["builder"] }, { step: 2, specialists: ["auditor"], gate: true }]);
  });
  test("code checks per return type", () => {
    const base = { summary: "", body: "", sources: [], check: { ok: true, missing: [] }, notebook: [] };
    expect(codeCheck(getSpecialist(V, "analyst")!, { ...base, body: "no figures here at all, none" })).toEqual(expect.arrayContaining(["no numbers", "no sources for the numbers"]));
    expect(codeCheck(getSpecialist(V, "historian")!, { ...base, body: "- 2024-01 one\n- 2025-02 two" })).toEqual([]);
    expect(codeCheck(getSpecialist(V, "auditor")!, { ...base, body: "checked everything carefully", verdict: "fine" })).toContain("no verdict (verified or flagged)");
    expect(codeCheck(getSpecialist(V, "builder")!, { ...base, body: "```\nno path line\n```" })).toContain("no files (fenced blocks starting with a path line)");
    expect(codeCheck(getSpecialist(V, "clerk")!, { ...base, body: "nothing was filed at all" })).toContain("no changes to file");
    expect(buildFiles("```js\n// path: a/b.js\nx()\n```\n```\npath: ../evil\n```")).toEqual([{ path: "a/b.js", text: "x()\n" }]);
  });
  test("a Clerk files tasks (never twice) and notes; a Builder's files wait in the job folder; Undo reverses both", async () => {
    const d = await dispatch({ vault: V, message: "@Clerk file what the foo renewal letter says", domain: "foo", runner: null });
    const job = d.job!;
    job.domains.informed = ["bar"];
    saveJob(V, job);
    const done = await runJob(V, job.id, { detectClis, runChatTurn: turns([]) as never });
    expect(done.status).toBe("done");
    const board = readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8");
    expect(board).toContain("Renew the foo plan @2026-11-01");
    expect(board.match(/Existing foo task/g)?.length).toBe(1);
    expect(readFileSync(join(D("bar"), "memory", "updates.jsonl"), "utf8")).toContain("renews in November");
    for (const r of readReceipts(V, job.id)) undoFiled(V, job.id, r.n);
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8")).not.toContain("Renew the foo plan");

    const b = await dispatch({ vault: V, message: "@Builder build a foo check script", domain: "foo", runner: null });
    saveJob(V, b.job!);
    const built = await runJob(V, b.job!.id, { detectClis, runChatTurn: turns([]) as never });
    expect(built.status).toBe("done");
    const f = join(V, "build", "_meta", "jobs", b.job!.id, "build", "tools", "check.sh");
    expect(readFileSync(f, "utf8")).toBe("echo foo\n");
    const rec = readReceipts(V, b.job!.id).find((r) => r.kind === "build")!;
    expect(rec.text).toMatch(/nothing ran/);
    undoFiled(V, b.job!.id, rec.n);
    expect(existsSync(f)).toBe(false);
  });
  test("an Auditor that flags stops the job at its gate", async () => {
    const d = await dispatch({ vault: V, message: "@Auditor check the foo numbers", domain: "foo", runner: null });
    const job: Job = { ...d.job!, team: [{ step: 1, specialists: ["analyst"] }, { step: 2, specialists: ["auditor"], gate: true }, { step: 3, specialists: ["editor"] }] };
    saveJob(V, job);
    const log: string[] = [];
    const done = await runJob(V, job.id, { detectClis, runChatTurn: turns(log, { Auditor: J({ summary: "flagged", verdict: "flagged", body: "The $2,880 figure uses the wrong year." }) }) as never });
    expect(done.status).toBe("needs-approval");
    expect(log).not.toContain("Editor");
  });
});

describe("playbooks with specialist steps", () => {
  beforeEach(seed);
  const pb: Playbook = {
    id: "foo-renewal", name: "Foo renewal", goal: "Review the foo renewal",
    steps: [
      { kind: "specialist", id: "s1", specialist: "historian", brief: "What happened with the foo plan" },
      { kind: "specialist", id: "s2", specialists: ["researcher", "scout"], brief: "Compare foo providers", uses: ["s1"] },
      { kind: "specialist", id: "s3", specialist: "steward", brief: "Does it fit?", uses: ["s2"], gate: "stop" },
      { kind: "specialist", id: "s4", specialist: "editor", brief: "One page", uses: ["s1", "s2", "s3"] },
      { kind: "specialist", id: "s5", specialist: "writer", brief: "Quote requests", uses: ["s4"], approval: "ask" },
      { kind: "task", id: "s6", text: "Call the foo office about the renewal window" },
    ],
  };
  const ctx = (log: string[], over: Record<string, string> = {}) => ({ vault: V, provider: "claude", model: "", autonomousActs: true, domain: "foo", runDeps: { detectClis, runChatTurn: turns(log, over) as never } });
  test("typed results feed the steps that use them; ASK waits; a task lands on the board; runs are jobs with origin playbook", async () => {
    const log: string[] = [];
    const prompts: string[] = [];
    const base = turns(log);
    const r = await runPlaybook("pb-foo-renewal-1", pb, { ...ctx(log), runDeps: { detectClis, runChatTurn: (async (t: { prompt: string }) => { prompts.push(t.prompt); return base(t); }) as never } });
    expect(r.steps.map((s) => s.decision)).toEqual(["auto", "auto", "auto", "auto", "ask", "auto"]);
    expect(log).toEqual(["Historian", "Researcher", "Scout", "Steward", "Editor"]);
    // The Researcher read the Historian's timeline; the Steward read the Researcher's findings.
    expect(prompts.find((p) => /You are the Researcher/.test(p))).toContain("2025-11-01 renewed at $960");
    expect(prompts.find((p) => /You are the Steward/.test(p))).toContain("Option A and B compared");
    expect(r.steps[4]!.note).toMatch(/waits for your yes/);
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8")).toMatch(/Call the foo office about the renewal window \+\d{4}-\d{2}-\d{2} ~src:playbook:foo-renewal/);
    const jobs = listJobs(V).filter((j) => j.playbook === "foo-renewal" && j.team.length);
    expect(jobs.length).toBe(5);
    expect(jobs.every((j) => j.origin.kind === "playbook" && j.domains.owner === "foo")).toBe(true);
    expect(jobs.find((j) => j.team[0]!.specialists[0] === "writer")!.status).toBe("proposed");
    expect(r.steps[0]!.outputs[0]).toMatch(/result\.json$/);
  });
  test("a gate that says it does not fit stops the playbook", async () => {
    const log: string[] = [];
    const r = await runPlaybook("pb-foo-renewal-2", pb, ctx(log, { Steward: J({ summary: "does not fit", verdict: "does not fit", body: "It breaks the foo rule." }) }));
    expect(r.steps.length).toBe(3);
    expect(log).not.toContain("Editor");
    expect(existsSync(join(D("foo"), "memory", "tasks.md")) && readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8").includes("Call the foo office")).toBe(false);
  });
  test("a gate that cannot run (time out) also stops the playbook: nothing unchecked is filed after it", async () => {
    const log: string[] = [];
    const r = await runPlaybook("pb-foo-renewal-3", pb, ctx(log, { Steward: "(cancelled)" }));
    expect(r.steps.length).toBe(3);
    expect(r.steps[2]!.ok).toBe(false);
    expect(log).not.toContain("Editor");
  });
  test("a specialist that is off is never run", async () => {
    const r = await runPlaybook("pb-x", { id: "x", name: "X", goal: "x", steps: [{ kind: "specialist", specialist: "negotiator", brief: "counteroffer" }] }, ctx([]));
    expect(r.steps[0]!.decision).toBe("block");
    expect(r.steps[0]!.note).toContain("negotiator");
  });
  test("the built-in reference playbooks load and name only specialists that are on", () => {
    const on = new Set(loadSpecialists(V).filter((s) => s.on).map((s) => s.id));
    for (const id of ["renewal-review", "keep-or-sell"]) {
      const p = loadPlaybook(V, id)!;
      expect(p).toBeTruthy();
      for (const s of p.steps) if (s.kind === "specialist") for (const x of s.specialists ?? [s.specialist!]) expect(on.has(x)).toBe(true);
    }
    const rows = playbookRows(V);
    expect(rows.find((x) => x.id === "renewal-review")!.group).toBe("built-in");
    const v = playbookView(V, "renewal-review")!;
    expect(v.rows.find((x) => x.n === 5)).toMatchObject({ specialists: ["steward"], returns: ["verdict"], gate: true });
    expect(v.rows.find((x) => x.n === 8)).toMatchObject({ specialists: ["writer"], returns: ["draft"], ask: true });
  });
});

describe("Save as playbook", () => {
  beforeEach(seed);
  test("a Planner's plan becomes steps: named specialists run, the rest are tasks; a draft until adopted", async () => {
    const d = await dispatch({ vault: V, message: "@Planner plan the foo renewal", domain: "foo", runner: null });
    saveJob(V, d.job!);
    await runJob(V, d.job!.id, { detectClis, runChatTurn: turns([]) as never });
    const pb = saveJobAsPlaybook(V, d.job!.id, { name: "Foo renewal plan" });
    expect(pb.draft).toBe(true);
    expect(pb.steps.map((s) => s.kind)).toEqual(["specialist", "task", "specialist", "specialist"]);
    expect(pb.steps[2]).toMatchObject({ specialists: ["writer"], approval: "ask" });
    expect(pb.steps[3]).toMatchObject({ specialists: ["steward"], gate: "stop" });
    expect(pb.steps[0]).toMatchObject({ kind: "specialist", specialists: ["researcher"] });
    expect(playbookRows(V).find((r) => r.id === pb.id)!.group).toBe("drafts");
    adoptPlaybook(V, pb.id);
    expect(playbookRows(V).find((r) => r.id === pb.id)!.group).toBe("yours");
    expect(saveJobAsPlaybook(V, d.job!.id, { name: "Foo renewal plan" }).id).toBe(`${pb.id}-2`);
  });
  test("any other job keeps its team, step by step", async () => {
    const d = await dispatch({ vault: V, message: "Find the best foo providers for next year", domain: "foo", runner: async () => JSON.stringify({ owner: "foo", consulted: [], informed: [], effort: "standard", open_ended: false, decision: true }) });
    saveJob(V, d.job!);
    const pb = saveJobAsPlaybook(V, d.job!.id, { draft: false });
    expect(pb.draft).toBeUndefined();
    expect(pb.steps.map((s) => (s.kind === "specialist" ? s.specialists : []))).toEqual([["researcher"], ["steward"], ["editor"]]);
    expect(readJob(V, d.job!.id)).toBeTruthy();
  });
  test("planToSteps keeps dates and ASK", () => {
    const s = planToSteps("1. Ask the bank for a foo statement by 2026-10-09\n2. Analyst works out the cost (ASK)", loadSpecialists(V), "foo");
    expect(s[0]).toMatchObject({ kind: "task", due: "2026-10-09", domain: "foo" });
    expect(s[1]).toMatchObject({ kind: "specialist", specialists: ["analyst"], approval: "ask" });
  });
});

describe("the code half of folded features", () => {
  beforeEach(seed);
  test("the Historian reads decisions and their retros; the Scout looks at a neighbour; others get nothing extra", async () => {
    const r = openDecision(V, { question: "Keep the foo plan?", domain: "foo", due: "2026-10-20" });
    decide(V, "foo", r.slug, "keep", "cheaper", Date.UTC(2026, 9, 1));
    const h = await specialistFacts(V, "historian", "foo");
    expect(h).toContain("Keep the foo plan?");
    expect(h).toContain("chose keep");
    expect(await specialistFacts(V, "scout", "foo")).toMatch(/Look one step to the side, at (general|bar)/);
    expect(await specialistFacts(V, "writer", "foo")).toBe("");
  });
  test("a step record keeps what code told the specialist", async () => {
    const d = await dispatch({ vault: V, message: "@Historian what happened with foo", domain: "foo", runner: null });
    saveJob(V, d.job!);
    const prompts: string[] = [];
    await runJob(V, d.job!.id, { detectClis, runChatTurn: (async (t: { prompt: string }) => { prompts.push(t.prompt); return turns([])(t); }) as never });
    expect(jobView(V, d.job!.id)!.steps.length).toBe(1);
    expect(prompts[0]).toContain("## Context");
  });
});
