// The one store for products (data/entities/products) and its read-only
// fallback to the legacy trees until the products migration has run.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPages } from "./entities.ts";
import { appRecords, listProducts } from "./ia.ts";
import { isAppFolder, productDir, productFolders, productWriteDir, productsMigrationRecorded } from "./path-safety.ts";

// The legacy layout (before products), read only by the transition fallback.
const LEGACY_APPS = ["data", "apps"];
const LEGACY_PAGES = ["data", "entities", "orgs"];

let v = "";
const put = (rel: string[], body: string) => { const p = join(v, ...rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
const page = (name: string, kind: string) => `---\nname: ${name}\nkind: ${kind}\naliases: []\nsaved: true\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\nmention_count: 0\n---\n\n## Your notes\n`;

beforeEach(() => {
  v = mkdtempSync(join(tmpdir(), "prevail-products-"));
  mkdirSync(join(v, "data", "domains"), { recursive: true });
  mkdirSync(join(v, "build", "_meta"), { recursive: true });
});
afterEach(() => rmSync(v, { recursive: true, force: true }));

describe("products store", () => {
  test("a product folder holds the page and the app parts; a page alone is not an app", () => {
    put(["data", "entities", "products", "foo-co", "entity.md"], page("Foo Co", "product"));
    put(["data", "entities", "products", "foo-co", "manifest.json"], JSON.stringify({ id: "foo-co", name: "Foo Co", integration: "api" }));
    put(["data", "entities", "products", "bar-co", "entity.md"], page("Bar Co", "product"));
    put(["data", "entities", "products", "baz-old", "manifest.json"], JSON.stringify({ id: "baz-old", lifecycle: "archived" }));
    expect(isAppFolder(productDir(v, "foo-co"))).toBe(true);
    expect(isAppFolder(productDir(v, "bar-co"))).toBe(false);
    expect(isAppFolder(productDir(v, "baz-old"))).toBe(false);
    expect(appRecords(v).map((a) => [a.id, a.integration ?? "", !!a.archived])).toEqual([["baz-old", "", true], ["foo-co", "api", false]]);
    expect(listPages(v).map((p) => p.id).sort()).toEqual(["product/bar-co", "product/foo-co"]);
  });

  test("before the migration the legacy trees are read, never written", () => {
    put([...LEGACY_APPS, "foo-app", "manifest.json"], JSON.stringify({ id: "foo-app", name: "Foo App" }));
    put([...LEGACY_PAGES, "foo-page", "entity.md"], page("Foo Page", "org"));
    put(["data", "entities", "products", "foo-new", "entity.md"], page("Foo New", "product"));
    expect(productFolders(v).map((f) => f.id).sort()).toEqual(["foo-app", "foo-new", "foo-page"]);
    expect(productDir(v, "foo-app")).toBe(join(v, ...LEGACY_APPS, "foo-app"));
    expect(productWriteDir(v, "foo-app")).toBe(join(v, "data", "entities", "products", "foo-app"));
    expect(listPages(v).map((p) => `${p.id}:${p.kind}`).sort()).toEqual(["product/foo-new:product", "product/foo-page:product"]);
    expect(listProducts(v).map((p) => p.id)).toContain("product/foo-app");
  });

  test("once a migration record exists the legacy trees are ignored (synced leftovers)", () => {
    put([...LEGACY_APPS, "foo-app", "manifest.json"], JSON.stringify({ id: "foo-app" }));
    put(["build", "_meta", "migrations", "products.foo-host.json"], "{}");
    expect(productsMigrationRecorded(v)).toBe(true);
    expect(productFolders(v)).toEqual([]);
    expect(productDir(v, "foo-app")).toBe(join(v, "data", "entities", "products", "foo-app"));
  });
});
