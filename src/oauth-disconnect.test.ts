// O20 — connector disconnect / revoke tests. Redirects the config dir to a
// temp dir via PREVAIL_CONFIG_DIR so nothing touches the real ~/.prevail.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authDir, isConnected, disconnectConnector } from "./oauth-flow.ts";

let dir: string;
let prevEnv: string | undefined;

function connect(id: string) {
  const a = authDir(id);
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "refresh.token"), "secret-refresh-token");
  writeFileSync(join(a, "oauth.json"), JSON.stringify({ provider: "google", client_id: "x", token_url: "https://t", scopes: [] }));
}

beforeEach(() => {
  prevEnv = process.env.PREVAIL_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "prevail-oauth-"));
  process.env.PREVAIL_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("connector disconnect (O20)", () => {
  test("isConnected reflects token presence", () => {
    expect(isConnected("gmail")).toBe(false);
    connect("gmail");
    expect(isConnected("gmail")).toBe(true);
  });

  test("disconnect removes the local token dir", async () => {
    connect("gmail");
    const res = await disconnectConnector("gmail");
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(true);
    expect(res.revoked).toBe(false); // no revoke_url given
    expect(isConnected("gmail")).toBe(false);
    expect(existsSync(authDir("gmail"))).toBe(false);
  });

  test("disconnect on a never-connected id is a no-op success", async () => {
    const res = await disconnectConnector("ghost");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("not connected");
  });

  test("rejects a non-https revoke_url", async () => {
    connect("gmail");
    const res = await disconnectConnector("gmail", { revoke_url: "http://evil.test/revoke" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("https");
    // Local token NOT deleted because we bailed before removal.
    expect(isConnected("gmail")).toBe(true);
  });

  test("best-effort revoke POSTs to the endpoint then removes the token", async () => {
    connect("gmail");
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      return new Response("", { status: 200 });
    };
    try {
      const res = await disconnectConnector("gmail", { revoke_url: "https://oauth2.googleapis.com/revoke", client_id: "abc" });
      expect(res.revoked).toBe(true);
      expect(res.removed).toBe(true);
      expect(calls[0]).toBe("https://oauth2.googleapis.com/revoke");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(isConnected("gmail")).toBe(false);
  });

  test("revoke network failure still deletes the local token", async () => {
    connect("gmail");
    const realFetch = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => { throw new Error("network down"); };
    try {
      const res = await disconnectConnector("gmail", { revoke_url: "https://oauth2.googleapis.com/revoke" });
      expect(res.revoked).toBe(false);
      expect(res.removed).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(isConnected("gmail")).toBe(false);
  });
});
