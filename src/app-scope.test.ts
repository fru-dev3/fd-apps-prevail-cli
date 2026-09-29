import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatJson } from "./chat-json.ts";
import type { ChatTurn } from "./cli-bridge.ts";
import { setNotes } from "./entities.ts";
import { accessOutcome, actMarker, DECLINED_REASON, entityIdFromEnv } from "./act-gate.ts";
import { buildTool, mirrorCachePath, type MirrorApp } from "./apps-mirror.ts";
import { accessLogPath, appChatBlock, appForTool, appToolAccess, appThreads, readAccessLog, recordAppAccess, refDomainBlock, summarizeArgs } from "./app-scope.ts";
import { readThreadTurns } from "./session.ts";

// Apps as chat scopes. Invented "foo" apps; the model turn is a stand-in.
let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-app-scope-"));
  mkdirSync(join(vault, "data", "domains", "general"), { recursive: true });
  mkdirSync(join(vault, "data", "apps"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

const tool = (server: string, bare: string) => buildTool(`mcp__${server}__${bare}`, bare);
const FOO_MAIL: MirrorApp = {
  id: "foo-mail", name: "Foo Mail", runtime: "claude", server: "claude.ai Foo Mail", status: "connected",
  signin_hint: "https://claude.ai/settings/connectors", syncable: true, domains: [],
  tools: [tool("claude_ai_Foo_Mail", "search_threads"), tool("claude_ai_Foo_Mail", "create_draft"), tool("claude_ai_Foo_Mail", "send_message")],
};
const FOO_CAL: MirrorApp = {
  id: "foo-cal", name: "Foo Cal", runtime: "claude", server: "claude.ai Foo Cal", status: "needs_auth",
  signin_hint: "https://claude.ai/settings/connectors", syncable: true, domains: [],
};
const FOO_DRIVE: MirrorApp = {
  id: "codex-foo-drive", name: "Foo Drive", runtime: "codex", server: "Foo Drive", status: "connected",
  signin_hint: "codex mcp login Foo Drive", syncable: false, domains: [],
};
const APPS = [FOO_MAIL, FOO_CAL, FOO_DRIVE];

async function turn(o: { apps?: string[]; entity?: string | string[]; refDomains?: string[]; scopeApp?: string; sessionId?: string; tools?: boolean }) {
  const turns: ChatTurn[] = [];
  const lines: string[] = [];
  const code = await runChatJson({
    vaultPath: vault, domain: "general", message: "What did Foo send?", sessionId: o.sessionId ?? "t-foo",
    apps: o.apps, entity: o.entity, refDomains: o.refDomains, scopeApp: o.scopeApp,
    write: (l) => lines.push(l),
    deps: {
      detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }, { kind: "codex", bin: "codex", label: "Codex" }],
      runChatTurn: async (t: ChatTurn) => {
        turns.push(t);
        if (o.tools) {
          t.onTool?.({ name: "mcp__claude_ai_Foo_Mail__search_threads", phase: "call", id: "s1", input: { query: "from:foo" } });
          t.onTool?.({ name: "mcp__claude_ai_Foo_Mail__search_threads", phase: "result", id: "s1", ok: true });
          t.onTool?.({ name: "Read", phase: "call", id: "s2", input: { file_path: "x.md" } });
          t.onTool?.({ name: "mcp__claude_ai_Foo_Mail__send_message", phase: "call", id: "s3", input: { to: "foo" } });
          t.onTool?.({ name: "mcp__claude_ai_Foo_Mail__send_message", phase: "result", id: "s3", ok: false, resultText: "queued" });
        }
        return "Nothing new.";
      },
      persistMessage: () => {},
      mirrorApps: () => APPS,
    },
  });
  return { code, turns, events: lines.map((l) => JSON.parse(l)) };
}

test("the app block names the runtime, status, grouped tools and the approval rule", () => {
  mkdirSync(join(vault, "data", "apps", "foo-mail"), { recursive: true });
  writeFileSync(join(vault, "data", "apps", "foo-mail", "SKILL.md"), "Search before drafting.");
  const b = appChatBlock(vault, "foo-mail", FOO_MAIL);
  expect(b).toContain("# APP CONTEXT: Foo Mail");
  expect(b).toContain("belongs to the Claude runtime. Status: connected.");
  expect(b).toContain("Reads: search_threads\nWrites: create_draft\nBlocked: send_message");
  expect(b).toContain("## How to operate it (SKILL.md)\nSearch before drafting.");
  expect(b).toContain("Reads run; writes and sends are queued for the user's approval.");
  expect(b.endsWith("Do not try other ways to reach it (files, shell, other tools).")).toBe(true);
  expect(appChatBlock(vault, "foo-none", null)).toContain("not in the apps mirror");
});

