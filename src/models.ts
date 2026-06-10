// Live model discovery per provider, so newly released models appear without a
// code change. Providers with a queryable catalog (ollama, lmstudio, openrouter)
// are discovered at runtime. Subscription CLIs (claude/codex/antigravity) expose
// no "list models" command, so they return [] and the desktop falls back to its
// curated catalog + auto-upgrading aliases (opus/sonnet/haiku).
export interface DiscoveredModel {
  id: string;
  label?: string;
  blurb?: string;
}

export async function discoverModels(provider: string): Promise<DiscoveredModel[]> {
  switch (provider) {
    case "ollama":
      return await discoverOllama();
    case "lmstudio":
      return await discoverLmStudio();
    case "openrouter":
      return await discoverOpenRouter();
    default:
      return []; // claude/codex/antigravity: no list API
  }
}

// Ollama's local HTTP API (/api/tags) → the models installed locally. Preferred
// over the `ollama list` CLI, which hangs when spawned non-interactively.
async function discoverOllama(): Promise<DiscoveredModel[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? [])
      .map((m) => m.name)
      .filter(Boolean)
      .map((name) => {
        const id = name.replace(/:latest$/, "");
        return { id, label: id, blurb: "local · installed" };
      });
  } catch {
    return [];
  }
}

// LM Studio exposes an OpenAI-compatible /v1/models on its local server.
async function discoverLmStudio(): Promise<DiscoveredModel[]> {
  try {
    const res = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, label: m.id, blurb: "local · LM Studio" }));
  } catch {
    return [];
  }
}

// OpenRouter's public catalog (no auth) — the full live list of routable models.
async function discoverOpenRouter(): Promise<DiscoveredModel[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { id: string; name?: string }[] };
    return (j.data ?? [])
      .filter((m) => m.id && !m.id.startsWith("~")) // skip preview/hidden aliases
      .map((m) => ({ id: m.id, label: m.name ?? m.id, blurb: "via OpenRouter" }));
  } catch {
    return [];
  }
}
