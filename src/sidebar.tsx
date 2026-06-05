import { useEffect, useRef } from "react";
import { theme, spinnerChar } from "./theme.ts";
import type { Domain, AppSkill } from "./vault.ts";
import { useLayoutTier } from "./use-layout-tier.ts";

// Per-domain icons — Unicode geometric shapes only (no emoji). Each maps to
// the lower-case folder name. Unknown domains fall back to DEFAULT_ICON.
const DOMAIN_ICON: Record<string, string> = {
  chief: "◆",
  council: "◇",
  vision: "★",
  wealth: "¤",
  health: "♥",
  tax: "§",
  calendar: "▦",
  career: "▲",
  business: "◈",
  estate: "⌂",
  "real-estate": "⊓",
  insurance: "+",
  benefits: "✚",
  brand: "※",
  content: "¶",
  social: "◯",
  home: "⌐",
  learning: "✻",
  explore: "⌖",
  intel: "⊗",
  records: "▤",
};

// App icons — same constraint. Apps without a specific match use DEFAULT_ICON.
const APP_ICON: Record<string, string> = {
  plaid: "$",
  "google-calendar": "▦",
  "1password": "⊝",
  notion: "▤",
  mychart: "♥",
  "stripe-dashboard": "$",
  quickbooks: "⊟",
  linkedin: "▶",
  oura: "◉",
  github: "⎈",
  gmail: "✉",
  appfolio: "⌂",
  gusto: "✚",
  turbotax: "§",
};

const DEFAULT_ICON = "·";

function domainIcon(name: string): string {
  return DOMAIN_ICON[name] ?? DEFAULT_ICON;
}

function appIcon(id: string): string {
  return APP_ICON[id] ?? DEFAULT_ICON;
}

export type SidebarFocus = "domains" | "apps";

export type ChatStatus = "idle" | "active" | "pending";

interface Props {
  domains: Domain[];
  apps: AppSkill[];
  // When false, the LIFE APPS section is hidden entirely — the LIFE
  // DOMAINS section takes the full sidebar height. Apps stay in the
  // data layer (scanned, tracked, available to re-enable) but the
  // user never sees them. Keeps the v1 council story focused.
  showApps?: boolean;
  domainIdx: number;
  appIdx: number;
  focus: SidebarFocus;
  vaultLabel: string;
  domainStatus: Map<string, ChatStatus>;
  appStatus: Map<string, ChatStatus>;
  tick: number;
  onPickDomain: (i: number) => void;
  onPickApp: (i: number) => void;
  onNewDomain: () => void;
  onNewApp: () => void;
}

