// Website sources: index a canonical site through its machine-readable surface.
//
// Point Prevail at a site (fru.dev) and this module discovers what the site
// publishes for machines, never scraping its pages or touching its database:
//
//   robots.txt     obeyed first; a Disallow for our agent (or *) wins
//   /api/health    the site's own freshness report (lastUpdated, nextRunAt);
//                  it decides WHEN we come back, and an unchanged lastUpdated
//                  means the data has not moved, so nothing else is fetched
//   /llms.txt      title, summary and sections become context; any linked
//                  <host>/llms.txt on the same base domain is a child site
//                  (fru.dev links its 47 trackers this way)
//   /llms-full.txt the table: a "Fields: a | b | c" header plus one "- " line
//                  per row. Every row becomes one searchable item, cited by
//                  the row's own page URL
//   /openapi.json  read endpoints are counted; when a site has no
//                  llms-full.txt, its parameterless GET list endpoints are
//                  read instead and each array item becomes a row
//   /sitemap.xml   counted for the surface summary, never crawled
//
// Every fetch is conditional (ETag / Last-Modified), honors Cache-Control
// max-age, waits out robots Crawl-delay, and identifies itself as PrevailBot.
// Pure over an injectable fetcher so the whole flow is unit-tested offline.

export const USER_AGENT = "PrevailBot/1.0 (+https://prevail.sh; personal context indexer)";
const ROBOTS_AGENT = "prevailbot";

// One searchable item. Shared shape with local sources (sources.ts).
export interface SourceDoc {
  t: string;   // title
  l?: string;  // location label shown in a citation (a file path); websites derive it from u
  u?: string;  // link to open (URL or absolute file path)
  g?: string;  // group: domain, tracker, folder
  x: string;   // text
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type Fetcher = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>;

export const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, {
    headers: init.headers,
    redirect: "follow",
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  return res as unknown as FetchResponse;
};

interface UrlState {
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
  maxAge?: number;     // seconds, from Cache-Control
  status: number;
  docs: SourceDoc[];
  meta?: Record<string, unknown>;
}

export interface SiteSurface {
  robots: boolean;
  llms: boolean;
  llmsFull: boolean;
  openapi: number | null;   // GET endpoints in the spec
  sitemap: number | null;   // URLs listed
  health: boolean;
}

export interface SiteHealth {
  ok?: boolean;
  lastUpdated?: string;
  nextRunAt?: string;
}

export interface SiteState {
  origin: string;
  name: string;
  summary: string;
  fields: string | null;     // llms-full column header, e.g. "date | company | round"
  surface: SiteSurface;
  health: SiteHealth | null;
  rows: number;
  lastChecked: string;
  nextDue: string;
  error?: string;
  urls: Record<string, UrlState>;
}

// Bump when parsing changes, so cached tables are re-read in the new shape
// (a 304 would otherwise keep serving the old parse).
export const WEB_PARSER_VERSION = 4;

export interface WebState {
  v?: number;
  root: string;              // root origin
  children: string[];        // child origins discovered from the root llms.txt
  sites: Record<string, SiteState>;
}

export interface WebRefreshOptions {
  name: string;
  force?: boolean;
  now?: Date;
  fetcher?: Fetcher;
  maxChildren?: number;
  concurrency?: number;
  // Politeness gap between two requests to the same host (ms) when robots.txt
  // sets no Crawl-delay. Tests pass 0.
  gapMs?: number;
  onProgress?: (msg: string) => void;
}

const MAX_BODY = 12 * 1024 * 1024;
const MAX_ROWS_PER_SITE = 25_000;
const MAX_API_ROWS = 2_000;
const HOUR = 3_600_000;

// ── URL helpers ─────────────────────────────────────────────────────────

/** Normalize what the user typed ("fru.dev", "https://fru.dev/x") to an origin. */
export function normalizeSiteUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function baseDomain(host: string): string {
  const parts = host.toLowerCase().split(".");
  return parts.slice(-2).join(".");
}

/** Child sites a root llms.txt links to: any <host>/llms.txt on the same base domain. */
export function discoverChildren(llmsText: string, rootOrigin: string, max = 100): string[] {
  const rootHost = new URL(rootOrigin).hostname.toLowerCase();
  const base = baseDomain(rootHost);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/([a-z0-9.-]+)\/llms\.txt/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(llmsText))) {
    const host = m[1]!.toLowerCase();
    if (host === rootHost || seen.has(host)) continue;
    if (host !== base && !host.endsWith(`.${base}`)) continue;
    seen.add(host);
    out.push(`https://${host}`);
    if (out.length >= max) break;
  }
  return out;
}

