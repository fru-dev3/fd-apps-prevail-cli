import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { readMachineRole } from "./config.ts";
import { runtimePath } from "./path-safety.ts";

// =============================================================================
// Machine-role enforcement for a vault shared by two Macs.
//
// A hub (the always-on Mac mini) owns ALL background automation: the learn,
// loops and connector-sync daemons plus the heartbeat/schedule ticks. A client
// (a MacBook) runs interactive use plus prompt capture only, because transcripts
// only exist on the machine that created them. Every processing-daemon entry
// point calls guardHubOnly() and bails on a client. Capture is exempt.
// =============================================================================

/** The single message shown whenever a client machine is asked to run
 *  automation that only the hub should run. No em dashes (Prevail UI rule). */
export const CLIENT_ROLE_MESSAGE =
  "This machine is configured as a client. Automation for this vault runs on the hub. Run 'prevail role set hub' to change.";

/** True when this machine is a client (automation must not run here). */
export function isClientMachine(): boolean {
  return readMachineRole() === "client";
}

/** Guard for a processing-daemon entry point. On a client it prints the client
 *  message to stderr and returns true (caller should exit non-zero). On a hub it
 *  returns false and the caller proceeds. */
export function guardHubOnly(): boolean {
  if (isClientMachine()) {
    console.error(CLIENT_ROLE_MESSAGE);
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Optional, warning-only hub ownership marker. When a hub starts daemons it
// stamps build/_meta/hub.json with its hostname. If a DIFFERENT hostname later
// starts daemons as hub for the same vault, we log a loud warning but never
// hard-fail (two hubs is a misconfiguration, not a safety violation the way a
// client running automation is).
// -----------------------------------------------------------------------------

interface HubMarker {
  hostname: string;
  updatedAt: string;
}

function hubMarkerPath(vaultPath: string): string {
  return join(runtimePath(vaultPath, "_meta"), "hub.json");
}

/** Record this machine as the hub for `vaultPath`. Best-effort; warns (does not
 *  fail) when a different hostname previously claimed hub. Call only on a hub. */
export function claimHubOwnership(vaultPath: string): void {
  const host = hostname();
  const file = hubMarkerPath(vaultPath);
  try {
    if (existsSync(file)) {
      try {
        const prev = JSON.parse(readFileSync(file, "utf8")) as Partial<HubMarker>;
        if (prev.hostname && prev.hostname !== host) {
          console.warn(
            `[prevail] warning: another machine claimed hub for this vault (${prev.hostname}); now claiming from ${host}. Two hubs will double-run automation.`,
          );
        }
      } catch {
        /* unreadable marker: overwrite it below */
      }
    }
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const marker: HubMarker = { hostname: host, updatedAt: new Date().toISOString() };
    writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } catch {
    /* best effort: the marker is a warning aid, not a correctness dependency */
  }
}
