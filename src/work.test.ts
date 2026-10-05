import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setChiefSetting } from "./chief-of-staff.ts";
import { boardFile, readJob, saveJob, type Job } from "./jobs.ts";
import type { Herdr } from "./spaces.ts";
import {
  acceptSuggestion, addWork, answerTask, continueTask, startTask, declineSuggestion, listWork, pauseTask, readOrder, readSettings, readTask, remainingJob, reorderTask, routeTask, runTask, showWork,
  stopTask, topUp, updateTask, workCommand, writeSettings, type WorkDeps,
} from "./work.ts";

const ROOT = join("/tmp", `prevail-work-${process.pid}`);
const V = join(ROOT, "vault");
// Never the user's config or Glyph map: both point into /tmp while these tests run.
const saved = { config: process.env.PREVAIL_CONFIG_DIR, glyph: process.env.GLYPH_SPACES };
beforeAll(() => { process.env.PREVAIL_CONFIG_DIR = join(ROOT, "config"); process.env.GLYPH_SPACES = join(ROOT, "no-glyph"); });
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of [["PREVAIL_CONFIG_DIR", saved.config], ["GLYPH_SPACES", saved.glyph]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const D = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "insurance", "money", "fitness"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), ".prevail-layout-v4"), "v4\n");
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d, summary: `Foo ${d}` } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state.\n`);
  }
}

// A herdr that is never the real one: it answers the read-only calls the queue makes.
function quietHerdr(): Herdr {
  return (args) => {
    if (args[0] === "--version") return "herdr 0.0.0";
    if (args[0] === "machine") return [];
    if (args[0] === "agent" && args[1] === "start" && args[2] === "--help") return "[possible values: claude, codex, gemini]";
    if (args[0] === "workspace" && args[1] === "list") return { workspaces: [] };
    if (args[0] === "pane") return { panes: [] };
    return {};
  };
}

function deps(spawned: string[][] = []): WorkDeps {
  const h = quietHerdr();
  return { spawnSelf: (a) => { spawned.push(a); }, herdrFor: () => h, machine: { host: "laptop", role: "hub", env: { GLYPH_SPACES: join(ROOT, "no-glyph"), PREVAIL_MACHINE: "laptop" } } };
}

const threeGoals = JSON.stringify({ goals: [
  { text: "Cover the foo rentals", tasks: [{ text: "Find the best foo carrier for the rentals", dest: { kind: "domain", id: "insurance" }, confidence: 0.9, shape: "find", flags: { decision: true } }] },
  { text: "Get fit", tasks: [{ text: "Plan a foo training block for next month", dest: { kind: "domain", id: "fitness" }, confidence: 0.8, shape: "plan" }] },
  { text: "Money", tasks: [{ text: "Draft an email to the foo bank about the fee", dest: { kind: "domain", id: "money" }, confidence: 0.8, shape: "do", missing: [{ kind: "domain", name: "banking", why: "no home for banks" }, { kind: "specialist", name: "Fee checker", why: "checks foo fees" }] }] },
] });

describe("adding work", () => {
  beforeEach(seed);
  test("one prompt becomes three routed tasks, each with a thread, a board line and a job; what may start alone starts", async () => {
    setChiefSetting(V, "handoff", "offer");
    setChiefSetting(V, "handoff", "auto");
    const spawned: string[][] = [];
    const p = await addWork(V, "foo prompt about three things", { surface: "desktop", deps: { ...deps(spawned), runner: async () => threeGoals } });
    expect(p.source).toBe("model");
    expect(p.surface).toBe("desktop");
    expect(p.machine).toBe("laptop");
    expect(p.tasks.map((t) => t.dest?.id)).toEqual(["insurance", "fitness", "money"]);
    const [a, b, c] = p.tasks;
    // find and plan start alone; an email asks first.
    expect(a!.status).toBe("running");
    expect(b!.status).toBe("running");
    expect(c!.status).toBe("needs-you");
    expect(c!.ask).toMatchObject({ kind: "start" });
    expect(spawned).toEqual([["work", "run", a!.id], ["work", "run", b!.id]]);
    // The thread: desktop markdown with its frontmatter, and the .jsonl twin.
    const md = readFileSync(join(D("insurance"), "memory", "threads", `${a!.thread.session}.md`), "utf8");
    expect(md).toMatch(/^---\ntitle: Find the best foo carrier for the rentals\ndomain: insurance\ncreated: \S+Z\nupdated: \S+Z\nturns: 1\n---\n\n## You\n\nFind the best foo carrier/);
    expect(existsSync(join(D("insurance"), "memory", "threads", `${a!.thread.session}.jsonl`))).toBe(true);
    // The board line follows the status.
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toContain(`~src:work:${a!.id} ~owner:ai ~status:doing ~id:${a!.board!.id}`);
    expect(readFileSync(join(D("money"), "memory", "tasks.md"), "utf8")).toContain("~status:review");
    const job = readJob(V, a!.jobId!)!;
    expect(job.origin.kind).toBe("work");
    expect(job.domains.owner).toBe("insurance");
    // A specialist the work needs is made (draft at most) when handoff is auto; a domain waits as a suggestion.
    expect(c!.suggestions.map((s) => [s.kind, s.state])).toEqual([["domain", "open"], ["specialist", "accepted"]]);
    expect(c!.specialists).toContain("fee-checker");
    expect(readFileSync(join(V, "build", "specialists", "fee-checker.md"), "utf8")).toContain("ceiling: draft");
  });
  test("the code router and bunker never start alone; handoff offer neither", async () => {
    const spawned: string[][] = [];
    const p = await addWork(V, "Find the best foo carrier for the insurance. Plan a foo training block for fitness.", { deps: { ...deps(spawned), runner: null } });
    expect(p.source).toBe("code");
    expect(p.tasks.every((t) => t.status === "needs-you")).toBe(true);
    process.env.PREVAIL_BUNKER = "1";
    try {
      const q = await addWork(V, "Find the best foo carrier", { deps: { ...deps(spawned), runner: async () => threeGoals } });
      expect(q.source).toBe("code");
      expect(q.tasks[0]!.status).toBe("needs-you");
    } finally { delete process.env.PREVAIL_BUNKER; }
    setChiefSetting(V, "handoff", "offer");
    const r = await addWork(V, "x", { deps: { ...deps(spawned), runner: async () => threeGoals } });
    expect(r.tasks[0]!.ask?.detail).toMatch(/offered/);
    expect(spawned).toEqual([]);
  });
});

describe("running, pausing, continuing", () => {
  beforeEach(seed);
  async function one(spawned: string[][] = []) {
    const p = await addWork(V, "x", { deps: { ...deps(spawned), runner: async () => JSON.stringify({ goals: [threeGoals && JSON.parse(threeGoals).goals[0]] }) } });
    return p.tasks[0]!;
  }
  test("the run files the result into the thread and closes the board line", async () => {
    const t = await one();
    const stub = async (vault: string, id: string): Promise<Job> => {
      const j = readJob(vault, id)!;
      const done = { ...j, status: "done" as const, result: { type: "page", summary: "Carrier A for both foo rentals" } };
      saveJob(vault, done);
      writeFileSync(join(vault, "build", "_meta", "jobs", id, "result.json"), JSON.stringify({ body: "## Answer\nCarrier A." }));
      return done;
    };
    const r = await runTask(V, t.id, { ...deps(), runJob: stub });
    expect(r.status).toBe("done");
    expect(r.lease).toBeUndefined();
    const md = readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.md`), "utf8");
    expect(md).toContain("## prevail\n\nCarrier A for both foo rentals\n\n## Answer\nCarrier A.");
    expect(md).toMatch(/turns: 2/);
    const turns = readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(turns.map((x: { role: string }) => x.role)).toEqual(["user", "assistant"]);
    expect(turns[1].parentId).toBe(turns[0].id);
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toMatch(/- \[x\] Find the best foo carrier/);
  });
  test("pause marks the board blocked; continue starts what is left; stop closes", async () => {
    const spawned: string[][] = [];
    const t = await one(spawned);
    const p = pauseTask(V, t.id, deps());
    expect(p.status).toBe("paused");
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toContain("~status:blocked");
    // The job got two of its three steps done before the pause.
    const j = readJob(V, t.jobId!)!;
    saveJob(V, { ...j, status: "stopped" });
    const dir = join(V, "build", "_meta", "jobs", j.id, "steps");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-researcher.json"), JSON.stringify({ specialist: "researcher", status: "done", result: { type: "findings", file: "steps/1-researcher.result.json" } }));
    writeFileSync(join(dir, "1-researcher.result.json"), JSON.stringify({ body: "Foo findings" }));
    writeFileSync(join(dir, "2-scout.json"), JSON.stringify({ specialist: "scout", status: "done", result: { type: "discoveries", file: "steps/2-scout.result.json" } }));
    writeFileSync(join(dir, "2-scout.result.json"), JSON.stringify({ body: "Foo discoveries" }));
    const c = await continueTask(V, t.id, { deps: deps(spawned) });
    expect(c.ok).toBe(true);
    expect(c.task!.status).toBe("running");
    const next = readJob(V, c.task!.jobId!)!;
    expect(next.id).not.toBe(j.id);
    expect(next.team.map((s) => s.specialists)).toEqual([["steward"], ["editor"]]);
    expect(next.inputs?.map((x) => x.body)).toEqual(["Foo findings", "Foo discoveries"]);
    expect(spawned.at(-1)).toEqual(["work", "run", t.id]);
    expect(stopTask(V, t.id, deps()).status).toBe("closed");
  });
  test("another Mac's live lease is only taken on a yes", async () => {
    const t = await one();
    updateTask(V, t.id, (x) => { x.status = "running"; x.lease = { host: "mini-foo", until: Date.now() + 60_000 }; });
    const no = await continueTask(V, t.id, { deps: deps() });
    expect(no).toMatchObject({ ok: false, lease: { host: "mini-foo" } });
    const yes = await continueTask(V, t.id, { yes: true, deps: deps() });
    expect(yes.ok).toBe(true);
    expect(yes.task!.machine).toBe("laptop");
  });
  test("remainingJob is null when every step finished", () => {
    const j: Job = { id: "2026-10-04-000000-foo", ask: "foo", origin: { kind: "work", domain: "money" }, domains: { owner: "money", consulted: [], informed: [] }, entities: [], team: [{ step: 1, specialists: ["researcher"] }], effort: "quick", budget: { usd: 0.3, minutes: 4 }, why: "", playbook: null, status: "stopped", startsAlone: true, created: 1 };
    saveJob(V, j);
    const dir = join(V, "build", "_meta", "jobs", j.id, "steps");
    writeFileSync(join(dir, "1-researcher.json"), JSON.stringify({ specialist: "researcher", status: "done", result: { type: "findings", file: "steps/1-researcher.result.json" } }));
    writeFileSync(join(dir, "1-researcher.result.json"), JSON.stringify({ body: "x" }));
    expect(remainingJob(V, j.id)).toBeNull();
  });
});

