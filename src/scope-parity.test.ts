import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChatJson, type ChatJsonOptions } from "./chat-json.ts";
import type { ChatTurn } from "./cli-bridge.ts";
import { buildUserContext } from "./cli-bridge.ts";
import { setNotes } from "./entities.ts";
import type { MirrorApp } from "./apps-mirror.ts";

// Parity: every chat scope (domain, app, entity, referenced apps and domains)
// must hand the model byte-identical context before and after the scope
// resolver refactor. The snapshots were recorded on the code before it.
let vault: string;
const w = (rel: string, text: string) => { const p = join(vault, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

beforeAll(() => {
  vault = mkdtempSync("/tmp/prevail-scope-parity-");
  w("build/user.md", "# You\nA person who likes long walks and quiet mornings.\n");
  w("build/ideal-state.md", "# Ideal state\nCalm, curious, kind.\n");
  w("build/compass.md", "# Compass\n\n## Values\n- Craft ~id:v-craft ~rank:1\n  words: \"Do it well.\"\n\n## Goals\n- [ ] Finish the shed ~id:g-shed ~serves:v-craft ~status:active\n");
  w("data/domains/general/memory/memory.md", "# General\n");
  w("data/domains/general/source/goals.md", "# Goals\n- [ ] Walk every day ~id:g-walk\n");
  w("data/domains/homestead/memory/state.md", "# State\nThe shed needs paint.\n");
  w("data/domains/homestead/memory/memory.md", "# Memory\nPaint dries slowly in autumn.\n");
  w("data/domains/homestead/source/goals.md", "# Goals\n- [ ] Paint the shed ~id:g-paint @2026-11-01\n");
  w("data/domains/homestead/ideal-state.md", "A tidy yard.\n");
  w("data/domains/money/memory/state.md", "# State\nBudget is fine.\n");
  w("data/apps/paint-shop/manifest.json", JSON.stringify({ id: "paint-shop", name: "Paint Shop", domains: ["homestead"], integration: "manual" }));
  setNotes(vault, "person/foo", "Lends a ladder.", { name: "Foo" });
});
afterAll(() => rmSync(vault, { recursive: true, force: true }));

const APPS: MirrorApp[] = [];

async function capture(o: Partial<ChatJsonOptions>) {
  const turns: ChatTurn[] = [];
  const code = await runChatJson({
    vaultPath: vault, domain: "general", message: "What should I do this weekend?",
    write: (l) => { if (l.includes("\"error\"")) console.log(l); },
    ...o,
    deps: {
      detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
      runChatTurn: async (t: ChatTurn) => { turns.push(t); return "Paint."; },
      persistMessage: () => {},
      mirrorApps: () => APPS,
      dispatch: async () => ({ kind: "answer", confident: true }),
    },
  });
  expect(code).toBe(0);
  const t = turns[0]!;
  const norm = (s: string | undefined) => (s ?? "").split(vault).join("<vault>");
  return {
    prompt: norm(t.prompt),
    cwd: norm(t.cwd),
    entityId: t.entityId ?? null,
    inheritUserMcp: !!t.inheritUserMcp,
    userContext: norm(buildUserContext(vault, t.cwd, t.prompt)),
  };
}

test("domain turn", async () => {
  expect(await capture({ domain: "homestead" })).toMatchSnapshot();
});

test("general turn", async () => {
  expect(await capture({ domain: "general" })).toMatchSnapshot();
});

test("app scope turn", async () => {
  expect(await capture({ domain: "general", scopeApp: "paint-shop" })).toMatchSnapshot();
});

test("entity turn", async () => {
  expect(await capture({ domain: "general", entity: ["person/foo"] })).toMatchSnapshot();
});

test("domain turn with a referenced app and domain", async () => {
  expect(await capture({ domain: "homestead", apps: ["paint-shop"], refDomains: ["money"] })).toMatchSnapshot();
});

// The desktop ChatPanel's scope (missions-plan MS1 leftover): a domain chat no
// longer adds its own context, it sends the typed text with the flags below.
// The model must get exactly the "domain turn" snapshot above.
test("a desktop domain turn (ChatPanel scope) gets the domain turn's context, byte for byte", async () => {
  const desktop = await capture({ domain: "homestead", webAccess: "allow", localOnly: false, inheritUserMcp: false, incognito: false, apps: [], refDomains: [], entity: [], threadId: "foo-thread", outputHint: "# OUTPUT FORMAT: write foo links." });
  expect(desktop).toEqual(await capture({ domain: "homestead" }));
  expect(desktop.prompt).toBe("What should I do this weekend?");
});

// Long-term memory: a desktop domain turn sends only the typed text, so the
// engine adds the domain's memory/memory.md; a prompt that already carries the
// desktop's own memory block (General, entity and app chats) gets it once.
test("a domain turn carries the domain's long-term memory, once", async () => {
  const d = await capture({ domain: "homestead" });
  expect(d.userContext).toContain("# LONG-TERM MEMORY (homestead)");
  expect(d.userContext).toContain("Paint dries slowly in autumn.");
  const desk = await capture({ domain: "homestead", message: "--- Long-term memory (homestead) ---\nPaint dries slowly in autumn.\n\nHi" });
  expect(desk.userContext).not.toContain("# LONG-TERM MEMORY");
});
