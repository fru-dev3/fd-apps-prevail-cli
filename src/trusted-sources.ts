// Trusted sources: the user's own data sites, added as apps that feed the
// agent READ-ONLY. A trusted source is an ordinary app folder (data/apps/<id>/)
// with one of three integration kinds:
//   mcp-remote  a remote MCP endpoint (streamable HTTP). Its tools are listed
//               at add time and attached to Claude turns that reference it.
//   web         a site with llms.txt and/or openapi.json. Their summary goes in
//               the APP CONTEXT block; the model may GET only that host.
//   links       a list of URLs the model may GET.
//
// Files:
//   <vault>/data/apps/<id>/manifest.json   {id, name, integration, urls, trusted,
//                                          domains, tools?, probe, source?}
//   <vault>/build/_meta/apps/trusted.json  the allowlist the act gate trusts:
//                                          per id its kind, urls, hosts and read
//                                          tools. It lives under _meta, which the
//                                          model can never write, so editing a
//                                          manifest cannot widen what runs live.
//
// Never stores credentials: URLs with a user:password part or a key/token
// query parameter are refused.

import { existsSync, mkdirSync, readdirSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  appDir,
  buildTool,
  classifyTool,
  localDate,
  metaAppsDir,
  slugify,
  type MirrorApp,
  type MirrorTool,
} from "./apps-mirror.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { appsContainer } from "./path-safety.ts";
import { vreadFile, vwriteFileAtomic } from "./vault-session.ts";

export type SourceKind = "mcp-remote" | "web" | "links";
export const SOURCE_KINDS: readonly SourceKind[] = ["mcp-remote", "web", "links"];
export const isSourceKind = (k: unknown): k is SourceKind => SOURCE_KINDS.includes(k as SourceKind);

export interface SourceEndpoint { path: string; summary?: string }
export interface SourceSummary { title?: string; llms?: string; endpoints?: SourceEndpoint[] }

export interface ProbeResult {
  ok: boolean;
  checked_at: number;
  error?: string;
  // mcp-remote
  server?: { name?: string; version?: string; protocol?: string };
  tools?: { name: string; kind: string; read_only_hint: boolean }[];
  // web
  llms_txt?: boolean;
  openapi?: boolean;
  // links (and web roots)
  urls?: { url: string; status: number | null; ok: boolean }[];
}

export interface RegistryEntry {
  integration: SourceKind;
  urls: string[];
  hosts: string[];
  read_tools: string[];
  updated_at: number;
}

const PROBE_TIMEOUT = 10_000;
const LLMS_CAP = 1500;
const ENDPOINT_CAP = 40;
const SUMMARY_CAP = 120;
const MAX_URLS = 10;

const clip = (s: string, cap: number) => (s.length <= cap ? s : `${s.slice(0, cap - 1)}…`);

// ── URL validation ───────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SECRET_PARAM = /(key|token|secret|password|passwd|auth|signature|sig|session|credential)/i;

/** A normalized URL, or an error. https only (http for localhost), and never
 *  one that carries a credential. */
export function validateSourceUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { error: `not a URL: ${clip(raw, 80)}` }; }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { error: `${u.origin || raw}: only https URLs are allowed (http only for localhost)` };
  }
  if (u.username || u.password) return { error: `${u.host}: the URL carries a user name or password; trusted sources never store credentials` };
  for (const k of u.searchParams.keys()) {
    if (SECRET_PARAM.test(k)) return { error: `${u.host}: the URL carries a "${k}" parameter; trusted sources never store credentials` };
  }
  u.hash = "";
  return { url: u.href };
}

// ── Probes ───────────────────────────────────────────────────────────────────

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One JSON-RPC result from a streamable-HTTP MCP response (JSON or SSE). */
async function rpcResult(res: Response, id: number): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
  const text = await res.text();
  const msgs: unknown[] = [];
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { msgs.push(JSON.parse(line.slice(5))); } catch { /* skip */ }
    }
  } else {
    const o = JSON.parse(text) as unknown;
    msgs.push(...(Array.isArray(o) ? o : [o]));
  }
  const m = msgs.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === id) as { result?: Record<string, unknown>; error?: { message?: string } } | undefined;
  if (!m) throw new Error("no JSON-RPC reply");
  if (m.error) throw new Error(`MCP error: ${clip(String(m.error.message ?? "unknown"), 160)}`);
  return m.result ?? {};
}

/** A remote tool's read classification: readOnlyHint true is a read unless
 *  the name says it sends or moves money. */
