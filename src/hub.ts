// The hub server (agent-mesh plan, Step 4).
//
// Prevail MCP served over HTTP from the hub (the Mac mini, reached over
// Tailscale), one scoped endpoint per domain: POST /domains/<domain>. A
// session's token is derived from the hub's secret and its domain, so a
// tax token opens only /domains/tax and gets tax's permissions
// (mcp-scope.ts); General, the chief of staff's home, sees everything.
//
// The hub also holds the domain LOCKS: an open tab holds its domain (renewed
// by `prevail spaces tidy` on the hub), a stale lock expires, and work for a
// held domain goes to the tab instead of running headless.
//
// Secrets stay machine-local: the hub's secret in ~/.prevail/hub.json, a
// client's token in ~/.prevail/hub-client.json, both 0600, never the vault.
// Every tool call runs through the same dispatcher, act gate, egress guard
// and approval queue as stdio; nothing here widens what a call may do.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { configDir } from "./config.ts";
import { writeSecretFile } from "./secret-file.ts";
import { CHIEF_SCOPE, validScope } from "./mcp-scope.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { realHerdr } from "./spaces.ts";

export const DEFAULT_PORT = 7421;
const MAX_BODY = 1_000_000;
const DEFAULT_TTL_MS = 10 * 60_000;

export interface HubConfig { secret: string; host: string; port: number }

export const hubConfigPath = () => join(configDir(), "hub.json");
export const hubClientPath = () => join(configDir(), "hub-client.json");
const locksPath = () => join(configDir(), "hub-locks.json");

export function readHubConfig(): HubConfig | null {
  try {
    const c = JSON.parse(readFileSync(hubConfigPath(), "utf8")) as Partial<HubConfig>;
    if (typeof c.secret !== "string" || c.secret.length < 32) return null;
    return { secret: c.secret, host: c.host || "127.0.0.1", port: Number(c.port) || DEFAULT_PORT };
  } catch { return null; }
}

/** Create the hub's secret once; later calls only change host and port. */
export function initHub(opts: { host?: string; port?: number } = {}): HubConfig {
  const cur = readHubConfig();
  const host = opts.host ?? cur?.host ?? "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "") throw new Error("bind the hub to localhost or the Tailscale address, never every interface");
  const c: HubConfig = { secret: cur?.secret ?? randomBytes(32).toString("hex"), host, port: opts.port ?? cur?.port ?? DEFAULT_PORT };
  writeSecretFile(hubConfigPath(), `${JSON.stringify(c, null, 2)}\n`);
  return c;
}

