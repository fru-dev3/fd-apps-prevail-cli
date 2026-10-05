import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateBuiltin, gateToolCall } from "./act-gate.ts";
import { listMirror, mirrorCachePath } from "./apps-mirror.ts";
import { accessLogPath, appChatBlock, mirrorApps, planAppRouting, recordAppAccess } from "./app-scope.ts";
import { runChatJson } from "./chat-json.ts";
import type { ChatTurn } from "./cli-bridge.ts";
import {
  addSource,
  probeMcp,
  readRegistry,
  registryPath,
  remoteMcpConfig,
  removeSource,
  sourceInfo,
  turnSources,
  validateSourceUrl,
} from "./trusted-sources.ts";

// Trusted sources. A local mock MCP server (Bun.serve) and mocked web fetches;
// invented "foo" names; never a real model call.

let mcpUrl = "";
let server: ReturnType<typeof Bun.serve>;
const calls: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("", { status: 405 });
      const msg = (await req.json()) as { id?: number; method: string };
      calls.push(msg.method);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "foo-mcp", version: "0.1" } });
      if (msg.method === "tools/list") {
        return reply({ tools: [
          { name: "list_foos", annotations: { readOnlyHint: true } },
          { name: "foo_spec", annotations: { readOnlyHint: true } },
          { name: "drop_foo" },
        ] });
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
    },
  });
  mcpUrl = `http://localhost:${server.port}/mcp`;
});
afterAll(() => server.stop(true));

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-trusted-"));
  mkdirSync(join(vault, "data", "domains", "general"), { recursive: true });
  mkdirSync(join(vault, "data", "entities", "products"), { recursive: true });
  // An empty runtime mirror, so listing never spawns a runtime.
  mkdirSync(join(mirrorCachePath(vault), ".."), { recursive: true });
  writeFileSync(mirrorCachePath(vault), JSON.stringify({ generated_at: 1, runtimes: [], apps: [] }));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

// A mocked site: llms.txt and openapi.json on https://foo.example.
const siteFetch = async (url: string): Promise<Response> => {
  if (url === "https://foo.example/llms.txt") return new Response("# Foo Data\n\n> Foo facts, updated daily.\n", { headers: { "content-type": "text/plain" } });
  if (url === "https://foo.example/openapi.json") {
    return Response.json({
      info: { title: "Foo API" },
      paths: {
        "/api/foos": { get: { summary: "List foos" } },
        "/api/foos/{id}": { get: { summary: "One foo" }, delete: { summary: "Drop a foo" } },
        "/api/admin": { post: { summary: "Admin only" } },
      },
    });
  }
  return new Response("nope", { status: 404 });
};

test("URL validation: https only (http for localhost), never a credential", () => {
  expect(validateSourceUrl("https://foo.example/mcp")).toEqual({ url: "https://foo.example/mcp" });
  expect(validateSourceUrl("http://localhost:8080/mcp")).toEqual({ url: "http://localhost:8080/mcp" });
  expect("error" in validateSourceUrl("http://foo.example/mcp")).toBe(true);
  expect("error" in validateSourceUrl("ftp://foo.example/")).toBe(true);
  expect("error" in validateSourceUrl("not a url")).toBe(true);
  expect("error" in validateSourceUrl("https://user:pw@foo.example/")).toBe(true);
  expect("error" in validateSourceUrl("https://foo.example/api?api_key=x")).toBe(true);
  expect("error" in validateSourceUrl("https://foo.example/api?token=x")).toBe(true);
  expect(validateSourceUrl("https://foo.example/api?q=1#frag")).toEqual({ url: "https://foo.example/api?q=1" });
});

test("add-source refuses a bad kind, a bad URL and two MCP URLs, writing nothing", async () => {
  await expect(addSource(vault, { kind: "db", urls: ["https://foo.example"], name: "Foo" })).rejects.toThrow(/--kind/);
  await expect(addSource(vault, { kind: "web", urls: ["http://foo.example"], name: "Foo" })).rejects.toThrow(/https/);
  await expect(addSource(vault, { kind: "mcp-remote", urls: [mcpUrl, "https://foo.example/mcp"], name: "Foo" })).rejects.toThrow(/exactly one/);
  expect(existsSync(join(vault, "data", "entities", "products", "foo"))).toBe(false);
});

