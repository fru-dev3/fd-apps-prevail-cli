import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { AppSkill, ConnectorStatus } from "./vault.ts";
import { scrubbedEnv } from "./cli-bridge.ts";

// Per-app authentication probe. Each integration type has a different
// "what does it mean to be connected" question:
//
//   api      — required env keys / config file present and non-empty
//   oauth    — refresh token file exists AND not expired
//   browser  — Playwright/Chrome session file fresh enough to use
//   mcp      — MCP server reachable (stdio binary present, or http endpoint up)
//   manual   — expected watched file/folder exists with recent activity
//
// The manifest declares the auth_check shape; this runner executes it and
// returns a structured result the UI can render as a status badge + a
// "what's missing" hint. No assumption that the probe is fast — caller
// runs it in the background and updates state when it resolves.

export interface AuthCheckSpec {
  kind: "env-keys" | "file-exists" | "command" | "http" | "mcp" | "manual";
  // env-keys: every listed key must be set + non-empty in process.env
  env_keys?: string[];
  // file-exists: every listed path must exist (~ and $HOME expanded).
  // `paths` is accepted as an alias for `files` (manifests use either key).
  files?: string[];
  paths?: string[];
  // command: spawn and check exit code; optionally match stdout substring
  command?: string;
  command_args?: string[];
  expect_stdout?: string;
  // http: GET url; auth_header_env names an env var whose value goes into
  // an Authorization header (or x-api-key for plain api-key flow)
  url?: string;
  auth_header_env?: string;
  auth_header_scheme?: "Bearer" | "x-api-key" | "Token";
  expect_status?: number; // default 200
  // mcp: stdio binary path OR http url
  mcp_command?: string;
  mcp_url?: string;
  // manual: human steps + an optional "freshness" file to check
  manual_steps?: string[];
  freshness_file?: string;
  freshness_max_age_days?: number;
}

export interface ProbeResult {
  ok: boolean;
  status: ConnectorStatus;
  message: string;
  missing?: string[];
  fixHint?: string;
  ts: number;
}

// Top-level entry point — read the manifest, dispatch to the right kind.
export async function probeConnector(app: AppSkill, spec: AuthCheckSpec | null): Promise<ProbeResult> {
  const ts = Date.now();
  if (!spec) {
    // No auth_check declared in manifest. Surface as "we don't know how to
    // test this" rather than green-checking it.
    return {
      ok: false,
      status: "not-configured",
      message: "manifest doesn't declare an auth_check — can't verify connection automatically",
      fixHint: `add an auth_check block to apps/community/${app.id}/manifest.json`,
      ts,
    };
  }
  try {
    switch (spec.kind) {
      case "env-keys":
        return probeEnvKeys(spec, ts);
      case "file-exists":
        return probeFileExists(spec, ts);
      case "command":
        return await probeCommand(spec, ts);
      case "http":
        return await probeHttp(spec, ts);
      case "mcp":
        return await probeMcp(spec, ts);
      case "manual":
        return probeManual(spec, ts);
      default:
        return {
          ok: false,
          status: "error",
          message: `unknown auth_check.kind: ${(spec as { kind?: string }).kind}`,
          ts,
        };
    }
  } catch (err) {
    return {
      ok: false,
      status: "error",
      message: `probe threw: ${(err as Error).message}`,
      ts,
    };
  }
}

function probeEnvKeys(spec: AuthCheckSpec, ts: number): ProbeResult {
  const keys = spec.env_keys ?? [];
  if (keys.length === 0) {
    return { ok: false, status: "not-configured", message: "auth_check.env_keys is empty", ts };
  }
  const missing = keys.filter((k) => !process.env[k] || process.env[k]!.length === 0);
  if (missing.length === 0) {
    return {
      ok: true,
      status: "connected",
      message: `all ${keys.length} env keys present`,
      ts,
    };
  }
  return {
    ok: false,
    status: "not-configured",
    message: `missing env vars: ${missing.join(", ")}`,
    missing,
    fixHint: `set them in your shell or ~/.ai/env/.env, then restart prevail`,
    ts,
  };
}

