import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createMission } from "./missions.ts";
import { crewPaths } from "./work-crew.ts";
import { CREW_NUDGE, addMachine, agentKinds, findTaskWorkspace, approveInTerminal, askingQuestion, ownerAsk, shellQuote, terminalArgv, buildBrief, closeTask, focusTask, glyphLine, headlessArgs, herdrWorkspaces, hostKey, launchTask, machines, mirrorTask, newText, stripChrome, afterBrief, BRIEF_END, reopenTask, writeMachineRecord } from "./herdr-work.ts";
import type { Herdr } from "./spaces.ts";
import { addWork, continueTask, doneTask, followUp, isCloseYes, WORKING_LINE, pauseTask, queueTasks, readTask, reconcileWork, routeTask, updateTask, writeSettings, type WorkDeps, type WorkTask } from "./work.ts";

const ROOT = join("/tmp", `prevail-herdr-work-${process.pid}`);
const V = join(ROOT, "vault");
const GLYPH = join(ROOT, "glyph");
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
  for (const d of ["general", "insurance", "money"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), ".prevail-layout-v4"), "v4\n");
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d } }));
  }
  writeSettings(V, { herdr: true, workspace: "Foo Work" });
}

/** A fake herdr: records every call as [machine, ...argv] and keeps a little state (workspaces it made, screens, agent states). */
function fakeHerdr(o: { workspaces?: { workspace_id: string; label: string; cwd?: string }[]; saved?: { id: string; label: string; enabled?: boolean }[]; reads?: string[]; statuses?: string[]; screens?: string[]; panes?: unknown[]; tabsLeft?: number; startFails?: boolean; promptBlockedOnce?: boolean } = {}) {
  const calls: string[][] = [];
  const reads = [...(o.reads ?? ["working on foo"])];
  const statuses = [...(o.statuses ?? ["idle", "done"])];
  const screens = [...(o.screens ?? [""])];
  const workspaces = [...(o.workspaces ?? [])];
  let prompts = 0;
  let n = 0;
  const forMachine = (m: string): Herdr => (args) => {
    calls.push([m, ...args]);
    const [a, b] = args;
    if (a === "--version") return "herdr 0.0.0";
    if (a === "machine" && b === "list") return o.saved ?? [];
    if (a === "machine" && b === "add") return "saved";
    if (a === "agent" && b === "start" && o.startFails && args[2] !== "--help") throw new Error('herdr agent start failed: {"error":{"code":"agent_not_ready"}}');
    if (a === "agent" && b === "start" && args[2] === "--help") return "Usage...\n  [possible values: pi, claude, codex, gemini]";
    // The brief goes in; the next prompt meets a menu once (agent_blocked).
    if (a === "agent" && b === "prompt" && ++prompts === 2 && o.promptBlockedOnce) throw new Error('herdr agent prompt failed: {"error":{"code":"agent_blocked"}}');
    if (a === "workspace" && b === "list") return { workspaces };
    if (a === "workspace" && b === "create") { workspaces.push({ workspace_id: "wnew", label: args[args.indexOf("--label") + 1]! }); return { workspace: { workspace_id: "wnew" }, tab: { tab_id: "wnew:t1" }, root_pane: { pane_id: "wnew:p1" } }; }
    if (a === "tab" && b === "create") { n++; return { tab: { tab_id: `w1:t${n}` }, root_pane: { pane_id: `w1:p${n}` } }; }
    if (a === "tab" && b === "list") return { tabs: Array.from({ length: o.tabsLeft ?? 0 }, (_, i) => ({ tab_id: `x${i}` })) };
    if (a === "pane" && b === "list") return { panes: o.panes ?? [] };
    if (a === "pane" && b === "read") return { text: screens.length > 1 ? screens.shift() : screens[0] };
    if (a === "agent" && b === "read") return { text: reads.length > 1 ? reads.shift() : reads[0] };
    if (a === "agent" && b === "get") return { agent: { agent_status: statuses.length > 1 ? statuses.shift() : statuses[0] } };
    return {};
  };
  return { calls, forMachine };
}

function deps(h: ReturnType<typeof fakeHerdr>, spawned: string[][] = [], o: { glyph?: boolean; runner?: WorkDeps["runner"] } = {}): WorkDeps {
  return {
    runner: o.runner ?? null,
    sleep: () => {},
    glyph: () => !!o.glyph,
    spawnSelf: (a) => { spawned.push(a); },
    herdrFor: (m) => h.forMachine(m),
    machine: { host: "laptop", role: "hub", env: { GLYPH_SPACES: GLYPH, PREVAIL_MACHINE: "laptop", GLYPH_AGENTS: join(ROOT, "no-agents.tsv") } },
    settingsPath: () => "/tmp/foo-act-gate.json",
    worktreeRoot: join(ROOT, "trees"),
  };
}

const oneTask = (kind = "claude", machine?: string, text = "Find the best foo carrier for the rentals") => JSON.stringify({ goals: [{ text: "Cover the foo rentals", tasks: [{ name: "Foo Carrier", text, dest: { kind: "domain", id: "insurance" }, confidence: 0.9, shape: "find", ...(kind !== "claude" ? { agent: kind } : {}), ...(machine ? { machine, effort: "deep" } : {}) }] }] });
const mutating = (calls: string[][]) => calls.filter((c) => ["create", "close", "start", "prompt", "send-keys", "add", "run", "rename", "focus"].includes(c[2] ?? "") && c[3] !== "--help");
const HEADLESS_CLAUDE = ["--dangerously-skip-permissions", "--settings", "/tmp/foo-act-gate.json", "--disallowedTools", "AskUserQuestion"];
// A crew task's Claude settings: the act gate plus its Stop hook, in this Mac's own folder (here, the test config dir).
const crewSettings = (id: string) => join(ROOT, "config", "work", id, "settings.json");
const crewClaude = (id: string) => ["--dangerously-skip-permissions", "--settings", crewSettings(id), "--disallowedTools", "AskUserQuestion"];
/** A record from before shapes (no scout or ship): it runs as it always did. */
const legacy = (id: string) => updateTask(V, id, (x) => { delete x.crew; });