describe("routes, suggestions and answers", () => {
  beforeEach(seed);
  test("re-route moves the thread files and the board line; Undo moves them back; nothing is deleted", async () => {
    const p = await addWork(V, "x", { deps: { ...deps(), runner: async () => threeGoals } });
    const t = p.tasks[2]!;
    const s = t.thread.session;
    const r = await routeTask(V, t.id, { dest: "domain:fitness" }, deps());
    expect(r.dest?.id).toBe("fitness");
    expect(r.thread.space).toBe("fitness");
    expect(existsSync(join(D("money"), "memory", "threads", `${s}.md`))).toBe(false);
    expect(readFileSync(join(D("fitness"), "memory", "threads", `${s}.md`), "utf8")).toContain("domain: fitness");
    expect(existsSync(join(D("fitness"), "memory", "threads", `${s}.jsonl`))).toBe(true);
    expect(readFileSync(join(D("money"), "memory", "tasks.md"), "utf8")).not.toContain(t.id);
    expect(readFileSync(join(D("fitness"), "memory", "tasks.md"), "utf8")).toContain(t.id);
    expect(readJob(V, r.jobId!)!.domains.owner).toBe("fitness");
    const u = await routeTask(V, t.id, { undo: true }, deps());
    expect(u.dest?.id).toBe("money");
    expect(existsSync(join(D("money"), "memory", "threads", `${s}.md`))).toBe(true);
    const g = await routeTask(V, t.id, { undo: true }, deps());
    expect(g.dest?.id).toBe("general");
    await expect(routeTask(V, t.id, { dest: "domain:nope" }, deps())).rejects.toThrow(/no domain nope/);
    await expect(routeTask(V, t.id, { agentKind: "nope" }, deps())).rejects.toThrow(/unknown agent kind/);
  });
  test("accepting a domain makes it and routes the task there; declining marks it", async () => {
    setChiefSetting(V, "handoff", "offer");
    const p = await addWork(V, "x", { deps: { ...deps(), runner: async () => threeGoals } });
    const t = p.tasks[2]!;
    expect(t.suggestions[1]!.state).toBe("open");
    expect(declineSuggestion(V, t.id, 2).suggestions[1]!.state).toBe("declined");
    const r = await acceptSuggestion(V, t.id, 1, deps());
    expect(r.made).toBe("domain banking");
    expect(existsSync(join(V, "data", "domains", "banking"))).toBe(true);
    expect(r.task.dest?.id).toBe("banking");
    expect(r.task.suggestions[0]!.state).toBe("accepted");
    await expect(acceptSuggestion(V, t.id, 1, deps())).rejects.toThrow(/already accepted/);
  });
  test("accepting an entity makes it as the kind the router named, not always a person", async () => {
    setChiefSetting(V, "handoff", "offer");
    const reply = JSON.stringify({ goals: [{ text: "Foo the dog", tasks: [{ text: "Book the foo dog's checkup", dest: { kind: "domain", id: "general" }, confidence: 0.8, missing: [{ kind: "entity", name: "Foo Dog", why: "a pet", draft: { kind: "thing" } }] }] }] });
    const p = await addWork(V, "x", { deps: { ...deps(), runner: async () => reply } });
    const r = await acceptSuggestion(V, p.tasks[0]!.id, 1, deps());
    expect(r.made).toBe("thing/foo-dog");
    expect(r.task.dest?.entity).toBe("thing/foo-dog");
  });
  test("answer yes starts, no closes", async () => {
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(spawned), runner: async () => threeGoals } });
    const c = p.tasks[2]!;
    expect((await answerTask(V, c.id, "yes", { deps: deps(spawned) })).status).toBe("running");
    expect(spawned.at(-1)).toEqual(["work", "run", c.id]);
    pauseTask(V, c.id, deps());
    updateTask(V, c.id, (x) => { x.ask = { kind: "start", detail: "foo" }; });
    const closed = await answerTask(V, c.id, "no", { deps: deps() });
    expect(closed.status).toBe("closed");
    // Off the open board, as dropped.
    expect(readFileSync(boardFile(V, closed.board!.space), "utf8")).toMatch(new RegExp(`- \\[x\\] .*~status:dropped ~id:${closed.board!.id}`));
    await expect(answerTask(V, c.id, "maybe", { deps: deps() })).rejects.toThrow(/answer yes, no/);
  });
});

