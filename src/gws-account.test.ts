import { describe, expect, test } from "bun:test";
import {
  pickDefaultGwsAccount,
  resolveDefaultGwsAccount,
  resolveGwsAccounts,
  resolveGwsConfigDir,
  gwsSpawnEnv,
  type GwsProfile,
} from "./calendar-sync.ts";

// The generic principle under test: when a caller passes NO explicit account,
// resolution is strict and machine-agnostic - exactly one connected profile is
// used automatically (whatever its label; never a hard-coded address), and with
// several connected we NEVER guess between identities. An explicitly-picked
// account always wins.

const prof = (label: string): GwsProfile => ({ label, configDir: `/x/.config/${label === "default" ? "gws" : `gws-${label}`}` });

describe("pickDefaultGwsAccount — one connected account auto-targets; several never guess", () => {
  test("no connected profiles -> undefined (honest failure, nothing to target)", () => {
    expect(pickDefaultGwsAccount([])).toBeUndefined();
  });

  test("exactly one connected -> that account, whatever its label", () => {
    expect(pickDefaultGwsAccount([prof("work")])).toBe("work");
    expect(pickDefaultGwsAccount([prof("default")])).toBe("default");
  });

  test("two or more connected -> undefined (never guess between identities)", () => {
    expect(pickDefaultGwsAccount([prof("default"), prof("work")])).toBeUndefined();
    expect(pickDefaultGwsAccount([prof("home"), prof("work")])).toBeUndefined();
  });
});

describe("resolveGwsAccounts — the ask-the-user resolution", () => {
  test("none / single / ambiguous, with the connected labels surfaced", () => {
    expect(resolveGwsAccounts([])).toEqual({ kind: "none" });
    expect(resolveGwsAccounts([prof("work")])).toEqual({ kind: "single", label: "work" });
    expect(resolveGwsAccounts([prof("home"), prof("work")])).toEqual({ kind: "ambiguous", labels: ["home", "work"] });
  });
});

describe("gwsSpawnEnv — explicit account wins, default resolves to connected", () => {
  test("an explicit label sets that account's config dir", () => {
    const env = gwsSpawnEnv("work");
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR ?? "").toContain("gws-work");
  });

  test("an explicit \"default\" pins the gws default dir (no override)", () => {
    const env = gwsSpawnEnv("default");
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBeUndefined();
  });

  test("no account => the resolved connected default (self-consistent invariant)", () => {
    // resolveDefaultGwsAccount reads the live machine, so we don't hard-code a
    // value; we assert the spawn env matches what that resolution implies.
    const expectedDir = resolveGwsConfigDir(resolveDefaultGwsAccount());
    const env = gwsSpawnEnv();
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe(expectedDir as string | undefined);
    // PATH is always augmented regardless.
    expect(env.PATH).toBeTruthy();
  });
});