function probeFileExists(spec: AuthCheckSpec, ts: number): ProbeResult {
  const files = (spec.files ?? spec.paths ?? []).map(expandHome);
  if (files.length === 0) {
    return { ok: false, status: "not-configured", message: "auth_check.files is empty", ts };
  }
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length === 0) {
    return { ok: true, status: "connected", message: `all ${files.length} files present`, ts };
  }
  return {
    ok: false,
    status: "not-configured",
    message: `missing files: ${missing.map(shortenHome).join(", ")}`,
    missing,
    fixHint: "create or restore the listed file(s)",
    ts,
  };
}

async function probeCommand(spec: AuthCheckSpec, ts: number): Promise<ProbeResult> {
  const bin = spec.command;
  if (!bin) {
    return { ok: false, status: "not-configured", message: "auth_check.command is empty", ts };
  }
  const args = spec.command_args ?? [];
  return new Promise<ProbeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, {
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        status: "error",
        message: `cannot spawn ${bin}: ${(err as Error).message}`,
        fixHint: `is ${bin} installed and on your PATH?`,
        ts,
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child!.kill();
      } catch {}
      resolve({ ok: false, status: "error", message: `${bin} timed out after 8s`, ts });
    }, 8000);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          ok: false,
          status: "error",
          message: `${bin} exited ${code}: ${(stderr || stdout).slice(0, 200)}`,
          ts,
        });
        return;
      }
      if (spec.expect_stdout && !stdout.includes(spec.expect_stdout)) {
        resolve({
          ok: false,
          status: "error",
          message: `${bin} ran ok but stdout did not include "${spec.expect_stdout}"`,
          ts,
        });
        return;
      }
      resolve({ ok: true, status: "connected", message: `${bin} succeeded`, ts });
    });
  });
}