test("mcp-remote: probe lists tools with read classification; manifest, registry and apps list", async () => {
  const r = await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" }, { now: () => 1000 });
  expect(r.probe.ok).toBe(true);
  expect(r.probe.server).toEqual({ name: "foo-mcp", version: "0.1", protocol: "2025-06-18" });
  expect(r.probe.tools).toEqual([
    { name: "list_foos", kind: "read", read_only_hint: true, required: 0 },
    { name: "foo_spec", kind: "read", read_only_hint: true, required: 0 },
    { name: "drop_foo", kind: "write", read_only_hint: false, required: 0 },
  ]);
  expect(calls).toContain("notifications/initialized");
  expect(r.app).toMatchObject({ id: "foo-context", trusted: true, integration: "mcp-remote", urls: [mcpUrl], status: "connected", runtime: "claude" });

  const man = JSON.parse(readFileSync(join(vault, "data", "entities", "products", "foo-context", "manifest.json"), "utf8"));
  expect(man).toMatchObject({ id: "foo-context", name: "Foo Context", integration: "mcp-remote", urls: [mcpUrl], trusted: true, domains: [] });
  expect(man.tools.map((t: { name: string; kind: string }) => `${t.name}:${t.kind}`)).toEqual(["list_foos:read", "foo_spec:read", "drop_foo:write"]);
  expect(readRegistry(vault)["foo-context"]).toMatchObject({ integration: "mcp-remote", read_tools: ["list_foos", "foo_spec"] });

  const doc = await listMirror(vault);
  const app = doc.apps.find((a) => a.id === "foo-context")!;
  expect(app).toMatchObject({ trusted: true, integration: "mcp-remote", status: "connected" });
  expect(app.tools!.map((t) => `${t.name}:${t.kind}`)).toEqual(["list_foos:read", "foo_spec:read", "drop_foo:write"]);
});

test("mcp-remote: a dead endpoint is added with status error", async () => {
  const r = await addSource(vault, { kind: "mcp-remote", urls: ["http://localhost:1/mcp"], name: "Foo Down" });
  expect(r.probe.ok).toBe(false);
  expect(r.app.status).toBe("error");
  expect(r.app.status_detail).toBeTruthy();
});

test("probe times out within its budget", async () => {
  const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
  const p = await probeMcp("https://foo.example/mcp", { fetch: hang, timeoutMs: 50 });
  expect(p).toMatchObject({ ok: false, error: "no answer within 10 s" });
});

