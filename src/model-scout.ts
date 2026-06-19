// Model Scout — the standing scan that searches the web for AI models worth
// adding to the Arena benchmark. It looks for BOTH camps:
//   - open-source / open-weight models (Llama, Qwen, Mistral, DeepSeek, ...)
//   - frontier closed models (Claude, GPT, Gemini, Grok, ...)
// and returns each with its provider, which camp it is in, and a one-line reason
// it is worth benchmarking. A daily loop in the General domain runs this so the
// benchmark's coverage tracks the fast-moving model landscape instead of going
// stale. Web access is on by default for the claude CLI (WebSearch tool), so the
// scout sees current releases rather than its training-cutoff snapshot.
//
// Output: <vault>/build/_meta/model_suggestions.json (a single global list, not
// per-domain) so the Arena can show "New models to add" and the user can fold
// the ones they want into a benchmark run.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimePath } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { runChatTurn, type AvailableCli } from "./cli-bridge.ts";

export interface ModelSuggestion {
  name: string;        // the model as people say it, e.g. "Llama 4 Maverick"
  provider: string;    // who makes it, e.g. "Meta", "OpenAI", "DeepSeek"
  kind: "open" | "frontier"; // open-weight vs closed frontier
  reason: string;      // one line: why it is worth benchmarking now
}
export interface ModelSuggestionsFile {
  generated: number;   // epoch ms of the last scan
  model: string;       // "cli:model" that produced it
  items: ModelSuggestion[];
}

export function modelSuggestionsPath(vault: string): string {
  return join(runtimePath(vault, "_meta"), "model_suggestions.json");
}

export function readModelSuggestions(vault: string): ModelSuggestionsFile | null {
  try {
    return JSON.parse(vreadFile(modelSuggestionsPath(vault))) as ModelSuggestionsFile;
  } catch {
    return null;
  }
}

function buildPrompt(known: string[]): string {
  return [
    "You are a model scout for a local AI benchmarking tool. Search the web for the AI models worth benchmarking RIGHT NOW. Cover BOTH camps:",
    "  1) open-source / open-weight models (e.g. Llama, Qwen, Mistral, DeepSeek, Gemma, Kimi).",
    "  2) frontier closed models (e.g. Claude, GPT, Gemini, Grok).",
    "",
    "Favour models released or meaningfully updated recently, and the current flagships of each major lab. Prefer models people can actually run or call today.",
    "",
    known.length ? `Already in the benchmark (do NOT repeat these): ${known.join(", ")}` : "The benchmark is empty so far.",
    "",
    "Rules:",
    "- Use the real, current model names and the real provider.",
    "- Tag each as open (open-weight) or frontier (closed).",
    "- One short reason per model: why it is worth benchmarking now.",
    "- Suggest 6 to 12, the most benchmark-worthy first.",
    "- Do not use em dashes.",
    "",
    "Respond as EXACTLY one line per model, nothing else:",
    "NAME | PROVIDER | open OR frontier | one-line reason",
  ].join("\n");
}

export function parseModelSuggestions(raw: string): ModelSuggestion[] {
  const out: ModelSuggestion[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim().replace(/^[-*\d.)\s]+/, "");
    if (!t || t.split("|").length < 4) continue;
    const [name, provider, kindRaw, ...rest] = t.split("|");
    const nm = name.trim().replace(/^["'`]|["'`]$/g, "");
    const kind = /open/i.test(kindRaw) ? "open" : "frontier";
    const reason = rest.join("|").trim();
    if (nm && nm.length <= 60) out.push({ name: nm, provider: provider.trim(), kind, reason });
    if (out.length >= 14) break;
  }
  return out;
}

export interface ScoutArgs {
  vault: string;
  cli: AvailableCli;
  model?: string;
  known?: string[];    // model names already covered by the benchmark
  signal?: AbortSignal;
}

// Run one scout pass (web search) and persist the result. Returns the items.
export async function scoutModels(args: ScoutArgs): Promise<ModelSuggestion[]> {
  const prompt = buildPrompt(args.known ?? []);
  const reply = await runChatTurn({
    prompt,
    cwd: args.vault,
    cli: args.cli,
    model: args.model ?? "",
    isFirst: true,
    bare: true,
    signal: args.signal,
  });
  const items = parseModelSuggestions(reply);
  const doc: ModelSuggestionsFile = {
    generated: Date.now(),
    model: `${args.cli.kind}${args.model ? `:${args.model}` : ""}`,
    items,
  };
  const outPath = modelSuggestionsPath(args.vault);
  try { mkdirSync(dirname(outPath), { recursive: true }); } catch { /* exists */ }
  vwriteFile(outPath, JSON.stringify(doc, null, 2));
  return items;
}
