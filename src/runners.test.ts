import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSkillCli, runSkillHttp, extractSummary, jsonPath } from "./runners.ts";
import { runSkill, parseSkillFile, classifyOp, autonomyAllows } from "./connector-skills.ts";
import type { AppSkill } from "./vault.ts";

const ROOT = join(tmpdir(), `prevail-runners-${process.pid}`);

const app = (id: string): AppSkill => ({
  id,
  title: id,
  description: "",
  domains: ["wealth"],
  path: join(ROOT, id),
  hasState: false,
  openLoopCount: 0,
  stateMtime: null,
  skills: [],
  community: true,
  status: "connected",
  lastSuccessTs: null,
  configured: true,
});

function makeSkill(id: string, raw: string) {
  const a = app(id);
  mkdirSync(join(a.path, "data"), { recursive: true });
  const spec = parseSkillFile(raw, join(a.path, "skills", "s", "SKILL.md"), a);
  if (!spec) throw new Error("skill failed to parse");
  return spec;
}

beforeAll(() => mkdirSync(ROOT, { recursive: true }));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("pattern runners", () => {
  test("cli runner executes a command, captures output, writes outputs, extracts summary", async () => {
    const spec = makeSkill("cli-app", [
      "---",
      "id: pull",
      "runner: cli",
      'command: printf "line1\\n===SUMMARY===\\n3 new items synced\\n"',
      "outputs:",
      "  - path: data/pull-${date}.txt",
      "    kind: replace",
      "---",
      "Pull items.",
    ].join("\n"));
    const r = await runSkillCli(spec, {}, {});
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("3 new items synced");
    expect(r.outputsWritten.length).toBe(1);
    const written = join(spec.connectorDir, r.outputsWritten[0]);
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("line1");
  });

  test("cli runner substitutes ${cursor.x} and advances cursor from stdout JSON", async () => {
    const spec = makeSkill("cli-cursor", [
      "---",
      "id: pull",
      "runner: cli",
      'command: printf \'{"since": "${cursor.since}", "next": "2026-06-12"}\'',
      "cursor_from: stdout:next",
      "---",
      "Pull.",
    ].join("\n"));
    const r = await runSkillCli(spec, {}, { cursor: { since: "2026-06-01" } });
    expect(r.ok).toBe(true);
    expect(r.raw).toContain('"since": "2026-06-01"');
    expect(r.cursor?.next).toBe("2026-06-12");
  });

  test("cli runner fails on nonzero exit with stderr in message", async () => {
    const spec = makeSkill("cli-fail", [
      "---", "id: pull", "runner: cli",
      "command: sh -c 'echo boom >&2; exit 3'",
      "---", "Pull.",
    ].join("\n"));
    const r = await runSkillCli(spec, {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("exited 3");
    expect(r.message).toContain("boom");
  });

  test("cli runner refuses output paths escaping the connector dir", async () => {
    const spec = makeSkill("cli-escape", [
      "---", "id: pull", "runner: cli",
      "command: echo hi",
      "outputs:",
      "  - path: ../../etc/owned",
      "    kind: replace",
      "---", "Pull.",
    ].join("\n"));
    const r = await runSkillCli(spec, {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("escapes");
  });

  test("http runner performs a declarative request, saves response, extracts cursor", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => Response.json({ items: [1, 2], nextCursor: "abc123", summary: "2 items" }),
    });
    // https enforced — but allow the test through a template override check:
    // use the real path with a https-check bypass via the local server is not
    // possible, so verify the https guard separately and test the rest via
    // a mocked fetch.
    srv.stop();

    const spec = makeSkill("http-app", [
      "---", "id: pull", "runner: api",
      "url: https://api.test.local/v1/items?since=${cursor.since}",
      "method: GET",
      "headers:",
      '  - "Accept: application/json"',
      "save: data/items-${date}.json",
      "cursor_path: nextCursor",
      "summary_path: summary",
      "---", "Pull items.",
    ].join("\n"));

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("since=2026-06-01");
      return Response.json({ items: [1, 2], nextCursor: "abc123", summary: "2 items" });
    }) as typeof fetch;
    try {
      const r = await runSkillHttp(spec, {}, { cursor: { since: "2026-06-01" } });
      expect(r.ok).toBe(true);
      expect(r.cursor?.nextCursor).toBe("abc123");
      expect(r.summary).toBe("2 items");
      expect(r.outputsWritten.length).toBe(1);
      const saved = JSON.parse(readFileSync(join(spec.connectorDir, r.outputsWritten[0]), "utf8"));
      expect(saved.items.length).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // Cursor pagination, Plaid /transactions/sync shaped: keep POSTing while
  // has_more, feed next_cursor back into the body, collect `added` across pages
  // into a JSONL ledger, and return the FINAL cursor for the daemon to persist.
  test("http runner paginates on paginate_while, threads the cursor, appends items as JSONL", async () => {
    const spec = makeSkill("http-paged", [
      "---", "id: sync", "runner: api",
      "url: https://api.test.local/transactions/sync",
      "method: POST",
      "headers:",
      '  - "Content-Type: application/json"',
      `body: '{"cursor":"\${cursor.next_cursor}","count":2}'`,
      "cursor_path: next_cursor",
      "paginate_while: has_more",
      "items_path: added",
      "outputs:",
      "  - { path: transactions/recent.jsonl, kind: append }",
      "---", "Sync transactions.",
    ].join("\n"));

    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? "{}")) as { cursor: string };
      seen.push(sent.cursor);
      if (sent.cursor === "") return Response.json({ added: [{ id: 1 }, { id: 2 }], has_more: true, next_cursor: "c1" });
      if (sent.cursor === "c1") return Response.json({ added: [{ id: 3 }], has_more: false, next_cursor: "c2" });
      return Response.json({ added: [], has_more: false, next_cursor: sent.cursor });
    }) as typeof fetch;
    try {
      const r = await runSkillHttp(spec, {}, { cursor: {} });
      expect(r.ok).toBe(true);
      expect(seen).toEqual(["", "c1"]);
      expect(r.cursor?.next_cursor).toBe("c2");
      expect(r.summary).toBe("3 items across 2 pages");
      const file = join(spec.connectorDir, r.outputsWritten[0]!);
      expect(readFileSync(file, "utf8")).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');

      // A later "nothing new" run resumes from the persisted cursor and appends nothing.
      const again = await runSkillHttp(spec, {}, { cursor: { next_cursor: "c2" } });
      expect(again.ok).toBe(true);
      expect(seen[seen.length - 1]).toBe("c2");
      expect(again.cursor?.next_cursor).toBe("c2");
      expect(again.summary).toBe("0 items across 1 page");
      expect(readFileSync(file, "utf8")).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("http runner refuses paginate_while without a cursor_path", async () => {
    const spec = makeSkill("http-paged-bad", [
      "---", "id: sync", "runner: api",
      "url: https://api.test.local/sync",
      "paginate_while: has_more",
      "---", "Sync.",
    ].join("\n"));
    const r = await runSkillHttp(spec, {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("cursor_path");
  });

  // A quoted API secret of 40+ chars looks like a "verbatim quote" to the egress
  // guard. Declared auth values are what the request exists to send, so they are
  // masked before the scan and the credentialed POST goes out.
  test("http runner does not let the egress guard block the skill's own declared auth values", async () => {
    process.env.HTTP_TEST_SECRET = "access-production-" + "a".repeat(40);
    const spec = makeSkill("http-auth-body", [
      "---", "id: sync", "runner: api",
      "auth: [HTTP_TEST_SECRET]",
      "url: https://api.test.local/sync",
      "method: POST",
      `body: '{"access_token":"\${env.HTTP_TEST_SECRET}"}'`,
      "---", "Sync.",
    ].join("\n"));
    const realFetch = globalThis.fetch;
    let sentBody = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const r = await runSkillHttp(spec, {}, {});
      expect(r.ok).toBe(true);
      expect(sentBody).toContain(process.env.HTTP_TEST_SECRET!);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.HTTP_TEST_SECRET;
    }
  });

  test("runSkill stamps the runner on every result", async () => {
    const spec = makeSkill("cli-stamp", [
      "---", "id: pull", "runner: cli", 'command: printf "hi"', "---", "Pull.",
    ].join("\n"));
    const r = await runSkill(spec, {}, {});
    expect(r.ok).toBe(true);
    expect(r.runner).toBe("cli");
  });

  test("http runner rejects non-https urls", async () => {
    const spec = makeSkill("http-insecure", [
      "---", "id: pull", "runner: api",
      "url: http://api.test.local/v1",
      "---", "Pull.",
    ].join("\n"));
    const r = await runSkillHttp(spec, {}, {});
    expect(r.ok).toBe(false);
    // http:// is rejected by the SSRF guard (https-only is part of the guard).
    expect(r.message.toLowerCase()).toContain("unsafe");
  });
});

describe("autonomy gate (pattern-wide)", () => {
  test("op classification", () => {
    expect(classifyOp(undefined)).toBe("read");
    expect(classifyOp("sync")).toBe("read");
    expect(classifyOp("createDraft")).toBe("draft");
    expect(classifyOp("send")).toBe("act");
  });

  test("levels", () => {
    expect(autonomyAllows(undefined, "read")).toBe(true);
    expect(autonomyAllows(undefined, "draft")).toBe(false);
    expect(autonomyAllows("draft", "draft")).toBe(true);
    expect(autonomyAllows("draft", "act")).toBe(false);
    expect(autonomyAllows("act", "act")).toBe(true);
  });

  test("runSkill blocks a send op at read-only with actionable message", async () => {
    const spec = makeSkill("gated", [
      "---", "id: send-email", "runner: api", "op: send",
      "url: https://api.test.local/send",
      "---", "Send.",
    ].join("\n"));
    const r = await runSkill(spec, {}, { autonomy: "read-only" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('needs autonomy "act"');
    expect(r.message).toContain("prevail connectors set gated autonomy act");
  });
});

describe("helpers", () => {
  test("extractSummary prefers the marker block", () => {
    expect(extractSummary("noise\n===SUMMARY===\nThe gist.\n")).toBe("The gist.");
    expect(extractSummary("a\nb\nlast line")).toBe("last line");
  });
  test("jsonPath walks dotted paths", () => {
    expect(jsonPath({ a: { b: [10, 20] } }, "a.b.1")).toBe(20);
    expect(jsonPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });
});
