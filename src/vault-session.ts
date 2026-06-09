// Vault session key — the process-global Data-Encrypting Key for this engine
// invocation, plus the transparent read used by every vault read site.
//
// The engine runs as a short-lived process per command. When the vault is
// encrypted, the host (desktop sidecar, or a CLI unlock) passes the unwrapped
// DEK in via the PREVAIL_VAULT_KEY env var (base64) — never on argv. This module
// holds it for the life of the process and exposes `vreadFile`, which:
//   - decrypts when the vault is encrypted AND we hold the DEK, else
//   - returns the bytes unchanged (byte-identical to readFileSync).
//
// Because the unencrypted path is a pure passthrough, swapping readFileSync ->
// vreadFile at a read site cannot change behavior for a plaintext vault. That's
// what makes the migration safe to land incrementally.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { decryptText, encryptText } from "./vault-crypto.ts";

let sessionDek: Buffer | null = null;
let sessionEncrypted = false;

/** Initialize from the environment (called once at engine startup). */
export function initVaultSession(env: NodeJS.ProcessEnv = process.env): void {
  const b64 = env.PREVAIL_VAULT_KEY;
  if (b64 && b64.length > 0) {
    try {
      sessionDek = Buffer.from(b64, "base64");
      sessionEncrypted = sessionDek.length === 32;
      if (!sessionEncrypted) sessionDek = null;
    } catch {
      sessionDek = null;
      sessionEncrypted = false;
    }
  }
  // An explicit flag lets a host say "this vault is encrypted" even before a key
  // is supplied (so reads fail loudly rather than returning ciphertext).
  if (env.PREVAIL_VAULT_ENCRYPTED === "1") sessionEncrypted = true;
}

/** Test/host hook: set the session key directly. */
export function setVaultSession(dek: Buffer | null, encrypted: boolean): void {
  sessionDek = dek;
  sessionEncrypted = encrypted;
}

export function vaultSessionDek(): Buffer | null {
  return sessionDek;
}

export function isVaultSessionEncrypted(): boolean {
  return sessionEncrypted;
}

/**
 * Read a vault file as UTF-8, transparently decrypting when the session vault is
 * encrypted. Passthrough (== readFileSync) otherwise. The single function every
 * engine vault read site calls instead of readFileSync.
 */
export function vreadFile(path: string): string {
  const raw = readFileSync(path, "utf8");
  if (!sessionEncrypted || !sessionDek) return raw;
  return decryptText(sessionDek, raw);
}

/**
 * Write a vault file, encrypting the whole content when the session vault is
 * encrypted. Passthrough (== writeFileSync) otherwise. The write-side twin of
 * vreadFile for full-overwrite saves (state, manifest, journal rewrites).
 */
export function vwriteFile(path: string, content: string): void {
  if (!sessionEncrypted || !sessionDek) {
    writeFileSync(path, content);
    return;
  }
  writeFileSync(path, encryptText(sessionDek, content));
}

/**
 * Append a line to an append-only ledger (usage/intents/decisions). You can't
 * append to an AES-GCM blob, so under encryption this is read-modify-write:
 * decrypt the whole file, append, re-encrypt. Plain append otherwise. Single
 * user / low contention, so the RMW cost is acceptable; concurrent writers
 * would need a lock (noted for the activation pass).
 */
export function vappendLine(path: string, line: string): void {
  if (!sessionEncrypted || !sessionDek) {
    appendFileSync(path, line);
    return;
  }
  let current = "";
  if (existsSync(path)) {
    try {
      current = decryptText(sessionDek, readFileSync(path, "utf8"));
    } catch {
      current = "";
    }
  }
  writeFileSync(path, encryptText(sessionDek, current + line));
}
