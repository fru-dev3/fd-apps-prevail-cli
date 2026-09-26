import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appIdFor, archiveApps, archiveCandidates, buildSyncArgs, classifyTool, claudeToolsForServer,
  extractJsonObject, findClaudeInit, isDue, listMirror, parseAgyMcpList, parseClaudeMcpList,
  parseCodexMcpList, parseGeminiMcpList, readCheckpoint, refreshMirror, saveRecipe, scaffoldOnly,
  syncDue, syncMirrorApp, syncedAppsContext, draftRecipe, type Exec, type ExecResult, type MirrorApp,
} from "./apps-mirror.ts";

// ── Fixtures (invented servers only) ──────────────────────────────────────────

const CLAUDE_LIST = [
  "Checking MCP server health…",
  "",
  "claude.ai Acme Notes: https://mcp.acme-notes.example/mcp - ✔ Connected",
  "claude.ai Foo Rides: https://mcp.foo-rides.example/mcp - ! Needs authentication",
  "claude.ai Foo: https://mcp.foo.example/mcp - ✔ Connected",
  "claude.ai Bar.io: https://mcp.bar.example - ⊘ Disabled for this project (re-enable via /mcp)",
  "claude.ai Baz Mail: https://baz.example/mcp/v1 - ✔ Connected",
  "prevail: /opt/tools/prevail mcp --unsafe-detach - ✔ Connected",
  "local-thing: npx -y local-thing-mcp - ✗ Failed to connect",
].join("\n");

const CODEX_JSON = JSON.stringify([
  { name: "prevail", enabled: true, disabled_reason: null, transport: { type: "stdio", command: "/opt/tools/prevail", args: ["mcp"] }, auth_status: "unsupported" },
  { name: "helper-one", enabled: true, disabled_reason: null, transport: { type: "stdio", command: "/opt/helper", args: ["serve", "mcp"] }, auth_status: "unsupported" },
  { name: "Remote Docs", enabled: true, transport: { type: "streamable_http", url: "https://docs.example/mcp" }, auth_status: "not_logged_in" },
  { name: "off-one", enabled: false, disabled_reason: "user disabled", transport: { type: "stdio", command: "x" }, auth_status: "unsupported" },
]);

const AGY_LIST = [
  "NAME        TYPE   STATUS    COMMAND/URL",
  "prevail     stdio  enabled   /opt/tools/prevail mcp --unsafe-detach",
  "Acme Tasks  http   disabled  https://tasks.example/mcp",
  "qux         stdio  enabled   /usr/local/bin/qux --mcp",
].join("\n");

const GEMINI_LIST = [
  "Configured MCP servers:",
  "",
  "✓ weatherish: npx weatherish-mcp (stdio) - Connected",
  "✗ remote-kb: https://kb.example/mcp (http) - Disconnected",
].join("\n");

const ACME = "mcp__claude_ai_Acme_Notes__";
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  tools: [
    `${ACME}search`, `${ACME}fetch_page`, `${ACME}create_page`, `${ACME}send_invite`,
    "mcp__claude_ai_Foo__list_rides", "mcp__claude_ai_Foo__book_ride",
    "mcp__claude_ai_Baz_Mail__search_threads", "mcp__claude_ai_Baz_Mail__send_message", "mcp__claude_ai_Baz_Mail__create_draft",
    "mcp__prevail__chat",
  ],
  mcp_servers: [{ name: "claude.ai Acme Notes", status: "connected" }, { name: "claude.ai Baz Mail", status: "connected" }, { name: "claude.ai Foo", status: "connected" }, { name: "local-thing", status: "pending" }],
});

function ok(stdout: string): ExecResult { return { code: 0, stdout, stderr: "", missing: false, timedOut: false }; }
const MISSING: ExecResult = { code: null, stdout: "", stderr: "", missing: true, timedOut: false };

