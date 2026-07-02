// browser-driver — the single fixed Playwright driver, run as a hidden
// subcommand of the prevail binary (`prevail __browser-driver`). Spawned as a
// child by the host below; speaks newline-delimited JSON over stdin/stdout.
//
// Why a subcommand and not a separate .mjs: the engine is one bun-compiled
// binary, and playwright-core is loaded at runtime from an on-disk sidecar next
// to the executable (see playwright-resolve.ts; bun --compile cannot make
// playwright-core resolvable inside /$bunfs). Re-spawning ourselves in driver
// mode needs no Node and no extra runtime, while still isolating the browser in
// its own process with a MINIMAL env (never the vault DEK / provider keys).
//
// Security invariants enforced here, in code:
//   * The child receives only PATH/HOME/DISPLAY/PLAYWRIGHT_* — set by the host.
//   * Page actions are DATA (locators, refs, text), never code to eval.
//   * The model targets opaque refs ("e12"); the child maps ref → element via a
//     `data-pv-ref` attribute it stamps during snapshot. Selectors never round-
//     trip through the model.
//   * Every value in a snapshot is redacted before it leaves this process.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSnapshot } from "./browser-actions.ts";
import type { Locator, PageSnapshot, SnapshotElement } from "./browser-actions.ts";
import { loadPlaywrightCore, PLAYWRIGHT_UNAVAILABLE_MESSAGE } from "./playwright-resolve.ts";

// ---------------------------------------------------------------------------
// Wire protocol (host ⇄ child)
// ---------------------------------------------------------------------------

export interface OpenRequest {
  startUrl?: string;
  profileDir?: string; // persistent context dir; if absent, use storageState
  statePath?: string; // storageState file (session: state)
  downloadsDir: string; // where captured downloads are saved
  headed: boolean;
  chromiumPath?: string; // explicit executablePath; else PLAYWRIGHT_BROWSERS_PATH
  domainAllow?: string[]; // hostnames the browser may navigate to (+ SSO)
  viewport?: { width: number; height: number };
}

// A driver command sent on the child's stdin (one JSON line).
export type DriverCommand =
  | { cmd: "open"; req: OpenRequest }
  | { cmd: "snapshot" }
  | { cmd: "act"; ref?: string; kind: string; url?: string; text?: string; option?: string; key?: string; to?: string; timeout_ms?: number }
  | { cmd: "replay_step"; step: ReplayStepWire; index: number }
  | { cmd: "wait_success"; successUrlContains?: string; successSelector?: string; timeout_ms: number }
  | { cmd: "save_state"; statePath: string }
  | { cmd: "close" };

export interface ReplayStepWire {
  action: string;
  url?: string;
  locator?: Locator;
  fallback?: Locator;
  value?: string;
  option?: string;
  key?: string;
  selector?: string;
  max?: number;
  saveAs?: string;
  to?: string;
  timeout_sec?: number;
  expect?: Record<string, unknown>;
}

// A driver event emitted on the child's stdout (one JSON line).
export type DriverEvent =
  | { event: "opened"; url: string }
  | { event: "snapshot"; snapshot: PageSnapshot }
  | { event: "acted"; ok: boolean; ref?: string; targetName?: string; error?: string }
  | { event: "nav"; url: string }
  | { event: "awaiting_user"; reason: string }
  | { event: "user_resumed"; url: string }
  | { event: "download"; name: string; path: string; bytes: number }
  | { event: "step_done"; index: number; ok: boolean; error?: string; downloads: number }
  | { event: "state_saved"; path: string }
  | { event: "error"; message: string; recoverable?: boolean }
  | { event: "closed" };

// ---------------------------------------------------------------------------
// Host — spawns and talks to the child
// ---------------------------------------------------------------------------

// How the child is launched. In a compiled binary, re-exec ourselves with the
// hidden subcommand. In dev (running from source), execPath is `bun` and we
// must pass the entry script too.
function driverSpawnArgs(): { cmd: string; args: string[] } {
  const exec = process.execPath;
  const isBun = /(?:^|\/)bun$/.test(exec);
  // Compiled binary: execPath IS the prevail engine → self-exec the subcommand.
  // Dev (running under `bun`): re-run the engine entry next to this module
  // (src/index.tsx), independent of whichever harness owns process.argv[1].
  if (isBun) {
    const entry = join(import.meta.dir, "index.tsx");
    return { cmd: exec, args: [entry, "__browser-driver"] };
  }
  return { cmd: exec, args: ["__browser-driver"] };
}

// Minimal env for the browser child (the O46 discipline): enough to find the
// browser + display, never the parent's secrets.
function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DISPLAY: process.env.DISPLAY,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    PREVAIL_CHROMIUM_PATH: process.env.PREVAIL_CHROMIUM_PATH,
    // Lets the spawned driver child resolve the same on-disk sidecar
    // playwright-core the parent did (see playwright-resolve.ts).
    PREVAIL_PLAYWRIGHT_CORE: process.env.PREVAIL_PLAYWRIGHT_CORE,
    ...extra,
  };
}

// Ensure Playwright's Chromium is present, auto-downloading it on first browser
// use (it is NOT bundled in the signed app). Runs the install in a SEPARATE
// child so its progress never touches the caller's stdout. Resolves once
// Chromium is available (or rejects if the download fails / offline). Emits a
// coarse {phase:"chromium_download"} so the desktop can show a one-time wait.
export async function ensureChromium(emit?: (e: Record<string, unknown>) => void): Promise<void> {
  const pw = await loadPlaywrightCore();
  let exe = "";
  try {
    exe = (pw as { chromium: { executablePath(): string } }).chromium.executablePath();
  } catch {
    exe = "";
  }
  const fs = await import("node:fs");
  if (exe && fs.existsSync(exe)) return; // already installed
  emit?.({ phase: "chromium_download", status: "start" });
  const { cmd, args } = driverSpawnArgs();
  const installArgs = args.map((a) => (a === "__browser-driver" ? "__install-chromium" : a));
  if (!installArgs.includes("__install-chromium")) installArgs.push("__install-chromium");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, installArgs, { env: childEnv(), stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`chromium install exited ${code}`))));
  });
  emit?.({ phase: "chromium_download", status: "done" });
}

export class BrowserDriverHost {
  private child: ChildProcess | null = null;
  private buf = "";
  private listeners = new Set<(e: DriverEvent) => void>();
  private closed = false;

  start(): void {
    if (this.child) return;
    const { cmd, args } = driverSpawnArgs();
    this.child = spawn(cmd, args, { env: childEnv(), stdio: ["pipe", "pipe", "inherit"] });
    this.child.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let ev: DriverEvent | null = null;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev) for (const l of this.listeners) l(ev);
      }
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const l of this.listeners) l({ event: "closed" });
    });
    this.child.on("error", (e) => {
      for (const l of this.listeners) l({ event: "error", message: String(e?.message || e) });
    });
  }

  on(fn: (e: DriverEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(cmd: DriverCommand): void {
    if (this.closed || !this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(cmd) + "\n");
  }

  // Send a command and resolve on the first event whose `event` is in `until`.
  async request(cmd: DriverCommand, until: DriverEvent["event"][], timeoutMs: number): Promise<DriverEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`driver: timed out waiting for ${until.join("/")}`));
      }, timeoutMs);
      const off = this.on((e) => {
        if (until.includes(e.event) || e.event === "error" || e.event === "closed") {
          clearTimeout(timer);
          off();
          resolve(e);
        }
      });
      this.send(cmd);
    });
  }

  async stop(): Promise<void> {
    if (!this.child || this.closed) return;
    try {
      this.send({ cmd: "close" });
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200));
    try {
      this.child.kill();
    } catch {
      /* gone */
    }
  }
}

