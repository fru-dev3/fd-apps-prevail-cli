import { describe, expect, test } from "bun:test";
import {
  pickDefaultGwsAccount,
  resolveDefaultGwsAccount,
  resolveGwsConfigDir,
  gwsSpawnEnv,
  type GwsProfile,
} from "./calendar-sync.ts";

// The generic principle under test: when a caller passes NO explicit account,
// gws must target a CONNECTED/authorized account rather than gws's arbitrary
// on-disk default. An explicitly-picked account always wins. This is what makes
// an attached Google app authenticate in a DOMAIN chat exactly as in the app's
// own chat.

const prof = (label: string): GwsProfile => ({ label, configDir: `/x/.config/${label === "default" ? "gws" : `gws-${label}`}` });

describe("pickDefaultGwsAccount — connected account, not gws's arbitrary default", () => {
  test("no connected profiles -> undefined (honest failure, nothing to target)", () => {
    expect(pickDefaultGwsAccount([])).toBeUndefined();
  });

  test("default profile connected -> undefined (use ~/.config/gws, unchanged)", () => {
    expect(pickDefaultGwsAccount([prof("default"), prof("work")])).toBeUndefined();
  });

  test("only a labeled account connected -> that account (the domain-chat fix)", () => {
    // The user authorized only "work" from the Google panel; the default dir is
    // empty. We must target "work", not let gws fall back to the empty default.
    expect(pickDefaultGwsAccount([prof("work")])).toBe("work");
  });

  test("multiple labeled accounts, none default -> the first (stable order)", () => {
    expect(pickDefaultGwsAccount([prof("home"), prof("work")])).toBe("home");
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
