<!-- Thanks for sending a PR. Keep this short and concrete. -->

## What changed

<!-- One or two sentences. The diff already says how — tell us what. -->

## Why

<!-- The reason this change exists. Link the issue or user report if applicable. -->

## Test plan

- [ ] `bunx tsc --noEmit` passes
- [ ] `bun run build` succeeds
- [ ] `bun test src/` passes (added or updated tests where the change introduces non-trivial behavior)
- [ ] Ran the affected flow in the cockpit and verified the result
- [ ] `CHANGELOG.md` updated under the appropriate section (only for user-facing changes; chore commits can skip)

## Related issue

<!-- e.g. Closes #123, or "n/a" -->

## Backwards compatibility

<!--
Does this break any of the following? If yes, justify in the body.
  - keyboard shortcut
  - slash command syntax
  - config.json field
  - vault file shape (state.md, _log/, _journal/, skills/, benchmark/)
  - persisted format (chat history DB, schedule file)
-->

No / Yes — explain:
