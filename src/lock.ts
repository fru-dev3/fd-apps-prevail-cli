// App lock — Feature 4, Phase 0 (passcode gate; NOT yet at-rest encryption).
//
// A passcode that gates opening Prevail. We store ONLY an Argon2id verifier
// (via Bun's built-in password hashing — memory-hard, no external dep), never
// the passcode itself and never a key derived from it. Phase 0 deliberately
// does NOT encrypt vault files — turning this on locks the app UI but the
// markdown on disk is still readable, so the UI must say so. At-rest encryption
// (Phase 1) is a separate, security-reviewed effort (see SECURITY-LOCK-PLAN.md).
//
// Verifier lives at ~/.prevail/lock.json, chmod 600, separate from config.json
// so it's easy to reason about and back up independently.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configDir } from "./config.ts";

export const LOCK_SCHEMA = "prevail.lock/v1";

export interface LockFile {
  schema: typeof LOCK_SCHEMA;
  algorithm: "argon2id";
  // The Argon2id PHC-string verifier (contains its own salt + params).
  verifier: string;
  createdAt: string;
}

// The path is injectable so tests never touch the real ~/.prevail/lock.json.
export function lockFilePath(): string {
  return join(configDir(), "lock.json");
}

export function isLockSet(file: string = lockFilePath()): boolean {
  return existsSync(file);
}

export function readLock(file: string = lockFilePath()): LockFile | null {
  if (!existsSync(file)) return null;
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as LockFile;
    if (f.schema !== LOCK_SCHEMA || !f.verifier) return null;
    return f;
  } catch {
    return null;
  }
}

/** Set (or replace) the app passcode. Stores only an Argon2id verifier. */
export async function setPasscode(
  passcode: string,
  createdAt: string,
  file: string = lockFilePath(),
): Promise<void> {
  if (!passcode || passcode.length < 4) {
    throw new Error("passcode must be at least 4 characters");
  }
  const verifier = await Bun.password.hash(passcode, { algorithm: "argon2id" });
  const lock: LockFile = { schema: LOCK_SCHEMA, algorithm: "argon2id", verifier, createdAt };
  writeFileSync(file, JSON.stringify(lock, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

/** Verify a passcode against the stored verifier. False if no lock is set. */
export async function verifyPasscode(
  passcode: string,
  file: string = lockFilePath(),
): Promise<boolean> {
  const lock = readLock(file);
  if (!lock) return false;
  try {
    return await Bun.password.verify(passcode, lock.verifier);
  } catch {
    return false;
  }
}

/** Remove the passcode (requires the current one to have been verified by the
 *  caller — this just deletes the verifier). */
export function clearLock(file: string = lockFilePath()): void {
  if (existsSync(file)) rmSync(file);
}
