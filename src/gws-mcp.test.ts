import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callGoogleWorkspace } from "./gws-mcp.ts";
import { readPendingGws } from "./gws-gateway.ts";

// Fix 1: account precedence in the gws-mcp tool handler.
//   explicit tool-arg account  >  launched --account (chip selection)  >  default
// A WRITE is queued (never spawns gws), so we can assert the target account the
// queued record carries without a live gws binary.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const ROOT = join(TMP_BASE, `prevail-gwsmcp-${process.pid}`);
const VAULT = join(ROOT, "vault");

// A guaranteed-write command (send). classifyGwsCommand routes this to the queue.
const SEND_ARGS = ["gmail", "messages", "send", "--params", "{}"];

function lastQueuedAccount(): string | undefined {
  const pending = readPendingGws(VAULT);
  expect(pending.length).toBeGreaterThan(0);
  return pending[pending.length - 1]!.account;
}

describe("gws-mcp account precedence (Fix 1)", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(VAULT, { recursive: true });
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  test("launched --account is used when the model passes no account", () => {
    callGoogleWorkspace({ args: SEND_ARGS }, VAULT, "general", "personal");
    expect(lastQueuedAccount()).toBe("personal");
  });

  test("an explicit tool-arg account overrides the launched --account", () => {
    callGoogleWorkspace({ args: SEND_ARGS, account: "work" }, VAULT, "general", "personal");
    expect(lastQueuedAccount()).toBe("work");
  });

  test("no pick + zero or one connected account => proceeds (unambiguous)", () => {
    // Machine state pinned via the injectable resolver - never the live machine.
    callGoogleWorkspace({ args: SEND_ARGS }, VAULT, "general", undefined, () => ({ kind: "none" }));
    expect(lastQueuedAccount()).toBeUndefined();
    callGoogleWorkspace({ args: SEND_ARGS }, VAULT, "general", undefined, () => ({ kind: "single", label: "work" }));
    expect(readPendingGws(VAULT).length).toBe(2);
  });

  test("no pick + MULTIPLE connected accounts => refused with the labels, nothing queued", () => {
    const out = callGoogleWorkspace(
      { args: SEND_ARGS }, VAULT, "general", undefined,
      () => ({ kind: "ambiguous", labels: ["home", "work"] }),
    );
    const text = out.map((c) => c.text ?? "").join(" ");
    expect(text).toContain("multiple Google accounts");
    expect(text).toContain("home, work");
    expect(readPendingGws(VAULT).length).toBe(0);
  });

  test("an explicit pick bypasses the multi-account refusal", () => {
    callGoogleWorkspace(
      { args: SEND_ARGS }, VAULT, "general", "work",
      () => ({ kind: "ambiguous", labels: ["home", "work"] }),
    );
    expect(lastQueuedAccount()).toBe("work");
  });

  test("the Google app's account binding resolves ambiguity for headless callers", () => {
    // No pick + multiple accounts, but the user bound the Google app to "work":
    // that standing choice is honored (this is how loop act runs resolve).
    callGoogleWorkspace(
      { args: SEND_ARGS }, VAULT, "general", undefined,
      () => ({ kind: "ambiguous", labels: ["home", "work"] }),
      () => "work",
    );
    expect(lastQueuedAccount()).toBe("work");
  });

  test("a binding for an account that is NOT connected does not bypass the refusal", () => {
    const out = callGoogleWorkspace(
      { args: SEND_ARGS }, VAULT, "general", undefined,
      () => ({ kind: "ambiguous", labels: ["home", "work"] }),
      () => "stale-label",
    );
    expect(out.map((c) => c.text ?? "").join(" ")).toContain("multiple Google accounts");
    expect(readPendingGws(VAULT).length).toBe(0);
  });
});

// classifyGwsFailure: errors must name the REAL cause, never a blanket auth story.
import { classifyGwsFailure } from "./gws-gateway.ts";
import { describe as describe2, test as test2, expect as expect2 } from "bun:test";

describe2("classifyGwsFailure - honest, actionable errors", () => {
  test2("invalid argv -> a grammar error naming the CLI usage, explicitly not auth", () => {
    const msg = classifyGwsFailure("", "error: unrecognized subcommand 'list'\n\nUsage: gws calendars [OPTIONS] <COMMAND>", ["calendar", "calendars", "list"]);
    expect2(msg).toContain("invalid arguments");
    expect2(msg).toContain("NOT an auth problem");
    expect2(msg).toContain("unrecognized subcommand");
  });

  test2("disabled Google API -> names the service and the one-click activation URL", () => {
    const out = JSON.stringify({ error: { message: "Google Calendar API has not been used in project 915905035776 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=915905035776 then retry.", status: "PERMISSION_DENIED", reason: "SERVICE_DISABLED" } });
    const msg = classifyGwsFailure(out, "", ["calendar", "+agenda"]);
    expect2(msg).toContain("DISABLED");
    expect2(msg).toContain("console.developers.google.com/apis/api/calendar-json.googleapis.com");
    expect2(msg).toContain("blocked at Google, not by sign-in");
  });

  test2("real scope refusal -> the account-named auth message", () => {
    const msg = classifyGwsFailure("", "ACCESS_TOKEN_SCOPE_INSUFFICIENT: insufficient scope for this call", ["gmail", "+triage"], "work");
    expect2(msg).toContain("work");
  });

  test2("unknown failure -> auth guidance but ALWAYS with the real detail attached", () => {
    const msg = classifyGwsFailure("", "something odd happened: quota exceeded maybe", ["gmail", "+triage"], "work");
    expect2(msg).toContain("quota exceeded");
  });
});
