// Today T6: tell the chief of staff anything, on any surface. Each kind is
// filed by code where it belongs, with a receipt and an Undo that restores
// the exact bytes; "What am I forgetting?" lists the open loops; chat files
// at once with no model call; mail to yourself is filed once. Invented data.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE, FORGETTING, domainForText, forgetting, forgettingText, missionForText, readTold, tell, tellFromMail, toldReply, undoTold } from "./tell.ts";
import { createMission } from "./missions.ts";
import { runChatJson } from "./chat-json.ts";
import { topCandidates } from "./said.ts";

const ROOT = join("/tmp", `prevail-tell-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = new Date(2026, 9, 1, 12).getTime(); // Thu 2026-10-01
const board = (d: string) => { try { return readFileSync(join(D(d), "memory", "tasks.md"), "utf8"); } catch { return ""; } };

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "home", "money"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "memory", "tasks.md"), "# Tasks\n\n- [ ] Old foo task @2026-09-20 ~id:old1\n"); }
  writeFileSync(join(D("home"), "manifest.json"), JSON.stringify({ routing: { keywords: ["boiler", "roof"] } }));
  writeFileSync(join(D("money"), "manifest.json"), JSON.stringify({ routing: { keywords: ["invoice"] } }));
  writeFileSync(join(D("general"), "manifest.json"), "{}");
}

describe("where it goes", () => {
  beforeEach(seed);
  test("a domain by its name or routing keywords, else General; a project by its words", () => {
    expect(domainForText(V, "the boiler made a noise")).toBe("home");
    expect(domainForText(V, "money: check the foo invoice")).toBe("money");
    expect(domainForText(V, "something unrelated")).toBe("general");
  });
  test("an active project the words point at; practice goes to the only learning project", async () => {
    createMission(V, { name: "Learn the cello", outcome: "Learn the cello for the family", domains: [{ slug: "home", role: "owner" }], now: NOW });
    createMission(V, { name: "Kitchen remodel", outcome: "A new foo kitchen", domains: [{ slug: "home", role: "owner" }], now: NOW });
    expect((await missionForText(V, "the kitchen tiles arrived"))?.slug).toBe("kitchen-remodel");
    expect((await missionForText(V, "practiced 30 min today"))?.slug).toBe("learn-the-cello");
    expect(await missionForText(V, "nothing to do with either")).toBeNull();
  });
});

describe("what it is, with Undo", () => {
  beforeEach(seed);
  test("a task with its date, a promise, a waiting-for, a decision, a Compass line, a number, a note", async () => {
    const before = board("home");
    const t = await tell(V, "Remind me to call the boiler company by Friday", { surface: "phone", now: NOW });
    expect([t.kind, t.domain, t.due]).toEqual(["task", "home", "2026-10-02"]);
    expect(board("home")).toMatch(/- \[ \] Call the boiler company @2026-10-02 \+2026-10-01 ~src:tell:phone:\S+ ~id:t\S+\n$/);
    await undoTold(V, t.id, NOW);
    expect(board("home")).toBe(before);

    const p = await tell(V, "I promised Sam I'd send the foo photos tomorrow", { surface: "telegram", now: NOW });
    expect([p.kind, p.domain, p.due]).toEqual(["commitment", "general", "2026-10-02"]);
    expect((await tell(V, "Jordan owes me the signed foo lease by Oct 7", { surface: "chat", now: NOW })).kind).toBe("waiting");

    const d = await tell(V, "Should I sell the foo bike?", { surface: "chat", domain: "money", now: NOW });
    expect([d.kind, d.text, d.due]).toEqual(["decision", "Should I sell the foo bike?", "2026-10-15"]);
    expect(existsSync(join(V, d.file!))).toBe(true);
    await undoTold(V, d.id, NOW);
    expect(existsSync(join(V, d.file!))).toBe(false);

    const c = await tell(V, "My goal is to run a foo marathon", { surface: "mcp", now: NOW });
    expect(c.kind).toBe("candidate");
    expect(topCandidates(V, 5).map((x) => x.title)).toEqual(["Run a foo marathon"]);
    await undoTold(V, c.id, NOW);
    expect(topCandidates(V, 5)).toEqual([]);

    expect((await tell(V, "ran 5 km this morning", { surface: "phone", now: NOW })).kind).toBe("metric");

    const n = await tell(V, "note that the boiler is twelve years old", { surface: "email", now: NOW });
    expect([n.kind, n.domain, n.text]).toEqual(["note", "home", "The boiler is twelve years old"]);
    const up = readFileSync(join(D("home"), "memory", "updates.jsonl"), "utf8");
    expect(up).toContain('"fact":"The boiler is twelve years old"');
    await undoTold(V, n.id, NOW);
    expect(readFileSync(join(D("home"), "memory", "updates.jsonl"), "utf8")).toBe("");
    expect(readTold(V).filter((r) => r.undone).length).toBe(4);
    expect(toldReply(p)).toBe("Filed a promise in General's board, as a promise.");
  });

  test("practice and a spend go to the project; Undo takes them out", async () => {
    createMission(V, { name: "Learn the cello", outcome: "Learn the cello for the family", domains: [{ slug: "home", role: "owner" }], budgetUsd: 500, now: NOW });
    const pr = await tell(V, "practiced 30 min", { surface: "telegram", now: NOW });
    expect([pr.kind, pr.mission]).toEqual(["practice", "learn-the-cello"]);
    const sp = await tell(V, "paid $120 for the cello term fee", { surface: "telegram", now: NOW });
    expect([sp.kind, sp.where]).toEqual(["spend", "the project Learn the cello's budget ($120)"]);
    const ledger = join(V, "data", "missions", "learn-the-cello", "memory", "ledger.jsonl");
    expect(readFileSync(ledger, "utf8")).toContain('"usd":-120');
    await undoTold(V, sp.id, NOW);
    expect(readFileSync(ledger, "utf8").trim()).toBe("");
  });
});

describe("what am I forgetting, chat, mail", () => {
  beforeEach(seed);
  test("open loops by kind: promises, waiting-fors, decisions, overdue tasks", async () => {
    await tell(V, "I promised Sam I'd send the foo photos tomorrow", { surface: "chat", now: NOW });
    await tell(V, "Should I sell the foo bike?", { surface: "chat", domain: "money", now: NOW });
    const f = await forgetting(V, NOW);
    expect(f.sections.map((s) => s.title)).toEqual(expect.arrayContaining(["Promises you made", "Decisions to make", "Overdue tasks"]));
    expect(forgettingText(f)).toContain("- Old foo task (overdue since 2026-09-20, Home)");
    expect(FORGETTING.test("What am I forgetting?")).toBe(true);
    expect(CAPTURE.test("note that the roof leaks")).toBe(true);
    expect(CAPTURE.test("what is a good roof?")).toBe(false);
  });

  test("in chat: filed at once with a told event and no model call; the question answered by code", async () => {
    const run = async (message: string) => {
      const lines: string[] = []; let model = 0;
      await runChatJson({ vaultPath: V, domain: "general", message, write: (l) => lines.push(l), deps: { detectClis: async () => [{ kind: "claude", bin: "/bin/false", label: "claude" }] as never, runChatTurn: (async () => { model++; return "x"; }) as never, persistMessage: () => {} } });
      return { evs: lines.map((l) => JSON.parse(l)), model };
    };
    const a = await run("remind me to check the roof gutters");
    expect(a.model).toBe(0);
    expect(a.evs.find((e) => e.type === "told").told).toMatchObject({ kind: "task", text: "Check the roof gutters" });
    expect(board("home")).toContain("Check the roof gutters");
    const b = await run("What am I forgetting?");
    expect(b.model).toBe(0);
    expect(b.evs.find((e) => e.type === "assistant").text).toMatch(/open loop/);
  });

  test("mail you sent yourself with tell: or todo: is filed once", async () => {
    mkdirSync(join(V, "build", "_meta", "mail"), { recursive: true });
    const h = (id: string, subject: string, to = "me@example.com") => JSON.stringify({ id, thread: id, ts: NOW - 3_600_000, dir: "sent", from: "Me <me@example.com>", to: [to], subject });
    writeFileSync(join(V, "build", "_meta", "mail", "headers.me.jsonl"), [h("m1", "todo: renew the foo roof warranty"), h("m2", "tell: the boiler code is E4"), h("m3", "todo: not to myself", "sam@example.com"), h("m4", "Lunch?")].join("\n") + "\n");
    const r = await tellFromMail(V, NOW);
    expect(r.map((x) => [x.kind, x.surface])).toEqual([["task", "email"], ["note", "email"]]);
    expect(await tellFromMail(V, NOW)).toEqual([]);
  });
});
