# Entity-owned TeamMate lifecycle and object Turns

- **Status:** Accepted and implemented
- **Date:** 2026-08-16
- **Affects:** `@excitedjs/dreamux-types`,
  `@excitedjs/agent-runtime-codex`,
  `@excitedjs/agent-runtime-claude-code`,
  `/packages/dreamux/src/service/agent-entity/`,
  `/packages/dreamux/src/service/teammate-service/`,
  `/packages/dreamux/src/service/teammate-collection/`,
  `/packages/dreamux/src/service/workflow-service/`,
  Team dissolve, dispatcher shutdown, and completion delivery
- **PR / Issue:** [Issue #337](https://github.com/excitedjs/dreamux/issues/337);
  [development task](../tasks/workflow/unified-teammate-lifecycle/README.md)

## Context

Workflow-created agents were durable TeamMates but did not use one TeamMate
lifecycle. Workflow borrowed Collection-owned ownership tokens and bulk release
verbs, while shutdown had separate runtime sweeps. Completion routing also
reconstructed process-local relationships from provider or host Turn ids through
a dispatcher-wide registry.

Those shapes gave observers and containers command responsibility for an entity
they did not own. They also made close ordering depend on callbacks and lookup
maps, so a never-settling Turn, a late provider admission, or a cold cache could
leave Workflow, Team dissolve, or server shutdown reporting success before the
durable TeamMate lifecycle converged.

## Decision

`TeammateService` is the sole owner of one TeamMate's mutation admission, lock,
runtime authority, in-process Turn objects, terminal persistence, close
single-flight, and committed retirement fact.

- `TeammateService.lock()` returns one restricted handle. Workflow holds that
  handle, submits and closes through it, and unlocks only after the matching
  terminal journal and Workflow record commit.
- `close()` never unlocks. A closed locked entity stays cached and cannot reopen.
  Unlock retires a durably closed entity and publishes the post-commit close fact;
  `TeammateCollection` reacts only by removing its own exact cached reference.
- `TeammateCollection` owns scoped construction, canonical per-name
  materialization, cache subscription, roster queries, and reads. It owns no
  close algorithm, membership registry, bulk release, or runtime shutdown sweep.
- Team dissolve and process shutdown materialize every durable non-closed entity
  and invoke the same entity close contract. They stop Workflows before ordinary
  writers and close entities before draining work that can depend on closure.

One accepted logical input is represented by one `RuntimeTurn` object from the
provider and one `Turn` object owned by the entity.

- Folds return the exact same object. Workflow retains the object directly.
- The first terminal outcome is snapshotted and wins one object-owned latch.
- Terminal persistence writes one strict version-2 `turn.jsonl` row. Public,
  service, Workflow, Channel, and persisted contracts carry no Turn id merely
  to reconstruct an in-process relationship.
- Completion delivery is a closure captured by the initiating action. It runs
  after terminal persistence through one stateless, deadline-bounded policy.
  Only provider-proven pre-admission failure may retry; ambiguous or
  post-admission failure is terminal.
- Provider-native ids remain private implementation details inside provider
  packages.

The neutral runtime contract therefore distinguishes `failed` from `ambiguous`
admission and requires `AgentRuntime.stop()` to fence new input synchronously and
drain every already-started admission before resolving. A stopped runtime cannot
later return a newly accepted `RuntimeTurn`.

## Consequences

- Workflow stop is a truthful terminal barrier: runner termination,
  materialization join, member close, Agent result convergence, terminal journal
  and record persistence, unlock, and bounded terminal delivery complete before
  success returns.
- `teammate_close`, Workflow stop, Team dissolve, and server shutdown share one
  TeamMate close meaning. There is no raw-runtime success path.
- Cold-cache shutdown is intentionally allowed to perform canonical
  materialization before close. Collection materialization is a query/factory
  capability; lifecycle callers still issue entity commands.
- `turn.jsonl` version 2 is an incompatible persisted format. Legacy archives
  fail loudly with the release's rebuild instruction. Complete malformed rows
  are never repaired or truncated; only a demonstrably incomplete final JSON
  fragment may be discarded before append.
- External Agent Runtime providers must implement object Turns, conservative
  admission classification, and stop-time admission convergence.
- Architecture gates prohibit the removed ownership verbs, service/public Turn
  ids, Channel Turn events, reverse lookup registries, and runtime-only shutdown
  paths.

## Alternatives Considered

- **Collection-owned claims, command adapters, or Workflow ports.** Rejected:
  they split one entity fact across extra roles and keep an observer or
  bookkeeping owner in the command path.
- **Provider or host Turn ids plus lookup maps.** Rejected: every required
  relationship is process-local and can be retained directly by object or
  closure. Native ids are still free to exist inside a provider adapter.
- **Runtime-only shutdown sweeps.** Rejected: runtime termination without
  terminal Turn and durable identity convergence is not successful TeamMate
  close.
- **Grace periods, replay, durable cross-daemon leases, or a general JSONL repair
  engine.** Rejected for this decision: they solve different recovery problems
  and are not required for owner-correct lifecycle convergence.
