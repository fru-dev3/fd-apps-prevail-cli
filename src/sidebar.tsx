import { theme, spinnerChar } from "./theme.ts";
import type { Domain, AppSkill } from "./vault.ts";

export type SidebarFocus = "domains" | "apps";

export type ChatStatus = "idle" | "active" | "pending";

interface Props {
  domains: Domain[];
  apps: AppSkill[];
  domainIdx: number;
  appIdx: number;
  focus: SidebarFocus;
  vaultLabel: string;
  domainStatus: Map<string, ChatStatus>;
  appStatus: Map<string, ChatStatus>;
  tick: number;
  onPickDomain: (i: number) => void;
  onPickApp: (i: number) => void;
}

export function Sidebar({
  domains,
  apps,
  domainIdx,
  appIdx,
  focus,
  vaultLabel,
  domainStatus,
  appStatus,
  tick,
  onPickDomain,
  onPickApp,
}: Props) {
  return (
    <box
      flexDirection="column"
      width={32}
      border
      borderColor={theme.border}
      backgroundColor={theme.bgPanel}
      bottomTitle={` ${vaultLabel} `}
      bottomTitleAlignment="left"
    >
      <Section
        title="LIFE DOMAINS"
        count={domains.length}
        focused={focus === "domains"}
        flexGrow={3}
      >
        {domains.map((d, i) => {
          const active = focus === "domains" && i === domainIdx;
          const fg = active ? theme.selFg : theme.fg;
          const bg = active ? theme.selBg : theme.bgPanel;
          const pointer = active ? "› " : "  ";
          const badgeColor = d.openLoopCount > 0 ? theme.warn : theme.fgFaint;
          const badge = d.openLoopCount.toString().padStart(2, " ");
          const namePadded = d.name.padEnd(16, " ").slice(0, 16);
          const status = domainStatus.get(d.name) ?? "idle";
          return (
            <box
              key={d.name}
              flexDirection="row"
              backgroundColor={bg}
              height={1}
              onMouseDown={() => onPickDomain(i)}
            >
              <text fg={fg} bg={bg}>{pointer}{namePadded}</text>
              <text fg={badgeColor} bg={bg}>{badge}</text>
              <StatusGlyph status={status} tick={tick} bg={bg} />
            </box>
          );
        })}
      </Section>
      <Section
        title="LIFE APPS"
        count={apps.length}
        focused={focus === "apps"}
        flexGrow={2}
      >
        {apps.map((a, i) => {
          const active = focus === "apps" && i === appIdx;
          const fg = active ? theme.selFg : theme.fg;
          const bg = active ? theme.selBg : theme.bgPanel;
          const pointer = active ? "› " : "  ";
          const xn = a.domains.length;
          const badge = xn > 1 ? `×${xn}`.padStart(3, " ") : "   ";
          const badgeColor = active ? theme.selFg : theme.fgFaint;
          const communityMark = a.community ? "★" : " ";
          const nameRaw = `${communityMark}${a.id}`;
          const namePadded = nameRaw.padEnd(16, " ").slice(0, 16);
          const status = appStatus.get(a.id) ?? "idle";
          return (
            <box
              key={a.id}
              flexDirection="row"
              backgroundColor={bg}
              height={1}
              onMouseDown={() => onPickApp(i)}
            >
              <text fg={fg} bg={bg}>{pointer}{namePadded}</text>
              <text fg={badgeColor} bg={bg}>{badge}</text>
              <StatusGlyph status={status} tick={tick} bg={bg} />
            </box>
          );
        })}
      </Section>
    </box>
  );
}

function StatusGlyph({ status, tick, bg }: { status: ChatStatus; tick: number; bg: string }) {
  if (status === "idle") return <text bg={bg}>  </text>;
  if (status === "pending") {
    return (
      <text fg={theme.gold} bg={bg}> {spinnerChar(tick)}</text>
    );
  }
  return <text fg={theme.ok} bg={bg}> ●</text>;
}

function Section({
  title,
  count,
  focused,
  flexGrow,
  children,
}: {
  title: string;
  count: number;
  focused: boolean;
  flexGrow: number;
  children: React.ReactNode;
}) {
  const accent = focused ? theme.gold : theme.fgDim;
  return (
    <box
      flexDirection="column"
      flexGrow={flexGrow}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      borderColor={theme.border}
      border={["top"]}
    >
      <box flexDirection="row" height={1}>
        <text fg={accent} attributes={focused ? 1 : 0}>{title}</text>
        <text fg={theme.fgFaint}>  {count}</text>
        {focused && <text fg={theme.gold}>  ●</text>}
      </box>
      <text> </text>
      <scrollbox flexGrow={1} scrollY>
        {children}
      </scrollbox>
    </box>
  );
}