describe("views and the CLI", () => {
  beforeEach(seed);
  async function cli(args: string[], d: WorkDeps = deps()): Promise<{ code: number; json: Record<string, unknown> }> {
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = ((s: string) => { buf += s; return true; }) as typeof process.stdout.write;
    try { const code = await workCommand([...args, "--json"], V, d); return { code, json: JSON.parse(buf.trim().split("\n").pop()!) }; } finally { process.stdout.write = orig; }
  }
  test("queue, backlog, show, settings and machines answer in JSON", async () => {
    const p = await addWork(V, "x", { deps: { ...deps(), runner: async () => threeGoals } });
    for (const t of p.tasks.slice(0, 2)) updateTask(V, t.id, (x) => { x.status = "done"; delete x.ask; });
    const q = await cli(["list"]);
    expect(q.code).toBe(0);
    expect((q.json.prompts as unknown[]).length).toBe(1);
    const b = await cli(["list", "--view", "backlog"]);
    expect((b.json.tasks as { prompt: { id: string } }[]).map((t) => t.prompt.id)).toEqual([p.id, p.id, p.id]);
    expect(listWork(V, "queue").prompts?.[0]?.tasks.length).toBe(3);
    const s = await cli(["show", p.tasks[0]!.id]);
    expect(s.json).toMatchObject({ ok: true, task: { id: p.tasks[0]!.id }, thread: { turns: 1 } });
    expect((s.json.job as { job: { id: string } }).job.id).toBe(p.tasks[0]!.jobId!);
    expect(showWork(V, p.id)).toMatchObject({ ok: true, prompt: { id: p.id } });
    expect((await cli(["settings", "--herdr", "on"])).json).toMatchObject({ ok: true, settings: { herdr: true, workspace: "Prevail" } });
    expect(readSettings(V).herdr).toBe(true);
    expect((await cli(["settings", "--herdr", "maybe"])).code).toBe(1);
    writeSettings(V, { herdr: false });
    const m = await cli(["machines"]);
    expect(m.json).toMatchObject({ ok: true, current: "laptop", machines: [{ id: "local", label: "laptop", current: true, herdr: "local" }] });
    expect(m.json.agentKinds).toContain("claude");
    expect((await cli(["show", "nope"])).json).toMatchObject({ ok: false });
    expect((await cli(["bogus"])).code).toBe(1);
    expect(readTask(V, p.tasks[2]!.id)?.task.status).toBe("needs-you");
  });  test("machine-add answers needs approval (exit 0) and machine-approve opens Terminal only with --yes", async () => {
    const q = quietHerdr();
    const refusing: Herdr = (args) => { if (args[0] === "machine" && args[1] === "add") throw new Error("herdr machine add failed: remote herdr server needs one final update before this client can attach; run from an interactive terminal to approve updating it"); return q(args); };
    const ran: string[][] = [];
    const d: WorkDeps = { ...deps(), herdrFor: () => refusing, terminal: (a) => { ran.push(a); } };
    const r = await cli(["machine-add", "--label", "mini-foo", "--target", "foo@mini-foo", "--yes"], d);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: false, needsApproval: true, label: "mini-foo" });
    expect((r.json.command as string[]).slice(1)).toEqual(["machine", "add", "--label", "mini-foo", "foo@mini-foo"]);
    expect((await cli(["machine-approve", "--label", "mini-foo", "--target", "foo@mini-foo"], d)).code).toBe(1);
    expect(ran).toEqual([]);
    const ok = await cli(["machine-approve", "--label", "mini-foo", "--target", "foo@mini-foo", "--yes"], d);
    expect(ok.json).toMatchObject({ ok: true });
    expect(ran.length).toBe(1);
  });
});

