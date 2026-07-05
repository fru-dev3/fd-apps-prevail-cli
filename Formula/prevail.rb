class Prevail < Formula
  desc "Terminal cockpit for hard personal decisions — Claude + Codex + Gemini + Ollama council"
  homepage "https://github.com/fru-dev3/prevail-cli"
  version "1.9.7"
  license "GPL-3.0-only"

  # Checksums are the real sha256 of the v1.9.7 release tarballs. To bump:
  # publish a new cli release, then run `shasum -a 256 prevail-v<ver>-*.tar.gz`
  # for each asset and update the version + urls + sha256 below. See
  # Formula/README.md.

  on_macos do
    on_arm do
      url "https://github.com/fru-dev3/prevail-cli/releases/download/v1.9.7/prevail-v1.9.7-darwin-arm64.tar.gz"
      sha256 "0445e6edcfa7ec367278cf6c9c532efd043c7a0591f472eb421b4efc2ac96cc9"
    end
    # Intel macOS: no prebuilt darwin-x64 asset is published yet. Install from
    # source (see the README) or run under Rosetta until one exists.
  end

  on_linux do
    on_arm do
      url "https://github.com/fru-dev3/prevail-cli/releases/download/v1.9.7/prevail-v1.9.7-linux-arm64.tar.gz"
      sha256 "43eac76c265826366fc43150cbf0438d12cedb8b970912a5401acb9a9a2cc2c6"
    end
    on_intel do
      url "https://github.com/fru-dev3/prevail-cli/releases/download/v1.9.7/prevail-v1.9.7-linux-x64.tar.gz"
      sha256 "e5446162ec73a7e9d774cb7f88550a4f71b00735ee6c7c76f284eb06e8307fce"
    end
  end

  def install
    # The release tarball contains the compiled `prevail` binary at its root
    # (plus a bundled demo vault we do not install).
    bin.install "prevail"
  end

  test do
    # Smoke test: --version should print something containing "prevail"
    # and exit cleanly. Don't actually launch the TUI in tests.
    assert_match(/prevail/i, shell_output("#{bin}/prevail --version"))
  end
end