interface Call { bin: string; args: string[]; cwd?: string }
function fakeExec(opts: { syncReply?: string; draftReply?: string; noGemini?: boolean } = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (bin, args, o) => {
    calls.push({ bin, args, cwd: o.cwd });
    if (bin === "gemini" && opts.noGemini) return MISSING;
    if (args[0] === "--version") return ok(`${bin} 1.0.0\n`);
    if (args[0] === "mcp" && args[1] === "list") {
      if (bin === "claude") return ok(CLAUDE_LIST);
      if (bin === "codex") return ok(CODEX_JSON);
      if (bin === "agy") return ok(AGY_LIST);
      if (bin === "gemini") return ok(GEMINI_LIST);
    }
    if (bin === "claude" && args.includes("stream-json")) {
      return ok(`${JSON.stringify({ type: "system", subtype: "hook_started" })}\n${INIT}\n`);
    }
    if (bin === "claude" && args.includes("--strict-mcp-config")) {
      return ok(JSON.stringify({ type: "result", is_error: false, result: opts.draftReply ?? "" }));
    }
    if (bin === "claude" && args.includes("--allowedTools")) {
      return ok(JSON.stringify({ type: "result", is_error: false, result: opts.syncReply ?? "" }));
    }
    return { code: 1, stdout: "", stderr: "unexpected", missing: false, timedOut: false };
  };
  return { exec, calls };
}

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "apps-mirror-"));
  mkdirSync(join(v, "build", "_meta"), { recursive: true });
  mkdirSync(join(v, "data", "apps"), { recursive: true });
  for (const d of ["health", "notes", "wealth"]) {
    mkdirSync(join(v, "data", "domains", d), { recursive: true });
    writeFileSync(join(v, "data", "domains", d, "ideal-state.md"), `# ${d}\nA thriving ${d} domain.\n`);
  }
  return v;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

describe("parsers", () => {
  test("claude mcp list: names with spaces and dots, every status", () => {
    const r = parseClaudeMcpList(CLAUDE_LIST);
    expect(r.map((s) => s.name)).toEqual([
      "claude.ai Acme Notes", "claude.ai Foo Rides", "claude.ai Foo", "claude.ai Bar.io", "claude.ai Baz Mail", "prevail", "local-thing",
    ]);
    expect(r[0]).toMatchObject({ url: "https://mcp.acme-notes.example/mcp", status: "connected" });
    expect(r[1]!.status).toBe("needs_auth");
    expect(r[3]!.status).toBe("disabled");
    expect(r[3]!.detail).toContain("Disabled for this project");
    expect(r[5]!.command).toBe("/opt/tools/prevail mcp --unsafe-detach");
    expect(r[6]).toMatchObject({ command: "npx -y local-thing-mcp", status: "error" });
  });

  test("codex mcp list --json", () => {
    const r = parseCodexMcpList(CODEX_JSON);
    expect(r).toHaveLength(4);
    expect(r[1]).toMatchObject({ name: "helper-one", command: "/opt/helper serve mcp", status: "connected" });
    expect(r[2]).toMatchObject({ name: "Remote Docs", url: "https://docs.example/mcp", status: "needs_auth" });
    expect(r[3]).toMatchObject({ status: "disabled", detail: "user disabled" });
    expect(parseCodexMcpList("not json")).toEqual([]);
  });

  test("agy table with a spaced name", () => {
    const r = parseAgyMcpList(AGY_LIST);
    expect(r.map((s) => s.name)).toEqual(["prevail", "Acme Tasks", "qux"]);
    expect(r[1]).toMatchObject({ status: "disabled", url: "https://tasks.example/mcp" });
    expect(r[2]).toMatchObject({ status: "connected", command: "/usr/local/bin/qux --mcp" });
    expect(parseAgyMcpList("no servers")).toEqual([]);
  });

  test("gemini mcp list", () => {
    const r = parseGeminiMcpList(GEMINI_LIST);
    expect(r).toEqual([
      { name: "weatherish", command: "npx weatherish-mcp", status: "connected" },
      { name: "remote-kb", url: "https://kb.example/mcp", status: "error", detail: "Disconnected" },
    ]);
  });

  test("headless init status wins over the listing", async () => {
    const { applyInitStatus } = await import("./apps-mirror.ts");
    const a = { status: "connected" } as MirrorApp;
    applyInitStatus(a, "needs-auth");
    expect(a.status).toBe("needs_auth");
    expect(a.status_detail).toContain("headless");
    applyInitStatus(a, "pending");
    expect(a.status).toBe("needs_auth");
    applyInitStatus(a, "connected");
    expect(a.status).toBe("connected");
    expect(a.status_detail).toBeUndefined();
  });

  test("stable ids", () => {
    expect(appIdFor("claude", "claude.ai Acme Notes")).toBe("acme-notes");
    expect(appIdFor("claude", "claude.ai Bar.io")).toBe("bar-io");
    expect(appIdFor("codex", "Remote Docs")).toBe("codex-remote-docs");
    expect(appIdFor("agy", "qux")).toBe("agy-qux");
  });

  test("init line is found after hook lines", () => {
    const init = findClaudeInit(`{"type":"system","subtype":"hook_started"}\n${INIT}\n`);
    expect(init?.tools.length).toBe(10);
    expect(findClaudeInit("garbage\n{}")).toBeNull();
  });

  test("tools grouped by server prefix, no bleed between Foo and Foo Rides", () => {
    const init = findClaudeInit(INIT)!;
    expect(claudeToolsForServer(init.tools, "claude.ai Foo").map((t) => t.name)).toEqual(["book_ride", "list_rides"]);
    expect(claudeToolsForServer(init.tools, "claude.ai Foo Rides")).toEqual([]);
  });
});

