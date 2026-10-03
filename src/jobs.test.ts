import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  adjustJob, codeCheck, dispatch, jobView, learnedStaffing, parseDispatchReply, parseStepOutput, readJob, readReceipts,
  runJob, saveJob, shapeOf, startJob, stopJob, teamFor, undoFiled, type Job,
} from "./jobs.ts";
import { appendNotebook, builtInSpecialists, forDomain, getSpecialist, loadSpecialists, NOTEBOOK_MAX, parseSpecialist, readNotebook } from "./specialists.ts";
import { readChiefOfStaff, setChiefSetting } from "./chief-of-staff.ts";
import { runChatJson } from "./chat-json.ts";

const ROOT = join("/tmp", `prevail-jobs-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "insurance", "property", "money", "tax", "health"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state for ${d}.\n`);
  }
  writeFileSync(join(D("insurance"), "ideal-state.md"), "# Insurance\nEvery foo property covered.\n");
  writeFileSync(join(D("insurance"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Existing foo task ~id:abc1234\n");
}

const fakeCli = { kind: "claude" as const, bin: "/bin/false", label: "claude" };
const detectClis = async () => [fakeCli] as never;
const dispatchReply = JSON.stringify({ owner: "insurance", consulted: ["property", "money", "health"], informed: ["tax"], effort: "standard", open_ended: true, decision: true, why: "compare and choose; money involved" });

function fakeTurn(log: string[]) {
  return async (t: { prompt: string }) => {
    const who = /You are the (\w+)/.exec(t.prompt)?.[1] ?? "";
    log.push(who);
    if (who === "Researcher") return JSON.stringify({ summary: "Carrier A is cheapest", body: "Carrier A and Carrier B compared on foo facts.", sources: ["https://example.com/a"], check: { ok: true, missing: [] }, notebook: ["Rating is the tiebreak"] });
    if (who === "Scout") return JSON.stringify({ summary: "Bundle discount exists", body: "A bundle discount and a renewal window you did not ask about.", sources: ["https://example.com/b"], check: { ok: true, missing: [] }, notebook: [] });
    if (who === "Steward") return JSON.stringify({ summary: "fits", verdict: "fits", body: "It fits peace of mind and the foo goal.", sources: [], check: { ok: true, missing: [] }, notebook: [] });
    if (who === "Editor") return "```json\n" + JSON.stringify({ summary: "Carrier A for both foo rentals", body: "## Answer\nCarrier A.\n\n| Carrier | Price |\n|---|---|\n| A | $1 |", sources: ["https://example.com/a"], check: { ok: true, missing: [] }, notebook: [], filed: { decision: "Carrier A for the foo rentals", task: { text: "Renew with Carrier A", due: "2026-12-01" }, notes: { property: "Premiums drop about $340 a year", money: "Cash flow up about $28 a month", tax: "Keep premium receipts", health: "should never be written" } } }) + "\n```";
    return "";
  };
}

describe("specialists", () => {
  beforeEach(seed);
  test("all twenty-one are on (Phase 4 turned on the last four)", () => {
    const all = builtInSpecialists();
    expect(all.filter((s) => s.on).map((s) => s.id)).toEqual(["researcher", "scout", "planner", "steward", "editor", "writer", "analyst", "historian", "sentinel", "auditor", "builder", "clerk", "operator", "coach", "skeptic", "interviewer", "mechanic", "negotiator", "liaison", "tutor", "confidant"]);
    expect(all.length).toBe(21);
    expect(getSpecialist(V, "writer")!.ceiling).toBe("draft");
    expect(getSpecialist(V, "editor")!.ceiling).toBe("write-vault");
  });
  test("a user file overrides a built-in and adds custom ones", () => {
    mkdirSync(join(V, "build", "specialists"), { recursive: true });
    writeFileSync(join(V, "build", "specialists", "researcher.md"), "---\nid: researcher\nbudget: { minutes: 2, usd: 0.1, passes: 1 }\n---\n");
    writeFileSync(join(V, "build", "specialists", "foo-checker.md"), "---\nid: foo-checker\nname: Foo checker\nfamily: decide\nreturns: verdict\nceiling: read\n---\n## Mandate\nChecks foo.\n");
    const r = getSpecialist(V, "researcher")!;
    expect(r.budget).toEqual({ minutes: 2, usd: 0.1, passes: 1 });
    expect(r.mandate).toContain("sourced");
    expect(r.source).toBe("build/specialists/researcher.md");
    expect(loadSpecialists(V).find((s) => s.id === "foo-checker")?.on).toBe(true);
  });
  test("a domain can tighten a specialist, never loosen it", () => {
    mkdirSync(join(D("insurance"), "source", "specialists"), { recursive: true });
    writeFileSync(join(D("insurance"), "source", "specialists", "editor.md"), "---\nceiling: act\ntools: [vault-read, web]\n---\nAlways put the price first.\n");
    const { spec, notes } = forDomain(V, getSpecialist(V, "editor")!, "insurance");
    expect(spec.ceiling).toBe("write-vault");
    expect(spec.tools).toEqual(["vault-read"]);
    expect(notes).toBe("Always put the price first.");
    writeFileSync(join(D("insurance"), "source", "specialists", "editor.md"), "---\nceiling: read\n---\n");
    expect(forDomain(V, getSpecialist(V, "editor")!, "insurance").spec.ceiling).toBe("read");
  });
  test("notebooks dedupe and stay short", () => {
    expect(appendNotebook(V, "insurance", "researcher", ["Rating is the tiebreak", "rating is the tiebreak", "x"])).toHaveLength(1);
    expect(appendNotebook(V, "insurance", "researcher", ["Rating is the tiebreak"])).toHaveLength(0);
    for (let i = 0; i < 40; i++) appendNotebook(V, "insurance", "researcher", [`Foo lesson number ${i}`]);
    expect(readNotebook(V, "insurance", "researcher")).toHaveLength(NOTEBOOK_MAX);
  });
  test("a malformed id is refused", () => {
    expect(parseSpecialist("---\nid: ../x\n---\n")).toBeNull();
  });
});

describe("dispatch", () => {
  beforeEach(seed);
  test("questions are answered; jobs have a shape", () => {
    expect(shapeOf("what is an umbrella policy?")).toBeNull();
    expect(shapeOf("thanks")).toBeNull();
    expect(shapeOf("Find the best insurance providers for next year for the rentals")).toBe("find");
    expect(shapeOf("Can you plan the move to the new foo office")).toBe("plan");
    expect(shapeOf("draft an email to the property manager about the lease")).toBe("do");
  });
  test("the insurance example: owner, reads, tells, team, starts alone", async () => {
    setChiefSetting(V, "never", "health");
    const d = await dispatch({ vault: V, message: "Find the best insurance providers for next year for the rentals", domain: "insurance", runner: async () => dispatchReply, now: Date.UTC(2026, 9, 1, 14, 32) });
    expect(d.kind).toBe("job");
    const j = d.job!;
    expect(j.domains).toEqual({ owner: "insurance", consulted: ["property", "money"], informed: ["tax"] });
    expect(j.team.map((s) => s.specialists)).toEqual([["researcher", "scout"], ["steward"], ["editor"]]);
    expect(j.team[1]!.gate).toBe(true);
    expect(j.startsAlone).toBe(true);
    expect(j.budget).toEqual({ usd: 1, minutes: 10 });
  });
  test("a never-read domain comes back when the message names it", async () => {
    setChiefSetting(V, "never", "health");
    const d = await dispatch({ vault: V, message: "Find the best plan that covers health and the rentals", domain: "insurance", runner: async () => dispatchReply });
    expect(d.job!.domains.consulted).toContain("health");
  });
  test("money, people, location or identity asks first; so does an unsure staffing", async () => {
    const a = await dispatch({ vault: V, message: "Find and buy the cheapest foo policy for the rentals", domain: "insurance", runner: async () => dispatchReply });
    expect(a.job!.startsAlone).toBe(false);
    expect(a.job!.askReason).toMatch(/money/);
    const b = await dispatch({ vault: V, message: "Find the best foo providers for next year", domain: "insurance", runner: async () => "no json" });
    expect(b.job!.startsAlone).toBe(false);
    expect(b.job!.askReason).toMatch(/not sure/);
    expect(b.job!.domains.owner).toBe("insurance");
  });
  test("over the user's limit asks first", async () => {
    setChiefSetting(V, "usd", "0.5");
    const d = await dispatch({ vault: V, message: "Find the best foo providers for next year", domain: "insurance", runner: async () => dispatchReply });
    expect(d.job!.askReason).toMatch(/over your limit/);
  });
  test("@Researcher hands one piece to one specialist", async () => {
    const d = await dispatch({ vault: V, message: "@Researcher what does a foo umbrella policy cost?", domain: "insurance", runner: null });
    expect(d.mention).toBe("researcher");
    expect(d.job!.team).toEqual([{ step: 1, specialists: ["researcher"] }]);
    expect(d.job!.ask).toBe("what does a foo umbrella policy cost?");
  });
  test("the dispatch reply is validated against real domains", () => {
    expect(parseDispatchReply('{"owner":"nope","consulted":["money","x"],"effort":"huge"}', ["money"])).toMatchObject({ owner: undefined, consulted: ["money"], effort: "standard" });
  });
  test("teams leave out specialists that are off", () => {
    expect(teamFor("find", new Set(["researcher", "editor"]))).toEqual([{ step: 1, specialists: ["researcher"] }, { step: 2, specialists: ["editor"] }]);
  });
});

describe("running a job", () => {
  beforeEach(seed);
  async function insuranceJob(): Promise<Job> {
    setChiefSetting(V, "never", "health");
    const d = await dispatch({ vault: V, message: "Find the best insurance providers for next year for the rentals", domain: "insurance", runner: async () => dispatchReply });
    saveJob(V, d.job!);
    return d.job!;
  }
  test("runs end to end, files one write per domain, and Undo reverses each", async () => {
    const job = await insuranceJob();
    const log: string[] = [];
    const done = await runJob(V, job.id, { detectClis, runChatTurn: fakeTurn(log) as never });
    expect(done.status).toBe("done");
    expect(log).toEqual(["Researcher", "Scout", "Steward", "Editor"]);
    expect(done.result!.summary).toBe("Carrier A for both foo rentals");
    expect(done.result!.verdict).toBe("fits");
    expect(done.cost!.estimated).toBe(true);
    const page = join(V, done.result!.page!);
    expect(readFileSync(page, "utf8")).toContain("| Carrier | Price |");
    const filed = readReceipts(V, job.id);
    expect(filed.map((r) => `${r.domain}:${r.kind}`)).toEqual(["insurance:page", "insurance:decision", "insurance:task", "property:note", "money:note", "tax:note"]);
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toMatch(/- \[ \] Renew with Carrier A @2026-12-01 \+\d{4}-\d{2}-\d{2} ~src:job:/);
    expect(existsSync(join(D("health"), "memory", "updates.jsonl"))).toBe(false);
    expect(readFileSync(join(D("property"), "memory", "updates.jsonl"), "utf8")).toContain("Premiums drop");
    expect(readNotebook(V, "insurance", "researcher")[0]).toContain("Rating is the tiebreak");
    const v = jobView(V, job.id)!;
    expect(v.steps.map((s: { specialist: string; status: string }) => `${s.specialist}:${s.status}`)).toEqual(["researcher:done", "scout:done", "steward:done", "editor:done"]);
    // Undo each.
    for (const r of filed) undoFiled(V, job.id, r.n);
    expect(existsSync(page)).toBe(false);
    expect(existsSync(join(V, "build", "_meta", "jobs", job.id, "undone", page.split("/").pop()!))).toBe(true);
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).not.toContain("Carrier A");
    expect(readFileSync(join(D("insurance"), "memory", "tasks.md"), "utf8")).toContain("Existing foo task");
    expect(readFileSync(join(D("property"), "memory", "updates.jsonl"), "utf8").trim()).toBe("");
    expect(readReceipts(V, job.id).every((r) => r.undone)).toBe(true);
  });
  test("a self-check miss gets another pass; the code check needs sources", async () => {
    const d = await dispatch({ vault: V, message: "@Researcher compare foo carriers", domain: "insurance", runner: null });
    saveJob(V, d.job!);
    let n = 0;
    const turn = async () => (++n === 1 ? JSON.stringify({ summary: "A", body: "Carrier A is best for these foo reasons, all checked.", sources: [], check: { ok: true } }) : JSON.stringify({ summary: "A", body: "Carrier A is best for these foo reasons, all checked.", sources: ["https://example.com"], check: { ok: true } }));
    const done = await runJob(V, d.job!.id, { detectClis, runChatTurn: turn as never });
    expect(done.status).toBe("done");
    const step = jobView(V, d.job!.id)!.steps[0] as { passes: { check: { ok: boolean; missing: string[] } }[] };
    expect(step.passes.map((p) => p.check.ok)).toEqual([false, true]);
    expect(step.passes[0]!.check.missing).toContain("no sources");
  });
  test("the budget stops a run in code", async () => {
    const job = await insuranceJob();
    job.budget = { usd: 0.001, minutes: 10 };
    saveJob(V, job);
    const done = await runJob(V, job.id, { detectClis, runChatTurn: fakeTurn([]) as never });
    expect(done.status).toBe("failed");
    expect(done.note).toMatch(/budget reached/);
  });
  test("a gate that says it does not fit stops before the Editor", async () => {
    const job = await insuranceJob();
    const log: string[] = [];
    const base = fakeTurn(log);
    const turn = async (t: { prompt: string }) => (/You are the Steward/.test(t.prompt) ? (log.push("Steward"), JSON.stringify({ summary: "does not fit", verdict: "does not fit", body: "It breaks the no new debt rule for foo.", check: { ok: true } })) : base(t));
    const done = await runJob(V, job.id, { detectClis, runChatTurn: turn as never });
    expect(done.status).toBe("needs-approval");
    expect(log).not.toContain("Editor");
    expect(readReceipts(V, job.id)).toEqual([]);
  });
  test("a run cut off by time is a failure, never a page that says cancelled", async () => {
    const job = await insuranceJob();
    const base = fakeTurn([]);
    const turn = async (t: { prompt: string }) => (/You are the Editor/.test(t.prompt) ? "(cancelled)" : base(t));
    const done = await runJob(V, job.id, { detectClis, runChatTurn: turn as never });
    expect(done.status).toBe("failed");
    expect(done.note).toMatch(/Editor returned nothing usable: time ran out/);
    expect(readReceipts(V, job.id)).toEqual([]);
  });
  test("stop and start", async () => {
    const job = await insuranceJob();
    expect(stopJob(V, job.id).status).toBe("stopped");
    expect(existsSync(join(V, "build", "_meta", "jobs", job.id, "stop"))).toBe(true);
    const again = startJob(V, job.id, { detached: false });
    expect(again.status).toBe("proposed");
    expect(existsSync(join(V, "build", "_meta", "jobs", job.id, "stop"))).toBe(false);
  });
  test("parsing: prose falls back to the body with its links", () => {
    const o = parseStepOutput("Carrier A wins.\nSee https://example.com/x for details.");
    expect(o.sources).toEqual(["https://example.com/x"]);
    expect(codeCheck(getSpecialist(V, "researcher")!, { ...o, sources: [] })).toContain("no sources");
  });
});

describe("adjust and learning", () => {
  beforeEach(seed);
  test("Adjust is logged; twice the same correction becomes a rule the next dispatch follows", async () => {
    for (let i = 0; i < 2; i++) {
      const d = await dispatch({ vault: V, message: `Find the best foo providers for next year, round ${i}`, domain: "insurance", runner: async () => dispatchReply, now: Date.UTC(2026, 9, 1, 10, i) });
      saveJob(V, d.job!);
      const j = adjustJob(V, d.job!.id, { team: [["researcher"], ["steward"], ["editor"]], effort: "quick" });
      expect(j.effort).toBe("quick");
      expect(j.budget.usd).toBe(0.3);
    }
    expect([...(learnedStaffing(V).skip.get("insurance") ?? [])]).toEqual(["scout"]);
    expect(readChiefOfStaff(V).learned).toContain("insurance jobs: skip the scout");
    const next = await dispatch({ vault: V, message: "Find the best foo providers for the cabin", domain: "insurance", runner: async () => dispatchReply });
    expect(next.job!.team[0]!.specialists).toEqual(["researcher"]);
  });
  test("a running job cannot be adjusted", async () => {
    const d = await dispatch({ vault: V, message: "Find the best foo providers for next year", domain: "insurance", runner: async () => dispatchReply });
    saveJob(V, { ...d.job!, status: "running" });
    expect(() => adjustJob(V, d.job!.id, { effort: "deep" })).toThrow(/stop the job/);
    expect(readJob(V, d.job!.id)!.effort).toBe("standard");
  });
});

describe("chat hands jobs to the chief of staff", () => {
  beforeEach(seed);
  test("a job-shaped message gets a job card and a one-line reply, no model turn", async () => {
    const lines: string[] = [];
    let modelTurns = 0;
    let started = "";
    const code = await runChatJson({
      vaultPath: V, domain: "insurance", message: "Find the best insurance providers for next year for the rentals",
      write: (l) => lines.push(l),
      deps: {
        detectClis, runChatTurn: (async () => { modelTurns++; return "x"; }) as never, persistMessage: () => {},
        dispatch: (i) => dispatch({ ...i, runner: async () => dispatchReply }),
        startJob: (_v, id) => { started = id; },
      },
    });
    expect(code).toBe(0);
    expect(modelTurns).toBe(0);
    const evs = lines.map((l) => JSON.parse(l));
    const job = evs.find((e) => e.type === "job").job;
    expect(job.owner).toBe("insurance");
    expect(job.status).toBe("running");
    expect(started).toBe(job.id);
    expect(evs.find((e) => e.type === "assistant").text).toMatch(/^On it\./);
  });
  test("an ordinary question still gets an ordinary answer", async () => {
    const lines: string[] = [];
    let modelTurns = 0;
    await runChatJson({
      vaultPath: V, domain: "insurance", message: "what is an umbrella policy?", write: (l) => lines.push(l),
      deps: { detectClis, runChatTurn: (async () => { modelTurns++; return "An umbrella foo answer."; }) as never, persistMessage: () => {}, dispatch: (i) => dispatch({ ...i, runner: async () => dispatchReply }) },
    });
    expect(modelTurns).toBe(1);
    expect(lines.some((l) => l.includes('"type":"job"'))).toBe(false);
  });
  test("handoff off: only @ by hand", async () => {
    setChiefSetting(V, "handoff", "off");
    const lines: string[] = [];
    await runChatJson({
      vaultPath: V, domain: "insurance", message: "Find the best insurance providers for next year for the rentals", write: (l) => lines.push(l),
      deps: { detectClis, runChatTurn: (async () => "ok answer") as never, persistMessage: () => {}, dispatch: (i) => dispatch({ ...i, runner: async () => dispatchReply }) },
    });
    expect(lines.some((l) => l.includes('"type":"job"'))).toBe(false);
  });
});

describe("a specialist's read-only tools reach the runtime", () => {
  test("allowTools grants only read-only built-ins, and web only when web is allowed", async () => {
    const { chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { runChatTurn } = await import("./cli-bridge.ts");
    const dir = mkdtempSync(join(tmpdir(), "fake-spec-cli-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
    chmodSync(bin, 0o755);
    const cwd = join(dir, "vault", "foo");
    mkdirSync(cwd, { recursive: true });
    const cli = { kind: "claude" as const, bin, label: "claude" };
    const a = (await runChatTurn({ prompt: "hi", cwd, cli, model: "", isFirst: true, bare: true, webAccess: "allow", allowTools: ["WebSearch", "WebFetch", "Read", "Bash", "Write"] })).split("\n");
    const at = a.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    for (const t of ["WebSearch", "WebFetch", "Read"]) expect(a.slice(at + 1)).toContain(t);
    expect(a).not.toContain("Bash");
    expect(a).not.toContain("Write");
    expect(a).not.toContain("--dangerously-skip-permissions");
    const b = (await runChatTurn({ prompt: "hi", cwd, cli, model: "", isFirst: true, bare: true, webAccess: "deny", allowTools: ["WebSearch", "Read"] })).split("\n");
    const bt = b.slice(b.indexOf("--allowedTools") + 1);
    expect(bt).toContain("Read");
    expect(bt).not.toContain("WebSearch");
    // A group chat member: no shell at all, denied up front beside the web lockdown.
    const c = (await runChatTurn({ prompt: "hi", cwd, cli, model: "", isFirst: true, bare: true, webAccess: "deny", allowTools: ["Read"], noShell: true })).split("\n");
    expect(c.slice(c.indexOf("--disallowedTools") + 1, c.indexOf("--disallowedTools") + 4)).toEqual(["WebSearch", "WebFetch", "Bash"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
