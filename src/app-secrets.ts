// App secrets for headless runs. The desktop stores every app credential in the
// macOS Keychain (service "prevail.appsecrets", account = the exact env-var
// name the connector reads) and injects them as env vars when IT spawns the
// engine. A daemon or CLI started any other way (launchd, a terminal, the MCP
// server) never sees them, so its probes report "missing env vars" and its
// fetches run without credentials even though the user connected the app.
//
// readAppSecret closes that gap: process.env first, then (darwin only) the
// same Keychain item via the `security` CLI. Values are never logged. Hits are
// cached for the life of the process; misses only briefly, so a secret the
// user adds while the daemon is running shows up on the next tick.

import { spawnSync } from "node:child_process";

export const APP_SECRETS_SERVICE = "prevail.appsecrets";

// Only env-var-shaped names ever reach `security`: the name is a spawn arg,
// and a vault-resident manifest could otherwise smuggle anything in here.
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const LOOKUP_TIMEOUT_MS = 3000;
const MISS_TTL_MS = 60_000;

type Lookup = (key: string) => string | undefined;

function keychainLookup(key: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  // Escape hatch for CI and for users who never want a Keychain prompt.
  if (process.env.PREVAIL_NO_KEYCHAIN) return undefined;
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", APP_SECRETS_SERVICE, "-a", key, "-w"],
    { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return undefined;
  // `security -w` prints the value followed by one newline.
  const v = r.stdout.replace(/\r?\n$/, "");
  return v.length ? v : undefined;
}

let lookup: Lookup = keychainLookup;
const cache = new Map<string, { value: string | undefined; ts: number }>();

// The value of an app secret: process.env when set and non-empty, else the
// Keychain fallback. Undefined when neither has it.
export function readAppSecret(key: string): string | undefined {
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!ENV_NAME.test(key)) return undefined;
  const hit = cache.get(key);
  if (hit && (hit.value !== undefined || Date.now() - hit.ts < MISS_TTL_MS)) return hit.value;
  let value: string | undefined;
  try {
    value = lookup(key);
  } catch {
    value = undefined; // a Keychain failure is never fatal; the probe just reports "missing"
  }
  cache.set(key, { value, ts: Date.now() });
  return value;
}

// Test seam: replace the Keychain lookup (null restores the real one). Clears
// the cache so a stub takes effect immediately.
export function _setAppSecretLookupForTests(fn: Lookup | null): void {
  lookup = fn ?? keychainLookup;
  cache.clear();
}
