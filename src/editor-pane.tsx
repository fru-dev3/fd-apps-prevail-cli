import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { theme } from "./theme.ts";

interface EditTarget {
  path: string;
  name: string;
}

interface Props {
  target: EditTarget;
  filename: string;
  onExit: (saved: boolean) => void;
}

export function EditorPane({ target, filename, onExit }: Props) {
  const filePath = join(target.path, filename);
  const [initial] = useState(() => {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  });
  const [status, setStatus] = useState<string | null>(null);
  const ref = useRef<any>(null);

  useEffect(() => {
    const node = ref.current;
    try {
      node?.focus?.();
    } catch {}
  }, []);

  function readCurrent(): string {
    const node = ref.current;
    try {
      const text = node?.getTextRange?.(0, 10_000_000);
      if (typeof text === "string") return text;
    } catch {}
    return initial;
  }

  function save() {
    try {
      const text = readCurrent();
      writeFileSync(filePath, text);
      setStatus("saved ✓ — returning…");
      setTimeout(() => onExit(true), 400);
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      onExit(false);
      return;
    }
    if (evt.ctrl && evt.name === "s") {
      save();
      return;
    }
  });

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.gold}
      backgroundColor={theme.bg}
      title={` editing ${target.name}/${filename} `}
      titleAlignment="left"
      bottomTitle=" ctrl-s save · esc cancel "
      bottomTitleAlignment="left"
    >
      <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
        <textarea
          ref={ref}
          focused
          initialValue={initial}
          backgroundColor={theme.bg}
          textColor={theme.fg}
          placeholder="(empty file — start typing)"
        />
      </box>
      {status && (
        <box height={1} paddingLeft={2} backgroundColor={theme.bgPanel}>
          <text fg={theme.gold}>{status}</text>
        </box>
      )}
    </box>
  );
}