// ── Classification ────────────────────────────────────────────────────────────

describe("classifyTool", () => {
  const k = (n: string) => classifyTool(n).kind;
  test("reads", () => {
    for (const n of ["list_cards", "get_card", "list_transactions", "search_threads", "get_thread", "notion-fetch", "notion-search",
      "notion-query-data-sources", "download_file_content", "read_file_content", "list_orders", "get_booking", "listEvents", "plaid_get_usages",
      "get_message", "get_draft", "get-export-formats", "list_drafts"]) {
      expect([n, k(n)]).toEqual([n, "read"]);
      expect(classifyTool(n).sync_allowed).toBe(true);
      expect(classifyTool(n).chat_default).toBe(true);
    }
  });
  test("writes are chat-allowed but never synced", () => {
    for (const n of ["create_draft", "update_draft", "delete_draft", "create_event", "update_event", "trash_message", "label_thread",
      "notion-create-pages", "notion-update-page", "notion-move-pages", "copy_file", "create_label", "notion-spawn-session", "complete_authentication", "authenticate",
      "update_message_labels", "get-create-design-async-job", "list_and_delete_items"]) {
      expect([n, k(n)]).toEqual([n, "write"]);
      expect(classifyTool(n)).toEqual({ kind: "write", sync_allowed: false, chat_default: true });
    }
  });
  test("send tools are never allowed", () => {
    for (const n of ["send_message", "reply", "forward", "share_file", "notion-create-comment", "comment-on-design", "reply-to-comment",
      "notion-send-message-to-session", "respond_to_event", "post_update", "publish-brand-template", "invite_member"]) {
      expect([n, k(n)]).toEqual([n, "send"]);
      expect(classifyTool(n)).toEqual({ kind: "send", sync_allowed: false, chat_default: false });
    }
  });
  test("money tools are never allowed", () => {
    for (const n of ["create_card", "close_card", "pause_card", "update_card_spend_limit", "book_ride", "place_order", "checkout",
      "transfer_funds", "pay_invoice", "purchase_item", "request_refund", "get_pan"]) {
      expect([n, k(n)]).toEqual([n, "money"]);
      expect(classifyTool(n)).toEqual({ kind: "money", sync_allowed: false, chat_default: false });
    }
  });
  test("secrets are not syncable even when phrased as a read", () => {
    expect(classifyTool("get_password").sync_allowed).toBe(false);
    expect(classifyTool("list_api_tokens").sync_allowed).toBe(false);
  });
});

// ── Refresh / list ────────────────────────────────────────────────────────────

