import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LockStore, authorize, domainToken, hubHandler, initHub, readHubConfig, routeDelivery, serveHub, tabHolder } from "./hub.ts";

mkdirSync(join(homedir(), ".prevail-test-tmp"), { recursive: true });
const ROOT = mkdtempSync(join(homedir(), ".prevail-test-tmp", "prevail-hub-"));
const V = join(ROOT, "vault");
const saved = process.env.PREVAIL_CONFIG_DIR;
process.env.PREVAIL_CONFIG_DIR = join(ROOT, "cfg");
afterAll(() => {
  if (saved === undefined) delete process.env.PREVAIL_CONFIG_DIR; else process.env.PREVAIL_CONFIG_DIR = saved;
  rmSync(ROOT, { recursive: true, force: true });
});
for (const d of ["general", "orchard", "ledger"]) mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
mkdirSync(join(V, "build"), { recursive: true });
writeFileSync(join(V, "data", "domains", "ledger", "MEMORY.md"), "# Memory\nledger private note\n");

const SECRET = "a".repeat(64);
const locks = new LockStore(null);
const handle = hubHandler({ vault: V, secret: SECRET, locks });
const rpc = (domain: string, token: string | null, body: unknown) =>
  handle(new Request(`http://hub/domains/${domain}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("hub config and tokens", () => {
  test("init writes a 0600 secret once and refuses every interface", () => {
    const c = initHub({ port: 7999 });
    expect(c.host).toBe("127.0.0.1");
    expect(statSync(join(ROOT, "cfg", "hub.json")).mode & 0o777).toBe(0o600);
    expect(initHub({}).secret).toBe(c.secret);
    expect(() => initHub({ host: "0.0.0.0" })).toThrow();
    expect(readHubConfig()!.port).toBe(7999);
  });

  test("a domain token opens only its domain; General's opens any lock", () => {
    const t = domainToken(SECRET, "orchard");
    expect(authorize(SECRET, t, "orchard")).toBe(true);
    expect(authorize(SECRET, t, "ledger")).toBe(false);
    expect(authorize(SECRET, domainToken(SECRET, "general"), "ledger")).toBe(true);
    expect(authorize(SECRET, "", "orchard")).toBe(false);
    expect(domainToken("b".repeat(64), "orchard")).not.toBe(t);
  });
});

describe("scoped MCP endpoints", () => {
  test("no token, a wrong token, or another domain's token is refused", async () => {
    expect((await rpc("orchard", null, call("read_state", {}))).status).toBe(401);
    expect((await rpc("orchard", domainToken(SECRET, "ledger"), call("read_state", {}))).status).toBe(401);
    expect((await rpc("orchard", domainToken(SECRET, "general"), call("read_state", {}))).status).toBe(401);
    expect((await rpc("nowhere", domainToken(SECRET, "nowhere"), call("read_state", {}))).status).toBe(404);
    const get = await handle(new Request("http://hub/domains/orchard", { headers: { authorization: `Bearer ${domainToken(SECRET, "orchard")}` } }));
    expect(get.status).toBe(405);
  });

  test("initialize and a scoped tools/list", async () => {
    const t = domainToken(SECRET, "orchard");
    const init = (await (await rpc("orchard", t, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("prevail");
    const list = (await (await rpc("orchard", t, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((x) => x.name);
    expect(names).toContain("read_memory");
    expect(names).not.toContain("connect_app");
    expect(names).not.toContain("run_playbook");
    const chief = (await (await rpc("general", domainToken(SECRET, "general"), { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    expect(chief.result.tools.map((x) => x.name)).toContain("connect_app");
  });

  test("orchard cannot read ledger; General can; a handoff lands as From orchard", async () => {
    const t = domainToken(SECRET, "orchard");
    const peek = (await (await rpc("orchard", t, call("read_memory", { domain: "ledger" }))).json()) as { error?: { message: string } };
    expect(peek.error?.message).toContain("reads and writes only orchard");
    const chief = (await (await rpc("general", domainToken(SECRET, "general"), call("read_memory", { domain: "ledger" }))).json()) as { result: { content: { text: string }[] } };
    expect(chief.result.content[0]!.text).toContain("ledger private note");
    const h = (await (await rpc("orchard", t, call("add_task", { domain: "ledger", text: "Sold the old tractor", amount: "$4,200", date: "2026-09-30" }))).json()) as { result: { content: { text: string }[] } };
    expect(h.result.content[0]!.text).toContain('Added to ledger: "From orchard: Sold the old tractor | amount: $4,200 | date: 2026-09-30"');
  });

  test("a notification gets 202 and a batch answers each request", async () => {
    const t = domainToken(SECRET, "orchard");
    expect((await rpc("orchard", t, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const batch = (await (await rpc("orchard", t, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "nope" }])).json()) as { id: number; error?: unknown }[];
    expect(batch.map((b) => b.id)).toEqual([1, 2]);
    expect(batch[1]!.error).toBeDefined();
  });
});

describe("domain locks on the hub", () => {
  test("one holder per domain; renew by the holder; a stale lock expires", () => {
    const s = new LockStore(null);
    expect(s.acquire("ledger", "tabs@hub", { pane: "p1", ttlMs: 1000, now: 0 }).ok).toBe(true);
    const other = s.acquire("ledger", "headless@laptop", { now: 500 });
    expect(other.ok).toBe(false);
    expect(other.lock.holder).toBe("tabs@hub");
    expect(s.acquire("ledger", "tabs@hub", { ttlMs: 1000, now: 900 }).ok).toBe(true);
    expect(s.acquire("ledger", "headless@laptop", { now: 2000 }).ok).toBe(true);
    expect(s.release("ledger", "tabs@hub")).toBe(false);
  });

  test("sync takes a holder's set and drops what it no longer holds", () => {
    const s = new LockStore(null);
    s.sync("tabs@hub", [{ domain: "a", pane: "p1" }, { domain: "b", pane: "p2" }]);
    s.sync("tabs@hub", [{ domain: "b", pane: "p2" }]);
    expect(s.list().map((l) => l.domain)).toEqual(["b"]);
  });

  test("over HTTP: a domain token locks only its domain; sync is General's", async () => {
    const post = (path: string, token: string, body: unknown) => handle(new Request(`http://hub${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    expect((await post("/locks/acquire", domainToken(SECRET, "orchard"), { domain: "ledger", holder: "x" })).status).toBe(401);
    expect((await post("/locks/acquire", domainToken(SECRET, "orchard"), { domain: "orchard", holder: "x", pane: "p9" })).status).toBe(200);
    expect((await post("/locks/acquire", domainToken(SECRET, "orchard"), { domain: "orchard", holder: "y" })).status).toBe(409);
    expect((await post("/locks/sync", domainToken(SECRET, "orchard"), { holder: "x", held: [] })).status).toBe(401);
    const got = (await (await handle(new Request("http://hub/locks", { headers: { authorization: `Bearer ${domainToken(SECRET, "ledger")}` } }))).json()) as { locks: { domain: string }[] };
    expect(got.locks.map((l) => l.domain)).toEqual(["orchard"]);
    expect((await handle(new Request("http://hub/locks"))).status).toBe(401);
  });

  test("a real server on localhost: work for a held domain goes to the idle tab, else waits; no hub runs headless", async () => {
    initHub({ host: "127.0.0.1", port: 0 });
    const srv = serveHub(V, { port: 0 });
    try {
      const client = { url: srv.url, token: domainToken(readHubConfig()!.secret, "general") };
      expect((await fetch(`${srv.url}/health`)).status).toBe(200);
      await fetch(`${srv.url}/locks/sync`, { method: "POST", headers: { authorization: `Bearer ${client.token}` }, body: JSON.stringify({ holder: tabHolder(), held: [{ domain: "ledger", pane: "w1:p1" }] }) });
      expect(await routeDelivery("ledger", { client, paneIdle: () => true })).toEqual({ to: "tab", pane: "w1:p1" });
      expect(await routeDelivery("ledger", { client, paneIdle: () => false })).toEqual({ to: "wait", holder: tabHolder() });
      expect(await routeDelivery("orchard", { client })).toEqual({ to: "headless" });
      expect(await routeDelivery("ledger", { client: null })).toEqual({ to: "headless" });
    } finally {
      srv.stop();
    }
  });
});
