import { useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "./theme.ts";

export type ToolbarAction = "new" | "chat" | "edit" | "refresh" | "quit";

interface Props {
  mode: "idle" | "new-domain" | "new-app" | "new-skill" | "pick-cli" | "chat" | "edit";
  prompt: string;
  message: string | null;
  cliOptions?: string[];
  cliIndex?: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onAction: (a: ToolbarAction) => void;
}

export function CommandBar({
  mode,
  prompt,
  message,
  cliOptions,
  cliIndex,
  onSubmit,
  onCancel,
  onAction,
}: Props) {
  if (mode === "pick-cli" && cliOptions) {
    return (
      <box flexDirection="row" height={1} paddingLeft={2} backgroundColor={theme.selBg}>
        <text fg={theme.gold}>{prompt} </text>
        {cliOptions.map((opt, i) => (
          <text key={opt} fg={i === cliIndex ? theme.selFg : theme.fgDim}>
            {i === cliIndex ? `[${opt}] ` : ` ${opt}  `}
          </text>
        ))}
        <text fg={theme.fgFaint}>(←/→ pick · enter run · esc cancel)</text>
      </box>
    );
  }

  if (mode === "new-domain" || mode === "new-app" || mode === "new-skill") {
    return (
      <box flexDirection="row" height={1} paddingLeft={2} backgroundColor={theme.selBg}>
        <text fg={theme.gold}>{prompt} </text>
        <FocusedInput onSubmit={onSubmit} onCancel={onCancel} />
      </box>
    );
  }

  return (
    <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={theme.bgPanel}>
      {message ? (
        <box flexDirection="row" flexGrow={1} paddingLeft={1}>
          <text fg={theme.gold}>{message}</text>
        </box>
      ) : (
        <Toolbar onAction={onAction} />
      )}
    </box>
  );
}

function Toolbar({ onAction }: { onAction: (a: ToolbarAction) => void }) {
  return (
    <box flexDirection="row" flexGrow={1}>
      <Button label="n new" hint="add a domain" onClick={() => onAction("new")} />
      <Button label="c chat" hint="talk to claude" onClick={() => onAction("chat")} />
      <Button label="e edit" hint="open in $EDITOR" onClick={() => onAction("edit")} />
      <Button label="r refresh" hint="rescan vault" onClick={() => onAction("refresh")} />
      <Button label="q quit" hint="exit" onClick={() => onAction("quit")} />
      <box flexGrow={1} />
      <text fg={theme.fgFaint}>↑↓ domain · tab cycle view · click anywhere</text>
    </box>
  );
}

function Button({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={2}
      backgroundColor={theme.bgPanel}
      onMouseDown={onClick}
    >
      <text fg={theme.gold}>{`[${label}] `}</text>
      <text fg={theme.fgFaint}>{hint}</text>
    </box>
  );
}

function FocusedInput({ onSubmit, onCancel }: { onSubmit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    try {
      node.focus?.();
    } catch {}
  }, []);

  useKeyboard((evt) => {
    if (evt.name === "escape") onCancel();
  });

  return (
    <input
      ref={ref}
      focused
      placeholder="domain-name (lowercase, kebab-case)"
      maxLength={48}
      backgroundColor={theme.selBg}
      textColor={theme.selFg}
      onSubmit={onSubmit as any}
    />
  );
}
