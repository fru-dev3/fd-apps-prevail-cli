import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentField, deriveAll, deriveTabs, launchLine, planSleeps, sleepDomain, tidy, wake, type DomainFacts, type Herdr, type Pane, type SpaceFile } from "./spaces.ts";

// Under home: vault reads refuse /var/folders.
mkdirSync(join(homedir(), ".prevail-test-tmp"), { recursive: true });
const ROOT = mkdtempSync(join(homedir(), ".prevail-test-tmp", "prevail-spaces-"));
const V = join(ROOT, "vault");
const MAP = join(ROOT, "map");
const saved = { cfg: process.env.PREVAIL_CONFIG_DIR, map: process.env.GLYPH_SPACES };
process.env.PREVAIL_CONFIG_DIR = join(ROOT, "cfg");
process.env.GLYPH_SPACES = MAP;
afterAll(() => {
  for (const [k, v] of [["PREVAIL_CONFIG_DIR", saved.cfg], ["GLYPH_SPACES", saved.map]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(ROOT, { recursive: true, force: true });
});

const manifest = (name: string, cfg: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, identity: { name, label: name }, config: { cli: "claude", model: "", ...cfg }, ...extra });

function seed() {
  const doms: [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ["orchard", { pinned: true, cli: "codex", model: "gpt-test" }, { context_score: { score: 10 } }],
    ["ledger", {}, { context_score: { score: 40 } }],
    ["harbor", {}, { context_score: { score: 5 } }],
    ["attic", {}, { archived: true }],
    ["studio", {}],
  ];
  for (const [d, cfg, extra] of doms) {
    mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
    writeFileSync(join(V, "data", "domains", d, "manifest.json"), manifest(d, cfg, extra ?? {}));
  }
  writeFileSync(join(V, "data", "domains", "harbor", "memory", "tasks.md"), "# Tasks\n\n" + "- [ ] one\n".repeat(50));
  mkdirSync(join(V, "data", "domains", "_log"), { recursive: true });
  mkdirSync(join(MAP, "spaces"), { recursive: true });
  writeFileSync(join(MAP, "spaces", "life.json"), JSON.stringify({ id: "life", space: "life", profiles: ["hub"], source: "prevail domains", pins: ["studio"], tabs: [{ label: "ledger", mark: "life-ledger", path: "{vault}/data/domains/ledger", previous: ["Ledger"] }] }, null, 2));
  writeFileSync(join(MAP, "spaces", "desk.json"), JSON.stringify({ id: "desk", space: "desk", tabs: [{ label: "chief", mark: "desk", path: "{vault}/data/domains/orchard", agent: "claude" }] }));
}
seed();

describe("derived spaces", () => {
  test("tabs: pins first, then score plus open tasks; archived and claimed out; agents only when pinned", () => {
    const space: SpaceFile = { id: "s", space: "s", tabs: [{ label: "b", mark: "s-b", path: "x", previous: ["B"] }], pins: ["c"] };
    const facts: DomainFacts[] = [
      { name: "a", pinned: false, archived: false, score: 1, openTasks: 0 },
      { name: "b", pinned: true, archived: false, score: 5, openTasks: 0 },
      { name: "c", pinned: false, archived: false, score: 0, openTasks: 0 },
      { name: "d", pinned: false, archived: true, score: 99, openTasks: 0 },
      { name: "e", pinned: false, archived: false, score: 50, openTasks: 0 },
    ];
    const tabs = deriveTabs(space, facts, new Set(["e"]));
    expect(tabs.map((t) => t.label)).toEqual(["c", "b", "a"]);
    expect(tabs[1]).toEqual({ label: "b", mark: "s-b", path: "{vault}/data/domains/b", agent: agentField("b"), previous: ["B"] });
    expect(tabs[0]!.agent).toBeUndefined();
  });

  test("deriveAll asks the vault, not the folder, and keeps a dated copy of the hand-kept file", () => {
    const r = deriveAll(V, MAP, { today: "2026-01-02" });
    expect(r).toEqual([{ id: "life", tabs: 3, agents: 0, changed: true }]);
    const life = JSON.parse(readFileSync(join(MAP, "spaces", "life.json"), "utf8")) as SpaceFile;
    // orchard is claimed by desk; _log and attic are never tabs; harbor's 50 open tasks beat ledger's 40 points.
    expect(life.tabs.map((t) => t.label)).toEqual(["studio", "harbor", "ledger"]);
    expect(life.tabs.find((t) => t.label === "ledger")!.previous).toEqual(["Ledger"]);
    expect(existsSync(join(MAP, "spaces", "life.json.pre-derive-2026-01-02"))).toBe(true);
    expect(deriveAll(V, MAP, { today: "2026-01-02" })[0]!.changed).toBe(false);
  });

  test("a domain added in the app appears on the next derive with its folder, engine and model", async () => {
    mkdirSync(join(V, "data", "domains", "garden"), { recursive: true });
    writeFileSync(join(V, "data", "domains", "garden", "manifest.json"), manifest("garden", { pinned: true, cli: "claude", model: "test-model" }));
    deriveAll(V, MAP, { today: "2026-01-02" });
    const life = JSON.parse(readFileSync(join(MAP, "spaces", "life.json"), "utf8")) as SpaceFile;
    const tab = life.tabs.find((t) => t.label === "garden")!;
    expect(tab).toEqual({ label: "garden", mark: "life-garden", path: "{vault}/data/domains/garden", agent: 'eval "$(prevail spaces cmd garden)"' });
    const { commandFor } = await import("./spaces.ts");
    const line = await commandFor(V, "garden");
    expect(line.startsWith("PREVAIL_DOMAIN=garden claude life-garden --model 'test-model' --settings ")).toBe(true);
  });

  test("launch lines carry the engine, model and scope", () => {
    expect(launchLine("orchard", "life-orchard", "codex", "gpt-test")).toBe("PREVAIL_DOMAIN=orchard codex life-orchard -m 'gpt-test'");
    expect(launchLine("ledger", "life-ledger", "claude", "", "/tmp/s.json")).toBe("PREVAIL_DOMAIN=ledger claude life-ledger --settings '/tmp/s.json'");
  });
});

function fakeHerdr(panes: Pane[]) {
  const calls: string[][] = [];
  const h: Herdr = (args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") return { panes };
    if (args[1] === "send-text" && args[3]?.startsWith("/exit")) { const p = panes.find((x) => x.pane_id === args[2]); if (p) { delete p.agent; p.agent_status = "unknown"; } }
    if (args[1] === "run") { const p = panes.find((x) => x.pane_id === args[2]); if (p) { p.agent = "claude"; p.agent_status = "idle"; } }
    return {};
  };
  return { h, calls };
}

describe("wake, sleep and the idle policy", () => {
  test("start <domain> wakes the tab in place; no tab means apply first", async () => {
    const panes: Pane[] = [{ pane_id: "w1:p1", cwd: join(V, "data", "domains", "ledger") }];
    const { h, calls } = fakeHerdr(panes);
    expect(await wake(V, "ledger", h)).toBe("woke ledger in its tab");
    const run = calls.find((c) => c[1] === "run")!;
    expect(run[2]).toBe("w1:p1");
    expect(run[3]).toContain("PREVAIL_DOMAIN=ledger claude");
    expect(await wake(V, "ledger", h)).toContain("already awake");
    expect(await wake(V, "harbor", h)).toContain("no tab here");
  });

  test("sleep files first, then exits; the agent is asked to write only its own folder", async () => {
    const panes: Pane[] = [{ pane_id: "w1:p2", cwd: join(V, "data", "domains", "harbor"), agent: "claude", agent_status: "idle" }];
    const { h, calls } = fakeHerdr(panes);
    const r = await sleepDomain(V, "harbor", h, { pollMs: 1, timeoutMs: 50 });
    expect(r).toContain("asleep");
    const texts = calls.filter((c) => c[1] === "send-text").map((c) => c[3]);
    expect(texts[0]).toContain("Write only inside this folder");
    expect(texts[1]).toBe("/exit");
    expect(panes[0]!.agent).toBeUndefined();
  });

  test("planSleeps: idle past the limit, or longest idle first under the memory floor; never pinned", () => {
    const now = 10 * 3600_000;
    const agents = [
      { domain: "a", pinned: false, idleSince: now - 60 * 60_000 },
      { domain: "b", pinned: false, idleSince: now - 10 * 60_000 },
      { domain: "c", pinned: true, idleSince: now - 600 * 60_000 },
      { domain: "d", pinned: false, idleSince: null },
    ];
    expect(planSleeps(agents, now, 8)).toEqual(["a"]);
    expect(planSleeps(agents, now, 0.4)).toEqual(["a", "b"]);
  });

  test("tidy remembers when an agent went idle, sleeps it later, and holds the rest on the hub", async () => {
    const panes: Pane[] = [
      { pane_id: "w1:p3", cwd: join(V, "data", "domains", "ledger"), agent: "claude", agent_status: "idle" },
      { pane_id: "w1:p4", cwd: join(V, "data", "domains", "orchard"), agent: "codex", agent_status: "idle" },
    ];
    const { h } = fakeHerdr(panes);
    const held: string[][] = [];
    const slept: string[] = [];
    const deps = { herdr: h, freeGb: 8, presence: async (x: { domain: string }[]) => { held.push(x.map((y) => y.domain)); }, sleep: async (d: string) => { slept.push(d); return ""; } };
    const t0 = 1_000_000;
    expect((await tidy(V, { ...deps, now: t0 })).slept).toEqual([]);
    expect(held.at(-1)).toEqual(["ledger", "orchard"]);
    const later = await tidy(V, { ...deps, now: t0 + 50 * 60_000 });
    expect(later.slept).toEqual(["ledger"]); // orchard is pinned
    expect(held.at(-1)).toEqual(["orchard"]);
  });
});