export function domainToken(secret: string, domain: string): string {
  return `prevail-hub-${createHmac("sha256", secret).update(`domain:${domain}`).digest("hex").slice(0, 48)}`;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";

/** The domain a request's token speaks for, checked against the asked one (General may speak for any). */
export function authorize(secret: string, token: string, domain: string): boolean {
  if (!token) return false;
  return sameToken(token, domainToken(secret, domain)) || sameToken(token, domainToken(secret, CHIEF_SCOPE));
}

// ── Locks ────────────────────────────────────────────────────────────────

export interface DomainLock { domain: string; holder: string; pane?: string; expires: number }

/** One writer for lock state: the hub process. Persisted so a restart keeps them. */
export class LockStore {
  private locks = new Map<string, DomainLock>();
  constructor(private file: string | null = locksPath()) {
    if (file && existsSync(file)) {
      try { for (const l of JSON.parse(readFileSync(file, "utf8")) as DomainLock[]) this.locks.set(l.domain, l); } catch { /* start empty */ }
    }
  }
  private save() { if (this.file) writeSecretFile(this.file, JSON.stringify([...this.locks.values()])); }
  list(now = Date.now()): DomainLock[] {
    let pruned = false;
    for (const [d, l] of this.locks) if (l.expires <= now) { this.locks.delete(d); pruned = true; }
    if (pruned) this.save();
    return [...this.locks.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  }
  get(domain: string, now = Date.now()): DomainLock | null { return this.list(now).find((l) => l.domain === domain) ?? null; }
  /** Take or renew. Another live holder keeps it; a stale one has expired. */
  acquire(domain: string, holder: string, opts: { pane?: string; ttlMs?: number; now?: number } = {}): { ok: boolean; lock: DomainLock } {
    const now = opts.now ?? Date.now();
    const cur = this.get(domain, now);
    if (cur && cur.holder !== holder) return { ok: false, lock: cur };
    const lock: DomainLock = { domain, holder, ...(opts.pane ? { pane: opts.pane } : {}), expires: now + (opts.ttlMs ?? DEFAULT_TTL_MS) };
    this.locks.set(domain, lock);
    this.save();
    return { ok: true, lock };
  }
  release(domain: string, holder: string): boolean {
    const cur = this.locks.get(domain);
    if (!cur || cur.holder !== holder) return false;
    this.locks.delete(domain);
    this.save();
    return true;
  }
  /** A holder's whole set at once: take these, drop the rest it held. */
  sync(holder: string, held: { domain: string; pane?: string }[], opts: { ttlMs?: number; now?: number } = {}): { held: string[]; refused: DomainLock[] } {
    const want = new Set(held.map((h) => h.domain));
    for (const l of this.list(opts.now)) if (l.holder === holder && !want.has(l.domain)) this.release(l.domain, holder);
    const ok: string[] = [];
    const refused: DomainLock[] = [];
    for (const h of held) {
      const r = this.acquire(h.domain, holder, { pane: h.pane, ...opts });
      if (r.ok) ok.push(h.domain); else refused.push(r.lock);
    }
    return { held: ok, refused };
  }
}

// ── Server ───────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readBody(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new Error("body too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("body too large");
  return JSON.parse(text);
}

export interface HubDeps { vault: string; secret: string; locks: LockStore }

/** The whole request handler, separate from Bun.serve so tests call it directly. */
export function hubHandler(deps: HubDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/health" && req.method === "GET") return json({ ok: true });
    const token = bearer(req);

    const dm = /^\/domains\/([a-z0-9][a-z0-9-]{0,63})$/.exec(path);
    if (dm) {
      const domain = dm[1]!;
      if (domain !== CHIEF_SCOPE && !validScope(deps.vault, domain)) return json({ error: "no such domain" }, 404);
      // A token opens its own endpoint only (General's opens General's).
      if (!token || !sameToken(token, domainToken(deps.secret, domain))) return json({ error: "unauthorized" }, 401);
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      let body: unknown;
      try { body = await readBody(req); } catch (e) { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: (e as Error).message } }, 400); }
      const { dispatch, mcpTools } = await import("./mcp-server.ts");
      const tools = mcpTools();
      const one = async (r: unknown) => {
        const rq = r as { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
        if (!rq || typeof rq.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
        try {
          const result = await dispatch(rq, tools, deps.vault, domain);
          return rq.id === undefined || rq.id === null ? null : { jsonrpc: "2.0", id: rq.id, result };
        } catch (e) {
          return { jsonrpc: "2.0", id: rq.id ?? null, error: { code: -32000, message: (e as Error).message ?? "tool error" } };
        }
      };
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map(one))).filter(Boolean);
        return out.length ? json(out) : new Response(null, { status: 202 });
      }
      const out = await one(body);
      return out ? json(out) : new Response(null, { status: 202 });
    }

    if (path === "/locks" && req.method === "GET") {
      // Who holds what is shared among the owner's own agents; any valid token reads it.
      const ok = !!token && (authorize(deps.secret, token, CHIEF_SCOPE) || listDomainDirs(deps.vault).some((d) => sameToken(token, domainToken(deps.secret, d))));
      return ok ? json({ locks: deps.locks.list() }) : json({ error: "unauthorized" }, 401);
    }
    const lm = /^\/locks\/(acquire|release|sync)$/.exec(path);
    if (lm && req.method === "POST") {
      let b: Record<string, unknown>;
      try { b = (await readBody(req)) as Record<string, unknown>; } catch { return json({ error: "bad body" }, 400); }
      const holder = typeof b.holder === "string" && b.holder.length <= 200 ? b.holder : "";
      if (!holder) return json({ error: "holder is required" }, 400);
      const ttlMs = Math.min(Math.max(Number(b.ttlMs) || DEFAULT_TTL_MS, 30_000), 60 * 60_000);
      if (lm[1] === "sync") {
        const held = Array.isArray(b.held) ? (b.held as { domain?: unknown; pane?: unknown }[]).filter((h) => typeof h.domain === "string").map((h) => ({ domain: String(h.domain), pane: typeof h.pane === "string" ? h.pane : undefined })) : [];
        // Holding many domains at once is the hub's own tidy: General only.
        if (!authorize(deps.secret, token, CHIEF_SCOPE)) return json({ error: "unauthorized" }, 401);
        if (held.some((h) => !validScope(deps.vault, h.domain))) return json({ error: "no such domain" }, 404);
        return json(deps.locks.sync(holder, held, { ttlMs }));
      }
      const domain = typeof b.domain === "string" ? b.domain : "";
      if (!validScope(deps.vault, domain)) return json({ error: "no such domain" }, 404);
      if (!authorize(deps.secret, token, domain)) return json({ error: "unauthorized" }, 401);
      if (lm[1] === "acquire") {
        const r = deps.locks.acquire(domain, holder, { pane: typeof b.pane === "string" ? b.pane : undefined, ttlMs });
        return json(r, r.ok ? 200 : 409);
      }
      return json({ ok: deps.locks.release(domain, holder) });
    }
    return json({ error: "not found" }, 404);
  };
}

