// Metrics M6: a number logged by hand for an asked metric (a learned line
// counting stated events, ~src:stated ~kind:stated.<id>). Content free: the
// number only. Family metrics and household numbers were removed by the owner
// (2026-10-02).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseModArgs } from "./cli-args.ts";

/** Log one number for an asked metric. */
export async function sayMetric(vault: string, id: string, value: number, o: { now?: number } = {}): Promise<{ id: string; kind: string; value: number }> {
  const m = await import("./metrics.ts");
  const line = m.readRegistry(vault).get(id);
  const kind = line?.tokens.kind;
  if (!line || !kind || !kind.startsWith("stated.")) throw new Error(`${id} is not a metric you log by hand`);
  if (!Number.isFinite(value) || value < 0 || value > 1e7) throw new Error("a number between 0 and 10,000,000");
  const now = o.now ?? Date.now();
  const day = m.dayOf(now);
  const dir = join(m.eventsRoot(vault), "stated");
  mkdirSync(dir, { recursive: true });
  const host = m.hostSlug();
  appendFileSync(join(dir, `${day.slice(0, 7)}.${host}.jsonl`), `${JSON.stringify({ ts: day, src: "stated", kind: kind.split(",")[0], n: 1, host, tier: "asked", attrs: { value } })}\n`);
  return { id, kind, value };
}

export async function familyCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    if (sub === "say") {
      const r = await sayMetric(vault, args.pos[1] ?? "", Number(args.pos[2]));
      if (args.json) out({ ok: true, ...r }); else console.log(`Logged ${r.value} for ${r.id}.`);
      return 0;
    }
  } catch (e) { if (args.json) { out({ ok: false, error: (e as Error).message }); return 0; } console.error((e as Error).message); return 1; }
  return 1;
}