export function Sidebar({
  domains,
  apps,
  showApps = true,
  domainIdx,
  appIdx,
  focus,
  vaultLabel,
  domainStatus,
  appStatus,
  tick,
  onPickDomain,
  onPickApp,
  onNewDomain,
  onNewApp,
}: Props) {
  // Sidebar narrows on small terminals so the chat / workspace pane
  // gets more horizontal real estate. 22 cells is enough to render
  // "▸ ◆ business-pricing" (the longest demo domain id) plus a
  // 2-cell skill count.
  const { tier } = useLayoutTier();
  const sidebarWidth = tier === "compact" ? 22 : 32;
  return (
    <box
      flexDirection="column"
      width={sidebarWidth}
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
        flexGrow={showApps ? 3 : 1}
        columnHeader="    domain        skills"
        followId={focus === "domains" ? `dom-${domains[domainIdx]?.name ?? ""}` : null}
        footer={<NewRow label="+ new domain" onClick={onNewDomain} />}
      >
        {domains.map((d, i) => {
          const active = focus === "domains" && i === domainIdx;
          const fg = active ? theme.selFg : theme.fg;
          const bg = active ? theme.selBg : theme.bgPanel;
          const pointer = active ? "› " : "  ";
          // Show skill count, not open-loop count — skills are the action
          // surface for each domain, open loops live inside state.md.
          const skillsCount = d.skills.length;
          const badgeColor = skillsCount > 0 ? theme.gold : theme.fgFaint;
          const badge = skillsCount.toString().padStart(2, " ");
          const icon = domainIcon(d.name);
          const iconFg = active ? theme.selFg : theme.gold;
          const namePadded = d.name.padEnd(14, " ").slice(0, 14);
          const status = domainStatus.get(d.name) ?? "idle";
          return (
            <box
              key={d.name}
              id={`dom-${d.name}`}
              flexDirection="row"
              backgroundColor={bg}
              height={1}
              onMouseDown={() => onPickDomain(i)}
            >
              <text fg={fg} bg={bg}>{pointer}</text>
              <text fg={iconFg} bg={bg}>{icon} </text>
              <text fg={fg} bg={bg}>{namePadded}</text>
              <text fg={badgeColor} bg={bg}>{badge}</text>
              <StatusGlyph status={status} tick={tick} bg={bg} />
            </box>
          );
        })}
      </Section>
      {showApps && (
      <Section
        title="LIFE APPS"
        count={apps.length}
        focused={focus === "apps"}
        flexGrow={2}
        columnHeader="    app           skills"
        followId={focus === "apps" ? `app-${apps[appIdx]?.id ?? ""}` : null}
        footer={<NewRow label="+ new app" onClick={onNewApp} />}
      >
        {apps.map((a, i) => {
          const active = focus === "apps" && i === appIdx;
          const fg = active ? theme.selFg : theme.fg;
          const bg = active ? theme.selBg : theme.bgPanel;
          const pointer = active ? "› " : "  ";
          const skillsCount = a.skills.length;
          // Connector status glyph + color. Leading checkbox:
          //   ☑  = connected and healthy
          //   ☒  = error or expired (re-auth needed)
          //   ☐  = not configured yet (or freshly installed)
          // This replaces the per-id app icon for connectors that have
          // explicit status; legacy apps without status info still get ☐.
          const connGlyph =
            a.status === "connected" ? "✓" :
            a.status === "error" || a.status === "expired" ? "☒" :
            "·";
          const connFg = active
            ? theme.selFg
            : a.status === "connected" ? theme.ok
            : a.status === "error" || a.status === "expired" ? theme.warn
            : theme.fgDim;
          const badgeColor = skillsCount > 0 ? theme.gold : theme.fgFaint;
          const badge = skillsCount.toString().padStart(2, " ");
          const namePadded = a.id.padEnd(13, " ").slice(0, 13);
          const status = appStatus.get(a.id) ?? "idle";
          return (
            <box
              key={a.id}
              id={`app-${a.id}`}
              flexDirection="row"
              backgroundColor={bg}
              height={1}
              onMouseDown={() => onPickApp(i)}
            >
              <text fg={fg} bg={bg}>{pointer}</text>
              <text fg={connFg} bg={bg}>{connGlyph} </text>
              <text fg={fg} bg={bg}>{namePadded}</text>
              <text fg={badgeColor} bg={bg}>{badge}</text>
              <StatusGlyph status={status} tick={tick} bg={bg} />
            </box>
          );
        })}
      </Section>
      )}
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
  columnHeader,
  followId,
  footer,
  children,
}: {
  title: string;
  count: number;
  focused: boolean;
  flexGrow: number;
  columnHeader?: string;
  followId?: string | null;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const accent = focused ? theme.gold : theme.fgDim;
  const scrollRef = useRef<any>(null);
  useEffect(() => {
    if (!followId) return;
    // Retry across a few frames: the scrollbox's children may not be laid out
    // by the time the effect fires (especially after a focus switch or a
    // sidebar resize), so a single call can no-op. The retries are cheap.
    const tryScroll = () => {
      try {
        scrollRef.current?.scrollChildIntoView?.(followId);
      } catch {}
    };
    tryScroll();
    const t1 = setTimeout(tryScroll, 30);
    const t2 = setTimeout(tryScroll, 120);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [followId]);
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
      {columnHeader && (
        <text fg={theme.fgFaint}>{columnHeader}</text>
      )}
      {!columnHeader && <text> </text>}
      <scrollbox ref={scrollRef} flexGrow={1} scrollY>
        {children}
      </scrollbox>
      {footer}
    </box>
  );
}

function NewRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <box
      flexDirection="row"
      height={1}
      onMouseDown={onClick}
    >
      <text fg={theme.goldDim}>  {label}</text>
    </box>
  );
}
