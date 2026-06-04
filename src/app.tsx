import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Sidebar, type ChatStatus, type SidebarFocus } from "./sidebar.tsx";
import { DomainDetail } from "./domain-detail.tsx";
import { AppDetail } from "./app-detail.tsx";
import { Branding } from "./branding.tsx";
import { CommandBar } from "./command-bar.tsx";
import {
  ChatPane,
  CouncilConfigPanel,
  SLASH_HELP,
  makeInitialMessages,
  makeSeedPrompt,
  type ChatCommand,
  type ChatSeed,
  type ChatSession,
} from "./chat-pane.tsx";
import { EditorPane } from "./editor-pane.tsx";
import { TabStrip } from "./tab-strip.tsx";
import { WorkspaceConfigBar } from "./workspace-config-bar.tsx";
import { ToolsPanel } from "./tools-panel.tsx";
import {
  ALL_CLI_KINDS,
  isCliKind,
  readCouncilConfig,
  readResponseFramework,
  readAutoCouncil,
  readCheckpoint,
  readResponseLens,
  readSerendipity,
  readWebAccess,
  readGlobalCouncilDefault,
  setResponseFramework,
  setResponseLens,
  setCouncilClis,
  setCouncilModel,
  addCouncilModel,
  removeCouncilModel,
  setCouncilChair,
  setGlobalCouncilDefault,
  setWebAccess,
  type CliKind,
} from "./config.ts";
import { FRAMEWORKS, getFramework, isFrameworkId } from "./framework.ts";
import { buildLensPreamble, expandLensSelection, getLens, type Lens } from "./lens.ts";
import { buildDomainHeatmap, renderHeatmapText } from "./heatmap.ts";
import {
  readRecentObservations,
  recordObservations,
  renderObservationsText,
  runWatcher,
} from "./watcher.ts";
import { scanApps, scanCommunityApps, scanVault, type AppSkill, type Domain, type ViewKey } from "./vault.ts";
import { theme } from "./theme.ts";
import { scaffoldApp, scaffoldDomain } from "./domain-scaffold.ts";
import { buildDistillPrompt, parseDistillResponse, writeDistilledSkill } from "./distill.ts";
import {
  formatRelativeDate,
  getDomainHistory,
  makeSessionId,
  persistMessage,
  getUserPromptsForDomain,
  promptLogPath,
  searchMessages,
} from "./session.ts";
import { tickAndRunDue } from "./schedule.ts";
import { writeTurnSummary } from "./auto-summary.ts";
import { distillTurnToJournal } from "./journal.ts";
import { runSerendipityPass } from "./serendipity.ts";
import { classifyAsCouncilWorthy } from "./auto-council.ts";
import {
  detectOllama,
  detectSubprocessClis,
  formatModelBadge,
  probeCli,
  runChatTurn,
  type AvailableCli,
  type CliHealth,
} from "./cli-bridge.ts";

// Feature flag: when false, the LIFE APPS section, the `s` swap-focus key,
// the AppDetail panel, and the new-app flow are all collapsed out of the
// default UI. The connector architecture and the scanApps loader stay in
// the codebase so the v1 council story can ship clean and we can re-enable
// apps later once the grounding pipeline (connector → domain context →
// council prompt) is actually wired. Flip to `true` to bring it all back.
const SHOW_APPS = false;

const VIEW_ORDER: ViewKey[] = ["state", "quickstart", "prompts", "skills"];
const VIEW_FILE: Record<ViewKey, string | null> = {
  state: "state.md",
  // 'loops' kept as a typed alias for state.md so old call sites and the
  // ViewKey union don't break; the tab itself is removed from VIEW_ORDER so
  // it never shows in the nav. Open items live as a section inside state.md.
  loops: "state.md",
  quickstart: "QUICKSTART.md",
  prompts: "PROMPTS.md",
  skills: null,
};

type Mode = "idle" | "new-domain" | "new-app" | "pick-cli" | "chat" | "edit";

interface AppProps {
  vaultPath: string;
  vaultLabel: string;
}

interface PendingOpen {
  key: string;
  label: string;
  hostDomain: Domain;
  seed: ChatSeed;
  initialView: ViewKey;
}

