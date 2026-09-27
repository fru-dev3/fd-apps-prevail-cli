import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatJson } from "./chat-json.ts";
import type { ChatTurn } from "./cli-bridge.ts";
import { setNotes } from "./entities.ts";
import { readThreadTurns } from "./session.ts";

// `prevail chat --json --entity <id>`: every turn carries the entity block
// ahead of the message. The model turn is a stand-in; no model is called.
let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-entity-chat-"));
  mkdirSync(join(vault, "data", "domains", "general"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

async function turn(entity: string | undefined, sessionId?: string) {
  const prompts: string[] = [];
  const lines: string[] = [];
  const code = await runChatJson({
    vaultPath: vault, domain: "general", message: "When does Foo move?", sessionId, entity,
    write: (l) => lines.push(l),
    deps: {
      detectClis: async () => [{ kind: "claude", bin: "claude", label: "Claude" }],
      runChatTurn: async (t: ChatTurn) => { prompts.push(t.prompt); return "In May."; },
      persistMessage: () => {},
    },
  });
  return { code, prompts, events: lines.map((l) => JSON.parse(l)) };
}

test("--entity puts the entity block ahead of every turn, never into the saved transcript", async () => {
  setNotes(vault, "person/foo", "Moves in May.", { name: "Foo" });
  const first = await turn("person/foo", "t-foo");
  expect(first.code).toBe(0);
  expect(first.prompts[0].startsWith("# ENTITY CONTEXT\nThis conversation is about Foo (Person, id person/foo).")).toBe(true);
  expect(first.prompts[0]).toContain("## Your notes\nMoves in May.");
  expect(first.prompts[0].endsWith("\n\n---\n\nWhen does Foo move?")).toBe(true);

  // A later turn rebuilds the block from the page, so a new note shows up.
  setNotes(vault, "person/foo", "Moves in June now.");
  const second = await turn("person/foo", "t-foo");
  expect(second.prompts[0]).toContain("Moves in June now.");

  const saved = readThreadTurns(vault, "general", "t-foo");
  expect(saved.filter((t) => t.role === "user").map((t) => t.content)).toEqual(["When does Foo move?", "When does Foo move?"]);
  expect(second.events.map((e) => e.type)).toEqual(["start", "user", "assistant", "usage", "done"]);
});

test("without --entity the prompt is just the message", async () => {
  const r = await turn(undefined);
  expect(r.prompts).toEqual(["When does Foo move?"]);
});
