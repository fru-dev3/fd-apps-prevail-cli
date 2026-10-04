import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { classifyAct } from "./act-gate.ts";
import { briefingKnowledge } from "./briefings.ts";
import {
  addKnowledgeSource, checkKnowledgeSource, detectUrl, knowledgeForRun, knowledgeNote, listKnowledgeSources, migrateKnowledgeSources,
  parseSourceText, removeKnowledgeSource, setSourceScope, sourceToolCall, sourcesFooter, sourcesFor,
} from "./knowledge-sources.ts";
import { checkSelect, confinedFile, parseDbLocation, parseFeed, realFolder } from "./source-readers.ts";
import { sourcesMcpDispatch } from "./sources-mcp.ts";
import { readRegistry, registryPath } from "./trusted-sources.ts";

// Knowledge sources. Invented sources only: example.com sites served by a
// mocked fetch, a temp folder and a temp SQLite file. Never a real network
// call, never the keychain (a seam records what would be stored).

let root: string;
let vault: string;
let docs: string;
let dbFile: string;
const stored: Record<string, string> = {};
const deps = {
  writeSecret: (n: string, v: string) => { stored[n] = v; },
  readSecret: (n: string) => stored[n],
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "prevail-knowledge-")));
  vault = join(root, "vault");
  mkdirSync(join(vault, "data", "domains", "general"), { recursive: true });
  mkdirSync(join(vault, "data", "domains", "wealth"), { recursive: true });
  mkdirSync(join(vault, "data", "apps"), { recursive: true });
  docs = join(root, "docs");
  mkdirSync(join(docs, "sub"), { recursive: true });
  writeFileSync(join(docs, "budget-notes.md"), "# Foo budget\nThe foo budget is 120 units.\n");
  writeFileSync(join(docs, "sub", "items.csv"), "id,label\n1,alpha\n");
  writeFileSync(join(docs, "photo.png"), "not text");
  writeFileSync(join(root, "outside.md"), "outside secret");
  symlinkSync(join(root, "outside.md"), join(docs, "escape.md"));
  symlinkSync(root, join(docs, "uplink"));
  dbFile = join(root, "foo.db");
  const d = new Database(dbFile);
  d.exec("CREATE TABLE items(id INTEGER, label TEXT); INSERT INTO items VALUES (1,'alpha'),(2,'beta'),(3,'gamma');");
  d.close();
  for (const k of Object.keys(stored)) delete stored[k];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// A mocked web: a site that advertises an MCP endpoint, the endpoint itself,
// a feed, and a plain page.
const RSS = `<?xml version="1.0"?><rss><channel><title>Foo News</title><item><title>Foo launched</title><link>https://feed.example.com/a</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item><item><title>Bar &amp; baz</title></item></channel></rss>`;
function mockFetch(opts: { slow?: boolean } = {}) {
  // `slow` is read on each call, so a test can add a source and then slow it down.
  const seen: string[] = [];
  const f = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    seen.push(`${method} ${input}`);
    if (opts.slow && input.includes("slow.example.com")) {
      return new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    }
    const u = new URL(input);
    if (method === "POST" && u.href === "https://site.example.com/mcp") {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "foo-context" } });
      if (msg.method === "tools/list") return reply({ tools: [
        { name: "get_briefing", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
        { name: "search", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "delete_foo", inputSchema: { type: "object" } },
      ] });
      if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `called ${msg.params?.name}: foo prices fell 3 percent` }] });
    }
    if (method === "POST") return new Response("no", { status: 405 });
    if (u.href === "https://site.example.com/") return new Response(`<html><head><title>Foo Site | Data</title></head><body><p>Agents: MCP: https://site.example.com/mcp (read only)</p></body></html>`, { headers: { "content-type": "text/html" } });
    if (u.host === "feed.example.com" && u.pathname === "/feed.xml") return new Response(RSS, { headers: { "content-type": "application/rss+xml" } });
    if (u.host === "page.example.com" && u.pathname === "/") return new Response(`<html><head><title>Bar Page</title><script>evil()</script></head><body><h1>Bar</h1><p>Bar facts here.</p></body></html>`, { headers: { "content-type": "text/html" } });
    if (u.host === "slow.example.com" && u.pathname === "/") return new Response("<title>Slow</title>", { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };
  return Object.assign(f, { seen, opts });
}

