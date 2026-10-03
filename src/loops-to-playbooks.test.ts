// Playbooks replace loops (owner, 2026-10-02). Every loop is carried into a
// scheduled playbook that runs as the very same loop; the loops file stays
// as it was (a hub on the released daemon keeps running it), with a dated
// copy beside it, and nothing runs twice. Invented names only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loopsOnce, migrateLoops, readLoops, verifyMigration } from "./daemon-loops.ts";
import { playbookRows, playbookTriggers, playbookView, setTrigger } from "./playbooks.ts";

const ROOT = join("/tmp", `prevail-loops-pb-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const PB = join(V, "build", "playbooks");
const DAY = 86_400_000;
// Ran yesterday: a weekly steward loop that is not due, so no test ever reaches a model.
const RAN = Date.now() - DAY;

const LOOPS = {
  schema: 1,
  desiredState: "Foo stays calm and paid.",
  loops: [
    { id: "foo-watch", name: "Foo watch", purpose: "Watch the foo bills", type: "open", signals: ["bills"], condition: "", cadence: "weekly", autonomy: "tasks", evaluation: "Paid on time", actions: ["Pay foo"], status: "active", enabled: true, lastRunTs: RAN, createdTs: 1_600_000_000_000 },
    { id: "foo-digest", name: "Foo digest", purpose: "A monthly foo page", type: "open", signals: [], condition: "", cadence: "monthly", kind: "briefing", channel: "log", evaluation: "", actions: [], status: "staged", enabled: false, lastRunTs: null, createdTs: 1_600_000_000_000 },
    { id: "foo-weekly", name: "Playbook: Foo weekly", purpose: "A foo check-in", type: "open", condition: "", cadence: "weekly", autonomy: "auto", evaluation: "", actions: [], status: "active", enabled: true, lastRunTs: null, createdTs: 1_600_000_000_000, playbook: "foo-weekly" },
    { id: "foo-renew", name: "On renewals", purpose: "Renewals", type: "open", condition: "", cadence: "weekly", on: "admin:renew", evaluation: "", actions: [], status: "active", enabled: true, lastRunTs: null, createdTs: 1_600_000_000_000, playbook: "foo-weekly" },
  ],
};

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state for ${d}, long enough to count as a baseline for the steward.\n`);
  }
  mkdirSync(PB, { recursive: true });
  writeFileSync(join(PB, "foo-weekly.json"), JSON.stringify({ id: "foo-weekly", name: "Foo weekly", goal: "A foo check-in", steps: [{ kind: "task", id: "s1", text: "Check the foo plan" }] }));
  writeFileSync(join(D("foo"), "_loops.json"), JSON.stringify(LOOPS, null, 2));
}

