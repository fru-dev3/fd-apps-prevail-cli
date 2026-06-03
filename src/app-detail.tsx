import type React from "react";
import { useEffect, useState } from "react";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { theme } from "./theme.ts";
import {
  formatRelativeTime,
  readAppSkill,
  readAppView,
  type AppSkill,
  type ViewKey,
} from "./vault.ts";
import { renderMarkdownLines } from "./markdown-lite.tsx";
import { probeConnector, type AuthCheckSpec, type ProbeResult } from "./connector-probe.ts";
import { loadSkillsForConnector, runSkill, logSkillRun, type SkillSpec, type SkillRunResult } from "./connector-skills.ts";
import { detectClis, runChatTurn, type AvailableCli } from "./cli-bridge.ts";
import { useRef } from "react";

interface Props {
  app: AppSkill;
  view: ViewKey;
  skillIdx: number;
  onPickSkill: (i: number) => void;
  topBar?: React.ReactNode;
}

// Connector workspace tabs. The global tab strip (state/loops/quickstart/
// prompts/skills) is for DOMAINS; connectors get their own internal tab
// row because the model is fundamentally different — a connector is a
// thing you authenticate to + run skills against + chat with the data of.
//
// The "Chat" tab was REMOVED — chat is now embedded directly into the
// Overview tab, alongside the connection summary, so opening any app
// lands you on a working chat surface with all the connector context
// visible above it. The other four tabs (Auth/Sync/Skills/Data) remain
// as dedicated deep-dives.
type ConnectorTab = "overview" | "auth" | "sync" | "skills" | "data";
const CONNECTOR_TABS: { id: ConnectorTab; label: string }[] = [
  { id: "overview", label: "Overview + Chat" },
  { id: "auth", label: "Auth" },
  { id: "sync", label: "Sync" },
  { id: "skills", label: "Skills" },
  { id: "data", label: "Data" },
];

export function AppDetail({ app, view, skillIdx, onPickSkill, topBar }: Props) {
  const updated = formatRelativeTime(app.stateMtime);
  const domainsLabel =
    app.domains.length > 0 ? `used in ${app.domains.join(", ")}` : "no linked domains";
  const communityMark = app.community ? "★ community  ·  " : "";

  const [tab, setTab] = useState<ConnectorTab>("overview");
  // Re-derive skills + auth probe whenever the app changes.
  const [skills, setSkills] = useState<SkillSpec[]>(() => loadSkillsForConnector(app));
  useEffect(() => {
    setSkills(loadSkillsForConnector(app));
    setTab("overview");
  }, [app.id]);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title={` ${app.id}  ·  ${app.title} `}
      titleAlignment="left"
      bottomTitle={` ${communityMark}${domainsLabel}  ·  updated ${updated}  ·  ${skills.length} skill${skills.length === 1 ? "" : "s"} `}
      bottomTitleAlignment="left"
    >
      {topBar}
      <ConnectorTabRow active={tab} onPick={setTab} skillCount={skills.length} />
      {tab === "overview" ? (
        // Overview tab gets a special split layout: compact connection
        // summary on top, working chat on the bottom. Both flex within the
        // same panel — no scroll, no extra click to reach chat.
        <ConnectorOverviewWithChat app={app} skillsCount={skills.length} />
      ) : (
        <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <scrollbox flexGrow={1} scrollY>
            {tab === "auth" && <ConnectorAuthPanel app={app} />}
            {tab === "sync" && <ConnectorSyncPanel app={app} skills={skills} />}
            {tab === "skills" && <ConnectorSkillsPanel app={app} skills={skills} />}
            {tab === "data" && <ConnectorDataPanel app={app} />}
          </scrollbox>
        </box>
      )}
    </box>
  );
}

function ConnectorTabRow({
  active,
  onPick,
  skillCount,
}: {
  active: ConnectorTab;
  onPick: (t: ConnectorTab) => void;
  skillCount: number;
}) {
  return (
    <box
      flexDirection="row"
      height={1}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
    >
      {CONNECTOR_TABS.map((t, i) => {
        const isActive = t.id === active;
        const fg = isActive ? theme.aiAccent : theme.fgDim;
        const suffix = t.id === "skills" && skillCount > 0 ? ` (${skillCount})` : "";
        return (
          <text
            key={t.id}
            fg={fg}
            attributes={isActive ? 1 : 0}
            onMouseDown={() => onPick(t.id)}
          >
            {i === 0 ? "" : "  "}
            {isActive ? `▸ ${t.label}` : `  ${t.label}`}
            {suffix}
          </text>
        );
      })}
    </box>
  );
}