export function remoteToolKind(name: string, readOnlyHint: boolean): MirrorTool["kind"] {
  const byName = classifyTool(name).kind;
  if (byName === "send" || byName === "money") return byName;
  return readOnlyHint ? "read" : byName;
}

/** initialize, then tools/list, within one timeout. */
export async function probeMcp(url: string, opts: { fetch?: Fetch; timeoutMs?: number; now?: number } = {}): Promise<ProbeResult> {
  const f = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT);
  const checked_at = opts.now ?? Date.now();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = (body: unknown) => f(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  try {
    const initRes = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prevail", version: "1" } },
    });
    const sid = initRes.headers.get("mcp-session-id");
    const init = await rpcResult(initRes, 1);
    const protocol = typeof init.protocolVersion === "string" ? init.protocolVersion : undefined;
    if (sid) headers["mcp-session-id"] = sid;
    if (protocol) headers["mcp-protocol-version"] = protocol;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((r) => r.body?.cancel()).catch(() => {});
    const tools: NonNullable<ProbeResult["tools"]> = [];
    let cursor: string | undefined;
    for (let page = 0, id = 2; page < 5; page++, id++) {
      const r = await rpcResult(await post({ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} }), id);
      for (const t of Array.isArray(r.tools) ? r.tools : []) {
        const o = t as { name?: unknown; annotations?: { readOnlyHint?: unknown } };
        if (typeof o.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(o.name)) continue;
        const hint = o.annotations?.readOnlyHint === true;
        tools.push({ name: o.name, kind: remoteToolKind(o.name, hint), read_only_hint: hint });
      }
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    const info = (init.serverInfo ?? {}) as { name?: unknown; version?: unknown };
    return {
      ok: true, checked_at, tools,
      server: { ...(typeof info.name === "string" ? { name: clip(info.name, 80) } : {}), ...(typeof info.version === "string" ? { version: clip(info.version, 40) } : {}), ...(protocol ? { protocol } : {}) },
    };
  } catch (e) {
    const err = e as Error;
    return { ok: false, checked_at, error: err.name === "TimeoutError" || err.name === "AbortError" ? "no answer within 10 s" : clip(err.message, 200) };
  }
}

async function getText(f: Fetch, url: string, signal: AbortSignal): Promise<{ status: number | null; text?: string; type?: string }> {
  try {
    const r = await f(url, { method: "GET", headers: { accept: "*/*" }, signal, redirect: "follow" });
    const text = r.ok ? (await r.text()).slice(0, 200_000) : undefined;
    if (!r.ok) await r.body?.cancel().catch(() => {});
    return { status: r.status, text, type: r.headers.get("content-type") ?? "" };
  } catch { return { status: null }; }
}

/** The GET paths of an OpenAPI document, with their summaries. */
export function openapiEndpoints(doc: unknown): { title?: string; endpoints: SourceEndpoint[] } {
  const o = (doc ?? {}) as { info?: { title?: unknown }; paths?: Record<string, Record<string, { summary?: unknown; description?: unknown }>> };
  const endpoints: SourceEndpoint[] = [];
  for (const [path, ops] of Object.entries(o.paths ?? {})) {
    const get = ops?.get;
    if (!get) continue;
    const s = typeof get.summary === "string" ? get.summary : typeof get.description === "string" ? get.description : "";
    endpoints.push({ path: clip(path, 200), ...(s.trim() ? { summary: clip(s.trim().replace(/\s+/g, " "), SUMMARY_CAP) } : {}) });
    if (endpoints.length >= ENDPOINT_CAP) break;
  }
  return { ...(typeof o.info?.title === "string" ? { title: clip(o.info.title, 120) } : {}), endpoints };
}

