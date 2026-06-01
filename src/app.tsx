import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Sidebar, type ChatStatus, type SidebarFocus } from "./sidebar.tsx";
import { DomainDetail } from "./domain-detail.tsx";
import { AppDetail } from "./app-detail.tsx";
import { Branding } from "./branding.tsx";
import { CommandBar } from "./command-bar.tsx";
import {
  ChatPane,
  SLASH_HELP,
  makeInitialMessages,
  makeSeedPrompt,
  type ChatCommand,
  type ChatSeed,
  type ChatSession,
} from "./chat-pane.tsx";
import { EditorPane } from "./editor-pane.tsx";
import { scanApps, scanVault, type AppSkill, type Domain, type ViewKey } from "./vault.ts";
import { theme } from "./theme.ts";
import { scaffoldDomain } from "./domain-scaffold.ts";
import { buildDistillPrompt, parseDistillResponse, writeDistilledSkill } from "./distill.ts";
import {
  formatRelativeDate,
  getDomainHistory,
  makeSessionId,
  persistMessage,
  searchMessages,
} from "./session.ts";
import {
  detectClis,
  formatModelBadge,
  runChatTurn,
  type AvailableCli,
} from "./cli-bridge.ts";

const VIEW_ORDER: ViewKey[] = ["state", "loops", "quickstart", "prompts", "skills"];
const VIEW_FILE: Record<ViewKey, string | null> = {
  state: "state.md",
  loops: "state.md",
  quickstart: "QUICKSTART.md",
  prompts: "PROMPTS.md",
  skills: null,
};

type Mode = "idle" | "new-domain" | "pick-cli" | "chat" | "edit";

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
  const [apps, setApps] = useState<AppSkill[]>(() => scanApps(vaultPath));
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
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [tick, setTick] = useState(0);

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

  useEffect(() => {
    setViewIdx(0);
    setSkillIdx(0);
  }, [domainIdx]);

  useEffect(() => {
    setSkillIdx(0);
  }, [viewIdx]);

  useEffect(() => {
    if (mode === "edit" || mode === "new-domain") return;
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

    if (mode === "new-domain" || mode === "edit") return;

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
      if (focus === "domains") setViewIdx(Number(name) - 1);
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
    const result = scaffoldDomain(vaultPath, value);
    setMode("idle");
    if (result.ok) {
      const next = scanVault(vaultPath);
      setDomains(next);
      setApps(scanApps(vaultPath));
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
    setApps(scanApps(vaultPath));
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
    runChatTurn({
      prompt: promptForCli,
      cwd: session.hostDomain.path,
      cli: session.cli,
      model: session.model,
      isFirst: !session.hasFirstTurn,
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
      });
  }

  function doEdit() {
    if (focus === "apps") {
      setMessage("apps aren't editable from the cockpit — open the SKILL.md in your repo");
      return;
    }
    if (!domain) return;
    const filename = VIEW_FILE[view];
    if (!filename) {
      setMessage("the skills tab isn't editable — switch to state / prompts / quickstart");
      return;
    }
    setMode("edit");
  }

  function exitEditor(saved: boolean) {
    setMode("idle");
    if (saved) {
      setDomains(scanVault(vaultPath));
      setMessage("✓ saved");
    }
  }

  function doQuit() {
    renderer?.destroy?.();
    process.exit(0);
  }

  const activeSession = activeKey ? chats.get(activeKey) ?? null : null;
  const inChat = mode === "chat" && activeSession;
  const inEdit = mode === "edit" && domain;
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
        />
        {inChat ? (
          <ChatPane
            session={activeSession!}
            availableClis={clis}
            tick={tick}
            onSend={sendMessage}
            onCommand={handleChatCommand}
            onExit={exitChat}
          />
        ) : inEdit && editFilename ? (
          <EditorPane
            domain={domain!}
            filename={editFilename}
            onExit={exitEditor}
          />
        ) : focus === "apps" && app ? (
          <AppDetail app={app} />
        ) : (
          <DomainDetail
            domain={domain}
            view={view}
            skillIdx={skillIdx}
            onPickTab={(i) => {
              setFocus("domains");
              setViewIdx(i);
            }}
            onPickSkill={(i) => setSkillIdx(i)}
          />
        )}
      </box>
      <CommandBar
        mode={mode}
        prompt={mode === "new-domain" ? "new domain ›" : "chat with:"}
        message={message}
        cliOptions={clis.map((c) => c.label)}
        cliIndex={cliIdx}
        onSubmit={handleSubmit}
        onCancel={() => {
          setMode("idle");
          setPendingOpen(null);
        }}
        onAction={(a) => {
          if (a === "new") setMode("new-domain");
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
