import { useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { theme } from "./theme.ts";
import {
  detectVaultCandidates,
  writeConfig,
  type VaultCandidate,
} from "./config.ts";
import { scaffoldDomain } from "./domain-scaffold.ts";

interface Props {
  onDone: (vaultPath: string) => void;
}

const SEED_DOMAINS = [
  "wealth",
  "health",
  "tax",
  "career",
  "business",
  "real-estate",
  "insurance",
  "benefits",
  "content",
  "brand",
  "calendar",
  "vision",
  "intel",
  "learning",
  "home",
  "social",
  "records",
  "estate",
  "explore",
];

export function FirstRunWizard({ onDone }: Props) {
  const renderer = useRenderer();
  const [candidates] = useState<VaultCandidate[]>(() => detectVaultCandidates());
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  // When the user picks the "custom" sentinel option, we flip into
  // input mode and capture the path they type. The list view goes away
  // so the input has the full focus; pressing Esc returns to the list.
  const [customMode, setCustomMode] = useState(false);

  useKeyboard((evt) => {
    if (status) return;
    if (customMode) return; // CustomPathInput owns the keyboard in input mode
    if (evt.name === "up" || evt.name === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (evt.name === "down" || evt.name === "j") {
      setSelected((s) => Math.min(candidates.length - 1, s + 1));
    } else if (evt.name === "return" || evt.name === "enter") {
      const chosen = candidates[selected];
      if (chosen?.kind === "custom") {
        setCustomMode(true);
      } else if (chosen) {
        void commit(chosen);
      }
    } else if (evt.name === "q" || (evt.ctrl && evt.name === "c")) {
      renderer?.destroy?.();
      process.exit(0);
    }
  });

  function commitCustom(rawPath: string) {
    setCustomMode(false);
    const trimmed = rawPath.trim();
    if (!trimmed) {
      setStatus("path is empty — pick an option or try again");
      setTimeout(() => setStatus(null), 2000);
      return;
    }
    // Expand ~ and resolve to absolute. Refuse paths that look obviously
    // wrong (relative to / when CWD isn't root, etc.) by always going
    // through resolve(homedir(), ...) when ~/-prefixed.
    const expanded = trimmed.startsWith("~/")
      ? resolve(homedir(), trimmed.slice(2))
      : resolve(process.cwd(), trimmed);
    const c: VaultCandidate = {
      // Reuse "default-home" semantics: scaffold if missing, otherwise
      // adopt as-is. Same code path the existing default-home option
      // takes.
      kind: "default-home",
      label: expanded,
      path: expanded,
      exists: existsSync(expanded),
    };
    void commit(c);
  }

  async function commit(c: VaultCandidate) {
    setStatus(`preparing ${c.label}…`);
    try {
      if (c.kind === "demo") {
        writeConfig({ vaultPath: c.path, createdAt: new Date().toISOString() });
        setStatus(`✓ using bundled demo — booting cockpit…`);
        setTimeout(() => onDone(c.path), 500);
        return;
      }
      if (c.kind === "default-home" || c.kind === "current-dir") {
        if (!c.exists) {
          mkdirSync(c.path, { recursive: true });
          for (const name of SEED_DOMAINS) {
            scaffoldDomain(c.path, name);
          }
          setStatus(`✓ scaffolded ${SEED_DOMAINS.length} domains at ${shorten(c.path)} — booting…`);
        } else {
          setStatus(`✓ using existing vault at ${shorten(c.path)} — booting…`);
        }
        writeConfig({ vaultPath: c.path, createdAt: new Date().toISOString() });
        setTimeout(() => onDone(c.path), 700);
        return;
      }
      if (c.kind === "ai-folder") {
        if (!c.exists) {
          setStatus(`~/.ai/vault does not exist yet — pick another option`);
          setTimeout(() => setStatus(null), 2000);
          return;
        }
        writeConfig({ vaultPath: c.path, createdAt: new Date().toISOString() });
        setStatus(`✓ pointing at your existing ${shorten(c.path)} — booting…`);
        setTimeout(() => onDone(c.path), 500);
        return;
      }
    } catch (err) {
      setStatus(`✗ ${(err as Error).message}`);
      setTimeout(() => setStatus(null), 3000);
    }
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.bg}
      alignItems="center"
      justifyContent="center"
    >
      <box
        flexDirection="column"
        width={86}
        height={26}
        border
        borderStyle="double"
        borderColor={theme.gold}
        backgroundColor={theme.bg}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
      >
        <Header />
        <text> </text>
        <text fg={theme.fgDim}>where should your life vault live?</text>
        <text fg={theme.fgFaint}>
          (vaults are folders of markdown — one subfolder per life domain)
        </text>
        <text> </text>
        {customMode ? (
          <CustomPathInput
            onSubmit={commitCustom}
            onCancel={() => setCustomMode(false)}
          />
        ) : (
          candidates.map((c, i) => (
            <Option
              key={`${c.kind}-${c.path}`}
              candidate={c}
              active={i === selected}
            />
          ))
        )}
        <text> </text>
        <text fg={theme.fgFaint}>
          {customMode
            ? "enter to use this path · esc to go back · q to quit"
            : "↑/↓ choose · enter to select · q to quit"}
        </text>
        <text> </text>
        {status && <text fg={theme.gold}>{status}</text>}
      </box>
    </box>
  );
}

function Header() {
  return (
    <box flexDirection="row">
      <box flexDirection="column" width={11} paddingTop={0}>
        <text fg={theme.goldDim}> ╲ │ ╱ </text>
        <text fg={theme.gold} attributes={1}> ─ ◈ ─ </text>
        <text fg={theme.goldDim}> ╱ │ ╲ </text>
      </box>
      <box flexDirection="column" paddingLeft={2}>
        {/* prevAIl — "AI" rendered in aiAccent (electric cyan) for high
            contrast against the gold "prev" / "l". Mirrors the main
            cockpit logo so first-run and steady-state feel like the
            same brand surface. */}
        <text attributes={1}>
          <span fg={theme.gold}>{"█▀█ █▀▄ █▀▀ █ █ "}</span>
          <span fg={theme.aiAccent}>{"▄▀█ █"}</span>
          <span fg={theme.gold}>{" █  "}</span>
        </text>
        <text attributes={1}>
          <span fg={theme.gold}>{"█▀▀ █▀▄ ██▄  █  "}</span>
          <span fg={theme.aiAccent}>{"█▀█ █"}</span>
          <span fg={theme.gold}>{" █▄▄"}</span>
        </text>
        <text fg={theme.goldDim}>first run · welcome to prevAIl</text>
      </box>
    </box>
  );
}

function Option({ candidate, active }: { candidate: VaultCandidate; active: boolean }) {
  const pointer = active ? "▸ " : "  ";
  const fg = active ? theme.gold : candidate.exists ? theme.fg : theme.fgDim;
  const existsTag = candidate.exists ? "" : " (will create)";
  const isDemoTag = candidate.kind === "demo" ? "  ●● recommended" : "";
  return (
    <box flexDirection="row" backgroundColor={active ? theme.selBg : theme.bg} height={1}>
      <text fg={fg}>
        {pointer}
        {candidate.label}
        {existsTag}
      </text>
      <text fg={theme.ok}>{isDemoTag}</text>
    </box>
  );
}

// Inline path-input shown when the user picks the "type a custom path"
// sentinel option. Same multi-pass focus pattern as the CommandBar's
// FocusedInput — opentui's `focused` prop sometimes loses the first
// keystroke if the user types before the focus has settled, so we
// re-focus across 0 / 30 / 120 ms to catch the race window.
function CustomPathInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (path: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const focus = () => {
      try { ref.current?.focus?.(); } catch {}
    };
    focus();
    const ids = [
      setTimeout(focus, 0),
      setTimeout(focus, 30),
      setTimeout(focus, 120),
    ];
    return () => ids.forEach(clearTimeout);
  }, []);
  useKeyboard((evt) => {
    if (evt.name === "escape") onCancel();
  });
  return (
    <box flexDirection="column">
      <text fg={theme.fgFaint}>
        absolute, ~/relative, or relative to your current dir. tilde and ~ both expand.
      </text>
      <box flexDirection="row" backgroundColor={theme.selBg} height={1}>
        <text fg={theme.gold}>{"vault path › "}</text>
        <input
          ref={ref}
          focused
          placeholder="~/Documents/my-vault"
          maxLength={400}
          backgroundColor={theme.selBg}
          textColor={theme.selFg}
          onSubmit={onSubmit as any}
        />
      </box>
    </box>
  );
}

function shorten(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