/** Fetch /llms.txt and /openapi.json of each site (when present). */
export async function probeWeb(urls: string[], opts: { fetch?: Fetch; timeoutMs?: number; now?: number } = {}): Promise<{ probe: ProbeResult; source: SourceSummary }> {
  const f = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT);
  const source: SourceSummary = {};
  const probe: ProbeResult = { ok: false, checked_at: opts.now ?? Date.now(), llms_txt: false, openapi: false, urls: [] };
  const llmsParts: string[] = [];
  const endpoints: SourceEndpoint[] = [];
  for (const origin of [...new Set(urls.map((u) => new URL(u).origin))]) {
    const [llms, api] = await Promise.all([getText(f, `${origin}/llms.txt`, signal), getText(f, `${origin}/openapi.json`, signal)]);
    if (llms.text && !/text\/html/i.test(llms.type ?? "")) {
      probe.llms_txt = true;
      const t = llms.text.trim();
      source.title ??= t.match(/^#\s+(.+)$/m)?.[1]?.trim();
      llmsParts.push(t);
    }
    if (api.text) {
      try {
        const e = openapiEndpoints(JSON.parse(api.text));
        probe.openapi = true;
        source.title ??= e.title;
        endpoints.push(...e.endpoints.map((x) => (urls.length > 1 ? { ...x, path: `${origin}${x.path}` } : x)));
      } catch { /* not JSON: no spec */ }
    }
    let status = llms.status;
    if (!llms.text && !api.text) status = (await getText(f, origin, signal)).status;
    probe.urls!.push({ url: origin, status, ok: !!(llms.text || api.text) || (status !== null && status < 400) });
  }
  if (llmsParts.length) source.llms = clip(llmsParts.join("\n\n"), LLMS_CAP);
  if (endpoints.length) source.endpoints = endpoints.slice(0, ENDPOINT_CAP);
  if (source.title) source.title = clip(source.title, 120);
  probe.ok = probe.urls!.some((u) => u.ok);
  if (!probe.ok) probe.error = "the site did not answer";
  return { probe, source };
}

/** Each link answers a GET. */
export async function probeLinks(urls: string[], opts: { fetch?: Fetch; timeoutMs?: number; now?: number } = {}): Promise<ProbeResult> {
  const f = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT);
  const rows = await Promise.all(urls.map(async (url) => {
    const r = await getText(f, url, signal);
    return { url, status: r.status, ok: r.status !== null && r.status < 400 };
  }));
  const ok = rows.some((r) => r.ok);
  return { ok, checked_at: opts.now ?? Date.now(), urls: rows, ...(ok ? {} : { error: "no link answered" }) };
}

// ── The trusted registry (build/_meta/apps/trusted.json) ─────────────────────

export function registryPath(vault: string): string {
  return join(metaAppsDir(vault), "trusted.json");
}

