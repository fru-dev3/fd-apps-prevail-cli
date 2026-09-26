import type React from "react";
import { useEffect, useState } from "react";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { theme } from "./theme.ts";
import {
  formatRelativeTime,
  type AppSkill,
  type ViewKey,
} from "./vault.ts";
import { probeConnector, type AuthCheckSpec, type ProbeResult } from "./connector-probe.ts";
import { loadSkillsForConnector, runSkill, logSkillRun, type SkillSpec, type SkillRunResult } from "./connector-skills.ts";

interface Props {
  app: AppSkill;
  view: ViewKey;
  skillIdx: number;
  onPickSkill: (i: number) => void;
  topBar?: React.ReactNode;
  // Callback for the embedded chat to tell the parent app.tsx that its
  // input is being typed in, so the global keyboard handler can stand
  // down and let single-letter keys flow into the input.
  setEmbeddedInputActive?: (v: boolean) => void;
  councilOn?: boolean;
  onToggleCouncil?: () => void;
  frameworkTick?: number;
  onFrameworkChange?: () => void;
  // Opens the full ChatPane for this app. Surfaced as the "▸ Chat"
  // link at the top of the workspace.
  onOpenChat?: () => void;
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

export function AppDetail({ app, view, skillIdx, onPickSkill, topBar, setEmbeddedInputActive, councilOn, onToggleCouncil, frameworkTick, onFrameworkChange, onOpenChat }: Props) {
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
      paddingTop={1}
      paddingBottom={1}
      bottomTitle={` ${communityMark}${domainsLabel}  ·  updated ${updated}  ·  ${skills.length} skill${skills.length === 1 ? "" : "s"} `}
      bottomTitleAlignment="left"
    >
      {/* topBar is the full bundle: TabStrip + ConfigBar.
          AppDetail no longer renders its own WorkspaceConfigBar. */}
      {topBar}
      {/* Apps now use the GLOBAL TabStrip exactly like domains —
          clicking state/quickstart/prompts/skills/chat changes which
          section of the connector workspace shows. Same behavior as
          domain tabs:
            state      → overview (connection summary + data)
            quickstart → auth (how to authenticate)
            prompts    → scheduled syncs
            skills     → runnable skills list
            chat       → ChatPane (handled at the app.tsx level)
          The user gets the SAME tab interaction across domains AND
          apps; only the content differs. */}
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <scrollbox flexGrow={1} scrollY>
          {view === "state" && (
            <>
              <ConnectorCompactSummary app={app} skillsCount={skills.length} />
              <text> </text>
              <text fg={theme.border}>{"─".repeat(80)}</text>
              <text fg={theme.gold} attributes={1}>▸ Data</text>
              <ConnectorDataPanel app={app} />
            </>
          )}
          {view === "quickstart" && <ConnectorAuthPanel app={app} />}
          {view === "prompts" && <ConnectorSyncPanel app={app} skills={skills} />}
          {view === "skills" && <ConnectorSkillsPanel app={app} skills={skills} />}
        </scrollbox>
      </box>
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
    effectiveStatus === "connected" ? "● connected" :
    effectiveStatus === "error" ? "✗ error" :
    effectiveStatus === "expired" ? "✗ auth expired" :
    "○ not configured";
  const statusFg =
    effectiveStatus === "connected" ? theme.ok :
    effectiveStatus === "error" || effectiveStatus === "expired" ? theme.warn :
    theme.fgDim;

  // Pull the auth_check kind for the "how do we connect" line — uses
  // whichever the manifest declared (env-keys, http, command, mcp, file-
  // exists, manual). When no auth_check is present we say so explicitly.
  const authSpec = app.authCheck as AuthCheckSpec | undefined;
  const authMechanism = authSpec
    ? authMechanismLabel(authSpec)
    : "no auth_check declared in manifest";

  return (
    <box flexDirection="column">
      {!manifest && (
        <box flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text fg={theme.warn}>! no manifest yet</text>
          <text fg={theme.fgFaint}>  ·  </text>
          <box
            paddingLeft={1}
            paddingRight={1}
            border={["left", "right"]}
            borderColor={theme.aiAccent}
            onMouseDown={onScaffold}
          >
            <text fg={theme.aiAccent} attributes={1}>{" + Scaffold "}</text>
          </box>
          {scaffoldNote && <text fg={scaffoldNote.startsWith("✓") ? theme.ok : theme.warn}>{"  " + scaffoldNote}</text>}
        </box>
      )}
      {/* Each title-row element lives in its own box with paddingLeft.
          Putting them all in one <text> sequence caused opentui to
          collapse the trailing whitespace inside spans, so text
          bled together ("1Passwordifemanual ··drop filesfinlfolder").
          Boxes with explicit padding are layout cells — whitespace
          inside them is preserved. */}
      <box flexDirection="row" height={1}>
        <box flexDirection="row"><text fg={theme.gold} attributes={1}>{app.title}</text></box>
        <box flexDirection="row" paddingLeft={3}>
          <text fg={theme.fgFaint}>{integrationLabel[integration] ?? integration}</text>
        </box>
        <box flexDirection="row" paddingLeft={3}>
          <text fg={statusFg} attributes={1}>{probing ? "probing…" : statusGlyph}</text>
        </box>
        {!probing && (
          <box flexDirection="row" paddingLeft={3}>
            <text fg={theme.fgFaint}>{probe?.ts ? `probed ${formatRelativeTime(probe.ts)}` : "never tested"}</text>
          </box>
        )}
      </box>
      <text> </text>
      {/* Compact 2-line connection block. "how" answers the user's
          questions (MCP? API? OAuth? browser?) in one human-readable line.
          "skills/domains" combines the two counts. Cluttered 8-row
          version is gone — same info, half the lines. */}
      <ConnRow label="how"     value={authMechanism}                                  valueFg={theme.fg} />
      <ConnRow label="scope"   value={`${skillsCount} skill${skillsCount === 1 ? "" : "s"}  ·  ${app.domains.length === 0 ? "no domains" : "domains: " + app.domains.join(", ")}`} valueFg={theme.fgDim} />
      {/* Error / fix surfaces only when something's wrong. No row when
          the connection is healthy — keeps the panel quiet at green. */}
      {!probe?.ok && probe?.message && (
        <ConnRow label="issue" value={probe.message} valueFg={theme.warn} />
      )}
      {probe?.fixHint && (
        <ConnRow label="fix" value={probe.fixHint} valueFg={theme.aiAccent} />
      )}
      <text> </text>
      <box flexDirection="row" height={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          border={["left", "right"]}
          borderColor={theme.aiAccent}
          onMouseDown={runProbe}
        >
          <text fg={theme.aiAccent} attributes={1}>{probing ? " ⠋ testing… " : " ⟳ Test Connection "}</text>
        </box>
      </box>
    </box>
  );
}

// Labeled key/value row — keeps every connection field aligned for fast
// scanning. Label is dim, value uses whatever fg the caller passed.
function ConnRow({
  label,
  value,
  valueFg,
}: {
  label: string;
  value: string;
  valueFg: string;
}) {
  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.fgFaint}>{`  ${label.padEnd(12)}`}</text>
      <text fg={valueFg}>{value}</text>
    </box>
  );
}

