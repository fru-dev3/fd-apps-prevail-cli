import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChatTurn } from "./cli-bridge";
import { addSource, refreshSources, type SourceHit } from "./sources";

// The chat path end to end, without a real model: runChatTurn against a fake
// OpenAI-compatible local server that records the prompt it was sent. Proves
// the user's sources reach the model as a cited block, and that the opt-outs
// (bare calls, sources:false, a block already present) are honored.

let savedCfg: string | undefined;
let vault: string;
let cwd: string;
let seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  savedCfg = process.env.PREVAIL_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), "prevail-sources-chat-"));
  process.env.PREVAIL_CONFIG_DIR = join(root, "cfg");
  vault = join(root, "vault");
  cwd = join(vault, "data", "domains", "home");
  mkdirSync(join(cwd, "memory"), { recursive: true });
  writeFileSync(join(vault, "VAULT.md"), "# map\n");
  mkdirSync(join(root, "garden"), { recursive: true });
  writeFileSync(join(root, "garden", "plan.txt"), "Garden plan\n\nPlant garlic in October, harvest in July.\n");
  addSource(vault, { kind: "folder", location: join(root, "garden"), name: "Garden" });
  await refreshSources(vault, { ids: ["folder-garden"] });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: { content: string }[] };
      seen.push(body.messages[0]!.content);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Plant it in October [S1]." } }] }), { headers: { "content-type": "application/json" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (savedCfg === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = savedCfg;
});

const local = () => ({ kind: "ollama" as const, bin: `http://127.0.0.1:${server.port}`, label: "Local" });

describe("sources in the chat turn", () => {
  test("a real turn carries the cited block ahead of the message and reports the hits", async () => {
    seen = [];
    let hits: SourceHit[] = [];
    const reply = await runChatTurn({ prompt: "When should I plant garlic?", cwd, cli: local(), model: "llama3", isFirst: true, onSources: (h) => { hits = h; } });
    expect(reply).toContain("[S1]");
    const sent = seen[0]!;
    expect(sent).toContain("# CONTEXT FROM YOUR SOURCES");
    expect(sent).toContain('[S1] plan');
    expect(sent).toContain('Folder "Garden": plan.txt');
    expect(sent.indexOf("# CONTEXT FROM YOUR SOURCES")).toBeLessThan(sent.indexOf("When should I plant garlic?"));
    expect(hits.map((h) => h.sourceId)).toEqual(["folder-garden"]);
  });

  test("bare calls, sources:false and a prompt that already has a block get none added", async () => {
    seen = [];
    await runChatTurn({ prompt: "When should I plant garlic?", cwd, cli: local(), model: "llama3", isFirst: true, bare: true });
    await runChatTurn({ prompt: "When should I plant garlic?", cwd, cli: local(), model: "llama3", isFirst: true, sources: false });
    const pre = "# CONTEXT FROM YOUR SOURCES\n[S1] from the desktop\n# END OF SOURCES\n\nWhen should I plant garlic?";
    await runChatTurn({ prompt: pre, cwd, cli: local(), model: "llama3", isFirst: true });
    expect(seen[0]).not.toContain("CONTEXT FROM YOUR SOURCES");
    expect(seen[1]).not.toContain("CONTEXT FROM YOUR SOURCES");
    expect(seen[2]!.match(/# CONTEXT FROM YOUR SOURCES/g)).toHaveLength(1);
  });
});
