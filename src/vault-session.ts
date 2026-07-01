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

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { decryptText, encryptText } from "./vault-crypto.ts";

let sessionDek: Buffer | null = null;
let sessionEncrypted = false;
// When set, only paths under this root are encrypted/decrypted — so a module
// that writes OUTSIDE the vault (e.g. a connector skill output to an arbitrary
// path) is never wrongly encrypted. Null = treat every path as in-vault (the
// back-compat default used by unit tests that operate on a single temp vault).
let sessionVaultRoot: string | null = null;

function inVault(path: string): boolean {
  if (!sessionVaultRoot) return true;
  const root = resolve(sessionVaultRoot);
  const p = resolve(path);
  return p === root || p.startsWith(root + "/");
}

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
  // The encrypted vault's root — only paths under it are transformed.
  sessionVaultRoot = env.PREVAIL_VAULT_ROOT && env.PREVAIL_VAULT_ROOT.length > 0
    ? env.PREVAIL_VAULT_ROOT
    : null;
}

/** Test/host hook: set the session key directly (optional vault root). */
export function setVaultSession(dek: Buffer | null, encrypted: boolean, vaultRoot: string | null = null): void {
  sessionDek = dek;
  sessionEncrypted = encrypted;
  sessionVaultRoot = vaultRoot;
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
  if (!sessionEncrypted || !sessionDek || !inVault(path)) return raw;
  return decryptText(sessionDek, raw);
}

/**
 * Write a vault file, encrypting the whole content when the session vault is
 * encrypted. Passthrough (== writeFileSync) otherwise. The write-side twin of
 * vreadFile for full-overwrite saves (state, manifest, journal rewrites).
 */
export function vwriteFile(path: string, content: string): void {
  if (!sessionEncrypted || !sessionDek || !inVault(path)) {
    writeFileSync(path, content);
    return;
  }
  writeFileSync(path, encryptText(sessionDek, content));
}

/**
 * Atomic vault write: write to a sibling temp file, then rename over the target.
 * A crash mid-write can only leave the temp file, never a truncated target, so
 * repeatedly-flushed files (e.g. a benchmark's incremental results.json) stay
 * complete and readable across a resume. Encryption is content-based, so the
 * encrypted bytes rename intact. Same-directory rename is atomic on one fs.
 */
export function vwriteFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Math.floor(performance.now())}.tmp`;
  try {
    vwriteFile(tmp, content);
    renameSync(tmp, path);
  } catch {
    // Rename/temp write failed: fall back to a direct write so the flush is
    // never dropped. Loses atomicity for this one write, but not the data.
    vwriteFile(path, content);
  }
}

/**
 * Append a line to an append-only ledger (usage/intents/decisions). You can't
 * append to an AES-GCM blob, so under encryption this is read-modify-write:
 * decrypt the whole file, append, re-encrypt. Plain append otherwise. Single
 * user / low contention, so the RMW cost is acceptable; concurrent writers
 * would need a lock (noted for the activation pass).
 */
export function vappendLine(path: string, line: string): void {
  if (!sessionEncrypted || !sessionDek || !inVault(path)) {
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

/**
 * Read ONLY the bytes of an append-only ledger after `byteOffset`, without
 * loading the whole file — the memory-safe path for the distiller, which only
 * ever needs the new tail past its cursor. Under encryption the file is one
 * AES-GCM blob that can't be seeked, so we must decrypt the whole thing and
 * slice (no win, but correct); the plaintext path does a true positional read.
 * Returns { slice, total } where `total` is the post-decrypt byte length, so a
 * caller can detect rotation/truncation when total < byteOffset.
 */
export function vreadTail(path: string, byteOffset: number): { slice: string; total: number } {
  if (sessionEncrypted && sessionDek && inVault(path)) {
    const buf = Buffer.from(decryptText(sessionDek, readFileSync(path, "utf8")), "utf8");
    if (byteOffset >= buf.length) return { slice: "", total: buf.length };
    return { slice: buf.slice(byteOffset).toString("utf8"), total: buf.length };
  }
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (byteOffset >= size) return { slice: "", total: size };
    const len = size - byteOffset;
    const out = Buffer.allocUnsafe(len);
    readSync(fd, out, 0, len, byteOffset);
    return { slice: out.toString("utf8"), total: size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Rotate an append-only ledger to keep it bounded. Moves the already-consumed
 * prefix into `archivePath` (append) and rewrites the ledger with only the
 * remaining tail. The cut is the SMALLER of `maxCutOffset` (the distiller's
 * cursor — never archive un-distilled records) and `plaintextLen - keepTailBytes`
 * (always keep a recent tail so skillgen/taskgen still see recent activity),
 * then snapped DOWN to a newline so a record is never split. Never deletes data
 * (the prefix is archived, not dropped). Returns the bytes removed from the
 * front (0 if nothing safe to rotate), so the caller decrements its cursor.
 * Encryption-aware; rotation is rare so the whole-file read/write is acceptable.
 */
export function vrotateLedgerPrefix(path: string, archivePath: string, maxCutOffset: number, keepTailBytes: number): number {
  if (maxCutOffset <= 0 || !existsSync(path)) return 0;
  const buf = Buffer.from(vreadFile(path), "utf8");
  let cut = Math.min(maxCutOffset, Math.max(0, buf.length - keepTailBytes));
  while (cut > 0 && buf[cut - 1] !== 0x0a) cut--; // snap to a complete record
  if (cut <= 0) return 0;
  vappendLine(archivePath, buf.slice(0, cut).toString("utf8")); // head ends in \n
  vwriteFile(path, buf.slice(cut).toString("utf8"));
  return cut;
}