test("a sentence is read for its location, kind, name, domains, projects and briefings", () => {
  const p = parseSourceText(`the notes folder at ${docs}, called Foo Notes, for wealth briefings`, { domains: ["general", "wealth", "health"] });
  expect(p).toMatchObject({ location: docs, kind: "folder", name: "Foo Notes", domains: ["wealth"], briefings: true });
  expect(parseSourceText("https://site.example.com/ for the chief of staff, no briefings")).toMatchObject({ location: "https://site.example.com/", general: true, briefings: false });
  expect(parseSourceText("postgres://foo@db.example.com/bar").kind).toBe("database");
  expect(parseSourceText("track the foo-launch project with https://page.example.com/", { projects: [{ slug: "foo-launch", name: "Foo launch" }] }).projects).toEqual(["foo-launch"]);
  expect(parseSourceText("").location).toBeUndefined();
});

test("only one SELECT runs: writes, several statements, comments and file functions are refused", () => {
  expect(checkSelect("select * from items;")).toEqual({ sql: "select * from items" });
  expect("sql" in checkSelect("WITH x AS (SELECT 1 AS n) SELECT n FROM x")).toBe(true);
  expect("sql" in checkSelect("SELECT 'delete me' AS label")).toBe(true);
  for (const bad of [
    "DELETE FROM items", "insert into items values (4,'d')", "select 1; drop table items", "PRAGMA writable_schema=1",
    "ATTACH DATABASE '/tmp/x.db' AS x", "WITH x AS (SELECT 1) DELETE FROM items", "select * into t2 from items",
    "select 1 -- hidden", "select /* x */ 1", "select pg_read_file('/etc/passwd')", "select load_extension('x')", "update items set label='x'", "",
  ]) expect("error" in checkSelect(bad)).toBe(true);
});

test("a Postgres URL's password is split off; a SQLite file must be one", () => {
  const pg = parseDbLocation("postgres://foo:s3cret-pw@db.example.com:5432/bar");
  expect(pg).toEqual({ engine: "postgres", location: "postgres://foo@db.example.com:5432/bar", password: "s3cret-pw" });
  expect("error" in parseDbLocation("postgres://foo@db.example.com/bar?password=x")).toBe(true);
  expect(parseDbLocation(dbFile)).toEqual({ engine: "sqlite", location: dbFile });
  expect("error" in parseDbLocation(join(docs, "budget-notes.md"))).toBe(true);
});

test("a folder is read only inside its realpath: no symlink escape, text types only, no secret stores", () => {
  expect(realFolder(docs)).toEqual({ path: docs });
  expect("error" in realFolder("/")).toBe(true);
  expect("error" in realFolder("~")).toBe(true);
  expect("error" in realFolder("~/.ssh")).toBe(true);
  expect(confinedFile(docs, "budget-notes.md")).toEqual({ path: join(docs, "budget-notes.md") });
  for (const bad of ["../outside.md", "escape.md", "uplink/outside.md", "photo.png", "/etc/hosts", ""]) expect("error" in confinedFile(docs, bad)).toBe(true);
});

test("folder source: added from a sentence, listed with what was found, read through the tools, confined", async () => {
  const r = await addKnowledgeSource(vault, { text: `my notes at ${docs} for wealth briefings`, domains: ["general", "wealth"] }, deps);
  expect(r.source).toMatchObject({ id: "docs", kind: "folder", status: "ready", trusted_here: true, scope: { briefings: true, general: false, domains: ["wealth"], projects: [] } });
  expect(r.found).toBe("2 readable files (1 csv, 1 md)");
  expect(readRegistry(vault).docs!.paths).toEqual([docs]);
  const list = await sourceToolCall(vault, "read_source", { source: "docs" });
  expect(list).toContain("budget-notes.md");
  expect(list).not.toContain("escape.md");
  expect(list).not.toContain("photo.png");
  expect(await sourceToolCall(vault, "read_source", { source: "docs", path: "budget-notes.md" })).toContain("120 units");
  expect(await sourceToolCall(vault, "read_source", { source: "docs", path: "escape.md" })).toBe("escape.md is outside the folder");
  expect(await sourceToolCall(vault, "read_source", { source: "docs", path: "../outside.md" })).toBe("../outside.md is outside the folder");
});

