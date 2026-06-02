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
import {
  ALL_CLI_KINDS,
  isCliKind,
  readCouncilConfig,
  readResponseFramework,
  readWebAccess,
  setResponseFramework,
  setCouncilClis,
  setCouncilModel,
  addCouncilModel,
  removeCouncilModel,
  setCouncilChair,
  setWebAccess,
  type CliKind,
} from "./config.ts";
import { FRAMEWORKS, getFramework, isFrameworkId } from "./framework.ts";
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
import {
  detectClis,
  formatModelBadge,
  probeCli,
  runChatTurn,
  type AvailableCli,
  type CliHealth,
} from "./cli-bridge.ts";

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
  const [clis] = useState<AvailableCli[]>(() => detectClis());
  const [cliIdx, setCliIdx] = useState(0);
  const [chats, setChats] = useState<Map<string, ChatSession>>(new Map());
  // One AbortController per in-flight session turn. When the user hits Escape
  // mid-prompt we abort the controller, which SIGTERMs the CLI child process
  // in runCapture. The .then/.catch handlers on the runChatTurn promise still
  // fire — they just write a "(cancelled)" bubble instead of the model reply.
  // Council shares one controller across all panelists + the synthesis call
  // so a single Escape kills the whole batch.
  const cancelControllersRef = useRef<Map<string, AbortController>>(new Map());
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
    for (const c of detectClis()) m.set(c.kind, null);
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
  // hook, etc) the chip flips from ⚠ to ✓ without needing an app relaunch.
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
  const councilModeFor = (key: string | null): boolean =>
    key ? councilModeMap.get(key) ?? false : false;
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

  useEffect(() => {
    if (mode === "edit" || mode === "new-domain" || mode === "new-app") return;
    if (focus === "domains" && domain) {
      autoOpenDomainChat(domain);
    } else if (focus === "apps" && app) {
      autoOpenAppChat(app);
    }
  }, [domainIdx, appIdx, focus]);

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

    // When the chat's slash-command popover is open, let the chat pane own
    // arrow/tab navigation — don't steal them for the sidebar.
    if (autocompleteOpen && (name === "up" || name === "down" || name === "tab")) {
      return;
    }

    if (mode === "chat") {
      if (name === "up") {
        if (focus === "apps") setAppIdx((s) => Math.max(0, s - 1));
        else setDomainIdx((s) => Math.max(0, s - 1));
        return;
      }
      if (name === "down") {
        if (focus === "apps") setAppIdx((s) => Math.min(apps.length - 1, s + 1));
        else setDomainIdx((s) => Math.min(domains.length - 1, s + 1));
        return;
      }
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
      setFocus((f) => (f === "domains" ? "apps" : "domains"));
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
      if (focus === "apps" && app) openChatForApp(app);
      else if (onSkillsTab && skills.length > 0) {
        const sk = skills[skillIdx];
        if (sk) openChatForSkill(sk);
      } else if (focus === "domains" && domain) openChatForDomain(domain);
    } else if (name === "r") {
      doRefresh();
    } else if (name === "n") {
      setMode("new-domain");
    } else if (name === "c") {
      if (focus === "apps" && app) openChatForApp(app);
      else if (domain) openChatForDomain(domain);
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
    if (clis.length === 1) {
      finalizeOpen(clis[0], open);
    } else {
      setCliIdx(0);
      setPendingOpen(open);
      setMode("pick-cli");
    }
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

  function runCouncil(key: string, prompt: string) {
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
    const text = prompt.trim();
    if (!text) {
      setMessage("usage: /council <your high-stakes question>");
      return;
    }
    const userTs = Date.now();
    const userMsg = {
      role: "user" as const,
      content: `/council ${text}`,
      ts: userTs,
    };
    persistMessage({
      domain: session.hostDomain.name,
      session_id: session.sessionId,
      role: "user",
      content: userMsg.content,
      ts: userTs,
      cli: "council",
      model: "",
    });
    // One ts per panelist (not per CLI) so we can have multiple panelists
    // sharing a CLI — e.g. Claude opus-4-7 AND Claude opus-4-8 — and still
    // replace the right placeholder when each lands.
    const pendingTsByIdx = panelists.map((_, i) => userTs + 100 + i);

    setChats((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      const introTs = userTs + 1;
      const panelLabel = panelists
        .map(({ cli, model }) => (model ? `${cli.label}·${model}` : cli.label))
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
      // Drop a "thinking" placeholder bubble per panelist immediately so
      // the user sees all panelists working at once instead of waiting in
      // silence for the first one to return.
      panelists.forEach(({ cli, model }, i) => {
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
    const promptForCli = buildCouncilTurnPrompt(
      { ...session, messages: [...session.messages, userMsg] },
      text,
    );
    // Shared abort controller for the whole council batch. Escape kills every
    // panelist and the synthesis call in one shot.
    const controller = new AbortController();
    cancelControllersRef.current.set(key, controller);
    // Collect successful responses in a closure so we can synthesize them
    // into a verdict after all panel members return.
    type Collected = { cli: AvailableCli; model: string; response: string; ok: boolean };
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

    const calls = panelists.map(({ cli, model: mdl }, panelistIdx) =>
      withTimeout(
        runChatTurn({
          prompt: promptForCli,
          cwd: session.hostDomain.path,
          cli,
          model: mdl,
          isFirst: true,
          bare: true,
          signal: controller.signal,
        }),
        PANELIST_TIMEOUT_MS,
        mdl ? `${cli.label}·${mdl}` : cli.label,
      )
        .then((response) => {
          const ts = Date.now();
          collected.push({ cli, model: mdl, response, ok: true });
          persistMessage({
            domain: session.hostDomain.name,
            session_id: session.sessionId,
            role: "assistant",
            content: response,
            ts,
            cli: cli.kind,
            model: mdl,
          });
          // Replace the pending placeholder for THIS panelist (by ts —
          // multiple panelists may share a CLI so kind alone isn't enough).
          const pendingTs = pendingTsByIdx[panelistIdx]!;
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
                promptChars: cur.usage.promptChars + promptForCli.length,
                replyChars: cur.usage.replyChars + response.length,
              },
            });
          });
        })
        .catch((err: Error) => {
          const ts = Date.now();
          collected.push({ cli, model: mdl, response: err.message, ok: false });
          const pendingTs = pendingTsByIdx[panelistIdx]!;
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
        }),
    );

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
        const panelBlock = good
          .map((c) => {
            const tag = c.model ? `${c.cli.label}·${c.model}` : c.cli.label;
            return `--- ${tag} ---\n${c.response.trim()}`;
          })
          .join("\n\n");
        const panelistList = good
          .map((c) => (c.model ? `${c.cli.label}·${c.model}` : c.cli.label))
          .join(", ");
        const synthPrompt =
          `You are the chair of an AI council. ${good.length} independent panelists (${panelistList}) just answered the same user question. ` +
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
          });
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

  function sendMessage(key: string, text: string) {
    const session = chats.get(key);
    if (!session || session.pending) return;
    const userMsg = { role: "user" as const, content: text, ts: Date.now() };
    persistMessage({
      domain: session.hostDomain.name,
      session_id: session.sessionId,
      role: "user",
      content: text,
      ts: userMsg.ts,
      cli: session.cli.kind,
      model: session.model,
    });
    const promptForCli = makeSeedPrompt(
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
    runChatTurn({
      prompt: promptForCli,
      cwd: session.hostDomain.path,
      cli: session.cli,
      model: session.model,
      isFirst: !session.hasFirstTurn,
      signal: controller.signal,
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
        });
        setChats((m) => {
          const cur = m.get(key);
          if (!cur) return m;
          return new Map(m).set(key, {
            ...cur,
            messages: [
              ...cur.messages,
              { role: "assistant", content: response, ts },
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
          return new Map(m).set(key, {
            ...cur,
            messages: [
              ...cur.messages,
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
      />
      <box flexDirection="row" flexGrow={1}>
        <Sidebar
          domains={domains}
          apps={apps}
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
          }}
          onPickApp={(i) => {
            setAppIdx(i);
            setFocus("apps");
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
                    if (focus === "apps" && app) openChatForApp(app);
                    else if (domain) openChatForDomain(domain);
                  }}
                  onEdit={() => {
                    if (mode === "chat") setMode("idle");
                    doEdit();
                  }}
                  cli={
                    inChat && activeSession
                      ? {
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
                        }
                      : undefined
                  }
                />
              ) : undefined;

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
                  topBar={tabBar}
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
                  setSkillIdx(i);
                  const sk = domain?.skills[i];
                  if (sk) openChatForSkill(sk);
                }}
                topBar={tabBar}
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