describe("refresh + list", () => {
  test("merges runtimes, excludes prevail, caches, gemini missing", async () => {
    const v = makeVault();
    const { exec } = fakeExec({ noGemini: true });
    const doc = await refreshMirror(v, { exec, now: () => 1000 });
    const ids = doc.apps.map((a) => a.id);
    expect(ids).toContain("acme-notes");
    expect(ids).toContain("codex-helper-one");
    expect(ids).toContain("agy-acme-tasks");
    expect(ids.some((i) => i.includes("prevail"))).toBe(false);
    const gem = doc.runtimes.find((r) => r.runtime === "gemini")!;
    expect(gem.installed).toBe(false);
    expect(doc.runtimes.find((r) => r.runtime === "claude")).toMatchObject({ installed: true, syncable: true, count: 6 });
    expect(doc.runtimes.find((r) => r.runtime === "codex")).toMatchObject({ syncable: false, count: 3 });
    const codexApp = doc.apps.find((a) => a.id === "codex-remote-docs")!;
    expect(codexApp).toMatchObject({ syncable: false, status: "needs_auth", signin_hint: "codex mcp login Remote Docs", transport: "remote" });
    expect(doc.apps.find((a) => a.id === "agy-acme-tasks")!.signin_hint).toBe("agy mcp enable Acme Tasks");
    expect(doc.apps.find((a) => a.id === "acme-notes")!.signin_hint).toBe("https://claude.ai/settings/connectors");
    // no tool discovery -> no app folders scaffolded
    expect(readdirSync(join(v, "data", "apps"))).toEqual([]);
    expect(existsSync(join(v, "build", "_meta", "apps", "mirror.json"))).toBe(true);
    // list reads the cache without calling any runtime
    const calls: Call[] = [];
    const listed = await listMirror(v, { exec: async (bin, args) => { calls.push({ bin, args }); return MISSING; } });
    expect(calls).toEqual([]);
    expect(listed.apps.length).toBe(doc.apps.length);
  });

  test("--tools writes classified tools into manifests, keeping existing fields", async () => {
    const v = makeVault();
    mkdirSync(join(v, "data", "apps", "acme-notes"), { recursive: true });
    writeFileSync(join(v, "data", "apps", "acme-notes", "manifest.json"), JSON.stringify({ id: "acme-notes", title: "Acme Notes", integration: "mcp", domains: ["notes"], connection: "x" }));
    const { exec, calls } = fakeExec();
    const doc = await refreshMirror(v, { exec, tools: true, now: () => 5 });
    const init = calls.find((c) => c.args.includes("stream-json"))!;
    expect(init.args).toContain("--tools");
    expect(init.cwd).toBe(v);
    const acme = doc.apps.find((a) => a.id === "acme-notes")!;
    expect(acme.tools!.map((t) => `${t.name}:${t.kind}`)).toEqual(["create_page:write", "fetch_page:read", "search:read", "send_invite:send"]);
    expect(acme.tools_checked_at).toBe(5);
    expect(acme.domains).toEqual(["notes"]);
    const man = JSON.parse(readFileSync(join(v, "data", "apps", "acme-notes", "manifest.json"), "utf8"));
    expect(man.connection).toBe("x");
    expect(man.mirror).toEqual({ runtime: "claude", server: "claude.ai Acme Notes", url: "https://mcp.acme-notes.example/mcp" });
    expect(man.tools).toHaveLength(4);
    // only servers whose tools were discovered got a folder
    expect(readdirSync(join(v, "data", "apps")).sort()).toEqual(["acme-notes", "baz-mail", "foo"]);
  });
});

// ── Recipes + sync ────────────────────────────────────────────────────────────

async function withTools(): Promise<{ v: string }> {
  const v = makeVault();
  const { exec } = fakeExec();
  await refreshMirror(v, { exec, tools: true });
  return { v };
}

