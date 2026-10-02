// Missions MS5: Telegram and the phone route to missions (a stub transport:
// the bot's logic is tested as the replies it would send, never a network),
// /m pins a chat, practice and spends count on the right mission, and MCP
// writes (create, status, complete) wait for the user's Allow in the Inbox and
// run at once when allowed. Invented missions only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { telegramCommand, telegramText, type Pin } from "./telegram-capture.ts";
import { createMission, readMission } from "./missions.ts";
import { approvePendingAct, denyPendingAct, readPendingActs } from "./act-gate.ts";
import { afterActAnswer, isEngineAct } from "./engine-acts.ts";
import { missionWriteTool } from "./missions-mcp.ts";
import { briefCommand } from "./telegram.ts";

const ROOT = join("/tmp", `prevail-ms5-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = Date.now();

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "learning", "home", "money"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), "{}"); }
  createMission(V, { name: "Learn the cello", outcome: "Learn the cello for the family", domains: [{ slug: "learning", role: "owner" }, { slug: "money", role: "consulted" }], budgetUsd: 500, now: NOW });
  createMission(V, { name: "Kitchen remodel", outcome: "A new foo kitchen by spring", domains: [{ slug: "home", role: "owner" }], now: NOW });
}
const ledger = (slug: string) => { try { return readFileSync(join(V, "data", "missions", slug, "memory", "ledger.jsonl"), "utf8"); } catch { return ""; } };

describe("Telegram and the phone route to projects", () => {
  beforeEach(seed);
  test("practice and a spend file to the project the words name, with no model turn", async () => {
    const pin: Pin = {};
    const a = await telegramText("practiced 30 min on scales", V, pin);
    expect(a).toEqual({ reply: "Filed practice in the project Learn the cello's progress." });
    const b = await telegramText("paid $340 for the kitchen tiles", V, pin);
    expect("reply" in b && b.reply).toBe("Filed a spend in the project Kitchen remodel's budget ($340).");
    expect(ledger("kitchen-remodel")).toContain('"usd":-340');
    // Anything else is a chat turn, as before.
    expect(await telegramText("how are the markets today?", V, pin)).toEqual({ prompt: "how are the markets today?" });
  });

  test("/m pins a chat: turns run inside the project, spends land there, /m off unpins", async () => {
    const pin: Pin = {};
    expect(await telegramCommand("/m", "", V, pin)).toContain("Not pinned to a project.\nActive projects: Kitchen remodel (/m kitchen-remodel), Learn the cello (/m learn-the-cello)");
    expect(await telegramCommand("/m", "kitchen", V, pin)).toContain("Pinned to the project Kitchen remodel.");
    expect(pin.mission).toBe("kitchen-remodel");
    const t = await telegramText("what should I order first?", V, pin);
    expect("prompt" in t && t.cwd).toBe(join(V, "data", "missions", "kitchen-remodel"));
    expect("prompt" in t && t.prompt).toContain("# PROJECT REFERENCED: Kitchen remodel");
    const s = await telegramText("spent $45 on samples", V, pin);
    expect("reply" in s && s.reply).toContain("Kitchen remodel's budget ($45)");
    expect(await telegramCommand("/m", "nothing like it", V, pin)).toBe('No active project matches "nothing like it". /m to list them.');
    expect(await telegramCommand("/m", "off", V, pin)).toContain("Unpinned.");
    expect(pin.mission).toBeUndefined();
    expect(await telegramCommand("/status", "", V, pin)).toBeNull();
  });

  test("/tell and /forget; the weekly review carries a line per project", async () => {
    const pin: Pin = { mission: "learn-the-cello" };
    expect(await telegramCommand("/tell", "note that the teacher prefers Saturdays", V, pin)).toMatch(/^Filed a note in the project Learn the cello's log\. \(undo: prevail tell undo t\w+\)$/);
    expect(readFileSync(join(V, "data", "missions", "learn-the-cello", "memory", "log.md"), "utf8")).toContain("The teacher prefers Saturdays");
    expect(await telegramCommand("/forget", "", V, pin)).toMatch(/open loop|Nothing open/);
    const review = await briefCommand("/review", "", V);
    expect(review).toContain("Project: Learn the cello");
    expect(review).toContain("Project: Kitchen remodel");
  });
});

describe("MCP writes behind approval", () => {
  beforeEach(seed);
  test("create: queued in the Inbox, run the moment it is allowed, a retry says it is done", async () => {
    const q = await missionWriteTool(V, "create_mission", { name: "Trip to Foo Island", outcome: "A week on Foo Island", target: "2027-03-01", owner: "home" });
    expect(q).toMatch(/^Not done yet: this waits for the user's approval in Prevail's Inbox/);
    expect(readMission(V, "trip-to-foo-island")).toBeNull();
    const act = readPendingActs(V).find((a) => a.tool === "mcp__prevail-missions__create_mission")!;
    expect(act.summary).toBe('Start the project "Trip to Foo Island": A week on Foo Island, by 2027-03-01');
    expect(isEngineAct(act.tool)).toBe(true);
    // The same request again is not queued twice.
    await missionWriteTool(V, "create_mission", { name: "Trip to Foo Island", outcome: "A week on Foo Island", target: "2027-03-01", owner: "home" });
    expect(readPendingActs(V).filter((a) => a.tool === act.tool).length).toBe(1);
    expect(approvePendingAct(V, act.id).ok).toBe(true);
    expect(await afterActAnswer(V, act, "approved")).toEqual({ ran: "Started the project Trip to Foo Island (mission/trip-to-foo-island), target 2027-03-01." });
    expect(readMission(V, "trip-to-foo-island")?.status).toBe("active");
    expect(await missionWriteTool(V, "create_mission", { name: "Trip to Foo Island", outcome: "A week on Foo Island", target: "2027-03-01", owner: "home" })).toBe("Already done: The project mission/trip-to-foo-island exists.");
  });

  test("status and complete: denied stays undone; allowed completes with the close-out", async () => {
    await missionWriteTool(V, "set_mission_status", { mission: "kitchen-remodel", op: "pause" });
    const p = readPendingActs(V).find((a) => a.tool.endsWith("set_mission_status"))!;
    expect(p.summary).toBe("Pause the project kitchen-remodel");
    expect(denyPendingAct(V, p.id).ok).toBe(true);
    expect(await afterActAnswer(V, p, "denied")).toEqual({ ran: "declined" });
    expect(readMission(V, "kitchen-remodel")?.status).toBe("active");
    expect(await missionWriteTool(V, "set_mission_status", { mission: "kitchen-remodel", op: "pause" })).toMatch(/declined/);

    await missionWriteTool(V, "complete_mission", { mission: "learn-the-cello", result: "partly" });
    const c = readPendingActs(V).find((a) => a.tool.endsWith("complete_mission"))!;
    expect(c.summary).toMatch(/^Complete the project Learn the cello \(partly\): files \d+ lines? into .*, each with Undo for 7 days$/);
    approvePendingAct(V, c.id);
    const r = await afterActAnswer(V, c, "approved");
    expect(r.ran).toMatch(/^Completed the project Learn the cello/);
    expect(readMission(V, "learn-the-cello")?.status).toBe("completed");
    await expect(missionWriteTool(V, "set_mission_status", { mission: "kitchen-remodel", op: "explode" })).rejects.toThrow("op is pause, resume, archive or reopen");
  });
});
