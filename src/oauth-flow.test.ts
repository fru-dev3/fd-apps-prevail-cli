import { describe, expect, test } from "bun:test";
import { runOAuthFlow, authDir } from "./oauth-flow.ts";

describe("runOAuthFlow — input validation", () => {
  test("missing client_id env var returns a clear error", async () => {
    delete process.env.NON_EXISTENT_CLIENT_ID;
    const r = await runOAuthFlow(
      "test-app",
      {
        client_id_env: "NON_EXISTENT_CLIENT_ID",
        auth_url: "https://example.com/auth",
        token_url: "https://example.com/token",
        scopes: ["read"],
        redirect_port: 53999,
      },
      { openBrowser: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain("NON_EXISTENT_CLIENT_ID");
  });

  test("redirect_port out of range rejected", async () => {
    const r = await runOAuthFlow(
      "test-app",
      {
        client_id: "x",
        auth_url: "https://example.com/auth",
        token_url: "https://example.com/token",
        scopes: ["read"],
        redirect_port: 80, // too low
      },
      { openBrowser: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/redirect_port/);
  });

  test("authDir() returns ~/.prevail path", () => {
    const d = authDir("my-app");
    expect(d).toMatch(/\.prevail\/connectors\/my-app\/auth$/);
  });
});

describe("runOAuthFlow — security", () => {
  test("times out cleanly when the user never completes the flow", async () => {
    // 100ms timeout — server starts, no one hits the callback, we get a
    // timeout error back (no hang).
    const t0 = Date.now();
    const r = await runOAuthFlow(
      "test-timeout",
      {
        client_id: "x",
        auth_url: "https://example.com/auth",
        token_url: "https://example.com/token",
        scopes: ["read"],
        redirect_port: 54000,
      },
      { openBrowser: () => {}, timeoutMs: 200 },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/timed out/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