describe("recipes", () => {
  test("save validates read tools and domains", async () => {
    const { v } = await withTools();
    const { exec } = fakeExec();
    await expect(saveRecipe(v, "acme-notes", { prompt: "p", domains: ["notes"], readTools: ["create_page"] }, { exec })).rejects.toThrow(/not read tools/);
    await expect(saveRecipe(v, "acme-notes", { prompt: "p", domains: ["nope"], readTools: ["search"] }, { exec })).rejects.toThrow(/unknown domain/);
    await expect(saveRecipe(v, "codex-helper-one", { prompt: "p", domains: ["notes"], readTools: ["search"] }, { exec })).rejects.toThrow(/mirror-only/);
    const app = await saveRecipe(v, "acme-notes", { prompt: "Pull recent pages", domains: ["notes"], schedule: "weekly", readTools: [`${ACME}search`, "fetch_page"] }, { exec, now: () => 9 });
    expect(app.recipe).toEqual({ prompt: "Pull recent pages", domains: ["notes"], schedule: "weekly", read_tools: ["search", "fetch_page"], updated_at: 9 });
    expect(app.domains).toEqual(["notes"]);
  });

  test("draft keeps only valid fields and lands in drafts/, not the manifest", async () => {
    const { v } = await withTools();
    const reply = "Here you go:\n```json\n{\"prompt\":\"Fetch pages\",\"domains\":[\"notes\",\"made-up\"],\"schedule\":\"daily\",\"read_tools\":[\"search\",\"create_page\"]}\n```";
    const { exec, calls } = fakeExec({ draftReply: reply });
    const r = await draftRecipe(v, "acme-notes", { exec, model: "claude-test-model" });
    expect(r.model).toBe("claude-test-model");
    expect(r.recipe).toEqual({ prompt: "Fetch pages", domains: ["notes"], schedule: "daily", read_tools: ["search"] });
    const prompt = calls.find((c) => c.args.includes("--strict-mcp-config"))!.args[1]!;
    expect(prompt).toContain("- fetch_page");
    expect(prompt).not.toContain("create_page");
    expect(prompt).toContain("A thriving notes domain.");
    expect(existsSync(join(v, "build", "_meta", "apps", "drafts", "acme-notes.json"))).toBe(true);
    const man = JSON.parse(readFileSync(join(v, "data", "apps", "acme-notes", "manifest.json"), "utf8"));
    expect(man.recipe).toBeUndefined();
    const saved = await saveRecipe(v, "acme-notes", { fromDraft: true, schedule: "manual" }, { exec });
    expect(saved.recipe).toMatchObject({ prompt: "Fetch pages", schedule: "manual", read_tools: ["search"] });
  });
});

describe("sync", () => {
  test("args pin the tool surface", () => {
    const app = { id: "acme-notes", name: "Acme Notes", server: "claude.ai Acme Notes", tools: claudeToolsForServer(findClaudeInit(INIT)!.tools, "claude.ai Acme Notes") } as MirrorApp;
    const args = buildSyncArgs(app, { prompt: "p", domains: ["notes"], schedule: "daily", read_tools: ["search", "create_page"] }, ["claude.ai Baz Mail", "claude.ai Acme Notes"], "PROMPT");
    const val = (f: string) => args[args.indexOf(f) + 1]!;
    expect(val("--allowedTools")).toBe(`${ACME}search`);
    const deny = val("--disallowedTools").split(",");
    expect(deny).toContain(`${ACME}create_page`);
    expect(deny).toContain(`${ACME}send_invite`);
    expect(deny).toContain(`${ACME}fetch_page`);
    expect(deny).toContain("mcp__claude_ai_Baz_Mail");
    expect(deny).toContain("mcp__prevail");
    expect(deny).toContain("Bash");
    expect(deny).not.toContain(`${ACME}search`);
    expect(val("--tools")).toBe("");
    expect(val("--permission-mode")).toBe("dontAsk");
    expect(val("--model")).toBe("claude-haiku-4-5");
  });

  test("writes records per domain + checkpoint, then due logic", async () => {
    const { v } = await withTools();
    const reply = "```json\n{\"records\":[{\"title\":\"Page A\"},{\"title\":\"Page B\"}],\"summary\":\"two pages\"}\n```";
    const { exec, calls } = fakeExec({ syncReply: reply });
    await saveRecipe(v, "acme-notes", { prompt: "Pull pages", domains: ["notes", "health"], readTools: ["search"] }, { exec });
    const t = new Date(2026, 0, 15, 12).getTime();
    const r = await syncMirrorApp(v, "acme-notes", { exec, now: () => t });
    expect(r).toMatchObject({ ok: true, id: "acme-notes", records: 2 });
    expect(r.files.map((f) => f.slice(v.length))).toEqual([
      "/data/domains/notes/source/apps/acme-notes/2026-01-15.json",
      "/data/domains/health/source/apps/acme-notes/2026-01-15.json",
    ]);
    const call = calls.find((c) => c.args.includes("--allowedTools"))!;
    expect(call.cwd).toBe(v);
    const cp = readCheckpoint(v, "acme-notes");
    expect(cp).toMatchObject({ last_sync: t, last_error: null, records: 2 });
    expect(cp.runs).toHaveLength(1);
    const listed = (await listMirror(v)).apps.find((a) => a.id === "acme-notes")!;
    expect(listed).toMatchObject({ last_sync: t, records_last_sync: 2, last_error: null });
    // context block for the domain
    const ctx = syncedAppsContext(join(v, "data", "domains", "notes"));
    expect(ctx).toContain("SYNCED APP DATA");
    expect(ctx).toContain("Page B");
    expect(syncedAppsContext(join(v, "data", "domains", "wealth"))).toBe("");
    // due: a daily recipe that just ran is not due; a day later it is
    expect((await syncDue(v, { exec, now: () => t + 3600_000 })).ran).toEqual([]);
    const later = await syncDue(v, { exec, now: () => t + 24 * 3600_000 });
    expect(later.ran).toEqual([{ id: "acme-notes", ok: true, records: 2 }]);
  });

  test("failures are recorded, never thrown", async () => {
    const { v } = await withTools();
    const { exec } = fakeExec({ syncReply: "I could not do that." });
    expect((await syncMirrorApp(v, "acme-notes", { exec })).error).toMatch(/no recipe/);
    await saveRecipe(v, "acme-notes", { prompt: "Pull", domains: ["notes"], readTools: ["search"] }, { exec });
    const r = await syncMirrorApp(v, "acme-notes", { exec });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/JSON/);
    expect(readCheckpoint(v, "acme-notes").last_error).toMatch(/JSON/);
    expect((await syncMirrorApp(v, "foo-rides", { exec })).ok).toBe(false);
    expect((await syncMirrorApp(v, "nope", { exec })).error).toMatch(/no mirrored app/);
  });

  test("isDue", () => {
    const H = 3600_000;
    expect(isDue("manual", { last_sync: null, last_error: null }, 0)).toBe(false);
    expect(isDue("daily", { last_sync: null, last_error: null }, 0)).toBe(true);
    expect(isDue("daily", { last_sync: 0, last_error: null }, 22 * H)).toBe(false);
    expect(isDue("daily", { last_sync: 0, last_error: null }, 23 * H)).toBe(true);
    expect(isDue("weekly", { last_sync: 0, last_error: null }, 6 * 24 * H)).toBe(false);
    expect(isDue("weekly", { last_sync: 0, last_error: null }, 7 * 24 * H)).toBe(true);
    expect(isDue("daily", { last_sync: null, last_error: "x", last_attempt: 0 }, H / 2)).toBe(false);
  });
});