describe("machines and agent kinds", () => {
  beforeEach(seed);
  test("this Mac, its saved Herdr machines, other Macs' records and the Glyph map, merged by label", () => {
    mkdirSync(GLYPH, { recursive: true });
    writeFileSync(join(GLYPH, "machines.json"), JSON.stringify({ machines: { "studio-foo": { role: "hub", tag: "sf", roots: { mono: "~/code" } }, laptop: { tag: "laptop" } } }));
    const h = fakeHerdr({ saved: [{ id: "m1", label: "mini-foo" }, { id: "m2", label: "old-foo", enabled: false }] });
    mkdirSync(join(V, "build", "_meta", "machines"), { recursive: true });
    writeFileSync(join(V, "build", "_meta", "machines", "mini-foo.json"), JSON.stringify({ hostname: "mini-foo", label: "mini-foo", role: "hub", herdrVersion: "0.0.0", vaultRoot: "/tmp/foo-vault", homeRoot: "/tmp/foo-home", herdrMachines: [], lastSeen: 1 }));
    writeFileSync(join(V, "build", "_meta", "machines", "air-foo.json"), JSON.stringify({ hostname: "air-foo", label: "air-foo", role: "client", herdrVersion: null, vaultRoot: "/tmp/v2", homeRoot: "/tmp/h2", herdrMachines: [], lastSeen: 2 }));
    const ms = machines(V, { herdr: h.forMachine("local"), host: "laptop", role: "hub", env: { GLYPH_SPACES: GLYPH } });
    expect(ms.map((m) => [m.label, m.herdr, m.current])).toEqual([["laptop", "local", true], ["mini-foo", "saved", false], ["old-foo", "disabled", false], ["air-foo", "missing", false], ["sf", "missing", false]]);
    expect(ms[1]).toMatchObject({ id: "m1", role: "hub", vaultRoot: "/tmp/foo-vault" });
    const rec = writeMachineRecord(V, { herdr: h.forMachine("local"), host: "laptop", role: "hub", env: { GLYPH_SPACES: GLYPH } });
    expect(rec).toMatchObject({ hostname: "laptop", label: "laptop", herdrVersion: "0.0.0", herdrMachines: ["mini-foo", "old-foo"], vaultRoot: V });
    expect(JSON.parse(readFileSync(join(V, "build", "_meta", "machines", "laptop.json"), "utf8")).label).toBe("laptop");
    expect(hostKey("Foo-Laptop.local")).toBe("foo-laptop");
  });
  test("agent kinds come from herdr's own help", () => {
    expect(agentKinds(fakeHerdr().forMachine("local"), true)).toEqual(["pi", "claude", "codex", "gemini"]);
    expect(agentKinds((() => { throw new Error("no herdr"); }) as Herdr, true)).toContain("claude");
    agentKinds(fakeHerdr().forMachine("local"), true);
  });
  test("adding a machine checks the label and the SSH target", () => {
    const h = fakeHerdr();
    expect(addMachine("mini-foo", "foo@mini-foo", h.forMachine("local"))).toMatchObject({ ok: true, output: "saved" });
    expect(h.calls.at(-1)).toEqual(["local", "machine", "add", "--label", "mini-foo", "foo@mini-foo"]);
    expect(() => addMachine("x", "-oProxyCommand=foo")).toThrow(/SSH target/);
    expect(() => addMachine("bad label", "foo@x")).toThrow(/label/);
  });
  test("a remote Herdr that needs its update is a clear needs-approval answer, approved in Terminal", () => {
    const refuse: Herdr = () => { throw new Error("herdr machine add failed: remote herdr server on mini-foo needs one final update before this client can attach; run from an interactive terminal to approve updating it"); };
    const r = addMachine("mini-foo", "foo@mini-foo", refuse);
    expect(r).toMatchObject({ ok: false, needsApproval: true, label: "mini-foo", target: "foo@mini-foo" });
    expect(!r.ok && r.command.slice(1)).toEqual(["machine", "add", "--label", "mini-foo", "foo@mini-foo"]);
    // Any other failure stays a failure.
    expect(() => addMachine("mini-foo", "foo@mini-foo", () => { throw new Error("herdr machine add failed: no route to host"); })).toThrow(/no route/);
    // Approve: Terminal runs exactly that argv, each word shell-quoted, inside one AppleScript string.
    const ran: string[][] = [];
    const ok = approveInTerminal("mini-foo", "foo@mini-foo", (a) => { ran.push(a); });
    expect(ok.command.slice(1)).toEqual(["machine", "add", "--label", "mini-foo", "foo@mini-foo"]);
    expect(ran[0]!.filter((_, i) => i % 2 === 1)).toEqual(['tell application "Terminal"', "activate", expect.stringMatching(/^do script ".* machine add --label mini-foo foo@mini-foo"$/), "end tell"]);
    // Nothing else gets in: a label or target that is not plain is refused before Terminal opens.
    expect(() => approveInTerminal("foo; rm", "foo@x", (a) => { ran.push(a); })).toThrow(/label/);
    expect(() => approveInTerminal("foo", "x\" & y", (a) => { ran.push(a); })).toThrow(/SSH target/);
    expect(ran.length).toBe(1);
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
    expect(terminalArgv(["/tmp/foo bar/herdr", "x"])[5]).toBe(`do script "'/tmp/foo bar/herdr' x"`);
    expect(terminalArgv(['a"b'])[5]).toBe(`do script "'a\\"b'"`);
  });
});

