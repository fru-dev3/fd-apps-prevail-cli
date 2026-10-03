// Decisions heard in conversation: code notices a stated decision in the
// user's words, saves a decided record with the thread, never twice; Undo
// moves it aside; the backfill reads threads and never writes them.
// Invented people and data only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backfillDecisions, captureDecision, decisionMade, undoCaptured } from "./decision-capture.ts";
import { listDecisions } from "./decision-records.ts";

const ROOT = join("/tmp", `prevail-dcap-${process.pid}`);
const V = join(ROOT, "vault");
const D = (d: string) => join(V, "data", "domains", d);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of ["general", "learning", "dev"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), "{}"); }
});

describe("noticing a decision", () => {
  test("stated decisions are found in the user's words", () => {
    expect(decisionMade("Ok. I've decided to learn cello this winter.")?.what).toBe("Learn cello this winter");
    expect(decisionMade("I'm going to archive the three old foo projects")?.what).toBe("Archive the three old foo projects");
    expect(decisionMade("Let's go with the blue foo couch.")?.what).toBe("Go with the blue foo couch");
    expect(decisionMade("I chose the remote job at Bar Co")?.what).toBe("Chose the remote job at Bar Co");
    expect(decisionMade("From now on I'll stop working on Sundays.")?.what).toBe("Stop working on Sundays");
  });
  test("questions, maybes and plain steps are not decisions", () => {
    for (const t of ["Should I learn cello?", "I'm thinking about selling the foo car.", "I'll take a look at it later.", "Maybe I'll quit the gym.", "Can you decide for me?", "I'll write the intro first."]) expect(decisionMade(t)).toBeNull();
  });
});

describe("saving, once, with Undo", () => {
  test("a decided record with what, when, the thread and the domain; the same decision is not saved twice", () => {
    const c = captureDecision(V, { text: "I've decided to learn cello.", domain: "learning", thread: "t-1", now: Date.parse("2026-10-02T10:00:00Z") })!;
    expect(c).toMatchObject({ domain: "learning", what: "Learn cello", decided: "2026-10-02", thread: "t-1" });
    const text = readFileSync(join(D("learning"), "memory", "decisions", `${c.slug}.md`), "utf8");
    expect(text).toContain("status: decided");
    expect(text).toContain('thread: "t-1"');
    expect(text).toContain("source: chat");
    expect(captureDecision(V, { text: "Yes, I decided to learn cello", domain: "learning", thread: "t-1" })).toBeNull();
    expect(listDecisions(V, { all: true }).map((r) => r.question)).toEqual(["Learn cello"]);
  });
  test("Undo moves the record aside and it is gone from the list; a record the user made is not undone here", () => {
    const c = captureDecision(V, { text: "I'm going to quit the foo club.", domain: "general", thread: "t-2" })!;
    expect(undoCaptured(V, "general", c.slug)).toBe(true);
    expect(listDecisions(V, { all: true })).toEqual([]);
    expect(existsSync(join(D("general"), "memory", "decisions", "_undone", `${c.slug}.md`))).toBe(true);
    mkdirSync(join(D("general"), "memory", "decisions"), { recursive: true });
    writeFileSync(join(D("general"), "memory", "decisions", "mine.md"), "---\nquestion: \"Mine\"\nstatus: open\n---\n");
    expect(() => undoCaptured(V, "general", "mine")).toThrow(/only a decision saved from a conversation/);
  });
});

describe("backfill", () => {
  test("reads every thread once and saves what the user decided, dated by the thread; threads are untouched", () => {
    const dir = join(D("dev"), "memory", "threads");
    mkdirSync(dir, { recursive: true });
    const md = "---\ntitle: Foo\ncreated: 2026-08-23T13:11:13Z\n---\n\n## You\n\nI've decided to archive the old foo repos.\n\n## claude · opus\n\nGood call. I'll archive them.\n";
    writeFileSync(join(dir, "2026-08-23_foo.md"), md);
    writeFileSync(join(dir, "2026-08-24_bar.jsonl"), `${JSON.stringify({ role: "user", content: "Should I learn cello?", ts: 1 })}\n${JSON.stringify({ role: "user", content: "I'm going to start learning cello.", ts: Date.parse("2026-08-24T09:00:00Z") })}\n`);
    const dry = backfillDecisions(V, { dryRun: true });
    expect(dry.found.map((f) => f.what)).toEqual(["Archive the old foo repos", "Start learning cello"]);
    expect(listDecisions(V, { all: true })).toEqual([]);
    const r = backfillDecisions(V);
    expect(r.saved).toBe(2);
    expect(listDecisions(V, { all: true }).map((x) => [x.question, x.decided, x.domain])).toEqual([["Archive the old foo repos", "2026-08-23", "dev"], ["Start learning cello", "2026-08-24", "dev"]]);
    expect(backfillDecisions(V).saved).toBe(0);
    expect(readFileSync(join(dir, "2026-08-23_foo.md"), "utf8")).toBe(md);
    expect(readdirSync(dir).length).toBe(2);
  });
});

describe("backfill from the prompts captured from other AI tools", () => {
  test("typed prompts only: an agent's instructions, pasted output and other people's decisions are skipped", () => {
    const dir = join(V, "build", "_meta", "prompts");
    mkdirSync(dir, { recursive: true });
    const row = (prompt: string, ms: number) => JSON.stringify({ ts: new Date(ms).toISOString(), epoch_ms: ms, tool: "claude", session: "abcd1234-ef", prompt });
    writeFileSync(join(dir, "claude.jsonl"), [
      row("ok let's go with the foo tracker name.", Date.parse("2026-09-26T10:00:00Z")),
      row("You are agent 7. I've decided to quit the bar club.", 1),
      row("**Plan**\nI'm going to quit the foo gym", 2),
      row("Sam has decided to sell the foo boat.", 3),
    ].join("\n"));
    const r = backfillDecisions(V);
    expect(r.found.map((f) => [f.what, f.thread, f.decided])).toEqual([["Go with the foo tracker name", "claude-abcd1234", "2026-09-26"]]);
  });
});

