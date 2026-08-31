# Verification

## Feishu bot self-identity recovery correction

Verified on 2026-08-31 against the approved requirement and technical design.

- `cd packages/channel/feishu-transport && npm run typecheck` — passed.
- `cd packages/channel/feishu-transport && npm run lint` — passed.
- `cd packages/channel/feishu-transport && npm run test` — 12 files and
  194 tests passed, including 6 self-identity recovery cases.
- `node common/scripts/install-run-rush.js change --verify` — passed.
- `git diff --check` — passed.

The focused suite exercises the routes registered by the real transport
assembly and covers startup lookup failure followed by same-message recovery,
empty identity responses, success caching, concurrent single-flight lookup,
non-message route exclusion, and the embedded WebSocket registration seam.

Full monorepo gates remain the responsibility of the cumulative PR gate; this
correction changes only `@excitedjs/feishu-transport` source, focused tests, and
its change note. The separate empty-TeamLeader/Codex session defect is excluded.