// Adapt a live BrowserDriverHost to the DriverLike interface the agent loop
// expects. Tracks download events globally so act() can report a per-action
// delta, and forwards driver events to an optional sink (for desktop streaming).
export function makeHostDriver(host: BrowserDriverHost, onEvent?: (e: DriverEvent) => void): {
  open(req: { startUrl: string; profileDir?: string; statePath?: string; downloadsDir: string; headed: boolean; domainAllow?: string[] }): Promise<{ url: string }>;
  snapshot(): Promise<PageSnapshot>;
  act(cmd: { ref?: string; kind: string; url?: string; text?: string; option?: string; key?: string; to?: string; timeout_ms?: number }): Promise<{ ok: boolean; targetName?: string; error?: string; downloads: number; snapshot: PageSnapshot }>;
  waitUser(opts: { successUrlContains?: string; successSelector?: string; timeout_ms: number }): Promise<boolean>;
  close(): Promise<void>;
  downloads(): number;
} {
  let downloadCount = 0;
  host.on((e) => {
    if (e.event === "download") downloadCount++;
    onEvent?.(e);
  });
  host.start();
  return {
    async open(req) {
      const ev = await host.request({ cmd: "open", req: { ...req, downloadsDir: req.downloadsDir } }, ["opened"], 60_000);
      if (ev.event === "error") throw new Error(ev.message);
      return { url: ev.event === "opened" ? ev.url : "" };
    },
    async snapshot() {
      const ev = await host.request({ cmd: "snapshot" }, ["snapshot"], 20_000);
      if (ev.event !== "snapshot") throw new Error(ev.event === "error" ? ev.message : "no snapshot");
      return ev.snapshot;
    },
    async act(cmd) {
      const before = downloadCount;
      let acted: { ok: boolean; targetName?: string; error?: string } = { ok: false };
      const off = host.on((e) => {
        if (e.event === "acted") acted = { ok: e.ok, targetName: e.targetName, error: e.error };
      });
      // The child emits `acted` then `snapshot` for an act command.
      const ev = await host.request({ cmd: "act", ...cmd }, ["snapshot"], (cmd.timeout_ms || 20_000) + 10_000);
      off();
      if (ev.event !== "snapshot") throw new Error(ev.event === "error" ? ev.message : "act produced no snapshot");
      return { ...acted, downloads: downloadCount - before, snapshot: ev.snapshot };
    },
    async waitUser(opts) {
      const ev = await host.request({ cmd: "wait_success", ...opts }, ["user_resumed"], opts.timeout_ms + 10_000);
      return ev.event === "user_resumed";
    },
    async close() {
      await host.stop();
    },
    downloads: () => downloadCount,
  };
}

// ---------------------------------------------------------------------------
// Child — the actual Playwright driver (only runs inside `__browser-driver`)
// ---------------------------------------------------------------------------

// Stamps every meaningful interactive element with data-pv-ref and returns the
// compact element list. Runs INSIDE the page (serialized to a string for
// evaluate); it never receives model input, so this is safe fixed code.
const SNAPSHOT_FN = `(() => {
  const els = [];
  let i = 0;
  const sel = 'a,button,select,input,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++i);
    el.setAttribute('data-pv-ref', ref);
    const isPassword = el.tagName === 'INPUT' && (el.type === 'password');
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || '').toString().trim().slice(0, 80);
    els.push({
      ref,
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name,
      value: isPassword ? '[password]' : (el.value ? String(el.value).slice(0, 40) : undefined),
      isPassword,
      href: el.getAttribute('href') || undefined,
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
    });
    if (i >= 200) break;
  }
  return els;
})()`;

async function buildSnapshot(page: any): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  let aria = "";
  try {
    aria = await page.locator("body").ariaSnapshot();
  } catch {
    aria = "";
  }
  let elements: SnapshotElement[] = [];
  try {
    elements = (await page.evaluate(SNAPSHOT_FN)) || [];
  } catch {
    elements = [];
  }
  // Collect live credential-field values (password/OTP) so we can scrub them
  // out of the aria tree + names. Playwright's ariaSnapshot echoes textbox
  // values, so a human-typed password lingering in a field would otherwise
  // reach the model. These stay inside the driver process and are discarded
  // immediately after scrubbing — never emitted, never sent to a model.
  let secrets: string[] = [];
  try {
    secrets =
      (await page.evaluate(
        "(() => [...document.querySelectorAll('input[type=password],input[autocomplete*=one-time-code],input[name*=otp],input[id*=otp]')].map(e=>e.value).filter(v=>v&&v.length>=2))()",
      )) || [];
  } catch {
    secrets = [];
  }
  const maskSecrets = (s: string): string => {
    let o = s;
    for (const sec of secrets) if (sec) o = o.split(sec).join("••••");
    return o;
  };
  // Redact (numeric shapes) + scrub (live credential values) before emit.
  for (const el of elements) {
    if (el.name) el.name = maskSecrets(redactSnapshot(el.name));
    if (el.value) el.value = maskSecrets(redactSnapshot(el.value));
  }
  return { url, title, aria: maskSecrets(redactSnapshot(aria)).slice(0, 12000), elements };
}

function hostnameOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

function domainAllowed(url: string, allow?: string[]): boolean {
  if (!allow || allow.length === 0) return true;
  const h = hostnameOf(url);
  if (!h) return false;
  // Common SSO/auth hosts are always allowed so login flows don't trip the pin.
  const SSO = ["accounts.google.com", "login.microsoftonline.com", "okta.com", "auth0.com", "duosecurity.com", "id.apple.com"];
  return allow.some((a) => h === a || h.endsWith("." + a)) || SSO.some((s) => h === s || h.endsWith("." + s));
}

function resolveLocator(page: any, loc: Locator): any {
  if (loc.role && loc.name) return page.getByRole(loc.role, { name: loc.name }).first();
  if (loc.label) return page.getByLabel(loc.label).first();
  if (loc.text) return page.getByText(loc.text, { exact: false }).first();
  if (loc.testid) return page.getByTestId(loc.testid).first();
  if (loc.css) return page.locator(loc.css).first();
  return page.locator("__pv_no_match__");
}

// The child entry. Invoked from index.tsx when argv contains __browser-driver.
export async function runBrowserDriverChild(): Promise<void> {
  const emit = (e: DriverEvent) => process.stdout.write(JSON.stringify(e) + "\n");
  let pw: any;
  try {
    // Resolves the on-disk sidecar playwright-core for the compiled binary; see
    // playwright-resolve.ts. Falls back to the bundled specifier in dev.
    pw = await loadPlaywrightCore();
  } catch (e) {
    // Keep the raw cause on stderr (inherited) for debugging, but surface a
    // clear, actionable message to the user instead of the module-not-found dump.
    try {
      process.stderr.write("prevail: browser engine unavailable: " + String((e as Error)?.message || e) + "\n");
    } catch {
      /* ignore */
    }
    emit({ event: "error", message: PLAYWRIGHT_UNAVAILABLE_MESSAGE });
    return;
  }

  let context: any = null;
  let page: any = null;
  let downloadsDir = "";
  let downloadCount = 0;
  let domainAllow: string[] | undefined;

  const attachDownloads = (p: any) => {
    p.on("download", async (dl: any) => {
      try {
        const name = (dl.suggestedFilename && dl.suggestedFilename()) || `download-${Date.now()}`;
        const target = join(downloadsDir, `${Date.now()}_${name}`.replace(/[^A-Za-z0-9._-]/g, "_"));
        await dl.saveAs(target);
        downloadCount++;
        const bytes = await dl
          .path()
          .then((pth: string) => (pth ? require("node:fs").statSync(target).size : 0))
          .catch(() => 0);
        emit({ event: "download", name, path: target, bytes });
      } catch (e) {
        emit({ event: "error", message: "download failed: " + String((e as Error)?.message || e), recoverable: true });
      }
    });
  };

  const open = async (req: OpenRequest) => {
    downloadsDir = req.downloadsDir;
    domainAllow = req.domainAllow;
    mkdirSync(downloadsDir, { recursive: true });
    // Drive the user's INSTALLED Google Chrome (channel:"chrome") so logins use
    // their real browser, and ALWAYS run in a persistent profile so a one-time
    // Google sign-in survives across every later run — no 120MB Chromium
    // download. An explicit chromiumPath (a bundled Chromium) overrides as a
    // fallback for machines without Chrome.
    const execPath = req.chromiumPath || process.env.PREVAIL_CHROMIUM_PATH || undefined;
    const baseOpts: any = { headless: !req.headed, acceptDownloads: true, viewport: req.viewport || { width: 1280, height: 860 } };
    if (execPath) baseOpts.executablePath = execPath;
    else baseOpts.channel = "chrome";
    const profileDir = req.profileDir || join(downloadsDir, "..", "auth", "profile");
    mkdirSync(profileDir, { recursive: true });
    try {
      context = await pw.chromium.launchPersistentContext(profileDir, baseOpts);
    } catch (e) {
      // Chrome not found (no channel) and no bundled Chromium → last-resort the
      // default Playwright Chromium (requires ensureChromium to have installed it).
      if (baseOpts.channel) {
        delete baseOpts.channel;
        context = await pw.chromium.launchPersistentContext(profileDir, baseOpts);
      } else {
        throw e;
      }
    }
    page = context.pages()[0] || (await context.newPage());
    attachDownloads(page);
    context.on("page", (p: any) => attachDownloads(p));
    // Domain pinning: block top-level navigations off the allowlist.
    page.on("framenavigated", (frame: any) => {
      if (frame === page.mainFrame() && !domainAllowed(frame.url(), domainAllow)) {
        emit({ event: "error", message: `blocked off-domain navigation: ${hostnameOf(frame.url())}`, recoverable: true });
      }
    });
    if (req.startUrl) {
      await page.goto(req.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    }
    emit({ event: "opened", url: page.url() });
  };

  const performAct = async (c: Extract<DriverCommand, { cmd: "act" }>) => {
    try {
      const target = c.ref ? page.locator(`[data-pv-ref="${c.ref}"]`).first() : null;
      const targetName = target ? await target.getAttribute("aria-label").catch(() => "") : "";
      switch (c.kind) {
        case "navigate":
          if (!domainAllowed(c.url || "", domainAllow)) {
            emit({ event: "acted", ok: false, error: "off-domain navigation refused" });
            return;
          }
          await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: c.timeout_ms || 45000 });
          break;
        case "click":
          await target.click({ timeout: c.timeout_ms || 15000 });
          break;
        case "fill":
          await target.fill(c.text || "", { timeout: c.timeout_ms || 15000 });
          break;
        case "select":
          await target.selectOption({ label: c.option }, { timeout: c.timeout_ms || 15000 }).catch(async () => {
            await target.selectOption(c.option, { timeout: c.timeout_ms || 15000 });
          });
          break;
        case "press_key":
          await page.keyboard.press(c.key || "Enter");
          break;
        case "scroll":
          if (c.to === "bottom") await page.mouse.wheel(0, 20000);
          else if (c.to === "top") await page.evaluate("window.scrollTo(0,0)");
          else if (target) await target.scrollIntoViewIfNeeded();
          break;
        case "wait_for":
          if (c.text) await page.getByText(c.text, { exact: false }).first().waitFor({ timeout: c.timeout_ms || 15000 });
          else await page.waitForTimeout(Math.min(c.timeout_ms || 1500, 10000));
          break;
        case "download":
          await Promise.all([
            page.waitForEvent("download", { timeout: c.timeout_ms || 20000 }).catch(() => {}),
            target.click({ timeout: c.timeout_ms || 15000 }),
          ]);
          break;
        default:
          emit({ event: "acted", ok: false, error: `unknown act kind ${c.kind}` });
          return;
      }
      emit({ event: "acted", ok: true, ref: c.ref, targetName: targetName || undefined });
    } catch (e) {
      emit({ event: "acted", ok: false, ref: c.ref, error: String((e as Error)?.message || e).slice(0, 200) });
    }
  };

  const replayStep = async (step: ReplayStepWire, index: number) => {
    const before = downloadCount;
    try {
      switch (step.action) {
        case "navigate":
          await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: (step.timeout_sec || 45) * 1000 });
          break;
        case "click": {
          let el = resolveLocator(page, step.locator || {});
          if ((await el.count()) === 0 && step.fallback) el = resolveLocator(page, step.fallback);
          await el.click({ timeout: (step.timeout_sec || 15) * 1000 });
          break;
        }
        case "fill": {
          const el = resolveLocator(page, step.locator || {});
          await el.fill(step.value || "", { timeout: (step.timeout_sec || 15) * 1000 });
          break;
        }
        case "select": {
          const el = resolveLocator(page, step.locator || {});
          await el.selectOption({ label: step.option }).catch(() => el.selectOption(step.option));
          break;
        }
        case "press":
          await page.keyboard.press(step.key || "Enter");
          break;
        case "scroll":
          if (step.to === "bottom") await page.mouse.wheel(0, 20000);
          break;
        case "wait_for": {
          const el = resolveLocator(page, step.locator || {});
          await el.waitFor({ timeout: (step.timeout_sec || 15) * 1000 });
          break;
        }
        case "download": {
          const el = resolveLocator(page, step.locator || {});
          await Promise.all([page.waitForEvent("download", { timeout: (step.timeout_sec || 20) * 1000 }).catch(() => {}), el.click()]);
          break;
        }
        case "download_all_links": {
          const links = await page.locator(step.selector || "a[href$='.pdf']").elementHandles();
          const cap = Math.min(links.length, step.max || 24);
          for (let i = 0; i < cap; i++) {
            await Promise.all([page.waitForEvent("download", { timeout: 20000 }).catch(() => {}), links[i].click().catch(() => {})]);
          }
          break;
        }
      }
      // Verify the step's expect marker (drift detection).
      const ok = await verifyExpect(page, step.expect, downloadCount - before);
      emit({ event: "step_done", index, ok, downloads: downloadCount - before, error: ok ? undefined : "expect marker not met" });
    } catch (e) {
      emit({ event: "step_done", index, ok: false, downloads: downloadCount - before, error: String((e as Error)?.message || e).slice(0, 200) });
    }
  };

  // stdin command loop
  let stdinBuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    stdinBuf += chunk;
    let nl: number;
    while ((nl = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, nl).trim();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (!line) continue;
      let c: DriverCommand;
      try {
        c = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        if (c.cmd === "open") await open(c.req);
        else if (c.cmd === "snapshot") emit({ event: "snapshot", snapshot: await buildSnapshot(page) });
        else if (c.cmd === "act") {
          await performAct(c);
          emit({ event: "snapshot", snapshot: await buildSnapshot(page) });
        } else if (c.cmd === "replay_step") await replayStep(c.step, c.index);
        else if (c.cmd === "wait_success") {
          const ok = await waitSuccess(page, c, emit, domainAllow);
          if (ok) emit({ event: "user_resumed", url: page.url() });
          else emit({ event: "error", message: "login not detected before timeout" });
        } else if (c.cmd === "save_state") {
          await context.storageState({ path: c.statePath });
          emit({ event: "state_saved", path: c.statePath });
        } else if (c.cmd === "close") {
          try {
            await context?.close();
          } catch {
            /* ignore */
          }
          emit({ event: "closed" });
          process.exit(0);
        }
      } catch (e) {
        emit({ event: "error", message: String((e as Error)?.message || e).slice(0, 200), recoverable: true });
      }
    }
  });
}

