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
    callGoogleWorkspace({ args: SEND_ARGS }, VAULT, "general", "fru.dev");
    expect(lastQueuedAccount()).toBe("fru.dev");
  });

  test("an explicit tool-arg account overrides the launched --account", () => {
    callGoogleWorkspace({ args: SEND_ARGS, account: "alex.rivera" }, VAULT, "general", "fru.dev");
    expect(lastQueuedAccount()).toBe("alex.rivera");
  });

  test("no launched account and no tool-arg => default account (undefined)", () => {
    callGoogleWorkspace({ args: SEND_ARGS }, VAULT, "general", undefined);
    expect(lastQueuedAccount()).toBeUndefined();
  });
});