describe("a task in a Herdr tab: found or made, one tab per task, headless, never asking", () => {
  beforeEach(seed);
  test("a task with no home goes to the one shared Work workspace, made once; each task gets its own tab there", async () => {
    const h = fakeHerdr({ statuses: ["idle"] });
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => oneTask() } });
    const t = p.tasks[0]!;
    expect(t).toMatchObject({ executor: "herdr", status: "running", name: "Foo Carrier" });
    expect(spawned).toEqual([["work", "run", t.id]]);
    const run = await launchTask(V, t.id, deps(h, spawned));
    expect(run.ask).toBeUndefined();
    const m = mutating(h.calls);
    expect(m[0]!.slice(0, 7)).toEqual(["local", "workspace", "create", "--label", "Work", "--cwd", D("insurance")]);
    expect(m[0]).toContain("--no-focus");
    expect(m[0]).toContain(`PREVAIL_THREAD_ID=${t.thread.session}`);
    expect(m[1]).toEqual(["local", "tab", "rename", "wnew:t1", "Foo Carrier"]);
    // Headless: Claude skips its approval prompts and its ask tool, and keeps Prevail's act-gate hook.
    expect(m[2]).toEqual(["local", "agent", "start", expect.stringMatching(/^foo-carrier-\d+$/), "--kind", "claude", "--pane", "wnew:p1", "--", ...crewClaude(t.id)]);
    expect(m[3]).toEqual(["local", "pane", "rename", "wnew:p1", "Foo Carrier"]);
    expect(m[4]!.slice(0, 4)).toEqual(["local", "agent", "prompt", "wnew:p1"]);
    expect(m[4]![4]).toContain("Task: Find the best foo carrier for the rentals");
    expect(m[4]![4]).toContain("Never ask the user a question");
    expect(m[4]![4]).toContain("Draft, never send");
    expect(run).toMatchObject({ status: "running", herdr: { workspaceLabel: "Work", workspaceId: "wnew", tabId: "wnew:t1", createdWorkspace: true, createdTab: true } });
    expect(JSON.parse(readFileSync(join(V, "build", "_meta", "work", "herdr.json"), "utf8"))).toEqual({ links: { laptop: { insurance: "Work" } }, created: { laptop: ["wnew"] } });
    expect(spawned.at(-1)).toEqual(["work", "mirror", t.id]);
    // A second task: a new tab in the shared workspace, never a second workspace.
    const q = await addWork(V, "y", { deps: { ...deps(h, spawned), runner: async () => oneTask("claude", undefined, "Compare foo carrier quotes") } });
    const second = await launchTask(V, q.tasks[0]!.id, deps(h, spawned));
    expect(mutating(h.calls).filter((c) => c[1] === "workspace" && c[2] === "create").length).toBe(1);
    expect(second.herdr).toMatchObject({ workspaceId: "wnew", tabId: "w1:t1", createdTab: true });
    expect(mutating(h.calls).find((c) => c[1] === "tab" && c[2] === "create")).toContain("wnew");
  });
  test("an open workspace is found by the destination's name, or by a link saved earlier", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "insurance" }], statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    await launchTask(V, p.tasks[0]!.id, deps(h));
    const m = mutating(h.calls);
    expect(m.some((c) => c[1] === "workspace" && c[2] === "create")).toBe(false);
    expect(m[0]).toEqual(["local", "tab", "create", "--workspace", "w1", "--cwd", D("insurance"), "--label", "Foo Carrier", "--env", "PREVAIL_DOMAIN=insurance", "--env", `PREVAIL_THREAD_ID=${p.tasks[0]!.thread.session}`, "--no-focus"]);
    mkdirSync(join(V, "build", "_meta", "work"), { recursive: true });
    writeFileSync(join(V, "build", "_meta", "work", "herdr.json"), JSON.stringify({ links: { laptop: { insurance: "Foo Desk" } } }));
    const h2 = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }, { workspace_id: "w9", label: "Foo Desk" }], statuses: ["idle"] });
    const q = await addWork(V, "y", { deps: { ...deps(h2), runner: async () => oneTask() } });
    expect((await launchTask(V, q.tasks[0]!.id, deps(h2))).herdr).toMatchObject({ workspaceId: "w9", workspaceLabel: "Foo Desk", createdWorkspace: false });
  });
  test("with Glyph, the agent's command is typed into the tab's shell, named and headless; without it, herdr agent start", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const r = await launchTask(V, p.tasks[0]!.id, deps(h, [], { glyph: true }));
    const m = mutating(h.calls);
    expect(m.find((c) => c[2] === "start")).toBeUndefined();
    expect(m.find((c) => c[1] === "pane" && c[2] === "run")).toEqual(["local", "pane", "run", "w1:p1", `claude -n 'Foo Carrier' --dangerously-skip-permissions --settings ${crewSettings(p.tasks[0]!.id)} --disallowedTools AskUserQuestion`]);
    // A task from before shapes keeps the act gate's own settings file.
    const old = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    legacy(old.tasks[0]!.id);
    await launchTask(V, old.tasks[0]!.id, deps(h, [], { glyph: true }));
    expect(mutating(h.calls).filter((c) => c[1] === "pane" && c[2] === "run").at(-1)![4]).toContain(HEADLESS_CLAUDE.join(" "));
    expect(r.herdr).toMatchObject({ glyph: true, agent: "w1:p1" });
    // Codex: through Glyph by a bare label word, sandboxed with no approvals, no act gate (its hook is Claude's).
    const hc = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["idle"] });
    const c = await addWork(V, "y", { deps: { ...deps(hc), runner: async () => oneTask("codex") } });
    expect(c.tasks[0]!.status).toBe("running");
    await launchTask(V, c.tasks[0]!.id, deps(hc, [], { glyph: true }));
    expect(mutating(hc.calls).find((x) => x[2] === "run")![4]).toBe("codex foo-carrier --ask-for-approval never --sandbox workspace-write");
    const hn = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["idle"] });
    const n = await addWork(V, "z", { deps: { ...deps(hn), runner: async () => oneTask("codex") } });
    await launchTask(V, n.tasks[0]!.id, deps(hn));
    expect(mutating(hn.calls).find((x) => x[2] === "start")).toEqual(["local", "agent", "start", expect.any(String), "--kind", "codex", "--pane", "w1:p1", "--", "--ask-for-approval", "never", "--sandbox", "workspace-write"]);
    expect(headlessArgs("claude", null)).toEqual(["--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion"]);
    expect(headlessArgs("claude", null, undefined, false)).toEqual(["--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion", "WebSearch", "WebFetch"]);
    expect(glyphLine("gemini", "Foo Carrier", ["--yolo"])).toBe("gemini --yolo");
  });
  test("a trust question is answered by itself; an agent that is still not ready gets its brief from the mirror", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["", "idle"], screens: ["Do you trust the files in this folder?\n> 1. Yes, proceed\n  2. No, exit"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const r = await launchTask(V, p.tasks[0]!.id, deps(h, [], { glyph: true }));
    expect(h.calls.some((c) => c[1] === "pane" && c[2] === "send-keys" && c[4] === "enter")).toBe(true);
    expect(mutating(h.calls).some((c) => c[2] === "prompt")).toBe(true);
    expect(r.herdr?.briefPending).toBeUndefined();
    // Blocked on something it cannot answer: no question for the user here; the mirror sends the brief once it is idle.
    const hb = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["blocked"], screens: ["Foo needs something"] });
    const q = await addWork(V, "y", { deps: { ...deps(hb), runner: async () => oneTask() } });
    legacy(q.tasks[0]!.id);
    const b = await launchTask(V, q.tasks[0]!.id, deps(hb));
    expect(b).toMatchObject({ status: "running", herdr: { briefPending: true } });
    expect(b.ask).toBeUndefined();
    expect(mutating(hb.calls).some((c) => c[2] === "prompt")).toBe(false);
    const hm = fakeHerdr({ statuses: ["idle", "done"], reads: ["", `${BRIEF_END}\n\nFoo carrier A is the cheapest; a draft quote request is in the thread.`] });
    const done = await mirrorTask(V, q.tasks[0]!.id, deps(hm), { maxRounds: 4, waitMs: 1 });
    expect(mutating(hm.calls).filter((c) => c[2] === "prompt").length).toBe(1);
    expect(done.status).toBe("done");
    expect(done.log.map((l) => l.ev)).toContain("briefed");
  });
  test("a saved remote machine gets every call through --machine; one Herdr cannot reach runs here instead", async () => {
    const h = fakeHerdr({ saved: [{ id: "m1", label: "mini-foo" }], workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask("claude", "mini-foo") } });
    const t = p.tasks[0]!;
    expect(t.machine).toBe("mini-foo");
    const r = await launchTask(V, t.id, deps(h));
    const m = mutating(h.calls);
    expect(m.every((c) => c[0] === "m1")).toBe(true);
    // The act-gate hook file lives on this Mac: no --settings on another one.
    expect(m.find((c) => c[2] === "start")).not.toContain("--settings");
    expect(r.log.some((l) => l.ev === "no act gate")).toBe(true);
    // Its Herdr goes away: the next launch runs on this Mac, without asking.
    const gone = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["idle"] });
    updateTask(V, t.id, (x) => { delete x.herdr; });
    const here = await launchTask(V, t.id, deps(gone));
    expect(here.machine).toBe("laptop");
    expect(here.ask).toBeUndefined();
    expect(mutating(gone.calls).every((c) => c[0] === "local")).toBe(true);
  });
});

