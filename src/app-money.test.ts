import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyMoney, cardCharges, chargeEvents, dateIn, detectSeries, lifecycleMail, lifecycleOf, moneyByApp, moneyScan, normMerchant, readUnknownMerchants } from "./app-money.ts";
import { buildMatcher, upsertRecord } from "./app-map.ts";
import { computeMetrics, glance } from "./metrics.ts";
import type { MailHeader } from "./source-sync.ts";

const ROOT = join("/tmp", `prevail-money-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const man = (id: string) => JSON.parse(readFileSync(join(V, "data", "entities", "products", id, "manifest.json"), "utf8"));

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta", "apps"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general"), { recursive: true });
  // A card export in the first bank format (invented merchants and amounts).
  mkdirSync(join(V, "data", "entities", "products", "Foo Card"), { recursive: true });
  const rows = ["Transaction Date,Post Date,Description,Category,Type,Amount,Memo"];
  for (const [m, d] of [["06", "14"], ["07", "14"], ["08", "14"], ["09", "14"]]) rows.push(`${m}/${d}/2026,${m}/${d}/2026,NOTION LABS INC 4155550100 CA,Software,Sale,-10.00,`);
  for (const [m, d, a] of [["06", "02", "15.00"], ["07", "02", "15.00"], ["08", "02", "17.00"], ["09", "02", "17.00"]]) rows.push(`${m}/${d}/2026,${m}/${d}/2026,SQ *BAR GYM EXAMPLE #4421,Health,Sale,-${a},`);
  rows.push("09/20/2026,09/21/2026,CORNER BAKERY EXAMPLE,Food,Sale,-6.50,");
  rows.push("09/25/2026,09/25/2026,PAYMENT THANK YOU,,Payment,200.00,");
  rows.push("09/10/2026,09/10/2026,OPENAI *CHATGPT SUBSCR,Software,Sale,-20.00,");
  writeFileSync(join(V, "data", "entities", "products", "Foo Card", "activity.CSV"), rows.join("\n"));
  // The second format: a yearly charge seen twice.
  mkdirSync(join(V, "data", "entities", "products", "Bar Card"), { recursive: true });
  writeFileSync(join(V, "data", "entities", "products", "Bar Card", "export.csv"), ["Date,Description,Amount", "09/28/2025,FOO NOTES APP YEARLY,48.00", "09/27/2026,FOO NOTES APP YEARLY,52.00", "09/27/2026,ONLINE PAYMENT,-500.00"].join("\n"));
  upsertRecord(V, { id: "notion", name: "Notion" });
  upsertRecord(V, { id: "openai", name: "OpenAI" });
  upsertRecord(V, { id: "foo-notes", name: "Foo Notes", identifiers: { merchants: ["FOO NOTES APP"] } });
}

