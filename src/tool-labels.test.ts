import { expect, test } from "bun:test";
import { stepLabel, stepDetail } from "./tool-labels.ts";

test("gws labels: read vs write per service", () => {
  expect(stepLabel("google_workspace", { args: ["gmail", "messages", "list"] })).toBe("Reading Gmail");
  expect(stepLabel("google_workspace", { args: ["gmail", "send", "--to", "x"] })).toBe("Sending an email");
  expect(stepLabel("google_workspace", { args: ["docs", "create", "--title", "Plan"] })).toBe("Creating a Google Doc");
  expect(stepLabel("google_workspace", { args: ["drive", "files", "create"] })).toBe("Saving to Drive");
  expect(stepLabel("google_workspace", { args: ["drive", "files", "list"] })).toBe("Searching Drive");
  expect(stepLabel("google_workspace", { args: ["calendar", "events", "list"] })).toBe("Checking your calendar");
});

test("mcp-prefixed google_workspace name still maps", () => {
  expect(stepLabel("mcp__google_workspace__google_workspace", { args: ["gmail", "messages", "list"] })).toBe("Reading Gmail");
});

test("builtin + connected mcp + fallback", () => {
  expect(stepLabel("WebSearch")).toBe("Searching the web");
  expect(stepLabel("Read")).toBe("Reading a file");
  expect(stepLabel("mcp__prevail_acts__remember")).toBe("Saving to your vault");
  expect(stepLabel("mcp__notion__search_pages")).toBe("Notion search pages");
  expect(stepLabel("")).toBe("Working");
});

test("never throws on junk input", () => {
  expect(() => stepLabel("google_workspace", null)).not.toThrow();
  expect(() => stepLabel("google_workspace", { args: [1, 2] })).not.toThrow();
  expect(stepLabel("google_workspace", {})).toBe("Using Google Workspace");
});

test("stepDetail: concrete targets per tool, truncated, never throws", () => {
  expect(stepDetail("google_workspace", { args: ["gmail", "labels", "list"], account: "work" })).toBe("gws gmail labels list \u00b7 account: work");
  expect(stepDetail("WebSearch", { query: "rent trends minneapolis" })).toBe("rent trends minneapolis");
  expect(stepDetail("Read", { file_path: "/vault/real-estate/lease.pdf" })).toBe("/vault/real-estate/lease.pdf");
  expect(stepDetail("Bash", { command: "npm run build" })).toBe("npm run build");
  expect(stepDetail("TodoWrite", { todos: [] })).toBe("");
  expect(stepDetail("mcp__notion__search_pages", { q: "brief" })).toBe('{"q":"brief"}');
  const long = "x".repeat(300);
  expect(stepDetail("Bash", { command: long }).length).toBeLessThanOrEqual(141);
  expect(() => stepDetail("Bash", null)).not.toThrow();
  expect(stepDetail("Bash", null)).toBe("");
});