export function readRegistry(vault: string): Record<string, RegistryEntry> {
  try {
    const p = registryPath(vault);
    if (!existsSync(p)) return {};
    const o = JSON.parse(vreadFile(p)) as Record<string, RegistryEntry>;
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function updateRegistry(vault: string, fn: (r: Record<string, RegistryEntry>) => void): void {
  const p = registryPath(vault);
  mkdirSync(join(p, ".."), { recursive: true });
  const lock = tryAcquireLock(`${p}.lock`);
  try {
    const r = readRegistry(vault);
    fn(r);
    vwriteFileAtomic(p, `${JSON.stringify(r, null, 2)}\n`);
  } finally { lock?.release(); }
}

const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

/** Every host a trusted web or links source allows GETs to. */
export function trustedFetchHosts(vault: string): Set<string> {
  const out = new Set<string>();
  for (const e of Object.values(readRegistry(vault))) {
    if (e.integration === "web" || e.integration === "links") for (const h of e.hosts ?? []) out.add(h);
  }
  return out;
}

/** mcp__<id>__<tool> is a read tool of a trusted mcp-remote source. */
export function isTrustedReadTool(vault: string, toolName: string): boolean {
  const m = /^mcp__([a-z0-9][a-z0-9-]*)__(.+)$/.exec(toolName);
  if (!m) return false;
  const e = readRegistry(vault)[m[1]!];
  return e?.integration === "mcp-remote" && Array.isArray(e.read_tools) && e.read_tools.includes(m[2]!);
}

/** A GET to a trusted host (WebFetch input), for the act gate. */
export function isTrustedFetch(vault: string, toolInput: unknown): boolean {
  const url = toolInput && typeof toolInput === "object" ? (toolInput as { url?: unknown }).url : undefined;
  if (typeof url !== "string") return false;
  const v = validateSourceUrl(url);
  if ("error" in v) return false;
  return trustedFetchHosts(vault).has(hostOf(v.url));
}

// ── Trusted sources as apps ──────────────────────────────────────────────────

function readManifest(vault: string, id: string): Record<string, unknown> | null {
  try {
    const p = join(appDir(vault, id), "manifest.json");
    if (!existsSync(p)) return null;
    const o = JSON.parse(vreadFile(p)) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch { return null; }
}

/** One registered trusted source as a mirror app. Tools and hosts come from
 *  the registry; the name, domains and summary from the manifest. */
function toApp(vault: string, id: string, e: RegistryEntry): MirrorApp {
  const man = readManifest(vault, id) ?? {};
  const probe = (man.probe ?? {}) as Partial<ProbeResult>;
  const name = typeof man.name === "string" && man.name.trim() ? man.name.trim() : id;
  const toolNames = Array.isArray(man.tools) ? (man.tools as { name?: unknown }[]).map((t) => t?.name).filter((n): n is string => typeof n === "string") : [];
  const tools: MirrorTool[] = toolNames.map((n) => {
    const t = buildTool(`mcp__${id}__${n}`, n);
    // The registry's read list is authoritative; anything else never reads as a read.
    const kind: MirrorTool["kind"] = e.read_tools.includes(n) ? "read" : t.kind === "read" ? "write" : t.kind;
    return { ...t, kind, sync_allowed: kind === "read", chat_default: kind === "read" || kind === "write" };
  });
  const app: MirrorApp = {
    id, name, runtime: "claude", server: id,
    ...(e.integration === "mcp-remote" ? { url: e.urls[0], transport: "remote" as const } : {}),
    status: probe.ok ? "connected" : "error",
    ...(probe.ok ? {} : { status_detail: typeof probe.error === "string" ? probe.error : "not checked yet" }),
    signin_hint: "",
    syncable: false,
    domains: Array.isArray(man.domains) ? (man.domains as unknown[]).filter((d): d is string => typeof d === "string") : [],
    trusted: true,
    trusted_here: true,
    integration: e.integration,
    urls: e.urls,
    ...(e.integration === "mcp-remote" ? { tools, ...(typeof probe.checked_at === "number" ? { tools_checked_at: probe.checked_at } : {}) } : {}),
    ...(man.source && typeof man.source === "object" ? { source: man.source as SourceSummary } : {}),
    recipe: null,
  };
  return app;
}

/** A trusted-source folder as its manifest describes it, and whether THIS
 *  Mac's registry trusts it. Folders sync between Macs; the registry under
 *  build/_meta does not, so a source added on another Mac shows up here as
 *  trusted: true, trusted_here: false. Read-only: never trusts anything. */
export interface SourceInfo {
  integration: SourceKind;
  urls: string[];
  name: string;
  trusted: true;
  trusted_here: boolean;
}

function manifestUrls(man: Record<string, unknown>): string[] {
  const raw = Array.isArray(man.urls) ? man.urls : [];
  // Only URLs that pass the add-time checks, so a hand-edited manifest never
  // echoes a credential into a listing.
  return raw.filter((u): u is string => typeof u === "string" && "url" in validateSourceUrl(u)).slice(0, MAX_URLS);
}

export function sourceInfo(vault: string, id: string, reg: Record<string, RegistryEntry> = readRegistry(vault)): SourceInfo | null {
  const man = readManifest(vault, id);
  const e = reg[id];
  const here = !!e && isSourceKind(e.integration);
  if (!here && !(man?.trusted === true && isSourceKind(man.integration))) return null;
  const name = typeof man?.name === "string" && man.name.trim() ? man.name.trim() : id;
  return here
    ? { integration: e!.integration, urls: e!.urls, name, trusted: true, trusted_here: true }
    : { integration: man!.integration as SourceKind, urls: manifestUrls(man!), name, trusted: true, trusted_here: false };
}

/** A source folder that synced in from another Mac but is not in this Mac's
 *  registry: listed for the user to see, with no tools and nothing attached. */
function untrustedHereApp(vault: string, id: string, info: SourceInfo): MirrorApp {
  const man = readManifest(vault, id) ?? {};
  return {
    id, name: info.name, runtime: "claude", server: id,
    status: "untrusted_here",
    status_detail: "added on another Mac; not trusted on this one (run apps add-source here to trust it)",
    signin_hint: "",
    syncable: false,
    domains: Array.isArray(man.domains) ? (man.domains as unknown[]).filter((d): d is string => typeof d === "string") : [],
    trusted: true,
    trusted_here: false,
    integration: info.integration,
    urls: info.urls,
    recipe: null,
  };
}

/** Every registered trusted source whose folder still exists, plus source
 *  folders trusted on another Mac (status untrusted_here). */
export function trustedSourceApps(vault: string): MirrorApp[] {
  const out: MirrorApp[] = [];
  const reg = readRegistry(vault);
  for (const [id, e] of Object.entries(reg)) {
    try {
      if (!isSourceKind(e?.integration) || !existsSync(appDir(vault, id))) continue;
      out.push(toApp(vault, id, e));
    } catch { /* skip a bad entry */ }
  }
  let names: string[] = [];
  try { names = readdirSync(appsContainer(vault)); } catch { /* no apps yet */ }
  for (const id of names) {
    if (id.startsWith("_") || id.startsWith(".") || reg[id]) continue;
    try {
      const info = sourceInfo(vault, id, reg);
      if (info) out.push(untrustedHereApp(vault, id, info));
    } catch { /* skip a bad folder */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Runtime apps plus trusted sources (a runtime connector keeps its id). */
export function withTrustedSources(vault: string, apps: MirrorApp[]): MirrorApp[] {
  const ids = new Set(apps.map((a) => a.id));
  return [...apps, ...trustedSourceApps(vault).filter((a) => !ids.has(a.id))];
}

// ── add-source / remove-source ───────────────────────────────────────────────

export interface AddSourceInput { kind: string; urls: string[]; name: string }
export interface AddSourceResult { app: MirrorApp; probe: ProbeResult; adopted: boolean }

export async function addSource(vault: string, input: AddSourceInput, deps: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {}): Promise<AddSourceResult> {
  const kind = input.kind;
  if (!isSourceKind(kind)) throw new Error(`--kind must be one of ${SOURCE_KINDS.join(", ")}`);
  const name = input.name.trim();
  if (!name) throw new Error("--name is required");
  const id = slugify(name);
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new Error(`"${name}" does not make a usable app id`);
  if (!input.urls.length) throw new Error("at least one --url is required");
  if (input.urls.length > MAX_URLS) throw new Error(`at most ${MAX_URLS} URLs`);
  const urls: string[] = [];
  for (const raw of input.urls) {
    const v = validateSourceUrl(raw);
    if ("error" in v) throw new Error(v.error);
    if (!urls.includes(v.url)) urls.push(v.url);
  }
  if (kind === "mcp-remote" && urls.length !== 1) throw new Error("an mcp-remote source takes exactly one --url");

  const dir = appDir(vault, id);
  const manPath = join(dir, "manifest.json");
  const cur = readManifest(vault, id);
  if (existsSync(manPath) && !cur) throw new Error(`data/apps/${id}/manifest.json is not valid JSON; fix or move it and retry`);
  // Adopt, never overwrite: a runtime connector or another kind of app keeps its folder.
  if (cur?.mirror) throw new Error(`"${id}" is already a connector mirrored from a runtime; pick another name`);
  if (cur && typeof cur.integration === "string" && cur.integration.trim() && cur.integration !== kind) {
    throw new Error(`"${id}" already exists as a ${cur.integration} app; pick another name`);
  }

  const now = deps.now?.() ?? Date.now();
  const opts = { fetch: deps.fetch, now, timeoutMs: deps.timeoutMs };
  let probe: ProbeResult;
  let source: SourceSummary | undefined;
  if (kind === "mcp-remote") probe = await probeMcp(urls[0]!, opts);
  else if (kind === "web") ({ probe, source } = await probeWeb(urls, opts));
  else probe = await probeLinks(urls, opts);

  // Only the machine-probed fields are refreshed; the user's own values stay.
  const next: Record<string, unknown> = { ...(cur ?? {}) };
  next.id = id;
  if (typeof next.name !== "string" || !next.name.trim()) next.name = name;
  if (typeof next.description !== "string") next.description = `${name}, a trusted source (${kind}), read-only.`;
  if (!Array.isArray(next.domains)) next.domains = [];
  next.integration = kind;
  next.urls = [...new Set([...(Array.isArray(cur?.urls) ? (cur!.urls as unknown[]).filter((u): u is string => typeof u === "string") : []), ...urls])];
  next.trusted = true;
  next.probe = probe;
  if (kind === "mcp-remote" && probe.ok) {
    next.tools = (probe.tools ?? []).map((t) => ({ ...buildTool(`mcp__${id}__${t.name}`, t.name), kind: t.kind, read_only_hint: t.read_only_hint }));
    next.tools_checked_at = now;
  }
  if (source) next.source = source;
  mkdirSync(dir, { recursive: true });
  vwriteFileAtomic(manPath, `${JSON.stringify(next, null, 2)}\n`);
  if (!existsSync(join(dir, "SKILL.md"))) {
    vwriteFileAtomic(join(dir, "SKILL.md"), `# ${name}\n\nA trusted source (${kind}): ${(next.urls as string[]).join(", ")}. Read-only.\n`);
  }

  const allUrls = next.urls as string[];
  const prevReads = readRegistry(vault)[id]?.read_tools ?? [];
  updateRegistry(vault, (r) => {
    r[id] = {
      integration: kind,
      urls: allUrls,
      hosts: [...new Set(allUrls.map(hostOf).filter(Boolean))],
      // A failed re-probe keeps the reads the last good one found.
      read_tools: kind === "mcp-remote" ? (probe.ok ? (probe.tools ?? []).filter((t) => t.kind === "read").map((t) => t.name) : prevReads) : [],
      updated_at: now,
    };
  });
  return { app: toApp(vault, id, readRegistry(vault)[id]!), probe, adopted: !!cur };
}

/** Archive a trusted source: the folder moves to data/apps/_archive/ (never
 *  deleted) and it leaves the trusted registry. */
export function removeSource(vault: string, id: string, now: number = Date.now()): { id: string; from: string; to: string } {
  const reg = readRegistry(vault);
  const dir = appDir(vault, id);
  const man = readManifest(vault, id);
  if (!reg[id] && !(man?.trusted === true && isSourceKind(man.integration))) throw new Error(`"${id}" is not a trusted source`);
  if (!existsSync(dir)) throw new Error(`data/apps/${id} does not exist`);
  const arch = join(appsContainer(vault), "_archive");
  mkdirSync(arch, { recursive: true });
  let to = join(arch, id);
  for (let n = 2; existsSync(to); n++) to = join(arch, `${id}-${n}`);
  renameSync(dir, to);
  const index = join(arch, "INDEX.md");
  try {
    if (!existsSync(index)) vwriteFileAtomic(index, "# Archived apps\n\nApp folders moved here by `prevail apps archive` or `apps remove-source`. Move one back to data/apps/ to restore it.\n\n");
    appendFileSync(index, `- ${localDate(now)} \`${id}\`${to.endsWith(`/${id}`) ? "" : ` (as ${to.split("/").pop()})`}: trusted source removed\n`);
  } catch { /* the index is best effort */ }
  updateRegistry(vault, (r) => { delete r[id]; });
  return { id, from: dir, to };
}

// ── Per-turn attachment ──────────────────────────────────────────────────────

/** The trusted sources a turn attaches: remote MCP servers (Claude config
 *  entries keyed by app id) and the hosts web/links sources may GET. */
export function turnSources(apps: MirrorApp[]): { remoteMcp: Record<string, string>; fetchHosts: string[] } {
  const remoteMcp: Record<string, string> = {};
  const hosts = new Set<string>();
  for (const a of apps) {
    if (!a.trusted || a.trusted_here === false) continue;
    if (a.integration === "mcp-remote" && a.urls?.[0]) remoteMcp[a.id] = a.urls[0];
    else if (a.integration === "web" || a.integration === "links") for (const u of a.urls ?? []) { const h = hostOf(u); if (h) hosts.add(h); }
  }
  return { remoteMcp, fetchHosts: [...hosts] };
}

/** The inline --mcp-config JSON for a turn's remote MCP sources, or null. */
export function remoteMcpConfig(remote: Record<string, string>): string | null {
  const ids = Object.keys(remote);
  if (!ids.length) return null;
  return JSON.stringify({ mcpServers: Object.fromEntries(ids.map((id) => [id, { type: "http", url: remote[id] }])) });
}

/** The APP CONTEXT lines that describe a trusted source. */
export function sourceBlockLines(app: MirrorApp): string[] {
  const hosts = [...new Set((app.urls ?? []).map(hostOf).filter(Boolean))];
  if (app.integration === "mcp-remote") {
    return [`A trusted source the user added: a remote MCP server at ${app.urls?.[0] ?? "?"}, read-only. Its tools are attached as mcp__${app.id}__<tool> on Claude turns.`];
  }
  const lines = [
    app.integration === "web"
      ? `A trusted source the user added: the site ${(app.urls ?? []).join(", ")}, read-only.`
      : `A trusted source the user added: these links, read-only: ${(app.urls ?? []).join(", ")}`,
    `You may fetch ONLY these hosts, and GET only: ${hosts.join(", ") || "none"}. Never send the user's data to them.`,
  ];
  const s = app.source;
  if (s?.title) lines.push(`Title: ${s.title}`);
  if (s?.endpoints?.length) {
    lines.push("", "## GET endpoints (openapi.json)");
    for (const e of s.endpoints) lines.push(`- GET ${e.path}${e.summary ? `: ${e.summary}` : ""}`);
  }
  if (s?.llms) lines.push("", "## llms.txt", s.llms);
  return lines;
}
