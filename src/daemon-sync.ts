// The autonomous-sync daemon: keeps every connected app fresh, headlessly.
//
// PATTERN-FIRST: this loop knows nothing about any specific app. Each app is
// a folder with a manifest (refresh schedule, autonomy, domains, routes) and
// skill files; the skill's runner (cli / api / llm / browser / mcp) is the
// connection pattern. The daemon's job per app is always the same five steps:
//
//   due? -> probe auth -> run the refresh skill (+ chained after: skills)
//        -> route results into the target domains -> advance the cursor.
//
// Results are routed as `kind:"intent"` records into each target domain's
// _intents.jsonl, the SAME ledger every other surface writes — so the
// existing distiller folds synced data into memory/state with no extra
// machinery. Errors elevate into the domain's _tasks.md after 3 consecutive
// failures, once, so a broken connector becomes a visible task instead of a
// silent gap.

import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { AppSkill, AppRoute } from "./vault.ts";
import { scanCommunityApps, scanApps, scanVault } from "./vault.ts";
import { loadSkillsForConnector, runSkill, logSkillRun } from "./connector-skills.ts";
import type { SkillSpec, SkillRunResult } from "./connector-skills.ts";
import { probeConnector } from "./connector-probe.ts";
import type { AuthCheckSpec } from "./connector-probe.ts";
import { cadenceToCron } from "./heartbeat.ts";
import { nextRunWithin } from "./schedule.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { vreadFile, vappendLine } from "./vault-session.ts";

export interface SyncConfig {
  vaultPath: string;
  tickSec: number;        // loop tick (default 60)
  maxRunsPerTick: number; // cap concurrent model/API spend per tick (default 2)
}

export const DEFAULT_SYNC: Omit<SyncConfig, "vaultPath"> = {
  tickSec: 60,
  maxRunsPerTick: 2,
};

export interface SyncState {
  version: 1;
  last_run_ts: number | null;
  last_ok_ts: number | null;
  last_run_ok: boolean;
  last_error: string | null;
  consecutive_failures: number;
  next_due_ts: number | null;
  elevated: boolean;
  // The fetch gate. `connected` is NOT set on a probe pass or on a skill that
  // merely ran without error. It requires a real fetch that produced data at
  // least ONCE. This latches true the first time a sync yields >=1 non-secret
  // artifact OR a non-empty payload, and stays true thereafter (so a later
  // "nothing new since last cursor" sync keeps the app connected, not amber).
  first_fetch_ok: boolean;
  first_fetch_ts: number | null;
  cursor: Record<string, unknown>;
  runs: { ts: number; ok: boolean; skill: string; summary?: string; error?: string; duration_ms: number; artifacts: number }[];
}

const EMPTY_STATE: SyncState = {
  version: 1,
  last_run_ts: null,
  last_ok_ts: null,
  last_run_ok: false,
  last_error: null,
  consecutive_failures: 0,
  next_due_ts: null,
  elevated: false,
  first_fetch_ok: false,
  first_fetch_ts: null,
  cursor: {},
  runs: [],
};

// The fetch gate's predicate: did this run pull REAL data? True when it wrote
// >=1 non-secret artifact, or returned a non-empty payload (the runner's raw
// HTTP body / MCP tool content / LLM reply). A skill that "succeeds" but writes
// nothing and returns an empty body is NOT a verified connection.
export function producedRealData(result: SkillRunResult, artifacts: string[]): boolean {
  const raw = typeof result.raw === "string" ? result.raw.trim() : "";
  // INTEGRITY: a response that is an auth challenge, an error, a help/usage dump,
  // or "no data" is NEVER real data, even if some bytes or a (possibly empty) file
  // came back. This is what stops a connector from reading "verified" when the
  // user never actually logged in (the server answered with a "not authenticated"
  // / help message that the old check counted as success).
  if (raw && looksLikeAuthOrErrorResponse(raw)) return false;
  // A non-empty payload counts only if it carries actual content. Empty-shaped
  // JSON ([], {}, null, "") is not data.
  if (raw && !isEmptyShapedPayload(raw)) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v).length > 0;
      return v != null && String(v).trim().length > 0;
    } catch {
      // Non-JSON text that isn't an auth/error message is treated as real content.
      return true;
    }
  }
  // No usable payload: fall back to a real written artifact.
  return artifacts.length > 0;
}

