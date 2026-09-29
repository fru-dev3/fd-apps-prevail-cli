import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookOutput } from "./act-gate.ts";
import { buildTool, mirrorCachePath, readMirrorCache, updateMirrorStatus, type MirrorApp } from "./apps-mirror.ts";
import { APP_NO_WORKAROUNDS, appChatBlock, appReadTools, readAccessLog, recordAppAccess } from "./app-scope.ts";
import { runChatJson } from "./chat-json.ts";
import { runChatTurn, runClaudeStream, type ChatTurn } from "./cli-bridge.ts";
import { accountEmail, googleAccounts, readPendingGws } from "./gws-gateway.ts";
import { callGoogleWorkspace } from "./gws-mcp.ts";

// Bug 1 (app reads refused in headless Claude) and multiple Google accounts.
// Invented "foo" apps and example.com accounts only.
const tool = (server: string, bare: string) => buildTool(`mcp__${server}__${bare}`, bare);
const FOO_MAIL: MirrorApp = {
  id: "foo-mail", name: "Foo Mail", runtime: "claude", server: "claude.ai Foo Mail", status: "connected",
  signin_hint: "https://claude.ai/settings/connectors", syncable: true, domains: [],
  tools: [tool("claude_ai_Foo_Mail", "search_threads"), tool("claude_ai_Foo_Mail", "get_thread"), tool("claude_ai_Foo_Mail", "create_draft"), tool("claude_ai_Foo_Mail", "send_message"), tool("claude_ai_Foo_Mail", "pay_invoice")],
};
const READS = ["mcp__claude_ai_Foo_Mail__search_threads", "mcp__claude_ai_Foo_Mail__get_thread"];

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-app-read-"));
  mkdirSync(join(vault, "data", "domains", "general"), { recursive: true });
  mkdirSync(join(vault, "data", "apps"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("Bug 1: an app's read tools are pre-allowed on its turns", () => {
  test("only the mirror's read tools, by exact Claude name", () => {
    expect(appReadTools([FOO_MAIL], ["foo-mail"])).toEqual(READS);
    expect(appReadTools([FOO_MAIL], [])).toEqual([]);
    expect(appReadTools([{ ...FOO_MAIL, runtime: "codex" }], ["foo-mail"])).toEqual([]);
  });

  test("a turn scoped to the app carries its reads and no write tools", async () => {
    const turns: ChatTurn[] = [];
    await runChatJson({
      vaultPath: vault, domain: "general", message: "What did Foo send?", sessionId: "t-foo", scopeApp: "foo-mail",
      write: () => {},
      deps: {
        detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
        runChatTurn: async (t: ChatTurn) => { turns.push(t); return "ok"; },
        persistMessage: () => {},
        mirrorApps: () => [FOO_MAIL],
      },
    });
    expect(turns[0]!.appReadTools).toEqual(READS);
  });

  test("the spawned claude gets them in --allowedTools; writes never", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-allowed-cli-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
    chmodSync(bin, 0o755);
    const cwd = join(dir, "vault", "foo");
    mkdirSync(cwd, { recursive: true });
    const out = await runChatTurn({ prompt: "hi", cwd, cli: { kind: "claude", bin, label: "claude" }, model: "", isFirst: true, bare: true, appReadTools: READS });
    const args = out.split("\n");
    const at = args.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    for (const r of READS) expect(args).toContain(r);
    expect(out).not.toContain("create_draft");
    expect(out).not.toContain("send_message");
    expect(out).not.toContain("pay_invoice");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the act-gate hook answers an allowed read with an explicit allow; writes still deny", () => {
    expect(hookOutput("mcp__claude_ai_Foo_Mail__search_threads", { action: "allow" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "allowed by Prevail's action gate" },
    });
    expect(hookOutput("Read", { action: "allow" })).toEqual({});
    expect(hookOutput("mcp__claude_ai_Foo_Mail__send_message", { action: "deny", reason: "queued" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "queued" },
    });
  });
});

describe("multiple Google accounts", () => {
  const profiles = [{ label: "default", configDir: "/x/gws" }, { label: "work", configDir: "/x/gws-work" }];
  const emailOf = (p: { label: string }) => (p.label === "work" ? "bar@example.com" : "foo@example.com");

  test("apps accounts: every gws account by email, the default, and Claude's one-account connector", () => {
    expect(googleAccounts("gmail", { profiles, emailOf, bound: "work", claudeConnector: "Gmail" })).toEqual([
      { id: "foo@example.com", label: "default", default: false, via: "gws" },
      { id: "bar@example.com", label: "work", default: true, via: "gws" },
      { id: "claude", label: "Gmail (Claude connector, one account)", default: false, via: "claude" },
    ]);
    expect(googleAccounts("gmail", { profiles: [profiles[0]!], emailOf })[0]!.default).toBe(true);
    expect(googleAccounts("gmail", { profiles, emailOf }).some((a) => a.default)).toBe(false);
    expect(googleAccounts("foo-mail", { profiles, emailOf })).toEqual([]);
  });

  const ambiguous = () => ({ kind: "ambiguous" as const, labels: ["default", "work"] });
  const text = (r: { text: string }[]) => r.map((c) => c.text).join("");

  // (A labeled read would spawn the live gws binary, so only the refusal is pinned here.)
  test("all: an unlabeled read is refused with the accounts", () => {
    const list = ["gmail", "users", "messages", "list"];
    expect(text(callGoogleWorkspace({ args: list }, vault, "general", "all", ambiguous, () => undefined))).toContain("all Google accounts are selected (default, work)");
  });

  test("all: a draft goes to the default account only and queues; with no default it is refused", () => {
    const draft = ["gmail", "users", "drafts", "create", "--params", "{}"];
    callGoogleWorkspace({ args: draft, account: "bar@example.com" }, vault, "general", "all", ambiguous, () => "work");
    const q = readPendingGws(vault);
    expect(q).toHaveLength(1);
    expect(q[0]!.account).toBe("work");
    expect(text(callGoogleWorkspace({ args: draft }, vault, "general", "all", ambiguous, () => undefined))).toContain("pick the one account");
    expect(readPendingGws(vault)).toHaveLength(1);
  });

  test("the access log records the account as its EMAIL, reads and writes alike", () => {
    const gws = "mcp__google_workspace__google_workspace";
    const toEmail = (a: string) => (a.includes("@") ? a : ({ default: "foo@example.com", work: "bar@example.com" } as Record<string, string>)[a] ?? a);
    const list = ["gmail", "users", "messages", "list"];
    const draft = ["gmail", "users", "drafts", "create", "--params", "{}"];
    const ctx = { domain: "_app-gmail", apps: [], toEmail };
    recordAppAccess(vault, gws, { args: list, account: "work" }, "ran", ctx);
    recordAppAccess(vault, gws, { args: list }, "ran", { ...ctx, googleAccount: "default" });
    recordAppAccess(vault, gws, { args: draft }, "queued", { ...ctx, googleAccount: "work" });
    recordAppAccess(vault, gws, { args: draft, account: "foo@example.com" }, "queued", { ...ctx, googleAccount: "all", writeDefault: () => "bar@example.com" });
    recordAppAccess(vault, gws, { args: list, account: "nolabel" }, "ran", ctx);
    const gmail: MirrorApp = { ...FOO_MAIL, id: "gmail", server: "claude.ai Gmail", tools: [tool("claude_ai_Gmail", "search_threads")] };
    recordAppAccess(vault, "mcp__claude_ai_Gmail__search_threads", { q: "x" }, "ran", { apps: [gmail] });
    recordAppAccess(vault, "mcp__claude_ai_Foo_Mail__search_threads", { q: "x" }, "ran", { apps: [FOO_MAIL] });
    const rows = readAccessLog(vault, { app: "gmail" });
    expect(rows.map((r) => r.account).sort()).toEqual(["bar@example.com", "bar@example.com", "bar@example.com", "claude", "foo@example.com", "nolabel"]);
    expect(readAccessLog(vault, { account: "bar@example.com" }).map((r) => r.access).sort()).toEqual(["read", "write", "write"]);
    expect(readAccessLog(vault, { account: "foo@example.com" })).toHaveLength(1);
    expect(readAccessLog(vault, { app: "foo-mail" })[0]!.account).toBeUndefined();
  });

  test("accountEmail: label to email, email passes through, label kept when unknown", () => {
    expect(accountEmail("work", { profiles, emailOf })).toBe("bar@example.com");
    expect(accountEmail("Foo@Example.com", { profiles, emailOf })).toBe("foo@example.com");
    expect(accountEmail("home", { profiles, emailOf })).toBe("home");
    expect(accountEmail("work", { profiles, emailOf: () => null })).toBe("work");
  });
});

// Live connector status: Claude's stream-json init event.
const INIT = JSON.stringify({
  type: "system", subtype: "init", tools: ["mcp__claude_ai_Foo_Mail__search_threads"],
  mcp_servers: [{ name: "claude.ai Foo Mail", status: "needs-auth" }, { name: "claude.ai Foo Docs", status: "connected" }],
});
const FOO_DOCS: MirrorApp = { ...FOO_MAIL, id: "foo-docs", name: "Foo Docs", server: "claude.ai Foo Docs", tools: [] };
const FOO_GONE: MirrorApp = { ...FOO_MAIL, id: "foo-gone", name: "Foo Gone", server: "claude.ai Foo Gone", tools: [] };

describe("live app auth status from the init event", () => {
  test("runClaudeStream hands the init event's servers to onInit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-init-cli-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\ncat <<'X'\n${INIT}\nX\n`);
    chmodSync(bin, 0o755);
    const seen: { name: string; status: string }[][] = [];
    await runClaudeStream(bin, [], dir, undefined, undefined, () => {}, undefined, (i) => seen.push(i.servers));
    expect(seen).toEqual([[{ name: "claude.ai Foo Mail", status: "needs-auth" }, { name: "claude.ai Foo Docs", status: "connected" }]]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a referenced app needing sign-in emits app_needs_auth and updates the mirror; a missing one emits app_unavailable", async () => {
    const lines: string[] = [];
    const updated: [string, string][] = [];
    await runChatJson({
      vaultPath: vault, domain: "general", message: "What is new in Foo?", sessionId: "t-foo", apps: ["foo-mail", "foo-docs", "foo-gone"],
      write: (l) => lines.push(l),
      deps: {
        detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
        runChatTurn: async (t: ChatTurn) => { t.onInit?.({ tools: [], servers: JSON.parse(INIT).mcp_servers }); return "It needs to be connected."; },
        persistMessage: () => {},
        mirrorApps: () => [FOO_MAIL, FOO_DOCS, FOO_GONE],
        updateMirrorStatus: (_v, id, st) => updated.push([id, st]),
      },
    });
    const ev = lines.map((l) => JSON.parse(l));
    const auth = ev.filter((e) => e.type === "app_needs_auth");
    expect(auth[0]).toMatchObject({ app: "foo-mail", name: "Foo Mail", signin_url: "https://claude.ai/settings/connectors" });
    expect(auth.every((e) => e.app === "foo-mail")).toBe(true);
    expect(ev.find((e) => e.type === "app_unavailable")).toMatchObject({ app: "foo-gone" });
    expect(ev.find((e) => e.type === "app_unavailable").reason).toContain("did not load");
    expect(ev.some((e) => e.type === "app_needs_auth" && e.app === "foo-docs")).toBe(false);
    expect(updated[0]).toEqual(["foo-mail", "needs-auth"]);
  });

  test("updateMirrorStatus writes needs_auth into the mirror cache", () => {
    mkdirSync(join(mirrorCachePath(vault), ".."), { recursive: true });
    writeFileSync(mirrorCachePath(vault), JSON.stringify({ generated_at: 1, runtimes: [], apps: [FOO_MAIL] }));
    updateMirrorStatus(vault, "foo-mail", "needs-auth");
    expect(readMirrorCache(vault)!.apps[0]!.status).toBe("needs_auth");
  });

  test("the app block tells the model to stop, not work around a missing app", () => {
    expect(appChatBlock(vault, "foo-mail", FOO_MAIL)).toContain(APP_NO_WORKAROUNDS);
    expect(APP_NO_WORKAROUNDS).toBe("If this app's tools are not available in this conversation, say in one sentence that it needs to be connected, and stop. Do not try other ways to reach it (files, shell, other tools).");
  });
});
