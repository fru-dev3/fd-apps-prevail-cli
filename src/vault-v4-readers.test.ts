// The distillers write `memory/state.md` on a v4 domain. The readers used by
// every domain list, preview and context score must prefer that file over the
// frozen pre-migration `_state.md`, or the app "learns" into a file nothing
// reads back. This pins the resolution order.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDomainDir, readStateContent, resolveStatePath } from "./vault.ts";

function tmpDomain(): string {
  return mkdtempSync(join(tmpdir(), "prevail-v4-readers-"));
}

describe("v4 state readers", () => {
  test("memory/state.md wins over _state.md and state.md", () => {
    const d = tmpDomain();
    writeFileSync(join(d, "state.md"), "v1 body");
    writeFileSync(join(d, "_state.md"), "v2 body");
    mkdirSync(join(d, "memory"));
    writeFileSync(join(d, "memory", "state.md"), "v4 body");
    expect(resolveStatePath(d)).toBe(join(d, "memory", "state.md"));
    expect(readStateContent(d)).toBe("v4 body");
  });

  test("falls back to _state.md, then state.md, then null", () => {
    const d = tmpDomain();
    expect(resolveStatePath(d)).toBeNull();
    writeFileSync(join(d, "state.md"), "v1 body");
    expect(readStateContent(d)).toBe("v1 body");
    writeFileSync(join(d, "_state.md"), "v2 body");
    expect(readStateContent(d)).toBe("v2 body");
  });

  test("a v4-marked domain with only ideal-state.md is still a domain", () => {
    const d = tmpDomain();
    expect(isDomainDir(d)).toBe(false);
    writeFileSync(join(d, ".prevail-layout-v4"), "");
    expect(isDomainDir(d)).toBe(true);
    const e = tmpDomain();
    writeFileSync(join(e, "ideal-state.md"), "# Ideal");
    expect(isDomainDir(e)).toBe(true);
  });
});
