// App suggestions — the learning layer that proposes which real-world apps to
// connect to enrich a domain. Unlike the deterministic "this domain has no app"
// recommendation, this reads what the user ACTUALLY does (domain state, recent
// decisions, distilled intents) and asks a model to name specific, real products
// (e.g. "Capital One" for Wealth, "Garmin Connect" for Health) that would feed
// valuable data in - each with a one-line reason grounded in their signals.
//
// Output: <vault>/build/_meta/app_suggestions.json, keyed by domain, so the
// desktop can show "Suggested for you" per domain and a daily daemon can refresh.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { readDecisions } from "./decisions.ts";
import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";

export interface AppSuggestion {
  name: string;        // real product name, e.g. "Capital One"
  reason: string;      // one line, grounded in the user's signals
}
export interface DomainAppSuggestions {
  generated: number;   // epoch ms
  model: string;       // "cli:model" that produced it
  items: AppSuggestion[];
}
export type AppSuggestionsFile = Record<string, DomainAppSuggestions>;

export function suggestionsPath(vault: string): string {
  return join(runtimePath(vault, "_meta"), "app_suggestions.json");
}

export function readAppSuggestions(vault: string): AppSuggestionsFile {
  try {
    return JSON.parse(vreadFile(suggestionsPath(vault))) as AppSuggestionsFile;
  } catch {
    return {};
  }
}

// Pull the signals that tell us what this person does in a domain: the living
// state.md, the most recent decisions (council verdicts, loop executions), and
// any distilled intents that touch the domain. Kept compact so the prompt stays
// cheap regardless of how large the vault grows.
function gatherSignals(vault: string, domain: string): string {
  const parts: string[] = [];
  const dir = resolveDomainDir(vault, domain);
  const readCapped = (file: string, cap: number): string => {
    try {
      const p = join(dir, file);
      if (!existsSync(p)) return "";
      const t = vreadFile(p).trim();
      return t.length > cap ? t.slice(0, cap) + "\n[...]" : t;
    } catch { return ""; }
  };
  const state = readCapped("state.md", 2500);
  if (state) parts.push(`STATE (${domain}/state.md):\n${state}`);
  const decisions = readDecisions(vault, domain, 8);
  if (decisions.length) {
    const lines = decisions.map((d) => {
      const what = (d as { prompt?: string; action?: string }).prompt ?? (d as { action?: string }).action ?? "";
      return `- ${String(what).slice(0, 160)}`;
    }).filter((l) => l.trim() !== "-");
    if (lines.length) parts.push(`RECENT DECISIONS:\n${lines.join("\n")}`);
  }
  try {
    const raw = readFileSync(join(runtimePath(vault, "_meta"), "intents_distilled.json"), "utf8");
    const doc = JSON.parse(raw) as { intents?: Array<{ title?: string; goal?: string; domains?: string[]; status?: string }> };
    const hits = (doc.intents ?? [])
      .filter((it) => it.status !== "resolved" && (it.domains ?? []).some((d) => String(d).toLowerCase() === domain.toLowerCase()))
      .map((it) => `- ${it.title || it.goal || ""}`.slice(0, 160))
      .filter((l) => l.trim() !== "-")
      .slice(0, 6);
    if (hits.length) parts.push(`ACTIVE GOALS:\n${hits.join("\n")}`);
  } catch { /* none */ }
  return parts.join("\n\n");
}

function buildPrompt(domain: string, signals: string, connected: string[]): string {
  return [
    `You suggest real apps/services this person should CONNECT to enrich their "${domain}" domain in a personal AI workspace. Connecting an app lets the assistant pull that app's data (transactions, workouts, statements, etc.) so its answers stay grounded in the person's real, current life.`,
    "",
    signals ? `What they actually do in ${domain}:\n${signals}` : `(little context yet for ${domain} - infer typical needs for this kind of domain)`,
    "",
    connected.length ? `Already connected (do NOT repeat): ${connected.join(", ")}` : "Nothing is connected yet.",
    "",
    "Rules:",
    "- Name SPECIFIC, real products by their actual name (e.g. 'Capital One', 'Garmin Connect', 'Fidelity', 'MyFitnessPal'). Never generic categories.",
    "- Each suggestion must enrich THIS domain with data worth having.",
    "- Ground each reason in their signals when possible; keep it to one short line.",
    "- Suggest 3 to 5. Order by how much they'd help.",
    "- Do not use em dashes.",
    "",
    "Respond as EXACTLY one line per suggestion, nothing else:",
    "NAME | one-line reason",
  ].join("\n");
}

function parseSuggestions(raw: string): AppSuggestion[] {
  const out: AppSuggestion[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim().replace(/^[-*\d.)\s]+/, "");
    if (!t || !t.includes("|")) continue;
    const [name, ...rest] = t.split("|");
    const nm = name.trim().replace(/^["'`]|["'`]$/g, "");
    const reason = rest.join("|").trim();
    if (nm && nm.length <= 60) out.push({ name: nm, reason });
    if (out.length >= 6) break;
  }
  return out;
}

export interface SuggestArgs {
  vault: string;
  domain: string;
  cli: AvailableCli;
  model?: string;
  connected?: string[];
  signal?: AbortSignal;
}

// Generate suggestions for ONE domain and merge them into the suggestions file.
export async function suggestAppsForDomain(args: SuggestArgs): Promise<AppSuggestion[]> {
  const signals = gatherSignals(args.vault, args.domain);
  const prompt = buildPrompt(args.domain, signals, args.connected ?? []);
  const dir = resolveDomainDir(args.vault, args.domain);
  const reply = await runChatTurn({
    prompt,
    cwd: existsSync(dir) ? dir : args.vault,
    cli: args.cli,
    model: args.model ?? "",
    isFirst: true,
    bare: true,
    signal: args.signal,
  });
  const items = parseSuggestions(reply);
  const all = readAppSuggestions(args.vault);
  all[args.domain.toLowerCase()] = {
    generated: Date.now(),
    model: `${args.cli.kind}${args.model ? `:${args.model}` : ""}`,
    items,
  };
  vwriteFile(suggestionsPath(args.vault), JSON.stringify(all, null, 2));
  return items;
}
