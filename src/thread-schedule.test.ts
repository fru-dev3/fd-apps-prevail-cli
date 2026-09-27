import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchedules, saveSchedules, tickAndRunDue, type ScheduleEntry } from "./schedule.ts";
import {
  addThreadSchedule, appendThreadMarkdown, isThreadScheduleDue, threadContext, tickThreadSchedules,
  type ThreadTurnRequest, type ThreadTurnRunner,
} from "./thread-schedule.ts";

// Conversation schedules: stored in .schedule.json, fired only on the hub, run
// as a chat turn through an injected runner (no model is ever called here).
const VAULT = `/tmp/prevail-thread-schedule-${process.pid}`;
const THREADS = join(VAULT, "data", "domains", "foo", "_threads");
const hub = () => false;
const client = () => true;

function recordingRunner(): { runner: ThreadTurnRunner; calls: ThreadTurnRequest[] } {
  const calls: ThreadTurnRequest[] = [];
  return { calls, runner: async (req) => { calls.push(req); return { ok: true, reply: "done" }; } };
}

beforeEach(() => {
  rmSync(VAULT, { recursive: true, force: true });
  mkdirSync(THREADS, { recursive: true });
});
afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

describe("add-thread", () => {
  test("creates a conversation entry that list includes", () => {
    const r = addThreadSchedule(VAULT, { domain: "foo", session: "2026-01-01_09-00-00_abc", prompt: "Summarize foo", cron: "0 9 * * *", name: "Foo digest" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toMatchObject({
      name: "Foo digest", cron: "0 9 * * *", command: "", enabled: true, last_run: null,
      thread: { domain: "foo", session: "2026-01-01_09-00-00_abc" }, prompt: "Summarize foo",
    });
    expect(loadSchedules(VAULT)).toEqual([r.entry]);
  });

  test("rejects a bad cron, a traversal session, and an empty prompt", () => {
    expect(addThreadSchedule(VAULT, { domain: "foo", session: "s1", prompt: "x", cron: "every day" }).ok).toBe(false);
    expect(addThreadSchedule(VAULT, { domain: "foo", session: "../s1", prompt: "x", cron: "0 9 * * *" }).ok).toBe(false);
    expect(addThreadSchedule(VAULT, { domain: "../foo", session: "s1", prompt: "x", cron: "0 9 * * *" }).ok).toBe(false);
    expect(addThreadSchedule(VAULT, { domain: "foo", session: "s1", prompt: "  ", cron: "0 9 * * *" }).ok).toBe(false);
    expect(loadSchedules(VAULT)).toHaveLength(0);
  });
});

describe("due detection", () => {
  const base = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
    id: "s_1", name: "n", cron: "0 9 * * *", command: "", enabled: true, last_run: null,
    created_at: new Date(2026, 0, 1, 8, 0).getTime(), thread: { domain: "foo", session: "s1" }, prompt: "p", ...over,
  });
  test("due on the minute, and caught up when the tick lands late", () => {
    expect(isThreadScheduleDue(base(), new Date(2026, 0, 1, 9, 0))).toBe(true);
    expect(isThreadScheduleDue(base(), new Date(2026, 0, 1, 9, 12))).toBe(true);
    expect(isThreadScheduleDue(base(), new Date(2026, 0, 1, 10, 0))).toBe(false); // past the catch-up window
    expect(isThreadScheduleDue(base(), new Date(2026, 0, 1, 8, 59))).toBe(false);
  });
  test("not again once run, and never when disabled or a shell entry", () => {
    const ran = base({ last_run: new Date(2026, 0, 1, 9, 0, 30).getTime() });
    expect(isThreadScheduleDue(ran, new Date(2026, 0, 1, 9, 5))).toBe(false);
    expect(isThreadScheduleDue(base({ enabled: false }), new Date(2026, 0, 1, 9, 0))).toBe(false);
    expect(isThreadScheduleDue(base({ thread: undefined, prompt: undefined, command: "true" }), new Date(2026, 0, 1, 9, 0))).toBe(false);
  });
});