test("SQLite source: tables found, SELECT runs capped, anything else refused, the file never changes", async () => {
  const r = await addKnowledgeSource(vault, { location: dbFile, name: "Foo DB" }, deps);
  expect(r.source).toMatchObject({ id: "foo-db", kind: "database", status: "ready", scope: { briefings: true, general: true } });
  expect(r.found).toBe("SQLite, 1 table: items");
  const before = readFileSync(dbFile);
  expect(JSON.parse(await sourceToolCall(vault, "query_database", { source: "foo-db", sql: "SELECT label FROM items WHERE id > 1 ORDER BY id" }))).toEqual({ columns: ["label"], rows: [["beta"], ["gamma"]], truncated: false });
  expect(await sourceToolCall(vault, "query_database", { source: "foo-db", sql: "DELETE FROM items" })).toContain("only SELECT");
  expect(await sourceToolCall(vault, "query_database", { source: "foo-db", sql: "select 1; delete from items" })).toContain("one statement");
  expect(await sourceToolCall(vault, "read_source", { source: "foo-db" })).toBe("items(id, label)");
  expect(readFileSync(dbFile).equals(before)).toBe(true);
});

test("Postgres: the password goes to the keychain seam, never to the vault; an unreachable server is an error", async () => {
  const r = await addKnowledgeSource(vault, { location: "postgres://foo:s3cret-pw@127.0.0.1:1/bar", name: "Bar PG" }, { ...deps, timeoutMs: 2000 });
  expect(stored.PREVAIL_SOURCE_BAR_PG_SECRET).toBe("s3cret-pw");
  expect(readRegistry(vault)["bar-pg"]).toMatchObject({ db: { engine: "postgres", location: "postgres://foo@127.0.0.1:1/bar" }, secret: "PREVAIL_SOURCE_BAR_PG_SECRET" });
  expect(r.source.status).toBe("error");
  expect(r.source.has_secret).toBe(true);
  const grep = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? grep(join(dir, e.name)) : readFileSync(join(dir, e.name), "utf8"))).join("\n");
  expect(grep(vault)).not.toContain("s3cret-pw");
}, 20_000);

test("a link is detected: the site's advertised MCP endpoint, a feed, a page", async () => {
  const f = mockFetch();
  expect(await detectUrl("https://site.example.com/", { fetch: f })).toMatchObject({ kind: "mcp", url: "https://site.example.com/mcp", title: "Foo Site | Data" });
  expect((await detectUrl("https://page.example.com/", { fetch: f })).kind).toBe("web");
  const r = await addKnowledgeSource(vault, { text: "https://site.example.com/" }, { ...deps, fetch: f });
  expect(r.source).toMatchObject({ id: "foo-site", kind: "mcp", location: "https://site.example.com/mcp", status: "ready" });
  expect(r.found).toBe("2 read-only tools: get_briefing, search");
  expect(readRegistry(vault)["foo-site"]!.read_tools).toEqual(["get_briefing", "search"]);
  const feed = await addKnowledgeSource(vault, { location: "https://feed.example.com/feed.xml", kind: "web", name: "Foo News" }, { ...deps, fetch: f });
  expect(feed.found).toContain("a feed");
  expect(parseFeed(RSS).items).toEqual([{ title: "Foo launched", link: "https://feed.example.com/a", date: "Mon, 01 Jan 2024 00:00:00 GMT" }, { title: "Bar & baz" }]);
});

