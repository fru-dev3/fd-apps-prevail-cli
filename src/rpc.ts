// Minimal loopback RPC scaffold.
//
// This is a SAFE-by-default skeleton for the future desktop bridge. The
// desktop app (Memosa / a Tauri shell) needs a streaming-friendly local
// transport to drive engine functions (score, chat NDJSON, manifest reads)
// without re-implementing the engine in the UI process. This module stands
// up that transport — but only the bones for now:
//
//   - Binds to 127.0.0.1 ONLY (never 0.0.0.0). The bridge is for processes on
//     the same machine; it must never be reachable off-host.
//   - Port is random by default (0 → OS-assigned) or explicitly configurable.
//   - Exposes /health → {ok:true} and a /score STUB that documents the shape
//     to come without doing any real work yet.
//   - It is NOT wired into the daemon's autostart. Nothing calls startRpcServer
//     automatically; a human (or a later track) opts in.
//
// Bun's `Bun.serve` is the runtime here (the project already targets Bun — see
// package.json engines + tsconfig "types": ["bun"]).

import { logDebug } from "./debug-log.ts";

export interface RpcOptions {
  // Port to bind. 0 (default) lets the OS pick a free port — read the actual
  // port back off the returned handle.
  port?: number;
  // Hostname to bind. Defaults to 127.0.0.1 and SHOULD NOT be changed; the
  // option exists only so a test can pass "127.0.0.1" explicitly. Binding to
  // anything non-loopback is unsupported and the server refuses it.
  hostname?: string;
}

export interface RpcServer {
  // The actual bound port (resolved even when port 0 was requested).
  port: number;
  // The bound hostname (always loopback).
  hostname: string;
  // Convenience: the loopback base URL, e.g. "http://127.0.0.1:53124".
  url: string;
  // Stop the server. Idempotent.
  stop(): void;
}

const LOOPBACK = "127.0.0.1";

// Only loopback hostnames are permitted. This is the single security gate for
// the scaffold — refuse anything that could expose the bridge off-host.
function assertLoopback(hostname: string): void {
  if (hostname !== LOOPBACK && hostname !== "localhost") {
    throw new Error(
      `rpc: refusing to bind to non-loopback host "${hostname}" (loopback only)`,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Route a single request. Kept pure (request → response) so it can be unit
// tested without a live socket. Unknown routes return a 404 error envelope
// that mirrors the engine JSON error shape (docs/ENGINE-JSON-API.md).
export async function handleRpc(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // GET /health → liveness probe for the desktop bridge.
  if (path === "/health") {
    return json({ ok: true });
  }

  // POST /score → STUB. The real implementation will wrap the engine's score
  // function and stream / return a ContextScore (docs/schemas/ContextScore.json).
  // For now it advertises itself as not-yet-implemented so callers building
  // against the bridge get a stable, documented placeholder rather than a 404.
  if (path === "/score") {
    return json(
      {
        ok: false,
        error: "score route not implemented yet (scaffold stub)",
        code: "NOT_IMPLEMENTED",
      },
      501,
    );
  }

  return json(
    { ok: false, error: `no such route: ${path}`, code: "NOT_FOUND" },
    404,
  );
}

// Start the loopback RPC server. Returns a handle exposing the resolved port
// and a stop(). Throws only on a non-loopback bind request or if the runtime
// has no Bun.serve (i.e. not running under Bun) — both are programmer errors
// surfaced loudly, unlike the silent-catch convention used for best-effort
// background work elsewhere.
export function startRpcServer(opts: RpcOptions = {}): RpcServer {
  const hostname = opts.hostname ?? LOOPBACK;
  assertLoopback(hostname);
  const requestedPort = opts.port ?? 0;

  // Guard the Bun runtime dependency explicitly so the failure is legible
  // when someone runs this under plain node by mistake.
  const bun = (globalThis as { Bun?: typeof Bun }).Bun;
  if (!bun || typeof bun.serve !== "function") {
    throw new Error("rpc: Bun.serve unavailable (start the RPC server under Bun)");
  }

  const server = bun.serve({
    hostname,
    port: requestedPort,
    // Force loopback at the bind level too.
    fetch(req) {
      return handleRpc(req);
    },
    error(err: Error) {
      logDebug("rpc", "request handler error", { error: err.message });
      return json({ ok: false, error: "internal error", code: "INTERNAL" }, 500);
    },
  });

  // Bun types `server.port` as possibly undefined; in practice it's always a
  // number once serve() returns. Fall back to the requested port defensively.
  const boundPort = server.port ?? requestedPort;
  logDebug("rpc", "loopback server started", { hostname, port: boundPort });

  let stopped = false;
  return {
    port: boundPort,
    hostname,
    url: `http://${hostname}:${boundPort}`,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        server.stop(true);
      } catch (err) {
        logDebug("rpc", "stop failed", { error: (err as Error).message });
      }
    },
  };
}
