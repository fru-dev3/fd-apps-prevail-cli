// Self-update for the compiled `prevail` binary.
//
// Strategy: hit GitHub's "latest release" endpoint, compare the tag to the
// VERSION constant, pick the right platform asset, download to tmpdir, verify
// SHA-256 against the published .sha256 sidecar if one is present, then
// atomically rename(2) over process.execPath.
//
// rename(2) on the same filesystem is atomic on macOS APFS and Linux ext4/btrfs/
// xfs, so a half-written replacement can never be observed. We always download
// into the same directory as the current binary so the rename stays on one
// filesystem (otherwise rename falls back to copy + unlink, which is NOT atomic).
//
// We refuse to apply the upgrade when the current binary lives somewhere the
// running user can't write (e.g. /opt/homebrew/bin under a brew install).
// In that case we tell the user to `brew upgrade prevail` instead — silently
// failing or asking for sudo would be worse than punting.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VERSION } from "./version.ts";

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/fru-dev3/prevail/releases";
const GITHUB_LATEST_URL = `${GITHUB_RELEASES_URL}/latest`;

export interface UpdateInfo {
  current: string;
  latest: string;
  binaryUrl: string | null;
  releaseUrl: string;
  sha256Url: string | null;
  isNewer: boolean;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GitHubAsset[];
}

/**
 * Returns the `<platform>-<arch>` slug we use to identify the right release
 * asset for the current host. Examples: "darwin-arm64", "linux-x64".
 *
 * Until v1.1.1 this returned a full binary name like "prevail-darwin-arm64"
 * and the asset matcher did an exact-string equality. That broke when the
 * release workflow shipped tarballs as "prevail-v1.1.1-darwin-arm64.tar.gz"
 * — no exact match, upgrade silently said "no binary for this platform"
 * and exited. The slug-only form lets the matcher accept any asset whose
 * name contains the platform+arch substring (raw binary, tarball, zip).
 */
export function platformSlug(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const archMap: Record<string, string> = { arm64: "arm64", x64: "x64" };
  const mappedArch = archMap[arch];
  if (!mappedArch) {
    throw new Error(
      `unsupported architecture: ${arch}. prevail ships binaries for x64 and arm64 only.`,
    );
  }
  if (platform === "darwin") return `darwin-${mappedArch}`;
  if (platform === "linux") return `linux-${mappedArch}`;
  throw new Error(
    `unsupported platform: ${platform}. prevail ships binaries for darwin and linux only.`,
  );
}

/**
 * Backwards-compatible name kept for any caller still on the v1.0.x API.
 * New code should prefer platformSlug + the substring-match asset finder.
 */
export function platformBinaryName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `prevail-${platformSlug(platform, arch)}`;
}

/**
 * Strip a leading "v" from a tag (v1.2.3 → 1.2.3). Returns the raw input
 * if there's no "v" prefix.
 */
