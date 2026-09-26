// Synced app records must reach the domain they feed: a chat turn in that
// domain and a loop run over it both carry the newest pull from
// <domain>/source/apps/<id>/. A fake runtime on PATH records what it was
// handed, so nothing real is spawned. Invented app and data only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectClis, runChatTurn } from "./cli-bridge.ts";
import { runOneLoop } from "./daemon-loops.ts";

// scanVault refuses paths under /var, where macOS tmpdir() lives.
const BASE = process.platform === "darwin" ? "/tmp" : (process.env.TMPDIR || "/tmp");
const root = join(BASE, `prevail-appsctx-${process.pid}-${Math.floor(performance.now())}`);
const vault = join(root, "vault");
const bin = join(root, "bin");
const argvLog = join(root, "argv.log");
const domain = join(vault, "data", "domains", "garden");
const MARKER = "tomato-bed-7-watered-2031";

const saved: Record<string, string | undefined> = {};

function readArgv(): string {
  return existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "";
}

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(vault, "build"), { recursive: true });
  mkdirSync(join(domain, "source", "apps", "acme-notes"), { recursive: true });
  writeFileSync(join(domain, "state.md"), "# Garden\n");
  writeFileSync(join(domain, "ideal-state.md"), "# Garden\nEvery bed watered.\n");
  // An older pull and the newest one; only the newest is expected in context.
  writeFileSync(join(domain, "source", "apps", "acme-notes", "2031-04-01.json"), JSON.stringify({ summary: "old pull", records: [{ note: "stale-entry" }] }));
  writeFileSync(join(domain, "source", "apps", "acme-notes", "2031-04-02.json"), JSON.stringify({ summary: "Acme Notes garden log", records: [{ note: MARKER }] }));
  writeFileSync(join(domain, "_loops.json"), JSON.stringify({
    schema: 1,
    desiredState: "Every bed watered",
    loops: [{
      id: "water", name: "Watering", purpose: "Keep beds watered", type: "maintain", signals: [], condition: "",
      cadence: "daily", autonomy: "suggest", evaluation: "", actions: [], status: "active", enabled: true,
      lastRunTs: null, createdTs: 0,
    }],
  }));
  // Fake runtime: logs every argument (one per line) and answers with a
  // minimal reply, so the caller's parse path runs to completion.
  const script = [
    "#!/bin/sh",
    `for a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done`,
    `printf '%s\\n' '---ARGV-END---' >> "${argvLog}"`,
    "echo '{\"actions\":[],\"done\":false,\"note\":\"ok\"}'",
  ].join("\n");
  for (const name of ["claude", "codex", "gemini"]) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  // Keep every side write (logs, usage ledgers) inside the temp tree.
  for (const k of ["PATH", "HOME", "PREVAIL_HOME"]) saved[k] = process.env[k];
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = join(root, "home");
  process.env.PREVAIL_HOME = join(root, "home", ".prevail");
  mkdirSync(process.env.PREVAIL_HOME, { recursive: true });
  // The runtime roster is cached per process; rebuild it so the loop picks
  // the fake runtime even when another test primed the cache first.
  await detectClis({ force: true });
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await detectClis({ force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("synced app records reach the domain", () => {
  test("a chat turn in the domain carries the newest pull (system prompt for claude)", async () => {
    rmSync(argvLog, { force: true });
    await runChatTurn({
      prompt: "How are the beds?", cwd: domain, model: "", isFirst: true,
      cli: { kind: "claude", bin: join(bin, "claude"), label: "Claude" },
    }).catch(() => "");
    const argv = readArgv();
    expect(argv).toContain(MARKER);
    expect(argv).toContain("source/apps/acme-notes/2031-04-02.json");
    expect(argv).not.toContain("stale-entry");
  });

  test("a chat turn through a runtime without a system channel gets it in the prompt", async () => {
    rmSync(argvLog, { force: true });
    await runChatTurn({
      prompt: "How are the beds?", cwd: domain, model: "", isFirst: true,
      cli: { kind: "gemini", bin: join(bin, "gemini"), label: "Gemini" },
    }).catch(() => "");
    expect(readArgv()).toContain(MARKER);
  });

  test("a bare turn (council, classifier) does not get it", async () => {
    rmSync(argvLog, { force: true });
    await runChatTurn({
      prompt: "Classify this", cwd: domain, model: "", isFirst: true, bare: true,
      cli: { kind: "gemini", bin: join(bin, "gemini"), label: "Gemini" },
    }).catch(() => "");
    const argv = readArgv();
    expect(argv).toContain("Classify this");
    expect(argv).not.toContain(MARKER);
  });

  test("a loop run over the domain carries the newest pull in its prompt", async () => {
    rmSync(argvLog, { force: true });
    await runOneLoop({ vaultPath: vault, intervalSec: 3600, provider: "claude", model: "" }, "garden", "water").catch(() => null);
    const argv = readArgv();
    expect(argv).toContain(MARKER);
    expect(argv).toContain("Watering");
  });
});