// A trimmed payload that is structurally empty: [], {}, null, "", 0.
function isEmptyShapedPayload(raw: string): boolean {
  return /^(\[\s*\]|\{\s*\}|null|""|''|0)$/.test(raw.trim());
}

// Heuristic: does this response look like an auth challenge, an error, a help/
// usage dump, or an explicit "no data"? Kept deliberately conservative so it
// catches the common "you are not logged in" / error shapes without nuking
// legitimate data that merely mentions a word like "error" deep inside.
function looksLikeAuthOrErrorResponse(raw: string): boolean {
  const s = raw.trim();
  // Structured error/auth shapes in JSON.
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.error || o.errors || o.error_message) return true;
      if (typeof o.code === "number" && (o.code === 401 || o.code === 403)) return true;
      if (o.authenticated === false || o.authorized === false || o.ok === false || o.success === false) return true;
      const status = typeof o.status === "string" ? o.status.toLowerCase() : "";
      if (status === "error" || status === "unauthorized" || status === "unauthenticated") return true;
    }
  } catch { /* not JSON */ }
  // Text/markdown shapes: an auth challenge or help dump tends to LEAD with these.
  const head = s.slice(0, 400).toLowerCase();
  return (
    /\bnot (authenticated|authorized|logged[ -]?in|signed[ -]?in)\b/.test(head) ||
    /\b(unauthorized|unauthenticated|forbidden)\b/.test(head) ||
    /\b(please|you (must|need to)) (log|sign) ?in\b/.test(head) ||
    /\b(log|sign) ?in to (continue|your account|airbnb|credit karma)/.test(head) ||
    /\b(invalid|expired|missing) (token|credential|api[_ -]?key|session)\b/.test(head) ||
    /\bauthentication (failed|required)\b/.test(head) ||
    /\b(http )?(401|403)\b/.test(head) ||
    /^usage:\s/.test(head) ||
    /\bno (data|results|records|transactions) (found|available|yet)\b/.test(head)
  );
}

export function syncStatePath(app: AppSkill): string {
  return join(app.path, "sync-state.json");
}

export function readSyncState(app: AppSkill): SyncState {
  try {
    const raw = JSON.parse(vreadFile(syncStatePath(app))) as Partial<SyncState>;
    return { ...EMPTY_STATE, ...raw, cursor: raw.cursor ?? {}, runs: Array.isArray(raw.runs) ? raw.runs : [] };
  } catch {
    return { ...EMPTY_STATE, cursor: {}, runs: [] };
  }
}

export function writeSyncState(app: AppSkill, s: SyncState): void {
  try {
    writeFileSync(syncStatePath(app), JSON.stringify(s, null, 2));
  } catch { /* best effort */ }
}

// Mirror health into connection-status.json so every existing status surface
// (TUI sidebar, desktop Connectors page, probe UI) reflects sync results
// without learning a new file.
function mirrorConnectionStatus(app: AppSkill, status: string, lastSuccessTs: number | null, lastError?: string): void {
  try {
    const p = join(app.path, "connection-status.json");
    let prev: Record<string, unknown> = {};
    try { prev = JSON.parse(vreadFile(p)); } catch { /* fresh */ }
    writeFileSync(p, JSON.stringify({ ...prev, status, lastSuccessTs, lastError: lastError ?? null }, null, 2));
  } catch { /* best effort */ }
}

// Manifest refresh -> 5-field cron. "hourly"/"daily"/"weekly" (+ at/on) go
// through the shared cadenceToCron; "<N>h" intervals get a */N hour field.
export function refreshToCron(r: { every: string; at?: string; on?: string }): string | null {
  const m = r.every.match(/^(\d+)h$/);
  if (m) {
    const n = Math.max(2, Math.min(23, Number(m[1])));
    return `0 */${n} * * *`;
  }
  return cadenceToCron([r.every, r.on, r.at].filter(Boolean).join(" "));
}

// Exponential failure backoff: after N consecutive failures, push the next due
// time out (2^N * 5min, capped at 6h) so a broken connector doesn't hammer its
// API/portal every tick. Never earlier than the normal cron-derived `base`.
export function backoffNextDue(base: number, now: number, failures: number): number {
  if (failures <= 0) return base;
  const delay = Math.min(6 * 3600_000, Math.pow(2, Math.min(failures, 7)) * 5 * 60_000);
  return Math.max(base, now + delay);
}