describe("mirror, follow up, check off, close and reopen", () => {
  beforeEach(seed);
  // These tasks are records from before shapes: the agent settles with its words, as it always did. Crew tasks are below.
  async function running(h: ReturnType<typeof fakeHerdr>, spawned: string[][] = [], runner = oneTask()) {
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => runner } });
    legacy(p.tasks[0]!.id);
    return launchTask(V, p.tasks[0]!.id, deps(h, spawned));
  }
  test("the mirror appends only new text, notes what the agent does in plain words, and ends done with an outcome", async () => {
    const h = fakeHerdr({ statuses: ["idle", "working", "done"], reads: ["Looking at foo carriers\n⏺ Read(data/foo/policy.md)", "Looking at foo carriers\n⏺ Read(data/foo/policy.md)\n⏺ gmail - search_threads (MCP)(query: \"foo\")\nSummary:\nCarrier A is cheapest for both foo rentals. A draft quote request is ready."] });
    const t = await running(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 5, waitMs: 1 });
    const md = readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.md`), "utf8");
    expect(md.match(/Looking at foo carriers/g)!.length).toBe(1);
    expect(r.log.filter((l) => l.ev === "activity").map((l) => l.detail)).toEqual(["Reading policy.md", "Reading your Gmail"]);
    expect(r.log.find((l) => l.ev === "activity")!.more).toContain("Read(data/foo/policy.md)");
    expect(r).toMatchObject({ status: "done", cleared: false, outcome: "Carrier A is cheapest for both foo rentals. A draft quote request is ready." });
    expect(r.ask).toBeUndefined();
    expect(r.lease).toBeUndefined();
    // The tab stays open; nothing asks keep or close.
    expect(mutating(h.calls).some((c) => c[2] === "close")).toBe(false);
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toMatch(/- \[x\]/);
    expect(newText("abc", "abcdef")).toBe("def");
  });
  test("a long run says its milestones in a sentence each, distilled from the agent's progress, never its raw output", async () => {
    const r1 = "\u23fa Read(data/foo/policy.md)\nI found three foo carriers that cover both rentals.";
    const r2 = `${r1}\n\u23fa Write(drafts/foo.md)\nI drafted the foo quote request for carrier A.`;
    const h = fakeHerdr({ statuses: ["idle", "working", "working", "done"], reads: [r1, r2, `${r2}\nSummary:\nCarrier A is cheapest for both foo rentals.`] });
    const t = await running(h);
    let clock = Date.now();
    const r = await mirrorTask(V, t.id, { ...deps(h), now: () => (clock += 10 * 60_000) }, { maxRounds: 5, waitMs: 1 });
    expect(r.updates!.filter((u) => u.milestone).map((u) => u.text)).toEqual(["I found three foo carriers that cover both rentals.", "I drafted the foo quote request for carrier A."]);
    expect(r.updates!.some((u) => /\u23fa|Read\(|Write\(/.test(u.text))).toBe(false);
    expect(r.status).toBe("done");
  });
  test("an agent Herdr will not read while it works is alive: the mirror waits for its pause, never says the tab closed", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: ["Summary:\nThe foo policy renews in May."] });
    const t = await running(h);
    let busy = true;
    const live = { ...deps(h), herdrFor: (m: string) => { const f = h.forMachine(m); return (args: string[]) => { if (busy && args.includes("read") && args.includes("agent")) { busy = false; throw new Error('herdr agent read failed: {"error":{"code":"agent_not_idle"}}'); } return f(args); }; } };
    const r = await mirrorTask(V, t.id, live, { maxRounds: 3, waitMs: 1 });
    expect(r.status).toBe("done");
    expect(r.outcome).toBe("The foo policy renews in May.");
    expect(r.log.some((l) => l.ev === "mirror ended")).toBe(false);
  });
  test("a reply that hands a choice back is Needs you with its result, never Done", async () => {
    const end = "Foo Lake, Nov 13 to 15, about 430 foo dollars.\n\nWaiting on you:\n1. Pick a destination and a weekend.\n2. Approve booking.";
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [end] });
    const t = await running(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 2, waitMs: 1 });
    expect(r.status).toBe("needs-you");
    expect(r.waiting).toBe("Waiting on you: pick a destination and a weekend; approve booking.");
    expect(r.outcome).toBeTruthy();
    expect(r.updates!.some((u) => u.text.startsWith("Done"))).toBe(false);
    expect(ownerAsk("Two foo hotels compared.\n\nPick one and I will hold it.")).toBe("Pick one and I will hold it.");
    // The owner's own errands in a summary are not a question back: that summary is done.
    expect(ownerAsk("The foo claim is 85% paid.\n\nWaiting on you:\n1. Notarizing and sending the foo form.\n2. Paying the foo contractor.")).toBeNull();
    expect(ownerAsk("Drafted the foo reply; it is in your drafts.\n\nNext steps:\n1. Review it.")).toBeNull();
    // Only the latest reply counts: after the owner's answer, a finished reply is done.
    expect(ownerAsk(`${end}\n❯ Foo Lake, the 13th\nBooked nothing; Foo Lake hold drafted for the 13th.`)).toBeNull();
  });
  test("an agent asking something is never done: it needs you with the question; the follow-up answers it", async () => {
    const menu = "Where are you right now?\n❯ 1. Home\n  2. Work\nEnter to select · Esc to cancel";
    const h = fakeHerdr({ statuses: ["idle", "blocked", "blocked"], reads: ["Looking for foo dinner spots", `Looking for foo dinner spots\n${menu}`], promptBlockedOnce: true });
    const t = await running(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 2, waitMs: 1 });
    expect(r).toMatchObject({ status: "needs-you", waiting: "Where are you right now?" });
    expect(r.ask).toBeUndefined();
    // The answer goes to that agent: the menu is closed first (it was blocked), then the words land.
    const f = await followUp(V, t.id, "Home, in Fooville", { deps: deps(h) });
    expect(f.task.status).toBe("running");
    const sent = mutating(h.calls).slice(-3);
    expect(sent.map((c) => c.slice(1, 3).join(" "))).toEqual(["agent prompt", "agent send-keys", "agent prompt"]);
    expect(sent[2]![4]).toBe("Home, in Fooville");
    expect(askingQuestion("All done. The draft is in the thread.")).toBeNull();
    expect(askingQuestion("Which one should I book?")).toBe("Which one should I book?");
  });
  test("a follow-up on finished work goes to its open tab; a shift renames it everywhere; other work becomes its own task", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [`${BRIEF_END}\n\nSummary:\nFoo carrier A is cheapest overall.`] });
    const spawned: string[][] = [];
    const t = await running(h, spawned);
    await mirrorTask(V, t.id, deps(h), { maxRounds: 3, waitMs: 1 });
    const judge = (kind: string, name: string) => async (req: { system: string }) => (req.system.includes("already has a short name") ? JSON.stringify({ kind, name }) : oneTask("claude", undefined, "Call the foo bank about the fee"));
    const r = await followUp(V, t.id, "Also get quotes for the second foo unit", { deps: deps(h, spawned, { runner: judge("rename", "Foo Carrier Quotes") }) });
    expect(r.renamed).toBe("Foo Carrier Quotes");
    expect(r.task).toMatchObject({ status: "running", name: "Foo Carrier Quotes" });
    expect(r.task.log.find((l) => l.ev === "renamed")?.detail).toBe("Renamed to Foo Carrier Quotes");
    expect(mutating(h.calls).filter((c) => c[2] === "rename").map((c) => c.slice(1, 4))).toEqual(expect.arrayContaining([["tab", "rename", "wnew:t1"], ["pane", "rename", "wnew:p1"], ["agent", "rename", "wnew:p1"]]));
    expect(mutating(h.calls).filter((c) => c[2] === "prompt").at(-1)![4]).toBe("Also get quotes for the second foo unit");
    expect(spawned.at(-1)).toEqual(["work", "mirror", t.id]);
    // Recorded in the thread as the user's words.
    expect(readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.md`), "utf8")).toContain("Also get quotes for the second foo unit");
    // Really other work: a new task in the same work, with its own name.
    const s = await followUp(V, t.id, "And call the foo bank about the fee", { deps: deps(h, spawned, { runner: judge("new", "Foo Bank Call") }) });
    expect(s.added?.length).toBe(1);
    expect(s.added![0]!).toMatchObject({ promptId: t.promptId, name: "Foo Bank Call" });
    expect(s.added![0]!.id).toBe(`${t.promptId}-2`);
    expect(s.task.log.at(-1)).toMatchObject({ ev: "split", detail: "Became its own task: Foo Bank Call" });
    // The parent stays open as it was, and the two link both ways.
    expect(s.task.status).toBe("running");
    expect(s.task.children).toEqual([s.added![0]!.id]);
    expect(s.task.updates!.at(-1)).toMatchObject({ from: "task", link: s.added![0]!.id });
    expect(queueTasks(V).find((x) => x.task.id === s.added![0]!.id)?.task.parentId).toBe(t.id);
    expect(queueTasks(V).some((x) => x.task.id === t.id)).toBe(true);
  });
  test("a finished task never closes itself: it says what came of it, never asks to close, and stays with its tab", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [`${BRIEF_END}\n\nSummary:\nFoo carrier A is cheapest overall.`] });
    const t = await running(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 3, waitMs: 1 });
    expect(r).toMatchObject({ status: "done", cleared: false });
    expect(r.updates?.map((u) => [u.from, u.text])).toEqual([["task", WORKING_LINE], ["task", "Done: Foo carrier A is cheapest overall."]]);
    expect(queueTasks(V).some((x) => x.task.id === t.id)).toBe(true);
    expect(mutating(h.calls).some((c) => c[2] === "close")).toBe(false);
  });
  test("saying close in a reply closes the finished task and its tab", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [`${BRIEF_END}\n\nSummary:\nFoo carrier A is cheapest overall.`], tabsLeft: 0 });
    const t = await running(h);
    await mirrorTask(V, t.id, deps(h), { maxRounds: 3, waitMs: 1 });
    const f = await followUp(V, t.id, "Go ahead and close it", { deps: deps(h) });
    expect(f.closed).toBe(true);
    expect(f.task).toMatchObject({ status: "done", cleared: true });
    expect(f.task.updates?.at(-1)).toMatchObject({ from: "you", text: "Go ahead and close it" });
    expect(mutating(h.calls).some((c) => c[1] === "tab" && c[2] === "close")).toBe(true);
    expect(queueTasks(V).some((x) => x.task.id === t.id)).toBe(false);
  });
  test("any other reply to a finished task goes on with the work", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [`${BRIEF_END}\n\nSummary:\nFoo carrier A is cheapest overall.`] });
    const spawned: string[][] = [];
    const t = await running(h, spawned);
    await mirrorTask(V, t.id, deps(h), { maxRounds: 3, waitMs: 1 });
    const f = await followUp(V, t.id, "Continue, and add the foo deductible", { deps: deps(h, spawned) });
    expect(f.closed).toBeUndefined();
    expect(f.task.status).toBe("running");
    expect(f.task.updates?.slice(-2).map((u) => [u.from, u.text])).toEqual([["you", "Continue, and add the foo deductible"], ["task", WORKING_LINE]]);
    expect(mutating(h.calls).filter((c) => c[2] === "prompt").at(-1)![4]).toBe("Continue, and add the foo deductible");
    expect(mutating(h.calls).some((c) => c[1] === "tab" && c[2] === "close")).toBe(false);
  });
  test("done or close in a reply is told apart from a follow-up", () => {
    for (const y of ["Yes, close it.", "Go ahead and close it", "close it please", "done", "Done, thanks", "that's it", "You can close it"]) expect([y, isCloseYes(y)]).toEqual([y, true]);
    for (const n of ["Continue", "no", "yes", "go ahead", "ok thanks", "don't close it", "not yet", "yes but add the foo deductible", "keep it open", "what did it cost?", "close the foo account", "Close the foo account at the bank and then email Sam about it"]) expect([n, isCloseYes(n)]).toEqual([n, false]);
  });
  test("checking a task off marks it done, closes its tab and takes it out of the queue", async () => {
    const h = fakeHerdr({ tabsLeft: 0 });
    const t = await running(h);
    const d = doneTask(V, t.id, deps(h));
    expect(d).toMatchObject({ status: "done", cleared: true });
    expect(d.herdr?.tabId).toBeUndefined();
    expect(mutating(h.calls).slice(-2)).toEqual([["local", "tab", "close", "wnew:t1"], ["local", "workspace", "close", "wnew"]]);
    expect(queueTasks(V).some((x) => x.task.id === t.id)).toBe(false);
  });
  test("Open in Herdr focuses the task's tab and agent", async () => {
    const h = fakeHerdr();
    const t = await running(h);
    focusTask(V, t.id, deps(h));
    expect(h.calls.slice(-2)).toEqual([["local", "tab", "focus", "wnew:t1"], ["local", "agent", "focus", "wnew:p1"]]);
  });
  test("pause sends esc; close shuts the tab and the workspace Prevail made when it is empty; reopen comes back with the history", async () => {
    const h = fakeHerdr();
    const spawned: string[][] = [];
    const t = await running(h, spawned);
    pauseTask(V, t.id, deps(h));
    expect(h.calls.at(-1)).toEqual(["local", "agent", "send-keys", t.herdr!.agent!, "esc"]);
    updateTask(V, t.id, (x) => { x.herdr!.lastRead = "foo tail"; });
    const c = closeTask(V, t.id, deps(h));
    const m = mutating(h.calls);
    expect(m.slice(-2)).toEqual([["local", "tab", "close", "wnew:t1"], ["local", "workspace", "close", "wnew"]]);
    expect(c.status).toBe("closed");
    expect(c.herdr).toEqual({ machine: "laptop", workspaceLabel: "Work", workspaceId: "wnew", createdWorkspace: true, lastRead: "foo tail" });
    const o = reopenTask(V, t.id, deps(h, spawned));
    expect(o.status).toBe("running");
    expect(spawned.at(-1)).toEqual(["work", "run", t.id, "--reopen"]);
    const h2 = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }] });
    expect((await launchTask(V, t.id, deps(h2), { reopen: true })).herdr?.lastRead).toBeUndefined();
    const prompt = mutating(h2.calls).find((x) => x[2] === "prompt")!;
    expect(prompt[4]).toMatch(/^Pick this task back up/);
    expect(prompt[4]).toContain("## You");
  });
  test("continue after a pause goes on in the same tab", async () => {
    const h = fakeHerdr();
    const spawned: string[][] = [];
    const t = await running(h, spawned);
    pauseTask(V, t.id, deps(h));
    const c = await continueTask(V, t.id, { deps: deps(h, spawned) });
    expect(c.task!.status).toBe("running");
    expect(h.calls.at(-1)).toEqual(["local", "agent", "prompt", t.herdr!.agent!, "Continue where you left off."]);
    expect(spawned.at(-1)).toEqual(["work", "mirror", t.id]);
  });
  test("a workspace Prevail did not create, or one with other tabs, stays open", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }] });
    const t = await running(h);
    closeTask(V, t.id, deps(h));
    expect(mutating(h.calls).some((c) => c[1] === "workspace" && c[2] === "close")).toBe(false);
    const h2 = fakeHerdr({ tabsLeft: 2 });
    const t2 = await running(h2);
    closeTask(V, t2.id, deps(h2));
    expect(mutating(h2.calls).some((c) => c[1] === "workspace" && c[2] === "close")).toBe(false);
  });
  test("the brief carries the team's mandates, what the vault knows, and the user's rules", async () => {
    const h = fakeHerdr();
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const b = buildBrief(V, p.tasks[0]!);
    expect(b).toContain("- Researcher:");
    expect(b).toContain("Where it belongs: Insurance (domain).");
    expect(b).toContain("Task name: Foo Carrier");
  });
});