// Plain-language description of HOW the connector authenticates, derived
// from the auth_check block. The Auth tab has the deep explanation; this
// shows up on the Overview as a single-line summary so the user sees
// "Bearer token from GH_TOKEN env var" at a glance.
function authMechanismLabel(spec: AuthCheckSpec): string {
  switch (spec.kind) {
    case "env-keys": {
      const keys = spec.env_keys ?? [];
      if (keys.length === 0) return "env vars (none declared)";
      const present = keys.filter((k) => process.env[k]);
      return `env vars: ${keys.join(", ")}  (${present.length}/${keys.length} set)`;
    }
    case "file-exists": {
      const files = spec.files ?? [];
      if (files.length === 0) return "file present (none declared)";
      const home = process.env.HOME ?? "~";
      return `file: ${files[0]!.replace(home, "~")}${files.length > 1 ? ` +${files.length - 1}` : ""}`;
    }
    case "http": {
      const scheme = spec.auth_header_scheme ?? "Bearer";
      return spec.auth_header_env
        ? `${scheme} token from ${spec.auth_header_env}`
        : `HTTP GET ${spec.url}`;
    }
    case "command":
      return `spawn ${spec.command}${spec.command_args?.length ? " " + spec.command_args.join(" ") : ""}`;
    case "mcp":
      return spec.mcp_command
        ? `MCP server: ${spec.mcp_command}`
        : `MCP over HTTP: ${spec.mcp_url ?? "(unset)"}`;
    case "manual":
      return spec.freshness_file
        ? `manual · watch ${spec.freshness_file}`
        : "manual setup (see Auth tab for steps)";
    default:
      return "(unknown auth kind)";
  }
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
        <text fg={theme.warn}>{"  ! no manifest.json — scaffold one on the Overview tab to enable auth + skills"}</text>
      )}
      {manifest && !spec && (
        <>
          <text fg={theme.warn}>{"  ! manifest exists but no auth_check declared"}</text>
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
              <span fg={process.env[k] ? theme.ok : theme.warn}>{process.env[k] ? "✓" : "·"}</span>
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
                <span fg={ok ? theme.ok : theme.warn}>{ok ? "✓" : "·"}</span>
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
