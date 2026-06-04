import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";
import {
  MODEL_QUICKPICKS,
  type AvailableCli,
} from "../cli-bridge.ts";
import {
  readCouncilConfig,
  readResponseFramework,
  setCouncilClis,
  setCouncilModel,
  addCouncilModel,
  removeCouncilModel,
  setCouncilChair,
  setResponseFramework,
  type CliKind as ConfigCliKind,
} from "../config.ts";
import { FRAMEWORKS, getFramework, type FrameworkId } from "../framework.ts";

const COUNCIL_KINDS: ConfigCliKind[] = ["claude", "codex", "gemini", "ollama"];

function CouncilConfigBubble({
  availableClis,
  councilMode,
  onToggleCouncilMode,
}: {
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
}) {
  // Force re-render after each click that mutates persistent config.
  const [_revision, setRevision] = useState(0);
  const cfg = readCouncilConfig();
  const detectedKinds = new Set(availableClis.map((c) => c.kind));

  const isInPanel = (k: ConfigCliKind): boolean => {
    if (cfg.clis === null) return detectedKinds.has(k);
    return cfg.clis.includes(k);
  };

  const togglePanel = (k: ConfigCliKind) => {
    if (!detectedKinds.has(k)) return;
    const detectedList = Array.from(detectedKinds) as ConfigCliKind[];
    const current = cfg.clis ?? detectedList;
    const next = current.includes(k)
      ? current.filter((x) => x !== k)
      : [...current, k];
    setCouncilClis(next.length === 0 ? [] : next);
    setRevision((r) => r + 1);
  };

  // Set "default" (no pin) — clears all model variants for this CLI.
  const resetModels = (k: ConfigCliKind) => {
    setCouncilModel(k, null);
    setRevision((r) => r + 1);
  };
  // Toggle a model variant in/out of the panel for this CLI. Lets the user
  // build a comparison panel (e.g. opus-4-7 + opus-4-8 + sonnet) by checking
  // multiple chips on the same row.
  const toggleVariant = (k: ConfigCliKind, m: string, isOn: boolean) => {
    if (isOn) removeCouncilModel(k, m);
    else addCouncilModel(k, m);
    setRevision((r) => r + 1);
  };

  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="column"
        border
        borderColor={theme.gold}
        backgroundColor={theme.bg}
        title=" ◆ council panel · click to toggle "
        titleAlignment="left"
        bottomTitle=" persists to ~/.prevail/config.json "
        bottomTitleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
      >
        {COUNCIL_KINDS.map((kind) => {
          const detected = detectedKinds.has(kind);
          const inPanel = detected && isInPanel(kind);
          const checkbox = inPanel ? "[×]" : detected ? "[ ]" : "[—]";
          const checkboxFg = inPanel
            ? theme.gold
            : detected
              ? theme.fgDim
              : theme.fgFaint;
          const nameFg = detected ? theme.gold : theme.fgFaint;
          const pinnedList = cfg.models[kind] ?? [];
          const hasAnyPin = pinnedList.length > 0;
          const picks = MODEL_QUICKPICKS[kind] ?? [];
          // Surface custom model entries the user added that aren't in the
          // built-in quickpicks (typed via /council model claude add foo).
          const customPins = pinnedList.filter((m) => !picks.includes(m));
          return (
            <box key={kind} flexDirection="column" paddingTop={0}>
              <box
                flexDirection="row"
                height={1}
                onMouseDown={() => togglePanel(kind)}
              >
                <text fg={checkboxFg} attributes={inPanel ? 1 : 0}>
                  {checkbox}{" "}
                </text>
                <text fg={nameFg} attributes={inPanel ? 1 : 0}>
                  {kind}
                </text>
                {!detected && (
                  <text fg={theme.fgFaint}>  (not on PATH)</text>
                )}
                {detected && (
                  <text fg={theme.fgFaint}>
                    {"  → "}
                    {hasAnyPin ? pinnedList.join(", ") : "default model"}
                  </text>
                )}
              </box>
              {detected && (() => {
                // Aliases ("opus", "sonnet", "haiku") are CLI shorthand that
                // resolves to *the latest* model in that tier. Versioned IDs
                // ("claude-opus-4-7") pin a specific version. We show them on
                // separate rows so the comparison is explicit.
                //
                // Width matters: cramming all 6 claude versions on one row
                // overflows the bubble and right-edge chips get clipped
                // mid-string (the user sees "claude-opus-" with no number).
                // So we group versions by tier prefix (opus / sonnet / haiku)
                // and render each tier on its own row.
                const isVersionId = (s: string) => /-\d/.test(s);
                const aliasPicks = picks.filter((p) => !isVersionId(p));
                const versionPicks = picks.filter(isVersionId);
                const renderChip = (p: string, displayLabel?: string) => {
                  const isOn = pinnedList.includes(p);
                  return (
                    <CouncilModelChip
                      key={p}
                      label={displayLabel ?? p}
                      active={isOn}
                      onClick={() => toggleVariant(kind, p, isOn)}
                    />
                  );
                };
                // Group versions by tier so claude's 6 IDs become 3 rows of
                // 1-3 chips each. For codex/gemini (4 versions) the group is
                // just one row, which is fine.
                const tierOf = (s: string): string => {
                  const m = s.match(/^(?:claude-|gemini-|gpt-)?([a-z0-9]+)/i);
                  return m?.[1]?.toLowerCase() ?? s;
                };
                const versionTiers = new Map<string, string[]>();
                for (const v of versionPicks) {
                  const t = tierOf(v);
                  const arr = versionTiers.get(t) ?? [];
                  arr.push(v);
                  versionTiers.set(t, arr);
                }
                return (
                  <box flexDirection="column">
                    <box flexDirection="row" height={1} paddingLeft={2}>
                      <text fg={theme.fgFaint}>aliases: </text>
                      <CouncilModelChip
                        label="default"
                        active={!hasAnyPin}
                        onClick={() => resetModels(kind)}
                      />
                      {aliasPicks.map((p) =>
                        renderChip(p, `${p} (latest)`),
                      )}
                    </box>
                    {[...versionTiers.entries()].map(([tier, list]) => (
                      <box
                        key={tier}
                        flexDirection="row"
                        height={1}
                        paddingLeft={2}
                      >
                        <text fg={theme.fgFaint}>
                          {`${tier.padEnd(8, " ")}:`}
                        </text>
                        {list.map((p) =>
                          // Codex pinned versions are blocked when codex is
                          // logged in via ChatGPT-account auth (the common
                          // case). Suffix the chip label with * so the user
                          // sees up-front which picks need API-key auth; the
                          // footer below the section explains.
                          renderChip(
                            p,
                            kind === "codex" ? `${p} *` : undefined,
                          ),
                        )}
                      </box>
                    ))}
                    {kind === "codex" && versionPicks.length > 0 && (
                      <box flexDirection="row" height={1} paddingLeft={2}>
                        <text fg={theme.fgFaint}>
                          {"         * pinned codex models require codex login --api-key — ChatGPT-account auth only allows the default"}
                        </text>
                      </box>
                    )}
                    {customPins.length > 0 && (
                      <box flexDirection="row" height={1} paddingLeft={2}>
                        <text fg={theme.fgFaint}>custom:  </text>
                        {customPins.map((p) => (
                          <CouncilModelChip
                            key={p}
                            label={p}
                            active
                            onClick={() => toggleVariant(kind, p, true)}
                          />
                        ))}
                      </box>
                    )}
                  </box>
                );
              })()}
              <text> </text>
            </box>
          );
        })}
        {(() => {
          // Verdict synthesizer (chair). null = auto: first panelist that
          // returns. Pinning lets the user always have e.g. claude write the
          // verdict no matter who else is on the panel. Click a chip to set;
          // click "auto" to clear.
          const chair = cfg.chair;
          const pickChair = (next: { cli: ConfigCliKind } | null) => {
            setCouncilChair(next);
            setRevision((r) => r + 1);
          };
          return (
            <box flexDirection="column" paddingTop={0}>
              <box flexDirection="row" height={1}>
                <text fg={theme.gold} attributes={1}>verdict synthesizer</text>
                <text fg={theme.fgFaint}>
                  {"  → "}
                  {chair
                    ? chair.model
                      ? `${chair.cli} · ${chair.model}`
                      : chair.cli
                    : "auto (first panelist to reply)"}
                </text>
              </box>
              <box flexDirection="row" height={1} paddingLeft={2}>
                <text fg={theme.fgFaint}>chair:   </text>
                <CouncilModelChip
                  label="auto"
                  active={chair === null}
                  onClick={() => pickChair(null)}
                />
                {COUNCIL_KINDS.map((k) => (
                  <CouncilModelChip
                    key={k}
                    label={k}
                    active={chair?.cli === k}
                    onClick={() => pickChair({ cli: k })}
                  />
                ))}
              </box>
              <text> </text>
            </box>
          );
        })()}
        {(() => {
          // Response framework picker. Sets the global responseFramework
          // config key, which runChatTurn reads on every call and prepends
          // as a bracketed instruction to the prompt. Click any chip to
          // switch; click "none" to clear.
          const active = readResponseFramework();
          const pickFw = (id: FrameworkId | null) => {
            setResponseFramework(id);
            setRevision((r) => r + 1);
          };
          const activeFw = getFramework(active);
          return (
            <box flexDirection="column" paddingTop={0}>
              <box flexDirection="row" height={1}>
                <text fg={theme.gold} attributes={1}>response framework</text>
                <text fg={theme.fgFaint}>
                  {"  → "}
                  {activeFw ? `${activeFw.label} · ${activeFw.blurb}` : "none (model picks structure)"}
                </text>
              </box>
              <box flexDirection="row" height={1} paddingLeft={2}>
                <text fg={theme.fgFaint}>style:   </text>
                <CouncilModelChip
                  label="none"
                  active={active === null}
                  onClick={() => pickFw(null)}
                />
                {FRAMEWORKS.map((f) => (
                  <CouncilModelChip
                    key={f.id}
                    label={f.label}
                    active={active === f.id}
                    onClick={() => pickFw(f.id)}
                  />
                ))}
              </box>
              <text> </text>
            </box>
          );
        })()}
        <box
          flexDirection="row"
          height={1}
          onMouseDown={onToggleCouncilMode}
        >
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={councilMode ? theme.selBg : theme.bgPanel}
          >
            <text fg={councilMode ? theme.goldBright : theme.gold} attributes={1}>
              {councilMode ? "▣ council mode ON" : "▸ ask the council  (next message fans out)"}
            </text>
          </box>
          {councilMode && (
            <text fg={theme.fgFaint}>  · click again to turn off · or just type /council</text>
          )}
        </box>
        <text> </text>
      </box>
    </box>
  );
}

