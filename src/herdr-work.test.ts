import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addMachine, agentKinds, approveInTerminal, shellQuote, terminalArgv, buildBrief, closeTask, herdrWorkspaces, hostKey, launchTask, machines, mirrorTask, newText, stripChrome, afterBrief, BRIEF_END, reopenTask, writeMachineRecord } from "./herdr-work.ts";
import type { Herdr } from "./spaces.ts";
import { addWork, answerTask, continueTask, pauseTask, readTask, routeTask, updateTask, writeSettings, type WorkDeps } from "./work.ts";

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

/** A fake herdr: records every call as [machine, ...argv] and keeps a little state. */
function fakeHerdr(o: { workspaces?: { workspace_id: string; label: string }[]; saved?: { id: string; label: string; enabled?: boolean }[]; reads?: string[]; statuses?: string[]; panes?: unknown[]; tabsLeft?: number; startFails?: boolean } = {}) {
  const calls: string[][] = [];
  const reads = [...(o.reads ?? ["working on foo"])];
  const statuses = [...(o.statuses ?? ["done"])];
  let n = 0;
  const forMachine = (m: string): Herdr => (args) => {
    calls.push([m, ...args]);
    const [a, b] = args;
    if (a === "--version") return "herdr 0.0.0";
    if (a === "machine" && b === "list") return o.saved ?? [];
    if (a === "machine" && b === "add") return "saved";
    if (a === "agent" && b === "start" && o.startFails && args[2] !== "--help") throw new Error('herdr agent start failed: {"error":{"code":"agent_not_ready"}}');
    if (a === "agent" && b === "start" && args[2] === "--help") return "Usage...\n  [possible values: pi, claude, codex, gemini]";
    if (a === "workspace" && b === "list") return { workspaces: o.workspaces ?? [] };
    if (a === "workspace" && b === "create") return { workspace: { workspace_id: "wnew" }, tab: { tab_id: "wnew:t1" }, root_pane: { pane_id: "wnew:p1" } };
    if (a === "tab" && b === "create") { n++; return { tab: { tab_id: `w1:t${n}` }, root_pane: { pane_id: `w1:p${n}` } }; }
    if (a === "tab" && b === "list") return { tabs: Array.from({ length: o.tabsLeft ?? 0 }, (_, i) => ({ tab_id: `x${i}` })) };
    if (a === "pane" && b === "list") return { panes: o.panes ?? [] };
    if (a === "agent" && b === "read") return { text: reads.length > 1 ? reads.shift() : reads[0] };
    if (a === "agent" && b === "get") return { agent: { agent_status: statuses.length > 1 ? statuses.shift() : statuses[0] } };
    return {};
  };
  return { calls, forMachine };
}

function deps(h: ReturnType<typeof fakeHerdr>, spawned: string[][] = []): WorkDeps {
  return {
    spawnSelf: (a) => { spawned.push(a); },
    herdrFor: (m) => h.forMachine(m),
    machine: { host: "laptop", role: "hub", env: { GLYPH_SPACES: GLYPH, PREVAIL_MACHINE: "laptop" } },
    settingsPath: () => "/tmp/foo-act-gate.json",
  };
}

const oneTask = (kind = "claude", machine?: string) => JSON.stringify({ goals: [{ text: "Cover the foo rentals", tasks: [{ text: "Find the best foo carrier for the rentals", dest: { kind: "domain", id: "insurance" }, confidence: 0.9, shape: "find", ...(kind !== "claude" ? { agent: kind } : {}), ...(machine ? { machine, effort: "deep" } : {}) }] }] });
const mutating = (calls: string[][]) => calls.filter((c) => ["create", "close", "start", "prompt", "send-keys", "add"].includes(c[2] ?? "") && c[3] !== "--help");

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

