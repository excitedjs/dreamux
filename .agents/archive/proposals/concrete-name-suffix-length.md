# Concrete Entity Name Suffix Length

Status: Implemented by PR #305. Current behavior is documented in
[Current architecture](../../reference/current-architecture.md),
[Dispatcher orchestration](../../domains/dispatcher-orchestration.md), and
[Service topology](../../reference/service-topology.md).

## Intent

Use one compact random-suffix contract for every generated concrete Dreamux
entity name: Team, TeamLeader, ordinary TeamMate, and Team member names all use
a CSPRNG-backed lowercase base36 suffix whose length is chosen from 4 through 8
characters, inclusive. The fixed dispatcher name is not generated and remains
outside this contract.

## Scope

- Narrow the shared allocator's generated-kind surface to `team`, `team_leader`,
  `teammate`, and `team_member`, then use the same 4–8 character suffix
  generator for all four kinds.
- Preserve the existing role-specific prefixes, slugging, 64-character maximum,
  collision retry limit, and Team durable-name-claim behavior.
- Remove the fixed agent-suffix constant and the kind-specific suffix-length
  branch. The kind remains an input only for prefix and slug formatting.
- Move generated agent-name allocation behind one `AgentIdentityStore` capability
  that atomically reserves a dispatcher-global candidate across ordinary
  TeamMate, Team-member, and TeamLeader creation. All live collections in one
  dispatcher share that store.
- Keep Team-record parsing in `TeamStore`: add a narrow read-only projection for
  occupied `leader_name` values, construct one shared `TeamStore` at the
  `DispatcherService` composition root, and inject that projection into
  `AgentIdentityStore` while injecting the same store into `TeamCollection`.
  `AgentIdentityStore` must not parse `record.json` or depend on TeamRecord.
- Hold an in-memory reservation across workspace/Team-record preparation through
  the authoritative identity create, then release it in `finally`. On restart,
  persisted identities and a Team record's `leader_name` are authoritative
  occupied names, including the Team-created/leader-identity-missing checkpoint.
  The serialization lock covers only candidate selection and reservation-set
  insertion/removal; slow workspace preparation and identity persistence run
  outside that lock while the reservation itself remains live.
- Update tests, current architecture documentation, and the existing Rush change
  entry to describe the unified suffix contract. Link this proposal from the KB
  root while active and archive it under the repository's normal proposal flow
  after implementation.

## Hard Constraints

- The suffix must contain only lowercase ASCII letters and digits.
- The length choice must remain CSPRNG-backed and must include both endpoints.
- An observed collision must regenerate a fresh suffix; no generated entity kind
  may bypass the shared allocator.
- Concrete Team names remain permanently non-reusable. This change does not add
  permanent claims for TeamLeader or TeamMate names.
- Agent-entity reservations are dispatcher-global, transient, and process-local.
  They serialize allocation only, not the full workspace/runtime startup path.
  A failed pre-identity create releases its name; a persisted identity or pending
  Team record keeps the name occupied through normal storage.
- Identity creation must not silently overwrite a different existing entity at
  the same path. The reservation capability is the only generated-name creation
  path and retries candidates under the namespace owner's lock.
- No provider-, channel-, runtime-, or role-specific naming logic may leak into
  the shared generator beyond the existing prefix/slug formatting.

## Acceptance

- Deterministic generator tests cover both 4- and 8-character endpoints for
  `team`, `team_leader`, `teammate`, and `team_member`, including role prefixes,
  lowercase base36 validation, and 64-character truncation.
- Real TeamCollection, TeamService, dispatcher TeamMate, and Team-member spawn
  paths use the shared allocator; forced observed collisions regenerate a
  suffix and preserve the existing exhaustion behavior.
- Concurrent dispatcher TeamMate, Team-member, and TeamLeader allocations forced
  onto the same candidate produce distinct names without overwriting an identity.
- A persisted Team record whose leader identity has not yet been written reserves
  its `leader_name` after service reconstruction.
- Failure-window tests prove reservation handoff:
  - ordinary TeamMate and Team-member failure before identity persistence releases
    the transient reservation and permits the candidate to be allocated again;
  - TeamLeader failure before TeamRecord persistence releases the candidate;
  - TeamLeader identity failure after TeamRecord persistence releases the
    transient reservation, while the persisted TeamRecord keeps the name occupied
    both immediately and after service reconstruction.
- Collision, exhaustion, Team claim, collaboration restart recovery, and
  managed-to-reuse workspace regression tests remain green.
- Rush lint, build, test, change verification, and the knowledge-base check pass.

## Out Of Scope

- Changing name prefixes, slug rules, maximum name length, collision retry
  count, or Team never-reuse semantics.
- Migrating or renaming existing persisted Teams, TeamLeaders, or TeamMates.
- Adding a new public configuration option for suffix length.
- Adding permanent agent-entity claim files. Team name claims remain the only
  durable name-claim namespace; agent reservations hand authority to existing
  identity or Team records.
