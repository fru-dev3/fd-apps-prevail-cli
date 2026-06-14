// Recommendations — the proactive, self-learning layer. Prevail watches what the
// user actually does and proposes the next high-leverage moves across their life:
//   - DOMAIN: intents keep touching a life area they have no domain for.
//   - MODEL:  a benchmarked model clearly beats the rest for a domain.
//   - APP:    a domain has no app feeding it real data.
// Computed deterministically from existing vault signals (distilled intents,
// benchmark matrix, connected apps, domains) so it's fast, explainable, and
// testable — no model call. Surfaced in one feed; each rec has a one-click action.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanVault, scanCommunityApps } from "./vault.ts";
import { buildPublicResults } from "./canonical-bench.ts";

export interface Recommendation {
  id: string;
  category: "domain" | "model" | "app";
  title: string;
  detail: string;
  action: { kind: "create_domain" | "set_domain_model" | "connect_app"; domain?: string; model?: string; cli?: string };
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
}

export function buildRecommendations(vaultRoot: string): Recommendation[] {
  const recs: Recommendation[] = [];
  const domainList = scanVault(vaultRoot);
  const have = new Set(domainList.map((d) => d.name.toLowerCase()));

  // 1. DOMAIN — distilled intents referencing a life area with no domain yet.
  try {
    const raw = readFileSync(join(vaultRoot, "_meta", "intents_distilled.json"), "utf8");
    const doc = JSON.parse(raw) as { intents?: Array<{ title?: string; goal?: string; domains?: string[]; status?: string }> };
    const missing = new Map<string, { n: number; ex: string }>();
    for (const it of doc.intents ?? []) {
      if (it.status === "resolved") continue;
      for (const d of it.domains ?? []) {
        const dl = String(d).toLowerCase().trim();
        if (!dl || have.has(dl)) continue;
        const c = missing.get(dl) ?? { n: 0, ex: "" };
        c.n += 1;
        if (!c.ex) c.ex = it.title || it.goal || "";
        missing.set(dl, c);
      }
    }
    for (const [d, c] of missing) {
      recs.push({
        id: `domain:${d}`,
        category: "domain",
        title: `Create a "${titleCase(d)}" domain`,
        detail: `Your activity keeps touching ${titleCase(d)}${c.ex ? ` (e.g. "${c.ex}")` : ""}, but you have no domain for it yet. Adding one lets Prevail track and work on it.`,
        action: { kind: "create_domain", domain: d },
      });
    }
  } catch { /* no distilled intents yet */ }

  // 2. MODEL — a clearly-best model per benchmarked domain (>= 2 models compared).
  try {
    const pr = buildPublicResults(vaultRoot, "");
    for (const domain of pr.domains) {
      let best: { key: string; label: string; score: number } | null = null;
      let scored = 0;
      for (const m of pr.models) {
        const cell = pr.matrix[m.key]?.[domain];
        if (cell?.judge_avg != null && cell.n > 0) {
          scored += 1;
          if (!best || cell.judge_avg > best.score) best = { key: m.key, label: m.label, score: cell.judge_avg };
        }
      }
      if (best && scored >= 2) {
        const m = pr.models.find((x) => x.key === best!.key);
        recs.push({
          id: `model:${domain}`,
          category: "model",
          title: `Use ${best.label} for ${titleCase(domain)}`,
          detail: `It scores ${best.score.toFixed(1)}/10 on your ${titleCase(domain)} benchmark — the best of ${scored} models tested. Set it as this domain's default.`,
          action: { kind: "set_domain_model", domain, model: m?.model ?? "", cli: m?.cli ?? "" },
        });
      }
    }
  } catch { /* no benchmark data yet */ }

  // 3. APP — a domain with no app feeding it real data.
  try {
    const apps = scanCommunityApps();
    const fed = new Set<string>();
    for (const a of apps) for (const d of a.domains ?? []) fed.add(String(d).toLowerCase());
    for (const d of domainList) {
      if (!fed.has(d.name.toLowerCase())) {
        recs.push({
          id: `app:${d.name.toLowerCase()}`,
          category: "app",
          title: `Connect an app to feed ${titleCase(d.name)}`,
          detail: `No app is syncing data into ${titleCase(d.name)} yet. Connect one so this domain stays grounded in your real, current data.`,
          action: { kind: "connect_app", domain: d.name },
        });
      }
    }
  } catch { /* none */ }

  return recs;
}

// Stable JSON for the CLI command. `existsSync` guards a missing vault.
export function recommendationsJson(vaultRoot: string): string {
  if (!existsSync(vaultRoot)) return JSON.stringify({ ok: false, error: "vault not found", recommendations: [] });
  return JSON.stringify({ ok: true, recommendations: buildRecommendations(vaultRoot) });
}
