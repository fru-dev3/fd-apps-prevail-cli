import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKeyring } from "./vault-crypto.ts";
import {
  initVaultSession,
  isVaultSessionEncrypted,
  setVaultSession,
  vappendLine,
  vreadFile,
  vwriteFile,
} from "./vault-session.ts";

afterEach(() => setVaultSession(null, false));

describe("initVaultSession from env", () => {
  it("ignores a missing or malformed key (stays plaintext)", () => {
    initVaultSession({});
    expect(isVaultSessionEncrypted()).toBe(false);
    initVaultSession({ PREVAIL_VAULT_KEY: "not-32-bytes" });
    expect(isVaultSessionEncrypted()).toBe(false);
  });
  it("activates with a valid 32-byte base64 key", () => {
    const { dek } = createKeyring("pw", "2026-06-09T00:00:00Z");
    initVaultSession({ PREVAIL_VAULT_KEY: dek.toString("base64") });
    expect(isVaultSessionEncrypted()).toBe(true);
    setVaultSession(null, false);
  });
});

describe("vwriteFile / vreadFile round-trip", () => {
  it("passthrough when not encrypted", () => {
    const f = join(mkdtempSync(join(tmpdir(), "prevail-vs-")), "a.md");
    vwriteFile(f, "# plain\n");
    expect(readFileSync(f, "utf8")).toBe("# plain\n"); // on disk plaintext
    expect(vreadFile(f)).toBe("# plain\n");
    rmSync(f, { force: true });
  });
  it("encrypts on disk and round-trips when a session DEK is set", () => {
    const { dek } = createKeyring("pw", "2026-06-09T00:00:00Z");
    setVaultSession(dek, true);
    const f = join(mkdtempSync(join(tmpdir(), "prevail-vs-")), "a.md");
    vwriteFile(f, "secret note\n");
    expect(readFileSync(f, "utf8")).not.toContain("secret note"); // ciphertext
    expect(vreadFile(f)).toBe("secret note\n");
    rmSync(f, { force: true });
  });
});

describe("path-awareness (only encrypt under the vault root)", () => {
  it("leaves files OUTSIDE the vault root untouched even when encrypted", () => {
    const root = mkdtempSync(join(tmpdir(), "prevail-root-"));
    const outside = mkdtempSync(join(tmpdir(), "prevail-out-"));
    const { dek } = createKeyring("pw", "2026-06-09T00:00:00Z");
    setVaultSession(dek, true, root);

    const inFile = join(root, "in.md");
    const outFile = join(outside, "out.md");
    vwriteFile(inFile, "vault note\n");
    vwriteFile(outFile, "external note\n");

    // In-vault is ciphertext; outside is left as plaintext (passthrough).
    expect(readFileSync(inFile, "utf8")).not.toContain("vault note");
    expect(readFileSync(outFile, "utf8")).toBe("external note\n");
    // And reads honor the same boundary.
    expect(vreadFile(inFile)).toBe("vault note\n");
    expect(vreadFile(outFile)).toBe("external note\n");

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("vappendLine (encrypted = read-modify-write)", () => {
  it("accumulates lines that decrypt to the full ledger", () => {
    const { dek } = createKeyring("pw", "2026-06-09T00:00:00Z");
    setVaultSession(dek, true);
    const f = join(mkdtempSync(join(tmpdir(), "prevail-vs-")), "ledger.jsonl");
    vappendLine(f, '{"n":1}\n');
    vappendLine(f, '{"n":2}\n');
    vappendLine(f, '{"n":3}\n');
    expect(readFileSync(f, "utf8")).not.toContain('"n":2'); // ciphertext on disk
    expect(vreadFile(f)).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    rmSync(f, { force: true });
  });
  it("plain append when not encrypted", () => {
    const f = join(mkdtempSync(join(tmpdir(), "prevail-vs-")), "ledger.jsonl");
    vappendLine(f, "a\n");
    vappendLine(f, "b\n");
    expect(readFileSync(f, "utf8")).toBe("a\nb\n");
    rmSync(f, { force: true });
  });
});
