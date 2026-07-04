import { expect, test } from "bun:test";
import { stepLabel } from "./tool-labels.ts";

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
