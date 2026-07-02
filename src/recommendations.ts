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
import { runtimePath } from "./path-safety.ts";
import { scanVault, scanCommunityApps } from "./vault.ts";
import { buildPublicResults } from "./canonical-bench.ts";
import { computeContextScore } from "./score.ts";

export interface Recommendation {
  id: string;
  category: "domain" | "model" | "app" | "context";
  title: string;
  detail: string;
  action: { kind: "create_domain" | "set_domain_model" | "connect_app" | "improve_context"; domain?: string; model?: string; cli?: string };
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
}

// Turn a raw model id or benchmark label into a clean, executive-friendly name.
// "claude-opus-4-6" or "2026-06-04_claude-claude-opus-4-6" -> "Claude Opus 4.6".
function humanizeModel(model: string, fallback: string): string {
  let s = (model || "").trim() || (fallback || "").trim();
  if (!s) return "the top model";
  s = s.replace(/^\d{4}-\d{2}-\d{2}_/, ""); // drop a leading benchmark-run date
  const VENDOR: Record<string, string> = {
    claude: "Claude", gpt: "GPT", gemini: "Gemini", llama: "Llama",
    opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", mistral: "Mistral",
    deepseek: "DeepSeek", qwen: "Qwen", grok: "Grok", kimi: "Kimi",
  };
  const out: string[] = [];
  for (const p of s.split(/[-_/]/).filter(Boolean)) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1])) {
      out[out.length - 1] += `.${p}`; // join version pieces: 4 then 6 -> 4.6
      continue;
    }
    const low = p.toLowerCase();
    out.push(VENDOR[low] ?? (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)));
  }
  const dedup = out.filter((w, i) => i === 0 || w !== out[i - 1]); // Claude Claude -> Claude
  return dedup.join(" ") || (fallback || "the top model");
}

export function buildRecommendations(vaultRoot: string): Recommendation[] {
  const recs: Recommendation[] = [];
  const domainList = scanVault(vaultRoot);
  const have = new Set(domainList.map((d) => d.name.toLowerCase()));

  // 1. DOMAIN — distilled intents referencing a life area with no domain yet.
  try {
    const raw = readFileSync(join(runtimePath(vaultRoot, "_meta"), "intents_distilled.json"), "utf8");
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
    // Be judicious: domains are meant to be FEW and BROAD. Over-suggesting them
    // fragments the vault into an unmanageable sprawl, so we surface only the
    // strongest few (by how many distinct unresolved intents touch the area) and
    // cap the total. Reusing an existing domain is almost always better than
    // creating a new one - the copy nudges that, and the distiller upstream is
    // told to prefer existing domains so facets of one project never become
    // separate candidates here.
    const MAX_DOMAIN_RECS = 3;
    const ranked = [...missing.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, MAX_DOMAIN_RECS);
    for (const [d, c] of ranked) {
      recs.push({
        id: `domain:${d}`,
        category: "domain",
        title: `Create a "${titleCase(d)}" domain`,
        detail: `Your activity keeps touching ${titleCase(d)}${c.ex ? ` (e.g. "${c.ex}")` : ""}, but you have no domain for it yet. Add one only if it is a broad area worth tracking on its own - if it is really a facet of something you already track, it belongs in that existing domain.`,
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
          title: `Use ${humanizeModel(m?.model ?? "", best.label)} for ${titleCase(domain)}`,
          detail: `Top performer on your ${titleCase(domain)} work: ${best.score.toFixed(1)} out of 10, ahead of ${scored} models tested. Make it the default for ${titleCase(domain)}.`,
          action: { kind: "set_domain_model", domain, model: m?.model ?? "", cli: m?.cli ?? "" },
        });
      }
    }
  } catch { /* no benchmark data yet */ }

  // 4. CONTEXT — domains whose context score is low and have a concrete gap.
  // This is the self-learning tie-in: the context score's missing[] items become
  // actions to enrich the domain, and the score then rises on its own as apps
  // sync and memory builds. Closes the loop: score -> action -> higher score.
  try {
    for (const d of domainList) {
      const sc = computeContextScore(vaultRoot, d.name);
      const serious = (sc.missing ?? []).filter((m) => m.severity === "critical" || m.severity === "warn");
      if (sc.score < 60 && serious.length > 0) {
        recs.push({
          id: `context:${d.name.toLowerCase()}`,
          category: "context",
          title: `Strengthen ${titleCase(d.name)} context (${Math.round(sc.score)}/100)`,
          detail: `${serious[0].label}. Richer context makes every answer, loop, and recommendation here sharper — and the score climbs on its own as apps sync and memory builds.`,
          action: { kind: "improve_context", domain: d.name },
        });
      }
    }
  } catch { /* scoring unavailable */ }

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