function normalizeVersion(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

/**
 * Semver-ish comparison: returns true iff `candidate` is strictly newer than
 * `baseline`. Handles numeric MAJOR.MINOR.PATCH only — pre-release suffixes
 * are ignored after the first non-numeric character in any segment.
 *
 * This is deliberately not a full semver impl. It's enough for our release
 * cadence (0.x.y) and avoids pulling in a dependency for one comparison.
 */
export function isNewer(candidate: string, baseline: string): boolean {
  const parse = (v: string): number[] => {
    const stripped = normalizeVersion(v);
    return stripped
      .split(/[.+-]/)
      .map((seg) => {
        const n = parseInt(seg, 10);
        return Number.isFinite(n) ? n : 0;
      })
      .slice(0, 3);
  };
  const a = parse(candidate);
  const b = parse(baseline);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

interface CheckOptions {
  includePrerelease?: boolean;
  fetcher?: (url: string) => Promise<Response>;
}

async function fetchJson<T>(
  url: string,
  fetcher: (url: string) => Promise<Response>,
): Promise<T> {
  const res = await fetcher(url);
  if (!res.ok) {
    throw new Error(
      `GitHub API ${url} responded ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

async function findLatestRelease(
  opts: CheckOptions,
): Promise<GitHubRelease> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  if (!opts.includePrerelease) {
    return fetchJson<GitHubRelease>(GITHUB_LATEST_URL, fetcher);
  }
  // The /latest endpoint silently skips prereleases. When --pre is set we
  // list all releases and pick the first non-draft one (GitHub returns them
  // in reverse-chronological order).
  const all = await fetchJson<GitHubRelease[]>(GITHUB_RELEASES_URL, fetcher);
  const release = all.find((r) => !r.draft);
  if (!release) throw new Error("no releases found on GitHub");
  return release;
}

function defaultFetcher(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `prevail/${VERSION}`,
    },
  });
}

/**
 * Hit GitHub, find the latest release, and return everything the upgrade
 * flow needs: current version, latest tag, the platform binary URL, the
 * checksum sidecar URL (if any), and the release page URL.
 */
export async function checkForUpdate(
  opts: CheckOptions = {},
): Promise<UpdateInfo> {
  const release = await findLatestRelease(opts);
  const latest = normalizeVersion(release.tag_name);
  const assets = release.assets ?? [];
  const slug = platformSlug();
  // Substring match — accepts the current "prevail-v1.1.1-darwin-arm64.tar.gz"
  // tarball convention AND raw-binary names like "prevail-darwin-arm64" if
  // we ever go back to that. The first asset that contains the slug and is
  // NOT a checksum sidecar wins. Preference: tarballs first (current
  // convention), raw binaries as a fallback.
  const matching = assets.filter(
    (a) => a.name.includes(slug) && !a.name.endsWith(".sha256"),
  );
  const tarball = matching.find((a) => a.name.endsWith(".tar.gz"));
  const rawBinary = matching.find(
    (a) => !a.name.endsWith(".tar.gz") && !a.name.endsWith(".zip"),
  );
  const binary = tarball ?? rawBinary ?? null;
  const checksum = binary
    ? assets.find((a) => a.name === `${binary.name}.sha256`)
    : undefined;
  return {
    current: VERSION,
    latest,
    binaryUrl: binary?.browser_download_url ?? null,
    sha256Url: checksum?.browser_download_url ?? null,
    releaseUrl: release.html_url,
    isNewer: isNewer(latest, VERSION),
  };
}

/**
 * If the downloaded artifact is a tarball, extract it to a fresh tmpdir and
 * return the path to the `prevail` binary inside. Otherwise (raw binary),
 * return the input path unchanged.
 *
 * The tarballs built by `.github/workflows/release.yml` contain a single
 * file named exactly `prevail` (the bun --compile output). We tolerate
 * a couple of layouts: top-level `prevail`, top-level `prevail-<slug>`,
 * or a single directory containing one of those.
 */
export function extractIfArchive(downloadedPath: string): string {
  if (!downloadedPath.endsWith(".tar.gz") && !downloadedPath.endsWith(".tgz")) {
    return downloadedPath;
  }
  const extractDir = mkdtempSync(join(tmpdir(), "prevail-upgrade-"));
  // Pass arg array, not shell:true — we control both the binary name (tar)
  // and the args. No user-provided content can land here as a shell token.
  const result = spawnSync("tar", ["-xzf", downloadedPath, "-C", extractDir], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to extract tarball ${downloadedPath} (tar exited ${result.status})`,
    );
  }
  // Walk one level deep looking for the binary. Accept: prevail, or anything
  // matching prevail-<platform>-<arch>. Skip directories.
  const candidates: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (entry === "prevail" || /^prevail(-[a-z0-9-]+)?$/.test(entry)) {
        candidates.push(full);
      }
    }
  };
  walk(extractDir, 0);
  if (candidates.length === 0) {
    throw new Error(
      `extracted tarball did not contain a recognizable 'prevail' binary (looked under ${extractDir})`,
    );
  }
  // Prefer the literal "prevail" name; fall back to the first slug-suffixed
  // binary if the tarball was built with the per-platform naming.
  const literal = candidates.find((p) => /\/prevail$/.test(p));
  return literal ?? candidates[0]!;
}

/**
 * Streams the binary from `url` to `targetPath`. If `sha256Url` is provided,
 * fetches the expected hex digest and compares it against the SHA-256 of the
 * downloaded bytes; throws (and deletes the partial file) on mismatch.
 *
 * The published checksum file format is `<hex>  <filename>\n` — same shape
 * as `shasum -a 256`. We tolerate either just the hex digest or the full
 * shasum-style line.
 */
export async function downloadBinary(
  url: string,
  sha256Url: string | null,
  targetPath: string,
  fetcher: (url: string) => Promise<Response> = defaultFetcher,
): Promise<void> {
  const res = await fetcher(url);
  if (!res.ok || !res.body) {
    throw new Error(
      `download failed: ${url} responded ${res.status} ${res.statusText}`,
    );
  }
  const hash = createHash("sha256");
  const sink = createWriteStream(targetPath, { mode: 0o755 });
  // Tee the body: every chunk goes both to the file and into the hash.
  const tee = new TransformStreamTap(hash);
  // Node's Readable.fromWeb gives us a Node stream from the Web ReadableStream
  // that fetch returns, so we can use stream.pipeline for backpressure.
  const nodeBody = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    await pipeline(nodeBody, tee, sink);
  } catch (err) {
    safeUnlink(targetPath);
    throw err;
  }
  if (sha256Url) {
    const expected = await fetchExpectedDigest(sha256Url, fetcher);
    const actual = hash.digest("hex").toLowerCase();
    if (expected !== actual) {
      safeUnlink(targetPath);
      throw new Error(
        `checksum mismatch — expected ${expected}, got ${actual}. download was corrupted or tampered with.`,
      );
    }
  }
}

