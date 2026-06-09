// Vault encryption core — Feature 4, Phase 1.
//
// Envelope encryption with a dependency-free, audited stdlib stack:
//   - KDF: scrypt (memory-hard, Node built-in) derives a Key-Encrypting Key
//     (KEK) from the passcode + a random salt.
//   - A random 256-bit Data-Encrypting Key (DEK) actually encrypts vault files.
//     The DEK is wrapped (encrypted) by the KEK and stored in a keyring. This is
//     what lets a user change their passcode WITHOUT re-encrypting every file —
//     we only re-wrap the DEK.
//   - Cipher: AES-256-GCM (authenticated) per blob, random 12-byte IV each time.
//     Tampering or a wrong key fails the GCM auth tag (decrypt throws).
//
// This module is the CORE primitive set, fully unit-tested. Wiring it into every
// vault read/write across the engine (so the whole app operates on an encrypted
// vault) is the larger, separately-reviewed integration — see
// SECURITY-LOCK-PLAN.md. Nothing here is wired into live read/write paths yet.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const KEYRING_SCHEMA = "prevail.keyring/v1";

// scrypt cost params — N must be a power of two. These target ~tens of ms and a
// few MB; raise N for more resistance at the cost of latency.
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32; // 256-bit
const IV_LEN = 12; // GCM standard

/** Derive a 32-byte key from a passcode + salt (memory-hard scrypt). */
export function deriveKey(passcode: string, salt: Buffer): Buffer {
  // N=2^15,r=8 needs ~128*N*r = 32MB, just over Node's default 32MB maxmem cap,
  // so raise the cap explicitly.
  return scryptSync(passcode, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 64 * 1024 * 1024,
  });
}

export interface SealedBlob {
  iv: string; // base64
  ct: string; // base64 ciphertext
  tag: string; // base64 GCM auth tag
}

/** AES-256-GCM encrypt arbitrary bytes with a 32-byte key. */
export function seal(key: Buffer, plaintext: Buffer): SealedBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

/** AES-256-GCM decrypt. Throws if the key is wrong or the blob was tampered. */
export function open(key: Buffer, blob: SealedBlob): Buffer {
  const iv = Buffer.from(blob.iv, "base64");
  const ct = Buffer.from(blob.ct, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export interface Keyring {
  schema: typeof KEYRING_SCHEMA;
  kdf: "scrypt";
  salt: string; // base64 — for the KEK
  wrappedDek: SealedBlob; // the DEK, encrypted under the KEK
  // A verifier so we can reject a wrong passcode cleanly (rather than only via a
  // downstream GCM failure): encrypt a known constant under the KEK.
  check: SealedBlob;
  createdAt: string;
}

const CHECK_CONSTANT = Buffer.from("prevail-keyring-ok");

/** Create a fresh keyring for a new passcode: random DEK, wrapped under the KEK. */
export function createKeyring(passcode: string, createdAt: string): { keyring: Keyring; dek: Buffer } {
  const salt = randomBytes(16);
  const kek = deriveKey(passcode, salt);
  const dek = randomBytes(KEY_LEN);
  const keyring: Keyring = {
    schema: KEYRING_SCHEMA,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    wrappedDek: seal(kek, dek),
    check: seal(kek, CHECK_CONSTANT),
    createdAt,
  };
  return { keyring, dek };
}

/** True if `passcode` unlocks this keyring (constant-time on the check value). */
export function verifyKeyringPasscode(passcode: string, keyring: Keyring): boolean {
  try {
    const kek = deriveKey(passcode, Buffer.from(keyring.salt, "base64"));
    const got = open(kek, keyring.check);
    return got.length === CHECK_CONSTANT.length && timingSafeEqual(got, CHECK_CONSTANT);
  } catch {
    return false;
  }
}

/** Recover the DEK from a keyring with the correct passcode. Throws if wrong. */
export function unwrapDek(passcode: string, keyring: Keyring): Buffer {
  const kek = deriveKey(passcode, Buffer.from(keyring.salt, "base64"));
  if (!verifyKeyringPasscode(passcode, keyring)) {
    throw new Error("wrong passcode");
  }
  return open(kek, keyring.wrappedDek);
}

/**
 * Change the passcode WITHOUT re-encrypting any files: unwrap the DEK with the
 * old passcode, re-wrap it (and the check value) under a key derived from the
 * new passcode + a fresh salt.
 */
export function rewrapKeyring(oldPass: string, newPass: string, keyring: Keyring, createdAt: string): Keyring {
  const dek = unwrapDek(oldPass, keyring);
  const salt = randomBytes(16);
  const kek = deriveKey(newPass, salt);
  return {
    schema: KEYRING_SCHEMA,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    wrappedDek: seal(kek, dek),
    check: seal(kek, CHECK_CONSTANT),
    createdAt,
  };
}

// Convenience: encrypt/decrypt a UTF-8 file body with the DEK. The on-disk form
// is JSON (a SealedBlob) so it's self-describing and survives round-trips.
export function encryptText(dek: Buffer, text: string): string {
  return JSON.stringify(seal(dek, Buffer.from(text, "utf8")));
}
export function decryptText(dek: Buffer, blobJson: string): string {
  return open(dek, JSON.parse(blobJson) as SealedBlob).toString("utf8");
}
