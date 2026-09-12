import { describe, expect, test, afterEach } from "bun:test";
import { readAppSecret, _setAppSecretLookupForTests } from "./app-secrets.ts";

// The Keychain itself is never touched here: the lookup is stubbed so these
// run the same on darwin, Linux CI, and a machine with no secrets stored.
afterEach(() => {
  _setAppSecretLookupForTests(null);
  delete process.env.APPSECRET_TEST_A;
});

describe("readAppSecret (headless Keychain fallback)", () => {
  test("process.env wins when set and non-empty; the Keychain is not consulted", () => {
    let calls = 0;
    _setAppSecretLookupForTests(() => { calls++; return "from-keychain"; });
    process.env.APPSECRET_TEST_A = "from-env";
    expect(readAppSecret("APPSECRET_TEST_A")).toBe("from-env");
    expect(calls).toBe(0);
  });

  test("falls back to the Keychain when the env var is unset or empty", () => {
    _setAppSecretLookupForTests((key) => (key === "APPSECRET_TEST_A" ? "from-keychain" : undefined));
    delete process.env.APPSECRET_TEST_A;
    expect(readAppSecret("APPSECRET_TEST_A")).toBe("from-keychain");
    process.env.APPSECRET_TEST_A = "";
    expect(readAppSecret("APPSECRET_TEST_A")).toBe("from-keychain");
  });

  test("a hit is cached for the process: one lookup, many reads", () => {
    let calls = 0;
    _setAppSecretLookupForTests(() => { calls++; return "v"; });
    expect(readAppSecret("APPSECRET_TEST_A")).toBe("v");
    expect(readAppSecret("APPSECRET_TEST_A")).toBe("v");
    expect(readAppSecret("APPSECRET_TEST_A")).toBe("v");
    expect(calls).toBe(1);
  });

  test("a miss is undefined and a throwing lookup is swallowed", () => {
    _setAppSecretLookupForTests(() => undefined);
    expect(readAppSecret("APPSECRET_TEST_A")).toBeUndefined();
    _setAppSecretLookupForTests(() => { throw new Error("security: item not found"); });
    expect(readAppSecret("APPSECRET_TEST_B")).toBeUndefined();
  });

  test("only env-var-shaped names reach the lookup (the name is a spawn arg)", () => {
    let calls = 0;
    _setAppSecretLookupForTests(() => { calls++; return "v"; });
    expect(readAppSecret("not a var")).toBeUndefined();
    expect(readAppSecret("-s")).toBeUndefined();
    expect(readAppSecret("lower_case")).toBeUndefined();
    expect(readAppSecret("")).toBeUndefined();
    expect(calls).toBe(0);
    expect(readAppSecret("PLAID_SECRET")).toBe("v");
    expect(calls).toBe(1);
  });
});
