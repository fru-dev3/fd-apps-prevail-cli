import { describe, expect, test } from "bun:test";
import { runGwsDoctor, type GwsAuthStatus } from "./gws-doctor.ts";

// The doctor must turn raw auth-status data into named remedial actions. Both
// the fetcher and the machine (binary presence + profiles) are injected, so
// these tests are hermetic: they pass on a box with zero gws state (CI) and on
// a developer machine with real accounts.
const MACHINE = {
  hasBinary: () => true,
  profiles: () => [{ label: "work", configDir: "/tmp/gws" }],
};
const HEALTHY: GwsAuthStatus = {
  user: "someone@example.com", token_valid: true, has_refresh_token: true,
  scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/tasks"],
  enabled_apis: ["calendar-json.googleapis.com", "gmail.googleapis.com", "drive.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com", "tasks.googleapis.com"],
  project_id: "p-123",
};

describe("gws doctor", () => {
  test("healthy account reports identity + token and stays quiet per service", () => {
    const out = runGwsDoctor(() => HEALTHY, MACHINE);
    expect(out).toContain("someone@example.com");
    expect(out).toContain("token valid");
    expect(out).not.toContain("DISABLED");
    expect(out).not.toContain("NOT granted");
  });

  test("disabled API names the service, project, and activation URL", () => {
    const out = runGwsDoctor(() => ({ ...HEALTHY, enabled_apis: ["gmail.googleapis.com"] }), MACHINE);
    expect(out).toContain("Calendar API is DISABLED");
    expect(out).toContain("project=p-123");
    expect(out).toContain("calendar-json.googleapis.com");
  });

  test("missing scope names the account re-authorization fix", () => {
    const out = runGwsDoctor(() => ({ ...HEALTHY, scopes: ["https://www.googleapis.com/auth/calendar"] }), MACHINE);
    expect(out).toContain("Gmail: scope NOT granted");
    expect(out).toContain("re-authorize");
  });

  test("keychain-style probe failure is named as a context problem", () => {
    const out = runGwsDoctor(() => ({ error: "SecKeychain: access denied for item gws" }), MACHINE);
    expect(out).toContain("PROBE FAILED");
    expect(out).toContain("Keychain");
  });
});
