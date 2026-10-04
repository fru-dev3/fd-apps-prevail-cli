// Every credential below is invented for the test.
import { describe, expect, test } from "bun:test";
import { maskDeep, maskSecrets, redactSecrets } from "./secret-redact.ts";

describe("redactSecrets", () => {
  test("labelled passwords keep the label and the email, mask the value", () => {
    const s = "Sign-in username sam@example.com. Starter password: Maple-Tree-42! Then change it.";
    const r = redactSecrets(s);
    expect(r.text).toBe("Sign-in username sam@example.com. Starter password: [redacted]! Then change it.");
    expect(r.count).toBe(1);
    expect(maskSecrets("login sam@example.com password=Zz9qPlop")).toBe("login sam@example.com password=[redacted]");
    expect(maskSecrets("the wifi password is Hunter2Hunter")).toBe("the wifi password is [redacted]");
    expect(maskSecrets('passcode "4417 river"')).toBe('passcode "[redacted]"');
    expect(maskSecrets("passphrase - correct-horse-battery-9")).toBe("passphrase - [redacted]");
  });

  test("PINs need digits", () => {
    expect(maskSecrets("My PIN 8812 for the alarm")).toBe("My PIN [redacted] for the alarm");
    expect(maskSecrets("pin: 4321")).toBe("pin: [redacted]");
    expect(maskSecrets("pin the tab to the left")).toBe("pin the tab to the left");
  });

  test("ordinary prose about passwords and tokens is left alone", () => {
    for (const s of [
      "I need to reset my password tomorrow",
      "the password-protected PDF",
      "input tokens: 12000 and output tokens: 300",
      "max_tokens: 4096",
      "token budget is fine",
      "commit 3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f0a1",
      "id 123e4567-e89b-12d3-a456-426614174000",
      "/Users/sam/Documents/projects/some-long-folder-name/file.ts",
      "epoch 1783040000000",
      "call 612-555-0142",
    ]) expect(maskSecrets(s)).toBe(s);
  });

  test("API keys and tokens by shape", () => {
    const cases = [
      "sk-abcdefghijklmnop1234567890",
      "sk-ant-api03-ABCDEFGHijklmnop1234",
      "ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz0123",
      "xoxb-1234567890-abcdefghij",
      "AKIAABCDEFGHIJKLMNOP",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk",
    ];
    for (const c of cases) expect(maskSecrets(`use ${c} now`)).toBe("use [redacted] now");
    expect(maskSecrets("Authorization: Bearer abc.DEF-123_456789")).toBe("Authorization: Bearer [redacted]");
    // A long random run is a secret next to a credential word, an id elsewhere.
    expect(maskSecrets("the key Zq3vT8kLp2Wm9Xr4Bn7Yc1Hd6Fg5Js0Ua8Qe")).toBe("the key [redacted]");
    expect(maskSecrets("drive file 1Zq3vT8kLp2Wm9Xr4Bn7Yc1Hd6Fg5Js0Ua8Qe")).toBe("drive file 1Zq3vT8kLp2Wm9Xr4Bn7Yc1Hd6Fg5Js0Ua8Qe");
  });

  test("private keys and card numbers", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----";
    expect(maskSecrets(`key:\n${pem}\nend`)).toBe("key:\n[redacted]\nend");
    expect(maskSecrets("card 4111 1111 1111 1111 exp 12/29")).toBe("card [redacted] exp 12/29");
    expect(maskSecrets("card 4111111111111112")).toBe("card 4111111111111112"); // fails Luhn
    expect(maskSecrets("visa 4111111111111111")).toBe("visa [redacted]");
    expect(maskSecrets("order 4111111111111111")).toBe("order 4111111111111111");
    expect(maskSecrets("on 2026-09-26 1234 5678")).toBe("on 2026-09-26 1234 5678");
  });

  test("idempotent, and deep over records", () => {
    const once = maskSecrets("password: Maple-Tree-42 and sk-abcdefghijklmnop1234567890");
    expect(maskSecrets(once)).toBe(once);
    expect(redactSecrets(once).count).toBe(0);
    const d = maskDeep({ a: ["pin 9921"], b: { c: "fine" }, n: 3 });
    expect(d.value).toEqual({ a: ["pin [redacted]"], b: { c: "fine" }, n: 3 });
    expect(d.count).toBe(1);
  });
});

describe("secrets never enter the vault", () => {
  test("prompt capture (push and sync) and thread turns are masked on write", async () => {
    const { mkdtempSync, readFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { rmSync } = await import("node:fs");
    const { ingest, ingestBatch } = await import("./capture.ts");
    const { writeThreadTurn, threadJsonlPath } = await import("./session.ts");
    const root = join(homedir(), ".prevail-test-tmp");
    mkdirSync(root, { recursive: true });
    const vault = mkdtempSync(join(root, "redact-vault-"));
    mkdirSync(join(vault, "build", "_meta"), { recursive: true });
    const internal = process.env.PREVAIL_INTERNAL;
    delete process.env.PREVAIL_INTERNAL;
    const push = ingest({ vault, tool: "claude", prompt: "Set up Sam: Starter password: Invented-Pass-77", session: "s1", cwd: "/tmp" });
    if (internal !== undefined) process.env.PREVAIL_INTERNAL = internal;
    expect(push.reason ?? "written").toBe("written");
    expect(push.written).toBe(true);
    delete process.env.PREVAIL_INTERNAL;
    const batch = ingestBatch(vault, "claude", [{ prompt: "token: sk-abcdefghijklmnop1234567890", session: "s2" }]);
    if (internal !== undefined) process.env.PREVAIL_INTERNAL = internal;
    expect(batch.written).toBe(1);
    const body = readFileSync(push.path as string, "utf8");
    expect(body).not.toContain("Invented-Pass-77");
    expect(body).not.toContain("sk-abcdefghijklmnop");
    expect(body).toContain("Starter password: [redacted]");
    writeThreadTurn(vault, "general", "t1", { id: "a", parentId: null, role: "user", text: "pin 7710" } as never);
    expect(readFileSync(threadJsonlPath(vault, "general", "t1"), "utf8")).toContain("pin [redacted]");
    rmSync(vault, { recursive: true, force: true });
  });
});