export function App({ vaultPath, vaultLabel }: AppProps) {
  const renderer = useRenderer();
  const [domains, setDomains] = useState<Domain[]>(() => scanVault(vaultPath));
  const [apps, setApps] = useState<AppSkill[]>(() => [...scanApps(vaultPath), ...scanCommunityApps()]);
  const [domainIdx, setDomainIdx] = useState(0);
  const [appIdx, setAppIdx] = useState(0);
  const [focus, setFocus] = useState<SidebarFocus>("domains");
  const [viewIdx, setViewIdx] = useState(0);
  const [skillIdx, setSkillIdx] = useState(0);
  const [mode, setMode] = useState<Mode>("idle");
  const [message, setMessage] = useState<string | null>(null);
  // CLIs are seeded synchronously with the subprocess detections so the UI
  // never flashes an empty CLI bar. Ollama is appended asynchronously after
  // the HTTP probe completes (see the effect below).
  const [clis, setClis] = useState<AvailableCli[]>(() => detectSubprocessClis());
  const [cliIdx, setCliIdx] = useState(0);
  useEffect(() => {
    let cancelled = false;
    detectOllama().then((o) => {
      if (cancelled || !o) return;
      setClis((prev) => (prev.some((c) => c.kind === "ollama") ? prev : [...prev, o]));
      setCliHealth((prev) => {
        if (prev.has("ollama")) return prev;
        const next = new Map(prev);
        next.set("ollama", null);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [chats, setChats] = useState<Map<string, ChatSession>>(new Map());
  // One AbortController per in-flight session turn. When the user hits Escape
  // mid-prompt we abort the controller, which SIGTERMs the CLI child process
  // in runCapture. The .then/.catch handlers on the runChatTurn promise still
  // fire — they just write a "(cancelled)" bubble instead of the model reply.
  // Council shares one controller across all panelists + the synthesis call
  // so a single Escape kills the whole batch.
  const cancelControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingGutRef = useRef<Map<string, string>>(new Map());
  // Tracks whether we've already done the launch-time chat-open so we
  // don't re-trigger it on every render. The user wants to LAND in chat
  // for the first domain — but only once, on app boot, not on every
  // re-render (that was the original auto-open bug).
  const didLaunchOpenRef = useRef(false);
  // Tracks whether an embedded chat input (in ConnectorChat / DomainChat
  // workspaces) currently has focus. Set to true on first keystroke into
  // the embedded input; reset to false on sidebar navigation. The global
  // useKeyboard handler returns early when this is true so single-letter
  // shortcut keys (q, s, h, j, k, n, r, e, etc.) go into the input
  // instead of triggering nav actions. ctrl+c still kills the process.
  const embeddedInputActiveRef = useRef(false);
  const setEmbeddedInputActive = (v: boolean) => {
    embeddedInputActiveRef.current = v;
  };
  // When user clicks the "chat" tab in the global TabStrip, this flips to
  // true so DomainDetail shows the embedded DomainChat instead of the
  // view-specific markdown. Resets to false on any view-tab click and on
  // sidebar nav. Without this, each tab clicked just changed viewIdx but
  // the pane never actually rendered different content.
  // Domains default to the chat tab; apps default to overview+chat. The
  // user spends most of their time TALKING to a domain — that's the
  // primary surface. State / quickstart / etc. are reference tabs you
  // click when needed.
  const [chatTabActive, setChatTabActive] = useState(true);
  // Tools & Integrations overlay — opened from the banner's 🔧 tools
  // link. Shows MCP wiring, Telegram setup, briefings, calibration,
  // bench, connector OAuth flows, and the vault/config file links
  // (clickable to open in Finder).
  const [toolsOpen, setToolsOpen] = useState(false);
  // Multi-select skill set per active domain. Click a skill to toggle
  // it in the set. Selected skills are surfaced to DomainChat as
  // <context> so the LLM sees their definitions when answering.
  // Resets on domain change so each domain starts with a clean slate.
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set());
  const toggleSkillSelection = (skillId: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  };
  useEffect(() => {
    setSelectedSkillIds(new Set());
  }, [domainIdx, focus]);
  // Bump to force a re-render when the framework changes via the workspace
  // config bar (the framework value is read from disk, not from React
  // state, so we need a manual nudge).
  const [frameworkTick, setFrameworkTick] = useState(0);
  const bumpFrameworkTick = () => setFrameworkTick((t) => t + 1);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [tick, setTick] = useState(0);
  // Council UX state, lifted from ChatPane so the top-right chip and the
  // dedicated config overlay can both observe / mutate it. councilModeMap is
  // per-session — each chat decides whether its next prompt fans out.
  const [councilModeMap, setCouncilModeMap] = useState<Map<string, boolean>>(new Map());
  const [councilConfigOpen, setCouncilConfigOpen] = useState(false);
  // CLI health from a launch-time `<bin> --version` probe. Surfaces broken
  // codex / gemini installs (wrong path, missing auth, sandbox issue) before
  // the user tries council mode and is met with silent error bubbles. Value
  // is null while probing.
  const [cliHealth, setCliHealth] = useState<Map<string, CliHealth | null>>(() => {
    const m = new Map<string, CliHealth | null>();
    for (const c of detectSubprocessClis()) m.set(c.kind, null);
    return m;
  });
  useEffect(() => {
    let cancelled = false;
    clis.forEach((c) => {
      probeCli(c).then((h) => {
        if (cancelled) return;
        setCliHealth((prev) => {
          const next = new Map(prev);
          next.set(c.kind, h);
          return next;
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [clis]);

  // Self-healing health watch: every 60s, re-probe any CLI whose last probe
  // failed. If the user fixed it externally (codex login, removed a gemini
  // hook, etc) the chip flips from ! to ✓ without needing an app relaunch.
  // Healthy CLIs aren't re-probed — they cost tokens and we trust them once
  // proven good for the session. A toggle to force a re-check would be a
  // future addition but background heal covers the common case.
  useEffect(() => {
    const inFlight = new Set<string>();
    const id = setInterval(() => {
      for (const c of clis) {
        if (inFlight.has(c.kind)) continue;
        const h = cliHealth.get(c.kind);
        if (!h || h.ok) continue; // only retry failures
        inFlight.add(c.kind);
        probeCli(c)
          .then((next) => {
            setCliHealth((prev) => {
              const m = new Map(prev);
              m.set(c.kind, next);
              return m;
            });
          })
          .finally(() => inFlight.delete(c.kind));
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [clis, cliHealth]);

  // Launch-time chat open. The user wants to land directly in chat for
  // the first domain — "when you launch, you are always in chat,
  // because I'm always ready to chat." Runs ONCE on mount (guarded by
  // ref so subsequent renders never re-trigger). Sidebar nav still
  // re-opens chat for the picked domain; Escape still exits to the
  // workspace tabs. This is just the initial state.
  useEffect(() => {
    if (didLaunchOpenRef.current) return;
    if (clis.length === 0) return; // wait until at least one CLI is detected
    if (domains.length === 0) return; // empty vault — nothing to open
    didLaunchOpenRef.current = true;
    const first = domains[0];
    if (first) openChatForDomain(first);
  }, [clis.length, domains.length]);

  // Per-chat council mode with global fallback. If the key has no
  // explicit setting in the map, use the global default from config.
  const councilModeFor = (key: string | null): boolean => {
    if (!key) return false;
    const explicit = councilModeMap.get(key);
    if (explicit !== undefined) return explicit;
    return readGlobalCouncilDefault();
  };
  const toggleCouncilModeFor = (key: string) => {
    setCouncilModeMap((m) => {
      const next = new Map(m);
      next.set(key, !(m.get(key) ?? false));
      return next;
    });
  };

  const view = VIEW_ORDER[viewIdx];
  const domain = domains[domainIdx] ?? null;
  const app = apps[appIdx] ?? null;
  const skills = domain?.skills ?? [];
  const onSkillsTab = focus === "domains" && view === "skills";

  const anyPending = useMemo(
    () => Array.from(chats.values()).some((s) => s.pending),
    [chats],
  );

  useEffect(() => {
    if (!anyPending) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 1000), 110);
    return () => clearInterval(id);
  }, [anyPending]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  // background watcher — every 5 minutes, scan domains+apps for fresh
  // observations (stale state, loops spike, cold domain). NEW findings are
  // persisted to ~/.prevail/watcher.jsonl and the most-severe one surfaces
  // in the command bar so the user sees something proactively.
  useEffect(() => {
    const tickWatcher = () => {
      const obs = runWatcher(domains, apps);
      if (obs.length === 0) return;
      recordObservations(obs);
      const worst =
        obs.find((o) => o.severity === "critical") ??
        obs.find((o) => o.severity === "warn") ??
        obs[0]!;
      setMessage(`watcher: ${worst.message}  ·  /watch for more`);
    };
    tickWatcher();
    const id = setInterval(tickWatcher, 5 * 60_000);
    return () => clearInterval(id);
  }, [vaultPath, domains, apps]);

  // schedule tick — check every minute for due jobs in this vault
  useEffect(() => {
    const fireAndSurface = () => {
      const fired = tickAndRunDue(vaultPath);
      if (fired.length > 0) {
        const label = fired.map((s) => s.name || s.id).join(", ");
        setMessage(`⏰ scheduled: ${label}`);
      }
    };
    fireAndSurface();
    const id = setInterval(fireAndSurface, 60_000);
    return () => clearInterval(id);
  }, [vaultPath]);

  useEffect(() => {
    setViewIdx(0);
    setSkillIdx(0);
  }, [domainIdx]);

  useEffect(() => {
    setSkillIdx(0);
  }, [viewIdx]);

  // REMOVED: this useEffect used to auto-call autoOpenAppChat /
  // autoOpenDomainChat on every navigation, which set mode="chat" and
  // forced the legacy full-pane ChatPane to render. THAT was the actual
  // root cause of "I have to press Escape on every app." Five prior fixes
  // (mouse, arrow, Enter/c, sidebar handlers, activeKey nuke) were all
  // being immediately undone by this effect re-firing on the next render.
  //
  // The embedded ConnectorChat / DomainChat in the workspace cover the
  // chat surface now — no pre-warming a separate chat session is needed.
  // Users who want the full-pane chat experience can click the chat tab
  // in the global tab strip explicitly.

  const { domainStatus, appStatus } = useMemo(() => {
    const dom = new Map<string, ChatStatus>();
    const ap = new Map<string, ChatStatus>();
    for (const [key, s] of chats) {
      const status: ChatStatus = s.pending
        ? "pending"
        : s.messages.some((m) => m.role !== "system")
          ? "active"
          : "idle";
      if (key.startsWith("app:")) ap.set(key.slice(4), status);
      else dom.set(key, status);
    }
    return { domainStatus: dom, appStatus: ap };
  }, [chats]);

  useKeyboard((evt) => {
    const name = evt.name;
    if (!name) return;

    if (mode === "new-domain" || mode === "new-app" || mode === "edit") return;

    // When an overlay is open (Tools panel, Council config), the overlay
    // owns the keyboard. Without this, scrolling the overlay with arrow
    // keys also moved the left sidebar selection — the user reported it
    // was happening on the Tools panel: scroll down to read more →
    // sidebar jumps to a different app.
    if (toolsOpen || councilConfigOpen) {
      if (evt.ctrl && name === "c") {
        renderer?.destroy?.();
        process.exit(0);
      }
      return;
    }

    // SECURITY/UX: when the user is typing in an embedded chat input
    // (Connector/Domain workspace), only ctrl+c (quit) propagates to the
    // global handler. Every other key — letters, arrows, escape — flows
    // through to the input so the user can type freely. Without this,
    // global shortcuts like 'q' (quit), 's' (swap focus), 'h/j/k/l'
    // (nav), 'n' (new domain) intercept letters and the user can't type.
    if (embeddedInputActiveRef.current) {
      if (evt.ctrl && name === "c") {
        renderer?.destroy?.();
        process.exit(0);
      }
      return;
    }

    // When the chat's slash-command popover is open, let the chat pane own
    // arrow/tab navigation — don't steal them for the sidebar.
    if (autocompleteOpen && (name === "up" || name === "down" || name === "tab")) {
      return;
    }

    if (mode === "chat") {
      // In chat, the InputBox owns the keyboard. Up/Down recall the
      // user's prior prompts from history (cross-session FTS5 walk);
      // letters type into the input. The global handler stands aside
      // and only handles ctrl+c for kill. Sidebar nav while in chat
      // is via mouse click on the sidebar — keyboard arrows belong
      // to the chat history.
      if (evt.ctrl && name === "c") {
        renderer?.destroy?.();
        process.exit(0);
      }
      return;
    }

    if (mode === "pick-cli") {
      if (name === "escape") {
        setMode("idle");
        setPendingOpen(null);
        return;
      }
      if (name === "left" || name === "h") {
        setCliIdx((i) => (i - 1 + clis.length) % clis.length);
        return;
      }
      if (name === "right" || name === "l") {
        setCliIdx((i) => (i + 1) % clis.length);
        return;
      }
      if (name === "return" || name === "enter") {
        const chosen = clis[cliIdx];
        if (chosen && pendingOpen) finalizeOpen(chosen, pendingOpen);
        return;
      }
      return;
    }

    if (name === "q" || (evt.ctrl && name === "c")) {
      renderer?.destroy?.();
      process.exit(0);
    } else if (name === "s") {
      // Swap-focus is disabled while apps are collapsed out of the UI.
      // Keep the handler but make it a no-op so muscle memory doesn't
      // throw an unhandled-key error.
      if (SHOW_APPS) setFocus((f) => (f === "domains" ? "apps" : "domains"));
    } else if (name === "j" || name === "down") {
      if (focus === "apps") setAppIdx((s) => Math.min(apps.length - 1, s + 1));
      else if (onSkillsTab && skills.length > 0) setSkillIdx((s) => Math.min(skills.length - 1, s + 1));
      else setDomainIdx((s) => Math.min(domains.length - 1, s + 1));
    } else if (name === "k" || name === "up") {
      if (focus === "apps") setAppIdx((s) => Math.max(0, s - 1));
      else if (onSkillsTab && skills.length > 0) setSkillIdx((s) => Math.max(0, s - 1));
      else setDomainIdx((s) => Math.max(0, s - 1));
    } else if (name === "g" || name === "home") {
      if (focus === "apps") setAppIdx(0);
      else if (onSkillsTab) setSkillIdx(0);
      else setDomainIdx(0);
    } else if (name === "G" || name === "end") {
      if (focus === "apps") setAppIdx(Math.max(0, apps.length - 1));
      else if (onSkillsTab) setSkillIdx(Math.max(0, skills.length - 1));
      else setDomainIdx(Math.max(0, domains.length - 1));
    } else if (name === "tab" || name === "right" || name === "l") {
      if (focus === "domains") setViewIdx((v) => (v + 1) % VIEW_ORDER.length);
    } else if (name === "left" || name === "h") {
      if (focus === "domains") setViewIdx((v) => (v - 1 + VIEW_ORDER.length) % VIEW_ORDER.length);
    } else if (name === "return" || name === "enter") {
      // Enter no longer auto-opens a separate chat pane for apps/domains —
      // the connector workspace (and domain detail) both have embedded
      // chat in their layout, so opening a second chat pane left the
      // user staring at it and needing Escape to see the workspace they
      // were trying to reach. Enter on a skill still opens its dedicated
      // chat because skills don't have the embedded-chat workspace.
      if (onSkillsTab && skills.length > 0) {
        const sk = skills[skillIdx];
        if (sk) openChatForSkill(sk);
      }
    } else if (name === "r") {
      doRefresh();
    } else if (name === "n") {
      setMode("new-domain");
    } else if (name === "c") {
      // 'c' previously force-opened a separate full-pane chat. With the
      // embedded chat now in every workspace, this just bounces the user
      // into a redundant view. No-op — the chat input is already onscreen.
    } else if (name === "e") {
      doEdit();
    } else if (name >= "1" && name <= "5") {
      // Numbers map 1..N to VIEW_ORDER indices. Guard against pressing a
      // number past the end of the view list — VIEW_ORDER has 4 entries
      // (state/quickstart/prompts/skills) so pressing "5" used to leave
      // viewIdx=4, which then read VIEW_ORDER[4]=undefined and crashed
      // readDomainView with "paths[1] must be string, got undefined".
      const idx = Number(name) - 1;
      if (focus === "domains" && idx < VIEW_ORDER.length) setViewIdx(idx);
    }
  });

  const stats = useMemo(() => summarize(domains, apps), [domains, apps]);

  const chatCounts = useMemo(() => {
    let active = 0;
    let pending = 0;
    for (const s of chats.values()) {
      const hasReal = s.messages.some((m) => m.role !== "system");
      if (hasReal) active++;
      if (s.pending) pending++;
    }
    return { active, pending };
  }, [chats]);

  const handleSubmit = (value: string) => {
    if (mode === "new-app") {
      const result = scaffoldApp(vaultPath, value);
      setMode("idle");
      if (result.ok) {
        const next = [...scanApps(vaultPath), ...scanCommunityApps()];
        setApps(next);
        const idx = next.findIndex((a) => a.path === result.path);
        if (idx >= 0) {
          setAppIdx(idx);
          setFocus("apps");
        }
        setMessage(`✓ ${result.message}`);
      } else {
        setMessage(`✗ ${result.message}`);
      }
      return;
    }
    const result = scaffoldDomain(vaultPath, value);
    setMode("idle");
    if (result.ok) {
      const next = scanVault(vaultPath);
      setDomains(next);
      setApps([...scanApps(vaultPath), ...scanCommunityApps()]);
      const idx = next.findIndex((d) => d.path === result.path);
      if (idx >= 0) {
        setDomainIdx(idx);
        setFocus("domains");
      }
      setMessage(`✓ ${result.message}`);
    } else {
      setMessage(`✗ ${result.message}`);
    }
  };

  function doRefresh() {
    setDomains(scanVault(vaultPath));
    setApps([...scanApps(vaultPath), ...scanCommunityApps()]);
    setMessage("vault reloaded");
  }

  function openChatForDomain(d: Domain) {
    openChat({
      key: d.name,
      label: d.name,
      hostDomain: d,
      seed: "tab",
      initialView: view,
    });
  }

  function autoOpenDomainChat(d: Domain) {
    if (clis.length === 0) return;
    const key = d.name;
    setActiveKey(key);
    setMode("chat");
    setChats((m) => {
      if (m.has(key)) return m;
      const cli = clis[0];
      const session: ChatSession = {
        key,
        label: d.name,
        hostDomain: d,
        cli,
        model: "",
        seed: "tab",
        initialView: view,
        messages: makeInitialMessages(d.name, cli),
        pending: false,
        hasFirstTurn: false,
        usage: { calls: 0, promptChars: 0, replyChars: 0 },
        sessionId: makeSessionId(),
      };
      return new Map(m).set(key, session);
    });
  }

  function autoOpenAppChat(a: AppSkill) {
    if (clis.length === 0) return;
    const host = domains.find((d) => d.name === a.domains[0]) ?? domains[0];
    if (!host) return;
    const key = `app:${a.id}`;
    setActiveKey(key);
    setMode("chat");
    setChats((m) => {
      if (m.has(key)) return m;
      const cli = clis[0];
      const label = `app: ${a.id}`;
      const session: ChatSession = {
        key,
        label,
        hostDomain: host,
        cli,
        model: "",
        seed: { kind: "app", id: a.id, title: a.title, domains: a.domains },
        initialView: view,
        messages: makeInitialMessages(label, cli),
        pending: false,
        hasFirstTurn: false,
        usage: { calls: 0, promptChars: 0, replyChars: 0 },
        sessionId: makeSessionId(),
      };
      return new Map(m).set(key, session);
    });
  }

  function openChatForSkill(skill: { id: string; title: string }) {
    if (!domain) return;
    openChat({
      key: `${domain.name}:skill:${skill.id}`,
      label: `${domain.name} · skill: ${skill.id}`,
      hostDomain: domain,
      seed: { kind: "skill", id: skill.id, title: skill.title },
      initialView: view,
    });
  }

  function openChatForApp(a: AppSkill) {
    const host = domains.find((d) => d.name === a.domains[0]) ?? domains[0];
    if (!host) return;
    openChat({
      key: `app:${a.id}`,
      label: `app: ${a.id}`,
      hostDomain: host,
      seed: { kind: "app", id: a.id, title: a.title, domains: a.domains },
      initialView: view,
    });
  }

  function openChat(open: PendingOpen) {
    if (clis.length === 0) {
      setMessage("no chat cli detected — install claude, codex, or gemini");
      return;
    }
    if (chats.has(open.key)) {
      setActiveKey(open.key);
      setMode("chat");
      return;
    }
    // Default to claude when available; fall back to the first detected
    // engine. The user can switch with /claude /codex /gemini /ollama
    // inside the chat. Going to the pick-cli overlay before chat starts
    // was an extra step the user didn't want.
    const preferred = clis.find((c) => c.kind === "claude") ?? clis[0]!;
    finalizeOpen(preferred, open);
  }

  function finalizeOpen(cli: AvailableCli, open: PendingOpen) {
    const session: ChatSession = {
      key: open.key,
      label: open.label,
      hostDomain: open.hostDomain,
      cli,
      model: "",
      seed: open.seed,
      initialView: open.initialView,
      messages: makeInitialMessages(open.label, cli),
      pending: false,
      hasFirstTurn: false,
      usage: { calls: 0, promptChars: 0, replyChars: 0 },
      sessionId: makeSessionId(),
    };
    setChats((m) => new Map(m).set(open.key, session));
    setActiveKey(open.key);
    setPendingOpen(null);
    setMode("chat");
  }

  function handleChatCommand(key: string, cmd: ChatCommand) {
    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      let next: ChatSession = cur;
      let systemNote: string | null = null;
      if (cmd.kind === "switch-cli") {
        const available = clis.find((c) => c.kind === cmd.cli);
        if (!available) {
          systemNote = `${cmd.cli} is not installed — try /claude, /codex, or /gemini that you have.`;
        } else {
          const model = (cmd.model ?? "").trim();
          next = {
            ...cur,
            cli: available,
            model,
            hasFirstTurn: false,
          };
          systemNote = `switched to ${available.label} · model ${formatModelBadge(model)}. next message starts a fresh session.`;
        }
      } else if (cmd.kind === "switch-model") {
        const raw = (cmd.model ?? "").trim();
        const model = raw === "default" || raw === "" ? "" : raw;
        next = { ...cur, model, hasFirstTurn: false };
        systemNote = `model set to ${formatModelBadge(model)} on ${cur.cli.label}. next message starts a fresh session.`;
      } else if (cmd.kind === "clear") {
        next = {
          ...cur,
          messages: makeInitialMessages(cur.label, cur.cli),
          hasFirstTurn: false,
        };
        systemNote = "conversation cleared.";
      } else if (cmd.kind === "help") {
        systemNote = `available commands:\n${SLASH_HELP}`;
      } else if (cmd.kind === "distill") {
        // distill is async — kick off in the next tick after this state update
        setTimeout(() => startDistill(key), 0);
        systemNote = "🪄 distilling this conversation into a SKILL.md draft…";
      } else if (cmd.kind === "accept-distill") {
        const result = writeDistilledSkill(cur.hostDomain, cmd.content);
        if (result.ok) {
          // mark the original distill-draft message as saved and add a system confirm
          next = {
            ...cur,
            messages: cur.messages.map((mm) =>
              mm.ts === cmd.ts && mm.kind === "distill-draft"
                ? { ...mm, kind: "distill-saved" }
                : mm,
            ),
          };
          systemNote = `✓ ${result.message} — refreshing skills…`;
          setTimeout(() => doRefresh(), 100);
        } else {
          systemNote = `✗ could not save: ${result.message}`;
        }
      } else if (cmd.kind === "discard-distill") {
        next = {
          ...cur,
          messages: cur.messages.map((mm) =>
            mm.ts === cmd.ts && mm.kind === "distill-draft"
              ? { ...mm, kind: "distill-discarded" }
              : mm,
          ),
        };
        systemNote = "distill draft discarded.";
      } else if (cmd.kind === "search") {
        const q = cmd.query.trim();
        if (!q) {
          systemNote = "usage: /search <query>  · e.g. /search roth conversion";
        } else {
          const hits = searchMessages(q, 5);
          if (hits.length === 0) {
            systemNote = `no past chats matched "${q}".`;
          } else {
            const lines = hits.map((h) => {
              const when = formatRelativeDate(h.ts);
              return `  · [${h.domain}] ${when} (${h.role}) — «${h.excerpt}»`;
            });
            systemNote = `${hits.length} past chat${hits.length === 1 ? "" : "s"} matching "${q}":\n${lines.join("\n")}`;
          }
        }
      } else if (cmd.kind === "history") {
        const limit = cmd.limit ?? 20;
        const prompts = getUserPromptsForDomain(next.hostDomain.name, limit);
        const filePath = promptLogPath(next.hostDomain.name);
        if (prompts.length === 0) {
          systemNote = `no past prompts saved for ${next.hostDomain.name} yet.\nlog file: ${filePath}`;
        } else {
          const lines = prompts.map((p) => {
            const when = formatRelativeDate(p.ts);
            const first = p.content.split("\n")[0]?.slice(0, 200) ?? "";
            const cliTag = p.cli ? ` [${p.cli}${p.model ? "·" + p.model : ""}]` : "";
            return `  · ${when}${cliTag} — ${first}`;
          });
          systemNote = `your last ${prompts.length} prompt${prompts.length === 1 ? "" : "s"} for ${next.hostDomain.name} (newest first):\n${lines.join("\n")}\n\nfull log: ${filePath}`;
        }
      } else if (cmd.kind === "council") {
        // Fire-and-forget — the council runner takes over from here.
        setTimeout(() => runCouncil(key, cmd.prompt), 0);
        return m;
      } else if (cmd.kind === "council-config") {
        // Open the dedicated full-pane config overlay rather than dropping a
        // bubble into the chat. Keeps the transcript focused on the actual
        // conversation; configuration is a separate surface.
        setCouncilConfigOpen(true);
        return m;
      } else if (cmd.kind === "council-use") {
        if (cmd.clis.length === 0) {
          systemNote = "usage: /council use <cli1> [cli2 ...]  ·  /council use all";
        } else if (cmd.clis.length === 1 && cmd.clis[0] === "all") {
          setCouncilClis(null);
          systemNote = "council panel reset to all detected CLIs.";
        } else {
          const valid: CliKind[] = [];
          const invalid: string[] = [];
          for (const c of cmd.clis) {
            if (isCliKind(c)) valid.push(c);
            else invalid.push(c);
          }
          if (invalid.length > 0) {
            systemNote = `unknown CLI: ${invalid.join(", ")}. valid: ${ALL_CLI_KINDS.join(", ")}`;
          } else {
            const dedup = Array.from(new Set(valid));
            setCouncilClis(dedup);
            systemNote = `council panel set to: ${dedup.join(", ")}.`;
          }
        }
      } else if (cmd.kind === "council-model") {
        if (!cmd.cli) {
          systemNote =
            "usage: /council model <cli> <model>            (replace list — single variant)\n" +
            "       /council model <cli> add <model>       (add a variant for cross-model compare)\n" +
            "       /council model <cli> remove <model>    (drop a variant)\n" +
            "       /council model <cli> default           (clear all variants — use CLI's default)";
        } else if (!isCliKind(cmd.cli)) {
          systemNote = `unknown CLI: ${cmd.cli}. valid: ${ALL_CLI_KINDS.join(", ")}`;
        } else if (!cmd.model.trim()) {
          systemNote = `usage: /council model ${cmd.cli} <model>  ·  /council model ${cmd.cli} add <model>  ·  /council model ${cmd.cli} default`;
        } else {
          // Sub-action parsing: first token may be add|remove|default|clear,
          // remainder is the model name (allows e.g. "add gpt-5.4-mini").
          const parts = cmd.model.trim().split(/\s+/);
          const head = parts[0]?.toLowerCase() ?? "";
          const tail = parts.slice(1).join(" ").trim();
          if (head === "default" || head === "clear") {
            setCouncilModel(cmd.cli, null);
            systemNote = `cleared all model variants for ${cmd.cli} (will use default).`;
          } else if (head === "add" && tail) {
            addCouncilModel(cmd.cli, tail);
            systemNote = `added ${tail} to ${cmd.cli} panel.`;
          } else if (head === "remove" && tail) {
            removeCouncilModel(cmd.cli, tail);
            systemNote = `removed ${tail} from ${cmd.cli} panel.`;
          } else {
            // Bare model name: replace the list with this single entry.
            setCouncilModel(cmd.cli, cmd.model.trim());
            systemNote = `${cmd.cli} panel now: ${cmd.model.trim()}.`;
          }
        }
      } else if (cmd.kind === "council-chair") {
        const cur = readCouncilConfig();
        if (!cmd.cli) {
          systemNote = cur.chair
            ? `chair: ${cur.chair.cli}${cur.chair.model ? "·" + cur.chair.model : ""}  ·  /council chair default to clear`
            : "chair: auto (first successful panelist)  ·  /council chair <cli> [model] to pin";
        } else if (cmd.cli === "default" || cmd.cli === "clear" || cmd.cli === "auto") {
          setCouncilChair(null);
          systemNote = "chair cleared — verdict will be synthesized by the first panelist that returns.";
        } else if (!isCliKind(cmd.cli)) {
          systemNote = `unknown CLI: ${cmd.cli}. valid: ${ALL_CLI_KINDS.join(", ")}`;
        } else {
          setCouncilChair({ cli: cmd.cli, model: cmd.model || undefined });
          systemNote = `chair pinned to ${cmd.cli}${cmd.model ? "·" + cmd.model : ""}. verdicts will always be synthesized by this CLI.`;
        }
      } else if (cmd.kind === "heatmap") {
        const days = cmd.days ?? 30;
        const required = domains.map((d) => d.name);
        const rows = buildDomainHeatmap(days, required);
        systemNote = renderHeatmapText(rows, days);
      } else if (cmd.kind === "watch") {
        const limit = cmd.limit ?? 20;
        const obs = readRecentObservations(limit);
        systemNote = renderObservationsText(obs);
      } else if (cmd.kind === "web") {
        if (cmd.mode === "status") {
          const current = readWebAccess();
          systemNote = `web access is currently: ${current}. use /web on to allow, /web off to deny.`;
        } else {
          setWebAccess(cmd.mode);
          systemNote = cmd.mode === "deny"
            ? "web access disabled. CLIs will be told not to use WebSearch, WebFetch, or any network tools from the next turn onward."
            : "web access enabled. CLIs may use WebSearch, WebFetch, and network tools as needed.";
        }
      } else if (cmd.kind === "framework") {
        const arg = cmd.id.trim();
        if (!arg || arg === "list" || arg === "ls" || arg === "show") {
          const cur = readResponseFramework();
          const lines = FRAMEWORKS.map(
            (f) => `  ${f.id === cur ? "▸" : " "} ${f.label.padEnd(10)} ${f.blurb}`,
          );
          systemNote =
            `response frameworks (active: ${cur ?? "none"}):\n` +
            lines.join("\n") +
            `\n\nset with: /framework <id> · clear with: /framework none`;
        } else if (arg === "none" || arg === "off" || arg === "clear" || arg === "default") {
          setResponseFramework(null);
          systemNote = "response framework cleared — models pick their own structure.";
        } else if (isFrameworkId(arg)) {
          setResponseFramework(arg);
          const fw = getFramework(arg)!;
          systemNote = `response framework set to ${fw.label} — ${fw.blurb}. applies to every CLI from the next message.`;
        } else {
          systemNote = `unknown framework "${arg}". try /framework list.`;
        }
      } else if (cmd.kind === "gut") {
        if (!cmd.text) {
          systemNote = "usage: /gut <one-line take> — captures your gut answer before /council. consumed on the next council turn.";
        } else {
          pendingGutRef.current.set(key, cmd.text);
          systemNote = `gut recorded: "${cmd.text}". the next /council in this chat will log it next to the verdict.`;
        }
      } else if (cmd.kind === "calibration") {
        systemNote = handleCalibrationCommand(cmd.sub, cmd.arg, cur.hostDomain.path);
      } else if (cmd.kind === "telegram") {
        systemNote = handleTelegramCommand(cmd.sub, cmd.arg);
      } else if (cmd.kind === "briefing") {
        systemNote = handleBriefingCommand(cmd.sub, cmd.arg, vaultPath, apps, domains);
      } else if (cmd.kind === "connectors") {
        systemNote = renderConnectorOverview(apps);
      } else if (cmd.kind === "connector-oauth") {
        // Fire OAuth flow asynchronously — spawns a 127.0.0.1 server,
        // opens the browser, writes the refresh token. We surface a
        // "starting" note immediately and the result message arrives as
        // a follow-up system note when the flow resolves.
        systemNote = startConnectorOAuth(key, cmd.id, apps);
      } else if (cmd.kind === "connector-test") {
        systemNote = `running connector test for ${cmd.id}…`;
        startConnectorTest(key, cmd.id, apps);
      } else if (cmd.kind === "unknown") {
        systemNote = `unknown command ${cmd.raw}. try /help.`;
      }
      if (systemNote) {
        next = {
          ...next,
          messages: [
            ...next.messages,
            { role: "system", content: systemNote, ts: Date.now() },
          ],
        };
      }
      return new Map(m).set(key, next);
    });
  }

  function exitChat() {
    setMode("idle");
  }

  function startDistill(key: string) {
    const session = chats.get(key);
    if (!session) return;
    const visible = session.messages.filter((mm) => mm.role !== "system");
    if (visible.length === 0) {
      setChats((m) => {
        const cur = m.get(key);
        if (!cur) return m;
        return new Map(m).set(key, {
          ...cur,
          messages: [
            ...cur.messages,
            {
              role: "system" as const,
              content: "nothing to distill — send a message or two first.",
              ts: Date.now(),
            },
          ],
        });
      });
      return;
    }
    const prompt = buildDistillPrompt(session.hostDomain, session.messages);
    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      return new Map(m).set(key, { ...cur, pending: true });
    });
    runChatTurn({
      prompt,
      cwd: session.hostDomain.path,
      cli: session.cli,
      model: session.model,
      isFirst: true,
    })
      .then((response) => {
        const parsed = parseDistillResponse(response);
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          const ts = Date.now();
          const newMsg = parsed.ok
            ? {
                role: "assistant" as const,
                content: parsed.skill!,
                ts,
                kind: "distill-draft" as const,
              }
            : {
                role: "system" as const,
                content: `distill failed: ${parsed.error}. raw response:\n\n${response.slice(0, 500)}`,
                ts,
              };
          return new Map(m).set(key, {
            ...cur,
            messages: [...cur.messages, newMsg],
            pending: false,
          });
        });
      })
      .catch((err: Error) => {
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          return new Map(m).set(key, {
            ...cur,
            messages: [
              ...cur.messages,
              {
                role: "system" as const,
                content: `distill error: ${err.message}`,
                ts: Date.now(),
              },
            ],
            pending: false,
          });
        });
      });
  }

  // A panelist is one (cli, model) pair. Expanding the configured CLI list
  // against each CLI's model variants lets users compare e.g. Claude Opus 4.7
  // vs 4.8 in the same panel.
  function resolveCouncilPanel(): {
    panelists: { cli: AvailableCli; model: string }[];
  } {
    const cfg = readCouncilConfig();
    let activeClis = clis;
    if (cfg.clis && cfg.clis.length > 0) {
      activeClis = clis.filter((c) => cfg.clis!.includes(c.kind));
    }
    const panelists: { cli: AvailableCli; model: string }[] = [];
    for (const cli of activeClis) {
      const variants = cfg.models[cli.kind] ?? [""]; // default = single panelist, default model
      for (const m of variants) {
        panelists.push({ cli, model: m });
      }
    }
    return { panelists };
  }

  async function runCouncil(key: string, prompt: string) {
    const session = chats.get(key);
    if (!session) return;
    if (clis.length === 0) {
      setMessage("no CLIs detected — install claude / codex / gemini first");
      return;
    }
    const { panelists: configuredPanelists } = resolveCouncilPanel();
    // Drop any panelist whose CLI failed the launch-time probe — same
    // (cli, model) pairs as before but indexed by panelist now. Health is
    // tracked per CLI (binary works/not), so all model variants of an
    // unhealthy CLI are skipped together.
    const skippedClis = new Set<string>();
    const panelists = configuredPanelists.filter(({ cli }) => {
      const h = cliHealth.get(cli.kind);
      if (h && !h.ok) {
        skippedClis.add(cli.kind);
        return false;
      }
      return true;
    });
    const skippedLabels = Array.from(skippedClis).map((kind) => {
      const c = clis.find((x) => x.kind === kind);
      return c?.label ?? kind;
    });
    if (skippedLabels.length > 0) {
      setMessage(`skipped ${skippedLabels.join(", ")} — failed launch probe`);
    }
    if (panelists.length === 0) {
      setMessage(
        "council panel is empty after filtering — /council config or /council use ... to fix",
      );
      return;
    }
    // Distinct CLIs in the panel — counts unique kinds, since multiple
    // model variants of one CLI still represent one provider's viewpoint.
    // If a council ends up running with only one provider it isn't really
    // a council anymore (no triangulation), so flag it visibly so the user
    // can fix their config or wait for the missing provider to come back
    // online (e.g. gemini quota reset).
    const distinctClis = new Set(panelists.map((p) => p.cli.kind));
    if (distinctClis.size < 2) {
      const sole = panelists[0]!.cli.label;
      setMessage(
        `! degraded council: only ${sole} will respond (no triangulation). check /council config or wait for the other providers to come back online.`,
      );
    }
    const text = prompt.trim();
    if (!text) {
      setMessage("usage: /council <your high-stakes question>");
      return;
    }
    const userTs = Date.now();
    // Capture-at-send for response-shaping metadata. The chair verdict
    // bubble + the user's own prompt carry the GLOBAL council framework
    // and lens setting (the lens of the COUNCIL, not per-panelist). The
    // lens label is "all" when fanout is on, else the resolved single
    // lens, else undefined. Per-panelist lens labels are derived from
    // job.lens inside the calls loop further down.
    const councilFwId = readResponseFramework(session.hostDomain.name);
    const councilLensSel = readResponseLens(session.hostDomain.name);
    const councilFwLabel = getFramework(councilFwId)?.label;
    const councilLensLabel =
      councilLensSel === "all"
        ? "all"
        : councilLensSel
          ? getLens(councilLensSel)?.label
          : undefined;
    const userMsg = {
      role: "user" as const,
      content: `/council ${text}`,
      ts: userTs,
      framework: councilFwLabel,
      lens: councilLensLabel,
    };
    persistMessage({
      domain: session.hostDomain.name,
      session_id: session.sessionId,
      role: "user",
      content: userMsg.content,
      ts: userTs,
      cli: "council",
      model: "",
      framework: councilFwLabel,
      lens: councilLensLabel,
    });
    // Expand panel × lenses. When the domain (or global) has a lens
    // selection of "all", every panelist runs once per lens — 4 CLIs ×
    // 5 lenses = 20 jobs per question. Specific id = each panelist
    // runs once with that lens prepended. null = today's behavior, one
    // job per panelist with no lens directive.
    const lensList = expandLensSelection(councilLensSel);
    type Job = { cli: AvailableCli; model: string; lens: Lens | null };
    const jobs: Job[] =
      lensList.length === 0
        ? panelists.map((p) => ({ ...p, lens: null as Lens | null }))
        : panelists.flatMap((p) =>
            lensList.map((l) => ({ ...p, lens: l as Lens | null })),
          );
    // One ts per JOB so multiple jobs sharing a CLI (multiple model
    // variants, or multiple lenses) each get their own pending bubble.
    const pendingTsByIdx = jobs.map((_, i) => userTs + 100 + i);

    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      const introTs = userTs + 1;
      const panelLabel = jobs
        .map(({ cli, model, lens }) => {
          const tag = model ? `${cli.label}·${model}` : cli.label;
          return lens ? `${tag} [${lens.label}]` : tag;
        })
        .join(" · ");
      const introMsgs: ChatSession["messages"] = [
        userMsg,
        {
          role: "system" as const,
          content: `convening council: ${panelLabel}`,
          ts: introTs,
        },
      ];
      if (skippedLabels.length > 0) {
        introMsgs.push({
          role: "system" as const,
          content: `skipped (failed launch probe): ${skippedLabels.join(", ")}`,
          ts: introTs + 1,
        });
      }
      // Drop a "thinking" placeholder bubble per job immediately so the
      // user sees all jobs working at once instead of waiting in silence
      // for the first one to return. With lens=all this drops 20 bubbles.
      jobs.forEach(({ cli, model }, i) => {
        introMsgs.push({
          role: "assistant" as const,
          content: "",
          ts: pendingTsByIdx[i]!,
          kind: "council-pending" as const,
          cli: cli.kind,
          model,
        });
      });
      return new Map(m).set(key, {
        ...cur,
        messages: [...cur.messages, ...introMsgs],
        pending: true,
      });
    });
    // Each panelist call to a CLI is one-shot — codex/gemini have no session
    // continuation in our wrapper, and we set isFirst=true for claude too so
    // every panelist starts clean. That means follow-up council turns lose all
    // prior context unless we hand-roll it: walk the message log, pull prior
    // user turns + council verdicts + single-CLI assistant turns, and prepend
    // that as a conversation transcript so each panelist sees what was said
    // before. Without this they answer the follow-up as if it were a totally
    // fresh question.
    const basePromptForCli = buildCouncilTurnPrompt(
      { ...session, messages: [...session.messages, userMsg] },
      text,
    );
    // Shared abort controller for the whole council batch. Escape kills every
    // panelist and the synthesis call in one shot.
    const controller = new AbortController();
    cancelControllersRef.current.set(key, controller);
    // Memory recall — best-effort. When Ollama is reachable + nomic-embed-text
    // is pulled, retrieve the top-3 semantically-similar prior decisions
    // from the vault and prepend as a <context> block so every panelist
    // sees what you decided before on similar questions. Silent fallback
    // to no-context when no embedder is available.
    let promptForCli = basePromptForCli;
    try {
      const { recall, formatRecallContext } = await import("./memory.ts");
      const hits = await recall({
        vaultPath,
        query: text,
        k: 3,
        signal: controller.signal,
      });
      const ctx = formatRecallContext(hits);
      if (ctx) promptForCli = `${ctx}\n\n${basePromptForCli}`;
    } catch {
      /* embedder unavailable — no recall this turn */
    }
    // Collect successful responses in a closure so we can synthesize them
    // into a verdict after all panel members return. lens is carried
    // through so the chair can group by lens in synthesis when applicable.
    type Collected = {
      cli: AvailableCli;
      model: string;
      lens: Lens | null;
      response: string;
      ok: boolean;
    };
    const collected: Collected[] = [];

    // Hard per-call timeout so a hanging CLI (codex on a broken auth, gemini
    // blocked on a missing hook script, network stall) can never block the
    // synthesis. 120s is long enough for slow models to finish but short
    // enough that the user gets a verdict from the rest of the panel.
    const PANELIST_TIMEOUT_MS = 120_000;
    function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms / 1000}s — skipped`));
        }, ms);
        p.then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
    }

    const calls = jobs.map(({ cli, model: mdl, lens }, jobIdx) => {
      // Lens preamble is prepended to the per-job prompt so each panelist
      // sees its assigned lens directive as the last thing before the
      // user's question (recall context + framework already in promptForCli).
      const jobPrompt = lens ? `${buildLensPreamble(lens)}${promptForCli}` : promptForCli;
      const callLabel = `${mdl ? `${cli.label}·${mdl}` : cli.label}${lens ? ` [${lens.label}]` : ""}`;
      return withTimeout(
        runChatTurn({
          prompt: jobPrompt,
          cwd: session.hostDomain.path,
          cli,
          model: mdl,
          isFirst: true,
          bare: true,
          signal: controller.signal,
        }),
        PANELIST_TIMEOUT_MS,
        callLabel,
      )
        .then((response) => {
          const ts = Date.now();
          collected.push({ cli, model: mdl, lens, response, ok: true });
          // Per-panelist lens label = the lens actually attached to THIS
          // job, not the council-wide selection. With fanout active each
          // panelist runs once per lens, so the bubble badge needs to show
          // the SPECIFIC lens of attack used here (CONTRARIAN, MOM, ...).
          const jobLensLabel = lens?.label;
          persistMessage({
            domain: session.hostDomain.name,
            session_id: session.sessionId,
            role: "assistant",
            content: response,
            ts,
            cli: cli.kind,
            model: mdl,
            framework: councilFwLabel,
            lens: jobLensLabel,
          });
          // Replace the pending placeholder for THIS job (by ts — many
          // jobs may share a CLI/model when lens fanout is active, so
          // kind alone isn't enough).
          const pendingTs = pendingTsByIdx[jobIdx]!;
          setChats((m) => {
            const cur = m.get(key);
            if (!cur) return m;
            const responseMsg = {
              role: "assistant" as const,
              content: response,
              ts,
              kind: "council-response" as const,
              cli: cli.kind,
              model: mdl,
              framework: councilFwLabel,
              lens: jobLensLabel,
            };
            const idx = cur.messages.findIndex(
              (x) => x.kind === "council-pending" && x.ts === pendingTs,
            );
            const nextMessages =
              idx >= 0
                ? [...cur.messages.slice(0, idx), responseMsg, ...cur.messages.slice(idx + 1)]
                : [...cur.messages, responseMsg];
            return new Map(m).set(key, {
              ...cur,
              messages: nextMessages,
              usage: {
                calls: cur.usage.calls + 1,
                promptChars: cur.usage.promptChars + jobPrompt.length,
                replyChars: cur.usage.replyChars + response.length,
              },
            });
          });
        })
        .catch((err: Error) => {
          const ts = Date.now();
          collected.push({ cli, model: mdl, lens, response: err.message, ok: false });
          const pendingTs = pendingTsByIdx[jobIdx]!;
          setChats((m) => {
            const cur = m.get(key);
            if (!cur) return m;
            const errMsg = {
              role: "assistant" as const,
              content: `error: ${err.message}`,
              ts,
              kind: "council-response" as const,
              cli: cli.kind,
              model: mdl,
            };
            const idx = cur.messages.findIndex(
              (x) => x.kind === "council-pending" && x.ts === pendingTs,
            );
            const nextMessages =
              idx >= 0
                ? [...cur.messages.slice(0, idx), errMsg, ...cur.messages.slice(idx + 1)]
                : [...cur.messages, errMsg];
            return new Map(m).set(key, { ...cur, messages: nextMessages });
          });
        });
    });

    Promise.allSettled(calls).then(async () => {
      const good = collected.filter((c) => c.ok);
      // Need ≥2 panel responses for a synthesis to be meaningful.
      if (good.length >= 2) {
        // Pick the chair: prefer the config-pinned chair if its CLI is healthy
        // and detected, otherwise fall back to the first panelist that
        // actually returned a reply. Avoids surprises where a timed-out
        // configured leader would have blocked the verdict.
        const chairCfg = readCouncilConfig().chair;
        let synthCli = (good[0] ?? panelists[0]!).cli;
        let synthModel = (good[0] ?? panelists[0]!).model;
        if (chairCfg) {
          const chairCli = clis.find((c) => c.kind === chairCfg.cli);
          const chairHealth = cliHealth.get(chairCfg.cli);
          if (chairCli && (!chairHealth || chairHealth.ok)) {
            synthCli = chairCli;
            synthModel = chairCfg.model ?? "";
          }
        }
        // Drop a "synthesizing" placeholder so the user sees step 2 happen
        // explicitly (panel → synth → verdict) rather than wondering why the
        // chair is "thinking" alongside the panel.
        const synthTs = Date.now();
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          return new Map(m).set(key, {
            ...cur,
            messages: [
              ...cur.messages,
              {
                role: "assistant" as const,
                content: "",
                ts: synthTs,
                kind: "council-synthesizing" as const,
                cli: synthCli.kind,
                model: synthModel,
              },
            ],
          });
        });
        const lensesActive = lensList.length > 0;
        const panelBlock = good
          .map((c) => {
            const tag = c.model ? `${c.cli.label}·${c.model}` : c.cli.label;
            const lensTag = c.lens ? ` [${c.lens.label}]` : "";
            return `--- ${tag}${lensTag} ---\n${c.response.trim()}`;
          })
          .join("\n\n");
        const panelistList = good
          .map((c) => {
            const tag = c.model ? `${c.cli.label}·${c.model}` : c.cli.label;
            return c.lens ? `${tag} [${c.lens.label}]` : tag;
          })
          .join(", ");
        // Two synthesis prompts: lens-mode treats divergence between
        // lenses as the SIGNAL (different angles are supposed to give
        // different answers), while standard council mode treats it as
        // factual disagreement and applies majority rule. Picking the
        // wrong prompt either flattens the lenses into a vote (bad) or
        // resolves a factual question by "respecting all perspectives"
        // (also bad).
        const synthPrompt = lensesActive
          ? `You are the chair of an AI council that just ran a multi-lens analysis. ${good.length} responses came in: each panelist (${panelistList}) attacked the same question from a specific cognitive lens. The lenses are deliberately different framings — first-principles, outsider, contrarian, expansionist, executor. Divergence between lenses is the SIGNAL, not noise.\n\n` +
            `USER QUESTION:\n${text}\n\n` +
            `PANEL RESPONSES (grouped by panelist · lens):\n${panelBlock}\n\n` +
            `Synthesis rules:\n` +
            `- DO NOT treat lens divergence as factual disagreement. The lenses were SUPPOSED to produce different angles.\n` +
            `- When the SAME lens (e.g. CONTRARIAN) was run by multiple CLIs, treat their replies as votes within that lens — if they converge, the lens has a stable position; if they diverge, name it.\n` +
            `- The verdict must integrate ACROSS lenses, not pick one lens as the winner. A good verdict respects what each lens revealed.\n\n` +
            `Output exactly these four sections, no preamble, no closing remarks:\n\n` +
            `## What each lens revealed\n` +
            `One bullet per LENS (not per panelist). Format: "**<LENS LABEL>**: <the lens's core insight in <=1 sentence> — <the most concrete thing it would have the user do or avoid>". Aggregate across CLIs that ran that lens.\n\n` +
            `## Cross-lens consensus\n` +
            `Bulleted list of points multiple lenses converged on, even via different reasoning. If lenses fundamentally disagreed about everything, write "None — see divergence."\n\n` +
            `## Cross-lens divergence\n` +
            `Bulleted list of points where the lenses produced genuinely incompatible recommendations (not just different emphases). For each bullet, name which lens took which side. This is where the user's hardest call lives.\n\n` +
            `## Verdict\n` +
            `Two lines. Line 1 starts with "VERDICT:" + one sentence giving the integrated call that respects what every lens revealed. Line 2 starts with "Why:" + one sentence naming which lenses most informed the call and what tradeoff you resolved.`
          : `You are the chair of an AI council. ${good.length} independent panelists (${panelistList}) just answered the same user question. ` +
          `Your job: show what each panelist said and why, name the consensus, name the divergence, then deliver one decisive verdict with the reasoning tied back to the panelists. Do not hedge — pick a side.\n\n` +
          `USER QUESTION:\n${text}\n\n` +
          `PANEL RESPONSES:\n${panelBlock}\n\n` +
          `MAJORITY RULE — read carefully:\n` +
          `When panelists give different concrete answers to the same factual question (a specific date, number, dollar amount, name, yes/no call, recommended action), the verdict MUST side with the majority answer. Example: if 2 panelists say "file in June" and 1 says "file in August", the verdict is June — full stop. Treat near-identical answers as the same vote (June 13 and June 14 are both "June"). The minority position only wins if it cites a hard external fact the majority got demonstrably wrong (a wrong year, a missed deadline, etc); if you invoke this exception, name the fact explicitly in Divergence and Why.\n\n` +
          `Output exactly these four sections in this order, no preamble, no closing remarks:\n\n` +
          `## What each panelist said\n` +
          `One bullet per panelist, using their label exactly as shown above. Format: "**<label>**: <their concrete answer in <=1 sentence> — <key reason or citation they gave in <=1 sentence>>". If a panelist cited a source, date, number, or rule, include it verbatim. Do not paraphrase the answer into something softer than what they actually said.\n\n` +
          `## Consensus\n` +
          `Bulleted list of every concrete point the panel agreed on (or where a clear majority converged). If they disagreed on everything, write "None — see divergence."\n\n` +
          `## Divergence\n` +
          `Bulleted list of every point where panelists materially disagreed. For each bullet, name which panelist took which side using their label and a vote tally (e.g. "Claude Code: June 14, Codex: August 14, Gemini: June 13 → majority: June (2 of 3)"). Skip stylistic differences; only flag substantive disagreements.\n\n` +
          `## Verdict\n` +
          `Two lines. Line 1 must start with the literal word "VERDICT:" followed by one single sentence giving the decisive call in plain language — no qualifiers, no "consider" or "you might", just tell the user what to do. The verdict must reflect the majority position from above. Line 2 must start with the literal word "Why:" followed by one short sentence tying the call back to the panelists by name — which ones supported the verdict, on what reasoning, and (if any) which panelist dissented and what they argued instead.`;

        try {
          // Synthesis itself can hang if the chair CLI is having a bad day.
          // Cap it so the verdict either lands quickly or we fall through to
          // pending=false cleanly.
          const verdict = await withTimeout(
            runChatTurn({
              prompt: synthPrompt,
              cwd: session.hostDomain.path,
              cli: synthCli,
              model: synthModel,
              isFirst: true,
              bare: true,
              signal: controller.signal,
            }),
            PANELIST_TIMEOUT_MS,
            `${synthCli.label} (synthesis)`,
          );
          const ts = Date.now();
          persistMessage({
            domain: session.hostDomain.name,
            session_id: session.sessionId,
            role: "assistant",
            content: verdict,
            ts,
            cli: synthCli.kind,
            model: synthModel,
            framework: councilFwLabel,
            lens: councilLensLabel,
          });
          // Self-curating vault: log the verdict (not the individual panel
          // responses — those are kept in the session log but the verdict is
          // what the user actually took away).
          // Consume the per-session gut take, if /gut was used since the
          // last council turn. Once consumed it's gone — a second
          // council turn won't re-use the stale gut.
          const gut = pendingGutRef.current.get(key);
          if (gut) pendingGutRef.current.delete(key);
          writeTurnSummary({
            domainPath: session.hostDomain.path,
            userPrompt: text,
            assistantReply: verdict,
            cliLabel: `Council ⚖ ${synthCli.label}`,
            ts,
            kind: "council-verdict",
            gut,
            framework: councilFwLabel,
            lens: councilLensLabel,
            // Full cockpit-state snapshot — user asked the _log meta
            // line to carry model, web, serendipity, council mode, etc.
            model: synthModel || synthCli.kind,
            webAccess: readWebAccess(),
            serendipity: readSerendipity(session.hostDomain.name),
            councilOn: true,
            raw: readCheckpoint(session.hostDomain.name),
          });
          // Curated layer: distill the verdict into journal/decisions.md
          // + journal/facts.md. Best-effort, async, never blocks the
          // chat path. Uses the chair model (synthCli) since it already
          // produced the synthesis and the distill prompt is small.
          void distillTurnToJournal({
            domainPath: session.hostDomain.path,
            userPrompt: text,
            assistantReply: verdict,
            ts,
            cli: synthCli,
            model: synthModel,
            signal: controller.signal,
          }).catch(() => {});
          // Serendipity on the council VERDICT — same pattern as the
          // single-chat path. The post-call uses the chair model so
          // the angle stays consistent with the synthesis voice.
          if (readSerendipity(session.hostDomain.name)) {
            void (async () => {
              const angle = await runSerendipityPass({
                cwd: session.hostDomain.path,
                cli: synthCli,
                model: synthModel,
                userPrompt: text,
                assistantReply: verdict,
              });
              if (!angle) return;
              const sTs = Date.now();
              setChats((m) => {
                const cur = m.get(key);
                if (!cur) return m;
                return new Map(m).set(key, {
                  ...cur,
                  messages: [
                    ...cur.messages,
                    {
                      role: "assistant" as const,
                      content: angle,
                      ts: sTs,
                      kind: "serendipity" as const,
                      cli: synthCli.kind,
                      model: synthModel,
                    },
                  ],
                });
              });
            })().catch(() => {});
          }
          // Replace the synthesizing placeholder with the verdict, AND flip
          // pending=false in the same setChats so the spinner stops the
          // instant the verdict bubble appears.
          setChats((m) => {
            const cur = m.get(key);
            if (!cur) return m;
            const verdictMsg = {
              role: "assistant" as const,
              content: verdict,
              ts,
              kind: "council-verdict" as const,
              cli: synthCli.kind,
              model: synthModel,
              framework: councilFwLabel,
              lens: councilLensLabel,
            };
            const idx = cur.messages.findIndex(
              (x) => x.kind === "council-synthesizing" && x.ts === synthTs,
            );
            const nextMessages =
              idx >= 0
                ? [...cur.messages.slice(0, idx), verdictMsg, ...cur.messages.slice(idx + 1)]
                : [...cur.messages, verdictMsg];
            return new Map(m).set(key, {
              ...cur,
              messages: nextMessages,
              pending: false,
              hasFirstTurn: true,
              usage: {
                calls: cur.usage.calls + 1,
                promptChars: cur.usage.promptChars + synthPrompt.length,
                replyChars: cur.usage.replyChars + verdict.length,
              },
            });
          });
          return; // verdict landed — done.
        } catch {
          // Synthesis failed — drop the synthesizing placeholder so the user
          // isn't left staring at a spinner that will never resolve.
          setChats((m) => {
            const cur = m.get(key);
            if (!cur) return m;
            return new Map(m).set(key, {
              ...cur,
              messages: cur.messages.filter(
                (x) => !(x.kind === "council-synthesizing" && x.ts === synthTs),
              ),
            });
          });
        }
      }
      // No verdict (fewer than 2 successes, or synthesis failed) — still
      // clear pending so the spinner stops.
      setChats((m) => {
        const cur = m.get(key);
        if (!cur) return m;
        return new Map(m).set(key, {
          ...cur,
          pending: false,
          hasFirstTurn: true,
        });
      });
    }).finally(() => {
      if (cancelControllersRef.current.get(key) === controller) {
        cancelControllersRef.current.delete(key);
      }
    });
  }

  function sendMessage(key: string, text: string, opts: { skipAutoCouncil?: boolean } = {}) {
    const session = chats.get(key);
    if (!session || session.pending) return;
    // Auto-council detection — only fires when council is OFF for this
    // session and the call wasn't a re-entry from the classifier itself.
    // Three modes (see src/auto-council.ts):
    //   "auto"    — classify the prompt; on YES route to runCouncil and
    //               skip the single-chat path. On NO, fall through to
    //               this same function with skipAutoCouncil=true so we
    //               don't classify twice.
    //   "suggest" — fire classifier in parallel with the chat call; on
    //               YES, append a passive council-suggestion bubble the
    //               user can click to re-run. Chat completes normally.
    //   "off"     — skip the classifier entirely.
    const autoMode = opts.skipAutoCouncil
      ? "off"
      : readAutoCouncil(session.hostDomain.name);
    const councilAlreadyOn = councilModeFor(key);
    if (!councilAlreadyOn && autoMode === "auto") {
      // Block: fire classifier first, then either runCouncil OR
      // re-enter sendMessage with the skip flag so the chat path
      // proceeds without a second classifier call.
      void (async () => {
        const worthy = await classifyAsCouncilWorthy({
          cwd: session.hostDomain.path,
          cli: session.cli,
          userPrompt: text,
        });
        if (worthy) runCouncil(key, text);
        else sendMessage(key, text, { skipAutoCouncil: true });
      })().catch(() => {
        // Classifier failed: don't strand the user. Fall through to chat.
        sendMessage(key, text, { skipAutoCouncil: true });
      });
      return;
    }
    // Capture-at-send for response-shaping metadata. The user can cycle
    // framework/lens chips between turns, so the badge under each bubble
    // (and the vault decision log) MUST reflect what was active when THIS
    // turn fired, not the current global state. Resolve to display labels
    // here so downstream code (bubble badge, sqlite sidecar, daily log)
    // never has to look the id up again.
    const fwId = readResponseFramework(session.hostDomain.name);
    const lensSel = readResponseLens(session.hostDomain.name);
    const fwLabel = getFramework(fwId)?.label;
    // Single-chat path: a LensSelection of "all" doesn't fan out (lens=all
    // is council-only by design), so for a single chat we only attach a
    // lens label when a concrete lens id was set. Anything else = no lens.
    const lensLabel =
      lensSel && lensSel !== "all" ? getLens(lensSel)?.label : undefined;
    const userMsg = { role: "user" as const, content: text, ts: Date.now() };
    persistMessage({
      domain: session.hostDomain.name,
      session_id: session.sessionId,
      role: "user",
      content: text,
      ts: userMsg.ts,
      cli: session.cli.kind,
      model: session.model,
      framework: fwLabel,
      lens: lensLabel,
    });
    // SUGGEST mode: fire the classifier in parallel with the chat call.
    // On YES, drop a passive council-suggestion bubble after the reply
    // lands. We don't block the chat path — the suggestion is
    // out-of-band. On NO or classifier failure, nothing visible
    // happens (silent fail-safe).
    if (!councilAlreadyOn && autoMode === "suggest") {
      void (async () => {
        const worthy = await classifyAsCouncilWorthy({
          cwd: session.hostDomain.path,
          cli: session.cli,
          userPrompt: text,
        });
        if (!worthy) return;
        const sTs = Date.now();
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          return new Map(m).set(key, {
            ...cur,
            messages: [
              ...cur.messages,
              {
                role: "assistant" as const,
                content: text, // bubble carries the original prompt for re-run on click
                ts: sTs,
                kind: "council-suggestion" as const,
              },
            ],
          });
        });
      })().catch(() => {});
    }
    // If the user pre-selected skills in the Skills tab for this domain,
    // prepend a small <selected_skills> block so the LLM treats them as
    // explicit context. Only applies on the first turn — once the chat
    // is going the model already has it. Empty set = no prefix.
    const selectedSkillsBlock = (() => {
      if (selectedSkillIds.size === 0) return "";
      const hostSkills = session.hostDomain.skills.filter((s) => selectedSkillIds.has(s.id));
      if (hostSkills.length === 0) return "";
      return [
        `<selected_skills>`,
        `The user pre-selected these ${session.hostDomain.name} skills as context for this conversation:`,
        ...hostSkills.map((s) => `  - ${s.id}: ${s.title}`),
        `Read their definitions under ${session.hostDomain.path}/skills/ and apply where relevant.`,
        `</selected_skills>\n\n`,
      ].join("\n");
    })();
    const promptForCli = selectedSkillsBlock + makeSeedPrompt(
      { ...session, messages: [...session.messages, userMsg] },
      text,
    );
    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      return new Map(m).set(key, {
        ...cur,
        messages: [...cur.messages, userMsg],
        pending: true,
      });
    });
    const controller = new AbortController();
    cancelControllersRef.current.set(key, controller);
    // Drop a "streaming" placeholder bubble that we mutate on each chunk.
    // Identified by its ts so we never confuse it with another in-flight
    // turn — every appendStream call updates the SAME ts.
    const streamTs = Date.now();
    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      return new Map(m).set(key, {
        ...cur,
        messages: [
          ...cur.messages,
          { role: "assistant", content: "", ts: streamTs, kind: "streaming" },
        ],
      });
    });
    const appendStream = (delta: string) => {
      setChats((m) => {
        const cur = m.get(key);
        if (!cur) return m;
        const messages = cur.messages.map((msg) =>
          msg.ts === streamTs && msg.kind === "streaming"
            ? { ...msg, content: msg.content + delta }
            : msg,
        );
        return new Map(m).set(key, { ...cur, messages });
      });
    };
    runChatTurn({
      prompt: promptForCli,
      cwd: session.hostDomain.path,
      cli: session.cli,
      model: session.model,
      isFirst: !session.hasFirstTurn,
      signal: controller.signal,
      onChunk: appendStream,
    })
      .then((response) => {
        const ts = Date.now();
        persistMessage({
          domain: session.hostDomain.name,
          session_id: session.sessionId,
          role: "assistant",
          content: response,
          ts,
          cli: session.cli.kind,
          model: session.model,
          framework: fwLabel,
          lens: lensLabel,
        });
        // Self-curating vault: append a one-paragraph snapshot of this turn
        // to <domain>/_log/YYYY-MM-DD.md so the vault remembers what was
        // discussed without the user having to take notes.
        writeTurnSummary({
          domainPath: session.hostDomain.path,
          userPrompt: text,
          assistantReply: response,
          cliLabel: session.model ? `${session.cli.label}·${session.model}` : session.cli.label,
          ts,
          kind: "chat",
          framework: fwLabel,
          lens: lensLabel,
          // Full cockpit-state snapshot on the single-chat path.
          model: session.model || session.cli.kind,
          webAccess: readWebAccess(),
          serendipity: readSerendipity(session.hostDomain.name),
          councilOn: councilModeFor(key),
          raw: readCheckpoint(session.hostDomain.name),
        });
        // Curated journal: distill into journal/decisions.md +
        // journal/facts.md. Uses the same CLI that answered the turn
        // (no separate "chair" in single-chat mode). Fire-and-forget.
        void distillTurnToJournal({
          domainPath: session.hostDomain.path,
          userPrompt: text,
          assistantReply: response,
          ts,
          cli: session.cli,
          model: session.model,
        }).catch(() => {});
        // Serendipity (Option B): when enabled, fire a SECOND call to
        // the same CLI asking for one non-obvious adjacent angle. The
        // result lands as its own dim bubble below the main reply.
        // Fire-and-forget — if the call fails or returns empty, the
        // bubble simply never appears.
        if (readSerendipity(session.hostDomain.name)) {
          void (async () => {
            const angle = await runSerendipityPass({
              cwd: session.hostDomain.path,
              cli: session.cli,
              model: session.model,
              userPrompt: text,
              assistantReply: response,
            });
            if (!angle) return;
            const sTs = Date.now();
            setChats((m) => {
              const cur = m.get(key);
              if (!cur) return m;
              return new Map(m).set(key, {
                ...cur,
                messages: [
                  ...cur.messages,
                  {
                    role: "assistant" as const,
                    content: angle,
                    ts: sTs,
                    kind: "serendipity" as const,
                    cli: session.cli.kind,
                    model: session.model,
                  },
                ],
              });
            });
          })().catch(() => {});
        }
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          // Replace the live streaming placeholder with the canonical
          // assistant message — same ts so the bubble doesn't reorder.
          // Attach the framework + lens that were active at SEND TIME so
          // the per-bubble badge stays loyal to the moment, not the
          // (possibly-cycled) current global state.
          const messages = cur.messages.map((msg) =>
            msg.ts === streamTs && msg.kind === "streaming"
              ? {
                  role: "assistant" as const,
                  content: response,
                  ts,
                  cli: session.cli.kind,
                  model: session.model,
                  framework: fwLabel,
                  lens: lensLabel,
                }
              : msg,
          );
          // If for some reason the placeholder wasn't found (rare race),
          // fall back to append so we never silently drop the reply.
          const hadPlaceholder = messages.some((msg) => msg.ts === ts);
          return new Map(m).set(key, {
            ...cur,
            messages: hadPlaceholder
              ? messages
              : [
                  ...messages,
                  {
                    role: "assistant",
                    content: response,
                    ts,
                    cli: session.cli.kind,
                    model: session.model,
                    framework: fwLabel,
                    lens: lensLabel,
                  },
                ],
            pending: false,
            hasFirstTurn: true,
            usage: {
              calls: cur.usage.calls + 1,
              promptChars: cur.usage.promptChars + promptForCli.length,
              replyChars: cur.usage.replyChars + response.length,
            },
          });
        });
      })
      .catch((err: Error) => {
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          // Drop the streaming placeholder and append an error bubble.
          const cleaned = cur.messages.filter(
            (msg) => !(msg.ts === streamTs && msg.kind === "streaming"),
          );
          return new Map(m).set(key, {
            ...cur,
            messages: [
              ...cleaned,
              { role: "assistant", content: `(error: ${err.message})`, ts: Date.now() },
            ],
            pending: false,
            hasFirstTurn: true,
          });
        });
      })
      .finally(() => {
        // Only forget the controller if it's still the same one — a new turn
        // could have replaced it (shouldn't happen since pending blocks new
        // sends, but be defensive).
        if (cancelControllersRef.current.get(key) === controller) {
          cancelControllersRef.current.delete(key);
        }
      });
  }

  // Abort the in-flight turn for a session. The CLI child process gets
  // SIGTERM; the runChatTurn promise resolves with "(cancelled)" and the
  // .then handler writes that into the transcript. Returns true if a turn
  // was actually aborted, so callers can fall through to other Escape
  // behaviors when nothing was pending.
  function cancelChat(key: string): boolean {
    const ctl = cancelControllersRef.current.get(key);
    if (!ctl) return false;
    cancelControllersRef.current.delete(key);
    try {
      ctl.abort();
    } catch {}
    return true;
  }

  // Append a system-note message to the chat session — used by async
  // connector flows (OAuth, test connection) to surface their result
  // when it lands, since the kick-off note returned synchronously isn't
  // enough.
  function appendSystemNote(key: string, content: string): void {
    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      return new Map(m).set(key, {
        ...cur,
        messages: [...cur.messages, { role: "system", content, ts: Date.now() }],
      });
    });
  }

  function startConnectorOAuth(key: string, id: string, list: AppSkill[]): string {
    const app = list.find((a) => a.id === id);
    if (!app) return `no connector with id "${id}". try /connectors to list.`;
    if (!app.oauth) {
      return `connector "${id}" has no oauth block in its manifest. only OAuth-style connectors can run this flow.`;
    }
    // Fire async — surface the kick-off note synchronously, then queue
    // the result.
    void (async () => {
      try {
        const { runOAuthFlow } = await import("./oauth-flow.ts");
        const result = await runOAuthFlow(
          id,
          app.oauth as Parameters<typeof runOAuthFlow>[1],
          { logger: (line) => appendSystemNote(key, `[oauth] ${line}`) },
        );
        appendSystemNote(key, result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
      } catch (err) {
        appendSystemNote(key, `oauth flow crashed: ${(err as Error).message}`);
      }
    })();
    return `starting OAuth flow for ${app.title}…\n\nyour browser should open to the consent screen. once you approve, the callback lands at http://127.0.0.1:${(app.oauth as { redirect_port?: number }).redirect_port ?? "<port>"} and the refresh token is saved to ~/.prevail/connectors/${id}/auth/refresh.token.\n\nflow times out after 5 minutes.`;
  }

  function startConnectorTest(key: string, id: string, list: AppSkill[]): void {
    const app = list.find((a) => a.id === id);
    if (!app) {
      appendSystemNote(key, `no connector with id "${id}". try /connectors.`);
      return;
    }
    void (async () => {
      try {
        const { probeConnector } = await import("./connector-probe.ts");
        const r = await probeConnector(app, (app.authCheck as Parameters<typeof probeConnector>[1]) ?? null);
        const lines = [
          `${app.title}: ${r.ok ? "✓ " : "✗ "}${r.status}`,
          `  ${r.message}`,
        ];
        if (r.fixHint) lines.push(`  fix: ${r.fixHint}`);
        if (r.missing && r.missing.length > 0) lines.push(`  missing: ${r.missing.join(", ")}`);
        appendSystemNote(key, lines.join("\n"));
      } catch (err) {
        appendSystemNote(key, `probe crashed: ${(err as Error).message}`);
      }
    })();
  }

  function doEdit() {
    const filename = VIEW_FILE[view];
    if (!filename) {
      setMessage("the skills tab isn't editable — switch to state / prompts / quickstart");
      return;
    }
    if (focus === "apps") {
      if (!app) return;
      if (app.community) {
        setMessage("community apps aren't editable from the cockpit");
        return;
      }
      setMode("edit");
      return;
    }
    if (!domain) return;
    setMode("edit");
  }

  function exitEditor(saved: boolean) {
    setMode("idle");
    if (saved) {
      setDomains(scanVault(vaultPath));
      setApps([...scanApps(vaultPath), ...scanCommunityApps()]);
      setMessage("✓ saved");
    }
  }

  function doQuit() {
    renderer?.destroy?.();
    process.exit(0);
  }

  const activeSession = activeKey ? chats.get(activeKey) ?? null : null;
  const inChat = mode === "chat" && activeSession;
  const editTarget =
    mode === "edit"
      ? focus === "apps" && app && !app.community
        ? { path: app.path, name: app.id }
        : focus === "domains" && domain
          ? { path: domain.path, name: domain.name }
          : null
      : null;
  const inEdit = mode === "edit" && editTarget !== null;
  const editFilename = inEdit ? VIEW_FILE[view] : null;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <Branding
        domainCount={stats.totalDomains}
        totalLoops={stats.totalLoops}
        appCount={stats.totalApps}
        vaultLabel={vaultLabel}
        cliLabels={clis.map((c) => c.label)}
        activeChats={chatCounts.active}
        pendingChats={chatCounts.pending}
        globalCouncilOn={readGlobalCouncilDefault()}
        onToggleGlobalCouncil={() => {
          setGlobalCouncilDefault(!readGlobalCouncilDefault());
          bumpFrameworkTick();
        }}
        onOpenCouncilConfig={() => setCouncilConfigOpen(true)}
        onOpenTools={() => setToolsOpen(true)}
        frameworkTick={frameworkTick}
        onCycleFramework={() => {
          const cur = readResponseFramework();
          const ids = [null, "bluf", "win", "scqa", "sbar", "ooda", "proscons", "steelman"] as const;
          const idx = ids.indexOf(cur as typeof ids[number]);
          const next = ids[(idx + 1) % ids.length];
          setResponseFramework(next as Parameters<typeof setResponseFramework>[0]);
          bumpFrameworkTick();
        }}
        onCycleLens={() => {
          // Mirror the framework cycle but for the global lens default.
          // Per-domain overrides still win at the workspace bar / chat
          // status line — this only sets the fallback.
          const cur = readResponseLens();
          const order = [
            null, "first-principles", "outsider", "contrarian",
            "expansionist", "executor", "alien", "mom", "dad", "all",
          ] as const;
          const idx = order.findIndex((s) => s === cur);
          const next = order[(idx + 1) % order.length];
          setResponseLens(next as Parameters<typeof setResponseLens>[0]);
          bumpFrameworkTick();
        }}
        onCycleWeb={() => {
          // Web access is a global allow/deny. The WorkspaceConfigBar
          // chip writes to the same key, so both surfaces stay in sync.
          setWebAccess(readWebAccess() === "allow" ? "deny" : "allow");
          bumpFrameworkTick();
        }}
        cliHealthSummary={clis.map((c) => {
          const h = cliHealth.get(c.kind);
          return {
            kind: c.kind,
            label: c.label,
            ok: h === null || h === undefined ? null : h.ok,
            message: h?.message,
          };
        })}
      />
      <box flexDirection="row" flexGrow={1}>
        <Sidebar
          domains={domains}
          apps={apps}
          showApps={SHOW_APPS}
          domainIdx={domainIdx}
          appIdx={appIdx}
          focus={focus}
          vaultLabel={vaultLabel}
          domainStatus={domainStatus}
          appStatus={appStatus}
          tick={tick}
          onPickDomain={(i) => {
            setDomainIdx(i);
            setFocus("domains");
            embeddedInputActiveRef.current = false;
            // Domains default to chat — the FULL ChatPane experience
            // (council mode, up-arrow history, streaming, escape, slash
            // commands, /distill, /council, etc.). Escape exits chat
            // back to the workspace's other tabs (state/skills/etc).
            const d = domains[i];
            if (d) openChatForDomain(d);
          }}
          onPickApp={(i) => {
            setAppIdx(i);
            setFocus("apps");
            embeddedInputActiveRef.current = false;
            // Mirror domains exactly. Apps land in chat — same
            // ChatPane, same menu bar, same flow. Press Escape (or
            // click any non-chat tab) to see the connector workspace
            // (Auth / Sync / Skills / Data). Consistent.
            const a = apps[i];
            if (a) openChatForApp(a);
          }}
          onNewDomain={() => {
            setFocus("domains");
            setMode("new-domain");
          }}
          onNewApp={() => {
            setFocus("apps");
            setMode("new-app");
          }}
        />
        <box flexDirection="column" flexGrow={1}>
          {(() => {
            const tabBar =
              ((focus === "domains" && domain) || (focus === "apps" && app)) && !inEdit ? (
                <TabStrip
                  activeView={view}
                  inChat={Boolean(inChat)}
                  onPickView={(i) => {
                    setFocus(focus);
                    setViewIdx(i);
                    if (mode === "chat") setMode("idle");
                  }}
                  onPickChat={() => {
                    // Open the full ChatPane with council mode, up-arrow
                    // history, streaming, escape, slash commands — all
                    // of it. Escape returns to the workspace.
                    if (focus === "apps" && app) openChatForApp(app);
                    else if (domain) openChatForDomain(domain);
                  }}
                  onEdit={() => {
                    if (mode === "chat") setMode("idle");
                    doEdit();
                  }}
                  cli={(() => {
                    // CLI chips + council toggle + ⚙ are now ALWAYS on
                    // the tab strip — same controls regardless of mode
                    // (in chat / on state / on skills / etc). When
                    // there's an active chat session, the chips drive
                    // that session. When there isn't, clicking a CLI
                    // chip opens chat with that engine, council toggle
                    // flips the global default, ⚙ opens the config
                    // panel. One consistent menu bar across modes.
                    if (inChat && activeSession) {
                      return {
                        clis,
                        currentCli: activeSession.cli.kind,
                        model: activeSession.model,
                        councilMode: councilModeFor(activeSession.key),
                        cliHealth,
                        onSwitchCli: (k) =>
                          handleChatCommand(activeSession.key, {
                            kind: "switch-cli",
                            cli: k,
                            model: undefined,
                          }),
                        onPickModel: (mdl) =>
                          handleChatCommand(activeSession.key, {
                            kind: "switch-model",
                            model: mdl,
                          }),
                        onToggleCouncilMode: () =>
                          toggleCouncilModeFor(activeSession.key),
                        onOpenCouncilConfig: () => setCouncilConfigOpen(true),
                      };
                    }
                    // Not in chat — same chips, but they open chat /
                    // flip global default when clicked.
                    const defaultCli =
                      (clis.find((c) => c.kind === "claude") ?? clis[0])?.kind ?? "claude";
                    return {
                      clis,
                      currentCli: defaultCli,
                      model: "",
                      councilMode: readGlobalCouncilDefault(),
                      cliHealth,
                      onSwitchCli: (k) => {
                        // Open chat with the picked CLI for the
                        // currently-focused domain/app.
                        const target = focus === "apps" ? app : domain;
                        if (!target) return;
                        const cliObj = clis.find((c) => c.kind === k);
                        if (!cliObj) return;
                        if (focus === "apps" && app) openChatForApp(app);
                        else if (domain) openChatForDomain(domain);
                        // After opening, the session will already be in
                        // the requested CLI iff that's the default. If
                        // not, the user can re-click in the now-open
                        // chat. Keeps the no-session-mode behavior
                        // light.
                      },
                      onPickModel: () => {
                        /* no-op without an active session */
                      },
                      onToggleCouncilMode: () => {
                        setGlobalCouncilDefault(!readGlobalCouncilDefault());
                        bumpFrameworkTick();
                      },
                      onOpenCouncilConfig: () => setCouncilConfigOpen(true),
                    };
                  })()}
                />
              ) : undefined;

            // ConfigBar (council + framework + lens + vault + edit) — sits
            // at the BOTTOM of the content area in BOTH chat and workspace
            // mode. In chat mode that's right above the input box (where
            // the user is typing). In workspace mode it's at the bottom of
            // the tab content. Identical row, identical position, no top
            // duplication with the TabStrip. Domain context drives
            // domainKey so per-domain overrides resolve correctly.
            const isEditableView =
              !inChat && (view === "state" || view === "quickstart" || view === "prompts");
            const configBarTarget = inChat
              ? activeSession?.hostDomain
              : focus === "domains"
                ? domain
                : null;
            const configBar = configBarTarget && !inEdit ? (
              <WorkspaceConfigBar
                vaultPath={configBarTarget.path}
                councilOn={
                  inChat && activeSession
                    ? councilModeFor(activeSession.key)
                    : domain
                      ? councilModeFor(domain.name)
                      : false
                }
                onToggleCouncil={() => {
                  if (inChat && activeSession) toggleCouncilModeFor(activeSession.key);
                  else if (domain) toggleCouncilModeFor(domain.name);
                }}
                frameworkTick={frameworkTick}
                onFrameworkChange={bumpFrameworkTick}
                domainKey={configBarTarget.name}
                onEdit={isEditableView ? () => doEdit() : undefined}
              />
            ) : undefined;

            if (toolsOpen) {
              return <ToolsPanel onClose={() => setToolsOpen(false)} />;
            }
            if (councilConfigOpen) {
              return (
                <CouncilConfigPanel
                  availableClis={clis}
                  councilMode={councilModeFor(activeKey)}
                  onToggleCouncilMode={() => {
                    if (activeKey) toggleCouncilModeFor(activeKey);
                  }}
                  onClose={() => setCouncilConfigOpen(false)}
                />
              );
            }
            if (inChat) {
              return (
                <ChatPane
                  session={activeSession!}
                  availableClis={clis}
                  tick={tick}
                  councilMode={councilModeFor(activeSession!.key)}
                  onToggleCouncilMode={() =>
                    toggleCouncilModeFor(activeSession!.key)
                  }
                  onSend={sendMessage}
                  onCommand={handleChatCommand}
                  onExit={exitChat}
                  onCancel={cancelChat}
                  onAutocompleteChange={setAutocompleteOpen}
                  topBar={tabBar}
                  bottomBar={configBar}
                  selectedSkills={
                    // Only relevant for domain chats; map ids → titles
                    // so the indicator can render names, not just ids.
                    focus === "domains" && domain
                      ? domain.skills.filter((s) => selectedSkillIds.has(s.id))
                      : []
                  }
                />
              );
            }
            if (inEdit && editFilename && editTarget) {
              return (
                <EditorPane
                  target={editTarget}
                  filename={editFilename}
                  onExit={exitEditor}
                />
              );
            }
            if (focus === "apps" && app) {
              return (
                <AppDetail
                  app={app}
                  view={view}
                  skillIdx={skillIdx}
                  onPickSkill={(i) => {
                    setSkillIdx(i);
                    const sk = app.skills[i];
                    if (sk) openChatForSkill(sk);
                  }}
                  setEmbeddedInputActive={setEmbeddedInputActive}
                  councilOn={councilModeFor(`app:${app.id}`)}
                  onToggleCouncil={() => toggleCouncilModeFor(`app:${app.id}`)}
                  frameworkTick={frameworkTick}
                  onFrameworkChange={bumpFrameworkTick}
                  onOpenChat={() => openChatForApp(app)}
                />
              );
            }
            return (
              <DomainDetail
                domain={domain}
                view={view}
                skillIdx={skillIdx}
                apps={apps}
                onPickSkill={(i) => {
                  // Just move the keyboard cursor. Mouse-click toggling
                  // selection is handled by onToggleSkill — clicking a
                  // skill does NOT auto-open chat anymore. User
                  // selects N skills, then clicks the chat tab when
                  // ready.
                  setSkillIdx(i);
                }}
                topBar={tabBar}
                bottomBar={configBar}
                setEmbeddedInputActive={setEmbeddedInputActive}
                showChat={false}
                councilOn={domain ? councilModeFor(domain.name) : false}
                onToggleCouncil={() => domain && toggleCouncilModeFor(domain.name)}
                frameworkTick={frameworkTick}
                onFrameworkChange={bumpFrameworkTick}
                selectedSkillIds={selectedSkillIds}
                onToggleSkill={toggleSkillSelection}
                onOpenChat={() => domain && openChatForDomain(domain)}
              />
            );
          })()}
        </box>
      </box>
      <CommandBar
        mode={mode}
        prompt={mode === "new-domain" ? "new domain ›" : mode === "new-app" ? "new app ›" : "chat with:"}
        message={message}
        cliOptions={clis.map((c) => c.label)}
        cliIndex={cliIdx}
        onSubmit={handleSubmit}
        onCancel={() => {
          setMode("idle");
          setPendingOpen(null);
        }}
        onAction={(a) => {
          if (a === "new") setMode(focus === "apps" ? "new-app" : "new-domain");
          else if (a === "chat") {
            if (focus === "apps" && app) openChatForApp(app);
            else if (domain) openChatForDomain(domain);
          } else if (a === "edit") doEdit();
          else if (a === "refresh") doRefresh();
          else if (a === "quit") doQuit();
        }}
      />
    </box>
  );
}

