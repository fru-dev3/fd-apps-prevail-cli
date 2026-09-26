import { describe, expect, test } from "bun:test";

import {
  discoverChildren, nextDueFor, normalizeSiteUrl, parseHealth, parseLlmsFull, parseLlmsTxt,
  parseRobots, refreshWebsite, robotsAllows, shortSiteName, summarizeOpenApi, summarizeWeb, webDocs,
  USER_AGENT, type FetchResponse, type Fetcher,
} from "./sources-web";

// A tiny offline web: path -> { body, headers, status }. Records every request
// so tests can assert what was (and was not) fetched and with which validators.
function fakeWeb(pages: Record<string, { body?: string; status?: number; headers?: Record<string, string> }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const p = pages[url];
    const h = new Map(Object.entries(p?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const etag = h.get("etag");
    if (p && etag && init.headers["if-none-match"] === etag) {
      return { status: 304, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => "" } as FetchResponse;
    }
    return {
      status: p ? (p.status ?? 200) : 404,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
      text: async () => p?.body ?? "",
    } as FetchResponse;
  };
  return { fetcher, calls };
}

const ROOT_LLMS = `# fru.dev

> The home of Fru. Each tracker is context for agents.

## Directories

- [Funding](https://funding.fru.dev): Who raised money. Its own llms.txt: https://funding.fru.dev/llms.txt
- [Paydays](https://paydays.fru.dev): Pay schedule calendars.

## For agents

- [Paydays llms.txt](https://paydays.fru.dev/llms.txt): agents page
- [Prevail](https://prevail.sh): Its own llms.txt: https://prevail.sh/llms.txt
`;

const FUNDING_LLMS = `# Funding

> Who raised money in data and AI.

## About this data

Rounds from company announcements.
`;

const FUNDING_FULL = `# Funding: all funding rounds

> Every round, newest first. Fields: date | company | round | amount (USD) | lead investors | source | page.

Last refreshed: 2026-09-25T07:52:16Z.

- 2026-09-25 | Nscale | Growth | $3.4B | lead: undisclosed | https://news.example/nscale | https://funding.fru.dev/rounds/nscale-growth-2026-09
- 2026-05-28 | Anthropic | Series H | $65B | lead: Altimeter | https://www.anthropic.com/news/series-h | https://funding.fru.dev/rounds/anthropic-series-h-2026-05
`;

describe("url + discovery", () => {
  test("normalizes what the user types to an origin", () => {
    expect(normalizeSiteUrl("fru.dev")).toBe("https://fru.dev");
    expect(normalizeSiteUrl("https://fru.dev/agents?x=1")).toBe("https://fru.dev");
    expect(normalizeSiteUrl("localhost")).toBeNull();
    expect(normalizeSiteUrl("ftp://fru.dev")).toBeNull();
  });
  test("child sites are same-base-domain hosts that publish an llms.txt", () => {
    expect(discoverChildren(ROOT_LLMS, "https://fru.dev")).toEqual(["https://funding.fru.dev", "https://paydays.fru.dev"]);
  });
  test("short site names for citations", () => {
    expect(shortSiteName("Labs: AI, data and research labs", "labs.fru.dev")).toBe("Labs");
    expect(shortSiteName("Funding", "funding.fru.dev")).toBe("Funding");
  });
});

describe("robots.txt", () => {
  test("our agent's group wins over *, longest rule wins", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: PrevailBot\nAllow: /\nDisallow: /api/admin/\nCrawl-delay: 2\nSitemap: https://x.dev/s.xml");
    expect(robotsAllows(r, "/llms.txt")).toBe(true);
    expect(robotsAllows(r, "/api/admin/keys")).toBe(false);
    expect(r.crawlDelay).toBe(2);
    expect(r.sitemaps).toEqual(["https://x.dev/s.xml"]);
  });
  test("falls back to * and honors Disallow", () => {
    const r = parseRobots("User-agent: *\nAllow: /\nDisallow: /admin");
    expect(robotsAllows(r, "/admin/x")).toBe(false);
    expect(robotsAllows(r, "/llms-full.txt")).toBe(true);
  });
});

