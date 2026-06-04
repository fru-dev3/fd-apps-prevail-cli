class Prevail < Formula
  desc "Terminal cockpit for hard personal decisions — Claude + Codex + Gemini + Ollama council"
  homepage "https://github.com/fru-dev3/prevail"
  version "0.8.2"
  license "MIT"

  # NOTE: The SHA256 values below are placeholders. After cutting a release
  # with prebuilt binaries attached, run `shasum -a 256 <binary>` for each
  # platform asset and replace the PLACEHOLDER_* strings. See Formula/README.md
  # for the full release process (or future release.yml automation).

  on_macos do
    on_arm do
      url "https://github.com/fru-dev3/prevail/releases/download/v0.8.2/prevail-darwin-arm64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/fru-dev3/prevail/releases/download/v0.8.2/prevail-darwin-x64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/fru-dev3/prevail/releases/download/v0.8.2/prevail-linux-arm64"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/fru-dev3/prevail/releases/download/v0.8.2/prevail-linux-x64"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
    end
  end

  def install
    # The downloaded file IS the binary itself (Bun --compile output).
    # Rename to "prevail" so users can run it as `prevail` rather than
    # `prevail-darwin-arm64`.
    binary_name = Dir["prevail-*"].first || "prevail"
    bin.install binary_name => "prevail"
  end

  test do
    # Smoke test: --version should print something containing "prevail"
    # and exit cleanly. Don't actually launch the TUI in tests.
    assert_match(/prevail/i, shell_output("#{bin}/prevail --version"))
  end
end
