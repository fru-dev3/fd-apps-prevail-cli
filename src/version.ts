// Single source of truth for the user-visible prevAIl version. Bumped
// alongside CHANGELOG.md + package.json + the git tag at every release.
// Imported by:
//   - src/index.tsx       (the --version flag)
//   - src/branding.tsx    (the banner's status column)
//   - src/mcp-server.ts   (the MCP serverInfo)
//
// Keep this in lockstep with package.json. A drift between them won't
// break anything functionally, but the user will see two different
// numbers and not trust either.
export const VERSION = "1.1.0";
