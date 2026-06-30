import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  classifyGwsCommand,
  readPendingGws,
  addPendingGws,
  removePendingGws,
} from "./gws-gateway.ts";

describe("classifyGwsCommand — reads run live, writes/unknown are gated", () => {
  test("reads", () => {
    expect(classifyGwsCommand(["gmail", "+triage"]).kind).toBe("read");
    expect(classifyGwsCommand(["calendar", "events", "list"]).kind).toBe("read");
    expect(classifyGwsCommand(["drive", "files", "search", "--params", "{}"]).kind).toBe("read");
    expect(classifyGwsCommand(["calendar", "+agenda"]).kind).toBe("read");
  });

  test("writes", () => {
    expect(classifyGwsCommand(["gmail", "messages", "send", "--params", "{}"]).kind).toBe("write");
    expect(classifyGwsCommand(["calendar", "events", "delete", "--params", "{}"]).kind).toBe("write");
    expect(classifyGwsCommand(["drive", "files", "update", "--params", "{}"]).kind).toBe("write");
    expect(classifyGwsCommand(["gmail", "+send"]).kind).toBe("write"); // unknown helper -> write
  });

  test("unknown method token defaults to write", () => {
    expect(classifyGwsCommand(["gmail"]).kind).toBe("write");
    expect(classifyGwsCommand(["drive", "files"]).kind).toBe("write");
    expect(classifyGwsCommand([]).kind).toBe("write");
  });

  test("produces a human summary", () => {
    expect(classifyGwsCommand(["gmail", "+triage"]).summary).toBe("Gmail: triage");
    expect(classifyGwsCommand(["calendar", "events", "delete"]).summary).toBe("Calendar: events delete");
  });
});

describe("pending store round-trip", () => {
  test("add, list, remove", () => {
    const vault = mkdtempSync(`${tmpdir()}/prevail-gws-`);
    expect(readPendingGws(vault)).toEqual([]);

    const a = addPendingGws(vault, { domain: "general", summary: "Gmail: messages send", args: ["gmail", "messages", "send"] });
    const b = addPendingGws(vault, { domain: "work", summary: "Calendar: events delete", args: ["calendar", "events", "delete"] });
    expect(a.id).toBeTruthy();
    expect(typeof a.ts).toBe("number");

    let items = readPendingGws(vault);
    expect(items.length).toBe(2);
    expect(items[0]!.args).toEqual(["gmail", "messages", "send"]);
    expect(items[1]!.domain).toBe("work");

    removePendingGws(vault, a.id);
    items = readPendingGws(vault);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(b.id);

    removePendingGws(vault, "does-not-exist");
    expect(readPendingGws(vault).length).toBe(1);

    removePendingGws(vault, b.id);
    expect(readPendingGws(vault)).toEqual([]);
  });
});
