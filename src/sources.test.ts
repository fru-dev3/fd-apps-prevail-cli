import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addSource, chunkDocument, formatSourcesContext, listSourceRows, queryFromPrompt, queryTerms,
  readSources, refreshSources, removeSource, searchSources, setSourceEnabled, sourcesCacheDir,
  sourcesContextFor, walkPrevailVault, SOURCES_HEADER,
} from "./sources";
import type { Fetcher, FetchResponse } from "./sources-web";

let savedCfg: string | undefined;
let root: string;
let vault: string;

function write(p: string, body: string) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

beforeAll(() => {
  savedCfg = process.env.PREVAIL_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), "prevail-sources-"));
  process.env.PREVAIL_CONFIG_DIR = join(root, "cfg");
  vault = join(root, "vault");
  write(join(vault, "VAULT.md"), "# map\n");
  mkdirSync(join(vault, "build"), { recursive: true });
  write(join(vault, "data/domains/tax/memory/state.md"), "# Tax state\n\n## Estimated payments\n\nQ4 estimated payment of $4,200 is due 2027-01-15.\n");
  write(join(vault, "data/domains/tax/memory/threads/chat.md"), "raw transcript mentioning estimated payment\n");
  write(join(vault, "data/domains/tax/skills/x/SKILL.md"), "estimated payment skill\n");
  write(join(vault, "data/domains/health/manifest.json"), JSON.stringify({ privacy: { localOnly: true } }));
  write(join(vault, "data/domains/health/memory/state.md"), "Blood pressure 120/80 at the June checkup.\n");
  write(join(vault, "data/entities/people/sam-rivera.md"), "---\nname: Sam Rivera\nkind: person\n---\n\n## Your notes\n\nSam is my accountant for estimated payments.\n");
  write(join(root, "obsidian/.obsidian/app.json"), "{}");
  write(join(root, "obsidian/Projects/roadmap.md"), "# Roadmap\n\nShip the Sources page, then [[Two way sync]] later.\n");
  write(join(root, "notes/garden.txt"), "Garden plan\n\nPlant garlic in October, harvest in July.\n");
});

afterAll(() => {
  if (savedCfg === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = savedCfg;
});

const noWeb: Fetcher = async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }) as FetchResponse;

describe("the source list", () => {
  test("the vault is always the first source, even with no file", () => {
    const list = readSources(vault);
    expect(list[0]).toMatchObject({ id: "vault", kind: "prevail", builtin: true, enabled: true });
    expect(existsSync(join(vault, "build/sources.json"))).toBe(false);
  });

  test("adds each kind with validation, stored in build/sources.json", () => {
    const ob = addSource(vault, { kind: "obsidian", location: join(root, "obsidian"), name: "Personal notes" });
    expect(ob).toMatchObject({ id: "obsidian-personal-notes", domain: "notes" });
    const f = addSource(vault, { kind: "folder", location: join(root, "notes") });
    expect(f.id).toBe("folder-notes");
    const w = addSource(vault, { kind: "website", location: "fru.dev/agents" });
    expect(w).toMatchObject({ id: "site-fru-dev", location: "https://fru.dev", name: "fru.dev" });
    expect(() => addSource(vault, { kind: "website", location: "https://fru.dev" })).toThrow(/already a source/);
    expect(() => addSource(vault, { kind: "folder", location: join(root, "missing") })).toThrow(/not found/);
    expect(() => addSource(vault, { kind: "folder", location: join(vault, "data") })).toThrow(/inside this vault/);
    expect(() => addSource(vault, { kind: "prevail", location: join(root, "notes") })).toThrow(/not a Prevail vault/);
    const file = JSON.parse(readFileSync(join(vault, "build/sources.json"), "utf8"));
    expect(file.sources.map((s: { id: string }) => s.id)).toEqual(["vault", "obsidian-personal-notes", "folder-notes", "site-fru-dev"]);
  });

  test("the built-in vault can be turned off but not removed", () => {
    expect(() => removeSource(vault, "vault")).toThrow(/always a source/);
    setSourceEnabled(vault, "vault", false);
    expect(readSources(vault)[0]!.enabled).toBe(false);
    setSourceEnabled(vault, "vault", true);
  });
});