describe("the owner's workspaces, from the Glyph spaces map", () => {
  const MONO = join(ROOT, "mono");
  const rows = [{ workspace_id: "wc", label: "Foo Code" }, { workspace_id: "wl", label: "Foo Life" }];
  const env = () => ({ GLYPH_SPACES: GLYPH });
  const task = (o: Partial<WorkTask>) => ({ machine: "laptop", thread: { space: "_app-foo", session: "s" }, ...o }) as unknown as WorkTask;
  beforeEach(() => {
    seed();
    mkdirSync(join(GLYPH, "spaces"), { recursive: true });
    writeFileSync(join(GLYPH, "machines.json"), JSON.stringify({ machines: { laptop: { tag: "laptop", roots: { vault: V, mono: MONO } } } }));
    writeFileSync(join(GLYPH, "spaces", "foo-code.json"), JSON.stringify({ id: "foo-code", space: "foocode", tabs: [{ label: "widget", path: "{mono}/apps/widget" }, { label: "root", path: "{mono}" }] }));
    writeFileSync(join(GLYPH, "spaces", "foo-life.json"), JSON.stringify({ id: "foo-life", space: "foolife", tabs: [{ label: "insurance", path: "{vault}/data/domains/insurance" }, { label: "money", path: "{vault}/data/domains/money" }] }));
  });
  test("by folder: code under a map tab goes to that workspace; vault domains, listed or not, to the one holding them", () => {
    const code = task({ dest: { kind: "folder", id: "w", label: "Bar", folder: { root: "mono", rel: "apps/widget/src" } } as WorkTask["dest"] });
    expect(findTaskWorkspace(V, rows, code, join(MONO, "apps/widget/src"), { env: env() })?.label).toBe("Foo Code");
    // An absolute folder resolves through the machine's roots.
    const abs = task({ dest: { kind: "folder", id: "w", label: "Bar", folder: { root: "abs", rel: join(MONO, "apps/other") } } as WorkTask["dest"] });
    expect(findTaskWorkspace(V, rows, abs, join(MONO, "apps/other"), { env: env(), roots: { mono: MONO, vault: V } })?.label).toBe("Foo Code");
    expect(findTaskWorkspace(V, rows, task({ thread: { space: "insurance", session: "s" } }), D("insurance"), { env: env() })?.label).toBe("Foo Life");
    expect(findTaskWorkspace(V, rows, task({ thread: { space: "general", session: "s" } }), D("general"), { env: env() })?.label).toBe("Foo Life");
  });
  test("by name, else nothing: an unmapped task has no home of its own", () => {
    const elsewhere = { root: "abs", rel: "/tmp/foo-elsewhere" } as const;
    const named = task({ dest: { kind: "app", id: "widget", label: "Widget", folder: elsewhere } as WorkTask["dest"] });
    expect(findTaskWorkspace(V, rows, named, elsewhere.rel, { env: env() })?.label).toBe("Foo Code");
    const byLabel = task({ dest: { kind: "app", id: "x", label: "Foo Life", folder: elsewhere } as WorkTask["dest"] });
    expect(findTaskWorkspace(V, rows, byLabel, elsewhere.rel, { env: env() })?.label).toBe("Foo Life");
    const none = task({ dest: { kind: "app", id: "amazon", label: "Amazon", folder: elsewhere } as WorkTask["dest"] });
    expect(findTaskWorkspace(V, rows, none, elsewhere.rel, { env: env() })).toBeNull();
  });
  test("a mapped task gets a tab in the owner's workspace, no workspace is made, and that workspace is never closed", async () => {
    const h = fakeHerdr({ workspaces: rows, statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const t = await launchTask(V, p.tasks[0]!.id, deps(h));
    expect(t.herdr).toMatchObject({ workspaceLabel: "Foo Life", workspaceId: "wl", createdWorkspace: false });
    expect(mutating(h.calls).some((c) => c[1] === "workspace" && c[2] === "create")).toBe(false);
    closeTask(V, t.id, deps(h));
    expect(mutating(h.calls).some((c) => c[1] === "workspace" && c[2] === "close")).toBe(false);
  });
  test("stale links and made-here marks are dropped, never made again", async () => {
    mkdirSync(join(V, "build", "_meta", "work"), { recursive: true });
    const file = join(V, "build", "_meta", "work", "herdr.json");
    writeFileSync(file, JSON.stringify({ links: { laptop: { insurance: "Amazon", money: "Foo Life" }, studio: { general: "Bar" } }, created: { laptop: ["wgone"] } }));
    const h = fakeHerdr({ workspaces: rows, statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    expect((await launchTask(V, p.tasks[0]!.id, deps(h))).herdr?.workspaceLabel).toBe("Foo Life");
    expect(mutating(h.calls).some((c) => c[1] === "workspace" && c[2] === "create")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ links: { laptop: { money: "Foo Life", insurance: "Foo Life" }, studio: { general: "Bar" } } });
  });
  test("the shared Work workspace is reused while open and closes with its last tab", async () => {
    writeFileSync(join(GLYPH, "spaces", "foo-life.json"), JSON.stringify({ id: "foo-life", space: "foolife", tabs: [] }));
    const h = fakeHerdr({ workspaces: [{ workspace_id: "wc", label: "Foo Code" }], statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const a = await launchTask(V, p.tasks[0]!.id, deps(h));
    const q = await addWork(V, "y", { deps: { ...deps(h), runner: async () => oneTask("claude", undefined, "Compare foo quotes") } });
    const b = await launchTask(V, q.tasks[0]!.id, deps(h));
    expect([a.herdr?.workspaceLabel, b.herdr?.workspaceLabel]).toEqual(["Work", "Work"]);
    expect(b.herdr?.createdWorkspace).toBe(true);
    expect(mutating(h.calls).filter((c) => c[1] === "workspace" && c[2] === "create").map((c) => c[4])).toEqual(["Work"]);
    closeTask(V, a.id, deps(h));
    expect(mutating(h.calls).at(-1)).toEqual(["local", "workspace", "close", "wnew"]);
  });
});

describe("workspaces", () => {
  beforeEach(seed);
  test("lists the open workspaces' labels on a machine, read only", () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }, { workspace_id: "w2", label: "Bar" }, { workspace_id: "w3", label: "Foo Work" }] });
    expect(herdrWorkspaces(V, "laptop", deps(h))).toEqual(["Foo Work", "Bar"]);
    expect(mutating(h.calls)).toEqual([]);
    expect(() => herdrWorkspaces(V, "mini-foo", deps(h))).toThrow(/not a saved Herdr machine/);
  });
});

