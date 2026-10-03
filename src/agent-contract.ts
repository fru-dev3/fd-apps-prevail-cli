// agent.md: a domain's contract (agent-mesh plan, Steps 1 and 2).
//
// An agent IS a domain folder. `<domain>/agent.md` says what the domain owns,
// what it wants to hear about, what it may do, who it hands off to and its
// approval tier, as short frontmatter plus prose. The per-tool instruction
// files (CLAUDE.md, AGENTS.md for Codex and pi, GEMINI.md) carry it inside
// Prevail's managed block, generated, never hand-edited.
//
// Two rules hold in code here, not in a prompt:
// - one writer per fact: two contracts may not own the same thing;
// - an agent writes only its own folder; anything for another domain is a
//   handoff, a task in the owner's inbox that starts "From <domain>:".

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CEILINGS, parseFrontmatter, type Ceiling } from "./specialists.ts";
import { DATA_DIR, DOMAINS_DIR, isDomainFolderName, resolveDomainDir } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";

export const CONTRACT_FILE = "agent.md";

export interface AgentContract {
  domain: string;
  /** The facts and jobs this domain is the one writer for. */
  owns: string[];
  /** Events from elsewhere this domain wants handed to it. */
  hears: string[];
  /** What the agent may do on its own, in plain words. */
  may: string[];
  /** Domains it hands work to. */
  handsOffTo: string[];
  /** Approval tier: the most it does without asking (specialist ceilings). */
  tier: Ceiling;
  body: string;
}

const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);

export function parseContract(text: string, domain: string): AgentContract | null {
  const { fm, body } = parseFrontmatter(text);
  const owns = asList(fm.owns);
  if (owns.length === 0) return null;
  const tier = CEILINGS.includes(fm.tier as Ceiling) ? (fm.tier as Ceiling) : "draft";
  return {
    domain,
    owns,
    hears: asList(fm.hears),
    may: asList(fm.may),
    handsOffTo: asList(fm.hands_off_to).map((d) => d.toLowerCase()),
    tier,
    body: body.trim(),
  };
}

export function contractPath(vault: string, domain: string): string {
  return join(resolveDomainDir(vault, domain), CONTRACT_FILE);
}

export function readContract(vault: string, domain: string): AgentContract | null {
  const p = contractPath(vault, domain);
  if (!existsSync(p)) return null;
  try { return parseContract(readFileSync(p, "utf8"), domain); } catch { return null; }
}

export function readContracts(vault: string): AgentContract[] {
  return listDomainDirs(vault).sort().map((d) => readContract(vault, d)).filter((c): c is AgentContract => !!c);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Problems that break the mesh: a fact with two writers, a handoff to nowhere. */
export function checkContracts(vault: string, contracts = readContracts(vault)): string[] {
  const issues: string[] = [];
  const owner = new Map<string, string>();
  const known = new Set(listDomainDirs(vault));
  for (const c of contracts) {
    for (const o of c.owns) {
      const k = norm(o);
      const prev = owner.get(k);
      if (prev && prev !== c.domain) issues.push(`"${o}" is owned by both ${prev} and ${c.domain}; one writer per fact`);
      else owner.set(k, c.domain);
    }
    for (const d of c.handsOffTo) if (!known.has(d)) issues.push(`${c.domain} hands off to "${d}", which is not a domain`);
  }
  return issues;
}

const phraseRe = (p: string) => new RegExp(`(^|[^a-z0-9])${norm(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");

/**
 * The declared owner of a message: the one domain whose `owns` phrases match
 * it most. Null when nothing matches or two domains tie (then a model decides).
 */
export function ownerFor(text: string, contracts: AgentContract[], allowed?: string[]): { domain: string; matched: string } | null {
  const t = ` ${norm(text)} `;
  let best: { domain: string; matched: string; n: number } | null = null;
  let tie = false;
  for (const c of contracts) {
    if (allowed && !allowed.includes(c.domain)) continue;
    const hits = c.owns.filter((o) => phraseRe(o).test(t));
    if (hits.length === 0) continue;
    if (!best || hits.length > best.n) { best = { domain: c.domain, matched: hits[0]!, n: hits.length }; tie = false; }
    else if (hits.length === best.n) tie = true;
  }
  return best && !tie ? { domain: best.domain, matched: best.matched } : null;
}

/** The section the generated instruction files carry. */
export function contractBlock(c: AgentContract): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  return [
    `# Your contract: the ${c.domain} agent`,
    "",
    "Generated from agent.md in this folder. Change agent.md, never this block.",
    "",
    "You own (you are the one writer for these):",
    list(c.owns),
    "",
    "You want to hear about:",
    list(c.hears),
    "",
    "You may do on your own:",
    list(c.may),
    "",
    `Approval tier: ${c.tier}. Anything above it asks the user first.`,
    "",
    `You hand off to: ${c.handsOffTo.join(", ") || "(none)"}.`,
    "",
    "Write only inside this folder. Anything for another domain is a handoff: add a task to that",
    `domain (Prevail MCP add_task) that starts "From ${c.domain}:" and says the event, the amount,`,
    "the date and the source file. Never edit another domain's files.",
    ...(c.body ? ["", c.body] : []),
  ].join("\n");
}

// ── Handoffs ─────────────────────────────────────────────────────────────

export interface Handoff {
  from: string;
  event: string;
  amount?: string;
  date?: string;
  source?: string;
}

const HANDOFF_RE = /^From ([a-z0-9-]+):\s*(.*)$/i;