export function serveHub(vault: string, opts: { host?: string; port?: number } = {}): { url: string; stop: () => void } {
  const cfg = readHubConfig();
  if (!cfg) throw new Error("no hub secret on this machine: run prevail hub init first");
  const host = opts.host ?? cfg.host;
  if (host === "0.0.0.0" || host === "::") throw new Error("bind the hub to localhost or the Tailscale address, never every interface");
  const server = Bun.serve({ hostname: host, port: opts.port ?? cfg.port, fetch: hubHandler({ vault, secret: cfg.secret, locks: new LockStore() }) });
  return { url: `http://${host}:${server.port}`, stop: () => server.stop(true) };
}

// ── Client ───────────────────────────────────────────────────────────────

export interface HubClient { url: string; token: string }

/** How this machine reaches the hub: the hub itself (its own secret), or a saved client config. */
export function hubClient(): HubClient | null {
  const env = process.env;
  if (env.PREVAIL_HUB_URL && env.PREVAIL_HUB_TOKEN) return { url: env.PREVAIL_HUB_URL, token: env.PREVAIL_HUB_TOKEN };
  const own = readHubConfig();
  if (own) return { url: `http://${own.host}:${own.port}`, token: domainToken(own.secret, CHIEF_SCOPE) };
  try {
    const c = JSON.parse(readFileSync(hubClientPath(), "utf8")) as Partial<HubClient>;
    if (c.url && c.token) return { url: c.url, token: c.token };
  } catch { /* none */ }
  return null;
}