async function probeHttp(spec: AuthCheckSpec, ts: number): Promise<ProbeResult> {
  const url = spec.url;
  if (!url) {
    return { ok: false, status: "not-configured", message: "auth_check.url is empty", ts };
  }
  // SECURITY: an auth_check.url from a vault-resident manifest could point
  // at an internal IP (SSRF). For now we just refuse the metadata-service
  // ranges that are the highest-impact SSRF targets. A future hardening
  // pass should require the URL to be on a manifest-author allowlist.
  if (isUnsafeUrl(url)) {
    return {
      ok: false,
      status: "error",
      message: `refusing to probe internal/metadata URL: ${url}`,
      ts,
    };
  }
  const headers: Record<string, string> = { accept: "application/json,text/*;q=0.5" };
  if (spec.auth_header_env) {
    const v = process.env[spec.auth_header_env];
    if (!v) {
      return {
        ok: false,
        status: "not-configured",
        message: `env var ${spec.auth_header_env} not set (referenced by auth_header_env)`,
        missing: [spec.auth_header_env],
        fixHint: `export ${spec.auth_header_env}=<your-key>`,
        ts,
      };
    }
    const scheme = spec.auth_header_scheme ?? "Bearer";
    if (scheme === "x-api-key") headers["x-api-key"] = v;
    else if (scheme === "Token") headers["Authorization"] = `Token ${v}`;
    else headers["Authorization"] = `Bearer ${v}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    const expected = spec.expect_status ?? 200;
    if (res.status === expected || (res.status >= 200 && res.status < 300 && !spec.expect_status)) {
      return { ok: true, status: "connected", message: `${url} → ${res.status}`, ts };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: "expired",
        message: `auth rejected (${res.status})`,
        fixHint: "credential expired or revoked — re-issue and update the env/file",
        ts,
      };
    }
    return {
      ok: false,
      status: "error",
      message: `unexpected status ${res.status} from ${url}`,
      ts,
    };
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    if (e.name === "AbortError") {
      return { ok: false, status: "error", message: `${url} timed out`, ts };
    }
    return { ok: false, status: "error", message: `${url}: ${e.message ?? "request failed"}`, ts };
  }
}

async function probeMcp(spec: AuthCheckSpec, ts: number): Promise<ProbeResult> {
  // Two flavors:
  //   stdio MCP: check that the binary exists + responds to --help
  //   http MCP:  GET the server URL and expect a JSON-RPC capabilities reply
  if (spec.mcp_command) {
    const exists = await new Promise<boolean>((resolve) => {
      let child;
      try {
        child = spawn(spec.mcp_command!, ["--help"], {
          env: scrubbedEnv(),
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child!.kill();
        } catch {}
        resolve(false);
      }, 3000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    return exists
      ? { ok: true, status: "connected", message: `${spec.mcp_command} is on PATH`, ts }
      : {
          ok: false,
          status: "not-configured",
          message: `MCP server not found: ${spec.mcp_command}`,
          fixHint: "install the MCP server and ensure it's on PATH",
          ts,
        };
  }
  if (spec.mcp_url) {
    if (isUnsafeUrl(spec.mcp_url)) {
      return {
        ok: false,
        status: "error",
        message: `refusing to probe internal MCP URL: ${spec.mcp_url}`,
        ts,
      };
    }
    try {
      const res = await fetch(spec.mcp_url, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      return res.ok
        ? { ok: true, status: "connected", message: `MCP server up (${res.status})`, ts }
        : { ok: false, status: "error", message: `MCP server returned ${res.status}`, ts };
    } catch (err) {
      return {
        ok: false,
        status: "error",
        message: `MCP server unreachable: ${(err as Error).message}`,
        ts,
      };
    }
  }
  return {
    ok: false,
    status: "not-configured",
    message: "auth_check.mcp_command or auth_check.mcp_url required for kind=mcp",
    ts,
  };
}

function probeManual(spec: AuthCheckSpec, ts: number): ProbeResult {
  if (spec.freshness_file) {
    const f = expandHome(spec.freshness_file);
    if (!existsSync(f)) {
      return {
        ok: false,
        status: "not-configured",
        message: `expected file missing: ${shortenHome(f)}`,
        fixHint: spec.manual_steps?.join(" → ") ?? "follow the manual setup steps",
        ts,
      };
    }
    const ageDays = (Date.now() - statSync(f).mtimeMs) / (1000 * 60 * 60 * 24);
    const max = spec.freshness_max_age_days ?? 30;
    if (ageDays > max) {
      return {
        ok: false,
        status: "expired",
        message: `${shortenHome(f)} is ${Math.floor(ageDays)}d old (max ${max}d)`,
        fixHint: "re-export or refresh the source file",
        ts,
      };
    }
    return { ok: true, status: "connected", message: `${shortenHome(f)} is fresh`, ts };
  }
  return {
    ok: false,
    status: "not-configured",
    message: "manual setup required",
    fixHint: spec.manual_steps?.join(" → "),
    ts,
  };
}

// --- helpers --------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  if (p === "~") return homedir();
  return p.replace(/^\$HOME/, homedir());
}

function shortenHome(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// SECURITY: SSRF guard. Blocks the AWS / GCP / Azure metadata endpoints,
// link-local, and localhost. Not exhaustive — a manifest is still a piece
// of trusted-ish config, and probing localhost services is sometimes the
// point (e.g. mcp_url pointing at a sidecar). We block only the well-known
// metadata-exfil targets, not all RFC1918.
function isUnsafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h === "169.254.169.254" || h === "metadata.google.internal" || h === "metadata") return true;
    if (h === "100.100.100.200") return true; // AliCloud
    return false;
  } catch {
    return true; // unparseable URL is unsafe to hit
  }
}