describe("the ordered queue", () => {
  beforeEach(seed);
  // Four foo tasks that may all start alone (find and plan shapes).
  const four = (tag: string) => JSON.stringify({ goals: [1, 2, 3, 4].map((n) => ({ text: `Foo ${tag}${n}`, tasks: [{ text: `Find foo ${tag}${n}`, dest: { kind: "domain", id: "fitness" }, confidence: 0.9, shape: "find" }] })) });
  const ids = () => (listWork(V, "queue").tasks ?? []).map((t) => t.id);
  const status = (id: string) => readTask(V, id)!.task.status;

  test("new tasks go to the end of the queue, and the order is kept in order.json", async () => {
    setChiefSetting(V, "handoff", "auto");
    const a = await addWork(V, "x", { deps: { ...deps(), runner: async () => threeGoals } });
    const b = await addWork(V, "y", { deps: { ...deps(), runner: async () => four("b") } });
    const all = [...a.tasks, ...b.tasks].map((t) => t.id);
    expect(ids()).toEqual(all);
    expect(readOrder(V)).toEqual(all);
    expect(existsSync(join(V, "build", "_meta", "work", "order.json"))).toBe(true);
    // Each row carries its prompt, like the backlog.
    expect(listWork(V, "queue").tasks?.[3]?.prompt.id).toBe(b.id);
    // Done and closed tasks leave the queue; the backlog keeps them.
    updateTask(V, all[0]!, (x) => { x.status = "done"; });
    stopTask(V, all[1]!, deps());
    expect(ids()).toEqual(all.slice(2));
    expect((listWork(V, "backlog").tasks ?? []).length).toBe(7);
    // A finished task that still asks something (keep or close its tab) stays until it is answered.
    updateTask(V, all[2]!, (x) => { x.status = "done"; x.ask = { kind: "keep-close", detail: "done; keep the Herdr tab open, or close it?" }; });
    expect(ids()).toEqual(all.slice(2));
    updateTask(V, all[2]!, (x) => { delete x.ask; });
    expect(ids()).toEqual(all.slice(3));
  });

  test("reorder moves a task before, after or to an index; bad targets fail", async () => {
    setChiefSetting(V, "handoff", "offer");
    const p = await addWork(V, "x", { deps: { ...deps(), runner: async () => four("r") } });
    const [a, b, c, d] = p.tasks.map((t) => t.id) as [string, string, string, string];
    expect(reorderTask(V, d, { before: a })).toEqual([d, a, b, c]);
    expect(reorderTask(V, d, { after: b })).toEqual([a, b, d, c]);
    expect(reorderTask(V, a, { index: 99 })).toEqual([b, d, c, a]);
    expect(reorderTask(V, a, { index: 0 })).toEqual([a, b, d, c]);
    expect(ids()).toEqual([a, b, d, c]);
    expect(() => reorderTask(V, a, { before: "nope" })).toThrow(/not in the queue/);
    expect(() => reorderTask(V, "nope", { index: 0 })).toThrow(/not in the queue/);
    expect(() => reorderTask(V, a, {})).toThrow(/say where/);
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = ((x: string) => { buf += x; return true; }) as typeof process.stdout.write;
    try { expect(await workCommand(["reorder", c, "--before", a, "--json"], V, deps())).toBe(0); } finally { process.stdout.write = orig; }
    expect(JSON.parse(buf.trim())).toEqual({ ok: true, order: [c, a, b, d] });
  });

  test("no more than maxRunning run at once; the rest wait as queued and start in queue order", async () => {
    setChiefSetting(V, "handoff", "auto");
    writeSettings(V, { maxRunning: 2 });
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(spawned), runner: async () => four("q") } });
    const [a, b, c, d] = p.tasks.map((t) => t.id) as [string, string, string, string];
    expect(p.tasks.map((t) => t.status)).toEqual(["running", "running", "queued", "queued"]);
    expect(spawned).toEqual([["work", "run", a], ["work", "run", b]]);
    // The user moves d ahead of c: d starts next.
    reorderTask(V, d, { before: c });
    // The run of a finishes (the board and thread update elsewhere); its process tops the queue up.
    updateTask(V, a, (x) => { x.status = "done"; });
    expect(await topUp(V, deps(spawned))).toEqual([d]);
    expect(status(d)).toBe("running");
    expect(status(c)).toBe("queued");
    // Still full: nothing more starts.
    expect(await topUp(V, deps(spawned))).toEqual([]);
    expect(spawned.at(-1)).toEqual(["work", "run", d]);
  });

  test("pausing frees a slot through the CLI; a task that needs you takes none", async () => {
    setChiefSetting(V, "handoff", "auto");
    writeSettings(V, { maxRunning: 1 });
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(spawned), runner: async () => four("p") } });
    const [a, b] = p.tasks.map((t) => t.id) as [string, string];
    expect(status(a)).toBe("running");
    expect(status(b)).toBe("queued");
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { expect(await workCommand(["pause", a, "--json"], V, deps(spawned))).toBe(0); } finally { process.stdout.write = orig; }
    expect(status(a)).toBe("paused");
    expect(status(b)).toBe("running");
    // b now needs the user: its slot frees for the next one, which the list tops up.
    updateTask(V, b, (x) => { x.status = "needs-you"; x.ask = { kind: "start", detail: "foo" }; });
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { await workCommand(["list", "--json"], V, deps(spawned)); } finally { process.stdout.write = orig; }
    expect(status(p.tasks[2]!.id)).toBe("running");
    // Paused tasks hold their place in the order.
    expect(ids().slice(0, 2)).toEqual([a, b]);
  });

  test("work add --hold parks the tasks in the backlog; start moves one to the end of the queue", async () => {
    setChiefSetting(V, "handoff", "auto");
    const spawned: string[][] = [];
    const a = await addWork(V, "x", { deps: { ...deps(spawned), runner: async () => four("a") } });
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = ((x: string) => { buf += x; return true; }) as typeof process.stdout.write;
    try { expect(await workCommand(["add", "--hold", "--text", "foo ideas", "--json"], V, { ...deps(spawned), runner: async () => four("h") })).toBe(0); } finally { process.stdout.write = orig; }
    const held = (JSON.parse(buf.trim().split("\n").pop()!) as { prompt: { tasks: { id: string; status: string; ask?: unknown }[] } }).prompt.tasks;
    // Routed and filed, never started, not in the queue, no slot taken.
    expect(held.map((t) => t.status)).toEqual(["backlog", "backlog", "backlog", "backlog"]);
    expect(held.every((t) => !t.ask)).toBe(true);
    expect(ids()).toEqual(a.tasks.map((t) => t.id));
    expect(readOrder(V)).toEqual(a.tasks.map((t) => t.id));
    expect(spawned.filter((c) => held.some((t) => c.includes(t.id)))).toEqual([]);
    expect((listWork(V, "backlog").tasks ?? []).filter((t) => t.status === "backlog").length).toBe(4);
    // A topUp never starts a parked task.
    updateTask(V, a.tasks[0]!.id, (x) => { x.status = "done"; });
    await topUp(V, deps(spawned));
    expect(held.map((t) => status(t.id))).toEqual(["backlog", "backlog", "backlog", "backlog"]);
    // Start moves it to the end of the queue, where it starts in turn (three slots: a2, a3, a4 run, so it waits).
    const moved = await startTask(V, held[1]!.id, { deps: deps(spawned) });
    expect(moved.status).toBe("queued");
    expect(ids()).toEqual([...a.tasks.slice(1).map((t) => t.id), held[1]!.id]);
    expect(moved.log.map((l) => l.ev)).toContain("moved to the queue");
    // A freed slot starts it.
    pauseTask(V, a.tasks[1]!.id, deps(spawned));
    await topUp(V, deps(spawned));
    expect(status(held[1]!.id)).toBe("running");
    // A parked task that needs a yes asks once it is in the queue, as a new one would.
    setChiefSetting(V, "handoff", "offer");
    const asked = await startTask(V, held[2]!.id, { deps: deps(spawned) });
    expect(asked).toMatchObject({ status: "needs-you", ask: { kind: "start" } });
    expect(ids().at(-1)).toBe(held[2]!.id);
  });

  test("settings take --max-running from 1 to 20", async () => {
    expect(readSettings(V).maxRunning).toBe(3);
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = ((x: string) => { buf += x; return true; }) as typeof process.stdout.write;
    try {
      expect(await workCommand(["settings", "--max-running", "5", "--json"], V, deps())).toBe(0);
      expect(await workCommand(["settings", "--max-running", "0", "--json"], V, deps())).toBe(1);
      expect(await workCommand(["reorder", "nope", "--to", "0", "--json"], V, deps())).toBe(1);
    } finally { process.stdout.write = orig; }
    expect(readSettings(V).maxRunning).toBe(5);
    expect(buf).toContain("\"maxRunning\":5");
  });
});