describe("parsing the machine surface", () => {
  test("llms.txt title, summary, sections", () => {
    const d = parseLlmsTxt(FUNDING_LLMS);
    expect(d.title).toBe("Funding");
    expect(d.summary).toContain("Who raised money");
    expect(d.sections.map((s) => s.heading)).toEqual(["About this data"]);
  });
  test("llms-full.txt is a table: one row per line, cited by its own page", () => {
    const t = parseLlmsFull(FUNDING_FULL, { name: "Funding", origin: "https://funding.fru.dev" }, "https://funding.fru.dev/llms-full.txt");
    expect(t.fields).toBe("date | company | round | amount (USD) | lead investors | source | page");
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]!.u).toBe("https://funding.fru.dev/rounds/anthropic-series-h-2026-05");
    expect(t.rows[1]!.t).toBe("2026-05-28, Anthropic, Series H");
    expect(t.rows[1]!.g).toBe("Funding");
  });
  test("openapi: counts GET endpoints, keeps parameterless list endpoints", () => {
    const sum = summarizeOpenApi({ paths: {
      "/api/rounds": { get: { parameters: [{ name: "limit", in: "query", schema: { maximum: 200 } }] } },
      "/api/rounds/{id}": { get: {} },
      "/api/search": { get: { parameters: [{ name: "q", in: "query", required: true }] } },
      "/api/health": { get: {} },
    } });
    expect(sum.getEndpoints).toBe(4);
    expect(sum.listEndpoints).toEqual([{ path: "/api/rounds", limitParam: "limit", limitMax: 200 }]);
  });
  test("health: reads lastUpdated / lastRun / nextRunAt in either time format", () => {
    expect(parseHealth({ ok: true, lastUpdated: "2026-09-26 05:37:52" })!.lastUpdated).toBe("2026-09-26T05:37:52.000Z");
    expect(parseHealth({ lastRun: { at: "2026-09-25T07:52:16Z" }, nextRunAt: "2026-09-28T07:45:00.000Z" })).toEqual({ ok: undefined, lastUpdated: "2026-09-25T07:52:16.000Z", nextRunAt: "2026-09-28T07:45:00.000Z" });
  });
});

describe("cadence follows each site's own schedule", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const H = 3_600_000;
  test("comes back just after the site's next scheduled run", () => {
    expect(nextDueFor({ nextRunAt: "2026-09-28T07:45:00Z" }, now)).toBe(Date.parse("2026-09-28T08:00:00Z"));
  });
  test("a day after the last update when no run is announced", () => {
    expect(nextDueFor({ lastUpdated: "2026-09-26T05:00:00Z" }, now)).toBe(Date.parse("2026-09-27T05:15:00Z"));
  });
  test("stale or unknown sites are checked every few hours, never hammered", () => {
    expect(nextDueFor({ lastUpdated: "2026-09-01T00:00:00Z" }, now)).toBe(now + 6 * H);
    expect(nextDueFor(null, now)).toBe(now + 24 * H);
    expect(nextDueFor({ nextRunAt: "2026-09-26T12:05:00Z" }, now)).toBe(now + H);
  });
});

