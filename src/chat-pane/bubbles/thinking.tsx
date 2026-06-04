import { spinnerChar, theme, thinkingWord } from "../../theme.ts";

export function ThinkingBubble({ tick, cliLabel }: { tick: number; cliLabel: string }) {
  const char = spinnerChar(tick);
  const word = thinkingWord(tick);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box
        flexDirection="row"
        border
        borderColor={theme.bubbleAssistant}
        backgroundColor={theme.bg}
        title={` ${cliLabel} `}
        titleAlignment="left"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.gold}>{char}</text>
        <text fg={theme.fgDim}>  {word}…</text>
      </box>
    </box>
  );
}
