import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Generic OAuth 2.0 + PKCE runner. Designed to cover the providers most
// people actually want connected to a personal-AI cockpit — Google (YouTube
// Analytics, Calendar, Drive, Gmail), GitHub (Apps), Notion, Linear, etc.
// Each provider's specifics (auth URL, token URL, scopes, optional extra
// query params) live in the connector manifest's "oauth" block; this
// module is generic over that shape.
//
// Security stance:
//   - Loopback-only HTTP server on 127.0.0.1 (never 0.0.0.0)
//   - PKCE S256 — a client_secret leak does NOT enable code interception
//   - state parameter is generated, compared, and rejected if missing/wrong
//   - refresh_token saved at ~/.prevail/connectors/<id>/auth/refresh.token
//     with chmod 0600
//   - 5-minute hard timeout on the loopback server so a stuck browser
//     never wedges the daemon

export interface OAuthSpec {
  provider?: string; // informational only
  client_id_env?: string; // env var holding the client_id
  client_secret_env?: string; // env var holding the client_secret (optional for public clients)
  // Some providers (Google web-app credentials) pass client_id inline in
  // the manifest because the value is per-installation. Env override wins.
  client_id?: string;
  auth_url: string;
  token_url: string;
  scopes: string[];
  // Loopback port to bind. Must match a pre-registered Authorized Redirect
  // URI in the provider's developer console.
  redirect_port: number;
  // Path portion of the redirect URI. Defaults to /callback.
  redirect_path?: string;
  // Optional extra query params to append to auth_url (e.g.
  // {"access_type":"offline","prompt":"consent"} for Google to force a
  // refresh_token on every consent).
  auth_extra_params?: Record<string, string>;
}

export interface FlowResult {
  ok: boolean;
  message: string;
  refreshTokenPath?: string;
}

interface PkceMaterial {
  verifier: string;
  challenge: string;
}

function pkcePair(): PkceMaterial {
  // 32 random bytes → 43-char base64url. RFC 7636 minimum is 43 chars.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function urlSafeRandom(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function authDir(connectorId: string): string {
  return join(homedir(), ".prevail", "connectors", connectorId, "auth");
}

function refreshTokenPath(connectorId: string): string {
  return join(authDir(connectorId), "refresh.token");
}

function oauthMetaPath(connectorId: string): string {
  return join(authDir(connectorId), "oauth.json");
}