test("adopting keeps the user's own manifest values and files", async () => {
  const dir = join(vault, "data", "entities", "products", "foo-context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "My Foo", domains: ["money"], note: "mine" }));
  writeFileSync(join(dir, "SKILL.md"), "# mine\n");
  const r = await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  expect(r.adopted).toBe(true);
  const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(man).toMatchObject({ id: "foo-context", name: "My Foo", domains: ["money"], note: "mine", trusted: true, integration: "mcp-remote" });
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# mine\n");
  // Another kind of app with that name is never taken over.
  mkdirSync(join(vault, "data", "entities", "products", "foo-mail"), { recursive: true });
  writeFileSync(join(vault, "data", "entities", "products", "foo-mail", "manifest.json"), JSON.stringify({ integration: "oauth" }));
  await expect(addSource(vault, { kind: "web", urls: ["https://foo.example"], name: "Foo Mail" }, { fetch: siteFetch })).rejects.toThrow(/already exists as a oauth app/);
});

test("per-turn config: a referenced mcp-remote source is attached as an http MCP server under its id", async () => {
  await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  const turns: ChatTurn[] = [];
  const events: Record<string, unknown>[] = [];
  const code = await runChatJson({
    vaultPath: vault, domain: "general", message: "List the foos", sessionId: "t-foo", apps: ["foo-context"],
    write: (l) => events.push(JSON.parse(l)),
    deps: {
      detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
      runChatTurn: async (t: ChatTurn) => {
        turns.push(t);
        t.onTool?.({ name: "mcp__foo-context__list_foos", phase: "call", id: "s1", input: {} });
        return "Two foos.";
      },
      persistMessage: () => {},
    },
  });
  expect(code).toBe(0);
  expect(turns[0]!.remoteMcp).toEqual({ "foo-context": mcpUrl });
  expect(turns[0]!.inheritUserMcp).toBe(true);
  expect(turns[0]!.prompt).toContain("# APP CONTEXT: Foo Context");
  expect(turns[0]!.prompt).toContain("Reads: list_foos, foo_spec");
  expect(JSON.parse(remoteMcpConfig(turns[0]!.remoteMcp!)!)).toEqual({ mcpServers: { "foo-context": { type: "http", url: mcpUrl } } });
  // Tool events carry the app.
  expect(events.find((e) => e.type === "tool")).toMatchObject({ app: "foo-context" });
  // The attached config reaches the mock server.
  const url = JSON.parse(remoteMcpConfig(turns[0]!.remoteMcp!)!).mcpServers["foo-context"].url;
  expect((await probeMcp(url)).ok).toBe(true);
});

test("routing: an mcp-remote source needs Claude; web and links sources need no runtime", async () => {
  await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  await addSource(vault, { kind: "web", urls: ["https://foo.example"], name: "Foo Site" }, { fetch: siteFetch });
  const apps = mirrorApps(vault);
  expect(planAppRouting(["foo-context"], apps, "codex", () => true).route?.runtime).toBe("claude");
  expect(planAppRouting(["foo-context"], apps, "codex", () => false).unavailable).toEqual([{ app: "foo-context", runtime_needed: "claude" }]);
  expect(planAppRouting(["foo-site"], apps, "codex", () => true)).toEqual({ unavailable: [], needsAuth: [] });
});

test("act gate: registered reads run and are logged as reads; other tools queue", async () => {
  await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  // foo_spec reads by hint only (its name is no read verb).
  expect(gateToolCall(vault, "general", "mcp__foo-context__foo_spec", { host: "foo.example" }).action).toBe("allow");
  expect(gateToolCall(vault, "general", "mcp__foo-context__drop_foo", { id: "1" }).action).toBe("deny");
  // An unregistered server with the same tool name is not trusted.
  expect(gateToolCall(vault, "general", "mcp__foo-other__foo_spec", {}).action).toBe("deny");
  expect(recordAppAccess(vault, "mcp__foo-context__foo_spec", { host: "foo.example" }, "ran", { thread: "t-foo", now: 5 })).toBe("foo-context");
  const line = JSON.parse(readFileSync(accessLogPath(vault, "foo-context"), "utf8").trim());
  expect(line).toEqual({ ts: 5, tool: "foo_spec", access: "read", outcome: "ran", thread: "t-foo", summary: "host=foo.example" });
});

test("web: llms.txt and openapi GET paths are summarized; WebFetch may GET only that host", async () => {
  const r = await addSource(vault, { kind: "web", urls: ["https://foo.example/docs"], name: "Foo Site" }, { fetch: siteFetch });
  expect(r.probe).toMatchObject({ ok: true, llms_txt: true, openapi: true });
  const man = JSON.parse(readFileSync(join(vault, "data", "entities", "products", "foo-site", "manifest.json"), "utf8"));
  expect(man.source.title).toBe("Foo Data");
  expect(man.source.endpoints).toEqual([{ path: "/api/foos", summary: "List foos" }, { path: "/api/foos/{id}", summary: "One foo" }]);
  expect(man.source.llms).toContain("Foo facts");
  expect(r.app).toMatchObject({ trusted: true, integration: "web", status: "connected" });

  const block = appChatBlock(vault, "foo-site", mirrorApps(vault).find((a) => a.id === "foo-site")!);
  expect(block).toContain("You may fetch ONLY these hosts, and GET only: foo.example");
  expect(block).toContain("- GET /api/foos: List foos");
  expect(block).not.toContain("/api/admin");

  expect(gateBuiltin(vault, true, "WebFetch", { url: "https://foo.example/api/foos" })?.action).toBe("allow");
  expect(gateBuiltin(vault, true, "WebFetch", { url: "https://bar.example/x" })?.action).toBe("deny");
  expect(gateBuiltin(vault, true, "WebFetch", { url: "http://foo.example/x" })?.action).toBe("deny");
  expect(gateBuiltin(vault, true, "WebSearch", { query: "foo" })?.action).toBe("deny");
});

test("links: each URL is checked; the turn gets their hosts", async () => {
  const r = await addSource(vault, { kind: "links", urls: ["https://foo.example/llms.txt", "https://foo.example/missing"], name: "Foo Links" }, { fetch: siteFetch });
  expect(r.probe.urls).toEqual([
    { url: "https://foo.example/llms.txt", status: 200, ok: true },
    { url: "https://foo.example/missing", status: 404, ok: false },
  ]);
  expect(r.app.status).toBe("connected");
  const turns: ChatTurn[] = [];
  await runChatJson({
    vaultPath: vault, domain: "general", message: "hi", sessionId: "t-foo", apps: ["foo-links"], write: () => {},
    deps: { detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }], runChatTurn: async (t: ChatTurn) => { turns.push(t); return "ok"; }, persistMessage: () => {} },
  });
  expect(turns[0]!.fetchHosts).toEqual(["foo.example"]);
  expect(turns[0]!.remoteMcp).toBeUndefined();
});