describe("loops become scheduled playbooks", () => {
  beforeEach(seed);

  test("one playbook per loop, the loops file untouched with a dated copy, and every loop runs as it did", () => {
    const before = readFileSync(join(D("foo"), "_loops.json"), "utf8");
    const r = migrateLoops(V, { now: Date.parse("2026-10-02T12:00:00Z") });
    expect(r.migrated.map((m) => m.loop)).toEqual(["foo-watch", "foo-digest", "foo-weekly", "foo-renew"]);
    // foo-weekly is already a playbook's id: the carried-over one is named after its space.
    expect(r.migrated.find((m) => m.loop === "foo-weekly")!.playbook).toBe("foo-foo-weekly");
    expect(readFileSync(join(D("foo"), "_loops.json"), "utf8")).toBe(before);
    expect(readFileSync(join(D("foo"), "_loops.json.pre-playbooks-2026-10-02"), "utf8")).toBe(before);
    const pb = JSON.parse(readFileSync(join(PB, "foo-watch.json"), "utf8"));
    expect(pb.schedule).toMatchObject({ space: "foo", loop: "foo-watch", cadence: "weekly", enabled: true, autonomy: "tasks", lastRunTs: RAN, migrated: "2026-10-02" });
    expect(pb.steps).toHaveLength(1);
    expect(pb.steps[0].kind).toBe("loop");
    expect(pb.desiredState).toBe("Foo stays calm and paid.");
    const v = verifyMigration(V);
    expect(v).toMatchObject({ checked: 4, same: 4, differ: [] });
    // Run again: nothing new to carry, no second copy.
    expect(migrateLoops(V).migrated).toEqual([]);
    expect(readdirSync(PB).length).toBe(5);
  });

  test("a dry run writes nothing", () => {
    expect(migrateLoops(V, { dryRun: true }).migrated).toHaveLength(4);
    expect(readdirSync(PB)).toEqual(["foo-weekly.json"]);
    expect(existsSync(join(D("foo"), "_loops.json.pre-playbooks-2026-10-02"))).toBe(false);
  });

  test("the runner runs a carried-over loop once, and its last run goes on the playbook, not the loops file", async () => {
    migrateLoops(V);
    const before = readFileSync(join(D("foo"), "_loops.json"), "utf8");
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8").match(/Check the foo plan/g)!.length).toBe(1);
    expect(readFileSync(join(D("foo"), "_loops.json"), "utf8")).toBe(before);
    const last = JSON.parse(readFileSync(join(PB, "foo-foo-weekly.json"), "utf8")).schedule.lastRunTs;
    expect(typeof last).toBe("number");
    expect(readLoops(V, D("foo")).find((l) => l.id === "foo-weekly")!.lastRunTs).toBe(last);
  });

  test("a loop added after the migration still runs, and the next pass carries it over", async () => {
    migrateLoops(V);
    const doc = JSON.parse(readFileSync(join(D("foo"), "_loops.json"), "utf8"));
    doc.loops.push({ id: "foo-new", name: "Foo new", purpose: "New", type: "open", cadence: "monthly", status: "paused", enabled: false, lastRunTs: null, actions: [] });
    writeFileSync(join(D("foo"), "_loops.json"), JSON.stringify(doc));
    expect(readLoops(V, D("foo")).map((l) => l.id)).toContain("foo-new");
    await loopsOnce({ vaultPath: V, intervalSec: 60, provider: "claude", model: "" });
    expect(existsSync(join(PB, "foo-new.json"))).toBe(true);
  });

  test("Playbooks shows each schedule: cadence, next run, last run, approvals, what triggers it", () => {
    migrateLoops(V);
    const rows = playbookRows(V);
    const watch = rows.find((r) => r.id === "foo-watch")!;
    expect(watch.group).toBe("scheduled");
    expect(watch.schedule).toMatchObject({ space: "foo", cadence: "weekly", enabled: true, autonomy: "tasks", lastRunTs: RAN, nextRunTs: RAN + 7 * DAY });
    expect(rows.find((r) => r.id === "foo-renew")!.schedule!.nextRunTs).toBeNull();
    expect(playbookTriggers(V, "foo-weekly").map((t) => t.loop).sort()).toEqual(["foo-renew", "foo-weekly"]);
    expect(playbookView(V, "foo-digest")!.rows[0]!.returns).toEqual(["page"]);
  });

  test("scheduling a built-in playbook makes a small one of yours; switching it off keeps the cadence", () => {
    rmSync(join(D("foo"), "_loops.json"));
    writeFileSync(join(PB, "zap.json"), JSON.stringify({ id: "zap", name: "Zap", goal: "Zap things", steps: [{ kind: "task", id: "s1", text: "Zap" }] }));
    setTrigger(V, "zap", "foo", { cadence: "monthly" });
    let pb = JSON.parse(readFileSync(join(PB, "zap.json"), "utf8"));
    expect(pb.schedule).toMatchObject({ space: "foo", cadence: "monthly", enabled: true });
    setTrigger(V, "zap", "foo", { enabled: false });
    pb = JSON.parse(readFileSync(join(PB, "zap.json"), "utf8"));
    expect(pb.schedule).toMatchObject({ cadence: "monthly", enabled: false });
    expect(readLoops(V, D("foo")).map((l) => [l.id, l.playbook, l.enabled])).toEqual([["pb-zap", "zap", false]]);
    // A built-in one (shipped with the engine) is never copied: a small playbook of yours runs it.
    setTrigger(V, "weekly-coach", "foo", { cadence: "weekly" });
    const w = JSON.parse(readFileSync(join(PB, "pb-weekly-coach.json"), "utf8"));
    expect(w.steps[0].loop.playbook).toBe("weekly-coach");
    expect(w.schedule).toMatchObject({ space: "foo", cadence: "weekly" });
    expect(playbookTriggers(V, "weekly-coach").map((t) => t.domain)).toEqual(["foo"]);
  });
});