describe("a task in a Herdr tab", () => {
  beforeEach(seed);
  test("a missing workspace is never created without a yes; the yes creates it, starts Claude with the act gate and the brief", async () => {
    const h = fakeHerdr();
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => oneTask() } });
    const t = p.tasks[0]!;
    expect(t.executor).toBe("herdr");
    expect(t.status).toBe("running");
    expect(spawned).toEqual([["work", "run", t.id]]);
    // The detached run: no workspace, so it asks.
    const asked = await launchTask(V, t.id, deps(h, spawned));
    expect(asked.status).toBe("needs-you");
    expect(asked.ask).toMatchObject({ kind: "herdr-workspace" });
    expect(mutating(h.calls)).toEqual([]);
    const yes = await answerTask(V, t.id, "yes", { deps: deps(h, spawned) });
    expect(yes.status).toBe("running");
    expect(spawned.at(-1)).toEqual(["work", "run", t.id, "--create-workspace"]);
    const run = await launchTask(V, t.id, deps(h, spawned), { createWorkspace: true });
    const m = mutating(h.calls);
    expect(m[0]!.slice(0, 7)).toEqual(["local", "workspace", "create", "--label", "Foo Work", "--cwd", D("insurance")]);
    expect(m[0]).toContain("--no-focus");
    expect(m[0]).toContain(`PREVAIL_THREAD_ID=${t.thread.session}`);
    expect(m[1]).toEqual(["local", "agent", "start", run.herdr!.agent!, "--kind", "claude", "--pane", "wnew:p1", "--", "--settings", "/tmp/foo-act-gate.json"]);
    expect(m[2]!.slice(0, 4)).toEqual(["local", "agent", "prompt", run.herdr!.agent!]);
    expect(m[2]![4]).toContain("Task: Find the best foo carrier for the rentals");
    expect(m[2]![4]).toContain("Draft, never send");
    expect(run).toMatchObject({ status: "running", herdr: { workspaceLabel: "Foo Work", workspaceId: "wnew", tabId: "wnew:t1", createdWorkspace: true, createdTab: true } });
    expect(spawned.at(-1)).toEqual(["work", "mirror", t.id]);
  });
  test("an agent that is not ready (a trust question in its tab) keeps its tab: Start goes on there, Not now closes it", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }], startFails: true, statuses: ["blocked", "idle"] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const id = p.tasks[0]!.id;
    const first = await launchTask(V, id, deps(h));
    expect(first.status).toBe("needs-you");
    expect(first.ask?.detail).toMatch(/waiting for an answer there/);
    expect(first.herdr).toMatchObject({ tabId: "w1:t1", paneId: "w1:p1", createdTab: true });
    // Still blocked: it asks again and opens nothing new.
    const before = mutating(h.calls).length;
    expect((await launchTask(V, id, deps(h))).ask?.detail).toMatch(/waiting for an answer there/);
    expect(mutating(h.calls).length).toBe(before);
    // Answered in Herdr: the same agent gets the brief, no new tab.
    const go = await launchTask(V, id, deps(h));
    expect(go.status).toBe("running");
    const m = mutating(h.calls).slice(before);
    expect(m.map((c) => c.slice(1, 3).join(" "))).toEqual(["agent prompt"]);
    expect(m[0]![3]).toBe(first.herdr!.agent!);
    // Not now on a fresh failure closes the tab Prevail opened.
    const h2 = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }], startFails: true, statuses: ["blocked"], tabsLeft: 1 });
    const q = await addWork(V, "y", { deps: { ...deps(h2), runner: async () => oneTask() } });
    await launchTask(V, q.tasks[0]!.id, deps(h2));
    const no = await answerTask(V, q.tasks[0]!.id, "no", { deps: deps(h2) });
    expect(no.status).toBe("closed");
    expect(no.herdr?.tabId).toBeUndefined();
    expect(h2.calls.some((c) => c[1] === "tab" && c[2] === "close" && c[3] === "w1:t1")).toBe(true);
  });
  test("an existing workspace gets a new tab with --cwd and --no-focus, resolved by label each time", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    await launchTask(V, p.tasks[0]!.id, deps(h));
    const m = mutating(h.calls);
    expect(m.some((c) => c[1] === "workspace" && c[2] === "create")).toBe(false);
    expect(m[0]).toEqual(["local", "tab", "create", "--workspace", "w1", "--cwd", D("insurance"), "--label", "Find the best foo carrier for", "--env", "PREVAIL_DOMAIN=insurance", "--env", `PREVAIL_THREAD_ID=${p.tasks[0]!.thread.session}`, "--no-focus"]);
    expect(readTask(V, p.tasks[0]!.id)!.task.herdr).toMatchObject({ tabId: "w1:t1", createdWorkspace: false });
  });
  test("the domain's own idle agent pane is prompted instead of a new tab", async () => {
    const h = fakeHerdr({ panes: [{ pane_id: "w7:p2", cwd: D("insurance"), agent: "claude", agent_status: "idle" }] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const r = await launchTask(V, p.tasks[0]!.id, deps(h));
    expect(mutating(h.calls).map((c) => c.slice(1, 4))).toEqual([["agent", "prompt", "w7:p2"]]);
    expect(r.herdr).toMatchObject({ agent: "w7:p2", createdTab: false });
  });
  test("another agent kind starts without the act gate and never starts alone", async () => {
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }] });
    const spawned: string[][] = [];
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => oneTask("codex") } });
    const t = p.tasks[0]!;
    expect(t.agentKind).toBe("codex");
    expect(t.status).toBe("needs-you");
    expect(t.ask?.detail).toMatch(/outside Prevail's approval gate/);
    expect(spawned).toEqual([]);
    await launchTask(V, t.id, deps(h));
    expect(mutating(h.calls).find((c) => c[2] === "start")).toEqual(["local", "agent", "start", expect.any(String), "--kind", "codex", "--pane", "w1:p1"]);
  });
  test("a saved remote machine gets every call through --machine; a missing one asks to be added", async () => {
    const h = fakeHerdr({ saved: [{ id: "m1", label: "mini-foo" }], workspaces: [{ workspace_id: "w1", label: "Foo Work" }] });
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask("claude", "mini-foo") } });
    const t = p.tasks[0]!;
    expect(t.machine).toBe("mini-foo");
    const r = await launchTask(V, t.id, deps(h));
    const m = mutating(h.calls);
    expect(m.every((c) => c[0] === "m1")).toBe(true);
    // The act-gate hook file lives on this Mac: no --settings on another one.
    expect(m.find((c) => c[2] === "start")).not.toContain("--settings");
    expect(r.log.some((l) => l.ev === "no act gate")).toBe(true);
    mkdirSync(join(V, "build", "_meta", "machines"), { recursive: true });
    writeFileSync(join(V, "build", "_meta", "machines", "air-foo.json"), JSON.stringify({ hostname: "air-foo", label: "air-foo", role: "client", herdrVersion: null, vaultRoot: "/tmp/v2", homeRoot: "/tmp/h2", herdrMachines: [], lastSeen: 2 }));
    updateTask(V, t.id, (x) => { x.status = "paused"; delete x.herdr; });
    const moved = await routeTask(V, t.id, { machine: "air-foo" }, deps(h));
    expect(moved.ask).toMatchObject({ kind: "machine-add", command: "herdr machine add --label air-foo <ssh target>" });
  });
});