describe("extractJsonObject", () => {
  test("plain, fenced, embedded, and garbage", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(extractJsonObject('Sure! {"a":{"b":"}"}} done')).toEqual({ a: { b: "}" } });
    expect(extractJsonObject("nothing here")).toBeNull();
  });
});

// ── Archive ───────────────────────────────────────────────────────────────────

describe("archive", () => {
  function app(v: string, id: string, files: Record<string, string>) {
    const dir = join(v, "data", "apps", id);
    mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      if (rel.endsWith("/")) mkdirSync(p, { recursive: true });
      else writeFileSync(p, body);
    }
  }

  test("scaffoldOnly definition", () => {
    const v = makeVault();
    app(v, "plain", { "manifest.json": "{}", "skills/x/SKILL.md": "# x", "state.md": "# s", "MEMORY.md": "m", "_threads/": "", "_journal/": "", "_intents.jsonl": "", "connection-status.json": '{"status":"not-configured"}', "._state.md": "junk" });
    app(v, "hasdata", { "manifest.json": "{}", "data/out.json": "{}" });
    app(v, "hascode", { "manifest.json": "{}", "skills/x/sync.py": "print(1)" });
    app(v, "hasthreads", { "manifest.json": "{}", "_threads/a.md": "hi" });
    app(v, "bigstate", { "manifest.json": "{}", "state.md": "x".repeat(5000) });
    app(v, "synced", { "manifest.json": "{}", "connection-status.json": '{"status":"connected","lastSuccessTs":1}' });
    app(v, "intents", { "manifest.json": "{}", "_intents.jsonl": '{"a":1}\n' });
    app(v, "csv", { "manifest.json": "{}", "export.csv": "a,b" });
    const root = join(v, "data", "apps");
    expect(scaffoldOnly(join(root, "plain")).scaffold).toBe(true);
    for (const id of ["hasdata", "hascode", "hasthreads", "bigstate", "synced", "intents", "csv"]) {
      expect([id, scaffoldOnly(join(root, id)).scaffold]).toEqual([id, false]);
    }
  });

  test("dry-run lists, apply moves (never deletes) and indexes; mirrored and _ dirs skipped", () => {
    const v = makeVault();
    app(v, "old-one", { "manifest.json": "{}" });
    app(v, "old two", { "manifest.json": "{}", "skills/a/SKILL.md": "# a" });
    app(v, "acme-notes", { "manifest.json": "{}" });
    app(v, "_scratch", { "manifest.json": "{}" });
    app(v, "keeper", { "manifest.json": "{}", "data/x.json": "{}" });
    app(v, "_archive/old-one", { "manifest.json": "{}" });
    const mirrored = new Set(["acme-notes"]);
    expect(archiveCandidates(v, mirrored).map((c) => c.id)).toEqual(["old two", "old-one"]);
    const dry = archiveApps(v, mirrored, false);
    expect(dry.moved).toEqual([]);
    expect(existsSync(join(v, "data", "apps", "old-one"))).toBe(true);
    const done = archiveApps(v, mirrored, true, new Date(2026, 1, 3).getTime());
    expect(done.moved.map((m) => m.id)).toEqual(["old two", "old-one"]);
    expect(existsSync(join(v, "data", "apps", "old-one"))).toBe(false);
    expect(existsSync(join(v, "data", "apps", "_archive", "old-one-2", "manifest.json"))).toBe(true);
    expect(existsSync(join(v, "data", "apps", "_archive", "old two", "skills", "a", "SKILL.md"))).toBe(true);
    const index = readFileSync(join(v, "data", "apps", "_archive", "INDEX.md"), "utf8");
    expect(index).toContain("- 2026-02-03 `old-one` (as old-one-2):");
    expect(index).toContain("- 2026-02-03 `old two`:");
    expect(readdirSync(join(v, "data", "apps")).sort()).toEqual(["_archive", "_scratch", "acme-notes", "keeper"]);
  });
});

