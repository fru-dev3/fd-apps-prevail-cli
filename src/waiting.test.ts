import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateToolCall } from "./act-gate.ts";
import { addPendingGws } from "./gws-gateway.ts";
import { collectWaiting } from "./waiting.ts";

// "Waiting for you" aggregates every source the Needs you inbox reads.
const VAULT = `/tmp/prevail-waiting-${process.pid}`;
const DOM = join(VAULT, "data", "domains", "foo");

beforeEach(() => {
  rmSync(VAULT, { recursive: true, force: true });
  mkdirSync(join(VAULT, "_meta"), { recursive: true });
  mkdirSync(DOM, { recursive: true });
});
afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

describe("collectWaiting", () => {
  test("an empty vault waits on nothing", () => {
    expect(collectWaiting(VAULT)).toEqual({ total: 0, items: [] });
  });

  test("acts, gws writes, loop approvals and blocked/review tasks, newest first", () => {
    gateToolCall(VAULT, "foo", "mcp__claude_ai_Spotify__create_playlist", { title: "foo" }, true, { thread: "thread_foo" });
    addPendingGws(VAULT, { domain: "foo", summary: "Send email to foo", args: ["gmail", "send"], thread: "thread_bar" });
    writeFileSync(join(DOM, "_loops_runtime.json"), JSON.stringify({
      schema: 1,
      loops: { l1: { history: [], pending: [{ text: "Pay the foo bill", ts: 1000 }, { text: "  ", ts: 1 }] } },
    }));
    writeFileSync(join(DOM, "_tasks.md"), [
      "# Tasks", "",
      "- [ ] Paused foo task ~owner:ai ~status:blocked ~id:aaa1111",
      "- [ ] Finished foo task ~owner:ai ~status:review ~id:bbb2222",
      "- [ ] Ordinary foo task ~id:ccc3333",
      "- [ ] Trashed foo task ~status:blocked ~id:ddd4444 ~trashed:2026-01-01",
      "",
    ].join("\n"));

    const r = collectWaiting(VAULT);
    expect(r.total).toBe(r.items.length);
    const kinds = r.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["act", "gws", "loop", "task", "task"]);

    const act = r.items.find((i) => i.kind === "act")!;
    expect(act).toMatchObject({ domain: "foo", summary: "Spotify: create_playlist", thread: "thread_foo" });
    expect(act.id.startsWith("act_")).toBe(true);
    expect(r.items.find((i) => i.kind === "gws")).toMatchObject({ domain: "foo", thread: "thread_bar" });
    expect(r.items.find((i) => i.kind === "loop")).toEqual({ kind: "loop", id: "foo:l1:0", domain: "foo", summary: "Pay the foo bill", since: 1000 });
    const tasks = r.items.filter((i) => i.kind === "task");
    expect(tasks.map((t) => t.id).sort()).toEqual(["task:aaa1111", "task:bbb2222"]);
    expect(tasks.every((t) => t.thread === undefined)).toBe(true);

    for (let i = 1; i < r.items.length; i++) expect(r.items[i - 1]!.since).toBeGreaterThanOrEqual(r.items[i]!.since);
  });
});