test("the mirror keeps the agent's words and drops its terminal chrome", () => {
  const screen = ["Foo summary:", "", "- the foo policy renews in May", "", "\u273b Baked for 9s", "", "\u2500".repeat(40) + " foo-tab \u2500", "\u276f ", "\u2500".repeat(40), "  \u23f5\u23f5 foo mode on (shift+tab to cycle)"].join("\n");
  expect(stripChrome(screen)).toBe("Foo summary:\n\n- the foo policy renews in May");
});

test("an unsent suggestion in the agent's input box is never read as its words", () => {
  const screen = ["Filed the foo summary.", "", "\u2500".repeat(40) + " foo-tab \u2500", "\u276f mark the foo task as review", "\u2500".repeat(40)].join("\n");
  expect(stripChrome(screen)).toBe("Filed the foo summary.");
});

test("the first mirror skips the agent's banner and its echo of the brief", () => {
  expect(afterBrief(`Foo CLI v1\n> You are working on one task. End with a short summary: what you did, ${BRIEF_END}\n\nFoo answer`).trim()).toBe("Foo answer");
  expect(afterBrief("no echo yet")).toBe("no echo yet");
});

describe("crew tasks: scout or ship, a status file before the end, a quiet watcher", () => {
  beforeEach(seed);
  const statusOf = (t: WorkTask) => crewPaths(V, t).status;
  const writeStatus = (t: WorkTask, j: object) => { mkdirSync(crewPaths(V, t).dir, { recursive: true }); writeFileSync(statusOf(t), JSON.stringify(j)); };
  /** A runner that only counts: the watcher's model calls. */
  const counting = () => { const n = { calls: 0 }; return { n, runner: async () => { n.calls++; return "NONE"; } }; };
  async function crewTask(h: ReturnType<typeof fakeHerdr>, text = "Find the best foo carrier for the rentals", spawned: string[][] = []) {
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => oneTask("claude", undefined, text) } });
    return launchTask(V, p.tasks[0]!.id, deps(h, spawned));
  }

  test("the router shapes each task; the brief tells a scout to change nothing and every crew agent to write its status file", async () => {
    const h = fakeHerdr({ statuses: ["idle"] });
    const t = await crewTask(h);
    expect(t.crew).toBe("scout");
    const brief = mutating(h.calls).find((c) => c[2] === "prompt")![4]!;
    expect(brief).toContain("This is a scout task");
    expect(brief).toContain(`Write what you found to ${crewPaths(V, t).report}`);
    expect(brief).toContain(`write ${statusOf(t)} as JSON`);
    // The brief still ends on its last words (the mirror finds the agent's reply after them).
    expect(brief.trimEnd().endsWith(BRIEF_END)).toBe(true);
    // The Stop hook rides in the task's own settings, beside the act gate's.
    const settings = JSON.parse(readFileSync(join(ROOT, "config", "work", t.id, "settings.json"), "utf8")) as { hooks: { Stop: unknown[] } };
    expect(settings.hooks.Stop).toHaveLength(1);
    const s = await addWork(V, "y", { deps: { ...deps(h), runner: async () => oneTask("claude", undefined, "Draft a reply to the foo landlord") } });
    expect(s.tasks[0]!.crew).toBe("ship");
  });

  test("a scout that writes its status and report is done with its own summary: the report goes in the thread, no model call", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [`${BRIEF_END}\n\nFoo carrier A is cheapest.`] });
    const t = await crewTask(h);
    mkdirSync(crewPaths(V, t).dir, { recursive: true });
    writeFileSync(crewPaths(V, t).report, "# Foo carriers\n\nCarrier A is cheapest for both foo rentals.\n");
    writeStatus(t, { state: "done", summary: "Carrier A is cheapest for both foo rentals.", report: crewPaths(V, t).report });
    const c = counting();
    const r = await mirrorTask(V, t.id, { ...deps(h), runner: c.runner }, { maxRounds: 3, waitMs: 1 });
    expect(r).toMatchObject({ status: "done", outcome: "Carrier A is cheapest for both foo rentals.", report: `data/domains/insurance/memory/work/${t.id}/report.md` });
    expect(c.n.calls).toBe(0);
    expect(readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.md`), "utf8")).toContain("Carrier A is cheapest for both foo rentals.\n");
    // It waited on Herdr, not a timer: idle while it worked.
    expect(h.calls.find((c) => c[1] === "agent" && c[2] === "wait")).toEqual(["local", "agent", "wait", t.herdr!.agent!, "--status", "idle", "--timeout", "1"]);
  });

  test("blocked in its status file is Needs you with what it needs; a follow-up clears the old status for a fresh one", async () => {
    const h = fakeHerdr({ statuses: ["idle", "idle"], reads: [`${BRIEF_END}\n\nI need the foo policy number.`] });
    const t = await crewTask(h);
    writeStatus(t, { state: "blocked", summary: "I need the foo policy number to compare like for like." });
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 2, waitMs: 1 });
    expect(r).toMatchObject({ status: "needs-you", waiting: "I need the foo policy number to compare like for like." });
    // Waiting on the owner, the watcher waits for the agent to work again.
    expect(h.calls.filter((c) => c[2] === "wait").at(-1)).toContain("working");
    const f = await followUp(V, t.id, "It is in the foo folder", { deps: deps(h) });
    expect(f.task.status).toBe("running");
    expect(existsSync(statusOf(t))).toBe(false);
    expect(existsSync(statusOf(t).replace(/\.json$/, ".prev.json"))).toBe(true);
  });

  test("an agent that stops without its status file is reminded once, then failed with a plain reason", async () => {
    const h = fakeHerdr({ statuses: ["idle", "idle", "idle"], reads: [`${BRIEF_END}\n\nAll done with foo.`] });
    const t = await crewTask(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 3, waitMs: 1 });
    expect(mutating(h.calls).filter((c) => c[2] === "prompt").map((c) => c[4]).at(-1)).toBe(CREW_NUDGE);
    expect(r.log.some((l) => l.ev === "reminded")).toBe(true);
    expect(r).toMatchObject({ status: "failed", outcome: "It stopped without saying how it went, even after a reminder." });
    // A reminder that lands: the status written after it settles the task.
    const h2 = fakeHerdr({ statuses: ["idle", "idle"], reads: [`${BRIEF_END}\n\nAll done with foo.`] });
    const t2 = await crewTask(h2);
    let n = 0;
    const d2 = { ...deps(h2), herdrFor: (m: string) => { const f = h2.forMachine(m); return (a: string[]) => { if (a[1] === "prompt" && a[3] === CREW_NUDGE && ++n === 1) writeStatus(t2, { state: "done", summary: "Foo carrier A it is." }); return f(a); }; } };
    expect(await mirrorTask(V, t2.id, d2, { maxRounds: 3, waitMs: 1 })).toMatchObject({ status: "done", outcome: "Foo carrier A it is." });
  });

  test("a crew agent's last line ending in a question is not a question: its status file says how it went", async () => {
    const h = fakeHerdr({ statuses: ["idle", "idle"], reads: [`${BRIEF_END}\n\nCarrier A is cheapest. Want me to draft the foo quote request too?`] });
    const t = await crewTask(h);
    writeStatus(t, { state: "done", summary: "Carrier A is cheapest." });
    expect(await mirrorTask(V, t.id, deps(h), { maxRounds: 2, waitMs: 1 })).toMatchObject({ status: "done", outcome: "Carrier A is cheapest." });
  });

  test("a long watch renews its lease between waits, so reconcile never starts a second watcher", async () => {
    const h = fakeHerdr({ statuses: ["idle", "working", "working", "working", "done"], reads: [`${BRIEF_END}\n\nworking on foo`] });
    const t = await crewTask(h);
    let clock = Date.now();
    const leases: number[] = [];
    const d = { ...deps(h), now: () => (clock += 2 * 60_000), herdrFor: (m: string) => { const f = h.forMachine(m); return (a: string[]) => { if (a[1] === "wait") leases.push(readTask(V, t.id)!.task.lease?.until ?? 0); return f(a); }; } };
    await mirrorTask(V, t.id, d, { maxRounds: 4, waitMs: 1 });
    // Each wait starts with a lease that outlives it.
    expect(leases.length).toBeGreaterThan(2);
    expect(leases.slice(1).every((u, i) => u > leases[i]!)).toBe(true);
  });

  test("the crew files are named by the vault folder of the Mac the agent runs on", async () => {
    const h = fakeHerdr({ statuses: ["idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const b = buildBrief(V, p.tasks[0]!, { vaultRoot: "/tmp/foo-remote-vault" });
    expect(b).toContain(`write /tmp/foo-remote-vault/data/domains/insurance/memory/work/${p.tasks[0]!.id}/status.json as JSON`);
  });

  test("its tab closing with no status file fails it; with one, the file says how it went", async () => {
    const gone = (h: ReturnType<typeof fakeHerdr>) => ({ ...deps(h), herdrFor: (m: string) => { const f = h.forMachine(m); return (a: string[]) => { if (a[0] === "agent" && a[1] === "read") throw new Error('herdr agent read failed: {"error":{"code":"agent_not_found"}}'); return f(a); }; } });
    const h = fakeHerdr({ statuses: ["idle"] });
    const t = await crewTask(h);
    expect(await mirrorTask(V, t.id, gone(h), { maxRounds: 2, waitMs: 1 })).toMatchObject({ status: "failed", outcome: "Its Herdr tab closed before it said how it went. Continue starts it again." });
    const t2 = await crewTask(h);
    writeStatus(t2, { state: "failed", summary: "The foo site was down." });
    expect(await mirrorTask(V, t2.id, gone(h), { maxRounds: 2, waitMs: 1 })).toMatchObject({ status: "failed", outcome: "The foo site was down." });
  });

  test("quiet supervision: a round where nothing changed makes no model call and no write", async () => {
    // A task from before shapes that hands a choice back, then sits there: the old mirror distilled it every round.
    const end = "Foo Lake or Foo Bay, both about 430 foo dollars.\n\nPick one and I will hold it.";
    const h = fakeHerdr({ statuses: ["idle"], reads: [end] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    legacy(p.tasks[0]!.id);
    const t = await launchTask(V, p.tasks[0]!.id, deps(h));
    const c = counting();
    const r = await mirrorTask(V, t.id, { ...deps(h), runner: c.runner }, { maxRounds: 8, waitMs: 1 });
    expect(r).toMatchObject({ status: "needs-you", waiting: "Pick one and I will hold it." });
    expect(c.n.calls).toBe(1);
    const turns = readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.md`), "utf8").match(/^## /gm)!.length;
    expect(turns).toBe(2);
    // While it waits on the owner, Herdr is asked to wake the watcher when the agent works again.
    expect(h.calls.filter((x) => x[2] === "wait").slice(1).every((x) => x.includes("working"))).toBe(true);
  });

  test("a ship task on a repo works in its own worktree, told how the project ships; checking it off keeps unpushed work", async () => {
    const repo = join(ROOT, "code", "foo-app");
    mkdirSync(repo, { recursive: true });
    const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Foo", GIT_AUTHOR_EMAIL: "foo@example.com", GIT_COMMITTER_NAME: "Foo", GIT_COMMITTER_EMAIL: "foo@example.com" } }).stdout.trim();
    g(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "foo.ts"), "export const foo = 1;\n");
    g(repo, "add", ".");
    g(repo, "commit", "--quiet", "-m", "foo");
    createMission(V, { name: "Foo App", domains: [{ slug: "general", role: "owner" }], repos: [repo] });
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo App" }], statuses: ["idle"] });
    const reply = JSON.stringify({ goals: [{ text: "Foo", tasks: [{ name: "Foo Bug", text: "Fix the foo bug", dest: { kind: "folder", id: repo }, confidence: 0.9, shape: "do", crew: "ship" }] }] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => reply } });
    const t = await launchTask(V, p.tasks[0]!.id, deps(h));
    const tree = join(ROOT, "trees", "foo-app", `foo-bug-${t.id.split("-").slice(-2).join("-")}`);
    expect(t.worktree).toMatchObject({ path: tree, branch: `work/foo-bug-${t.id.split("-").slice(-2).join("-")}`, base: "HEAD", cwd: tree });
    expect(t.shipMode).toBe("local-only");
    expect(mutating(h.calls).find((c) => c[1] === "tab" && c[2] === "create")).toContain(tree);
    const brief = mutating(h.calls).find((c) => c[2] === "prompt")![4]!;
    expect(brief).toContain(`your own git worktree at ${tree}, on the branch ${t.worktree!.branch}`);
    expect(brief).toContain("Do not push or merge: the owner merges it.");
    // Unpushed work on the branch: checking it off leaves the worktree and says so.
    writeFileSync(join(tree, "foo.ts"), "export const foo = 2;\n");
    g(tree, "commit", "--quiet", "-am", "foo two");
    const d = doneTask(V, t.id, deps(h));
    expect(existsSync(tree)).toBe(true);
    expect(d.worktree?.path).toBe(tree);
    expect(d.updates!.at(-1)!.text).toBe(`I left its worktree at ${tree} because its branch is not merged or pushed yet.`);
    // Merged into its base: nothing to lose, so it goes (the branch stays).
    g(repo, "merge", "--quiet", "--ff-only", t.worktree!.branch);
    const again = doneTask(V, t.id, deps(h));
    expect(existsSync(tree)).toBe(false);
    expect(again.worktree).toBeUndefined();
    expect(again.log.at(-1)).toMatchObject({ ev: "worktree removed" });
    expect(g(repo, "branch", "--list", t.worktree!.branch)).toContain("work/");
    // A worktree another Mac made is left for that Mac.
    updateTask(V, t.id, (x) => { x.worktree = { ...t.worktree!, machine: "studio-foo" }; });
    const far = doneTask(V, t.id, deps(h));
    expect(far.worktree?.machine).toBe("studio-foo");
    expect(far.log.at(-1)).toMatchObject({ ev: "worktree kept", detail: expect.stringContaining("it is on studio-foo") });
  });

  test("scout or ship changes like a re-route: an open tab closes and it starts again shaped anew", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Insurance" }], statuses: ["idle"] });
    const spawned: string[][] = [];
    const t = await crewTask(h, undefined, spawned);
    const r = await routeTask(V, t.id, { crew: "ship" }, deps(h, spawned));
    expect(r.crew).toBe("ship");
    expect(r.log.find((l) => l.ev === "shape")?.detail).toBe("scout to ship");
    expect(mutating(h.calls).some((c) => c[1] === "tab" && c[2] === "close")).toBe(true);
    expect(spawned.at(-1)).toEqual(["work", "run", t.id]);
    await expect(routeTask(V, t.id, { crew: "captain" }, deps(h))).rejects.toThrow(/scout or a ship/);
  });
});