async function call(c: HubClient, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${c.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export const tabHolder = () => `tabs@${hostname().toLowerCase()}`;

/** For `spaces tidy`: hold the open tabs' domains on the hub, drop the closed ones. */
export function hubPresence(client = hubClient()): ((held: { domain: string; pane: string }[]) => Promise<void>) | null {
  if (!client) return null;
  return async (held) => {
    const r = await call(client, "/locks/sync", { holder: tabHolder(), held });
    if (r.status !== 200) throw new Error(`hub refused the tab locks (${r.status})`);
  };
}

export async function hubLocks(client = hubClient()): Promise<DomainLock[]> {
  if (!client) return [];
  const r = await call(client, "/locks");
  return r.status === 200 ? ((r.body as { locks: DomainLock[] }).locks ?? []) : [];
}

/**
 * Where work for a domain goes: the live tab that holds it (only when its
 * agent is idle), else headless. Asked of the hub, so two machines never run
 * one domain twice.
 */
export async function routeDelivery(domain: string, opts: { client?: HubClient | null; paneIdle?: (pane: string) => boolean } = {}): Promise<{ to: "tab"; pane: string } | { to: "headless" } | { to: "wait"; holder: string }> {
  const client = opts.client === undefined ? hubClient() : opts.client;
  if (!client) return { to: "headless" };
  let lock: DomainLock | undefined;
  try { lock = (await hubLocks(client)).find((l) => l.domain === domain); } catch { return { to: "headless" }; }
  if (!lock) return { to: "headless" };
  if (lock.holder === tabHolder() && lock.pane) {
    const idle = opts.paneIdle ?? ((p: string) => paneIdle(p));
    return idle(lock.pane) ? { to: "tab", pane: lock.pane } : { to: "wait", holder: lock.holder };
  }
  return { to: "wait", holder: lock.holder };
}

function paneIdle(pane: string): boolean {
  try {
    const p = (realHerdr(["pane", "get", pane]) as { pane?: { agent?: string; agent_status?: string } })?.pane;
    return !!p?.agent && (p.agent_status === "idle" || p.agent_status === "done");
  } catch { return false; }
}

// ── CLI: prevail hub init|serve|token|client|status|locks ──────────────────

export async function hubCommand(args: string[], vault: string): Promise<number> {
  const { parseModArgs } = await import("./cli-args.ts");
  const a = parseModArgs(args);
  const sub = a.pos[0] ?? "status";
  try {
    if (sub === "init") {
      const c = initHub({ host: a.get("host"), port: a.get("port") ? Number(a.get("port")) : undefined });
      console.log(`hub ready: http://${c.host}:${c.port} (secret in ${hubConfigPath()}, mode 0600)`);
      return 0;
    }
    if (sub === "serve") {
      const s = serveHub(vault, { host: a.get("host"), port: a.get("port") ? Number(a.get("port")) : undefined });
      console.error(`[prevail-hub] serving ${s.url}/domains/<domain> for ${vault}`);
      await new Promise(() => { /* until killed */ });
      return 0;
    }
    if (sub === "token") {
      const cfg = readHubConfig();
      const d = a.pos[1] ?? "";
      if (!cfg) { console.error("no hub secret here: run prevail hub init on the hub"); return 1; }
      if (d !== CHIEF_SCOPE && !validScope(vault, d)) { console.error(`no domain "${d}"`); return 1; }
      process.stdout.write(`${domainToken(cfg.secret, d)}\n`);
      return 0;
    }
    if (sub === "client") {
      // The token comes on stdin so it never sits in shell history.
      const url = a.get("url") ?? "";
      if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(url)) { console.error("usage: prevail hub token general | prevail hub client --url http://<hub>:7421   (token on stdin)"); return 1; }
      const token = (await new Response(Bun.stdin.stream()).text()).trim();
      if (!/^prevail-hub-[0-9a-f]{48}$/.test(token)) { console.error("expected a prevail-hub- token on stdin"); return 1; }
      writeSecretFile(hubClientPath(), `${JSON.stringify({ url, token })}\n`);
      console.log(`saved ${hubClientPath()} (mode 0600)`);
      return 0;
    }
    if (sub === "status" || sub === "locks") {
      const c = hubClient();
      if (!c) { console.log("no hub configured on this machine"); return 1; }
      const h = await fetch(`${c.url}/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok).catch(() => false);
      const locks = h ? await hubLocks(c) : [];
      if (a.json) console.log(JSON.stringify({ url: c.url, up: h, locks }, null, 2));
      else console.log([`${c.url} ${h ? "up" : "DOWN"}`, ...locks.map((l) => `  ${l.domain.padEnd(14)} ${l.holder}${l.pane ? ` ${l.pane}` : ""} until ${new Date(l.expires).toISOString()}`)].join("\n"));
      return h ? 0 : 1;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.error("usage: prevail hub init [--host H] [--port P] | serve | token <domain> | client --url U | status | locks");
  return 1;
}
