import type { Dispatch, SetStateAction } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { SidebarFocus } from "./sidebar.tsx";
import type { AppSkill, Domain, ViewKey } from "./vault.ts";
import type { AvailableCli } from "./cli-bridge.ts";
import type { ChatSeed } from "./chat-pane.tsx";

// Feature flag mirror of the SHOW_APPS constant in app.tsx. The keyboard
// handler needs it to decide whether the `s` swap-focus key does anything.
// Importing it from app.tsx would create a circular import; this file holds
// the keyboard contract and app.tsx holds the UI tree. Keep both in sync.
const SHOW_APPS = false;

const VIEW_ORDER: ViewKey[] = ["state", "quickstart", "prompts", "skills"];

type Mode = "idle" | "new-domain" | "new-app" | "new-skill" | "pick-cli" | "chat" | "edit";

interface PendingOpenLike {
  key: string;
  label: string;
  hostDomain: Domain;
  seed: ChatSeed;
  initialView: ViewKey;
}

export interface UseAppKeyboardArgs {
  // Modes & overlays
  mode: Mode;
  toolsOpen: boolean;
  councilConfigOpen: boolean;
  benchmarkOpen: boolean;
  embeddedInputActiveRef: { current: boolean };
  autocompleteOpen: boolean;

  // Navigation state
  focus: SidebarFocus;
  view: ViewKey;
  onSkillsTab: boolean;

  // Collections
  domains: Domain[];
  apps: AppSkill[];
  skills: Array<{ id: string; title: string }>;
  clis: AvailableCli[];
  domain: Domain | null;

  // Indices
  domainIdx: number;
  appIdx: number;
  skillIdx: number;
  cliIdx: number;

  // Pending state
  pendingOpen: PendingOpenLike | null;

  // Setters
  setFocus: Dispatch<SetStateAction<SidebarFocus>>;
  setDomainIdx: Dispatch<SetStateAction<number>>;
  setAppIdx: Dispatch<SetStateAction<number>>;
  setViewIdx: Dispatch<SetStateAction<number>>;
  setSkillIdx: Dispatch<SetStateAction<number>>;
  setCliIdx: Dispatch<SetStateAction<number>>;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPendingOpen: Dispatch<SetStateAction<PendingOpenLike | null>>;
  setErrorBoundaryReset: Dispatch<SetStateAction<number>>;
  setBenchmarkOpen: Dispatch<SetStateAction<boolean>>;

  // Callbacks
  doEdit: () => void;
  doOpenSkill: () => void;
  doRefresh: () => void;
  openChatForSkill: (skill: { id: string; title: string }) => void;
  finalizeOpen: (cli: AvailableCli, open: PendingOpenLike) => void;
}

