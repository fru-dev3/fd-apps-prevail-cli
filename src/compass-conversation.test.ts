import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readLinks } from "./compass-chain.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerCandidate, compassCandidates, noteSaid, statedNumbers, topCandidates } from "./said.ts";
import { answerInterview, interviewActive, isInterviewTrigger, nextInterviewQuestion, phrases, readInterview, startInterview } from "./interview.ts";
import { compassBlock, compassJson, items, readCompass } from "./compass.ts";
import { checkin, checkinFor, readCheckins, reviewText, reviewWeek, weeklyReview } from "./review.ts";
import { INTERRUPTION_BUDGET, tryInterrupt, usedThisWeek, waitedForReview } from "./interruptions.ts";
import { runChatJson } from "./chat-json.ts";
import { computeMetrics, glance, weekOf, dayOf } from "./metrics.ts";

const ROOT = join("/tmp", `prevail-g2-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "money"]) mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
}
const fakeCli = { kind: "claude" as const, bin: "/bin/false", label: "claude" };

describe("what the user says, noticed by code", () => {
  beforeEach(seed);
  test("Compass candidates keep the user's sentence as the quote", () => {
    const c = compassCandidates("Honestly, what matters most to me is time with my kids and peace of mind. Also I will never take on new debt for a car.");
    expect(c.map((x) => `${x.kind}:${x.title}`)).toEqual(["value:Time with my kids", "value:Peace of mind", "rule:Never take on new debt for a car"]);
    expect(c[0]!.quote).toBe("Honestly, what matters most to me is time with my kids and peace of mind.");
    expect(compassCandidates("I want to be very aware of what is happening")[0]).toMatchObject({ kind: "value", title: "Being aware" });
    expect(compassCandidates("My goal is to finish the foo trail before the snow")[0]).toMatchObject({ kind: "goal", title: "Finish the foo trail before the snow" });
    expect(compassCandidates("what is the weather")).toEqual([]);
  });
  test("numbers said in chat become content-free events", () => {
    expect(statedNumbers("I ran 5k this morning and paid $1,200 for the roof")).toEqual([{ what: "ran", value: 5, unit: "km" }, { what: "paid", value: 1200, unit: "usd" }]);
    noteSaid(V, { text: "Slept 6 hours, ugh", now: Date.UTC(2026, 9, 1, 12) });
    const f = readFileSync(join(V, "build", "_meta", "events", "stated", `2026-10.${require("node:os").hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.jsonl`), "utf8");
    expect(f).toContain('"kind":"stated.slept"');
    expect(f).not.toContain("ugh");
  });
  test("the most heard candidates are offered; Yes adds the line in the user's words, Not now dismisses it", () => {
    for (let i = 0; i < 4; i++) noteSaid(V, { text: "I want to be very aware of what is happening in the world.", thread: `t${i}`, now: 1000 + i });
    noteSaid(V, { text: "I care deeply about my foo garden", thread: "t9", now: 2000 });
    const top = topCandidates(V);
    expect(top[0]).toMatchObject({ kind: "value", title: "Being aware", count: 4, threads: 4 });
    expect(answerCandidate(V, top[0]!.key, "yes", 3000).added).toMatch(/^v-/);
    const v = items(readCompass(V), "value")[0]!;
    expect(v.title).toBe("Being aware");
    expect(v.tokens.status).toBeUndefined();
    expect(v.fields.find((f) => f.key === "words")?.value).toContain("very aware");
    answerCandidate(V, topCandidates(V)[0]!.key, "no", 4000);
    expect(topCandidates(V)).toEqual([]);
  });
});

describe("the Compass conversation", () => {
  beforeEach(seed);
  test("a new user with an empty vault gets a usable Compass from five answers and one yes", () => {
    expect(isInterviewTrigger("Let's set up my Compass")).toBe(true);
    expect(isInterviewTrigger("what is a compass")).toBe(false);
    expect(startInterview(V, 1000).reply).toContain("Who are you to the people");
    answerInterview(V, "a father, a husband, and the one who builds things", 1001);
    expect(answerInterview(V, "That I was there, every evening", 1002).reply).toContain("hate");
    answerInterview(V, "That work came first", 1003);
    answerInterview(V, "time with family, freedom, peace of mind", 1004);
    const confirmQ = answerInterview(V, "never miss dinner more than twice a week", 1005).reply;
    expect(confirmQ).toContain("1. Father (role)");
    expect(confirmQ).toContain("never trade");
    const done = answerInterview(V, "drop 3, the rest is right", 1006);
    expect(done.reply).toContain("enough for today");
    expect(readInterview(V)!.status).toBe("paused");
    const j = compassJson(V);
    expect(j.roles.map((r) => r.title)).toEqual(["Father", "Husband"]);
    expect(j.roles[0]!.fields.hope).toBe("That I was there, every evening");
    expect(j.values.map((v) => `${v.title}:${v.status}`)).toEqual(["Time with family:confirmed", "Freedom:confirmed", "Peace of mind:confirmed"]);
    expect(j.rules.map((r) => r.title)).toEqual(["Never miss dinner more than twice a week"]);
    expect(j.proposed).toBe(0);
    // Every chat turn now carries it.
    expect(compassBlock(V)).toContain("1. Time with family");
    // The rest waits for the weekly review, one question at a time.
    expect(nextInterviewQuestion(V)?.text).toContain("Time with family, what would enough look like");
  });
  test("resumable: later pauses, continue picks up, skip moves on, a goal gets its WOOP", () => {
    startInterview(V, 1);
    answerInterview(V, "a friend", 2);
    expect(answerInterview(V, "later", 3).reply).toContain("Paused");
    expect(interviewActive(V)).toBe(false);
    expect(startInterview(V, 4).reply).toContain("Picking up where we left off");
    answerInterview(V, "skip", 5);
    answerInterview(V, "skip", 6);
    answerInterview(V, "calm", 7);
    answerInterview(V, "none", 8);
    answerInterview(V, "yes to all", 9);
    startInterview(V, 10);
    answerInterview(V, "calm 4 of 5 most weeks", 11); // enough
    answerInterview(V, "none", 12); // missing
    answerInterview(V, "hike the foo ridge with my brother", 13); // goal
    answerInterview(V, "standing on top together", 14);
    answerInterview(V, "I let work fill every weekend", 15);
    answerInterview(V, "if a weekend is free, then I book the hike first", 16);
    const last = answerInterview(V, "4", 17);
    expect(last.reply).toContain("In one sentence");
    const g = compassJson(V).goals[0]!;
    expect(g).toMatchObject({ title: "Hike the foo ridge with my brother", status: "active" });
    expect(g.fields.plan).toContain("if a weekend is free");
    expect(compassJson(V).values[0]!.fields.enough).toBe("calm 4 of 5 most weeks");
    expect(answerInterview(V, "Live calmly and show up for the people I love", 18).reply).toContain("What do you do, and for whom");
    expect(compassJson(V).mission?.text).toBe("Live calmly and show up for the people I love");
    // The chain (G1b): mission statement, vision and one objective, each said by the user and so theirs.
    expect(answerInterview(V, "I build calm foo tools for families", 19).reply).toContain("hope to become");
    expect(answerInterview(V, "A family that runs on its own foo", 20).reply).toContain("one number");
    expect(answerInterview(V, "Twelve foo hikes a year by 2027", 21).reply).toContain("whole Compass conversation");
    const j = compassJson(V);
    expect(j.statements.map((x) => `${x.title}:${x.status}`)).toEqual(["I build calm foo tools for families:confirmed"]);
    expect(j.visions[0]!.tokens.statement).toBe(j.statements[0]!.id);
    expect(j.objectives[0]).toMatchObject({ title: "Twelve foo hikes a year by 2027", tokens: { vision: j.visions[0]!.id, due: "2027-12-31" } });
    // The goal said earlier is proposed as moving the objective, with the user's words; it is not linked until accepted.
    const links = readLinks(V);
    expect(links).toMatchObject([{ kind: "goal-objective", from: g.id, to: j.objectives[0]!.id, quote: "Twelve foo hikes a year by 2027", by: "conversation", status: "proposed" }]);
    expect(compassJson(V).goals[0]!.tokens.objective).toBeUndefined();
  });
  test("phrases keep the user's words and drop filler", () => {
    expect(phrases("I'm a father and a brother; also a builder.")).toEqual(["Father", "Brother", "Builder"]);
    expect(phrases("none")).toEqual([]);
  });
  test("in a General chat the conversation runs without a model turn", async () => {
    const lines: string[] = [];
    let modelTurns = 0;
    const deps = { detectClis: async () => [fakeCli] as never, runChatTurn: (async () => { modelTurns++; return "x"; }) as never, persistMessage: () => {} };
    await runChatJson({ vaultPath: V, domain: "general", message: "Let's set up my Compass", write: (l) => lines.push(l), deps });
    await runChatJson({ vaultPath: V, domain: "general", message: "a mother and a friend", write: (l) => lines.push(l), deps });
    expect(modelTurns).toBe(0);
    const replies = lines.map((l) => JSON.parse(l)).filter((e) => e.type === "assistant").map((e) => e.text);
    expect(replies[0]).toContain("Who are you to the people");
    expect(replies[1]).toContain("Ten years from now");
    // A domain chat is never taken over by the conversation.
    await runChatJson({ vaultPath: V, domain: "money", message: "what is a good savings rate", write: () => {}, deps });
    expect(modelTurns).toBe(1);
  });
});

describe("the weekly review card", () => {
  beforeEach(seed);
  test("the check-in is an event, one tap a week, latest wins, and feeds the calm metric", async () => {
    const mon = Date.UTC(2026, 8, 28, 15);
    expect(() => checkin(V, 7)).toThrow(/1 to 5/);
    checkin(V, 3, "busy week", mon + 4 * 86_400_000);
    checkin(V, 4, undefined, mon + 5 * 86_400_000);
    expect(checkinFor(V, "2026-09-28")!.calm).toBe(4);
    expect(readCheckins(V)).toHaveLength(2);
    const c = await computeMetrics(V, { now: mon + 6 * 86_400_000 });
    expect(glance(c, { week: "2026-09-28", ids: ["m-calm"] }).rows[0]!.value).toBe(3.5);
  });
  test("which week: this week from Friday, last week until it is checked in", () => {
    const thu = Date.UTC(2026, 9, 1, 15);
    expect(reviewWeek(thu, V)).toBe("2026-09-21");
    checkin(V, 4, undefined, thu, "2026-09-21");
    expect(reviewWeek(thu, V)).toBe("2026-09-28");
    expect(reviewWeek(Date.UTC(2026, 9, 2, 15), V)).toBe("2026-09-28");
  });
  test("the card carries the check-in, the glance, the candidates and the next question", async () => {
    noteSaid(V, { text: "What matters to me is peace of mind", thread: "a" });
    startInterview(V); answerInterview(V, "a friend"); answerInterview(V, "later");
    const r = await weeklyReview(V, { now: Date.UTC(2026, 9, 2, 15) });
    expect(r.week).toBe("2026-09-28");
    expect(r.due).toBe(true);
    expect(r.glance.length).toBeGreaterThan(0);
    expect(r.candidates[0]!.title).toBe("Peace of mind");
    expect(r.question?.text).toContain("Ten years from now");
    expect(r.lines.conflict).toContain("No conflict");
    expect(r.interruptions).toEqual({ used: 0, budget: 3 });
    const t = reviewText(r);
    expect(t).toContain("How calm was this week?");
    expect(t).not.toMatch(/\u2014/);
    checkin(V, 4, undefined, Date.UTC(2026, 9, 2, 16));
    expect((await weeklyReview(V, { now: Date.UTC(2026, 9, 2, 17) })).due).toBe(false);
  });
});

describe("the interruption budget", () => {
  beforeEach(seed);
  test("over a simulated month, at most three a week; the rest waits for the review", () => {
    const start = Date.UTC(2026, 8, 7, 9);
    let sent = 0;
    for (let day = 0; day < 28; day++) {
      for (let k = 0; k < 2; k++) {
        const r = tryInterrupt(V, { kind: k ? "stalled-goal" : "overdue-promise", text: `foo ${day}-${k}`, key: `foo-${day}-${k}` }, start + day * 86_400_000 + k * 1000);
        if (r.ok) sent++;
      }
    }
    expect(sent).toBe(4 * INTERRUPTION_BUDGET);
    expect(usedThisWeek(V, start + 27 * 86_400_000)).toBe(3);
    expect(waitedForReview(V, weekOf(dayOf(start))).length).toBe(2 * 7 - 3);
    expect(tryInterrupt(V, { kind: "nice-to-know", text: "a tip" }, start).why).toMatch(/weekly review/);
    expect(tryInterrupt(V, { kind: "non-negotiable", text: "x", key: "foo-0-0" }, start + 1).why).toMatch(/already raised/);
  });
});