describe("the due-run path", () => {
  const nine = new Date(2026, 0, 1, 9, 0, 10);
  function seed(): ScheduleEntry {
    const r = addThreadSchedule(VAULT, { domain: "foo", session: "s1", prompt: "Summarize foo", cron: "0 9 * * *" });
    if (!r.ok) throw new Error(r.error);
    // Created well before the due minute.
    const all = loadSchedules(VAULT);
    all[0]!.created_at = new Date(2026, 0, 1, 8, 0).getTime();
    saveSchedules(VAULT, all);
    return all[0]!;
  }

  test("the hub runs the prompt as a turn in that thread, once", async () => {
    const e = seed();
    const { runner, calls } = recordingRunner();
    const t = tickThreadSchedules(VAULT, runner, nine, hub);
    expect(t.fired.map((s) => s.id)).toEqual([e.id]);
    expect(await t.done).toEqual([{ ok: true, reply: "done" }]);
    expect(calls).toEqual([{ vault: VAULT, scheduleId: e.id, domain: "foo", session: "s1", prompt: "Summarize foo" }]);
    expect(loadSchedules(VAULT)[0]!.last_run).toBe(nine.getTime());
    // A second tick in the same window does not double-fire.
    const again = tickThreadSchedules(VAULT, runner, new Date(2026, 0, 1, 9, 1), hub);
    expect(again.fired).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  test("a client never runs them and leaves them untouched", async () => {
    seed();
    const { runner, calls } = recordingRunner();
    const t = tickThreadSchedules(VAULT, runner, nine, client);
    expect(t.skippedRole).toBe(true);
    await t.done;
    expect(calls).toHaveLength(0);
    expect(loadSchedules(VAULT)[0]!.last_run).toBeNull();
  });

  test("a runner failure is reported, not thrown", async () => {
    seed();
    const t = tickThreadSchedules(VAULT, async () => { throw new Error("boom"); }, nine, hub);
    expect(await t.done).toEqual([{ ok: false, error: "boom" }]);
  });

  test("the shell ticker skips conversation schedules", () => {
    seed();
    expect(tickAndRunDue(VAULT, nine)).toHaveLength(0);
    expect(loadSchedules(VAULT)[0]!.last_run).toBeNull();
  });
});

describe("the desktop transcript", () => {
  const md = [
    "---", "title: Foo chat", "domain: foo", "created: 2026-01-01T09:00:00Z", "updated: 2026-01-01T09:00:00Z", "turns: 2", "---", "",
    "## You", "", "hello foo", "", "## claude · foo-model", "", "hi there", "", "",
  ].join("\n");

  test("a scheduled pair is appended as desktop turns and the frontmatter follows", () => {
    writeFileSync(join(THREADS, "s1.md"), md);
    expect(appendThreadMarkdown(VAULT, "foo", "s1", [
      { role: "user", content: "Summarize foo" },
      { role: "assistant", content: "Foo summary", cli: "claude", model: "foo-model" },
    ])).toBe(true);
    const out = readFileSync(join(THREADS, "s1.md"), "utf8");
    expect(out).toContain("turns: 4");
    expect(out).not.toContain("updated: 2026-01-01T09:00:00Z");
    expect(out.endsWith("## You\n\nSummarize foo\n\n## claude · foo-model\n\nFoo summary\n\n")).toBe(true);
    expect(out).toContain("## You\n\nhello foo\n\n## claude · foo-model\n\nhi there\n\n## You");
  });

  test("never creates a thread that does not exist", () => {
    expect(appendThreadMarkdown(VAULT, "foo", "nope", [{ role: "user", content: "x" }])).toBe(false);
  });

  test("recent turns become context for the scheduled turn", () => {
    writeFileSync(join(THREADS, "s1.md"), md);
    const ctx = threadContext(VAULT, "foo", "s1");
    expect(ctx).toContain("hello foo");
    expect(ctx).not.toContain("title: Foo chat");
    expect(threadContext(VAULT, "foo", "nope")).toBe("");
  });
});
