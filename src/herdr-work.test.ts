import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addMachine, agentKinds, findTaskWorkspace, approveInTerminal, askingQuestion, shellQuote, terminalArgv, buildBrief, closeTask, focusTask, glyphLine, headlessArgs, herdrWorkspaces, hostKey, launchTask, machines, mirrorTask, newText, stripChrome, afterBrief, BRIEF_END, reopenTask, writeMachineRecord } from "./herdr-work.ts";
import type { Herdr } from "./spaces.ts";
import { addWork, continueTask, doneTask, followUp, isCloseYes, CLOSE_QUESTION, WORKING_LINE, pauseTask, queueTasks, updateTask, writeSettings, type WorkDeps, type WorkTask } from "./work.ts";

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
  };
}

const oneTask = (kind = "claude", machine?: string, text = "Find the best foo carrier for the rentals") => JSON.stringify({ goals: [{ text: "Cover the foo rentals", tasks: [{ name: "Foo Carrier", text, dest: { kind: "domain", id: "insurance" }, confidence: 0.9, shape: "find", ...(kind !== "claude" ? { agent: kind } : {}), ...(machine ? { machine, effort: "deep" } : {}) }] }] });
const mutating = (calls: string[][]) => calls.filter((c) => ["create", "close", "start", "prompt", "send-keys", "add", "run", "rename", "focus"].includes(c[2] ?? "") && c[3] !== "--help");
const HEADLESS_CLAUDE = ["--dangerously-skip-permissions", "--settings", "/tmp/foo-act-gate.json", "--disallowedTools", "AskUserQuestion"];

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
    expect(m[2]).toEqual(["local", "agent", "start", expect.stringMatching(/^foo-carrier-\d+$/), "--kind", "claude", "--pane", "wnew:p1", "--", ...HEADLESS_CLAUDE]);
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
    expect(m.find((c) => c[1] === "pane" && c[2] === "run")).toEqual(["local", "pane", "run", "w1:p1", "claude -n 'Foo Carrier' --dangerously-skip-permissions --settings /tmp/foo-act-gate.json --disallowedTools AskUserQuestion"]);
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
  async function running(h: ReturnType<typeof fakeHerdr>, spawned: string[][] = [], runner = oneTask()) {
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => runner } });
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
  test("a finished task never closes itself: it says what came of it, asks to close, and stays with its tab", async () => {
    const h = fakeHerdr({ statuses: ["idle", "done"], reads: [`${BRIEF_END}\n\nSummary:\nFoo carrier A is cheapest overall.`] });
    const t = await running(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 3, waitMs: 1 });
    expect(r).toMatchObject({ status: "done", cleared: false });
    expect(r.updates?.map((u) => [u.from, u.text])).toEqual([["task", WORKING_LINE], ["task", "Done: Foo carrier A is cheapest overall."], ["task", CLOSE_QUESTION]]);
    expect(queueTasks(V).some((x) => x.task.id === t.id)).toBe(true);
    expect(mutating(h.calls).some((c) => c[2] === "close")).toBe(false);
  });
  test("a yes to the close question closes the task and its tab", async () => {
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
  test("any other reply to the close question goes on with the work", async () => {
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
  test("a clear yes is told apart from a follow-up", () => {
    for (const y of ["yes", "Yes, close it.", "go ahead", "Go ahead and close it", "ok thanks", "close it please", "done", "You can close it"]) expect([y, isCloseYes(y)]).toEqual([y, true]);
    for (const n of ["Continue", "no", "don't close it", "not yet", "yes but add the foo deductible", "keep it open", "what did it cost?", "close the foo account", "Close the foo account at the bank and then email Sam about it"]) expect([n, isCloseYes(n)]).toEqual([n, false]);
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

test("the first mirror skips the agent's banner and its echo of the brief", () => {
  expect(afterBrief(`Foo CLI v1\n> You are working on one task. End with a short summary: what you did, ${BRIEF_END}\n\nFoo answer`).trim()).toBe("Foo answer");
  expect(afterBrief("no echo yet")).toBe("no echo yet");
});
