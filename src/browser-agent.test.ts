import { describe, expect, test } from "bun:test";
import { runBrowserAgent, renderObservation, type DriverLike, type DriverActResult, type AgentGoal } from "./browser-agent.ts";
import type { PageSnapshot } from "./browser-actions.ts";

function snap(url: string, els: PageSnapshot["elements"], aria = ""): PageSnapshot {
  return { url, title: "T", aria, elements: els };
}

// A scriptable fake driver: each act() returns the next queued snapshot (or
// repeats the last), optionally reporting downloads.
class FakeDriver implements DriverLike {
  acts: Array<{ ref?: string; kind: string }> = [];
  constructor(
    private snaps: PageSnapshot[],
    private opts: { downloadsOnKind?: string; waitUserOk?: boolean } = {},
  ) {}
  private i = 0;
  async open() {
    return { url: this.snaps[0]!.url };
  }
  async snapshot() {
    return this.snaps[Math.min(this.i, this.snaps.length - 1)]!;
  }
  async act(cmd: { ref?: string; kind: string }): Promise<DriverActResult> {
    this.acts.push({ ref: cmd.ref, kind: cmd.kind });
    this.i = Math.min(this.i + 1, this.snaps.length - 1);
    const downloads = this.opts.downloadsOnKind && cmd.kind === this.opts.downloadsOnKind ? 1 : 0;
    return { ok: true, downloads, snapshot: this.snaps[this.i]! };
  }
  async waitUser() {
    return this.opts.waitUserOk ?? true;
  }
  async close() {}
}

// A scripted model: returns queued replies in order, then "fail".
function scriptModel(replies: string[]) {
  let i = 0;
  return async () => replies[i++] ?? '{"action":"fail","reason":"out of script"}';
}

const baseGoal = (over: Partial<AgentGoal> = {}): AgentGoal => ({
  objective: "Download statements",
  startUrl: "https://bank.com/login",
  downloadsDir: "/tmp/x",
  ...over,
});

describe("runBrowserAgent happy path", () => {
  test("navigates, selects, downloads, records a trace, and succeeds", async () => {
    const pages = [
      snap("https://bank.com/statements", [
        { ref: "e1", role: "combobox", name: "Period" },
        { ref: "e2", role: "button", name: "Download" },
      ]),
      snap("https://bank.com/statements?p=365", [
        { ref: "e1", role: "combobox", name: "Period" },
        { ref: "e2", role: "button", name: "Download" },
      ]),
      snap("https://bank.com/statements?done", [{ ref: "e2", role: "button", name: "Download" }]),
    ];
    const driver = new FakeDriver(pages, { downloadsOnKind: "download" });
    const model = scriptModel([
      '{"action":"select","ref":"e1","option":"Last 365 days"}',
      '{"action":"download","ref":"e2"}',
      '{"action":"done","summary":"got it"}',
    ]);
    const r = await runBrowserAgent(baseGoal(), { driver, askModel: model });
    expect(r.ok).toBe(true);
    expect(r.downloads).toBe(1);
    expect(r.trace.map((t) => t.action.action)).toEqual(["select", "download"]);
  });
});

describe("guardrails", () => {
  test("blocks a consequential click and keeps it out of the trace", async () => {
    const pages = [snap("https://bank.com", [{ ref: "e1", role: "button", name: "Send Money" }, { ref: "e2", role: "button", name: "Download" }])];
    const driver = new FakeDriver(pages, { downloadsOnKind: "download" });
    const model = scriptModel([
      '{"action":"click","ref":"e1"}', // Send Money → blocked
      '{"action":"download","ref":"e2"}',
      '{"action":"done","summary":"done"}',
    ]);
    const r = await runBrowserAgent(baseGoal(), { driver, askModel: model });
    expect(r.ok).toBe(true);
    // The blocked Send Money click never executed.
    expect(driver.acts.find((a) => a.ref === "e1")).toBeUndefined();
    expect(r.trace.every((t) => t.action.ref !== "e1")).toBe(true);
  });

  test("refuses to fill a password field", async () => {
    const pages = [snap("https://bank.com/login", [{ ref: "e1", role: "input", name: "Password", isPassword: true }])];
    const driver = new FakeDriver(pages);
    const model = scriptModel(['{"action":"fill","ref":"e1","text":"hunter2"}', '{"action":"fail","reason":"cannot login"}']);
    const r = await runBrowserAgent(baseGoal(), { driver, askModel: model });
    expect(r.ok).toBe(false);
    expect(driver.acts.length).toBe(0); // nothing executed
  });
});

describe("ask_user", () => {
  test("pauses for the human then resumes", async () => {
    const pages = [
      snap("https://bank.com/login", [{ ref: "e1", role: "button", name: "Continue" }]),
      snap("https://bank.com/home", [{ ref: "e2", role: "button", name: "Download" }]),
    ];
    const driver = new FakeDriver(pages, { downloadsOnKind: "download", waitUserOk: true });
    const model = scriptModel([
      '{"action":"ask_user","kind":"twofa","reason":"do 2FA"}',
      '{"action":"download","ref":"e2"}',
      '{"action":"done","summary":"ok"}',
    ]);
    const r = await runBrowserAgent(baseGoal(), { driver, askModel: model });
    expect(r.ok).toBe(true);
    expect(r.downloads).toBe(1);
  });
});

describe("safety nets", () => {
  test("stuck detection fails after repeated no-progress actions", async () => {
    const pages = [snap("https://bank.com", [{ ref: "e1", role: "button", name: "Nope" }])];
    const driver = new FakeDriver(pages); // page never changes
    const model = scriptModel([
      '{"action":"click","ref":"e1"}',
      '{"action":"click","ref":"e1"}',
      '{"action":"click","ref":"e1"}',
      '{"action":"click","ref":"e1"}',
    ]);
    const r = await runBrowserAgent(baseGoal(), { driver, askModel: model });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no progress/);
  });

  test("re-prompts on malformed model output without executing", async () => {
    const pages = [snap("https://bank.com", [{ ref: "e2", role: "button", name: "Download" }])];
    const driver = new FakeDriver(pages, { downloadsOnKind: "download" });
    const model = scriptModel([
      "I think I should click the button.", // not JSON
      '{"action":"download","ref":"e2"}',
      '{"action":"done","summary":"ok"}',
    ]);
    const r = await runBrowserAgent(baseGoal(), { driver, askModel: model });
    expect(r.ok).toBe(true);
    expect(driver.acts.length).toBe(1); // only the download executed
  });

  test("honors the turn budget", async () => {
    const pages = [snap("https://bank.com", [{ ref: "e1", role: "link", name: "x" }])];
    const driver = new FakeDriver([pages[0]!, snap("https://bank.com/2", [{ ref: "e1", role: "link", name: "y" }])]);
    const model = scriptModel(Array(20).fill('{"action":"read","ref":"e1"}'));
    const r = await runBrowserAgent(baseGoal({ maxTurns: 3 }), { driver, askModel: model });
    expect(r.ok).toBe(false);
    expect(r.turns).toBeLessThanOrEqual(3);
  });
});

describe("renderObservation", () => {
  test("lists refs and never the goal-less noise", () => {
    const out = renderObservation("Get statements", snap("https://x.com", [{ ref: "e1", role: "button", name: "Download" }], "- button"), 2);
    expect(out).toContain("e1 button");
    expect(out).toContain("GOAL: Get statements");
    expect(out).toContain("TURN: 2");
  });
});
