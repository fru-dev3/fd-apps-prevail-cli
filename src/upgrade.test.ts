import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VERSION } from "./version.ts";
import {
  _internal,
  checkForUpdate,
  isNewer,
  platformBinaryName,
} from "./upgrade.ts";

describe("platformBinaryName", () => {
  test("darwin arm64", () => {
    expect(platformBinaryName("darwin", "arm64")).toBe("prevail-darwin-arm64");
  });
  test("darwin x64", () => {
    expect(platformBinaryName("darwin", "x64")).toBe("prevail-darwin-x64");
  });
  test("linux arm64", () => {
    expect(platformBinaryName("linux", "arm64")).toBe("prevail-linux-arm64");
  });
  test("linux x64", () => {
    expect(platformBinaryName("linux", "x64")).toBe("prevail-linux-x64");
  });
  test("rejects unsupported platforms", () => {
    expect(() => platformBinaryName("win32" as NodeJS.Platform, "x64")).toThrow(
      /unsupported platform/,
    );
  });
  test("rejects unsupported architectures", () => {
    expect(() => platformBinaryName("darwin", "ia32")).toThrow(
      /unsupported architecture/,
    );
  });
});

describe("isNewer", () => {
  test("strictly greater patch", () => {
    expect(isNewer("0.9.1", "0.9.0")).toBe(true);
  });
  test("equal versions", () => {
    expect(isNewer("0.9.0", "0.9.0")).toBe(false);
  });
  test("strictly lower patch", () => {
    expect(isNewer("0.9.0", "0.9.1")).toBe(false);
  });
  test("minor bump", () => {
    expect(isNewer("0.10.0", "0.9.99")).toBe(true);
  });
  test("major bump", () => {
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });
  test("tolerates leading v", () => {
    expect(isNewer("v0.9.2", "0.9.1")).toBe(true);
    expect(isNewer("v0.9.1", "v0.9.1")).toBe(false);
  });
  test("ignores pre-release suffix", () => {
    // Equal numeric core → not newer (we don't decode pre-release ordering).
    expect(isNewer("0.9.0-beta.1", "0.9.0")).toBe(false);
  });
});

describe("parseShasumFile", () => {
  test("accepts shasum-style output", () => {
    const hash = "a".repeat(64);
    expect(_internal.parseShasumFile(`${hash}  prevail-darwin-arm64`)).toBe(
      hash,
    );
  });
  test("accepts raw hex digest", () => {
    const hash = "b".repeat(64);
    expect(_internal.parseShasumFile(`${hash}\n`)).toBe(hash);
  });
  test("rejects non-hex", () => {
    expect(_internal.parseShasumFile("not a hash")).toBeNull();
  });
  test("rejects wrong-length hex", () => {
    expect(_internal.parseShasumFile("ab".repeat(10))).toBeNull();
  });
  test("lowercases uppercase digests", () => {
    const upper = "A".repeat(64);
    expect(_internal.parseShasumFile(upper)).toBe(upper.toLowerCase());
  });
});

// Spin up a tiny HTTP server that pretends to be the GitHub Releases API.
// checkForUpdate accepts a custom fetcher, so the test points a wrapped
// `fetch` at this URL instead of going to api.github.com.
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/releases/latest")) {
        return Response.json({
          tag_name: "v99.99.99",
          html_url: "https://example.test/releases/v99.99.99",
          assets: [
            {
              name: platformBinaryName(),
              browser_download_url: `${baseUrl}/asset.bin`,
            },
            {
              name: `${platformBinaryName()}.sha256`,
              browser_download_url: `${baseUrl}/asset.bin.sha256`,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v99.99.100-beta.1",
            html_url: "https://example.test/releases/v99.99.100-beta.1",
            prerelease: true,
            draft: false,
            assets: [],
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

describe("checkForUpdate", () => {
  test("parses the latest release into UpdateInfo", async () => {
    const fetcher = (url: string) => {
      // Rewrite the github URL onto our local stub.
      const rewritten = url.replace(
        "https://api.github.com/repos/fru-dev3/prevail-cli",
        baseUrl,
      );
      return fetch(rewritten);
    };
    const info = await checkForUpdate({ fetcher });
    expect(info.current).toBe(VERSION);
    expect(info.latest).toBe("99.99.99");
    expect(info.isNewer).toBe(true);
    expect(info.binaryUrl).toBe(`${baseUrl}/asset.bin`);
    expect(info.sha256Url).toBe(`${baseUrl}/asset.bin.sha256`);
    expect(info.releaseUrl).toBe("https://example.test/releases/v99.99.99");
  });

  test("falls back to /releases when --pre is requested", async () => {
    const fetcher = (url: string) => {
      const rewritten = url.replace(
        "https://api.github.com/repos/fru-dev3/prevail-cli",
        baseUrl,
      );
      return fetch(rewritten);
    };
    const info = await checkForUpdate({ fetcher, includePrerelease: true });
    expect(info.latest).toBe("99.99.100-beta.1");
  });

  test("isNewer is false when current matches latest", async () => {
    const fetcher = () =>
      Promise.resolve(
        Response.json({
          tag_name: `v${VERSION}`,
          html_url: "https://example.test/releases/current",
          assets: [],
        }),
      );
    const info = await checkForUpdate({ fetcher });
    expect(info.isNewer).toBe(false);
    expect(info.binaryUrl).toBeNull();
    expect(info.sha256Url).toBeNull();
  });
});