describe("refreshWebsite", () => {
  const pages = {
    "https://fru.dev/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://fru.dev/sitemap.xml" },
    "https://fru.dev/llms.txt": { body: ROOT_LLMS, headers: { etag: '"root1"' } },
    "https://fru.dev/sitemap.xml": { body: "<urlset><url><loc>https://fru.dev/</loc></url><url><loc>https://fru.dev/card</loc></url></urlset>" },
    "https://funding.fru.dev/robots.txt": { body: "User-agent: *\nAllow: /\nDisallow: /admin" },
    "https://funding.fru.dev/api/health": { body: JSON.stringify({ ok: true, lastUpdated: "2026-09-25T07:52:16Z", nextRunAt: "2026-09-28T07:45:00.000Z" }) },
    "https://funding.fru.dev/llms.txt": { body: FUNDING_LLMS, headers: { etag: '"f1"' } },
    "https://funding.fru.dev/llms-full.txt": { body: FUNDING_FULL, headers: { etag: '"f2"' } },
    "https://funding.fru.dev/openapi.json": { body: JSON.stringify({ paths: { "/api/rounds": { get: {} } } }) },
    // Paydays forbids everything: it must be skipped, not read.
    "https://paydays.fru.dev/robots.txt": { body: "User-agent: *\nDisallow: /" },
    // Only used when a site has no llms-full.txt; must not be read here.
    "https://funding.fru.dev/api/rounds": { body: JSON.stringify({ rounds: [{ id: "x", company: "Should not be read" }] }) },
  };
  const now = new Date("2026-09-26T12:00:00Z");

  test("indexes the root and every linked tracker, obeying robots", async () => {
    const web = fakeWeb(pages);
    const st = await refreshWebsite("fru.dev", null, { name: "fru.dev", fetcher: web.fetcher, now, gapMs: 0 });
    expect(st.children).toEqual(["https://funding.fru.dev", "https://paydays.fru.dev"]);
    const sum = summarizeWeb(st);
    expect(sum.rows).toBe(2);
    expect(st.sites["https://funding.fru.dev"]!.name).toBe("Funding");
    expect(st.sites["https://funding.fru.dev"]!.surface).toMatchObject({ llms: true, llmsFull: true, openapi: 1, health: true });
    expect(st.sites["https://fru.dev"]!.surface.sitemap).toBe(2);
    expect(st.sites["https://paydays.fru.dev"]!.error).toBe("robots.txt does not allow indexing");
    expect(web.calls.some((c) => c.url.startsWith("https://paydays.fru.dev/") && !c.url.endsWith("/robots.txt"))).toBe(false);
    expect(web.calls.some((c) => c.url.includes("/api/rounds"))).toBe(false);
    expect(web.calls.every((c) => c.headers["user-agent"] === USER_AGENT)).toBe(true);
    // Due again just after the tracker's own next run (Monday 07:45 UTC).
    expect(st.sites["https://funding.fru.dev"]!.nextDue).toBe("2026-09-28T08:00:00.000Z");
    expect(webDocs(st).some((d) => d.u === "https://funding.fru.dev/rounds/anthropic-series-h-2026-05")).toBe(true);
  });

  test("a site that is not due is not fetched at all; unchanged health skips the tables", async () => {
    const first = fakeWeb(pages);
    const st = await refreshWebsite("fru.dev", null, { name: "fru.dev", fetcher: first.fetcher, now, gapMs: 0 });
    const again = fakeWeb(pages);
    const later = new Date("2026-09-26T18:00:00Z");
    await refreshWebsite("fru.dev", st, { name: "fru.dev", fetcher: again.fetcher, now: later, gapMs: 0 });
    expect(again.calls.some((c) => c.url.startsWith("https://funding.fru.dev"))).toBe(false);
    // Forced: health is unchanged, so only robots + health are asked for.
    const forced = fakeWeb(pages);
    const st2 = await refreshWebsite("fru.dev", st, { name: "fru.dev", fetcher: forced.fetcher, now: later, gapMs: 0, force: true });
    const fundingCalls = forced.calls.filter((c) => c.url.startsWith("https://funding.fru.dev")).map((c) => c.url);
    expect(fundingCalls).toContain("https://funding.fru.dev/llms-full.txt");
    expect(summarizeWeb(st2).rows).toBe(2);
  });

  test("conditional requests reuse the cached table on 304", async () => {
    const first = fakeWeb(pages);
    const st = await refreshWebsite("fru.dev", null, { name: "fru.dev", fetcher: first.fetcher, now, gapMs: 0 });
    // New run happened: health moved, so tables are revalidated with ETags.
    const moved = { ...pages, "https://funding.fru.dev/api/health": { body: JSON.stringify({ lastUpdated: "2026-09-28T07:50:00Z" }) } };
    const second = fakeWeb(moved);
    const st2 = await refreshWebsite("fru.dev", st, { name: "fru.dev", fetcher: second.fetcher, now: new Date("2026-09-28T09:00:00Z"), gapMs: 0 });
    const full = second.calls.find((c) => c.url === "https://funding.fru.dev/llms-full.txt");
    expect(full?.headers["if-none-match"]).toBe('"f2"');
    expect(summarizeWeb(st2).rows).toBe(2);
  });
});

describe("llms-full.txt table shapes the trackers use", () => {
  const site = { name: "T", origin: "https://t.fru.dev" };
  test("plain pipe lines with the header in a # line", () => {
    const t = parseLlmsFull("# Releases: every release\n# date | company | product | type | title | source\n2026-09-25 | PostHog | PostHog | update | v1 | https://github.com/x\n", site, "u");
    expect(t.fields).toBe("date | company | product | type | title | source");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.t).toBe("2026-09-25, PostHog, PostHog");
  });
  test("a section header in parentheses and a 'one line per' blockquote", () => {
    expect(parseLlmsFull("## Federal holidays (name | legal date | source)\nNew Year | 2026-01-01 | https://opm.gov\n", site, "u").fields).toBe("name | legal date | source");
    expect(parseLlmsFull("> One line per company, newest first: name | programs | page. From YC.\nRote | YC W27 | https://t.fru.dev/companies/rote\n", site, "u").rows[0]!.u).toBe("https://t.fru.dev/companies/rote");
  });
  test("markdown tables: rows kept, separator dropped; prose is not a row", () => {
    const t = parseLlmsFull("| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\nJust a sentence about the data.\n", site, "u");
    expect(t.rows.map((r) => r.x)).toEqual(["a | b | c", "1 | 2 | 3"]);
    expect(t.text[0]!.x).toContain("Just a sentence");
  });
});
