# prevAIl Homebrew Formula

This directory holds the canonical Homebrew formula for prevAIl. It is the source of truth; the formula gets copied/synced to the public tap repo (`fru-dev3/homebrew-prevail`) whenever a release is cut.

---

## For users

Install via the tap:

```sh
brew tap fru-dev3/prevail https://github.com/fru-dev3/homebrew-prevail
brew install prevail
```

Then run:

```sh
prevail
```

Upgrade later with:

```sh
brew update
brew upgrade prevail
```

> Note: the tap repository is `fru-dev3/homebrew-prevail` — a **separate** repo from this one, per Homebrew convention (every tap must be named `homebrew-<name>`). The formula in *this* directory is the source of truth; it is synced over to the tap repo as part of the release process.

---

## For maintainers — release process

When cutting a new release (say, `v0.9.0`):

1. **Build all 4 binaries** using the existing scripts in `package.json`:
   ```sh
   bun run build:darwin-arm64
   bun run build:darwin-x64
   bun run build:linux-arm64
   bun run build:linux-x64
   ```

2. **Compute SHA256** for each binary:
   ```sh
   shasum -a 256 dist/prevail-darwin-arm64
   shasum -a 256 dist/prevail-darwin-x64
   shasum -a 256 dist/prevail-linux-arm64
   shasum -a 256 dist/prevail-linux-x64
   ```

3. **Update `Formula/prevail.rb`** in this repo:
   - Bump `version "0.8.2"` to the new version.
   - Replace the four `PLACEHOLDER_SHA256_*` strings with the real hashes.
   - Update the four `url "..."` lines so the `vX.Y.Z` path segment matches the new tag.

4. **Create the GitHub release** at `https://github.com/fru-dev3/prevail/releases/new`:
   - Tag: `vX.Y.Z`
   - Attach all 4 prebuilt binaries as release assets, using the exact filenames the formula expects (`prevail-darwin-arm64`, etc.).

5. **Sync `Formula/prevail.rb` to the tap repo** (`fru-dev3/homebrew-prevail`):
   - Copy the updated `Formula/prevail.rb` over.
   - Commit + tag the tap repo with the matching `vX.Y.Z`.
   - Push.

6. **Verify** on a clean machine:
   ```sh
   brew untap fru-dev3/prevail 2>/dev/null || true
   brew tap fru-dev3/prevail https://github.com/fru-dev3/homebrew-prevail
   brew install prevail
   prevail --version
   ```

---

## Future automation

The above steps should be automated by a GitHub Action triggered on release. The natural home for it is `.github/workflows/release.yml` — extend that workflow to:

1. Build all 4 binaries in matrix jobs (macOS arm64, macOS x64, Linux arm64, Linux x64).
2. Upload them as GitHub release assets.
3. Compute SHA256 for each.
4. Patch `Formula/prevail.rb` (version + 4 sha256s + 4 URLs) using `sed` or a small Node/Bun script.
5. Open a PR (or push directly) to the `fru-dev3/homebrew-prevail` tap repo with the updated formula.
6. Tag the tap repo to match.

Until that automation lands, the process is manual — see the steps above.

---

## Why a personal tap instead of homebrew-core?

- **Speed.** Submitting to homebrew-core means a review queue measured in weeks, plus strict guidelines about versioning cadence, dependencies, and stability. prevAIl is moving fast — versions ship frequently and the surface is still evolving.
- **UX parity.** A personal tap still gives users the full `brew install prevail` experience, just with one extra `brew tap` step the first time.
- **Migration path.** Once prevAIl stabilizes (post-v1.0, with a slower release cadence), we can submit the formula to homebrew-core and drop the tap. Users would then install with a plain `brew install prevail`. The formula here is structured to make that migration straightforward.
