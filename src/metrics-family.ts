// Metrics M6, family metrics: numbers a household shares, with consent per
// person. A family metric is a metrics.md line with ~family:yes, counted from
// stated events (~src:stated ~kind:stated.<id>). Each number someone logs
// carries who it is (attrs.member; the owner has none). In code:
//   - a member's number is logged only while they share their numbers
//     (household metrics consent), and shown only while they still do;
//   - members' numbers never count in the owner's own metrics (metrics.ts
//     leaves every event with attrs.member out);
//   - a member who does not share shows as "not shared", never as zero.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { consented, readHousehold } from "./household.ts";
import { parseModArgs } from "./cli-args.ts";

/** Log one number for an asked metric (a pack's, a family one, or any learned stated one). Content free: the number only. */
export async function sayMetric(vault: string, id: string, value: number, o: { now?: number; member?: string } = {}): Promise<{ id: string; kind: string; value: number; member?: string }> {
  const m = await import("./metrics.ts");
  const line = m.readRegistry(vault).get(id);
  const kind = line?.tokens.kind;
  if (!line || !kind || !kind.startsWith("stated.")) throw new Error(`${id} is not a metric you log by hand`);
  if (!Number.isFinite(value) || value < 0 || value > 1e7) throw new Error("a number between 0 and 10,000,000");
  if (o.member) {
    if (line.tokens.family !== "yes") throw new Error(`${id} is not a family metric`);
    if (!consented(vault, o.member, "metrics")) throw new Error("their numbers are kept only while they share them (metrics consent)");
  }
  const now = o.now ?? Date.now();
  const day = m.dayOf(now);
  const dir = join(m.eventsRoot(vault), "stated");
  mkdirSync(dir, { recursive: true });
  const host = m.hostSlug();
  appendFileSync(join(dir, `${day.slice(0, 7)}.${host}.jsonl`), `${JSON.stringify({ ts: day, src: "stated", kind: kind.split(",")[0], n: 1, host, tier: "asked", attrs: { value, ...(o.member ? { member: o.member } : {}) } })}\n`);
  return { id, kind, value, ...(o.member ? { member: o.member } : {}) };
}

/** Add a family metric under Tracking. */
export async function addFamilyMetric(vault: string, i: { title: string; per?: "week" | "month"; unit?: "count" | "hours" | "minutes" | "usd" }): Promise<string> {
  const title = i.title.replace(/\s+/g, " ").replace(/[–—]/g, ",").trim().slice(0, 60);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  if (!slug) throw new Error("a family metric needs a title");
  const id = `m-family-${slug}`;
  const mp = await import("./metric-proposals.ts");
  const m = await import("./metrics.ts");
  if (m.readRegistry(vault).has(id)) throw new Error("that family metric is already there");
  mp.moveMetric(vault, id, "tracking", { line: `- ${title} ~id:${id} ~per:${i.per ?? "week"} ~unit:${i.unit ?? "count"} ~tier:asked ~src:stated ~kind:stated.family.${slug} ~value:value ~family:yes` });
  return id;
}

export interface FamilyRow { person: string; name: string; shared: boolean; weeks: { week: string; value: number }[] }
export interface FamilyMetric { id: string; title: string; unit: string; people: FamilyRow[] }

/** Every family metric: the last four weeks per person, only for people who share their numbers. */
export async function familyMetrics(vault: string, now = Date.now()): Promise<FamilyMetric[]> {
  const m = await import("./metrics.ts");
  const reg = m.readRegistry(vault);
  const fam = [...reg.entries()].filter(([, l]) => l.tokens.family === "yes" && l.tokens.kind);
  if (!fam.length) return [];
  const weeks: string[] = [];
  for (let k = 3; k >= 0; k--) weeks.push(m.weekOf(m.dayOf(now - k * 7 * 86_400_000)));
  const from = m.dayOf(now - 35 * 86_400_000);
  // Stated events, read here (never through computeMetrics, which leaves members out).
  const dir = join(m.eventsRoot(vault), "stated");
  const events: { ts: string; kind: string; attrs: Record<string, unknown> }[] = [];
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl") && x.slice(0, 7) >= from.slice(0, 7))) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) { try { const e = JSON.parse(l); if (e.ts >= from) events.push(e); } catch { /* skip */ } }
  }
  const members = readHousehold(vault).members.filter((x) => !x.removed);
  const people = [{ id: "", name: "You" }, ...members.map((x) => ({ id: x.id, name: x.name }))];
  return fam.map(([id, l]) => ({
    id, title: l.title || id, unit: l.tokens.unit ?? "count",
    people: people.map((p) => {
      const shared = !p.id || consented(vault, p.id, "metrics");
      return {
        person: p.id || "me", name: p.name, shared,
        weeks: shared ? weeks.map((w) => ({ week: w, value: Math.round(events.filter((e) => e.kind === l.tokens.kind && String(e.attrs?.member ?? "") === p.id && m.weekOf(e.ts) === w).reduce((a, e) => a + Number(e.attrs?.value ?? 1), 0) * 100) / 100 })) : [],
      };
    }),
  }));
}

export async function familyCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    if (sub === "say") {
      const r = await sayMetric(vault, args.pos[1] ?? "", Number(args.pos[2]), { ...(args.get("member") ? { member: args.get("member")! } : {}) });
      if (args.json) out({ ok: true, ...r }); else console.log(`Logged ${r.value} for ${r.id}.`);
      return 0;
    }
    if (sub === "family") {
      if (args.pos[1] === "add") { const id = await addFamilyMetric(vault, { title: args.get("title") ?? args.pos.slice(2).join(" "), per: args.get("per") === "month" ? "month" : "week", unit: (args.get("unit") as "count") ?? "count" }); if (args.json) out({ ok: true, id }); else console.log(`Added ${id}.`); return 0; }
      const f = await familyMetrics(vault); if (args.json) out(f); else for (const x of f) console.log(`${x.title}: ${x.people.map((p) => `${p.name} ${p.shared ? p.weeks.map((w) => w.value).join("/") : "not shared"}`).join("; ")}`);
      return 0;
    }
  } catch (e) { if (args.json) { out({ ok: false, error: (e as Error).message }); return 0; } console.error((e as Error).message); return 1; }
  return 1;
}
