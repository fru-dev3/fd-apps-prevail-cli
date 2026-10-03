// `prevail ai` - AI tool usage from the tools' own local records.
//
//   prevail ai scan [--only claude,codex] [--backfill] [--json]
//                                                    read every adapter now;
//                                                    --backfill also writes older
//                                                    months that have no file yet
//   prevail ai usage [--month YYYY-MM] [--tool t] [--json]
//                                                    this month across every host
//   prevail ai tools [--json]                        adapters' health and tools
//                                                    seen with no adapter yet
//   prevail ai plan <app> --usd N [--period month|year] [--json]
//                                                    what a vendor's plan costs you
//
// `capture sync` (the 30-minute agent) runs the scan too.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { aiUsageReport, defaultRoots, detectNewTools, scanAiUsage, setPlanCost } from "./ai-usage.ts";
import { runtimePath } from "./path-safety.ts";

const money = (n: number) => `$${n.toFixed(2)}`;
const mtok = (n: number) => `${(n / 1e6).toFixed(1)}M`;

export async function aiCommand(args: string[], vault: string): Promise<number> {
  const sub = args[0] ?? "usage";
  const json = args.includes("--json");
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

  if (sub === "scan") {
    const only = get("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
    const r = scanAiUsage(vault, { ...(only ? { only } : {}), backfill: args.includes("--backfill") });
    if (json) out(r);
    else {
      console.log(`ai scan on ${r.host} (${r.ms} ms), months ${r.months.join(", ")}`);
      for (const [t, h] of Object.entries(r.tools)) console.log(`  ${t.padEnd(12)} ${h.shape.padEnd(8)} files ${String(h.files).padStart(6)}  read ${String(h.read).padStart(5)}  events ${h.events}${h.note ? `  (${h.note})` : ""}`);
      if (r.unadapted.length) console.log(`  seen, no adapter yet: ${r.unadapted.map((u) => `${u.tool} (${u.via})`).join(", ")}`);
    }
    return 0;
  }

  if (sub === "usage") {
    const now = new Date();
    const month = get("--month") ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    if (!/^\d{4}-\d{2}$/.test(month)) { console.error("--month must be YYYY-MM"); return 1; }
    const r = aiUsageReport(vault, month, { tool: get("--tool") });
    if (json) { out(r); return 0; }
    console.log(`AI usage ${month} (hosts: ${r.hosts.join(", ") || "none yet; run prevail ai scan"})`);
    console.log(`  ${mtok(r.total.tokens)} tokens, ${money(r.total.usd_api)} at API prices${r.paid_monthly !== null ? `, ${money(r.paid_monthly)} paid, ${r.value_multiple}x` : ", paid: not set"}`);
    for (const t of r.by_tool) {
      console.log(`  ${t.key.padEnd(12)} ${mtok(t.tokens).padStart(8)}  ${money(t.usd_api).padStart(9)}  sessions ${t.sessions}${t.paid_monthly !== undefined ? `  paid ${money(t.paid_monthly)}` : ""}${t.value_multiple !== undefined ? `  ${t.value_multiple}x` : ""}${t.prompts ? `  prompts ${t.prompts}` : ""}`);
    }
    return 0;
  }

  if (sub === "tools") {
    const dir = join(runtimePath(vault, "_meta"), "apps");
    const health: Record<string, unknown> = {};
    try {
      for (const f of readdirSync(dir).filter((f) => /^adapters\..+\.json$/.test(f))) health[f.slice(9, -5)] = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch { /* none yet */ }
    const unadapted = detectNewTools(defaultRoots());
    if (json) out({ hosts: health, unadapted });
    else {
      for (const [host, h] of Object.entries(health)) console.log(`${host}: ${JSON.stringify((h as { tools?: unknown }).tools ?? {}).slice(0, 400)}`);
      console.log(`seen on this machine, no adapter yet: ${unadapted.map((u) => u.tool).join(", ") || "none"}`);
    }
    return 0;
  }

  if (sub === "plan") {
    const app = args[1];
    const usd = Number(get("--usd"));
    const period = get("--period") === "year" ? "year" : "month";
    if (!app || app.startsWith("--") || !Number.isFinite(usd)) { console.error("usage: prevail ai plan <app-id> --usd N [--period month|year]"); return 1; }
    try {
      const p = setPlanCost(vault, app, usd, period);
      if (json) out({ ok: true, app, amount: usd, period, path: p });
      else console.log(`${app}: ${money(usd)} a ${period} (written to ${p})`);
      return 0;
    } catch (e) { if (json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message); return 1; }
  }

  console.error("usage: prevail ai scan|usage|tools|plan ...");
  return 1;
}