describe("scanners skip _-prefixed app dirs", () => {
  test("scanApps and scanCommunityApps never list _archive", async () => {
    const { scanApps, scanCommunityApps } = await import("./vault.ts");
    const v = makeVault();
    const arch = join(v, "data", "apps", "_archive", "old-one");
    mkdirSync(arch, { recursive: true });
    writeFileSync(join(arch, "manifest.json"), "{}");
    writeFileSync(join(arch, "SKILL.md"), "# old");
    writeFileSync(join(v, "data", "apps", "_archive", "INDEX.md"), "# Archived apps\n");
    mkdirSync(join(v, "data", "apps", "live-one"), { recursive: true });
    writeFileSync(join(v, "data", "apps", "live-one", "manifest.json"), "{}");
    const ids = scanApps(v).map((a) => a.id);
    expect(ids).toContain("live-one");
    expect(ids.some((i) => i.startsWith("_"))).toBe(false);
    expect(scanCommunityApps(v).some((a) => a.id.startsWith("_") || a.path.includes("_archive"))).toBe(false);
  });
});

describe("daemon hook", () => {
  test("runMirrorRecipesDue never throws and is a no-op without a cache", async () => {
    const { runMirrorRecipesDue } = await import("./daemon-sync.ts");
    const v = makeVault();
    expect(await runMirrorRecipesDue(v)).toEqual({ ran: 0, ok: 0 });
    expect(await runMirrorRecipesDue(join(v, "does-not-exist"))).toEqual({ ran: 0, ok: 0 });
  });
});

describe("MCP list_apps", () => {
  test("includes mirrored connectors from the cache", async () => {
    const { tListMirrorApps } = await import("./mcp-server.ts");
    const v = makeVault();
    expect(tListMirrorApps(v)).toBe("");
    const { exec } = fakeExec();
    await refreshMirror(v, { exec });
    const txt = tListMirrorApps(v);
    expect(txt).toContain("# Mirrored connectors");
    expect(txt).toContain("(acme-notes) Acme Notes [claude, connected, no recipe]");
    expect(txt).toContain("(codex-helper-one) helper-one [codex, connected, mirror-only]");
  });
});