import { Transform } from "node:stream";

/**
 * Passthrough transform that also feeds every chunk into the provided hash.
 * Keeping it as a class (rather than a Transform({ transform: ... })) makes
 * it easy to name in stack traces.
 */
class TransformStreamTap extends Transform {
  constructor(private readonly hash: ReturnType<typeof createHash>) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _enc: string,
    cb: (err?: Error | null) => void,
  ): void {
    this.hash.update(chunk);
    this.push(chunk);
    cb();
  }
}

async function fetchExpectedDigest(
  url: string,
  fetcher: (url: string) => Promise<Response>,
): Promise<string> {
  const res = await fetcher(url);
  if (!res.ok) {
    throw new Error(
      `checksum fetch failed: ${url} responded ${res.status} ${res.statusText}`,
    );
  }
  const text = (await res.text()).trim();
  // First whitespace-separated token is the hex digest, whether the file is
  // a raw "abc123..." or shasum-style "abc123...  prevail-darwin-arm64".
  const token = text.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new Error(
      `checksum file at ${url} did not contain a valid sha-256 hex digest`,
    );
  }
  return token.toLowerCase();
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best effort — if we can't clean up, the temp file will outlive us. No
    // point throwing a second error and masking the original failure.
  }
}

/**
 * Atomically replace `currentBinaryPath` with `downloadedPath`. Both must
 * sit on the same filesystem (the caller is expected to download into the
 * same directory as the running binary for this reason).
 *
 * Refuses to run if the current binary's directory isn't writable — that's
 * usually the brew-installed case under /opt/homebrew/bin, where the right
 * answer is `brew upgrade prevail` rather than a sudo dance.
 */
export async function applyUpgrade(
  downloadedPath: string,
  currentBinaryPath: string,
): Promise<void> {
  if (!isWritablePath(currentBinaryPath)) {
    safeUnlink(downloadedPath);
    throw new Error(
      `current binary at ${currentBinaryPath} is not writable. ` +
        (isLikelyBrewInstall(currentBinaryPath)
          ? "Looks like a Homebrew install — run `brew upgrade prevail` instead."
          : "Move it somewhere user-writable (e.g. ~/.local/bin) or run as the owning user."),
    );
  }
  // rename(2) is atomic when both paths live on the same filesystem. If the
  // download was placed in the binary's own directory (which the CLI does),
  // we're guaranteed that.
  renameSync(downloadedPath, currentBinaryPath);
}

/**
 * True iff the current process can write to the binary's directory AND the
 * binary itself (if it already exists). We check the *directory* because
 * rename(2) modifies the dir entry, not the file inode.
 */
function isWritablePath(binaryPath: string): boolean {
  const dir = dirname(binaryPath);
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch {
    return false;
  }
  if (existsSync(binaryPath)) {
    try {
      accessSync(binaryPath, fsConstants.W_OK);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Heuristic: are we running out of a Homebrew prefix? Used only to tailor
 * the error message; the actual upgrade decision uses real fs.access().
 */
function isLikelyBrewInstall(p: string): boolean {
  return (
    p.startsWith("/opt/homebrew/") ||
    p.startsWith("/usr/local/Cellar/") ||
    p.startsWith("/usr/local/bin/") ||
    p.includes("/Homebrew/")
  );
}

/**
 * The currently-running binary. For a compiled `bun build --compile` output
 * this is the prevail executable itself. When running via `bun run src/...`
 * it'll point at the bun runtime — the upgrade flow checks for that and
 * refuses to clobber it.
 */
export function currentBinaryPath(): string {
  return process.execPath;
}

/**
 * Read a published checksum file (offline helper, used by tests and by the
 * CLI's `--check` path if we ever want to surface the expected hash).
 */
export function parseShasumFile(contents: string): string | null {
  const token = contents.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}

// Re-exported for tests that want to feed a fixture file straight in.
export const _internal = {
  parseShasumFile,
  readFileSync,
  isWritablePath,
  isLikelyBrewInstall,
};