// Minimal glob for routes[].match: ** crosses directories, * stays within one.
export function globMatch(pattern: string, path: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${rx}$`).test(path);
}

// Resolve a domain name to its directory under the vault (case-insensitive,
// matching how scanVault names domains).
function domainDirs(vaultPath: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const d of scanVault(vaultPath)) map.set(d.name.toLowerCase(), d.path);
  } catch { /* empty vault */ }
  return map;
}

// One intent record per target domain. The message is the run's ===SUMMARY===
// (or runner-built summary), capped, prefixed with the app identity so the
// distiller and the user can always tell where a fact came from.
function routeIntents(
  app: AppSkill,
  result: SkillRunResult,
  dirs: Map<string, string>,
  targets: string[],
): string[] {
  const routed: string[] = [];
  const summary = (result.summary ?? result.message).slice(0, 600);
  for (const domain of targets) {
    const dir = dirs.get(domain.toLowerCase());
    if (!dir) continue;
    const rec = JSON.stringify({
      kind: "intent",
      source: "sync",
      app: app.id,
      ts: Date.now(),
      domain,
      message: `[sync · ${app.account?.label ?? app.id}] ${summary}`,
      artifacts: (result.artifacts ?? []).slice(0, 20),
    });
    try {
      vappendLine(join(dir, "_intents.jsonl"), rec + "\n");
      routed.push(domain);
    } catch { /* domain dir read-only? skip */ }
  }
  return routed;
}

// Copy artifacts matched by copy:true routes into <vault>/<domain>/imports/
// with a provenance sidecar.
function copyRoutedArtifacts(
  app: AppSkill,
  result: SkillRunResult,
  routes: AppRoute[],
  dirs: Map<string, string>,
): number {
  let copied = 0;
  for (const rel of result.artifacts ?? []) {
    for (const route of routes) {
      if (!route.copy || !globMatch(route.match, rel)) continue;
      const dir = dirs.get(route.domain.toLowerCase());
      if (!dir) continue;
      const src = join(app.path, rel);
      if (!existsSync(src)) continue;
      const dest = join(dir, "imports", `${app.id}-${basename(rel)}`);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        writeFileSync(dest + ".meta.json", JSON.stringify({ source_app: app.id, original: rel, ingested_ts: Date.now() }, null, 2));
        copied++;
      } catch { /* skip */ }
    }
  }
  return copied;
}

// Elevate a persistent failure into each target domain's _tasks.md, once.
// Dedupe by the stable "Fix <app> sync" prefix so re-elevation after the flag
// resets doesn't stack duplicates of a still-open task.
function elevateFailure(app: AppSkill, error: string, dirs: Map<string, string>): void {
  const line = `- [ ] Fix ${app.id} sync: ${error.slice(0, 140)} ~source:sync +added:${new Date().toISOString().slice(0, 10)}`;
  for (const domain of app.domains) {
    const dir = dirs.get(domain.toLowerCase());
    if (!dir) continue;
    const tasksPath = join(dir, "_tasks.md");
    try {
      const existing = existsSync(tasksPath) ? vreadFile(tasksPath) : "";
      if (existing.includes(`- [ ] Fix ${app.id} sync:`)) continue; // still open
      vappendLine(tasksPath, line + "\n");
    } catch { /* skip */ }
  }
}

// NEVER let anything credential-shaped land inside the vault. Belt-and-
// suspenders check on artifact copies.
export function looksLikeSecretFile(name: string): boolean {
  return /token|secret|password|credential|\.pem$|\.key$/i.test(name);
}

interface RunOutcome {
  ok: boolean;
  error?: string;
  skillsRun: number;
}

// Run one app's refresh: the refresh skill plus any `after:` chained skills.
// activeConnection — if set, we first look for the matching connection entry's
// skill override before falling back to refresh.skill / trigger:refresh.
async function runAppRefresh(app: AppSkill, state: SyncState, activeConnection?: string): Promise<{ outcome: RunOutcome; results: SkillRunResult[] }> {
  const skills = loadSkillsForConnector(app);
  // Prefer the connection-specific skill override, then manifest refresh.skill,
  // then the first skill tagged trigger:refresh.
  const connSkillId = activeConnection
    ? app.connections?.find((c) => c.kind === activeConnection)?.skill
    : undefined;
  const primaryId = connSkillId ?? app.refresh?.skill;
  const primary =
    (primaryId && skills.find((s) => s.id === primaryId)) ||
    skills.find((s) => s.trigger === "refresh") ||
    null;
  if (!primary) {
    return { outcome: { ok: false, error: "no refresh skill (declare refresh.skill or a skill with trigger: refresh)", skillsRun: 0 }, results: [] };
  }

  const results: SkillRunResult[] = [];
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), 10 * 60_000);
  try {
    const chain: SkillSpec[] = [primary];
    // Append skills chained via after: (one level; chains of chains resolve
    // iteratively as long as each predecessor succeeded).
    let added = true;
    while (added) {
      added = false;
      for (const s of skills) {
        if (!s.after || chain.some((c) => c.id === s.id)) continue;
        // after may be comma-separated ("sync-inbox, sync-inbox-mcp, sync-inbox-cli")
        const afterIds = s.after.split(",").map((a) => a.trim());
        if (afterIds.some((aid) => chain.some((c) => c.id === aid))) {
          chain.push(s);
          added = true;
        }
      }
    }
    let cursor = { ...state.cursor };
    for (const spec of chain) {
      const r = await runSkill(spec, {}, { signal: ctl.signal, autonomy: app.autonomy ?? "read-only", cursor });
      logSkillRun(spec, r);
      results.push(r);
      if (!r.ok) {
        return { outcome: { ok: false, error: `${spec.id}: ${r.message}`, skillsRun: results.length }, results };
      }
      if (r.cursor) cursor = { ...cursor, ...r.cursor };
    }
    // Persist merged cursor onto the last result for the caller.
    const last = results[results.length - 1]!;
    last.cursor = cursor;
    return { outcome: { ok: true, skillsRun: results.length }, results };
  } finally {
    clearTimeout(killer);
  }
}

// Gateway sync. For apps connected via a gateway (Composio / Nango) there is no
// per-app skill; the app is fronted by the gateway's own MCP. We run ONE agent
// turn (claude, act:true so the Composio MCP is wired in by cli-bridge) prompting
// it to fetch the latest data for this toolkit and write a concise markdown
// summary into the app's OWN data folder. Then we hand back a SkillRunResult so
// the existing route/state machinery (fetch gate, first_fetch_ok, run history)
// works exactly like every other app.
//
// Defensive by design: if no gateway key is present (COMPOSIO_API_KEY /
// NANGO_SECRET_KEY), or the turn errors, we return ok:false with a clear message
// so the daemon records a failed run rather than crashing.
const GATEWAY_SUMMARY_FILE = "data/gateway-sync.md";

async function runGatewaySync(app: AppSkill): Promise<{ outcome: RunOutcome; results: SkillRunResult[] }> {
  const gw = app.gateway!;
  const started = Date.now();
  const fail = (error: string): { outcome: RunOutcome; results: SkillRunResult[] } => ({
    outcome: { ok: false, error, skillsRun: 0 },
    results: [{ ok: false, message: error, outputsWritten: [], durationMs: Date.now() - started }],
  });

  // Key gate: Composio needs COMPOSIO_API_KEY (so cli-bridge wires the MCP);
  // Nango needs NANGO_SECRET_KEY. No key => can't fetch; record a clear failure.
  const keyEnv = gw.provider === "composio" ? "COMPOSIO_API_KEY" : "NANGO_SECRET_KEY";
  if (!process.env[keyEnv] || !String(process.env[keyEnv]).trim()) {
    return fail(`${gw.provider} not configured: set ${keyEnv} to enable gateway sync`);
  }

  // The agent writes into the app's own data folder. Pass it the absolute target
  // path so the summary lands in data/apps/<id>/data/gateway-sync.md.
  const outAbs = join(app.path, GATEWAY_SUMMARY_FILE);
  try { mkdirSync(dirname(outAbs), { recursive: true }); } catch { /* best effort */ }

  const prompt = [
    `You are syncing the "${gw.toolkit}" app, connected through the ${gw.provider} gateway.`,
    gw.provider === "composio"
      ? `Use the available Composio MCP tools for the "${gw.toolkit}" toolkit to fetch the user's latest data (recent items, updates, or activity).`
      : `Use the Nango connection for the "${gw.toolkit}" toolkit (secret key is in the NANGO_SECRET_KEY env var; the REST API is at https://api.nango.dev) to fetch the user's latest data.`,
    `Then write a concise markdown summary of what you found to the file at this exact path:`,
    `  ${outAbs}`,
    `Keep the summary short and skimmable (a few bullets). If you genuinely cannot fetch any data (no connection, auth failed), write a one-line note saying so to that same file.`,
    `End your reply with a line starting "===SUMMARY===" followed by a one-paragraph summary of what you pulled.`,
  ].join("\n\n");

  let reply = "";
  try {
    const { runChatTurn, detectSubprocessClis } = await import("./cli-bridge.ts");
    // The Composio MCP wiring in cli-bridge is claude-only, so require a claude
    // binary. (Nango's agent path also rides claude here for a single contract.)
    const clis = detectSubprocessClis();
    const claude = clis.find((c) => c.kind === "claude");
    if (!claude) return fail("gateway sync needs the claude CLI on PATH");
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), 5 * 60_000);
    try {
      reply = await runChatTurn({
        prompt,
        cwd: app.path,
        cli: claude,
        model: "",
        isFirst: true,
        bare: true,
        act: true, // so cli-bridge injects the Composio MCP config
        signal: ctl.signal,
        maxOutputChars: 16_000,
      });
    } finally {
      clearTimeout(killer);
    }
  } catch (e) {
    return fail(`gateway agent turn failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The artifact is the markdown file IF the agent actually wrote it.
  const artifacts = existsSync(outAbs) ? [GATEWAY_SUMMARY_FILE] : [];
  const summary = extractGatewaySummary(reply);
  const result: SkillRunResult = {
    ok: true,
    message: summary || `${gw.provider}/${gw.toolkit} synced`,
    outputsWritten: artifacts,
    durationMs: Date.now() - started,
    raw: reply.slice(0, 8192),
    summary: summary || `${gw.provider}/${gw.toolkit} synced`,
    artifacts,
  };
  return { outcome: { ok: true, skillsRun: 1 }, results: [result] };
}

// Pull a ===SUMMARY=== block out of an agent reply, else the last non-empty line.
function extractGatewaySummary(text: string): string {
  const m = text.match(/===SUMMARY===\s*\n?([\s\S]*?)(?:\n===|$)/);
  if (m && m[1].trim()) return m[1].trim().slice(0, 600);
  const lines = text.trim().split("\n").filter((l) => l.trim());
  return (lines[lines.length - 1] ?? "").slice(0, 600);
}

// Dispatcher: gateway apps go through runGatewaySync (one agent turn over the
// gateway's MCP); everything else through the normal skill runner. Keeps both
// the scheduled (syncOnce) and manual (syncApp) paths on one branch point.
async function runAppRefreshOrGateway(app: AppSkill, state: SyncState, activeConnection?: string): Promise<{ outcome: RunOutcome; results: SkillRunResult[] }> {
  if (app.gateway) return runGatewaySync(app);
  return runAppRefresh(app, state, activeConnection);
}

// One pass over every app: run whatever is due, up to maxRunsPerTick.
export async function syncOnce(cfg: SyncConfig): Promise<{ ran: number; ok: number; failed: number }> {
  const apps = [...scanCommunityApps(), ...scanApps(cfg.vaultPath)].filter(
    // enabled === false means the user paused autonomous sync for this app; it
    // stays configured and still runs on an explicit "Sync now" (syncApp).
    (a) => a.refresh && a.status !== "not-configured" && a.enabled !== false,
  );
  const dirs = domainDirs(cfg.vaultPath);
  const now = Date.now();
  let ran = 0, ok = 0, failed = 0;

  for (const app of apps) {
    if (ran >= cfg.maxRunsPerTick) break;
    const state = readSyncState(app);
    const due = state.next_due_ts === null ? state.last_run_ts === null : now >= state.next_due_ts;
    if (!due) continue;

    const lock = tryAcquireLock(syncStatePath(app) + ".lock");
    if (!lock) continue; // another process is syncing this app right now
    ran++;
    try {
      // Auth first: a dead token should never burn a run or a model call. Gateway
      // apps (Composio/Nango) have no manifest auth_check - their key presence IS
      // the gate, enforced inside runGatewaySync - so skip the probe for them.
      const probe = app.gateway
        ? { ok: true, status: "connected" as const, message: "", ts: now, activeConnection: undefined }
        : await probeConnector(app, (app.authCheck as AuthCheckSpec | null) ?? null);
      const cron = refreshToCron(app.refresh!);
      const nextDue = cron ? nextRunWithin(cron, 8) : now + 24 * 3600_000;

      if (!probe.ok) {
        failed++;
        state.last_run_ts = now;
        state.last_run_ok = false;
        state.last_error = `auth: ${probe.message ?? "not connected"}`;
        state.consecutive_failures += 1;
        state.next_due_ts = backoffNextDue(nextDue, now, state.consecutive_failures);
        if (state.consecutive_failures >= 3 && !state.elevated) {
          elevateFailure(app, state.last_error, dirs);
          state.elevated = true;
        }
        state.runs = [...state.runs, { ts: now, ok: false, skill: "(auth probe)", error: state.last_error, duration_ms: 0, artifacts: 0 }].slice(-20);
        writeSyncState(app, state);
        mirrorConnectionStatus(app, "expired", app.lastSuccessTs, state.last_error);
        continue;
      }

      const { outcome, results } = await runAppRefreshOrGateway(app, state, probe.activeConnection);
      const last = results[results.length - 1];
      const durationMs = results.reduce((a, r) => a + r.durationMs, 0);
      const artifacts = results.flatMap((r) => r.artifacts ?? []).filter((p) => !looksLikeSecretFile(p));

      if (outcome.ok && last) {
        ok++;
        // Route: explicit routes win; default is one intent per domains[] entry.
        const combined: SkillRunResult = { ...last, artifacts };
        const targets = app.routes?.length ? [...new Set(app.routes.map((r) => r.domain))] : app.domains;
        routeIntents(app, combined, dirs, targets);
        if (app.routes?.length) copyRoutedArtifacts(app, combined, app.routes, dirs);
        state.cursor = last.cursor ?? state.cursor;
        state.last_run_ok = true;
        state.last_error = null;
        state.consecutive_failures = 0;
        state.elevated = false;
        // The fetch gate: latch first_fetch_ok the first time we pull real data.
        if (!state.first_fetch_ok && producedRealData(last, artifacts)) {
          state.first_fetch_ok = true;
          state.first_fetch_ts = now;
        }
        // Only a verified-by-fetch app goes green. A clean run that has not yet
        // produced any data stays "configured" (renders as authorized·verifying)
        // and deliberately does NOT advance lastSuccessTs.
        if (state.first_fetch_ok) {
          state.last_ok_ts = now;
          mirrorConnectionStatus(app, "connected", now);
        } else {
          mirrorConnectionStatus(app, "configured", state.last_ok_ts);
        }
      } else {
        failed++;
        state.last_run_ok = false;
        state.last_error = outcome.error ?? "unknown failure";
        state.consecutive_failures += 1;
        if (state.consecutive_failures >= 3 && !state.elevated) {
          elevateFailure(app, state.last_error, dirs);
          state.elevated = true;
        }
        mirrorConnectionStatus(app, "error", app.lastSuccessTs, state.last_error);
      }
      state.last_run_ts = now;
      // Backoff applies on failure (consecutive_failures>0); a success resets it
      // to 0 above, so this is the normal cron-derived time on success.
      state.next_due_ts = backoffNextDue(nextDue, now, state.consecutive_failures);
      state.runs = [...state.runs, {
        ts: now,
        ok: outcome.ok,
        skill: app.refresh?.skill ?? "(refresh)",
        summary: last?.summary?.slice(0, 200),
        error: outcome.ok ? undefined : state.last_error ?? undefined,
        duration_ms: durationMs,
        artifacts: artifacts.length,
      }].slice(-20);
      writeSyncState(app, state);
    } finally {
      lock.release();
    }
  }
  return { ran, ok, failed };
}

// Sync ONE app on demand (the "Sync now" button), regardless of schedule.
// Reuses the same probe → run → route → state machinery as syncOnce.
export async function syncApp(cfg: SyncConfig, id: string): Promise<{ ok: boolean; error?: string; artifacts: number }> {
  const app = [...scanCommunityApps(), ...scanApps(cfg.vaultPath)].find((a) => a.id === id);
  if (!app) return { ok: false, error: `no app "${id}"`, artifacts: 0 };
  if (!app.refresh) return { ok: false, error: `app "${id}" has no refresh config yet`, artifacts: 0 };
  const dirs = domainDirs(cfg.vaultPath);
  const now = Date.now();
  const state = readSyncState(app);

  // Gateway apps have no manifest auth_check (the key presence is the gate,
  // enforced inside runGatewaySync) - skip the probe for them.
  const probe = app.gateway
    ? { ok: true, status: "connected" as const, message: "", ts: now, activeConnection: undefined }
    : await probeConnector(app, (app.authCheck as AuthCheckSpec | null) ?? null);
  if (!probe.ok) {
    state.last_run_ts = now;
    state.last_run_ok = false;
    state.last_error = `auth: ${probe.message ?? "not connected"}`;
    state.consecutive_failures += 1;
    writeSyncState(app, state);
    mirrorConnectionStatus(app, "expired", app.lastSuccessTs, state.last_error);
    return { ok: false, error: state.last_error, artifacts: 0 };
  }

  const { outcome, results } = await runAppRefreshOrGateway(app, state, probe.activeConnection);
  const last = results[results.length - 1];
  const durationMs = results.reduce((a, r) => a + r.durationMs, 0);
  const artifacts = results.flatMap((r) => r.artifacts ?? []).filter((p) => !looksLikeSecretFile(p));

  if (outcome.ok && last) {
    const combined: SkillRunResult = { ...last, artifacts };
    const targets = app.routes?.length ? [...new Set(app.routes.map((r) => r.domain))] : app.domains;
    routeIntents(app, combined, dirs, targets);
    if (app.routes?.length) copyRoutedArtifacts(app, combined, app.routes, dirs);
    state.cursor = last.cursor ?? state.cursor;
    state.last_run_ts = now;
    state.last_run_ok = true;
    state.last_error = null;
    state.consecutive_failures = 0;
    state.elevated = false;
    // The fetch gate (same as syncOnce): a clean run only counts as "connected"
    // once it has actually pulled data; until then it's "configured"/verifying.
    const verified = producedRealData(last, artifacts);
    if (!state.first_fetch_ok && verified) {
      state.first_fetch_ok = true;
      state.first_fetch_ts = now;
    }
    if (state.first_fetch_ok) state.last_ok_ts = now;
    // Record the run so the per-app history reflects manual "Sync now" too,
    // not only autonomous daemon ticks. Same bounded ring as syncOnce.
    state.runs = [...state.runs, {
      ts: now, ok: true, skill: app.refresh?.skill ?? "(refresh)",
      summary: last.summary?.slice(0, 200), duration_ms: durationMs, artifacts: artifacts.length,
    }].slice(-20);
    writeSyncState(app, state);
    mirrorConnectionStatus(app, state.first_fetch_ok ? "connected" : "configured", state.last_ok_ts);
    // ok reflects the FETCH GATE, not merely "the skill ran". A first sync that
    // completes cleanly but pulls no data is authorized-but-not-yet-verified,
    // report that honestly instead of as a hard failure.
    return state.first_fetch_ok
      ? { ok: true, artifacts: artifacts.length }
      : { ok: false, error: "connected, but no data pulled yet (not verified)", artifacts: 0 };
  }

  state.last_run_ts = now;
  state.last_run_ok = false;
  state.last_error = outcome.error ?? "unknown failure";
  state.consecutive_failures += 1;
  state.runs = [...state.runs, {
    ts: now, ok: false, skill: app.refresh?.skill ?? "(refresh)",
    error: state.last_error ?? undefined, duration_ms: durationMs, artifacts: 0,
  }].slice(-20);
  writeSyncState(app, state);
  mirrorConnectionStatus(app, "error", app.lastSuccessTs, state.last_error);
  return { ok: false, error: state.last_error, artifacts: 0 };
}

// The daemon loop. Runs alongside --learn/--brief in the same process.
export async function runSyncDaemon(cfg: SyncConfig): Promise<void> {
  const tick = Math.max(30, cfg.tickSec) * 1000;
  console.log(`[sync] watching connectors for ${cfg.vaultPath} (tick ${Math.round(tick / 1000)}s, max ${cfg.maxRunsPerTick}/tick)`);
  while (true) {
    try {
      const { ran, ok, failed } = await syncOnce(cfg);
      if (ran > 0) console.log(`[sync] ran ${ran} connector${ran === 1 ? "" : "s"}: ${ok} ok, ${failed} failed`);
    } catch (e) {
      console.error(`[sync] pass error: ${e}`);
    }
    await new Promise((r) => setTimeout(r, tick));
  }
}
