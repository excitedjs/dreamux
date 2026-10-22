# Sync Codex session titles to Team intent

## Current state

- Goal: Use native Codex title notifications to update Team intent shown by team listings, without extra leader work.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/sync-codex-session-title-to-team-intent/requirement.md)
- Final solution: [Implementation design](/.agents/tasks/architecture/sync-codex-session-title-to-team-intent/technical-design/final.md).
- Verification: [Evidence and coverage](/.agents/tasks/architecture/sync-codex-session-title-to-team-intent/verification.md).
- Solution review Issue: None; the operator directly selected the native-event integration.
- Blockers: None.
- Next action: Follow review and CI on the existing PR; merge requires separate operator authority.
- Related tasks: [Data-flow ownership](/.agents/tasks/architecture/code-organization-refactor/README.md) and [native result reporting](/.agents/tasks/mcp/enable-team-member-messaging/README.md).

## Development approval

- Status: The operator directly requested implementation on 2026-10-22 and subsequently limited this delivery to Codex. No approval card is claimed.
- Approved implementation boundary: Codex native title notifications, the neutral runtime contract, Core-owned Team intent persistence, and the existing Team-list display. Claude support and additional title generation are excluded.
- Architecture revision: On 2026-10-22 the operator criticized the callback-based implementation and explicitly requested changing the surrounding architecture when the existing structure cannot support the feature cleanly. This reopens implementation within the same feature scope; the earlier review does not approve the replacement design.

## Delivery

- Pull request: [#478](https://github.com/excitedjs/dreamux/pull/478).
- Knowledge closeout: Updated the [runtime contract](/.agents/domains/provider-runtime.md), [state ownership](/.agents/domains/state-config-and-files.md), [service topology](/.agents/domains/service-topology.md), [product behavior](/.agents/product/README.md), and the shipped maintenance reference.
