import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { ErrorBoundary } from "./error-boundary.tsx";
import { debugLogPath } from "./debug-log.ts";

// Redirect ~/.prevail to a tmpdir per test so componentDidCatch's logDebug
// call writes there instead of polluting the real user log.
let prevDir: string | undefined;
let tmp: string;

beforeEach(() => {
  prevDir = process.env.PREVAIL_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), "prevail-eb-"));
  process.env.PREVAIL_DATA_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.PREVAIL_DATA_DIR;
  else process.env.PREVAIL_DATA_DIR = prevDir;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("ErrorBoundary", () => {
  test("getDerivedStateFromError flips hasError and stores the error", () => {
    const err = new Error("boom");
    const next = ErrorBoundary.getDerivedStateFromError(err);
    expect(next.hasError).toBe(true);
    expect(next.error).toBe(err);
  });

  test("constructor starts with hasError=false", () => {
    // Construct directly. React class components are just classes —
    // we don't need a renderer to verify initial state.
    const eb = new ErrorBoundary({ name: "X", children: null });
    expect(eb.state.hasError).toBe(false);
    expect(eb.state.error).toBeUndefined();
  });

  test("componentDidCatch writes a structured entry to debug.log", () => {
    const eb = new ErrorBoundary({ name: "ChatPane", children: null });
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n  at fake.tsx:1:1";
    eb.componentDidCatch(err, { componentStack: "\n    in ChatPane" });

    const file = debugLogPath();
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as {
      cat: string;
      msg: string;
      meta?: { message?: string; stack?: string; componentStack?: string };
    };
    expect(parsed.cat).toBe("react.errorboundary");
    expect(parsed.msg).toBe("ChatPane crashed");
    expect(parsed.meta?.message).toBe("kaboom");
    expect(parsed.meta?.stack).toContain("Error: kaboom");
    expect(parsed.meta?.componentStack).toContain("ChatPane");
  });

  test("componentDidCatch swallows logger failures", () => {
    // Even if logDebug couldn't write (it can't crash anyway), the
    // boundary's componentDidCatch must never throw — that would
    // make React re-throw and take down the cockpit.
    const eb = new ErrorBoundary({ name: "X", children: null });
    expect(() =>
      eb.componentDidCatch(new Error("e"), { componentStack: undefined }),
    ).not.toThrow();
  });

  test("render returns children when no error", () => {
    const child = React.createElement("text", null, "ok");
    const eb = new ErrorBoundary({ name: "X", children: child });
    // No error → state.hasError is false → render returns props.children.
    const out = eb.render();
    expect(out).toBe(child);
  });

  test("render returns the crashed view when hasError is true", () => {
    const eb = new ErrorBoundary({ name: "Sidebar", children: null });
    // Simulate React flipping our state via getDerivedStateFromError.
    eb.state = { hasError: true, error: new Error("oops") };
    const out = eb.render() as React.ReactElement;
    // It's a <box> with a flexDirection prop — sanity check that we
    // got a host element back, not the original children.
    expect(out).not.toBeNull();
    expect((out as { type: unknown }).type).toBe("box");
  });
});