describe("chunking + walking", () => {
  test("markdown splits by heading and keeps the file title", () => {
    const big = `# Plan\n\n## One\n\n${"alpha ".repeat(120)}\n\n## Two\n\n${"beta ".repeat(120)}`;
    const chunks = chunkDocument(big, "plan.md");
    expect(chunks.map((c) => c.title)).toEqual(["Plan > One", "Plan > Two"]);
  });

  test("the vault walk skips transcripts, skills and local-only domains", () => {
    const { files, domains } = walkPrevailVault(vault);
    const rels = files.map((f) => f.rel);
    expect(domains).toEqual(["tax"]);
    expect(rels).toContain("tax/memory/state.md");
    expect(rels).toContain("entities/people/sam-rivera.md");
    expect(rels.some((r) => r.includes("threads") || r.includes("skills") || r.startsWith("health"))).toBe(false);
  });
});

describe("refresh + search", () => {
  test("indexes local sources; Obsidian is imported one way into the vault", async () => {
    const r = await refreshSources(vault, { fetcher: noWeb, gapMs: 0 });
    expect(r.busy).toBe(false);
    expect(r.refreshed).toEqual(["vault", "obsidian-personal-notes", "folder-notes", "site-fru-dev"]);
    const rows = listSourceRows(vault);
    expect(rows.find((x) => x.id === "vault")!.status).toMatchObject({ state: "ready", detail: "1 domains" });
    expect(rows.find((x) => x.id === "folder-notes")!.status.items).toBe(1);
    const imported = join(vault, "data/domains/notes/source/obsidian/obsidian-personal-notes/Projects/roadmap.md");
    expect(readFileSync(imported, "utf8")).toContain("[Two way sync](Two%20way%20sync.md)");
    // The user's Obsidian file is never written.
    expect(readFileSync(join(root, "obsidian/Projects/roadmap.md"), "utf8")).toContain("[[Two way sync]]");
    // The imported copy is cited as Obsidian, not double-counted as vault.
    const hits = searchSources(vault, "roadmap sources page");
    expect(hits[0]).toMatchObject({ sourceId: "obsidian-personal-notes", location: "Projects/roadmap.md" });
    expect(hits.some((h) => h.sourceId === "vault")).toBe(false);
    expect(existsSync(sourcesCacheDir(vault))).toBe(true);
  });

  test("a due-only pass skips sources that are not due", async () => {
    const r = await refreshSources(vault, { dueOnly: true, fetcher: noWeb, gapMs: 0 });
    expect(r.refreshed).toEqual([]);
  });

  test("ranks the relevant excerpt first and cites it", () => {
    const hits = searchSources(vault, "When is my Q4 estimated tax payment due?");
    expect(hits[0]).toMatchObject({ sourceId: "vault", group: "tax", location: "data/domains/tax/memory/state.md" });
    expect(searchSources(vault, "when to plant garlic")[0]).toMatchObject({ sourceId: "folder-notes", location: "garden.txt" });
    // Local-only domains are never retrievable.
    expect(searchSources(vault, "blood pressure checkup")).toEqual([]);
  });

  test("turned-off sources are not searched", () => {
    setSourceEnabled(vault, "folder-notes", false);
    expect(searchSources(vault, "plant garlic")).toEqual([]);
    setSourceEnabled(vault, "folder-notes", true);
  });

  test("formats a cited block and strips it from repeat queries", () => {
    const { context, hits } = sourcesContextFor(vault, "estimated payment accountant");
    expect(context.startsWith(SOURCES_HEADER)).toBe(true);
    expect(context).toContain("[S1]");
    expect(hits.length).toBeGreaterThan(0);
    expect(formatSourcesContext([])).toBe("");
    expect(queryFromPrompt("preamble\nUser's next message: plant garlic")).toBe("plant garlic");
    expect(queryTerms("Who led Anthropic's latest funding rounds?")).toEqual(["led", "anthropic", "latest", "fund", "round"]);
  });

  test("removing a source drops its index but keeps imported notes", () => {
    const r = removeSource(vault, "obsidian-personal-notes");
    expect(r.keptImport).toContain("source/obsidian/obsidian-personal-notes");
    expect(existsSync(join(r.keptImport!, "Projects/roadmap.md"))).toBe(true);
    expect(existsSync(join(sourcesCacheDir(vault), "obsidian-personal-notes.index.json"))).toBe(false);
  });

  test("PREVAIL_SOURCES=off disables retrieval", () => {
    process.env.PREVAIL_SOURCES = "off";
    try { expect(sourcesContextFor(vault, "estimated payment").context).toBe(""); } finally { delete process.env.PREVAIL_SOURCES; }
  });
});