describe("A3: money", () => {
  beforeEach(seed);
  test("merchant names lose processor prefixes, store numbers and phone tails", () => {
    expect(normMerchant("SQ *BAR GYM EXAMPLE #4421")).toBe("BAR GYM EXAMPLE");
    expect(normMerchant("NOTION LABS INC 4155550100 CA")).toBe("NOTION LABS INC");
    expect(normMerchant("GOOGLE *YOUTUBE PREMIUM")).toBe("GOOGLE *YOUTUBE PREMIUM");
  });
  test("recurring series: monthly with a price step, yearly; one-offs are not series", () => {
    const s = detectSeries(cardCharges(V), buildMatcher(V));
    const by = Object.fromEntries(s.map((x) => [x.merchant, x]));
    expect(by["NOTION LABS INC"]).toMatchObject({ app: "notion", freq: "monthly", mature: true, next: "2026-10-14" });
    expect(by["BAR GYM EXAMPLE"]!.app).toBeNull();
    expect(by["BAR GYM EXAMPLE"]!.price_changes).toEqual([{ date: "2026-08-02", from: 15, to: 17 }]);
    expect(by["FOO NOTES APP YEARLY"]).toMatchObject({ app: "foo-notes", freq: "yearly", mature: false });
    expect(by["CORNER BAKERY EXAMPLE"]).toBeUndefined();
  });
  test("charge events keep only charges matched to apps; the bank's other lines never leave memory", () => {
    const { events } = chargeEvents(V);
    const apps = [...new Set(events.map((e) => e.project))].sort();
    expect(apps).toEqual(["foo-notes", "notion", "openai"]); // a single plan charge from a known vendor counts
    expect(JSON.stringify(events)).not.toMatch(/BAKERY|GYM|PAYMENT/);
  });
  test("costs, renewals and price history onto the records; a stated cost is never replaced", () => {
    upsertRecord(V, { id: "bar-gym", name: "Bar Gym", identifiers: { merchants: ["BAR GYM EXAMPLE"] } });
    const fooNotes = join(V, "data", "entities", "products", "foo-notes", "manifest.json");
    writeFileSync(fooNotes, JSON.stringify({ ...man("foo-notes"), cost: { amount: 40, period: "year", source: "stated" } }));
    const r = moneyScan(V, { now: NOW, host: "mac-a" });
    expect(r.matched).toBe(3);
    expect(man("notion").cost).toMatchObject({ amount: 10, period: "month", source: "card statements" });
    expect(man("notion").renewal).toMatchObject({ next: "2026-10-14", period: "monthly" });
    expect(man("bar-gym").price_history).toEqual([{ date: "2026-06-02", amount: 15 }, { date: "2026-08-02", amount: 17 }]);
    expect(man("foo-notes").cost).toEqual({ amount: 40, period: "year", source: "stated" });
    expect(man("foo-notes").renewal.next).toBe("2027-09-27");
    // Unmatched recurring merchants wait in the inbox on this Mac.
    expect(readUnknownMerchants(V)).toEqual([]);
  });
  test("an unmatched recurring merchant goes to the inbox; old statements lower confidence", () => {
    const r = moneyScan(V, { now: NOW, host: "mac-a" });
    expect(readUnknownMerchants(V).map((u) => u.value)).toEqual(["BAR GYM EXAMPLE"]);
    expect(r.statements_through).toBe("2026-09-27");
    const later = moneyScan(V, { now: NOW + 120 * 86_400_000, host: "mac-a" });
    expect(later.statements_through).toBe("2026-09-27");
    expect(man("notion").cost).toMatchObject({ confidence: 0.4, source: "card statements through 2026-09-27" });
  });
  test("Plaid wins over a statement guess; two live series for one app = billed twice", () => {
    const s = detectSeries(cardCharges(V), buildMatcher(V)).filter((x) => x.app === "notion");
    const twice = [...s, { ...s[0]!, merchant: "NOTION AGAIN" }];
    const money = moneyByApp(twice, [{ ts: "2026-09-15", src: "plaid", kind: "money.recurring", n: 3, project: "openai", host: "h", tier: "measured", attrs: { monthly: 20, frequency: "monthly", next: "2026-10-15", status: "mature" } }], [], NOW);
    expect(money.get("notion")).toMatchObject({ billed_twice: true, cost: { amount: 20 } });
    expect(money.get("openai")!.cost).toMatchObject({ source: "plaid", amount: 20, confidence: 0.95 });
    applyMoney(V, money);
    expect(man("notion").billed_twice).toBe(true);
  });
  test("lifecycle mail: known senders only, classified by subject, dates read from it", () => {
    const h = (from: string, subject: string, ts = NOW): MailHeader => ({ id: subject, thread: "t", ts, account: "a", dir: "received", from, to: [], cc: [], subject, labels: [] });
    const mail = lifecycleMail([
      h("team@mail.notion.so", "Your trial ends in 3 days"),
      h("noreply@tm.openai.com", "Your ChatGPT Plus subscription renews on Oct 14"),
      h("billing@foo.example", "Your receipt #1234"),
      h("noreply@tm.openai.com", "Your receipt from OpenAI"),
      h("friend@example.com", "Welcome to the party"),
    ], buildMatcher(V));
    expect(mail.map((m) => `${m.app}:${m.kind}:${m.until ?? ""}`)).toEqual(["notion:trial:2026-10-03", "openai:renewal:2026-10-14", "openai:receipt:"]);
    expect(lifecycleOf("Welcome to Foo")).toBe("welcome");
    expect(lifecycleOf("Important: price change for your plan")).toBe("price");
    expect(dateIn("renews 2026-11-12", NOW)).toBe("2026-11-12");
    expect(dateIn("nothing here", NOW)).toBeNull();
    const money = moneyByApp([], [], mail, NOW);
    expect(money.get("notion")!.trial).toEqual({ ends: "2026-10-03", source: "email" });
    expect(money.get("openai")!.renewal).toMatchObject({ next: "2026-10-14", source: "email" });
  });
  test("metrics: subscriptions paid a month, from charges matched to apps", async () => {
    const c = await computeMetrics(V, { now: NOW, home: join(ROOT, "home") });
    expect(c.sources.find((s) => s.id === "charges")!.events).toBeGreaterThan(0);
    const g = glance(c, { ids: ["m-subscriptions"], week: "2026-09-14" });
    expect(g.rows[0]!.value).toBe(10);
  });
});
