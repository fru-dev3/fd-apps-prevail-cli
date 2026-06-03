import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeEmbedding,
  decodeEmbedding,
  dot,
  formatRecallContext,
} from "./memory.ts";

describe("encodeEmbedding / decodeEmbedding round-trip", () => {
  test("preserves vector values within float precision", () => {
    const v = [0.12345, -0.54321, 1.0, -1.0, 0.0001, 0.99999, 0.5, 0.25];
    const round = decodeEmbedding(encodeEmbedding(v));
    expect(round).not.toBeNull();
    expect(round!.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(round![i]! - v[i]!)).toBeLessThan(1e-5);
    }
  });

  test("non-embed line returns null", () => {
    expect(decodeEmbedding("just text")).toBeNull();
    expect(decodeEmbedding("<!-- prevail-meta: id=x -->")).toBeNull();
  });

  test("too-short vector returns null (guards against malformed lines)", () => {
    expect(decodeEmbedding("<!-- prevail-embed: 1,2,3 -->")).toBeNull();
  });
});

describe("dot product", () => {
  test("orthogonal vectors → 0", () => {
    expect(dot([1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0])).toBe(0);
  });
  test("identical vectors → magnitude squared", () => {
    expect(dot([1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1])).toBe(8);
  });
  test("mismatched lengths → 0 (safe)", () => {
    expect(dot([1, 2, 3], [1, 2, 3, 4])).toBe(0);
  });
});

describe("formatRecallContext", () => {
  test("empty hits → empty string", () => {
    expect(formatRecallContext([])).toBe("");
  });
  test("hits get rendered with score + domain + date", () => {
    const out = formatRecallContext([
      {
        domain: "wealth",
        file: "/tmp/x.md",
        excerpt: "## 09:00\nQ: should I prepay?\nA: yes",
        score: 0.78,
        ts: Date.parse("2026-01-15T09:00:00Z"),
      },
    ]);
    expect(out).toContain("wealth");
    expect(out).toContain("0.78");
    expect(out).toContain("2026-01-15");
    expect(out).toContain("<context");
    expect(out).toContain("</context>");
  });
});
