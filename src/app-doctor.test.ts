import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertRecord } from "./app-map.ts";
import {
  answerCard, archiveRecord, buildStack, classifyText, detectCards, doctorApps, foldHealth, offboardingDraft, probeAll, raiseUrgent, readAnswers,
  stackReviewMarkdown, vendorStatus, visibleCards, weeklyLine, writeStackReview, type Exec, type Probe, type Stack,
} from "./app-doctor.ts";
import { readInterruptions } from "./interruptions.ts";

const ROOT = join("/tmp", `prevail-doctor-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const ev = (src: string, rows: object[]) => { const d = join(V, "build", "_meta", "events", src); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "2026-09.mac-a.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-09-${String(from + i).padStart(2, "0")}`);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta", "apps"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general", "memory"), { recursive: true });
  // Two paid notes apps, one used daily, one barely; a paid one renewing soon with a price step; a free one unused 90 days.
  upsertRecord(V, { id: "foo-notes", name: "Foo Notes", kind: "app", category: "notes", identifiers: { domains: ["foonotes.example"] } });
  upsertRecord(V, { id: "bar-notes", name: "Bar Notes", kind: "app", category: "notes", identifiers: { domains: ["barnotes.example"] } });
  upsertRecord(V, { id: "baz-video", name: "Baz Video", kind: "app", category: "content", identifiers: { domains: ["bazvideo.example"] } });
  upsertRecord(V, { id: "qux-free", name: "Qux Free", kind: "app", category: "dev", identifiers: { domains: ["quxfree.example"] } });
  const set = (id: string, patch: object) => { const p = join(V, "data", "apps", id, "manifest.json"); writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch })); };
  set("foo-notes", { cost: { amount: 10, period: "month", source: "card statements" } });
  set("bar-notes", { cost: { amount: 8, period: "month", source: "card statements" } });
  set("baz-video", { cost: { amount: 288, period: "year", source: "card statements" }, renewal: { next: "2026-10-06", period: "yearly" }, price_history: [{ date: "2025-10-06", amount: 240 }, { date: "2026-10-06", amount: 288 }] });
  ev("web", [
    ...days(1, 30).map((d) => ({ ts: d, src: "web", kind: "web.visits", n: 3, project: "foonotes.example", host: "mac-a", tier: "measured", attrs: {} })),
    { ts: "2026-09-29", src: "web", kind: "web.visits", n: 1, project: "barnotes.example", host: "mac-a", tier: "measured", attrs: {} },
    { ts: "2026-07-20", src: "web", kind: "web.visits", n: 1, project: "bazvideo.example", host: "mac-a", tier: "measured", attrs: {} },
  ]);
  const jul = join(V, "build", "_meta", "events", "web", "2026-07.mac-a.jsonl");
  writeFileSync(jul, [
    ...["2026-07-03", "2026-07-20"].map((d) => JSON.stringify({ ts: d, src: "web", kind: "web.visits", n: 1, project: "bazvideo.example", host: "mac-a", tier: "measured", attrs: {} })),
    JSON.stringify({ ts: "2026-07-01", src: "web", kind: "web.visits", n: 1, project: "quxfree.example", host: "mac-a", tier: "measured", attrs: {} }),
  ].join("\n") + "\n");
}

