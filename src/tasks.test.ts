// Token parity with the desktop (src-tauri/src/tasks.rs): both processes read and
// write _tasks.md, so the render/parse here must round-trip the same way.
import { test, expect } from "bun:test";
import { parseTasks, renderTasks, effectiveStatus, type Task } from "./tasks.ts";

test("parses owner/status/id tokens", () => {
  const tasks = parseTasks("- [ ] Draft the Q2 budget @2026-06-25 +2026-06-18 ~owner:ai ~status:doing ~id:k7f3a\n");
  expect(tasks[0].text).toBe("Draft the Q2 budget");
  expect(tasks[0].due).toBe("2026-06-25");
  expect(tasks[0].owner).toBe("ai");
  expect(tasks[0].status).toBe("doing");
  expect(tasks[0].id).toBe("k7f3a");
});

test("renders only ai owner and working statuses", () => {
  const ai: Task = { text: "do it", done: false, owner: "ai", status: "doing", id: "abc1234" };
  const meTodo: Task = { text: "mine", done: false, owner: "me", status: "todo", id: "def5678" };
  const line = renderTasks([ai]).split("\n")[2];
  expect(line).toContain("~owner:ai");
  expect(line).toContain("~status:doing");
  expect(line).toContain("~id:abc1234");
  const meLine = renderTasks([meTodo]).split("\n")[2];
  expect(meLine).not.toContain("~owner");   // me is implicit
  expect(meLine).not.toContain("~status");  // todo is implied by the box
});

test("does not eat an inline @ or ~ mid-line", () => {
  // Only END-of-line tokens are metadata; an inline @handle stays in the text.
  const tasks = parseTasks("- [ ] email bob@x.com about the budget\n");
  expect(tasks[0].text).toBe("email bob@x.com about the budget");
  // A bare ~word AT the end is provenance (matches the Rust split_meta).
  const src = parseTasks("- [ ] reconcile ~daemon\n");
  expect(src[0].text).toBe("reconcile");
  expect(src[0].source).toBe("daemon");
});

test("legacy line round-trips with defaults applied on write", () => {
  const parsed = parseTasks("- [ ] old task +2026-06-09 ~user\n");
  expect(parsed[0].owner).toBeUndefined();
  const rendered = renderTasks(parsed);
  expect(rendered).toContain("- [ ] old task @".length === 0 ? "- [ ] old task" : "- [ ] old task");
  expect(rendered).toContain("+2026-06-09");
  expect(rendered).toContain("~user");
});

test("effectiveStatus: explicit wins, else checkbox", () => {
  expect(effectiveStatus({ text: "a", done: false, status: "review" })).toBe("review");
  expect(effectiveStatus({ text: "a", done: true })).toBe("done");
  expect(effectiveStatus({ text: "a", done: false })).toBe("todo");
});

test("blocked/review survive a parse→render→parse round-trip", () => {
  const md = "- [ ] paused thing ~owner:ai ~status:blocked ~id:zzz1111\n- [ ] finished thing ~owner:ai ~status:review ~id:yyy2222\n";
  const round = parseTasks(renderTasks(parseTasks(md)));
  expect(round[0].status).toBe("blocked");
  expect(round[1].status).toBe("review");
  expect(round[0].owner).toBe("ai");
});
