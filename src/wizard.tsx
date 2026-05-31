import { useEffect, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { theme } from "./theme.ts";
import {
  bundledDemoVaultPath,
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

  useKeyboard((evt) => {
    if (status) return;
    if (evt.name === "up" || evt.name === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (evt.name === "down" || evt.name === "j") {
      setSelected((s) => Math.min(candidates.length - 1, s + 1));
    } else if (evt.name === "return" || evt.name === "enter") {
      void commit(candidates[selected]);
    } else if (evt.name === "q" || (evt.ctrl && evt.name === "c")) {
      renderer?.destroy?.();
      process.exit(0);
    }
  });

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
        {candidates.map((c, i) => (
          <Option key={c.path} candidate={c} active={i === selected} />
        ))}
        <text> </text>
        <text fg={theme.fgFaint}>
          ↑/↓ choose · enter to select · q to quit
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
        <text fg={theme.gold} attributes={1}>
          █▀█ █   █▀█ █▀▀ ▄▀█ █▀▄ █▄█   █ █
        </text>
        <text fg={theme.gold} attributes={1}>
          █▀█ █   █▀▄ ██▄ █▀█ █▄▀  █    █▄█
        </text>
        <text fg={theme.goldDim}>first run · welcome</text>
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

function shorten(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// Suppress unused import warning if bundledDemoVaultPath is needed later
void bundledDemoVaultPath;
void existsSync;
