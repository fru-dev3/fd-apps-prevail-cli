import { theme } from "./theme.ts";
import type { Domain } from "./vault.ts";

interface Props {
  domains: Domain[];
  selectedIndex: number;
  vaultLabel: string;
  onPick: (i: number) => void;
}

export function DomainList({ domains, selectedIndex, vaultLabel, onPick }: Props) {
  return (
    <box
      flexDirection="column"
      width={30}
      border
      borderColor={theme.border}
      title=" DOMAINS "
      titleAlignment="left"
      bottomTitle={` ${vaultLabel} `}
      bottomTitleAlignment="left"
      backgroundColor={theme.bgPanel}
      paddingTop={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.fgDim}>{domains.length} life domains</text>
      <text> </text>
      <scrollbox flexGrow={1} scrollY stickyScroll={false}>
        {domains.map((domain, i) => {
          const active = i === selectedIndex;
          const fg = active ? theme.selFg : theme.fg;
          const bg = active ? theme.selBg : theme.bgPanel;
          const pointer = active ? "› " : "  ";
          const badgeColor = domain.openLoopCount > 0 ? theme.warn : theme.fgFaint;
          const badge = domain.openLoopCount.toString().padStart(2, " ");
          const namePadded = domain.name.padEnd(18, " ").slice(0, 18);
          return (
            <box
              key={domain.name}
              flexDirection="row"
              backgroundColor={bg}
              height={1}
              onMouseDown={() => onPick(i)}
            >
              <text fg={fg} bg={bg}>{pointer}{namePadded}</text>
              <text fg={badgeColor} bg={bg}>{badge}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