describe("mirror, pause, close and reopen", () => {
  beforeEach(seed);
  async function running(h: ReturnType<typeof fakeHerdr>, spawned: string[][] = []) {
    const p = await addWork(V, "x", { deps: { ...deps(h, spawned), runner: async () => oneTask() } });
    return launchTask(V, p.tasks[0]!.id, deps(h, spawned), { createWorkspace: true });
  }
  test("the mirror appends only new text, then asks keep or close", async () => {
    const h = fakeHerdr({ reads: ["Looking at foo carriers", "Looking at foo carriers\nCarrier A is cheapest"], statuses: ["working", "done"] });
    const t = await running(h);
    const r = await mirrorTask(V, t.id, deps(h), { maxRounds: 5, waitMs: 1 });
    const md = readFileSync(join(D("insurance"), "memory", "threads", `${t.thread.session}.md`), "utf8");
    expect(md).toContain("## claude\n\nLooking at foo carriers\n\n## claude\n\nCarrier A is cheapest");
    expect(md.match(/Looking at foo carriers/g)!.length).toBe(1);
    expect(r).toMatchObject({ status: "done", ask: { kind: "keep-close" } });
    expect(r.lease).toBeUndefined();
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toMatch(/- \[x\]/);
    expect(newText("abc", "abcdef")).toBe("def");
    expect(newText(undefined, "x")).toBe("x");
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
    expect(c.herdr).toEqual({ machine: "laptop", workspaceLabel: "Foo Work", workspaceId: "wnew", createdWorkspace: true, lastRead: "foo tail" });
    const o = reopenTask(V, t.id, deps(h, spawned));
    expect(o.status).toBe("running");
    expect(spawned.at(-1)).toEqual(["work", "run", t.id, "--reopen"]);
    const h2 = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }] });
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
    const h = fakeHerdr({ workspaces: [{ workspace_id: "w1", label: "Foo Work" }] });
    const t = await running(h);
    closeTask(V, t.id, deps(h));
    expect(mutating(h.calls).some((c) => c[1] === "workspace" && c[2] === "close")).toBe(false);
    const h2 = fakeHerdr({ tabsLeft: 2 });
    const t2 = await running(h2);
    closeTask(V, t2.id, deps(h2));
    expect(mutating(h2.calls).some((c) => c[1] === "workspace" && c[2] === "close")).toBe(false);
  });
  test("the brief carries the team's mandates and the user's rules", async () => {
    const h = fakeHerdr();
    const p = await addWork(V, "x", { deps: { ...deps(h), runner: async () => oneTask() } });
    const b = buildBrief(V, p.tasks[0]!);
    expect(b).toContain("- Researcher:");
    expect(b).toContain("Where it belongs: Insurance (domain).");
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
