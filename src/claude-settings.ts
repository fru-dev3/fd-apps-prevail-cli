// Settings the engine hands a Claude Code launch through `--settings`.
//
// Claude Code reads ONE --settings value per launch. Given the flag twice, the
// later value replaces the earlier one (checked against claude 2.1.283: the
// first file's setting was dropped). So every piece a turn needs is merged into
// a single value before launch, never passed as a second flag.

export type ClaudeSettings = Record<string, unknown>;

// Load AGENTS.md files beside CLAUDE.md. The default mode loads AGENTS.md only
// when the project has no CLAUDE.md, and a Prevail vault root carries a
// CLAUDE.md link to VAULT.md, so without this a harness folder's AGENTS.md is
// skipped. Claude Code honours the option from user settings, --settings (file
// or inline JSON) and managed settings, never from a project's
// .claude/settings.json. A claude older than 2.1.277 ignores the key.
export const AGENTS_MD_SETTINGS: ClaudeSettings = {
  pluginConfigs: {
    "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function copyValue(v: unknown): unknown {
  if (isPlainObject(v)) return mergeClaudeSettings(v);
  if (Array.isArray(v)) return v.map(copyValue);
  return v;
}

// Deep merge, left to right: objects merge key by key, arrays concatenate (so
// hooks from every part still run), and any other value from a later part
// wins. Inputs are never mutated.
export function mergeClaudeSettings(...parts: Array<ClaudeSettings | null | undefined>): ClaudeSettings {
  const out: ClaudeSettings = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part)) {
      const current = out[key];
      if (isPlainObject(current) && isPlainObject(value)) out[key] = mergeClaudeSettings(current, value);
      else if (Array.isArray(current) && Array.isArray(value)) out[key] = [...current, ...value.map(copyValue)];
      else out[key] = copyValue(value);
    }
  }
  return out;
}

// The one --settings value for a claude launch, or null for none. `gate`
// writes the act-gate hook file with `extra` merged in and returns its path
// (null when the turn carries no gate). The AGENTS.md option rides in that
// file when there is one, and goes as inline JSON when there is not or the
// gate could not be written (claude accepts either form).
export function claudeSettingsArg(opts: {
  gate: ((extra?: ClaudeSettings) => string) | null;
  agentsMd: boolean;
}): string | null {
  const extra = opts.agentsMd ? AGENTS_MD_SETTINGS : undefined;
  if (opts.gate) {
    try {
      return opts.gate(extra);
    } catch {
      /* the gws spine still holds for Google; never break the turn */
    }
  }
  return extra ? JSON.stringify(extra) : null;
}