test("an MCP source runs only its registered read tools", async () => {
  const f = mockFetch();
  await addKnowledgeSource(vault, { location: "https://site.example.com/mcp", kind: "mcp", name: "Foo Site" }, { ...deps, fetch: f });
  expect(await sourceToolCall(vault, "read_source", { source: "foo-site", tool: "delete_foo" }, { fetch: f })).toContain("not a registered read tool");
  expect(await sourceToolCall(vault, "read_source", { source: "foo-site", tool: "get_briefing" }, { fetch: f })).toBe("called get_briefing: foo prices fell 3 percent");
});

test("a run reads its sources under the ceilings and the output can cite them", async () => {
  const f = mockFetch();
  await addKnowledgeSource(vault, { location: docs, name: "Foo Notes", scope: { domains: ["wealth"] } }, deps);
  await addKnowledgeSource(vault, { location: "https://site.example.com/mcp", kind: "mcp", name: "Foo Site" }, { ...deps, fetch: f });
  await addKnowledgeSource(vault, { location: "https://feed.example.com/feed.xml", kind: "web", name: "Foo News", scope: { briefings: false } }, { ...deps, fetch: f });
  await addKnowledgeSource(vault, { location: "https://slow.example.com/", kind: "web", name: "Slow" }, { ...deps, fetch: f });
  // In scope for a wealth briefing: the folder (wealth), and the general ones with briefings on.
  const use = sourcesFor(vault, { domain: "wealth", briefing: true }).map((s) => s.id).sort();
  expect(use).toEqual(["foo-notes"]);
  const gen = sourcesFor(vault, { domain: "general", briefing: true }).map((s) => s.id).sort();
  expect(gen).toEqual(["foo-site", "slow"]);
  const all = sourcesFor(vault, { names: ["foo-notes", "Foo Site", "slow", "foo-news"] });
  f.opts.slow = true;
  const t0 = Date.now();
  const k = await knowledgeForRun(vault, all, { query: "foo budget", fetch: f, ceilings: { perSourceMs: 300, maxChars: 4000 } });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(k.block).toContain("# KNOWLEDGE SOURCES");
  expect(k.block).toContain('cite it inline as "From <name>: ..."');
  expect(k.block).toContain("## From Foo Notes (folder)");
  expect(k.block).toContain("120 units");
  expect(k.block).toContain("## From Foo Site (mcp)");
  expect(k.block).toContain("called get_briefing");
  expect(k.block).not.toContain("called search");
  expect(k.block).toContain("Foo launched");
  expect(k.block).not.toContain("From Slow");
  expect(k.reads.find((r) => r.id === "slow")).toMatchObject({ ok: false });
  expect(k.reads.filter((r) => r.ok).every((r) => r.chars <= 1000)).toBe(true);
  expect(sourcesFooter(k.reads)).toContain("Sources read: From Foo News; From Foo Notes; From Foo Site");
  expect(sourcesFooter(k.reads)).toContain("Not read: Slow (no answer within 300 ms)");
  const capped = await knowledgeForRun(vault, all, { fetch: f, ceilings: { maxSources: 1 } });
  expect(capped.reads.length).toBe(1);
}, 20_000);

test("a briefing reads its named sources, its scope, or none", async () => {
  await addKnowledgeSource(vault, { location: docs, name: "Foo Notes", scope: { domains: ["wealth"] } }, deps);
  const k = await briefingKnowledge(vault, { domain: "wealth", prompt: "How is the foo budget?" });
  expect(k.prompt.startsWith("# KNOWLEDGE SOURCES")).toBe(true);
  expect(k.prompt.endsWith("How is the foo budget?")).toBe(true);
  expect(k.reads.map((r) => r.name)).toEqual(["Foo Notes"]);
  expect((await briefingKnowledge(vault, { domain: "wealth", prompt: "q", sources: ["none"] })).prompt).toBe("q");
  expect((await briefingKnowledge(vault, { domain: "health", prompt: "q" })).reads).toEqual([]);
  setSourceScope(vault, "foo-notes", { briefings: false });
  expect((await briefingKnowledge(vault, { domain: "wealth", prompt: "q" })).reads).toEqual([]);
});

