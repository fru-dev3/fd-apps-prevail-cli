import { defaultModelFor } from "../../cli-bridge.ts";
import type { ChatMsg } from "../types.ts";

// One-line dim badge rendered DIRECTLY UNDER every assistant bubble.
// Shape: `<cli> · <model> · ◆ <framework> · ◇ <lens>` with a `verdict ·`
// prefix on council-verdict bubbles. Any segment whose value is missing
// is dropped, so a vanilla chat with no framework + default model
// collapses to just `<cli>` — and when even that's redundant we return
// null and the caller skips the row entirely.
//
// Display labels (BLUF, CONTRARIAN, ...) come pre-resolved on the ChatMsg
// — no id-to-label lookup here, so this stays pure / cheap on every
// re-render of the transcript.
export function formatMetaBadge(
  msg: ChatMsg,
  opts: { verdict?: boolean } = {},
): string | null {
  const parts: string[] = [];
  if (msg.cli) parts.push(msg.cli);
  // Model name is shown for EVERY panelist, even when not explicitly
  // pinned. If the user didn't set a model on this CLI in council
  // config, msg.model is "" and we resolve to the CLI's hand-maintained
  // default (CLAUDE_VERSIONS[0] etc.) with a `(default)` suffix so the
  // user knows it wasn't pinned. Without this, mixed configs (claude
  // pinned to opus-4-7, codex/gemini on defaults) showed full info on
  // the pinned panelist and a bare `codex` / `gemini` on the rest —
  // user reported "the rest don't tell me which model is responding."
  const explicit = msg.model && msg.model.trim();
  if (explicit) {
    parts.push(msg.model!.trim());
  } else if (msg.cli) {
    parts.push(`${defaultModelFor(msg.cli)} (default)`);
  }
  if (msg.framework) parts.push(`◆ ${msg.framework}`);
  if (msg.lens) parts.push(`◇ ${msg.lens}`);
  if (parts.length === 0) return null;
  return opts.verdict ? `verdict · ${parts.join(" · ")}` : parts.join(" · ");
}
