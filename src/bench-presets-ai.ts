// AI-driven Arena preset library.
//
// The desktop hands us the AVAILABLE model universe it has already enumerated
// (each: a cli::model key, a human label, a provider, whether the runtime is
// validated/runnable, local-vs-cloud, and any tier hint). We ask a model to
// group those exact keys into a LIBRARY of canonical + creative presets, then
// GROUND every returned key against the input so a hallucinated model can never
// leak into the UI. The library is AI-maintained because it is regenerated over
// the live model list on each refresh.
//
// Pure functions live here (no I/O) so they can be unit-tested: the prompt
// builder, the JSON parser, and the grounding/validation filter. The command
// wiring (CLI detection, bunker gate, runChatTurn) stays in index.tsx.

// One model as the desktop enumerated it. Only `key` is required; the rest are
// hints that sharpen the prompt but are never trusted blindly.
export type AvailableModel = {
  key: string;            // "cli::model" — the ONLY identifier we ever emit back
  label?: string;         // human label, e.g. "Claude Opus 4.8"
  provider?: string;      // cli id, e.g. "claude", "openai", "ollama"
  validated?: boolean;    // runtime verified end-to-end (installed + authorized)
  local?: boolean;        // runs locally / open-weight (ollama, lmstudio, mlx, harness)
  tier?: string;          // optional tier hint: "flagship" | "mid" | "small" | ...
};

export type PresetSuggestion = {
  name: string;
  rationale: string;      // one short line
  models: string[];       // cli::model keys, all grounded against the input
};

// The canonical categories we ask the model to cover. Kept as data so the test
// and the prompt share one source of truth.
export const PRESET_CATEGORIES = [
  "Top Frontier: the best current flagship from each major provider",
  "Second-in-class: the previous-generation or one-notch-down model per provider (e.g. not the newest flagship, but the prior one)",
  "Open source / local: open-weight or locally hosted models (ollama, lmstudio, mlx, harness)",
  "Budget & Fast: the cheapest and quickest models, good for high-volume runs",
  "Balanced value: strong quality for reasonable cost, the everyday default",
  "Reasoning heavyweights: the deepest reasoning and thinking models",
  "One per provider: a single representative model from each detected provider",
  "David vs Goliath: a creative combo pitting the smallest against the largest",
] as const;

// Build the LLM prompt. Bunker-agnostic (the caller decides the runtime); this
// only shapes the request and lists the exact keys the model may use.
export function buildPresetPrompt(models: AvailableModel[]): string {
  const lines = models.map((m) => {
    const parts = [`- ${m.key}`];
    if (m.label) parts.push(`(${m.label})`);
    const tags: string[] = [];
    if (m.provider) tags.push(m.provider);
    if (m.local) tags.push("local/open");
    else tags.push("cloud");
    if (m.validated) tags.push("validated");
    else tags.push("unverified");
    if (m.tier) tags.push(`tier:${m.tier}`);
    parts.push(`[${tags.join(", ")}]`);
    return parts.join(" ");
  });
  const catList = PRESET_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    "You are curating a LIBRARY of benchmark presets for a model Arena.",
    "A preset is a named, reusable group of models the user can test head-to-head in one click, so they never have to hand-pick models each time.",
    "",
    "Produce a library of 6 to 9 presets. Aim to cover these canonical categories where the available models allow (skip a category if nothing fits, do not force it):",
    catList,
    "",
    "Rules:",
    "- Each preset must have 2 to 6 models.",
    "- Use ONLY the cli::model keys from the AVAILABLE MODELS list below. Never invent a model, never alter a key. If a model is not in the list, you may not use it.",
    "- Prefer models marked validated; you may include an unverified model when it is clearly the right fit for a category.",
    "- Give each preset a short, human name (2 to 4 words) and a one-line rationale (why these models, what the preset is for). No em dashes anywhere.",
    "- Do not repeat the exact same model set across two presets.",
    "",
    "REQUIRED OUTPUT: a single JSON object, no preamble, no markdown fences, no explanation.",
    'Shape: {"presets":[{"name":"...","rationale":"...","models":["cli::model", ...]}, ...]}',
    "",
    "=== AVAILABLE MODELS ===",
    ...lines,
  ].join("\n");
}

// Extract the JSON object from a raw model reply (fence-tolerant, preamble-tolerant).
// Returns the parsed value or null. Shared by the command and the tests.
export function extractPresetJson(raw: string): { presets?: unknown[] } | null {
  let text = (raw || "").trim();
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  // Trim any trailing prose after the final closing brace.
  const end = text.lastIndexOf("}");
  const slice = end > start ? text.slice(start, end + 1) : text.slice(start);
  try {
    const v = JSON.parse(slice);
    return v && typeof v === "object" ? (v as { presets?: unknown[] }) : null;
  } catch {
    return null;
  }
}

// Ground raw suggestions against the available model universe: keep only known
// cli::model keys, dedupe, drop presets that fall outside the 2..6 size bound
// AFTER filtering, and cap the returned library. This is the hard guarantee
// that a hallucinated model never reaches the UI.
export function groundPresets(
  parsed: { presets?: unknown[] } | null,
  models: AvailableModel[],
  opts?: { min?: number; max?: number; maxPresets?: number },
): PresetSuggestion[] {
  const min = opts?.min ?? 2;
  const max = opts?.max ?? 6;
  const maxPresets = opts?.maxPresets ?? 12;
  const known = new Set(models.map((m) => m.key));
  if (!parsed || !Array.isArray(parsed.presets)) return [];
  const out: PresetSuggestion[] = [];
  const seen = new Set<string>(); // dedupe identical model sets
  for (const p of parsed.presets) {
    if (!p || typeof p !== "object") continue;
    const po = p as Record<string, unknown>;
    const name = typeof po.name === "string" ? po.name.trim() : "";
    if (!name) continue;
    const rationale = typeof po.rationale === "string" ? po.rationale.trim() : "";
    const rawModels = Array.isArray(po.models) ? po.models : [];
    // Ground: keep only known keys, in order, deduped within the preset.
    const grounded: string[] = [];
    const inThis = new Set<string>();
    for (const k of rawModels) {
      if (typeof k !== "string") continue;
      const key = k.trim();
      if (!known.has(key) || inThis.has(key)) continue;
      inThis.add(key);
      grounded.push(key);
    }
    if (grounded.length < min) continue;
    const capped = grounded.slice(0, max);
    const sig = capped.slice().sort().join("|");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ name, rationale, models: capped });
    if (out.length >= maxPresets) break;
  }
  return out;
}