describe("reconcile after a restart", () => {
  beforeEach(seed);
  async function launched(h: ReturnType<typeof fakeHerdr>, text = "Find the best foo carrier for the rentals") {
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask("claude", undefined, text) } });
    return launchTask(V, p.tasks[0]!.id, deps(h));
  }
  test("a live agent whose watcher is gone is watched again, once; a gone tab settles from its status file or fails", async () => {
    const h0 = fakeHerdr({ statuses: ["idle"] });
    const alive = await launched(h0);
    const done = await launched(h0, "Find foo carrier B");
    const lost = await launched(h0, "Find foo carrier C");
    mkdirSync(crewPaths(V, done).dir, { recursive: true });
    writeFileSync(crewPaths(V, done).status, JSON.stringify({ state: "done", summary: "Foo carrier B is fine." }));
    const h = fakeHerdr({ panes: [{ pane_id: alive.herdr!.paneId, workspace_id: "wnew" }] });
    const spawned: string[][] = [];
    const r = reconcileWork(V, deps(h, spawned));
    expect(r.watched).toEqual([alive.id]);
    expect(spawned).toEqual([["work", "mirror", alive.id]]);
    expect(r.settled.sort()).toEqual([done.id, lost.id].sort());
    expect(readTask(V, done.id)!.task).toMatchObject({ status: "done", outcome: "Foo carrier B is fine." });
    expect(readTask(V, lost.id)!.task).toMatchObject({ status: "failed", outcome: "Its Herdr tab is gone and it left no word on how it went. Continue starts it again." });
    expect(readTask(V, lost.id)!.task.herdr?.paneId).toBeUndefined();
    // Idempotent: the watcher it started holds the lease, and the settled ones are settled.
    const again = reconcileWork(V, deps(h, spawned));
    expect(again).toEqual({ watched: [], relaunched: [], settled: [], orphans: [] });
    expect(spawned.length).toBe(1);
    // Nothing is ever closed.
    expect(mutating(h.calls)).toEqual([]);
  });
  test("a paused task keeps its pause; a Work pane no task knows is reported, never closed; no Herdr means no change", async () => {
    const h0 = fakeHerdr({ statuses: ["idle"] });
    const t = await launched(h0);
    pauseTask(V, t.id, deps(h0));
    const h = fakeHerdr({ panes: [{ pane_id: "wnew:p9", workspace_id: "wnew", label: "Foo Leftover", cwd: "/tmp/foo" }, { pane_id: "other:p1", workspace_id: "wmine", label: "Mine" }] });
    const r = reconcileWork(V, deps(h));
    expect(r.orphans).toEqual([{ pane: "wnew:p9", label: "Foo Leftover", cwd: "/tmp/foo" }]);
    expect(readTask(V, t.id)!.task.status).toBe("paused");
    expect(mutating(h.calls)).toEqual([]);
    const down = { ...deps(h), herdrFor: () => (() => { throw new Error("herdr pane list failed: no server"); }) as Herdr };
    expect(reconcileWork(V, down)).toEqual({ watched: [], relaunched: [], settled: [], orphans: [] });
    // No Work mode task or workspace in Herdr on this Mac: Herdr is not even asked.
    seed();
    const quiet = fakeHerdr();
    expect(reconcileWork(V, deps(quiet))).toEqual({ watched: [], relaunched: [], settled: [], orphans: [] });
    expect(quiet.calls.some((c) => c[1] === "pane")).toBe(false);
  });
  test("a launch that died before its tab opened is launched again once it has been quiet a while", async () => {
    const h = fakeHerdr({ statuses: ["idle"] });
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => oneTask() } });
    const id = p.tasks[0]!.id;
    expect(reconcileWork(V, deps(h, spawned)).relaunched).toEqual([]);
    const later = { ...deps(h, spawned), now: () => Date.now() + 10 * 60_000 };
    expect(reconcileWork(V, later).relaunched).toEqual([id]);
    expect(spawned.at(-1)).toEqual(["work", "run", id]);
    expect(reconcileWork(V, later).relaunched).toEqual([]);
  });
});
