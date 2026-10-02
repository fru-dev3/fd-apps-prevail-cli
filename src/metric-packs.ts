// Metric packs (Metrics M6): a vertical pack's metrics go under ## Tracking in
// build/metrics.md. Catalog metrics are tracked as they are; a pack's own
// metrics are asked ones: a learned line counting stated events
// (~src:stated ~kind:stated.<id> ~value:value), answered with
// `prevail metrics say <id> <number>` (metrics-family.ts) or the metric's Log button. Nothing is
// pinned (pinning names what it serves, which only the user knows).

import type { Pack } from "./packs.ts";

export async function addPackMetrics(vault: string, p: Pack, _now = Date.now()): Promise<{ added: string[]; skipped: string[] }> {
  const m = await import("./metrics.ts");
  const mp = await import("./metric-proposals.ts");
  const reg = m.readRegistry(vault);
  const defs = m.allDefs(vault);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const id of p.metrics.track) {
    const d = defs.find((x) => x.id === id);
    if (!d) continue;
    if (reg.has(id)) { skipped.push(d.title); continue; }
    mp.moveMetric(vault, id, "tracking", { line: `- ${d.title} ~id:${d.id} ~per:${d.per} ~unit:${d.unit} ~tier:${d.tier} ~pack:${p.id}` });
    added.push(d.title);
  }
  for (const d of p.metrics.define) {
    if (reg.has(d.id)) { skipped.push(d.title); continue; }
    const kind = `stated.${d.id.replace(/^m-/, "")}`;
    mp.moveMetric(vault, d.id, "tracking", { line: `- ${d.title} ~id:${d.id} ~per:${d.per} ~unit:${d.unit ?? "count"} ~tier:asked ~src:stated ~kind:${kind} ~value:value ~pack:${p.id}${d.question ? `\n  ask: ${d.question}` : ""}` });
    added.push(d.title);
  }
  return { added, skipped };
}