describe("the doctor", () => {
  beforeEach(seed);
  test("classes from real failure text", () => {
    expect(classifyText("access_denied: Account Restricted").status).toBe("ineligible");
    expect(classifyText("disabled_client: The OAuth client was disabled.").status).toBe("ineligible");
    expect(classifyText("You are not logged into any GitHub hosts").status).toBe("auth_expired");
    expect(classifyText("HTTP 503 Service Unavailable").status).toBe("vendor_down");
  });
  test("probes: versions, sign-in, missing tools, adapter shapes, capture gaps, sources", async () => {
    upsertRecord(V, { id: "anthropic", name: "Anthropic" });
    upsertRecord(V, { id: "github", name: "GitHub" });
    writeFileSync(join(V, "build", "_meta", "apps", "adapters.mac-a.json"), JSON.stringify({ tools: { claude: { present: true, shape: "ok" }, codex: { present: true, shape: "unknown", note: "a new rollout shape" } } }));
    writeFileSync(join(V, "build", "_meta", "source-state.json"), JSON.stringify({ gmail: { state: "auth-failed", note: "the Google sign-in client Prevail uses is disabled (Google Cloud)" } }));
    ev("codex", [{ ts: "2026-09-29", src: "codex", kind: "ai.session", n: 2, host: "mac-a", tier: "measured", attrs: {} }]);
    const exec: Exec = (cmd, args) => (cmd.endsWith("/gh") && args[0] === "auth" ? { ok: false, out: "", err: "You are not logged into any GitHub hosts" } : { ok: true, out: `${cmd.split("/").pop()} 1.2.3\n`, err: "" });
    const which = (b: string) => (["claude", "gh"].includes(b) ? `/fake/${b}` : null);
    const ps = await probeAll(V, { exec, which, now: NOW, host: "mac-a", status: false });
    const one = (check: string) => ps.find((p) => p.check === check);
    expect(one("claude --version")).toMatchObject({ status: "ok", version: "1.2.3" });
    expect(one("gh auth status")!.status).toBe("auth_expired");
    expect(one("codex installed")!.status).toBe("missing");
    expect(one("codex records")!.status).toBe("unknown_shape");
    expect(one("codex prompt capture")!.status).toBe("capture_gap");
    expect(one("gmail sync")!.status).toBe("ineligible");
  });
  test("health keeps last_ok and first_fail, and names what changed", () => {
    const p = (status: Probe["status"], version?: string, detail = "x"): Probe => ({ app: "foo", check: "foo --version", status, detail, ...(version ? { version } : {}) });
    const a = foldHealth({}, [p("ok", "1.0")], NOW);
    expect(a.foo!.last_ok).toBeTruthy();
    const b = foldHealth(a, [p("ineligible", undefined, "no longer available for your plan")], NOW + 86_400_000);
    expect(b.foo!.first_fail).toBeTruthy();
    expect(b.foo!.last_ok).toBe(a.foo!.last_ok);
    expect(b.foo!.changed).toContain("no longer available");
    const c = foldHealth(b, [p("ineligible", undefined, "no longer available for your plan")], NOW + 2 * 86_400_000);
    expect(c.foo!.first_fail).toBe(b.foo!.first_fail);
    expect(c.foo!.changed).toBeUndefined();
    expect(foldHealth(a, [p("ok", "1.1")], NOW).foo!.changed).toContain("1.1");
  });
  test("vendor status pages; an unreadable page is not a vendor problem", async () => {
    const f = (ind: string) => (async () => ({ ok: true, json: async () => ({ status: { indicator: ind, description: ind } }) })) as unknown as typeof fetch;
    expect((await vendorStatus("https://status.example", f("none"))).status).toBe("ok");
    expect((await vendorStatus("https://status.example", f("minor"))).status).toBe("degraded");
    expect((await vendorStatus("https://status.example", f("major"))).status).toBe("vendor_down");
    expect((await vendorStatus("https://status.example", (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch)).status).toBe("ok");
  });
  test("doctorApps writes health per host", async () => {
    const rows = await doctorApps(V, { exec: () => ({ ok: true, out: "1.0", err: "" }), which: () => null, now: NOW, host: "mac-a", status: false });
    expect(typeof rows).toBe("object");
    expect(existsSync(join(V, "build", "_meta", "apps", "health.mac-a.json"))).toBe(true);
  });
});

describe("the stack and its cards", () => {
  beforeEach(seed);
  const stackNow = () => buildStack(V, { now: NOW });
  test("verdicts: unused paid, price up, kept", () => {
    const s = stackNow();
    const by = Object.fromEntries(s.apps.map((a) => [a.id, a]));
    expect(by["foo-notes"]!.verdict).toBe("keep");
    expect(by["foo-notes"]!.cost_per_active_day).toBe(0.33);
    expect(by["bar-notes"]!.verdict).toBe("cancel");
    expect(by["baz-video"]!.verdict).toBe("cancel");
    expect(by["baz-video"]!.price_up).toEqual({ from: 240, to: 288, date: "2026-10-06" });
    expect(s.month_total).toBe(42);
  });
  test("cards: unused, archive, renewal stage, price, duplicate; answers hide them", () => {
    const s = stackNow();
    const cards = detectCards(s, NOW);
    const kinds = cards.map((c) => `${c.kind}:${c.app}`).sort();
    expect(kinds).toContain("unused:bar-notes");
    expect(kinds).toContain("unused:baz-video");
    expect(kinds).toContain("archive:qux-free");
    expect(kinds).toContain("renewal:baz-video");
    expect(kinds).toContain("price:baz-video");
    expect(kinds).toContain("duplicate:bar-notes");
    expect(cards.find((c) => c.kind === "renewal")!.title).toContain("in 6 days");
    const unused = cards.find((c) => c.kind === "unused" && c.app === "bar-notes")!;
    answerCard(V, unused.key, "snooze", NOW);
    expect(visibleCards(cards, readAnswers(V), NOW).some((c) => c.key === unused.key)).toBe(false);
    expect(visibleCards(cards, readAnswers(V), NOW + 31 * 86_400_000).some((c) => c.key === unused.key)).toBe(true);
    expect(() => answerCard(V, "nothex", "keep")).toThrow();
    expect(weeklyLine(cards, s)).toMatch(/^Apps: \d+ need you: /);
  });
  test("a trial ending in three days; AI value under 1", () => {
    const s: Stack = { ...stackNow(), apps: [{ id: "t", name: "Trial App", kind: "app", category: "x", lifecycle: "in use", usage: null, monthly: null, trial: { ends: "2026-10-02" }, health: null, verdict: "keep", why: [] }, { id: "ai", name: "Foo AI", kind: "ai-tool", category: "ai", lifecycle: "in use", usage: null, monthly: 200, value_multiple: 0.6, health: null, verdict: "review", why: [] }] };
    const cards = detectCards(s, NOW);
    expect(cards.find((c) => c.kind === "trial")!.title).toContain("in 2 days");
    expect(cards.find((c) => c.kind === "ai-plan")!.title).toContain("0.6x");
  });
  test("broken capture may interrupt, within three a week; the rest waits", () => {
    const urgent = (i: number) => ({ key: `abcdef00000${i}`, kind: "failing" as const, app: `a${i}`, title: `T${i}`, why: "w", actions: [], urgent: true });
    const r = raiseUrgent(V, [0, 1, 2, 3].map(urgent), NOW);
    expect(r.raised).toHaveLength(3);
    expect(r.waited).toHaveLength(1);
    expect(readInterruptions(V).filter((x) => x.sent)).toHaveLength(3);
    expect(raiseUrgent(V, [{ ...urgent(5), urgent: false }], NOW).raised).toEqual([]);
  });
  test("the monthly stack review and an offboarding draft: nothing cancelled, sent or deleted", () => {
    const s = stackNow();
    const cards = detectCards(s, NOW);
    const md = stackReviewMarkdown(s, cards, "2026-09");
    expect(md).toContain("Known spend: $42.00 a month across 3 paid apps");
    expect(md).toContain("## Top three to review");
    expect(md).not.toMatch(/—/);
    const p = writeStackReview(V, s, cards, NOW);
    expect(p).toContain(join("general", "memory", "reviews", "stack-2026-09.md"));
    const d = offboardingDraft(V, "bar-notes", NOW);
    const body = readFileSync(d, "utf8");
    expect(body).toContain("Nothing here has been done");
    expect(body).toContain("Draft message to the vendor (not sent)");
    expect(() => offboardingDraft(V, "nope")).toThrow();
    const to = archiveRecord(V, "qux-free");
    expect(existsSync(join(to, "manifest.json"))).toBe(true);
    expect(existsSync(join(V, "data", "apps", "qux-free"))).toBe(false);
  });
});