test("--app puts its block ahead of the message, never into the transcript", async () => {
  const r = await turn({ apps: ["foo-mail"] });
  expect(r.code).toBe(0);
  expect(r.turns[0].prompt.startsWith("# APP CONTEXT: Foo Mail")).toBe(true);
  expect(r.turns[0].prompt.endsWith("\n\n---\n\nWhat did Foo send?")).toBe(true);
  expect(r.turns[0].inheritUserMcp).toBe(true);
  expect(r.turns[0].cli.kind).toBe("claude");
  expect(readThreadTurns(vault, "general", "t-foo").map((t) => t.content)).toEqual(["What did Foo send?", "Nothing new."]);
  expect(r.events.map((e) => e.type)).toEqual(["start", "user", "assistant", "usage", "done"]);
});

test("--entity is repeatable: one block each, the first exported as the entity id", async () => {
  setNotes(vault, "person/foo", "Foo notes.", { name: "Foo" });
  setNotes(vault, "org/foo-co", "Foo Co notes.", { name: "Foo Co" });
  const r = await turn({ entity: ["person/foo", "org/foo-co"] });
  const p = r.turns[0].prompt;
  expect(p.indexOf("This conversation is about Foo (Person")).toBeGreaterThanOrEqual(0);
  expect(p.indexOf("This conversation is about Foo Co (")).toBeGreaterThan(p.indexOf("Foo notes."));
  expect(p).toContain("Foo Co notes.");
  expect(r.turns[0].entityId).toBe("person/foo");
});

test("--ref-domain adds a compact state block from that domain", async () => {
  mkdirSync(join(vault, "data", "domains", "foo-money", "memory"), { recursive: true });
  writeFileSync(join(vault, "data", "domains", "foo-money", "memory", "state.md"), "Budget is on track.");
  expect(refDomainBlock(vault, "foo-money")).toBe("# REFERENCED DOMAIN: foo-money\nThe user referenced this domain. Its current state:\nBudget is on track.");
  expect(refDomainBlock(vault, "../x")).toBe("");
  const r = await turn({ refDomains: ["foo-money"] });
  expect(r.turns[0].prompt).toContain("Budget is on track.\n\n---\n\nWhat did Foo send?");
});

test("routing: a single owning runtime moves the turn and says so", async () => {
  const r = await turn({ apps: ["codex-foo-drive"] });
  expect(r.turns[0].cli.kind).toBe("codex");
  const routed = r.events.find((e) => e.type === "routed");
  expect(routed).toMatchObject({ type: "routed", runtime: "codex" });
  expect(routed.reason).toContain("Foo Drive");
  expect(r.events.find((e) => e.type === "start").engine.startsWith("codex:")).toBe(true);
});

test("routing: apps split across runtimes stay put and report what is missing", async () => {
  const r = await turn({ apps: ["foo-mail", "codex-foo-drive"] });
  expect(r.turns[0].cli.kind).toBe("claude");
  expect(r.events.filter((e) => e.type === "routed")).toEqual([]);
  expect(r.events.filter((e) => e.type === "app_unavailable").map((e) => [e.app, e.runtime_needed])).toEqual([["codex-foo-drive", "codex"]]);
});

test("an app that needs sign-in emits app_needs_auth with its sign-in link", async () => {
  const r = await turn({ apps: ["foo-cal"] });
  const ev = r.events.find((e) => e.type === "app_needs_auth");
  expect(ev).toMatchObject({ app: "foo-cal", name: "Foo Cal", signin_url: "https://claude.ai/settings/connectors" });
});

test("tool events carry the app their tool belongs to", async () => {
  const r = await turn({ tools: true });
  const steps = r.events.filter((e) => e.type === "tool");
  expect(steps.map((e) => [e.step.status, e.app ?? null, e.tool ?? null, e.access ?? null])).toEqual([
    ["running", "foo-mail", "search_threads", "read"],
    ["done", "foo-mail", "search_threads", "read"],
    ["running", null, null, null],
    ["running", "foo-mail", "send_message", "blocked"],
    ["failed", "foo-mail", "send_message", "blocked"],
  ]);
  // The existing fields are unchanged.
  expect(steps[0]).toMatchObject({ text: steps[0].step.label, step: { id: "s1", detail: expect.any(String) } });
  // Same classifier as the access log.
  expect(appToolAccess(APPS, "mcp__claude_ai_Foo_Mail__create_draft")).toMatchObject({ tool: "create_draft", access: "write" });
  expect(appForTool(APPS, "mcp__claude_ai_Foo_Mail__create_draft")).toMatchObject({ app: { id: "foo-mail" }, tool: "create_draft" });
  expect(appForTool(APPS, "mcp__google_workspace__gws")).toBeNull();
});

test("--scope-app stores the thread in the app's own space", async () => {
  const r = await turn({ scopeApp: "foo-mail", sessionId: "t-app" });
  expect(r.code).toBe(0);
  expect(r.events[0]).toMatchObject({ type: "start", domain: "_app-foo-mail" });
  expect(r.turns[0].cwd).toBe(join(vault, "data", "apps", "foo-mail", "_scope"));
  expect(r.turns[0].prompt.startsWith("# APP CONTEXT: Foo Mail")).toBe(true);
  expect(existsSync(join(vault, "data", "apps", "foo-mail", "_scope", "_threads", "t-app.jsonl"))).toBe(true);
  expect(existsSync(join(vault, "data", "domains", "_app-foo-mail"))).toBe(false);
  expect((await turn({ scopeApp: "../x" })).code).toBe(1);
});

