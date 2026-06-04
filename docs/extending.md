# Extending prevAIl

How to add new pieces without breaking existing ones. Each section ends at
the boundary where the rest of the code picks the change up for free.

## 1. Adding a new framework

Frameworks shape *the structure* of the answer (BLUF, SCQA, OODA, ...).
One file, one append:

```ts
// src/framework.ts
export type FrameworkId =
  | "bluf" | "win" | "scqa" | "sbar" | "ooda" | "proscons" | "steelman"
  | "my-new-id";                                  // ← add to the union

export const FRAMEWORKS: readonly Framework[] = [
  // ...existing entries...
  {
    id: "my-new-id",
    label: "MY-LABEL",                            // <=10 chars for the chip
    blurb: "One-line description for tooltips",
    instruction:
      "Apply <X>. Structure your response as ... . No preamble.",
  },
];
```

That's it. The ConfigBar chip cycles `[null, ...FRAMEWORKS]` so the new id
is picked up automatically. `/framework <id>` validates against
`isFrameworkId()` which also reads `FRAMEWORKS`. `buildFrameworkPreamble()`
wraps the instruction in `[FRAMEWORK: ...]` and `runChatTurn()` prepends it
to every CLI call.

Keep the instruction terse — codex tends to echo long preambles into the
reply bubble.

## 2. Adding a new lens

Lenses are *angles of attack* on the problem (first principles, contrarian,
executor, ...) — used by the council fanout when `lens=all`. Same shape as
frameworks:

```ts
// src/lens.ts
export type LensId =
  | "first-principles" | "outsider" | "contrarian" | "expansionist"
  | "executor" | "alien" | "mom" | "dad"
  | "my-new-lens";                                // ← add to the union

export const LENSES: readonly Lens[] = [
  // ...existing entries...
  {
    id: "my-new-lens",
    label: "MY LENS",                             // <=14 chars for the chip
    blurb: "Angle of attack in one line",
    instruction:
      "Approach this problem as <X>. <directive in one paragraph>.",
  },
];
```

Then update README's lens list so users discover it. The ConfigBar chip
cycle reads `LENSES` directly; `/council lens <id>` validates through
`isLensId()`; `expandLensSelection("all")` picks the new lens up
automatically — `lens=all` becomes panelists × (N+1) calls, so be aware
of the cost cap.

## 3. Adding a new CLI bridge

Adding a new subprocess CLI (say `mistral-cli`) means touching one file —
`src/cli-bridge.ts` — in five places:

```ts
// 1. The union
export type CliKind = "claude" | "codex" | "gemini" | "ollama" | "mistral";

// 2. Detection
const CANDIDATES = [
  { kind: "claude", bins: ["claude"], label: "Claude" },
  // ...
  { kind: "mistral", bins: ["mistral-cli", "mistral"], label: "Mistral" },
];

// 3. Quick-pick model versions
const MISTRAL_VERSIONS = ["mistral-large-2", "mistral-medium", "mistral-small"];
const CLI_DEFAULT_MODELS: Record<CliKind, string> = {
  // ...
  mistral: MISTRAL_VERSIONS[0]!,
};
export const MODEL_QUICKPICKS_FALLBACK: Record<CliKind, string[]> = {
  // ...
  mistral: MISTRAL_VERSIONS,
};

// 4. The hint shown in the model picker
export const CLI_MODEL_HINT: Record<CliKind, string> = {
  // ...
  mistral: "e.g. mistral-large-2, mistral-medium",
};

// 5. The run path in runChatTurn
if (cli.kind === "mistral") {
  const args = m ? ["-m", m, framedPrompt] : [framedPrompt];
  return runCapture(cli.bin, args, cwd, signal, onChunk);
}
```

If the CLI emits a noisy envelope (like codex/gemini), add an
`extractMistralReply()` helper and call it on the raw output. If it has a
real system-prompt channel like `claude --append-system-prompt`, wire the
operating manual in too — otherwise leave the manual gating alone.

## 4. Adding a new ConfigBar chip

ConfigBar chips live in `src/workspace-config-bar.tsx`. The pattern:

```tsx
<box
  flexDirection="row"
  paddingLeft={1}
  paddingRight={1}
  onMouseDown={cycleMyChip}
>
  <text fg={labelFg}>{"◆ MyChip:"}</text>
  <text fg={myValFg} attributes={myOn ? 1 : 0}>{` ${myLabel}`}</text>
</box>
{sep}
```

Two non-negotiable rules:

- **Two adjacent `<text>` cells inside one `<box>`** — opentui clips a
  single `<text>` that mixes literal segments with JSX interpolation. The
  label cell is one `<text>`; the value cell is another. Same row.
- **NBSP-prefix the value cell** — opentui strips leading whitespace from
  text cells. The value cell starts with a U+00A0 non-breaking space so
  the rendered output has a visible gap between label and value. The
  template literal `` ` ${myLabel}` `` is using NBSP, not regular space.

For the backing state, follow the `readX` / `setX` pattern in `src/config.ts`
with a `domainKey?: string` parameter so the chip can flip between global
and per-domain scope. Read with `resolveX(domainKey)` when the chip should
show the effective value, including fallthrough to the global default.

## 5. Adding a new slash command

Three steps, all in two files:

```tsx
// src/chat-pane.tsx
export type ChatCommand =
  // ...existing variants...
  | { kind: "my-cmd"; arg: string };

function parseSlashCommand(text: string): ChatCommand {
  // ...existing matches...
  if (m = /^\/my-cmd\s+(.+)$/.exec(text)) {
    return { kind: "my-cmd", arg: m[1]!.trim() };
  }
  // ...
}
```

```tsx
// src/app.tsx — handleChatCommand
function handleChatCommand(key: string, cmd: ChatCommand) {
  switch (cmd.kind) {
    // ...
    case "my-cmd":
      // do the thing. Use writeTurnSummary if it produced something the
      // user would want in _log; otherwise just feed UI state.
      break;
  }
}
```

If the command needs autocomplete, register it in the slash-suggestion
list in `chat-pane.tsx` so it surfaces while the user types `/my-`.

## 6. Adding a new vault subfolder convention

Two auto-writers already exist and are the model for any new one:

- `writeTurnSummary()` in `src/auto-summary.ts` — appends to `_log/`.
- `distillTurnToJournal()` in `src/journal.ts` — distills to `_journal/`.

To add a new auto-written folder (e.g. `_briefs/` for daily briefings):

1. Write a writer module that accepts the same shape as `TurnSummaryArgs`
   (domainPath, ts, content) and `mkdir -p` the folder if missing.
2. Never throw — file errors swallowed, the chat path must not block on a
   side-effect writer.
3. Wire it from `src/app.tsx` next to the existing `writeTurnSummary()` /
   `distillTurnToJournal()` callsites for both the single-chat path
   (~line 1545) and the council path (~line 1875).
4. If the folder needs tamper-evidence, append `<entry-id> <sha256>` to a
   sibling `.shasum` and teach `prevail vault verify` about the new path.

## 7. Style notes

- **TypeScript strict mode.** No implicit any, no unused locals. The
  build script runs `tsc --noEmit` before bundling.
- **No `shell: true`.** Every `spawn()` call uses an argv array. Prompt
  content is never interpolated into a shell string.
- **No `console.log` in TUI paths.** opentui renders into the same TTY
  the cockpit owns — anything written to stdout corrupts the frame.
  Use the debug log writer instead and tail the file from another shell.
- **opentui rendering gotchas:**
  - Trailing AND leading whitespace inside a `<text>` cell is stripped.
    Use U+00A0 (NBSP) for any spacing you want preserved.
  - A `<text>` cell that mixes literal segments with JSX interpolation
    clips. Split into two adjacent `<text>` nodes inside one `<box>`.
  - `height={1}` rows assume one terminal row; multi-line `<text>` inside
    a fixed-height row gets clipped to one row of glyphs.
- **Side-effect writers are best-effort.** `writeTurnSummary()` and
  `distillTurnToJournal()` swallow their own errors. The chat path is
  the contract; the vault layer is the index.
