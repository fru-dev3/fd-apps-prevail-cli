// Connected sources (metrics plan M3): each reader turns one source into
// content-free events. Every reader checks consent first (sources.ts).

import { ConsentError, recordSourceState, requireConsent, sourceDef } from "./sources.ts";

export interface SyncResult { state: string; events?: number; note?: string }
type Reader = (vault: string, opts: { backfill?: boolean; now?: number }) => Promise<SyncResult> | SyncResult;

export const READERS: Record<string, Reader> = {};

/** Run one source's reader on this Mac, if the user allowed it; records the outcome. */
export async function syncSource(vault: string, id: string, opts: { backfill?: boolean; now?: number } = {}): Promise<SyncResult> {
  if (!sourceDef(id)) return { state: "unknown source" };
  let r: SyncResult;
  try {
    requireConsent(vault, id);
    const reader = READERS[id];
    r = reader ? await reader(vault, opts) : { state: "no reader on this Mac" };
  } catch (e) {
    r = e instanceof ConsentError ? { state: "off", note: "turn it on in Sources" } : { state: "failed", note: String((e as Error).message ?? e).slice(0, 200) };
  }
  if (r.state !== "off") recordSourceState(vault, id, r);
  return r;
}
