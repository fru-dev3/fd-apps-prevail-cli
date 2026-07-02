import { describe, expect, it } from "bun:test";

import {
  createKeyring,
  createKeyringWithRecovery,
  decryptText,
  deriveKey,
  encryptText,
  generateRecoveryCode,
  open,
  resetPasscodeWithRecovery,
  rewrapKeyring,
  seal,
  unwrapDek,
  unwrapDekWithRecovery,
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

describe("recovery code", () => {
  it("generates a grouped, readable code with no ambiguous chars", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(code).not.toMatch(/[ILOU]/); // Crockford base32 excludes these
  });

  it("recovers the SAME DEK as the passcode, and rejects a wrong code", () => {
    const { keyring, dek, recoveryCode } = createKeyringWithRecovery("my pass", "2026-06-09T00:00:00Z");
    // Passcode and recovery code both yield the same DEK.
    expect(unwrapDek("my pass", keyring).equals(dek)).toBe(true);
    expect(unwrapDekWithRecovery(recoveryCode, keyring).equals(dek)).toBe(true);
    // A wrong recovery code is rejected.
    expect(() => unwrapDekWithRecovery("WRONG-CODE-HERE-XXXXX-YYYYY-ZZZZZ", keyring)).toThrow(/wrong recovery code/);
  });

  it("a keyring without recovery throws on recovery unwrap", () => {
    const { keyring } = createKeyring("pw", "2026-06-09T00:00:00Z");
    expect(() => unwrapDekWithRecovery("anything", keyring)).toThrow(/no recovery code/);
  });

  it("survives a passcode change (rewrap preserves the recovery wrap)", () => {
    const { keyring, dek, recoveryCode } = createKeyringWithRecovery("old pass", "2026-06-09T00:00:00Z");
    const rewrapped = rewrapKeyring("old pass", "new pass", keyring, "2026-06-09T01:00:00Z");
    // The recovery code still unwraps the same DEK after a normal passcode change.
    expect(rewrapped.recovery).toBeDefined();
    expect(unwrapDekWithRecovery(recoveryCode, rewrapped).equals(dek)).toBe(true);
  });
});

describe("resetPasscodeWithRecovery (forgot-passcode escape)", () => {
  it("recovers the DEK and installs a new passcode", () => {
    const { keyring, dek, recoveryCode } = createKeyringWithRecovery("forgotten", "2026-06-09T00:00:00Z");
    const { keyring: next, dek: recovered } = resetPasscodeWithRecovery(
      recoveryCode,
      "brand new pass",
      keyring,
      "2026-06-09T02:00:00Z",
    );
    // Same DEK is recovered (files stay readable), returned for immediate unlock.
    expect(recovered.equals(dek)).toBe(true);
    // The old (forgotten) passcode no longer works; the new one does.
    expect(verifyKeyringPasscode("forgotten", next)).toBe(false);
    expect(unwrapDek("brand new pass", next).equals(dek)).toBe(true);
    // Salt rotated for the new passcode.
    expect(next.salt).not.toBe(keyring.salt);
    // The recovery code is preserved so it keeps working.
    expect(unwrapDekWithRecovery(recoveryCode, next).equals(dek)).toBe(true);
  });

  it("rejects a wrong recovery code without changing anything", () => {
    const { keyring } = createKeyringWithRecovery("pw", "2026-06-09T00:00:00Z");
    expect(() =>
      resetPasscodeWithRecovery("WRONG-XXXXX-YYYYY-ZZZZZ", "whatever", keyring, "2026-06-09T02:00:00Z"),
    ).toThrow(/wrong recovery code/);
  });

  it("throws when the keyring has no recovery wrap", () => {
    const { keyring } = createKeyring("pw", "2026-06-09T00:00:00Z");
    expect(() =>
      resetPasscodeWithRecovery("anything", "new", keyring, "2026-06-09T02:00:00Z"),
    ).toThrow(/no recovery code/);
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