// /telegram — surface daemon status, allowlist, and setup hints inside the
// TUI so users don't have to drop to a shell to configure it. Mutating ops
// (setup, add, remove) still write to ~/.prevail/telegram.json the same way
// the CLI subcommand does — same source of truth, two surfaces.
function handleTelegramCommand(sub: string, arg: string): string {
  // Lazy require so we don't pay the import cost on every slash command.
  const tg = require("./telegram-config.ts") as typeof import("./telegram-config.ts");
  const cur = tg.readTelegramConfig();
  if (sub === "status" || sub === "show") {
    if (!cur) {
      return [
        "telegram: not configured",
        "",
        "to set up:",
        "  /telegram setup <bot-token>",
        "",
        "get a token by messaging @BotFather on Telegram and running /newbot.",
        "after setup, message your bot once, then run /telegram add <chat_id>",
        "with the chat_id from the daemon log.",
        "",
        "to launch the bot: /telegram launch  (prints the shell command to run)",
      ].join("\n");
    }
    const tokenPreview = cur.botToken ? `${cur.botToken.slice(0, 6)}…${cur.botToken.slice(-4)}` : "(missing)";
    return [
      `telegram: configured`,
      `  token:           ${tokenPreview}`,
      `  allow-list:      ${cur.allowList.length === 0 ? "(empty — bot refuses everyone)" : cur.allowList.join(", ")}`,
      `  default cli:     ${cur.defaultCli ?? "(auto)"}`,
      `  default domain:  ${cur.defaultDomain ?? "(first in vault)"}`,
      `  council default: ${cur.councilByDefault ? "on" : "off"}`,
      "",
      "/telegram setup <token>      replace the bot token",
      "/telegram add <chat_id>      allow-list a chat ID",
      "/telegram remove <chat_id>   un-allow-list a chat ID",
      "/telegram launch             print the daemon command to run",
    ].join("\n");
  }
  if (sub === "setup") {
    if (!arg) return "usage: /telegram setup <bot-token>  (token from @BotFather)";
    tg.setTelegramToken(arg);
    return `✓ token saved to ~/.prevail/telegram.json (chmod 0600).\nnext: message your bot once, then /telegram add <chat_id>.`;
  }
  if (sub === "add" || sub === "add-user") {
    const id = parseInt(arg, 10);
    if (!Number.isFinite(id)) return "usage: /telegram add <chat_id>";
    try {
      const added = tg.addAllowedChatId(id);
      return added ? `✓ chat_id ${id} allow-listed` : `(${id} was already on the list)`;
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (sub === "remove" || sub === "rm" || sub === "remove-user") {
    const id = parseInt(arg, 10);
    if (!Number.isFinite(id)) return "usage: /telegram remove <chat_id>";
    const removed = tg.removeAllowedChatId(id);
    return removed ? `✓ removed ${id}` : `(${id} wasn't on the list)`;
  }
  if (sub === "launch" || sub === "start" || sub === "run") {
    return [
      "the daemon runs as a separate long-running process so it doesn't",
      "block the TUI. open a new terminal and run:",
      "",
      "  prevail daemon --telegram",
      "",
      "it will poll Telegram, dispatch messages through the same engines",
      "as this TUI, and fire any due briefings.",
    ].join("\n");
  }
  return `unknown /telegram subcommand: ${sub}\ntry /telegram status`;
}

// /briefing — list, add, run, remove scheduled domain briefings without
// dropping to a shell. Same .briefings.json storage as `prevail briefing`.
function handleBriefingCommand(sub: string, arg: string, vaultPath: string, _apps: AppSkill[], domains: Domain[]): string {
  const br = require("./briefings.ts") as typeof import("./briefings.ts");
  const sched = require("./schedule.ts") as typeof import("./schedule.ts");
  if (sub === "list" || sub === "ls" || sub === "show") {
    const list = br.loadBriefings(vaultPath);
    if (list.length === 0) {
      return [
        "no briefings yet",
        "",
        'add one with: /briefing add "<cron>" <domain> "<prompt>" [council] [telegram]',
        '  e.g. /briefing add "0 7 * * *" wealth "what is new this week?" council both',
        "",
        "cron format: 5 fields (min hr day-of-month month day-of-week). use * for any.",
      ].join("\n");
    }
    return [
      `${list.length} briefing${list.length === 1 ? "" : "s"}:`,
      "",
      ...list.map((b) => {
        const next = sched.nextRunWithin(b.cron);
        const nextLabel = next ? new Date(next).toLocaleString() : "(none within 7d)";
        return [
          `  ${b.enabled ? "✓" : "✗"} ${b.id}  ·  ${b.name}`,
          `      cron:    ${b.cron}  (${sched.describeCron(b.cron)})`,
          `      domain:  ${b.domain}  ·  mode: ${b.mode}  ·  deliver: ${b.deliver}`,
          `      prompt:  ${b.prompt.slice(0, 120)}${b.prompt.length > 120 ? "…" : ""}`,
          `      next:    ${nextLabel}`,
        ].join("\n");
      }),
    ].join("\n");
  }
  if (sub === "add") {
    // /briefing add "<cron>" <domain> "<prompt>" [mode] [deliver]
    // Parse quoted strings + bare tokens. Loose parser — accepts both
    // quoted and bare cron/prompt depending on user habit.
    const tokens = tokenizeBriefingAdd(arg);
    if (tokens.length < 3) {
      return 'usage: /briefing add "<cron>" <domain> "<prompt>" [single|council] [log|telegram|both]';
    }
    const [cron, domainName, prompt, modeRaw, deliverRaw] = tokens;
    if (!sched.isValidCron(cron!)) return `invalid cron: "${cron}" — needs 5 fields`;
    if (!domains.find((d) => d.name.toLowerCase() === domainName!.toLowerCase())) {
      return `unknown domain "${domainName}". /domains in cockpit to see options.`;
    }
    const mode = modeRaw === "council" ? "council" : "single";
    const deliver = deliverRaw === "telegram" || deliverRaw === "both" ? deliverRaw : "log";
    const list = br.loadBriefings(vaultPath);
    const entry = {
      id: br.makeBriefingId(),
      name: `${domainName} briefing`,
      cron: cron!,
      domain: domainName!,
      prompt: prompt!,
      mode: mode as "single" | "council",
      deliver: deliver as "log" | "telegram" | "both",
      enabled: true,
      last_run: null,
      created_at: Date.now(),
    };
    list.push(entry);
    br.saveBriefings(vaultPath, list);
    return `✓ added ${entry.id}\n  cron:    ${cron}  (${sched.describeCron(cron!)})\n  domain:  ${domainName}\n  mode:    ${mode}\n  deliver: ${deliver}` +
      (deliver !== "log"
        ? "\n\n! telegram delivery requires the daemon: prevail daemon --telegram"
        : "");
  }
  if (sub === "remove" || sub === "rm") {
    if (!arg) return "usage: /briefing remove <id>";
    const list = br.loadBriefings(vaultPath);
    const after = list.filter((b) => b.id !== arg);
    if (after.length === list.length) return `no briefing with id ${arg}`;
    br.saveBriefings(vaultPath, after);
    return `✓ removed ${arg}`;
  }
  if (sub === "run") {
    if (!arg) return "usage: /briefing run <id>  (fires it now, log delivery only)";
    return `running briefings inside the TUI would block. use the cli for now:\n\n  prevail briefing run ${arg}\n\nor wait for the daemon to fire it on cron.`;
  }
  return `unknown /briefing subcommand: ${sub}\ntry /briefing list`;
}

// Mini tokenizer for /briefing add — supports double-quoted strings so a
// cron expression or a multi-word prompt stays intact.
function tokenizeBriefingAdd(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch!)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// /connectors — quick-glance auth status for every app. Same data the app
// detail view shows, just flattened so users can audit "what's set up"
// without clicking each tile.
function renderConnectorOverview(apps: AppSkill[]): string {
  if (apps.length === 0) return "no apps registered. drop manifests into ~/.prevail/apps/<id>/";
  const integrationLabel: Record<string, string> = {
    api: "API",
    oauth: "OAuth",
    browser: "Browser",
    mcp: "MCP",
    manual: "manual",
  };
  const lines: string[] = [
    `${apps.length} apps · connection-status snapshot`,
    "",
    "  STATUS  TYPE      ID                 LAST SYNC",
    "  ──────  ────────  ─────────────────  ──────────",
  ];
  for (const a of apps) {
    const glyph =
      a.status === "connected" ? "✓ ok  "
      : a.status === "expired" ? "! exp "
      : a.status === "error"   ? "✗ err "
      : "○ off ";
    const type = (integrationLabel[a.integration ?? "manual"] ?? "manual").padEnd(8);
    const id = a.id.padEnd(17).slice(0, 17);
    const last = a.lastSuccessTs ? new Date(a.lastSuccessTs).toLocaleDateString() : "(never)";
    lines.push(`  ${glyph} ${type}  ${id}  ${last}`);
  }
  lines.push("");
  lines.push("click an app in the sidebar to see auth method + skills + 'Test connection'.");
  return lines.join("\n");
}

// /calibration — surface pending retrospectives + the running scoreboard
// for the active domain. All reads/writes hit _log/*.md frontmatter and
// _calibration.md — no DB.
function handleCalibrationCommand(sub: string, arg: string, domainPath: string): string {
  const cal = require("./calibration.ts") as typeof import("./calibration.ts");
  if (sub === "status" || sub === "show") {
    const stats = cal.computeCalibration(domainPath);
    cal.writeCalibrationReport(domainPath);
    if (stats.total === 0 && stats.pending === 0) {
      return [
        `no calibration data yet for this domain.`,
        ``,
        `to start: type /gut <your take> before /council, and your gut + council verdict will both be logged.`,
        `90 days later, /calibration pending will surface them so you can record the actual outcome.`,
      ].join("\n");
    }
    return [
      `Calibration · ${domainPath.split("/").pop()}`,
      ``,
      `decisions with outcome:  ${stats.total}`,
      `gut agreed with council: ${stats.agreed} / ${stats.total}`,
      `right when agreed:       ${stats.rightOnAgreement} / ${stats.agreed || 0}`,
      `right when disagreed:    ${stats.rightOnDisagreement} / ${Math.max(0, stats.total - stats.agreed)}`,
      `pending retrospectives:  ${stats.pending}`,
      ``,
      `full scoreboard: ${domainPath.split("/").pop()}/_calibration.md`,
    ].join("\n");
  }
  if (sub === "pending") {
    const pending = cal.listPendingRetrospectives(domainPath);
    if (pending.length === 0) return `no retrospectives owed for this domain.`;
    const lines = [`${pending.length} retrospective${pending.length === 1 ? "" : "s"} owed:`, ``];
    for (const p of pending.slice(0, 10)) {
      lines.push(`  ${p.id}  ·  due ${p.retroDue}`);
      if (p.gut) lines.push(`    gut:     ${p.gut.slice(0, 100)}`);
      if (p.verdict) lines.push(`    verdict: ${p.verdict.slice(0, 100)}`);
    }
    lines.push(``);
    lines.push(`record an outcome with: /calibration outcome <id> <right|wrong|partial|freeform>`);
    return lines.join("\n");
  }
  if (sub === "outcome") {
    const parts = arg.split(/\s+/);
    const id = parts[0] ?? "";
    const outcome = parts.slice(1).join(" ").trim();
    if (!id || !outcome) return `usage: /calibration outcome <id> <right|wrong|partial|freeform>`;
    const ok = cal.recordOutcome(domainPath, id, outcome);
    if (!ok) return `no log entry with id ${id} in this domain`;
    cal.writeCalibrationReport(domainPath);
    return `✓ recorded outcome for ${id}. scoreboard updated.`;
  }
  return `unknown /calibration subcommand: ${sub}\ntry /calibration status`;
}

function summarize(domains: Domain[], apps: AppSkill[]) {
  let totalLoops = 0;
  for (const d of domains) totalLoops += d.openLoopCount;
  return {
    totalDomains: domains.length,
    totalLoops,
    totalApps: apps.length,
  };
}

// Build the prompt sent to each council panelist for the CURRENT turn.
//
// If there's prior conversation in this session, we pull user questions,
// council verdicts, and single-CLI assistant replies into a compact
// transcript so the panelists actually see what was said before. Without
// this, every council follow-up is treated as a fresh question and the
// models say "I don't have prior context" — which is what was happening.
//
// We deliberately skip individual panelist responses (council-response)
// because each panel turn produces 3+ of those and they bloat the prompt
// fast. Verdicts are the synthesized summary so they carry the key signal.
//
// Pending placeholders, system messages, and empty assistant turns are
// filtered out. The new user text is appended last as the live question.
function buildCouncilTurnPrompt(
  session: ChatSession,
  newUserText: string,
): string {
  const history: string[] = [];
  for (const m of session.messages) {
    if (m.kind === "council-pending" || m.kind === "council-synthesizing") continue;
    if (m.role === "system") continue;
    if (!m.content || !m.content.trim()) continue;
    if (m.role === "user") {
      // Skip the just-added userMsg — it's the question we'll surface at the
      // end. Its content matches `/council ${newUserText}`.
      const stripped = m.content.replace(/^\/council\s+/, "").trim();
      if (stripped === newUserText.trim()) continue;
      history.push(`USER: ${stripped}`);
    } else if (m.kind === "council-verdict") {
      const who = m.cli ? ` (synthesized by ${m.cli}${m.model ? ` · ${m.model}` : ""})` : "";
      history.push(`COUNCIL VERDICT${who}: ${m.content.trim()}`);
    } else if (m.role === "assistant" && !m.kind) {
      // Single-CLI chat reply from a non-council turn earlier in the session.
      history.push(`ASSISTANT: ${m.content.trim()}`);
    }
  }
  // No prior conversation — use the original seed (sets the life-domain
  // framing for the very first turn).
  if (history.length === 0) {
    return makeSeedPrompt(session, newUserText);
  }
  // Truncate any individual line to a sane length so a runaway prior reply
  // doesn't blow up the prompt. 1600 chars ≈ 400 tokens; preserves the gist.
  const trimmed = history.map((line) =>
    line.length > 1600 ? `${line.slice(0, 1600)}... [truncated]` : line,
  );
  return [
    "You are continuing a multi-CLI council conversation. Prior turns in this session:",
    "",
    trimmed.join("\n\n"),
    "",
    "---",
    "",
    `Current user question: ${newUserText}`,
  ].join("\n");
}