// ── robots.txt ──────────────────────────────────────────────────────────

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
  sitemaps: string[];
}

/** Parse robots.txt and keep the rules for our agent, else for *. */
export function parseRobots(text: string): RobotsRules {
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow") cur.allow.push(val);
    else if (key === "disallow") cur.disallow.push(val);
    else if (key === "crawl-delay") { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.delay = n; }
  }
  const mine = groups.find((g) => g.agents.some((a) => { const tok = a.replace(/\/.*$/, ""); return tok.length >= 4 && ROBOTS_AGENT.includes(tok); }))
    ?? groups.find((g) => g.agents.includes("*"));
  return {
    allow: mine?.allow.filter(Boolean) ?? [],
    disallow: mine?.disallow.filter(Boolean) ?? [],
    crawlDelay: mine?.delay ?? null,
    sitemaps,
  };
}

function ruleMatches(rule: string, path: string): number {
  // Longest-match semantics with * and $ support. Returns the match length or -1.
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(`^${body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path) ? body.length : -1;
}

export function robotsAllows(rules: RobotsRules | null, path: string): boolean {
  if (!rules) return true;
  let best = -1;
  let allowed = true;
  for (const r of rules.disallow) { const n = ruleMatches(r, path); if (n > best) { best = n; allowed = false; } }
  for (const r of rules.allow) { const n = ruleMatches(r, path); if (n >= best && n >= 0) { best = n; allowed = true; } }
  return allowed;
}

// ── llms.txt / llms-full.txt ────────────────────────────────────────────

export interface LlmsDoc {
  title: string;
  summary: string;
  intro: string;
  sections: { heading: string; body: string }[];
}

export function parseLlmsTxt(text: string): LlmsDoc {
  const lines = text.split(/\r?\n/);
  let title = "";
  const summary: string[] = [];
  const intro: string[] = [];
  const sections: { heading: string; body: string }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^#{2,6}\s+(.+)/);
    if (h1 && !title && !line.startsWith("##")) { title = h1[1]!.trim(); continue; }
    if (h2) {
      if (cur) sections.push({ heading: cur.heading, body: cur.lines.join("\n").trim() });
      cur = { heading: h2[1]!.trim(), lines: [] };
      continue;
    }
    if (cur) { cur.lines.push(line); continue; }
    if (line.startsWith(">")) summary.push(line.replace(/^>\s?/, ""));
    else if (line.trim()) intro.push(line);
  }
  if (cur) sections.push({ heading: cur.heading, body: cur.lines.join("\n").trim() });
  return { title, summary: summary.join(" ").trim(), intro: intro.join("\n").trim(), sections };
}

function chunkPlain(text: string, max = 1400): string[] {
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n(?=\s*[-*]\s|\s*\n)/)) {
    const p = para.trim();
    if (!p) continue;
    if (buf && buf.length + p.length + 1 > max) { out.push(buf); buf = ""; }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
      continue;
    }
    buf = buf ? `${buf}\n${p}` : p;
  }
  if (buf) out.push(buf);
  return out;
}

export function llmsDocs(doc: LlmsDoc, site: { name: string; origin: string }, url: string): SourceDoc[] {
  const out: SourceDoc[] = [];
  const head = [doc.title, doc.summary, doc.intro].filter(Boolean).join("\n\n");
  if (head) for (const x of chunkPlain(head)) out.push({ t: "About", u: site.origin, g: site.name, x });
  for (const s of doc.sections) {
    for (const x of chunkPlain(s.body)) out.push({ t: s.heading, u: url, g: site.name, x });
  }
  return out;
}

/** "Labs: AI, data and research labs" -> "Labs". The short name every citation uses. */
export function shortSiteName(title: string, fallback: string): string {
  const t = title.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").split(/:\s|\s[|\u2013\u2014-]\s/)[0]!.trim();
  return t && t.length <= 40 ? t : fallback;
}

function stripLinks(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

export interface LlmsFullTable {
  fields: string | null;
  rows: SourceDoc[];
  text: SourceDoc[];
}

/**
 * The column header a table declares, in any of the shapes the trackers use:
 * "> ... Fields: a | b | c." / "# a | b | c" / "## Section (a | b | c)" /
 * "> One line per company: a | b | c. More prose".
 */
export function fieldsFrom(line: string): string | null {
  const body = line.replace(/^[#>\s]+/, "").trim();
  const paren = body.match(/\(([^()]*\s\|\s[^()]*\s\|\s[^()]*)\)/);
  if (paren) return paren[1]!.trim();
  const tail = body.match(/(?:^|:\s)([^:]*?\s\|\s[^:]*?\s\|\s[^:.]*?)(?:\.\s|\.?\s*$)/);
  return tail ? tail[1]!.trim() : null;
}

/** A table row: a "- " bullet, a markdown table row, or a plain line of 3+ pipe-separated cells. */
function rowBody(line: string): string | null {
  if (/^[-*]\s+/.test(line)) return line.replace(/^[-*]\s+/, "");
  if (/^\|?\s*:?-{3,}/.test(line)) return null; // markdown table separator
  const pipes = line.split(/\s\|\s/).length - 1;
  if (pipes >= 2) return line.replace(/^\|\s*/, "").replace(/\s*\|$/, "");
  return null;
}

/** llms-full.txt as a table: one row per line, cited by the row's own page. */
export function parseLlmsFull(text: string, site: { name: string; origin: string }, url: string, maxRows = MAX_ROWS_PER_SITE): LlmsFullTable {
  const host = new URL(site.origin).host;
  let fields: string | null = null;
  const rows: SourceDoc[] = [];
  const prose: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith(">")) {
      if (!fields) fields = fieldsFrom(line);
      if (line.startsWith(">")) prose.push(line.replace(/^>\s?/, ""));
      continue;
    }
    const body = rowBody(line);
    if (body !== null) {
      if (rows.length >= maxRows) continue;
      const urls = body.match(/https?:\/\/[^\s|)]+/g) ?? [];
      const own = [...urls].reverse().find((u) => { try { return new URL(u).host === host; } catch { return false; } });
      const cells = stripLinks(body).split("|").map((c) => c.trim()).filter((c) => c && !/^https?:\/\//.test(c));
      // Drop URLs and a dangling "label:" they leave behind ("Its own llms.txt:").
      const title = (cells.slice(0, 3).join(", ") || stripLinks(body)).replace(/\s*\(?https?:\/\/\S+\)?/g, "").replace(/[.,;]?\s+[^.:,]{1,30}:\s*$/, "").slice(0, 140);
      rows.push({ t: title, u: own ?? url, g: site.name, x: body });
      continue;
    }
    prose.push(line);
  }
  const textDocs = prose.length
    ? chunkPlain(prose.join("\n")).map((x) => ({ t: "Overview", u: url, g: site.name, x }))
    : [];
  return { fields, rows, text: textDocs };
}

// ── OpenAPI + JSON APIs ─────────────────────────────────────────────────

export interface OpenApiSummary {
  getEndpoints: number;
  listEndpoints: { path: string; limitParam: string | null; limitMax: number | null }[];
}

export function summarizeOpenApi(spec: unknown): OpenApiSummary {
  const out: OpenApiSummary = { getEndpoints: 0, listEndpoints: [] };
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> })?.paths;
  if (!paths || typeof paths !== "object") return out;
  for (const [path, ops] of Object.entries(paths)) {
    const get = ops?.get as { parameters?: { name?: string; in?: string; required?: boolean; schema?: { maximum?: number } }[] } | undefined;
    if (!get) continue;
    out.getEndpoints++;
    if (path.includes("{")) continue;
    if (/health|feed|search|admin|stream|export/i.test(path)) continue;
    const params = Array.isArray(get.parameters) ? get.parameters : [];
    if (params.some((p) => p?.required)) continue;
    const limit = params.find((p) => p?.in === "query" && /^(limit|per_page|pageSize|size)$/i.test(p?.name ?? ""));
    out.listEndpoints.push({ path, limitParam: limit?.name ?? null, limitMax: typeof limit?.schema?.maximum === "number" ? limit.schema.maximum : null });
  }
  return out;
}

function scalarLine(obj: Record<string, unknown>, max = 600): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) { if (v.length) parts.push(`${k}: ${v.slice(0, 8).join(", ")}`); }
  }
  const s = parts.join("; ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The first array of objects in an API response (the table). */
export function apiRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (body && typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) return v as Record<string, unknown>[];
    }
  }
  return [];
}

export function apiRowDocs(rows: Record<string, unknown>[], site: { name: string; origin: string }, url: string, path: string): SourceDoc[] {
  return rows.slice(0, MAX_API_ROWS).filter((r) => scalarLine(r).length > 0).map((r) => {
    const name = ["title", "name", "company", "headline", "label", "id"].map((k) => r[k]).find((v) => typeof v === "string" && v) as string | undefined;
    const link = ["url", "link", "sourceUrl", "href"].map((k) => r[k]).find((v) => typeof v === "string" && /^https?:\/\//.test(v as string)) as string | undefined;
    return { t: name ?? path, u: link ?? url, g: site.name, x: scalarLine(r) };
  });
}

export function countSitemap(xml: string): number {
  const idx = xml.match(/<sitemap>/gi)?.length ?? 0;
  if (idx) return idx;
  return xml.match(/<loc>/gi)?.length ?? 0;
}

// ── Cadence ─────────────────────────────────────────────────────────────

function parseTime(s: unknown): number | null {
  if (typeof s !== "string" || !s.trim()) return null;
  // "2026-09-26 05:37:52" (no zone) is UTC on these sites.
  const iso = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function parseHealth(body: unknown): SiteHealth | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const lastRun = (b.lastRun && typeof b.lastRun === "object") ? (b.lastRun as Record<string, unknown>) : null;
  const lastUpdated = [b.lastUpdated, b.last_updated, b.updatedAt, b.updated_at, lastRun?.at].find((v) => parseTime(v) !== null);
  const nextRunAt = [b.nextRunAt, b.next_run_at, b.nextRun, b.next_update].find((v) => parseTime(v) !== null);
  return {
    ok: typeof b.ok === "boolean" ? b.ok : undefined,
    lastUpdated: typeof lastUpdated === "string" ? new Date(parseTime(lastUpdated)!).toISOString() : undefined,
    nextRunAt: typeof nextRunAt === "string" ? new Date(parseTime(nextRunAt)!).toISOString() : undefined,
  };
}

/**
 * When to look at a site again, following the site's own cadence: shortly
 * after its next scheduled run when it reports one, else a day after its last
 * update, else daily. Never sooner than an hour, never later than a week.
 */
export function nextDueFor(health: SiteHealth | null, now: number): number {
  let due = now + 24 * HOUR;
  const next = parseTime(health?.nextRunAt);
  const last = parseTime(health?.lastUpdated);
  if (next !== null && next > now) due = next + 15 * 60_000;
  else if (last !== null) due = last + 24 * HOUR > now ? last + 24 * HOUR + 15 * 60_000 : now + 6 * HOUR;
  return Math.min(Math.max(due, now + HOUR), now + 7 * 24 * HOUR);
}

function maxAgeOf(cc: string | null): number | undefined {
  if (!cc) return undefined;
  if (/no-store|no-cache/i.test(cc)) return 0;
  const m = cc.match(/max-age=(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

// ── Fetch with validators ───────────────────────────────────────────────

interface Ctx {
  fetcher: Fetcher;
  now: number;
  gapMs: number;
  lastHit: Map<string, number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function politeGet(ctx: Ctx, url: string, prev: UrlState | undefined, delayMs: number): Promise<{ state: UrlState; changed: boolean; body: string | null }> {
  // Fresh per Cache-Control: reuse without asking.
  if (prev && prev.status === 200 && prev.maxAge && Date.parse(prev.fetchedAt) + prev.maxAge * 1000 > ctx.now) {
    return { state: prev, changed: false, body: null };
  }
  const host = new URL(url).host;
  const wait = (ctx.lastHit.get(host) ?? 0) + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  ctx.lastHit.set(host, Date.now());
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "text/plain, application/json, text/markdown, application/xml;q=0.9, */*;q=0.5" };
  if (prev?.status === 200 && prev.etag) headers["if-none-match"] = prev.etag;
  if (prev?.status === 200 && prev.lastModified) headers["if-modified-since"] = prev.lastModified;
  const fetchedAt = new Date(ctx.now).toISOString();
  try {
    const res = await ctx.fetcher(url, { headers });
    const maxAge = maxAgeOf(res.headers.get("cache-control"));
    if (res.status === 304 && prev) return { state: { ...prev, fetchedAt, maxAge: maxAge ?? prev.maxAge }, changed: false, body: null };
    if (res.status !== 200) {
      if (res.status >= 500 && prev) return { state: { ...prev, fetchedAt }, changed: false, body: null };
      return { state: { status: res.status, fetchedAt, docs: [] }, changed: prev?.status === 200, body: null };
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_BODY) return { state: { status: 413, fetchedAt, docs: [] }, changed: true, body: null };
    const body = await res.text();
    if (body.length > MAX_BODY) return { state: { status: 413, fetchedAt, docs: [] }, changed: true, body: null };
    return {
      state: { status: 200, fetchedAt, maxAge, etag: res.headers.get("etag") ?? undefined, lastModified: res.headers.get("last-modified") ?? undefined, docs: [] },
      changed: true,
      body,
    };
  } catch (e) {
    if (prev) return { state: { ...prev, fetchedAt }, changed: false, body: null };
    return { state: { status: 0, fetchedAt, docs: [], meta: { error: e instanceof Error ? e.message : String(e) } }, changed: false, body: null };
  }
}

function jsonOrNull(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ── One site ────────────────────────────────────────────────────────────

async function refreshSite(ctx: Ctx, origin: string, prev: SiteState | undefined, force: boolean, isRoot = false): Promise<{ site: SiteState; llmsText: string | null }> {
  const now = ctx.now;
  const urls: Record<string, UrlState> = { ...(prev?.urls ?? {}) };
  const host = new URL(origin).host;
  const site: SiteState = prev
    ? { ...prev, urls, surface: { ...prev.surface }, error: undefined }
    : { origin, name: host, summary: "", fields: null, surface: { robots: false, llms: false, llmsFull: false, openapi: null, sitemap: null, health: false }, health: null, rows: 0, lastChecked: "", nextDue: "", urls };

  // robots.txt first. A missing robots.txt allows everything.
  const robotsUrl = `${origin}/robots.txt`;
  const r = await politeGet(ctx, robotsUrl, urls[robotsUrl], 0);
  urls[robotsUrl] = r.state;
  if (r.body !== null) urls[robotsUrl] = { ...r.state, meta: { text: r.body.slice(0, 20_000) } };
  const robotsText = typeof urls[robotsUrl]?.meta?.text === "string" && urls[robotsUrl]!.status === 200 ? (urls[robotsUrl]!.meta!.text as string) : "";
  const rules = robotsText ? parseRobots(robotsText) : null;
  site.surface.robots = !!robotsText;
  const delayMs = Math.min(10_000, rules?.crawlDelay != null ? rules.crawlDelay * 1000 : ctx.gapMs);
  const allowed = (path: string) => robotsAllows(rules, path);

  if (!allowed("/llms.txt") && !allowed("/")) {
    site.error = "robots.txt does not allow indexing";
    site.rows = 0;
    for (const k of Object.keys(urls)) if (k !== robotsUrl) urls[k] = { ...urls[k]!, docs: [] };
    site.lastChecked = new Date(now).toISOString();
    site.nextDue = new Date(now + 7 * 24 * HOUR).toISOString();
    return { site, llmsText: null };
  }

  // Health decides whether anything moved. Unchanged lastUpdated + not forced
  // = keep every cached table and come back on the site's schedule.
  let health: SiteHealth | null = site.health;
  if (allowed("/api/health")) {
    const hUrl = `${origin}/api/health`;
    const h = await politeGet(ctx, hUrl, undefined, delayMs);
    if (h.body !== null) health = parseHealth(jsonOrNull(h.body));
    site.surface.health = !!health;
  }
  const unchanged = !force && prev && prev.rows + Object.values(prev.urls).reduce((n, u) => n + u.docs.length, 0) > 0
    && health?.lastUpdated && prev.health?.lastUpdated === health.lastUpdated;
  site.health = health;
  if (unchanged) {
    site.lastChecked = new Date(now).toISOString();
    site.nextDue = new Date(nextDueFor(health, now)).toISOString();
    return { site, llmsText: typeof urls[`${origin}/llms.txt`]?.meta?.text === "string" ? (urls[`${origin}/llms.txt`]!.meta!.text as string) : null };
  }

  // llms.txt: summary, sections, and (for a root) the child sites.
  let llmsText: string | null = null;
  const llmsUrl = `${origin}/llms.txt`;
  if (allowed("/llms.txt")) {
    const l = await politeGet(ctx, llmsUrl, urls[llmsUrl], delayMs);
    if (l.body !== null) {
      const parsed = parseLlmsTxt(l.body);
      if (parsed.title) site.name = shortSiteName(parsed.title, host);
      site.summary = parsed.summary;
      // Only the root keeps its raw llms.txt: it is where child sites come from.
      urls[llmsUrl] = { ...l.state, docs: llmsDocs(parsed, site, llmsUrl), ...(isRoot ? { meta: { text: l.body.slice(0, 400_000) } } : {}) };
    } else urls[llmsUrl] = l.state.status === 200 ? { ...(urls[llmsUrl] ?? l.state), ...l.state } : l.state;
    llmsText = typeof urls[llmsUrl]?.meta?.text === "string" && urls[llmsUrl]!.status === 200 ? (urls[llmsUrl]!.meta!.text as string) : null;
  }
  site.surface.llms = urls[llmsUrl]?.status === 200;

  // llms-full.txt: the table.
  const fullUrl = `${origin}/llms-full.txt`;
  if (allowed("/llms-full.txt")) {
    const f = await politeGet(ctx, fullUrl, urls[fullUrl], delayMs);
    if (f.body !== null) {
      const table = parseLlmsFull(f.body, site, fullUrl);
      urls[fullUrl] = { ...f.state, docs: [...table.text, ...table.rows], meta: { fields: table.fields, rows: table.rows.length } };
    } else urls[fullUrl] = f.state.status === 200 ? { ...(urls[fullUrl] ?? f.state), ...f.state } : f.state;
  }
  site.surface.llmsFull = urls[fullUrl]?.status === 200;
  site.fields = (urls[fullUrl]?.meta?.fields as string | null | undefined) ?? null;
  const fullRows = site.surface.llmsFull ? Number(urls[fullUrl]?.meta?.rows ?? 0) : 0;

  // OpenAPI: count the read surface; read list endpoints only when there is
  // no llms-full table to lean on.
  const specUrl = `${origin}/openapi.json`;
  let apiRowCount = 0;
  if (allowed("/openapi.json")) {
    const s = await politeGet(ctx, specUrl, urls[specUrl], delayMs);
    if (s.body !== null) {
      const sum = summarizeOpenApi(jsonOrNull(s.body));
      urls[specUrl] = { ...s.state, meta: { getEndpoints: sum.getEndpoints, list: sum.listEndpoints } };
    } else urls[specUrl] = s.state.status === 200 ? { ...(urls[specUrl] ?? s.state), ...s.state } : s.state;
    const ok = urls[specUrl]?.status === 200;
    site.surface.openapi = ok ? Number(urls[specUrl]?.meta?.getEndpoints ?? 0) : null;
    const list = ok && Array.isArray(urls[specUrl]?.meta?.list) ? (urls[specUrl]!.meta!.list as OpenApiSummary["listEndpoints"]) : [];
    if (fullRows === 0) {
      for (const ep of list.slice(0, 3)) {
        if (!allowed(ep.path)) continue;
        const q = ep.limitParam ? `?${ep.limitParam}=${Math.min(ep.limitMax ?? 500, 500)}` : "";
        const apiUrl = `${origin}${ep.path}${q}`;
        const a = await politeGet(ctx, apiUrl, urls[apiUrl], delayMs);
        if (a.body !== null) urls[apiUrl] = { ...a.state, docs: apiRowDocs(apiRows(jsonOrNull(a.body)), site, apiUrl, ep.path) };
        else urls[apiUrl] = a.state.status === 200 ? { ...(urls[apiUrl] ?? a.state), ...a.state } : a.state;
        apiRowCount += urls[apiUrl]?.docs.length ?? 0;
      }
    }
  }

  // Sitemap: counted, never crawled.
  const smUrl = rules?.sitemaps.find((u) => { try { return new URL(u).host === host; } catch { return false; } }) ?? `${origin}/sitemap.xml`;
  if (allowed(new URL(smUrl).pathname)) {
    const sm = await politeGet(ctx, smUrl, urls[smUrl], delayMs);
    if (sm.body !== null) urls[smUrl] = { ...sm.state, meta: { count: countSitemap(sm.body) } };
    else urls[smUrl] = sm.state.status === 200 ? { ...(urls[smUrl] ?? sm.state), ...sm.state } : sm.state;
    site.surface.sitemap = urls[smUrl]?.status === 200 ? Number(urls[smUrl]?.meta?.count ?? 0) : null;
  }

  // Drop docs of URLs this pass no longer reaches (a removed API endpoint).
  site.rows = fullRows + apiRowCount;
  site.lastChecked = new Date(now).toISOString();
  site.nextDue = new Date(nextDueFor(health, now)).toISOString();
  if (!site.surface.llms && !site.surface.llmsFull && site.surface.openapi === null) {
    site.error = "No llms.txt, llms-full.txt or OpenAPI spec found";
  }
  return { site, llmsText };
}

// ── The whole website source ────────────────────────────────────────────

/**
 * Refresh a website source: the root site, then every child site it links
 * (in small parallel batches, one request at a time per host). Sites that
 * are not due keep their cached tables untouched unless `force` is set.
 */
export async function refreshWebsite(rootUrl: string, prev: WebState | null, opts: WebRefreshOptions): Promise<WebState> {
  const root = normalizeSiteUrl(rootUrl);
  if (!root) throw new Error(`not a website address: ${rootUrl}`);
  const now = (opts.now ?? new Date()).getTime();
  const ctx: Ctx = { fetcher: opts.fetcher ?? defaultFetcher, now, gapMs: opts.gapMs ?? 250, lastHit: new Map() };
  const force = !!opts.force;
  const sameRoot = prev && prev.root === root && prev.v === WEB_PARSER_VERSION ? prev : null;
  const sites: Record<string, SiteState> = { ...(sameRoot?.sites ?? {}) };
  const due = (o: string) => force || !sites[o] || Date.parse(sites[o]!.nextDue || "0") <= now;

  let children = sameRoot?.children ?? [];
  if (due(root)) {
    opts.onProgress?.(`Reading ${new URL(root).host}`);
    const { site, llmsText } = await refreshSite(ctx, root, sites[root], force, true);
    sites[root] = site;
    if (llmsText) children = discoverChildren(llmsText, root, opts.maxChildren ?? 100);
  }
  // Forget children the root no longer links.
  for (const k of Object.keys(sites)) if (k !== root && !children.includes(k)) delete sites[k];

  const queue = children.filter(due);
  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, queue.length));
  let i = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (i < queue.length) {
      const origin = queue[i++]!;
      opts.onProgress?.(`Reading ${new URL(origin).host}`);
      try {
        const { site } = await refreshSite(ctx, origin, sites[origin], force);
        sites[origin] = site;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const nextDue = new Date(now + 6 * HOUR).toISOString();
        const prevSite = sites[origin];
        sites[origin] = prevSite
          ? { ...prevSite, error, nextDue }
          : { origin, name: new URL(origin).host, summary: "", fields: null, surface: { robots: false, llms: false, llmsFull: false, openapi: null, sitemap: null, health: false }, health: null, rows: 0, lastChecked: new Date(now).toISOString(), nextDue, error, urls: {} };
      }
    }
  }));
  return { v: WEB_PARSER_VERSION, root, children, sites };
}

/** Every searchable item in a website state, root first. */
export function webDocs(state: WebState): SourceDoc[] {
  const out: SourceDoc[] = [];
  const order = [state.root, ...state.children];
  for (const o of order) {
    const s = state.sites[o];
    if (!s) continue;
    for (const u of Object.values(s.urls)) for (const d of u.docs) out.push(d);
  }
  return out;
}

export interface WebSummary {
  sites: number;
  childSites: number;
  rows: number;
  items: number;
  llms: number;
  llmsFull: number;
  openapi: number;
  nextDue: string | null;
  lastUpdated: string | null;
  errors: { origin: string; error: string }[];
  list: { origin: string; name: string; rows: number; lastUpdated: string | null; nextDue: string; surface: SiteSurface; error?: string }[];
}

export function summarizeWeb(state: WebState): WebSummary {
  const list = [state.root, ...state.children].map((o) => state.sites[o]).filter((s): s is SiteState => !!s);
  const dues = list.map((s) => Date.parse(s.nextDue)).filter(Number.isFinite);
  const updated = list.map((s) => Date.parse(s.health?.lastUpdated ?? "")).filter(Number.isFinite);
  return {
    sites: list.length,
    childSites: state.children.length,
    rows: list.reduce((n, s) => n + s.rows, 0),
    items: webDocs(state).length,
    llms: list.filter((s) => s.surface.llms).length,
    llmsFull: list.filter((s) => s.surface.llmsFull).length,
    openapi: list.filter((s) => s.surface.openapi !== null).length,
    nextDue: dues.length ? new Date(Math.min(...dues)).toISOString() : null,
    lastUpdated: updated.length ? new Date(Math.max(...updated)).toISOString() : null,
    errors: list.filter((s) => s.error).map((s) => ({ origin: s.origin, error: s.error! })),
    list: list.map((s) => ({ origin: s.origin, name: s.name, rows: s.rows, lastUpdated: s.health?.lastUpdated ?? null, nextDue: s.nextDue, surface: s.surface, ...(s.error ? { error: s.error } : {}) })),
  };
}

/** Column header for a site's rows, so a citation can explain its cells once. */
export function fieldsFor(state: WebState, group: string): string | null {
  for (const s of Object.values(state.sites)) if (s.name === group) return s.fields;
  return null;
}