test("remove-source archives the folder, never deletes it", async () => {
  await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  const r = removeSource(vault, "foo-context", 0);
  expect(r.to).toBe(join(vault, "data", "entities", "products", "_archive", "foo-context"));
  expect(existsSync(join(r.to, "manifest.json"))).toBe(true);
  expect(existsSync(join(vault, "data", "entities", "products", "foo-context"))).toBe(false);
  expect(readRegistry(vault)["foo-context"]).toBeUndefined();
  expect(gateToolCall(vault, "general", "mcp__foo-context__foo_spec", {}).action).toBe("deny");
  expect(readFileSync(join(vault, "data", "entities", "products", "_archive", "INDEX.md"), "utf8")).toContain("`foo-context`: trusted source removed");
  // A second one with the same id goes beside it.
  await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  expect(removeSource(vault, "foo-context").to).toBe(join(vault, "data", "entities", "products", "_archive", "foo-context-2"));
  expect(() => removeSource(vault, "foo-nothing")).toThrow(/not a trusted source/);
});

test("a source folder synced from another Mac lists as untrusted_here and is never trusted or attached", async () => {
  await addSource(vault, { kind: "mcp-remote", urls: [mcpUrl], name: "Foo Context" });
  await addSource(vault, { kind: "web", urls: ["https://foo.example"], name: "Foo Site" }, { fetch: siteFetch });
  // The folders synced; this Mac's registry only knows foo-site.
  const reg = readRegistry(vault);
  delete reg["foo-context"];
  writeFileSync(registryPath(vault), JSON.stringify(reg));
  const before = readFileSync(registryPath(vault), "utf8");

  const apps = (await listMirror(vault)).apps;
  expect(apps.find((a) => a.id === "foo-context")).toMatchObject({
    name: "Foo Context", trusted: true, trusted_here: false, integration: "mcp-remote", urls: [mcpUrl], status: "untrusted_here",
  });
  expect(apps.find((a) => a.id === "foo-context")!.tools).toBeUndefined();
  expect(apps.find((a) => a.id === "foo-site")).toMatchObject({ trusted: true, trusted_here: true, integration: "web", status: "connected" });
  // The connectors list reads the same facts.
  expect(sourceInfo(vault, "foo-context")).toEqual({ integration: "mcp-remote", urls: [mcpUrl], name: "Foo Context", trusted: true, trusted_here: false });
  expect(sourceInfo(vault, "foo-site")).toMatchObject({ integration: "web", trusted_here: true });
  expect(sourceInfo(vault, "nothing-here")).toBeNull();

  // Read-only: nothing is trusted, attached, routed or allowed.
  expect(readFileSync(registryPath(vault), "utf8")).toBe(before);
  expect(turnSources(apps.filter((a) => a.id === "foo-context"))).toEqual({ remoteMcp: {}, fetchHosts: [] });
  expect(planAppRouting(["foo-context"], apps, "codex", () => true)).toEqual({ unavailable: [], needsAuth: [] });
  // foo_spec reads by hint only, so only the registry could allow it.
  expect(gateToolCall(vault, "general", "mcp__foo-context__foo_spec", {}).action).toBe("deny");
  expect(appChatBlock(vault, "foo-context", apps.find((a) => a.id === "foo-context")!)).toContain("NOT trusted on this one");
});

test("a synced manifest's URLs are shown only when they pass the add-time checks", () => {
  mkdirSync(join(vault, "data", "entities", "products", "foo-hand"), { recursive: true });
  writeFileSync(join(vault, "data", "entities", "products", "foo-hand", "manifest.json"), JSON.stringify({
    name: "Foo Hand", integration: "links", trusted: true, urls: ["https://foo.example/a", "https://foo.example/b?token=x", "http://foo.example/c"],
  }));
  expect(sourceInfo(vault, "foo-hand")).toMatchObject({ urls: ["https://foo.example/a"], trusted_here: false });
  // A manifest that does not claim to be a trusted source is not one.
  writeFileSync(join(vault, "data", "entities", "products", "foo-hand", "manifest.json"), JSON.stringify({ integration: "links", urls: ["https://foo.example/a"] }));
  expect(sourceInfo(vault, "foo-hand")).toBeNull();
});