function SkillsList({
  skills,
  selectedIdx,
  onPick,
  appId,
}: {
  skills: { id: string; title: string }[];
  selectedIdx: number;
  onPick: (i: number) => void;
  appId: string;
}) {
  if (skills.length === 0) {
    return <text fg={theme.fgDim}>No skills for {appId}.</text>;
  }
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.fgDim}>
        {skills.length} skills  ·  ↑/↓ navigate  ·  enter to run
      </text>
      <text> </text>
      <scrollbox flexGrow={1} scrollY>
        {skills.map((skill, i) => {
          const active = i === selectedIdx;
          const fg = active ? theme.selFg : theme.fg;
          const bg = active ? theme.selBg : theme.bg;
          const pointer = active ? "› " : "  ";
          const titleFg = active ? theme.selFg : theme.fgDim;
          return (
            <box
              key={skill.id}
              flexDirection="row"
              backgroundColor={bg}
              height={1}
              onMouseDown={() => onPick(i)}
            >
              <text fg={fg} bg={bg}>{pointer}{skill.id}</text>
              <text fg={titleFg} bg={bg}>  ·  {skill.title}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

// Top-of-state view for an app/connector: 4 sections (Connection, Skills,
// Domains, Chat hint) that surface the metadata up front before the body
// content. This is the "click on US Bank, see how it connects + what
// skills it exposes + which domains consume it" view.
// Detect whether this app has a real manifest.json. Vault apps (the ones
// the user authored over time as ~/.ai/vault/apps/*) typically don't —
// they predate the connector redesign. We use this to gate the tabs so
// they show helpful guidance instead of empty panels.
function hasManifest(app: AppSkill): boolean {
  return !!app.manifestPath && existsSync(app.manifestPath);
}

// Human-language explanation of what each integration type actually means.
// Shown in the Auth tab so the user understands WHAT THE CONNECTION IS
// before they're asked to set it up.
function integrationExplain(kind: string): string {
  switch (kind) {
    case "api":
      return "    REST or GraphQL API. prevAIl reads stored API keys from env vars (e.g. PLAID_SECRET) and calls the service directly. Best for services with first-party developer APIs.";
    case "oauth":
      return "    OAuth 2.0 (usually with PKCE). prevAIl runs the consent flow once, stores a refresh token at ~/.prevail/connectors/<id>/auth/refresh.token, then mints access tokens as needed. Best for Google services, GitHub Apps, Notion, Linear.";
    case "browser":
      return "    Browser automation via Playwright against your logged-in session. No API key — prevAIl uses Chrome cookies. Best for services WITHOUT public APIs (LinkedIn, most bank portals, AppFolio, real-estate sites).";
    case "mcp":
      return "    Wrapped via a local MCP server binary on your PATH. prevAIl spawns the server and calls its tools. Best for services with an existing MCP wrapper (Google Calendar, Filesystem, Slack).";
    case "a2a":
      return "    Agent-to-agent — another prevAIl-compatible agent on your network (Paperclip on Mac mini, Khoj instance). Uses MCP over HTTP/WS. Allowlisted by fingerprint.";
    case "manual":
      return "    Manual integration. You drop files into a watched folder, or paste data into a state.md. prevAIl reads them. Best when no programmatic integration exists yet.";
    default:
      return "    Unknown integration type.";
  }
}

// Action: write a starter manifest.json into the app's folder. Idempotent —
// won't overwrite an existing one. Inferred fields use safe defaults the
// user can edit immediately.
function scaffoldManifest(app: AppSkill): { ok: boolean; message: string; path?: string } {
  const target = join(app.path, "manifest.json");
  if (existsSync(target)) {
    return { ok: false, message: "manifest.json already exists — not overwriting", path: target };
  }
  const skeleton = {
    id: app.id,
    name: app.title || app.id,
    description: app.description || "",
    domains: app.domains.length > 0 ? app.domains : [],
    integration: "manual",
    connection:
      "Describe how this app connects in one paragraph. Examples: REST API + stored key, OAuth + refresh token, Playwright session against a logged-in browser, MCP server binary, A2A endpoint on another machine.",
    auth_check: {
      kind: "manual",
      manual_steps: [
        "1. Document the exact setup steps here so future-you can re-link.",
        "2. If env vars are needed, list them.",
        "3. If a session file is involved, note its path.",
      ],
    },
  };
  try {
    writeFileSync(target, JSON.stringify(skeleton, null, 2));
  } catch (err) {
    return { ok: false, message: `write failed: ${(err as Error).message}` };
  }
  // Also scaffold the skills/ dir so the Skills tab has somewhere to look.
  const skillsDir = join(app.path, "skills");
  if (!existsSync(skillsDir)) {
    try { mkdirSync(skillsDir); } catch { /* best-effort */ }
  }
  return { ok: true, message: `manifest scaffolded`, path: target };
}

// New split-layout Overview: compact connection card on top (~ 12 lines),
// embedded chat on the bottom (rest of the pane). The chat is scoped to
// the connector's data — the LLM gets a system prompt explaining the
// connector context, sees data/ files, and answers questions about
// THIS app's data specifically.
function ConnectorOverviewWithChat({ app, skillsCount }: { app: AppSkill; skillsCount: number }) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Top card — compact connection summary */}
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={0}>
        <ConnectorCompactSummary app={app} skillsCount={skillsCount} />
      </box>
      {/* Visual separator between summary and chat */}
      <box paddingLeft={2} paddingRight={2}>
        <text fg={theme.border}>{"─".repeat(80)}</text>
      </box>
      {/* Chat fills the rest */}
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <ConnectorChat app={app} />
      </box>
    </box>
  );
}

// Compact connection card — keeps the original ConnectorOverview's content
// but in a denser, single-screen-worth layout so the chat below has room.
function ConnectorCompactSummary({ app, skillsCount }: { app: AppSkill; skillsCount: number }) {
  const integrationLabel: Record<string, string> = {
    api: "REST API · stored key",
    oauth: "OAuth · token refresh",
    browser: "browser automation · Playwright",
    mcp: "MCP server · wrapped tool",
    a2a: "A2A · remote agent",
    manual: "manual · drop files in folder",
  };
  const integration = app.integration ?? "manual";
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const runProbe = () => {
    setProbing(true);
    probeConnector(app, (app.authCheck as AuthCheckSpec | undefined) ?? null)
      .then((r) => setProbe(r))
      .finally(() => setProbing(false));
  };
  useEffect(() => {
    let cancelled = false;
    setProbe(null);
    setProbing(true);
    probeConnector(app, (app.authCheck as AuthCheckSpec | undefined) ?? null)
      .then((r) => {
        if (!cancelled) setProbe(r);
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app.id]);

  const manifest = hasManifest(app);
  const [scaffoldNote, setScaffoldNote] = useState<string | null>(null);
  const onScaffold = () => {
    const r = scaffoldManifest(app);
    setScaffoldNote(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
  };
  const effectiveStatus = probe?.status ?? app.status;
  const statusGlyph =
    effectiveStatus === "connected" ? "☑ connected" :
    effectiveStatus === "error" ? "☒ error" :
    effectiveStatus === "expired" ? "☒ auth expired" :
    "☐ not configured";
  const statusFg =
    effectiveStatus === "connected" ? theme.ok :
    effectiveStatus === "error" || effectiveStatus === "expired" ? theme.warn :
    theme.fgDim;

  return (
    <box flexDirection="column">
      {!manifest && (
        <box flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text fg={theme.warn}>⚠ no manifest yet</text>
          <text fg={theme.fgFaint}>  ·  </text>
          <box
            paddingLeft={1}
            paddingRight={1}
            border={["left", "right"]}
            borderColor={theme.aiAccent}
            onMouseDown={onScaffold}
          >
            <text fg={theme.aiAccent} attributes={1}>{" ⊕ Scaffold "}</text>
          </box>
          {scaffoldNote && <text fg={scaffoldNote.startsWith("✓") ? theme.ok : theme.warn}>{"  " + scaffoldNote}</text>}
        </box>
      )}
      <box flexDirection="row" height={1}>
        <text fg={theme.gold} attributes={1}>{app.title}</text>
        <text fg={theme.fgDim}>{`  ·  ${integrationLabel[integration] ?? integration}`}</text>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={statusFg}>{probing ? "⠋ probing…" : statusGlyph}</text>
        <text fg={theme.fgFaint}>{probe?.message ? `  ·  ${probe.message}` : ""}</text>
      </box>
      <box flexDirection="row" height={1} paddingTop={0}>
        <box
          paddingLeft={1}
          paddingRight={1}
          border={["left", "right"]}
          borderColor={theme.aiAccent}
          onMouseDown={runProbe}
        >
          <text fg={theme.aiAccent} attributes={1}>{probing ? " ⠋ … " : " ⟳ Test "}</text>
        </box>
        <text fg={theme.fgFaint}>{`     ${skillsCount} skill${skillsCount === 1 ? "" : "s"} (Skills tab to run)  ·  domains: ${app.domains.length === 0 ? "(none)" : app.domains.join(", ")}`}</text>
      </box>
    </box>
  );
}

// Embedded chat scoped to the connector's data. Lightweight — has its own
// message history (lost on app switch, like the connector workspace tab
// state), spawns runChatTurn with a system prompt explaining the connector
// context, streams the reply as it arrives.
function ConnectorChat({ app }: { app: AppSkill }) {
  type ChatLine = { role: "user" | "assistant"; content: string; ts: number };
  const [history, setHistory] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [streamBuf, setStreamBuf] = useState("");
  const [cli, setCli] = useState<AvailableCli | null>(null);
  const inputRef = useRef<any>(null);

  // Reset history when switching connectors.
  useEffect(() => {
    setHistory([]);
    setInput("");
    setPending(false);
    setStreamBuf("");
  }, [app.id]);

  // Detect available CLIs once.
  useEffect(() => {
    let cancelled = false;
    detectClis().then((list) => {
      if (cancelled) return;
      if (list.length === 0) return;
      const claude = list.find((c) => c.kind === "claude");
      setCli(claude ?? list[0]!);
    });
    return () => { cancelled = true; };
  }, []);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    if (!cli) {
      setHistory((h) => [...h, { role: "assistant", content: "(no CLI detected — can't chat)", ts: Date.now() }]);
      return;
    }
    setHistory((h) => [...h, { role: "user", content: trimmed, ts: Date.now() }]);
    setInput("");
    inputRef.current?.setText?.("");
    setPending(true);
    setStreamBuf("");
    const prompt = buildConnectorChatPrompt(app, trimmed);
    runChatTurn({
      prompt,
      cwd: app.path,
      cli,
      model: "",
      isFirst: true,
      bare: true,
      onChunk: (delta) => setStreamBuf((s) => s + delta),
    })
      .then((reply) => {
        setHistory((h) => [...h, { role: "assistant", content: reply, ts: Date.now() }]);
      })
      .catch((err: Error) => {
        setHistory((h) => [...h, { role: "assistant", content: `(error: ${err.message})`, ts: Date.now() }]);
      })
      .finally(() => {
        setPending(false);
        setStreamBuf("");
      });
  };

  const cliLabel = cli ? cli.label : "no engine";
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" height={1}>
        <text fg={theme.aiAccent} attributes={1}>💬 Chat with {app.title}</text>
        <text fg={theme.fgFaint}>{`   ·   ${cliLabel}   ·   scope: this connector's manifest + data/`}</text>
      </box>
      <scrollbox flexGrow={1} scrollY>
        {history.length === 0 && !pending && (
          <text fg={theme.fgFaint}>
            {"  ask anything about " + app.title + ". try:"}
          </text>
        )}
        {history.length === 0 && !pending && (
          <>
            {connectorChatSuggestions(app).map((s, i) => (
              <text key={i} fg={theme.fgDim}>{`    › ${s}`}</text>
            ))}
          </>
        )}
        {history.map((m, i) => (
          <box key={i} flexDirection="column" paddingTop={1}>
            <text fg={m.role === "user" ? theme.gold : theme.fgDim}>
              {m.role === "user" ? "  › " : "  ▸ "}
              <span fg={theme.fg}>{m.content}</span>
            </text>
          </box>
        ))}
        {pending && (
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.fgDim}>{"  ▸ "}<span fg={theme.fg}>{streamBuf || "…"}</span></text>
          </box>
        )}
      </scrollbox>
      <box
        flexDirection="row"
        height={3}
        borderColor={theme.aiAccent}
        border
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={pending ? theme.fgFaint : theme.aiAccent}>{`› `}</text>
        <input
          ref={inputRef}
          flexGrow={1}
          placeholder={pending ? "thinking…" : `ask about ${app.title}'s data…`}
          backgroundColor={theme.bgPanel}
          textColor={theme.fg}
          onInput={((next: string) => setInput(next)) as any}
          onSubmit={((next: string) => send(next)) as any}
        />
      </box>
    </box>
  );
}

// Suggest 3 starter prompts so users see what kinds of questions THIS
// connector can answer. Tailored to integration type when we can.
function connectorChatSuggestions(app: AppSkill): string[] {
  const i = app.integration ?? "manual";
  if (app.id === "github") return [
    "which PR has been open longest?",
    "list my open notifications",
    "what's the star trend of my top repo?",
  ];
  if (app.id === "plaid") return [
    "what was my biggest spend last month?",
    "list every linked institution",
    "what did I spend on groceries in the last 30 days?",
  ];
  if (app.id === "youtube-analytics") return [
    "what was my best-performing video last quarter?",
    "show me yesterday's channel metrics",
    "which day this week got the most views?",
  ];
  if (app.id === "linkedin") return [
    "how many profile views this week?",
    "which post had the highest engagement?",
    "any new connection requests pending?",
  ];
  if (app.id === "google-calendar") return [
    "what's on my calendar today?",
    "when do I have a free hour this week?",
    "any conflicts on Friday?",
  ];
  if (i === "api" || i === "oauth") return [
    `what data is available from ${app.title}?`,
    `what was the most recent change in ${app.title}?`,
    `summarize what's in data/`,
  ];
  return [
    `what does ${app.title} do?`,
    `walk me through how to set this up`,
    `what skills are available?`,
  ];
}

// Build the system+user prompt for connector-scoped chat. The LLM is told
// the scope (THIS connector only, not the whole vault), given the path to
// data/ + manifest + skills, and asked to answer using that context.
function buildConnectorChatPrompt(app: AppSkill, userQuestion: string): string {
  return [
    `You are answering questions about ONE specific app/connector in a personal-AI cockpit called prevAIl.`,
    ``,
    `Connector: ${app.title} (id: ${app.id})`,
    `Integration type: ${app.integration ?? "manual"}`,
    `Connector folder: ${app.path}`,
    `Linked life domains: ${app.domains.join(", ") || "(none)"}`,
    ``,
    `The connector folder has these subdirs you can read with your tools:`,
    `  ${app.path}/manifest.json   — auth config, integration type, etc.`,
    `  ${app.path}/SKILL.md         — human-readable overview of the connector`,
    `  ${app.path}/skills/          — runnable skill definitions (YAML+markdown)`,
    `  ${app.path}/data/            — pulled data (JSONL/JSON/markdown files)`,
    `  ${app.path}/_log/            — record of skill runs`,
    ``,
    `Use ONLY this connector's data to answer. Do not read other connectors or domains.`,
    ``,
    `User question: ${userQuestion}`,
  ].join("\n");
}

function ConnectorOverview({ app, skillsCount }: { app: AppSkill; skillsCount?: number }) {
  const integrationLabel: Record<string, string> = {
    api: "REST/GraphQL API · stored key",
    oauth: "OAuth · token refresh",
    browser: "browser automation · cookie/Playwright",
    mcp: "MCP server · wrapped tool",
    manual: "manual · drop files in watched folder",
  };
  const integration = app.integration ?? "manual";
  // Live auth probe — runs the manifest's auth_check (env keys / file
  // exists / HTTP / spawn / MCP / manual) and shows the result. Auto-fires
  // on app open AND on Test Connection click. Falls back to the
  // declared connection-status.json when no auth_check is provided.
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const runProbe = () => {
    setProbing(true);
    probeConnector(app, (app.authCheck as AuthCheckSpec | undefined) ?? null)
      .then((r) => setProbe(r))
      .finally(() => setProbing(false));
  };
  useEffect(() => {
    let cancelled = false;
    setProbe(null);
    setProbing(true);
    probeConnector(app, (app.authCheck as AuthCheckSpec | undefined) ?? null)
      .then((r) => {
        if (!cancelled) setProbe(r);
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app.id]);

  // Use the live probe when we have one; fall back to the static
  // connection-status.json snapshot. This is what makes the badge real:
  // open Plaid and you see "API · ✓ env keys present" or "✗ missing
  // PLAID_SECRET" instantly, not a stale value from a side-channel file.
  const effectiveStatus = probe?.status ?? app.status;
  const statusGlyph =
    effectiveStatus === "connected" ? "☑ connected" :
    effectiveStatus === "error" ? "☒ error" :
    effectiveStatus === "expired" ? "☒ auth expired" :
    "☐ not configured";
  const statusFg =
    effectiveStatus === "connected" ? theme.ok :
    effectiveStatus === "error" || effectiveStatus === "expired" ? theme.warn :
    theme.fgDim;
  const lastSync = probe?.ts
    ? formatRelativeTime(probe.ts)
    : app.lastSuccessTs
      ? formatRelativeTime(app.lastSuccessTs)
      : "never";
  const manifest = hasManifest(app);
  const [scaffoldNote, setScaffoldNote] = useState<string | null>(null);
  const onScaffold = () => {
    const r = scaffoldManifest(app);
    setScaffoldNote(r.ok ? `✓ ${r.message} → ${r.path}` : `✗ ${r.message}`);
  };
  return (
    <box flexDirection="column">
      {!manifest && (
        <>
          <box
            flexDirection="column"
            border
            borderColor={theme.warn}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={0}
            paddingBottom={0}
          >
            <text fg={theme.warn} attributes={1}>⚠ No manifest.json yet</text>
            <text fg={theme.fgDim}>
              {`  This app hasn't been redesigned for the v0.6 connector workspace.`}
            </text>
            <text fg={theme.fgDim}>
              {`  Without a manifest, prevAIl can't probe auth, run skills, or sync data.`}
            </text>
            <text> </text>
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              border={["left", "right"]}
              borderColor={theme.aiAccent}
              onMouseDown={onScaffold}
            >
              <text fg={theme.aiAccent} attributes={1}>{" ⊕ Scaffold manifest.json "}</text>
            </box>
            {scaffoldNote && (
              <text fg={scaffoldNote.startsWith("✓") ? theme.ok : theme.warn}>{"  " + scaffoldNote}</text>
            )}
          </box>
          <text> </text>
        </>
      )}
      <text fg={theme.gold} attributes={1}>▸ Connection</text>
      <text fg={theme.fgDim}>{"  type:   "}<span fg={theme.fg}>{integrationLabel[integration]}</span></text>
      <text fg={theme.fgDim}>
        {"  status: "}
        <span fg={statusFg}>{probing ? "⠋ probing…" : statusGlyph}</span>
        <span fg={theme.fgFaint}>{`   ·   probed ${lastSync}`}</span>
      </text>
      {probe?.message && (
        <text fg={theme.fgDim}>{"  detail: "}<span fg={probe.ok ? theme.fg : theme.warn}>{probe.message}</span></text>
      )}
      {probe?.fixHint && (
        <text fg={theme.fgDim}>{"  fix:    "}<span fg={theme.aiAccent}>{probe.fixHint}</span></text>
      )}
      {!probe && app.lastError && (
        <text fg={theme.fgDim}>{"  error:  "}<span fg={theme.warn}>{app.lastError}</span></text>
      )}
      <text> </text>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        border={["left", "right"]}
        borderColor={theme.aiAccent}
        onMouseDown={runProbe}
      >
        <text fg={theme.aiAccent} attributes={1}>{probing ? " ⠋ testing… " : " ⟳ Test Connection "}</text>
      </box>
      {app.connectionNotes && (
        <>
          <text> </text>
          <text fg={theme.fgDim}>{app.connectionNotes.split("\n").slice(0, 6).join("\n")}</text>
        </>
      )}
      <text> </text>
      <text fg={theme.gold} attributes={1}>▸ Skills  ({skillsCount ?? app.skills.length} runnable)</text>
      <text fg={theme.fgFaint}>{"  click Skills tab to list + run them, or press 's'"}</text>
      <text> </text>
      <text fg={theme.gold} attributes={1}>▸ Linked domains  ({app.domains.length})</text>
      {app.domains.length === 0 ? (
        <text fg={theme.fgFaint}>{"  not wired into any life domain — set domains in manifest.json"}</text>
      ) : (
        <text fg={theme.fg}>{"  " + app.domains.join("  ·  ")}</text>
      )}
      <text> </text>
      <text fg={theme.gold} attributes={1}>▸ Quick actions</text>
      <text fg={theme.fgFaint}>{"  Skills tab → ▶ to run a skill"}</text>
      <text fg={theme.fgFaint}>{"  Data tab → browse pulled data"}</text>
      <text fg={theme.fgFaint}>{"  Chat tab → ask questions scoped to this connector's data"}</text>
      <text> </text>
      <text fg={theme.border}>{"─".repeat(60)}</text>
      <text> </text>
    </box>
  );
}

// Auth tab — environment vars + files the connector needs, with check marks.
// Honest about what's missing when no auth_check is declared.
function ConnectorAuthPanel({ app }: { app: AppSkill }) {
  const spec = app.authCheck as AuthCheckSpec | undefined;
  const manifest = hasManifest(app);
  return (
    <box flexDirection="column">
      <text fg={theme.gold} attributes={1}>▸ How does {app.title} connect?</text>
      <text> </text>
      <text fg={theme.fgDim}>{"  integration type: "}<span fg={theme.fg}>{app.integration ?? "(undeclared)"}</span></text>
      <text> </text>
      <text fg={theme.fgDim}>{"  What that means:"}</text>
      <text fg={theme.fgFaint}>{integrationExplain(app.integration ?? "manual")}</text>
      <text> </text>
      {!manifest && (
        <text fg={theme.warn}>{"  ⚠ no manifest.json — scaffold one on the Overview tab to enable auth + skills"}</text>
      )}
      {manifest && !spec && (
        <>
          <text fg={theme.warn}>{"  ⚠ manifest exists but no auth_check declared"}</text>
          <text fg={theme.fgFaint}>{"  Edit manifest.json and add an auth_check block. See examples in:"}</text>
          <text fg={theme.fgFaint}>{"    apps/community/{plaid,github,linkedin,youtube-analytics,google-calendar}/manifest.json"}</text>
          <text fg={theme.fgFaint}>{"  Full spec at docs/connector-architecture.md"}</text>
        </>
      )}
      {spec?.kind === "env-keys" && (
        <>
          <text> </text>
          <text fg={theme.fgDim} attributes={1}>required env vars:</text>
          {(spec.env_keys ?? []).map((k) => (
            <text key={k} fg={theme.fgDim}>
              {"  "}
              <span fg={process.env[k] ? theme.ok : theme.warn}>{process.env[k] ? "☑" : "☐"}</span>
              {"  "}
              <span fg={theme.fg}>{k}</span>
              <span fg={theme.fgFaint}>{process.env[k] ? "  (set)" : "  (missing)"}</span>
            </text>
          ))}
        </>
      )}
      {spec?.kind === "file-exists" && (
        <>
          <text> </text>
          <text fg={theme.fgDim} attributes={1}>required files:</text>
          {(spec.files ?? []).map((f) => {
            const expanded = f.replace("~", process.env.HOME ?? "~");
            const ok = existsSync(expanded);
            return (
              <text key={f} fg={theme.fgDim}>
                {"  "}
                <span fg={ok ? theme.ok : theme.warn}>{ok ? "☑" : "☐"}</span>
                {"  "}
                <span fg={theme.fg}>{f}</span>
              </text>
            );
          })}
        </>
      )}
      {spec?.kind === "http" && (
        <>
          <text> </text>
          <text fg={theme.fgDim}>{"  url:        "}<span fg={theme.fg}>{spec.url}</span></text>
          {spec.auth_header_env && (
            <text fg={theme.fgDim}>{"  auth env:   "}<span fg={theme.fg}>{spec.auth_header_env}</span></text>
          )}
        </>
      )}
      {spec?.kind === "command" && (
        <text fg={theme.fgDim}>{"  command:    "}<span fg={theme.fg}>{spec.command}</span></text>
      )}
      {spec?.kind === "mcp" && (
        <text fg={theme.fgDim}>{"  mcp:        "}<span fg={theme.fg}>{spec.mcp_command ?? spec.mcp_url ?? "(unset)"}</span></text>
      )}
      <text> </text>
      <text fg={theme.fgFaint}>{"  Overview tab has ⟳ Test Connection — runs the auth_check live."}</text>
    </box>
  );
}

// Sync tab — list every skill that has a cron trigger, show its schedule.
// (Actual scheduling lands in v0.6 phase 5; this is the surface for it.)
function ConnectorSyncPanel({ app, skills }: { app: AppSkill; skills: SkillSpec[] }) {
  const cronSkills = skills.filter((s) => s.trigger?.startsWith("cron("));
  return (
    <box flexDirection="column">
      <text fg={theme.gold} attributes={1}>▸ Scheduled syncs</text>
      <text> </text>
      {cronSkills.length === 0 ? (
        <text fg={theme.fgFaint}>{"  no cron-triggered skills declared for this connector."}</text>
      ) : (
        cronSkills.map((s) => (
          <text key={s.id} fg={theme.fgDim}>
            {"  · "}<span fg={theme.fg}>{s.id}</span>
            {"   "}<span fg={theme.fgFaint}>{s.trigger}</span>
          </text>
        ))
      )}
      <text> </text>
      <text fg={theme.fgFaint}>{"  scheduled execution arrives in v0.6 phase 5. for now, Skills tab → ▶ to fire manually."}</text>
    </box>
  );
}

// Skills tab — runnable list with [▶ Run] button and last result inline.
function ConnectorSkillsPanel({ app, skills }: { app: AppSkill; skills: SkillSpec[] }) {
  const [results, setResults] = useState<Map<string, SkillRunResult | "running">>(new Map());
  if (skills.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={theme.fgDim}>No runnable skills under {app.path}/skills/.</text>
        <text> </text>
        <text fg={theme.fgFaint}>Drop a skills/&lt;id&gt;.md file with YAML frontmatter to add one.</text>
        <text fg={theme.fgFaint}>See docs/connector-architecture.md for the format.</text>
      </box>
    );
  }
  const run = (s: SkillSpec) => {
    setResults((m) => new Map(m).set(s.id, "running"));
    void runSkill(s, {}).then((r) => {
      logSkillRun(s, r);
      setResults((m) => new Map(m).set(s.id, r));
    });
  };
  return (
    <box flexDirection="column">
      <text fg={theme.gold} attributes={1}>▸ Runnable skills ({skills.length})</text>
      <text> </text>
      {skills.map((s) => {
        const r = results.get(s.id);
        return (
          <box key={s.id} flexDirection="column" paddingBottom={1}>
            <box flexDirection="row" height={1}>
              <text fg={theme.fg}>  ● {s.id}</text>
              <text fg={theme.fgFaint}>  ·  runner={s.runner}</text>
              <text fg={theme.fgFaint}>  ·  trigger={s.trigger ?? "on-demand"}</text>
            </box>
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              border={["left", "right"]}
              borderColor={theme.aiAccent}
              onMouseDown={() => run(s)}
            >
              <text fg={theme.aiAccent} attributes={1}>{r === "running" ? " ⠋ running… " : " ▶ Run "}</text>
            </box>
            {r && r !== "running" && (
              <text fg={r.ok ? theme.ok : theme.warn}>
                {"    "}{r.ok ? "✓" : "✗"} {r.message}
                {r.outputsWritten.length > 0 && ` (${r.outputsWritten.length} output${r.outputsWritten.length === 1 ? "" : "s"})`}
                {" · "}{(r.durationMs / 1000).toFixed(1)}s
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}

// Data tab — show what's under <connector>/data/ in a flat list.
function ConnectorDataPanel({ app }: { app: AppSkill }) {
  const dataDir = join(app.path, "data");
  if (!existsSync(dataDir)) {
    return (
      <box flexDirection="column">
        <text fg={theme.fgDim}>No data pulled yet.</text>
        <text> </text>
        <text fg={theme.fgFaint}>Run a skill (Skills tab → ▶) to populate this.</text>
      </box>
    );
  }
  const entries = walkDataDir(dataDir, 50);
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  return (
    <box flexDirection="column">
      <text fg={theme.gold} attributes={1}>▸ Data store ({entries.length} files · {formatBytes(totalBytes)})</text>
      <text fg={theme.fgFaint}>{`  rooted at ${dataDir.replace(process.env.HOME ?? "", "~")}`}</text>
      <text> </text>
      {entries.length === 0 ? (
        <text fg={theme.fgFaint}>data/ exists but is empty.</text>
      ) : (
        entries.slice(0, 40).map((e) => (
          <text key={e.path} fg={theme.fgDim}>
            {"  "}{e.rel.padEnd(50).slice(0, 50)}{"  "}<span fg={theme.fgFaint}>{formatBytes(e.size).padStart(8)}{"  "}{formatRelativeTime(e.mtime)}</span>
          </text>
        ))
      )}
      {entries.length > 40 && <text fg={theme.fgFaint}>{`  … +${entries.length - 40} more`}</text>}
    </box>
  );
}

// Chat tab — placeholder for the connector-scoped chat surface. Wired in
// v0.6 phase 4; for now it points the user at the global chat.
function ConnectorChatPanel({ app }: { app: AppSkill }) {
  return (
    <box flexDirection="column">
      <text fg={theme.gold} attributes={1}>▸ Chat with {app.title}'s data</text>
      <text> </text>
      <text fg={theme.fg}>{"  Connector-scoped chat is coming in v0.6 (phase 4 of the redesign)."}</text>
      <text> </text>
      <text fg={theme.fgDim}>{"  The LLM will see ONLY this connector's data/ + SKILL.md as context,"}</text>
      <text fg={theme.fgDim}>{"  so you can ask focused questions like:"}</text>
      <text> </text>
      <text fg={theme.fgFaint}>{`     "what was my biggest spend last month?"        (Plaid)`}</text>
      <text fg={theme.fgFaint}>{`     "which PR has been open longest?"               (GitHub)`}</text>
      <text fg={theme.fgFaint}>{`     "show me my best-performing video last quarter" (YouTube)`}</text>
      <text> </text>
      <text fg={theme.fgFaint}>{"  For now, run skills in the Skills tab and the outputs land in data/."}</text>
      <text fg={theme.fgFaint}>{"  Use the domain chat (e.g. /domain wealth → ask) to query across connectors."}</text>
    </box>
  );
}

function walkDataDir(root: string, maxDepth: number): { path: string; rel: string; size: number; mtime: number }[] {
  const out: { path: string; rel: string; size: number; mtime: number }[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          out.push({
            path: full,
            rel: full.replace(root + "/", ""),
            size: st.size,
            mtime: st.mtimeMs,
          });
        } catch {
          /* skip */
        }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
