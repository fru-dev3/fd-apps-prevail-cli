import { describe, expect, it } from "bun:test";

import {
  createKeyring,
  decryptText,
  deriveKey,
  encryptText,
  open,
  rewrapKeyring,
  seal,
  unwrapDek,
  verifyKeyringPasscode,
} from "./vault-crypto.ts";
import { randomBytes } from "node:crypto";

describe("seal/open (AES-256-GCM)", () => {
  it("round-trips arbitrary bytes", () => {
    const key = randomBytes(32);
    const msg = Buffer.from("the vault is mine alone");
    const blob = open(key, seal(key, msg));
    expect(blob.toString()).toBe("the vault is mine alone");
  });

  it("fails to decrypt with the wrong key (GCM auth)", () => {
    const blob = seal(randomBytes(32), Buffer.from("secret"));
    expect(() => open(randomBytes(32), blob)).toThrow();
  });

  it("fails if the ciphertext is tampered", () => {
    const key = randomBytes(32);
    const blob = seal(key, Buffer.from("secret"));
    const tampered = { ...blob, ct: Buffer.from("zzzz").toString("base64") };
    expect(() => open(key, tampered)).toThrow();
  });
});

describe("deriveKey (scrypt)", () => {
  it("is deterministic for the same passcode + salt", () => {
    const salt = randomBytes(16);
    expect(deriveKey("pass", salt).equals(deriveKey("pass", salt))).toBe(true);
  });
  it("differs for a different salt", () => {
    expect(deriveKey("pass", randomBytes(16)).equals(deriveKey("pass", randomBytes(16)))).toBe(false);
  });
});

describe("keyring (envelope encryption)", () => {
  it("unwraps the DEK with the right passcode", () => {
    const { keyring, dek } = createKeyring("correct horse", "2026-06-09T00:00:00Z");
    expect(verifyKeyringPasscode("correct horse", keyring)).toBe(true);
    expect(unwrapDek("correct horse", keyring).equals(dek)).toBe(true);
  });

  it("rejects the wrong passcode", () => {
    const { keyring } = createKeyring("correct horse", "2026-06-09T00:00:00Z");
    expect(verifyKeyringPasscode("wrong", keyring)).toBe(false);
    expect(() => unwrapDek("wrong", keyring)).toThrow(/wrong passcode/);
  });

  it("changes the passcode without changing the DEK (re-wrap only)", () => {
    const { keyring, dek } = createKeyring("old pass", "2026-06-09T00:00:00Z");
    const rewrapped = rewrapKeyring("old pass", "new pass", keyring, "2026-06-09T01:00:00Z");
    // Old passcode no longer works; new one recovers the SAME DEK.
    expect(verifyKeyringPasscode("old pass", rewrapped)).toBe(false);
    expect(unwrapDek("new pass", rewrapped).equals(dek)).toBe(true);
    // Salt rotated.
    expect(rewrapped.salt).not.toBe(keyring.salt);
  });
});

describe("file text encryption with the DEK", () => {
  it("round-trips a markdown file body", () => {
    const { dek } = createKeyring("pw1234", "2026-06-09T00:00:00Z");
    const md = "# Health\n\n- BP: fine\n- next checkup: soon\n";
    const onDisk = encryptText(dek, md);
    expect(onDisk).not.toContain("checkup"); // ciphertext, not plaintext
    expect(decryptText(dek, onDisk)).toBe(md);
  });
});
