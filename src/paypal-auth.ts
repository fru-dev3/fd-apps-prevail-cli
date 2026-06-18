// PayPal (and any OAuth2 client-credentials provider) token minter.
//
// Unlike oauth-flow.ts (authorization-code + PKCE, a per-user browser consent),
// PayPal's Transaction Search uses the client-credentials grant: the app's own
// Client ID + Secret are exchanged for a short-lived bearer token. There is no
// browser step — the ONE user action is pasting the Client ID + Secret (stored in
// the OS keychain by the desktop, then injected into the engine as env vars).
//
// We cache the minted token at <auth>/token.json with its expiry and refresh
// only when within a 5-minute margin, so a sync run never re-mints needlessly.
//
// SECURITY: the Client ID/Secret are read from env (keychain-backed), never from
// the vault; the cached token file is written 0600 and lives under ~/.prevail,
// not in the synced vault.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { authDir } from "./oauth-flow.ts";

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  access_token: string;
  expires_at: number; // epoch ms
  env: string; // "sandbox" | "live" — so a sandbox→live switch re-mints
}

function tokenPath(connectorId: string): string {
  return join(authDir(connectorId), "token.json");
}

// The PayPal token endpoint per environment. Default is live; "sandbox" routes to
// the sandbox host so test credentials work end-to-end.
function paypalTokenUrl(env: string): string {
  return env === "sandbox"
    ? "https://api-m.sandbox.paypal.com/v1/oauth2/token"
    : "https://api-m.paypal.com/v1/oauth2/token";
}

function readCache(connectorId: string): CachedToken | null {
  try {
    const raw = readFileSync(tokenPath(connectorId), "utf8");
    const c = JSON.parse(raw) as CachedToken;
    if (typeof c.access_token === "string" && typeof c.expires_at === "number") return c;
  } catch { /* no/invalid cache */ }
  return null;
}

function writeCache(connectorId: string, c: CachedToken): void {
  const dir = authDir(connectorId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(connectorId), JSON.stringify(c, null, 2), { mode: 0o600 });
}

/**
 * Mint (or return a cached) PayPal access token via the client-credentials grant.
 * Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV from the environment
 * (the desktop injects these from the keychain). Throws a clear error if the
 * credentials are missing or rejected — the connect flow surfaces that as the
 * real reason the connection isn't verified.
 */
export async function mintPaypalToken(connectorId = "paypal"): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const env = (process.env.PAYPAL_ENV || "live").toLowerCase();
  if (!id || !secret) {
    throw new Error("PayPal not authorized: missing Client ID / Secret. Add them in the app's connect card (developer.paypal.com → REST app with Transaction Search).");
  }
  const cached = readCache(connectorId);
  if (cached && cached.env === env && cached.expires_at - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return cached.access_token;
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(paypalTokenUrl(env), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PayPal token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let parsed: { access_token?: string; expires_in?: number };
  try { parsed = JSON.parse(text); } catch { throw new Error(`PayPal token response not JSON: ${text.slice(0, 200)}`); }
  if (!parsed.access_token) throw new Error(`PayPal token response had no access_token: ${text.slice(0, 200)}`);
  const expiresInMs = (parsed.expires_in ?? 0) * 1000;
  writeCache(connectorId, {
    access_token: parsed.access_token,
    expires_at: Date.now() + (expiresInMs > 0 ? expiresInMs : 8 * 3600 * 1000),
    env,
  });
  return parsed.access_token;
}
