// Today T2: commitments. The precision eval on invented sentences (promises,
// requests, hedges, questions, other people's promises), dates, what the user
// tells the chief of staff, sent-mail headers (only the promise sentence is
// kept), meeting notes, filing with exact Undo, slip prediction, and the
// Today card never missing a promise due this week.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitmentsFromMail, fileCommitment, findPromises, meetingItems, noteCommitment, openCommitments, openProposals, resolveWhen, toldCommitment, undoCommitment,
  type HeaderLite,
} from "./commitments.ts";
import { headerOf } from "./source-sync.ts";
import { composeToday } from "./today.ts";
import { runChatJson } from "./chat-json.ts";

const ROOT = join("/tmp", `prevail-commit-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
// Thursday 2026-10-01, noon local.
const NOW = new Date(2026, 9, 1, 12).getTime();

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo", "bar"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), "{}");
  }
  writeFileSync(join(D("foo"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Existing foo task ~id:abc1234\n");
}

// [sentence, is it an explicit promise the user made with a time]
const EVAL: [string, boolean][] = [
  ["I'll send you the revised foo deck by Friday.", true],
  ["I will get the bar estimate to you tomorrow.", true],
  ["I'll have the draft over by Oct 7.", true],
  ["I'm going to review the foo contract on Monday.", true],
  ["I'll call the bar office next week.", true],
  ["I will file the foo claim by 2026-10-09.", true],
  ["I'll forward the receipts to you this week.", true],
  ["I can have the numbers ready by end of the month.", true],
  ["I'll book the venue for the foo dinner on Tuesday.", true],
  ["I'll update the bar spreadsheet by EOD.", true],
  ["Sure, I will confirm the booking tomorrow.", true],
  ["I'll make sure to sign the foo lease by Wednesday.", true],
  ["I'll look into it.", false],
  ["I might send the deck by Friday.", false],
  ["I'll try to call you tomorrow.", false],
  ["If you need it, I'll send it Monday.", false],
  ["Could you send me the bar file by Friday?", false],
  ["Sam will send the foo deck by Friday.", false],
  ["I sent the deck yesterday.", false],
  ["I won't be able to make it on Friday.", false],
  ["Hopefully I'll get to it next week.", false],
  ["I'll let you know if anything changes.", false],
  ["Thanks for the foo update, talk soon.", false],
  ["Can you confirm the bar time for Tuesday?", false],
  ["We should probably meet next week.", false],
  ["I'll think about it over the weekend.", false],
  ["Let me know when you are free on Monday.", false],
  ["They promised to deliver the foo chairs by Friday.", false],
  ["When I get back, I'll call you on Monday.", false],
  ["I would love to join the bar call next week.", false],
];

describe("finding promises (the precision eval)", () => {
  test(`${EVAL.length} invented sentences: precision and recall at least 0.8`, () => {
    let tp = 0, fp = 0, fn = 0;
    const misses: string[] = [];
    for (const [s, want] of EVAL) {
      const got = findPromises(s, NOW, "person/sam").some((p) => !!p.due);
      if (got && want) tp++; else if (got && !want) { fp++; misses.push(`false: ${s}`); } else if (!got && want) { fn++; misses.push(`missed: ${s}`); }
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    expect(misses).toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.8);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
  test("dates resolve against the message time", () => {
    expect(resolveWhen("by Friday", NOW)).toBe("2026-10-02");
    expect(resolveWhen("tomorrow", NOW)).toBe("2026-10-02");
    expect(resolveWhen("next week", NOW)).toBe("2026-10-09");
    expect(resolveWhen("on Monday", NOW)).toBe("2026-10-05");
    expect(resolveWhen("by Oct 7", NOW)).toBe("2026-10-07");
    expect(resolveWhen("end of the month", NOW)).toBe("2026-10-31");
    expect(resolveWhen("in 3 days", NOW)).toBe("2026-10-04");
    expect(resolveWhen("someday", NOW)).toBeUndefined();
  });
  test("a promise with a person and a time is the most sure; the text is the action", () => {
    expect(findPromises("Thanks! I'll send the foo deck by Friday.", NOW, "person/sam")).toEqual([{ kind: "commitment", text: "Send the foo deck by Friday", person: "person/sam", due: "2026-10-02", confidence: 0.9, quote: "I'll send the foo deck by Friday." }]);
  });
});

describe("what the user tells the chief of staff", () => {
  test("owe, promised, told; owes me, waiting on", () => {
    expect(toldCommitment("remind me I owe Sam the foo deck by Friday", NOW)).toMatchObject({ kind: "commitment", person: "person/sam", due: "2026-10-02", text: "The foo deck for Sam" });
    expect(toldCommitment("I promised Alex Reed I'd send the bar photos tomorrow", NOW)).toMatchObject({ kind: "commitment", person: "person/alex-reed", due: "2026-10-02", text: "Send the bar photos" });
    expect(toldCommitment("Jordan owes me the signed foo lease by Oct 7", NOW)).toMatchObject({ kind: "waiting", person: "person/jordan", due: "2026-10-07", text: "The signed foo lease from Jordan" });
    expect(toldCommitment("I'm waiting on Casey for the bar quote", NOW)).toMatchObject({ kind: "waiting", person: "person/casey" });
    expect(toldCommitment("what do I owe on the foo card?", NOW)).toBeNull();
    expect(toldCommitment("remind me I owe money on the card", NOW)).toBeNull();
  });
  test("filed with a receipt, never twice, and Undo restores the board byte for byte", () => {
    seed();
    const before = readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8");
    const r = noteCommitment(V, { text: "remind me I owe Sam the foo deck by Friday", domain: "foo", thread: "t1", now: NOW })!;
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8")).toContain(`- [ ] The foo deck for Sam @2026-10-02 +2026-10-01 ~src:${r.src} ~id:${r.id} ~kind:commitment ~to:person/sam`);
    expect(fileCommitment(V, toldCommitment("remind me I owe Sam the foo deck by Friday", NOW)!, { domain: "foo", src: r.src, now: NOW })).toBeNull();
    expect(undoCommitment(V, r.id)).toBe(true);
    expect(readFileSync(join(D("foo"), "memory", "tasks.md"), "utf8")).toBe(before);
  });
  test("in chat: filed at once with a filed event, no model call", async () => {
    seed();
    const lines: string[] = [];
    let modelTurns = 0;
    const code = await runChatJson({ vaultPath: V, domain: "foo", message: "remind me I owe Sam the foo deck by Friday", write: (l) => lines.push(l), deps: { detectClis: async () => [{ kind: "claude", bin: "/bin/false", label: "claude" }] as never, runChatTurn: (async () => { modelTurns++; return "x"; }) as never, persistMessage: () => {} } });
    expect(code).toBe(0);
    expect(modelTurns).toBe(0);
    const evs = lines.map((l) => JSON.parse(l));
    expect(evs.find((e) => e.type === "filed").filed).toMatchObject({ kind: "commitment", domain: "foo", person: "person/sam" });
    expect(evs.find((e) => e.type === "assistant").text).toMatch(/^Noted: a promise to Sam/);
  });
});

describe("sent mail and meeting notes", () => {
  test("a header keeps the promise sentence and whether it asks, never the snippet", () => {
    const msg = { id: "m1", threadId: "t1", internalDate: String(NOW), labelIds: ["SENT"], snippet: "Hi Sam, thanks for the call. I&#39;ll send the foo deck by Friday. Does Tuesday work for the bar review?", payload: { headers: [{ name: "From", value: "me@example.com" }, { name: "To", value: "sam.rivera@example.com" }, { name: "Subject", value: "Foo deck" }] } };
    const h = headerOf(msg, "acct", new Set(["me@example.com"]))!;
    expect(h.promises).toEqual([{ kind: "commitment", text: "Send the foo deck by Friday", person: "person/sam-rivera", due: "2026-10-02", confidence: 0.9, quote: "I'll send the foo deck by Friday." }]);
    expect(h.asks).toBe(true);
    expect(JSON.stringify(h)).not.toContain("thanks for the call");
  });
  test("sure ones are filed with Undo, the rest wait for the review; a second run changes nothing", () => {
    seed();
    const hs: HeaderLite[] = [
      { id: "1", thread: "ta", ts: NOW, dir: "sent", from: "me@example.com", to: ["sam@example.com"], subject: "Deck", promises: findPromises("I'll send the foo deck by Friday.", NOW, "person/sam") },
      { id: "2", thread: "tb", ts: NOW, dir: "sent", from: "me@example.com", to: ["casey@example.com"], subject: "Call", promises: findPromises("I'll call the bar office.", NOW, "person/casey") },
    ];
    const r = commitmentsFromMail(V, hs, NOW);
    expect(r.filed.length).toBe(1);
    expect(r.proposed).toBe(1);
    expect(readFileSync(join(D("general"), "memory", "tasks.md"), "utf8")).toMatch(/Send the foo deck by Friday @2026-10-02 .*~kind:commitment ~to:person\/sam/);
    expect(openProposals(V).length).toBe(1);
    expect(commitmentsFromMail(V, hs, NOW)).toEqual({ filed: [], proposed: 1 });
    expect(openProposals(V).length).toBe(1);
  });
  test("meeting action items: mine are commitments, someone else's are waiting-fors", () => {
    const md = "# Foo sync\n\nNotes here.\n\n## Action items\n- Send the bar budget by Friday\n- Jordan: share the foo floor plan by Oct 7\n- me: book the room\n\n## Other\n- not an item\n";
    const items = meetingItems(md, NOW);
    expect(items.map((x) => [x.kind, x.text, x.due ?? null, x.person ?? null])).toEqual([
      ["commitment", "Send the bar budget by Friday", "2026-10-02", null],
      ["waiting", "Share the foo floor plan by Oct 7 from Jordan", "2026-10-07", "person/jordan"],
      ["commitment", "Book the room", null, null],
    ]);
  });
});

describe("slip prediction and Today", () => {
  beforeEach(seed);
  test("due soon with nothing done is slipping; mail to the person since counts as activity; overdue always slips", () => {
    writeFileSync(join(D("foo"), "memory", "tasks.md"), [
      "- [ ] Send the foo deck @2026-10-03 +2026-09-28 ~id:c1 ~kind:commitment ~to:person/sam",
      "- [ ] Send the bar photos @2026-10-03 +2026-09-28 ~id:c2 ~kind:commitment ~to:person/casey",
      "- [ ] Return the foo drill @2026-09-29 +2026-09-20 ~id:c3 ~kind:commitment ~to:person/jordan",
      "- [ ] The signed lease @2026-10-20 ~id:c4 ~kind:waiting ~from:person/alex",
    ].join("\n"));
    const hs: HeaderLite[] = [{ id: "1", thread: "t", ts: new Date(2026, 8, 30).getTime(), dir: "sent", from: "me@example.com", to: ["casey.lee@example.com"], subject: "photos" }];
    const c = openCommitments(V, NOW, hs);
    expect(Object.fromEntries(c.map((x) => [x.id, x.slipping]))).toEqual({ c3: true, c1: true, c2: false, c4: false });
    expect(c.find((x) => x.id === "c1")!.why).toBe("due in 2 days, nothing done on it yet");
  });
  test("no promise due this week is missing from Today", () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(`- [ ] Promise number ${i} for foo @2026-10-0${2 + (i % 5)} ~id:p${i} ~kind:commitment ~to:person/sam`);
    writeFileSync(join(D("foo"), "memory", "tasks.md"), lines.join("\n"));
    writeFileSync(join(D("bar"), "memory", "tasks.md"), "- [ ] Bar renewal @2026-10-02 ~id:b1\n- [ ] Overdue promise @2026-09-25 ~id:b2 ~kind:commitment ~to:person/alex");
    const card = composeToday(V, { now: NOW, refresh: true });
    const shown = new Set([...card.items.map((x) => x.key), ...(card.promises ?? []).map((x) => x.key)]);
    for (let i = 0; i < 6; i++) expect(shown.has(`task:foo:p${i}`)).toBe(true);
    // The overdue promise to a person leads the card.
    expect(card.items[0]!.key).toBe("task:bar:b2");
  });
});