// Full-pane overlay version of the council configuration UI. Rendered by App
// when councilConfigOpen is true — keeps the config out of the chat transcript.
// ESC closes; clicking "done" closes; mutations persist immediately to
// ~/.prevail/config.json (same handlers as the original bubble).
export function CouncilConfigPanel({
  availableClis,
  councilMode,
  onToggleCouncilMode,
  onClose,
}: {
  availableClis: AvailableCli[];
  councilMode: boolean;
  onToggleCouncilMode: () => void;
  onClose: () => void;
}) {
  useKeyboard((evt) => {
    if (evt.name === "escape") onClose();
  });
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title=" ⚖ configure council "
      titleAlignment="left"
      bottomTitle=" esc or click [done] to close · changes save instantly "
      bottomTitleAlignment="left"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={theme.fgDim}>
        Pick which CLIs run when council mode is active, and (optionally) pin a
        specific model per CLI. The toggle at the bottom is the same toggle as
        the [⚖ Council] chip in the top-right of the chat.
      </text>
      <text> </text>
      <CouncilConfigBubble
        availableClis={availableClis}
        councilMode={councilMode}
        onToggleCouncilMode={onToggleCouncilMode}
      />
      <box flexGrow={1} />
      <box flexDirection="row" height={1} onMouseDown={onClose}>
        <text fg={theme.gold} attributes={1}>[ done ]</text>
        <text fg={theme.fgFaint}>  · esc also closes</text>
      </box>
    </box>
  );
}

function CouncilModelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  // Bordered chip — gives an obvious clickable hit target so the user sees
  // these as buttons (the borderless ModelChip in the picker bar reads as
  // text, which confused users in the inline council bubble).
  const bg = active ? theme.selBg : theme.bgPanel;
  const fg = active ? theme.goldBright : theme.gold;
  const border = active ? theme.goldBright : theme.fgDim;
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      borderColor={border}
      border={["left", "right"]}
      onMouseDown={onClick}
    >
      <text fg={fg} bg={bg} attributes={active ? 1 : 0}>
        {label}
      </text>
    </box>
  );
}
