# Concrete Entity Name Suffix Length

Status: Implemented by PR #305. Current behavior is documented in
[Current architecture](/.agents/domains/current-architecture.md),
[Dispatcher orchestration](../../domains/dispatcher-orchestration.md), and
[Service topology](/.agents/domains/service-topology.md).

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
- Keep generated agent-name allocation behind one stateless
  `AgentIdentityStore.allocateName()` capability. It scans the persisted
  dispatcher-global entity namespace, including entity directory names whose
  identity file is unreadable, before selecting a candidate.
- Preserve the single-process, low-frequency mutation contract. Agent creation
  is a sequential allocate-then-create flow; it does not add an in-memory
  reservation queue, cross-operation serialization, a TeamStore projection, or
  permanent agent-name claims.
- Keep identity creation no-clobber so an unexpected persisted-name collision
  fails instead of replacing another entity.
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
- Identity creation must not silently overwrite a different existing entity at
  the same path.
- No provider-, channel-, runtime-, or role-specific naming logic may leak into
  the shared generator beyond the existing prefix/slug formatting.

## Acceptance

- Deterministic generator tests cover both 4- and 8-character endpoints for
  `team`, `team_leader`, `teammate`, and `team_member`, including role prefixes,
  lowercase base36 validation, and 64-character truncation.
- Real TeamCollection, TeamService, dispatcher TeamMate, and Team-member spawn
  paths use the shared allocator; forced observed collisions regenerate a
  suffix and preserve the existing exhaustion behavior.
- Agent allocation skips persisted entity directory names before workspace side
  effects, even when the corresponding identity file is unreadable.
- Identity creation rejects an already-existing destination instead of
  overwriting it.
- Collision, exhaustion, Team claim, collaboration restart recovery, and
  managed-to-reuse workspace regression tests remain green.
- Rush lint, build, test, change verification, and the knowledge-base check pass.

## Out Of Scope

- Changing name prefixes, slug rules, maximum name length, collision retry
  count, or Team never-reuse semantics.
- Migrating or renaming existing persisted Teams, TeamLeaders, or TeamMates.
- Adding a new public configuration option for suffix length.
- Adding transient agent-name reservations, cross-operation queues, or permanent
  agent-entity claim files. Team name claims remain the only durable name-claim
  namespace.