/** One task line: "From wealth: <event> | amount: $1,200 | date: 2026-09-30 | source: source/x.csv". */
export function formatHandoff(h: Handoff): string {
  const event = h.event.replace(/\s+/g, " ").replace(HANDOFF_RE, "$2").trim();
  if (!event) throw new Error("a handoff needs an event");
  if (h.date && !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) throw new Error("date must be YYYY-MM-DD");
  if (h.source && (h.source.includes("..") || h.source.startsWith("/"))) throw new Error("source is a path inside the sender's folder, like source/statement.pdf");
  const parts = [`From ${h.from}: ${event.replace(/\|/g, "/")}`];
  if (h.amount) parts.push(`amount: ${h.amount.replace(/\|/g, "/")}`);
  if (h.date) parts.push(`date: ${h.date}`);
  if (h.source) parts.push(`source: ${h.from}/${h.source}`);
  return parts.join(" | ");
}

export function parseHandoff(line: string): Handoff | null {
  const [head, ...rest] = line.split(" | ");
  const m = HANDOFF_RE.exec((head ?? "").trim());
  if (!m) return null;
  const h: Handoff = { from: m[1]!.toLowerCase(), event: m[2]!.trim() };
  for (const p of rest) {
    const kv = /^(amount|date|source):\s*(.*)$/.exec(p.trim());
    if (kv) h[kv[1] as "amount" | "date" | "source"] = kv[2]!.trim();
  }
  return h;
}

// ── One writer per folder ───────────────────────────────────────────────

/**
 * The other domain a write would land in, or null when the write is fine.
 * Only a domain agent is held to this: mission and app scopes, and paths
 * outside data/domains, are someone else's rule.
 */
export function foreignDomainOf(vault: string, domain: string, target: string, cwd = process.cwd()): string | null {
  if (!isDomainFolderName(domain)) return null;
  const root = resolve(vault, DATA_DIR, DOMAINS_DIR);
  const rel = relative(root, resolve(cwd, target));
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const top = rel.split(sep)[0]!;
  return top && top !== domain ? top : null;
}

// ── CLI: prevail agents list|show|check|generate|handoff ───────────────────

/** File a handoff into the owner's inbox; the Activity feed records it. */
export async function fileHandoff(vault: string, to: string, h: Handoff): Promise<{ added: boolean; text: string }> {
  if (!listDomainDirs(vault).includes(to)) throw new Error(`no domain "${to}"`);
  if (!listDomainDirs(vault).includes(h.from)) throw new Error(`no domain "${h.from}"`);
  if (to === h.from) throw new Error("a handoff goes to another domain");
  const text = formatHandoff(h);
  const { appendTask } = await import("./daemon-loops.ts");
  const { domainDir } = await import("./decisions.ts");
  const added = appendTask(domainDir(vault, to), text);
  if (added) {
    const { logActivity } = await import("./activity.ts");
    logActivity(vault, { type: "task_filed", domain: to, title: `Handoff from ${h.from} to ${to}`, detail: text, status: "ok", ref: "handoff" });
  }
  return { added, text };
}

export async function agentsCommand(args: string[], vault: string): Promise<number> {
  const { parseModArgs } = await import("./cli-args.ts");
  const a = parseModArgs(args);
  const sub = a.pos[0] ?? "list";
  const out = (o: unknown, text: string) => { process.stdout.write(a.json ? `${JSON.stringify(o, null, 2)}\n` : `${text}\n`); };
  if (sub === "list") {
    const cs = readContracts(vault);
    out(cs.map(({ body: _b, ...c }) => c), cs.map((c) => `${c.domain.padEnd(14)} ${c.tier.padEnd(11)} owns ${c.owns.join(", ")}`).join("\n") || "No domain has an agent.md yet.");
    return 0;
  }
  if (sub === "show") {
    const c = a.pos[1] ? readContract(vault, a.pos[1]) : null;
    if (!c) { console.error(`no agent.md with an owns list for "${a.pos[1] ?? ""}"`); return 1; }
    out(c, contractBlock(c));
    return 0;
  }
  if (sub === "check") {
    const issues = checkContracts(vault);
    out({ ok: issues.length === 0, issues }, issues.length ? issues.join("\n") : `ok: ${readContracts(vault).length} contracts, every fact has one writer`);
    return issues.length ? 1 : 0;
  }
  if (sub === "generate") {
    const { generateHarnessFiles } = await import("./cli-bridge.ts");
    const { readManifest } = await import("./manifest.ts");
    const targets = a.has("all") ? readContracts(vault).map((c) => c.domain) : a.pos.slice(1);
    if (targets.length === 0) { console.error("usage: prevail agents generate <domain>... | --all"); return 1; }
    const done: Record<string, string[]> = {};
    for (const d of targets) {
      if (!readContract(vault, d)) { console.error(`${d}: no agent.md with an owns list, skipped`); continue; }
      const cli = readManifest(vault, d)?.config.cli ?? "claude";
      // Claude Code, Codex and pi (AGENTS.md) always; the domain's own engine too.
      done[d] = generateHarnessFiles(resolveDomainDir(vault, d), vault, ["claude", "codex", cli]);
    }
    out(done, Object.entries(done).map(([d, fs]) => `${d}: ${fs.join(", ")}`).join("\n"));
    return 0;
  }
  if (sub === "handoff") {
    const from = a.get("from") ?? process.env.PREVAIL_DOMAIN ?? "";
    const to = a.get("to") ?? "";
    try {
      const r = await fileHandoff(vault, to, { from, event: a.get("event") ?? "", amount: a.get("amount"), date: a.get("date"), source: a.get("source") });
      out(r, r.added ? `Handed to ${to}: ${r.text}` : `Already in ${to}: ${r.text}`);
      return 0;
    } catch (e) { console.error((e as Error).message); return 1; }
  }
  console.error("usage: prevail agents list|show <domain>|check|generate <domain>|--all|handoff --from D --to D --event TEXT [--amount A] [--date YYYY-MM-DD] [--source FILE]");
  return 1;
}
