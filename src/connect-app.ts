import { detectClis, runChatTurn } from "./cli-bridge.ts";
import { scanVault, scaffoldCommunityApp, scanApps } from "./vault.ts";
import { probeConnector, type AuthCheckSpec } from "./connector-probe.ts";

// The Connection Agent, extracted so BOTH the CLI (`prevail connectors connect`)
// and the MCP server (`app_connect` tool) drive the exact same flow: research
// the best way to connect an app right now, scaffold it into the vault, and
// return a plan with the ONE auth step the user must do (plus an autonomous
// verify when no user action is required).

export interface ConnectAppArgs {
  vaultPath: string;
  name: string;
  goal?: string;
  provider?: string; // cli kind; defaults to first detected
  model?: string;
  reevaluate?: boolean; // research-only: report a better method without scaffolding
  current?: string; // current integration, for a meaningful re-evaluation
}

export interface ConnectAppResult {
  ok: boolean;
  plan?: Record<string, unknown>;
  path?: string;
  error?: string;
  verified?: boolean | null;
  proof?: string | null;
  reevaluated?: boolean;
  raw?: string;
}

export async function connectApp(a: ConnectAppArgs): Promise<ConnectAppResult> {
  const name = a.name;
  const goal = a.goal ?? "";
  const provider = a.provider ?? "claude";
  const model = a.model ?? "";
  const reevaluate = !!a.reevaluate;
  const current = a.current ?? "";
  const domainNames = scanVault(a.vaultPath).map((d) => d.name);
  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === provider) ?? clis[0];
  if (!cli) return { ok: false, error: "no CLI available" };
  const prompt = [
    `You are Prevail's Connection Agent. The user wants to connect an app so it syncs real data into their personal life-OS vault on a schedule.`,
    `APP: ${name}`,
    `GOAL: ${goal || "(pull the most useful data this app offers)"}`,
    `THE USER'S DOMAINS: ${domainNames.join(", ") || "(none yet)"}`,
    reevaluate && current ? `\nThis app is ALREADY connected via "${current}". Re-check whether a BETTER method exists now; if "${current}" is still best, return it.` : "",
    "",
    `Determine the BEST available way to connect this app RIGHT NOW. Prefer headless, in this order: an MCP server > an official API/SDK or an already-installed CLI (e.g. gcloud, gh) > the Composio gateway > browser automation (a one-time login is acceptable). Use web search to check what actually exists today for this specific app.`,
    "",
    `Also provide an auth_check: a CONCRETE test Prevail can run to VERIFY the connection works, so the user doesn't have to. For an installed CLI use {"kind":"command","command":"gh","args":["auth","status"]} (exits 0 iff authed). For an HTTP API use {"kind":"http","url":"<a lightweight authed GET endpoint>","auth_header_env":"PREVAIL_<APP>_KEY","expect_status":200}. If nothing can be tested without a secret the user hasn't provided yet, omit it (kind "none").`,
    "",
    `Return ONLY a JSON object (no prose, no fences):`,
    `{"app_id":"kebab-case-id","title":"display name","integration":"mcp|api|cli|composio|browser","why":"one line: why this is the best method now","auth_step":{"kind":"none|oauth-cli|api-key|browser-login|manual","instruction":"the ONE thing the user must do to authorize, or empty if none"},"auth_check":{"kind":"command|http|none","command":"","args":[],"url":"","auth_header_env":"","expect_status":200},"schedule":{"every":"1d"},"domains":["which of the user's domains this should feed"],"data":"one line: what it will pull in"}`,
  ].join("\n");
  const out = await runChatTurn({ prompt, cwd: a.vaultPath, cli, model, isFirst: true, bare: true, act: true });
  const s = out.indexOf("{");
  const e = out.lastIndexOf("}");
  let plan: Record<string, unknown> | null = null;
  if (s >= 0 && e > s) {
    try { plan = JSON.parse(out.slice(s, e + 1)); } catch { plan = null; }
  }
  if (!plan || typeof plan.app_id !== "string") {
    return { ok: false, error: "could not determine a connection method", raw: out.slice(0, 300) };
  }
  if (reevaluate) return { ok: true, plan, reevaluated: true };
  const integ = (["api", "oauth", "browser", "mcp", "cli", "manual"].includes(plan.integration as string) ? plan.integration : "manual") as "api" | "oauth" | "browser" | "mcp" | "cli" | "manual";
  const planDomains = Array.isArray(plan.domains) ? (plan.domains as string[]).filter((d) => domainNames.includes(d)) : [];
  const authCheck = (plan.auth_check && typeof plan.auth_check === "object" && (plan.auth_check as Record<string, unknown>).kind && (plan.auth_check as Record<string, unknown>).kind !== "none")
    ? (plan.auth_check as Record<string, unknown>) : null;
  const refreshEvery = (plan.schedule && typeof plan.schedule === "object") ? ((plan.schedule as Record<string, unknown>).every as string | undefined) ?? null : null;
  const scaffold = scaffoldCommunityApp({ id: plan.app_id as string, title: (plan.title as string) || name, integration: integ, domains: planDomains, authCheck, refreshEvery, vaultRoot: a.vaultPath });
  // Autonomous verify: when no user action is required and we have a testable
  // auth_check, run it now and report proof instead of telling the user to.
  let verified: boolean | null = null;
  let proof: string | null = null;
  const authStepKind = (plan.auth_step && typeof plan.auth_step === "object") ? (plan.auth_step as Record<string, unknown>).kind : "none";
  if (scaffold.ok && authCheck && (authStepKind === "none" || !authStepKind)) {
    try {
      const fresh = scanApps(a.vaultPath).find((app) => app.id === (plan!.app_id as string));
      if (fresh) {
        const r = await probeConnector(fresh, authCheck as unknown as AuthCheckSpec);
        verified = r.ok;
        proof = r.ok ? (r.message || "connection test passed") : (r.fixHint || r.message || `test failed (${r.status})`);
      }
    } catch (err) {
      verified = false;
      proof = `could not run the test: ${err}`;
    }
  }
  return { ok: scaffold.ok, plan, path: scaffold.path, error: scaffold.error, verified, proof };
}