async function verifyExpect(page: any, expect: Record<string, unknown> | undefined, downloadsThisStep: number): Promise<boolean> {
  if (!expect) return true;
  try {
    if (typeof expect.url_matches === "string") return page.url().includes(expect.url_matches);
    if (typeof expect.text === "string") return (await page.getByText(expect.text, { exact: false }).count()) > 0;
    if (typeof expect.gone === "string") return (await page.locator(expect.gone).count()) === 0;
    if (expect.download === true) return downloadsThisStep > 0;
    if (typeof expect.min_downloads === "number") return downloadsThisStep >= expect.min_downloads;
  } catch {
    return false;
  }
  return true;
}

async function waitSuccess(
  page: any,
  c: Extract<DriverCommand, { cmd: "wait_success" }>,
  emit: (e: DriverEvent) => void,
  domainAllow?: string[],
): Promise<boolean> {
  emit({ event: "awaiting_user", reason: "login" });
  const start = Date.now();
  while (Date.now() - start < c.timeout_ms) {
    if (c.successUrlContains && page.url().includes(c.successUrlContains)) return true;
    if (c.successSelector) {
      try {
        if ((await page.locator(c.successSelector).count()) > 0) return true;
      } catch {
        /* navigation in flight */
      }
    }
    await page.waitForTimeout(1500);
  }
  return false;
}