// Run the full authorization-code-with-PKCE flow. Opens the browser to
// the provider's consent screen, listens for the redirect, exchanges the
// code, and persists the refresh token. Returns a result describing what
// happened so the CLI / TUI can render it.
export async function runOAuthFlow(
  connectorId: string,
  spec: OAuthSpec,
  opts: {
    timeoutMs?: number;
    openBrowser?: (url: string) => void;
    logger?: (line: string) => void;
  } = {},
): Promise<FlowResult> {
  const log = opts.logger ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  // Resolve client_id from env first (preferred), fall back to manifest
  // inline value. client_secret is env-only — never serialize it in the
  // manifest. PKCE means even public clients (no secret) work cleanly.
  const clientId = (spec.client_id_env && process.env[spec.client_id_env]) || spec.client_id;
  if (!clientId) {
    return {
      ok: false,
      message: `client_id missing. Set ${spec.client_id_env ?? "<client_id_env>"} or add client_id to the manifest oauth block.`,
    };
  }
  const clientSecret = spec.client_secret_env ? process.env[spec.client_secret_env] : undefined;

  const port = spec.redirect_port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, message: `redirect_port must be an integer in [1024, 65535] — got ${port}` };
  }
  const redirectPath = spec.redirect_path ?? "/callback";
  const redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
  const { verifier, challenge } = pkcePair();
  const state = urlSafeRandom(16);

  const authUrl = new URL(spec.auth_url);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", spec.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(spec.auth_extra_params ?? {})) {
    authUrl.searchParams.set(k, v);
  }

  // Spin up the loopback server. Bind explicitly to 127.0.0.1 — Bun.serve
  // defaults to 0.0.0.0 which would expose the callback to the LAN.
  let serverHandle: { stop(): void } | null = null;
  const codePromise = new Promise<string>((resolveCode, rejectCode) => {
    const timer = setTimeout(() => {
      try { serverHandle?.stop(); } catch {}
      rejectCode(new Error(`OAuth flow timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== redirectPath) {
          return new Response("Not the prevail OAuth callback. You can close this tab.", { status: 404 });
        }
        const err = u.searchParams.get("error");
        if (err) {
          clearTimeout(timer);
          setTimeout(() => server.stop(), 50);
          rejectCode(new Error(`provider returned error: ${err} — ${u.searchParams.get("error_description") ?? ""}`));
          return new Response(htmlPage("Authorization failed", `<p>The provider returned <code>${escapeHtml(err)}</code>. You can close this tab.</p>`), {
            headers: { "content-type": "text/html" },
            status: 400,
          });
        }
        const returnedState = u.searchParams.get("state");
        if (returnedState !== state) {
          clearTimeout(timer);
          setTimeout(() => server.stop(), 50);
          rejectCode(new Error("OAuth state mismatch — possible CSRF, refusing"));
          return new Response(htmlPage("State mismatch", "<p>OAuth state did not match. Aborting.</p>"), {
            headers: { "content-type": "text/html" },
            status: 400,
          });
        }
        const code = u.searchParams.get("code");
        if (!code) {
          clearTimeout(timer);
          setTimeout(() => server.stop(), 50);
          rejectCode(new Error("redirect did not include a code parameter"));
          return new Response(htmlPage("No code", "<p>No code in redirect. Aborting.</p>"), {
            headers: { "content-type": "text/html" },
            status: 400,
          });
        }
        clearTimeout(timer);
        // Resolve after a short delay so the response actually flushes.
        setTimeout(() => {
          server.stop();
          resolveCode(code);
        }, 50);
        return new Response(htmlPage("Connected!", "<p>You can close this tab and return to your terminal.</p>"), {
          headers: { "content-type": "text/html" },
        });
      },
    });
    serverHandle = server;
  });

  log(`opening browser to ${authUrl.origin}${authUrl.pathname}`);
  log(`if it doesn't open automatically, paste this URL into your browser:\n${authUrl.toString()}`);
  try {
    (opts.openBrowser ?? defaultOpenBrowser)(authUrl.toString());
  } catch {
    /* the user can still paste manually */
  }

  let code: string;
  try {
    code = await codePromise;
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  // Exchange code for tokens. PKCE means we need to include the verifier;
  // public clients omit client_secret.
  const tokenBody = new URLSearchParams();
  tokenBody.set("grant_type", "authorization_code");
  tokenBody.set("code", code);
  tokenBody.set("client_id", clientId);
  if (clientSecret) tokenBody.set("client_secret", clientSecret);
  tokenBody.set("redirect_uri", redirectUri);
  tokenBody.set("code_verifier", verifier);

  let tokenRes;
  try {
    tokenRes = await fetch(spec.token_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
  } catch (err) {
    return { ok: false, message: `token endpoint unreachable: ${(err as Error).message}` };
  }
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    return { ok: false, message: `token exchange failed (HTTP ${tokenRes.status}): ${body.slice(0, 300)}` };
  }
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (!tokens.refresh_token) {
    return {
      ok: false,
      message:
        "provider returned no refresh_token. For Google: add auth_extra_params: {access_type: 'offline', prompt: 'consent'} to the manifest oauth block.",
    };
  }

  ensureAuthDir(connectorId);
  const tokPath = refreshTokenPath(connectorId);
  writeFileSync(tokPath, tokens.refresh_token);
  try { chmodSync(tokPath, 0o600); } catch {}
  writeFileSync(
    oauthMetaPath(connectorId),
    JSON.stringify(
      {
        provider: spec.provider,
        client_id: clientId,
        token_url: spec.token_url,
        scopes: spec.scopes,
        saved_at: Date.now(),
      },
      null,
      2,
    ),
  );
  try { chmodSync(oauthMetaPath(connectorId), 0o600); } catch {}

  return {
    ok: true,
    message: `refresh token saved to ${shorten(tokPath)} (chmod 0600).`,
    refreshTokenPath: tokPath,
  };
}

// Exchange the stored refresh_token for a fresh access_token. Used at
// probe time and by any connector skill that needs a token. Does NOT
// cache — the caller decides how short-lived the access_token is.
export async function refreshAccessToken(connectorId: string): Promise<{ ok: boolean; accessToken?: string; expiresIn?: number; message?: string }> {
  const tokPath = refreshTokenPath(connectorId);
  if (!existsSync(tokPath)) {
    return { ok: false, message: `no refresh token at ${shorten(tokPath)} — run \`prevail connectors oauth ${connectorId}\` first` };
  }
  const metaPath = oauthMetaPath(connectorId);
  if (!existsSync(metaPath)) {
    return { ok: false, message: `oauth metadata missing at ${shorten(metaPath)} — re-run the oauth flow` };
  }
  const refresh = readFileSync(tokPath, "utf8").trim();
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
    client_id: string;
    token_url: string;
    scopes: string[];
  };
  // client_secret comes from the env spec — we don't store it on disk.
  // Caller's environment must still have it set. For PKCE-only providers
  // (no secret), this is fine.
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refresh);
  body.set("client_id", meta.client_id);
  const secretEnvCandidates = ["PREVAIL_OAUTH_CLIENT_SECRET", `PREVAIL_${(meta as { provider?: string }).provider?.toUpperCase() ?? "GOOGLE"}_CLIENT_SECRET`];
  for (const key of secretEnvCandidates) {
    const v = process.env[key];
    if (v) { body.set("client_secret", v); break; }
  }
  try {
    const res = await fetch(meta.token_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 400 || res.status === 401) {
        return { ok: false, message: `refresh token rejected (HTTP ${res.status}). Re-run \`prevail connectors oauth ${connectorId}\`.` };
      }
      return { ok: false, message: `token refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return { ok: false, message: "token endpoint returned no access_token" };
    return { ok: true, accessToken: json.access_token, expiresIn: json.expires_in };
  } catch (err) {
    return { ok: false, message: `token refresh failed: ${(err as Error).message}` };
  }
}

function ensureAuthDir(connectorId: string): void {
  const dir = authDir(connectorId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch {}
  }
}

function shorten(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} · prevAIl</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:80px auto;padding:32px;color:#222;background:#fafaf6}
h1{color:#C4A35A;margin:0 0 16px 0}p{line-height:1.5}code{background:#eee;padding:2px 6px;border-radius:3px}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function defaultOpenBrowser(url: string): void {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open"
    : platform === "win32" ? "cmd"
    : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* fall through — user pastes manually */
  }
}
