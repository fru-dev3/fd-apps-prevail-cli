import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChatJson } from "./chat-json.ts";
import { dispatch } from "./jobs.ts";
import { cannotAnswer, leadingMentions, longWork, memberTools, routeTurn, visibleText } from "./members.ts";
import { getSpecialist } from "./specialists.ts";

const ROOT = join("/tmp", `prevail-members-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo"]) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d } }));
    writeFileSync(join(D(d), "memory", "state.md"), `# ${d}\nFoo state.\n`);
  }
  writeFileSync(join(V, "build", "chief-of-staff.md"), "---\nname: Quill\n---\n");
}

const detectClis = async () => [{ kind: "claude", bin: "/bin/false", label: "claude" }] as never;
type Turn = { prompt: string; allowTools?: string[]; act?: boolean; onChunk?: (d: string) => void };
function fakeTurn(log: Turn[]) {
  return (async (t: Turn) => {
    log.push(t);
    const who = /You are the (\w+), a specialist/.exec(t.prompt)?.[1] ?? "chief";
    const text = `${who} says foo.`;
    t.onChunk?.(text);
    return text;
  }) as never;
}
async function turn(o: { domain?: string; message: string; to?: string[]; members?: string[]; log: Turn[]; dispatched?: string[]; routeRunner?: (r: { prompt: string }) => Promise<string>; started?: string[] }) {
  const lines: string[] = [];
  await runChatJson({
    vaultPath: V, domain: o.domain ?? "general", message: o.message, sessionId: "s-foo", write: (l) => lines.push(l),
    ...(o.to ? { to: o.to } : {}), ...(o.members ? { members: o.members } : {}),
    deps: {
      detectClis, runChatTurn: fakeTurn(o.log), persistMessage: () => {},
      dispatch: (i) => { o.dispatched?.push(i.message); return dispatch({ ...i, runner: null }); },
      startJob: (_v, id) => { o.started?.push(id); },
      routeRunner: (o.routeRunner ?? null) as never,
    },
  });
  return lines.map((l) => JSON.parse(l));
}
const threadFile = () => {
  const dir = join(D("general"), "_threads");
  const f = readdirSync(dir).find((x) => x.endsWith(".jsonl"))!;
  return readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

describe("routing a turn", () => {
  beforeEach(seed);
  test("leading mentions, and the text the user typed", () => {
    expect(leadingMentions("@Researcher @planner, what next?")).toEqual({ names: ["Researcher", "planner"], rest: "what next?" });
    expect(visibleText("# CONTEXT\nfoo\n\nUser's next message: @Planner plan it")).toBe("@Planner plan it");
    expect(longWork("do a thorough comparison of foo carriers")).toBe(true);
    expect(longWork("what is a foo policy?")).toBe(false);
  });
  test("explicit names win, with no model call", async () => {
    let calls = 0;
    const runner = async () => { calls++; return "planner"; };
    const r = await routeTurn(V, { message: "@Researcher @Planner what about foo?", members: ["writer"], runner });
    expect(r.route.map((x) => x.specialist)).toEqual(["researcher", "planner"]);
    expect(r.explicit).toBe(true);
    expect(r.ask).toBe("what about foo?");
    const c = await routeTurn(V, { message: "what about foo?", to: ["Writer"], runner });
    expect(c.route.map((x) => x.specialist)).toEqual(["writer"]);
    expect(calls).toBe(0);
  });
  test("a name that is no specialist stays in the text; just you skips the members", async () => {
    const r = await routeTurn(V, { message: "@Sam can you plan the foo?", members: [] });
    expect(r.route).toEqual([]);
    expect(r.ask).toBe("@Sam can you plan the foo?");
    const j = await routeTurn(V, { message: "just you: plan the foo week", members: ["planner"] });
    expect(j.route).toEqual([]);
  });
  test("members: the one whose work it is answers; a tie asks the model once", async () => {
    const members = ["researcher", "planner"];
    expect((await routeTurn(V, { message: "what are the best foo carriers?", members })).route.map((x) => x.specialist)).toEqual(["researcher"]);
    expect((await routeTurn(V, { message: "lay out the schedule and next steps for the foo move", members })).route.map((x) => x.specialist)).toEqual(["planner"]);
    expect((await routeTurn(V, { message: "how was your day", members })).route).toEqual([]);
    let asked = "";
    const tie = await routeTurn(V, { message: "find and plan it", members, runner: async (r) => { asked = r.prompt; return "planner"; } });
    expect(asked).toContain("researcher:");
    expect(tie.route.map((x) => x.specialist)).toEqual(["planner"]);
  });
});

describe("group chat in a thread", () => {
  beforeEach(seed);
  test("two members in General: one turn the Researcher answers, the next the Planner, each as itself", async () => {
    const log: Turn[] = [];
    const a = await turn({ message: "what are the best foo carriers for renters?", members: ["researcher", "planner"], log });
    const sp = a.filter((e) => e.type === "speaker");
    expect(sp.map((e) => e.speaker.id)).toEqual(["researcher"]);
    const reply = a.find((e) => e.type === "assistant");
    expect(reply.speaker).toEqual({ id: "researcher", name: "Researcher", why: "fits the message" });
    expect(reply.meta).toMatchObject({ speaker: "researcher", name: "Researcher", members: ["researcher", "planner"], scope: "general" });
    expect(reply.text).toBe("Researcher says foo.");
    expect(log[0]!.prompt).toContain("You are the Researcher, a specialist in a group chat with the user and Quill");
    expect(log[0]!.act).toBe(false);
    expect(log[0]!.allowTools!.every((t) => ["WebSearch", "WebFetch", "Read", "Grep", "Glob"].includes(t))).toBe(true);

    const b = await turn({ message: "lay out the schedule and next steps for the foo move", members: ["researcher", "planner"], log });
    expect(b.filter((e) => e.type === "speaker").map((e) => e.speaker.id)).toEqual(["planner"]);
    // Stored with each turn, so it survives later membership changes.
    const saved = threadFile().filter((t) => t.role === "assistant");
    expect(saved.map((t) => t.meta.speaker)).toEqual(["researcher", "planner"]);
    expect(saved[1].meta.members).toEqual(["researcher", "planner"]);
  });
  test("regression: @Planner in General hands off in code, with no shell or tool call and no model routing", async () => {
    const log: Turn[] = [];
    const dispatched: string[] = [];
    let routed = 0;
    // The desktop's General prompt: context first, the user's words last.
    const msg = "# WHO YOU'RE HELPING\nfoo profile\n\nYou are mid-conversation.\n--- PRIOR TURNS ---\nUser: hi\n--- END PRIOR TURNS ---\n\nUser's next message: @Planner plan the foo week";
    const evs = await turn({ message: msg, log, dispatched, routeRunner: async () => { routed++; return ""; } });
    expect(evs.find((e) => e.type === "speaker").speaker.id).toBe("planner");
    expect(log.length).toBe(1);
    expect(log[0]!.prompt).toContain("You are the Planner");
    expect(log[0]!.prompt).toContain("The user asked you by name.");
    expect(log[0]!.allowTools ?? []).not.toContain("Bash");
    expect(dispatched).toEqual([]);
    expect(routed).toBe(0);
    // The chip path: the same with no "@" in the text.
    const log2: Turn[] = [];
    const c = await turn({ message: "plan the foo week", to: ["planner"], log: log2 });
    expect(c.find((e) => e.type === "assistant").speaker.id).toBe("planner");
  });
  test("several answer in turn without repeating; the chief closes only on a disagreement", async () => {
    const log: Turn[] = [];
    const evs = await turn({ message: "@Researcher @Steward should I switch foo carriers?", log, routeRunner: async () => "They disagree on whether to switch now; your call." });
    expect(evs.filter((e) => e.type === "speaker").map((e) => e.speaker.id)).toEqual(["researcher", "steward", "chief"]);
    expect(log[1]!.prompt).toContain("## Already said on this turn\n### Researcher");
    expect(evs.filter((e) => e.type === "assistant").at(-1).meta).toMatchObject({ speaker: "chief", name: "Quill" });
    const quiet = await turn({ message: "@Researcher @Steward should I switch foo carriers?", log: [], routeRunner: async () => "NONE" });
    expect(quiet.filter((e) => e.type === "speaker").map((e) => e.speaker.id)).toEqual(["researcher", "steward"]);
  });
  test("long work still becomes a job card, for every name on it", async () => {
    const started: string[] = [];
    const evs = await turn({ domain: "foo", message: "@Researcher @Scout do a thorough comparison of foo carriers", log: [], started });
    const job = evs.find((e) => e.type === "job").job;
    expect(job.team).toEqual([{ step: 1, specialists: ["researcher", "scout"] }]);
    expect(evs.some((e) => e.type === "speaker")).toBe(false);
  });
  test("ceilings hold: a specialist that would act, or an outside agent, never answers in a thread", () => {
    const base = getSpecialist(V, "researcher")!;
    expect(cannotAnswer(base)).toBeNull();
    expect(cannotAnswer({ ...base, ceiling: "act" })).toMatch(/never allowed/);
    expect(cannotAnswer({ ...base, outside: { endpoint: "https://foo.example", tool: "ask", perDay: 3 } })).toMatch(/only works as a job/);
    expect(cannotAnswer({ ...base, on: false })).toMatch(/is off/);
    expect(memberTools({ ...base, tools: ["web", "vault-read", "vault-write"] })).toEqual(["WebSearch", "WebFetch", "Read", "Grep", "Glob"]);
  });
});