export function useAppKeyboard(args: UseAppKeyboardArgs) {
  const renderer = useRenderer();
  useKeyboard((evt) => {
    const name = evt.name;
    if (!name) return;

    if (args.mode === "new-domain" || args.mode === "new-app" || args.mode === "new-skill" || args.mode === "edit") return;

    // When an overlay is open (Tools panel, Council config), the overlay
    // owns the keyboard. Without this, scrolling the overlay with arrow
    // keys also moved the left sidebar selection — the user reported it
    // was happening on the Tools panel: scroll down to read more →
    // sidebar jumps to a different app.
    if (args.toolsOpen || args.councilConfigOpen || args.benchmarkOpen) {
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
    if (args.embeddedInputActiveRef.current) {
      if (evt.ctrl && name === "c") {
        renderer?.destroy?.();
        process.exit(0);
      }
      return;
    }

    // When the chat's slash-command popover is open, let the chat pane own
    // arrow/tab navigation — don't steal them for the sidebar.
    if (args.autocompleteOpen && (name === "up" || name === "down" || name === "tab")) {
      return;
    }

    if (args.mode === "chat") {
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

    if (args.mode === "pick-cli") {
      if (name === "escape") {
        args.setMode("idle");
        args.setPendingOpen(null);
        return;
      }
      if (name === "left" || name === "h") {
        args.setCliIdx((i) => (i - 1 + args.clis.length) % args.clis.length);
        return;
      }
      if (name === "right" || name === "l") {
        args.setCliIdx((i) => (i + 1) % args.clis.length);
        return;
      }
      if (name === "return" || name === "enter") {
        const chosen = args.clis[args.cliIdx];
        if (chosen && args.pendingOpen) args.finalizeOpen(chosen, args.pendingOpen);
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
      if (SHOW_APPS) args.setFocus((f) => (f === "domains" ? "apps" : "domains"));
    } else if (name === "j" || name === "down") {
      if (args.focus === "apps") args.setAppIdx((s) => Math.min(args.apps.length - 1, s + 1));
      else if (args.onSkillsTab && args.skills.length > 0) args.setSkillIdx((s) => Math.min(args.skills.length - 1, s + 1));
      else args.setDomainIdx((s) => Math.min(args.domains.length - 1, s + 1));
    } else if (name === "k" || name === "up") {
      if (args.focus === "apps") args.setAppIdx((s) => Math.max(0, s - 1));
      else if (args.onSkillsTab && args.skills.length > 0) args.setSkillIdx((s) => Math.max(0, s - 1));
      else args.setDomainIdx((s) => Math.max(0, s - 1));
    } else if (name === "g" || name === "home") {
      if (args.focus === "apps") args.setAppIdx(0);
      else if (args.onSkillsTab) args.setSkillIdx(0);
      else args.setDomainIdx(0);
    } else if (name === "G" || name === "end") {
      if (args.focus === "apps") args.setAppIdx(Math.max(0, args.apps.length - 1));
      else if (args.onSkillsTab) args.setSkillIdx(Math.max(0, args.skills.length - 1));
      else args.setDomainIdx(Math.max(0, args.domains.length - 1));
    } else if (name === "tab" || name === "right" || name === "l") {
      if (args.focus === "domains") args.setViewIdx((v) => (v + 1) % VIEW_ORDER.length);
    } else if (name === "left" || name === "h") {
      if (args.focus === "domains") args.setViewIdx((v) => (v - 1 + VIEW_ORDER.length) % VIEW_ORDER.length);
    } else if (name === "return" || name === "enter") {
      // Enter no longer auto-opens a separate chat pane for apps/domains —
      // the connector workspace (and domain detail) both have embedded
      // chat in their layout, so opening a second chat pane left the
      // user staring at it and needing Escape to see the workspace they
      // were trying to reach. Enter on a skill still opens its dedicated
      // chat because skills don't have the embedded-chat workspace.
      if (args.onSkillsTab && args.skills.length > 0) {
        const sk = args.skills[args.skillIdx];
        if (sk) args.openChatForSkill(sk);
      }
    } else if (name === "R") {
      // Capital R: force-remount every ErrorBoundary'd pane by bumping
      // the reset counter. This is the recovery path when a pane has
      // caught a render-time error and is showing the "crashed" view.
      args.setErrorBoundaryReset((n) => n + 1);
    } else if (name === "B") {
      // Capital B: open the Benchmark overlay. Lowercase `b` is unused
      // globally (model picker / chat input handle it). Same Esc-to-
      // close pattern as Tools / Council Config.
      args.setBenchmarkOpen(true);
    } else if (name === "r") {
      args.doRefresh();
    } else if (name === "n") {
      // Context-sensitive: on the Skills tab `n` scaffolds a new skill
      // under the active domain; everywhere else it scaffolds a new
      // domain. The CommandBar prompt label reflects which one fires.
      if (args.view === "skills" && args.focus === "domains" && args.domain) {
        args.setMode("new-skill");
      } else {
        args.setMode("new-domain");
      }
    } else if (name === "c") {
      // 'c' previously force-opened a separate full-pane chat. With the
      // embedded chat now in every workspace, this just bounces the user
      // into a redundant view. No-op — the chat input is already onscreen.
    } else if (name === "e") {
      args.doEdit();
    } else if (name === "o") {
      // Open-in-finder shortcut. Only meaningful on the Skills tab right
      // now — it opens the highlighted skill's folder so the user can
      // edit any file in the skill bundle, not just SKILL.md. Silent
      // no-op everywhere else (the ConfigBar's `▸ vault` chip covers
      // "open the domain folder" UX on every other tab).
      args.doOpenSkill();
    } else if (name >= "1" && name <= "5") {
      // Numbers map 1..N to VIEW_ORDER indices. Guard against pressing a
      // number past the end of the view list — VIEW_ORDER has 4 entries
      // (state/quickstart/prompts/skills) so pressing "5" used to leave
      // viewIdx=4, which then read VIEW_ORDER[4]=undefined and crashed
      // readDomainView with "paths[1] must be string, got undefined".
      const idx = Number(name) - 1;
      if (args.focus === "domains" && idx < VIEW_ORDER.length) args.setViewIdx(idx);
    }
  });
}