test("the access summary keeps keys and short values, never bodies or sensitive values", () => {
  const s = summarizeArgs({
    to: "foo@example.com", subject: "Lunch with Foo", body: "Dear Foo, the full letter ".repeat(20),
    card: "4111 1111 1111 1111", q: "x".repeat(100),
  });
  expect(s).toContain("to=[an email address]");
  expect(s).toContain("subject=Lunch with Foo");
  expect(s).toMatch(/body=\[\d+ chars\]/);
  expect(s).toContain("card=[a card number]");
  expect(s).toContain(`q=${"x".repeat(59)}…`);
  expect(s).not.toContain("foo@example.com");
  expect(s).not.toContain("4111");
  expect(s).not.toContain("Dear Foo");
});

test("the access log appends per app and filters newest first", () => {
  mkdirSync(join(mirrorCachePath(vault), ".."), { recursive: true });
  writeFileSync(mirrorCachePath(vault), JSON.stringify({ generated_at: 1, runtimes: [], apps: APPS }));
  expect(recordAppAccess(vault, "mcp__claude_ai_Foo_Mail__search_threads", { query: "from:foo" }, "ran", { thread: "t1", domain: "general", now: 100 })).toBe("foo-mail");
  expect(recordAppAccess(vault, "mcp__claude_ai_Foo_Mail__send_message", { to: "foo@example.com", body: "hi" }, "queued", { thread: "t2", domain: "work", entity: "person/foo", now: 200 })).toBe("foo-mail");
  expect(recordAppAccess(vault, "mcp__unknown_server__get_x", {}, "ran")).toBeNull();

  const raw = readFileSync(accessLogPath(vault, "foo-mail"), "utf8");
  expect(raw).not.toContain("foo@example.com");
  expect(raw.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
    { ts: 100, tool: "search_threads", access: "read", outcome: "ran", thread: "t1", domain: "general", summary: "query=from:foo" },
    { ts: 200, tool: "send_message", access: "blocked", outcome: "queued", thread: "t2", domain: "work", entity: "person/foo", summary: "to=[an email address], body=[2 chars]" },
  ]);
  expect(readAccessLog(vault).map((r) => [r.app, r.ts])).toEqual([["foo-mail", 200], ["foo-mail", 100]]);
  expect(readAccessLog(vault, { domain: "general" }).map((r) => r.ts)).toEqual([100]);
  expect(readAccessLog(vault, { entity: "person/foo" }).map((r) => r.ts)).toEqual([200]);
  expect(readAccessLog(vault, { thread: "t1", app: "foo-mail" }).map((r) => r.ts)).toEqual([100]);
  expect(readAccessLog(vault, { limit: 1 }).map((r) => r.ts)).toEqual([200]);
  expect(readAccessLog(vault, { app: "foo-cal" })).toEqual([]);
});

test("gate decisions map to access outcomes; the entity env is validated", () => {
  expect(accessOutcome({ action: "allow" })).toBe("ran");
  expect(accessOutcome({ action: "deny", reason: `queued. ${actMarker("act_1")}` })).toBe("queued");
  expect(accessOutcome({ action: "deny", reason: DECLINED_REASON })).toBe("declined");
  expect(accessOutcome({ action: "deny", reason: "gate errored" })).toBe("denied");
  expect(entityIdFromEnv({ PREVAIL_ENTITY_ID: "person/foo" })).toBe("person/foo");
  expect(entityIdFromEnv({ PREVAIL_ENTITY_ID: "../etc" })).toBeUndefined();
});

test("app threads list the app's own chats, newest first", () => {
  const dir = join(vault, "data", "apps", "foo-mail", "_scope", "_threads");
  mkdirSync(dir, { recursive: true });
  const md = (title: string, updated: string, turns: number) =>
    `---\ntitle: ${title}\ndomain: _app-foo-mail\ncreated: ${updated}\nupdated: ${updated}\nturns: ${turns}\napp: foo-mail\n---\n\n## You\n\nhi\n\n`;
  writeFileSync(join(dir, "older.md"), md("Older chat", "2026-01-01T00:00:00Z", 2));
  writeFileSync(join(dir, "newer.md"), md("Newer chat", "2026-02-01T00:00:00Z", 4));
  mkdirSync(join(vault, "data", "domains", "general", "_threads"), { recursive: true });
  writeFileSync(join(vault, "data", "domains", "general", "_threads", "other.md"), md("Other", "2026-03-01T00:00:00Z", 1));
  expect(appThreads(vault, "foo-mail")).toEqual([
    { slug: "newer", title: "Newer chat", updated: Date.parse("2026-02-01T00:00:00Z"), turns: 4 },
    { slug: "older", title: "Older chat", updated: Date.parse("2026-01-01T00:00:00Z"), turns: 2 },
  ]);
  expect(appThreads(vault, "foo-cal")).toEqual([]);
});