test("a source synced from another Mac is listed but never trusted, read or attached", async () => {
  await addKnowledgeSource(vault, { location: docs, name: "Foo Notes" }, deps);
  // Another Mac: the folder synced, this Mac's allowlist did not.
  writeFileSync(registryPath(vault), "{}\n");
  const [s] = listKnowledgeSources(vault);
  expect(s).toMatchObject({ id: "foo-notes", status: "untrusted_here", trusted_here: false, location: docs });
  expect(sourcesFor(vault, { names: ["foo-notes"] })).toEqual([]);
  expect(await sourceToolCall(vault, "read_source", { source: "foo-notes", path: "budget-notes.md" })).toContain("not trusted on this one");
  const again = await checkKnowledgeSource(vault, "foo-notes", deps);
  expect(again.source.trusted_here).toBe(true);
});

test("old trusted sources get a scope without losing anything: dated backup, idempotent", () => {
  const dir = join(vault, "data", "apps", "foo-old");
  mkdirSync(dir, { recursive: true });
  const old = { id: "foo-old", name: "Foo Old", integration: "web", urls: ["https://page.example.com/"], trusted: true, domains: ["wealth"], probe: { ok: true, checked_at: 1 } };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(old));
  mkdirSync(join(registryPath(vault), ".."), { recursive: true });
  writeFileSync(registryPath(vault), JSON.stringify({ "foo-old": { integration: "web", urls: old.urls, hosts: ["page.example.com"], read_tools: [], updated_at: 1 } }));
  expect(migrateKnowledgeSources(vault, Date.UTC(2026, 0, 15, 12))).toEqual(["foo-old"]);
  const bak = readdirSync(dir).filter((n) => n.startsWith("manifest.json.bak-"));
  expect(bak).toEqual(["manifest.json.bak-2026-01-15"]);
  expect(JSON.parse(readFileSync(join(dir, bak[0]!), "utf8"))).toEqual(old);
  const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(man).toMatchObject({ ...old, scope: { briefings: false, general: false, domains: ["wealth"], projects: [] } });
  expect(migrateKnowledgeSources(vault)).toEqual([]);
  expect(listKnowledgeSources(vault)[0]).toMatchObject({ id: "foo-old", kind: "web", status: "ready" });
});

test("removing archives the folder; use changes the scope; the chat note names sources in scope", async () => {
  await addKnowledgeSource(vault, { location: dbFile, name: "Foo DB" }, deps);
  const s = setSourceScope(vault, "Foo DB", { general: false, domains: ["wealth"], projects: ["foo-launch"] });
  expect(s.scope).toEqual({ briefings: true, general: false, domains: ["wealth"], projects: ["foo-launch"] });
  expect(sourcesFor(vault, { project: "mission/foo-launch" }).map((x) => x.id)).toEqual(["foo-db"]);
  expect(sourcesFor(vault, { domain: "general" })).toEqual([]);
  const note = knowledgeNote(sourcesFor(vault, { domain: "wealth" }));
  expect(note).toContain("Foo DB (id foo-db, database)");
  expect(note).toContain("query_database");
  expect(knowledgeNote([])).toBe("");
  const r = removeKnowledgeSource(vault, "foo-db");
  expect(existsSync(r.to)).toBe(true);
  expect(existsSync(join(vault, "data", "apps", "foo-db"))).toBe(false);
  expect(listKnowledgeSources(vault)).toEqual([]);
});

test("the prevail_sources MCP server lists three read tools and the act gate lets them run", async () => {
  await addKnowledgeSource(vault, { location: docs, name: "Foo Notes" }, deps);
  const list = (await sourcesMcpDispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, vault)) as { tools: { name: string }[] };
  expect(list.tools.map((t) => t.name)).toEqual(["list_sources", "read_source", "query_database"]);
  const call = (await sourcesMcpDispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_source", arguments: { source: "foo-notes", path: "budget-notes.md" } } }, vault)) as { content: { text: string }[] };
  expect(call.content[0]!.text).toContain("120 units");
  await expect(sourcesMcpDispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_file" } }, vault)).rejects.toThrow("unknown tool");
  expect(classifyAct("mcp__prevail_sources__read_source")).toBe("allow");
  expect(classifyAct("mcp__prevail_sources__query_database")).toBe("allow");
});
