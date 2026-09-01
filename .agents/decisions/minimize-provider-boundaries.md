# Minimize Core provider boundaries

- **Status:** Accepted
- **Date:** 2026-08-31
- **Decided by:** the operator (rulings recorded per item in the task archive);
  engineering mechanics by the implementing team within those rulings
- **Affects:** `dreamux-types` public provider contracts, Core Command surface,
  Channel routing/binding ownership, Team lifecycle semantics, MCP error
  contract, persisted Team/Agent state
- **PR / Issue:** solution review
  [issue #349](https://github.com/excitedjs/dreamux/issues/349), implementation
  [PR #350](https://github.com/excitedjs/dreamux/pull/350), residue cleanup
  [PR #353](https://github.com/excitedjs/dreamux/pull/353), session-layout
  restore [PR #356](https://github.com/excitedjs/dreamux/pull/356)

## Context

The provider seams had accumulated so many required types and callbacks that
adding a third Agent Runtime or a second Channel was no longer realistic. The
operator's framing question: looking only at the core package, is what Dreamux
demands from the outside the minimal set? The refactor's authority order was
set explicitly: the confirmed final product shape decides; existing code and
prior decisions are evidence of how the system got here, not preservation
orders.

## Decision

Reduce both provider seams to a minimal command/event shape and move
provider-specific complexity to its owner:

- **Agent Runtime seam.** A provider factory creates a runtime handle with
  `start` / `submit` / `stop`. `submit` takes text (the caller renders any
  source envelope); Dreamux policies such as deduplication stay in Core.
  Provider-private session state crosses the seam as an opaque, serializable
  generic that Core persists and returns without interpreting. Registration
  metadata (`ref`, descriptor) belongs to Core's registry and is never echoed
  back by the provider. Structured output is mandatory; live activity
  reporting is optional (absent activity only means no live display). History
  reads use the neutral `readRecentActivity` shape backed by each runtime's
  own storage — Core keeps no turn journal copy. The provider also keeps
  `getCapabilities()` as its public configuration surface.
- **Channel seam.** A Channel provider implements lifecycle interfaces, calls
  Core through one `invoke(command, payload)` port, subscribes to Core facts
  through `onMessage(event, payload)`, and may register its own MCP tools.
  Everything between the external platform and those ports — message parsing,
  binding storage, target routing, topic semantics, presentation — is
  Channel-internal.
- **One Command registry.** `admin.sock` and Channel `invoke` share a single
  command registry with uniform reachability: no exposure policy, no
  per-caller allowlist. Agent-facing MCP rides one generic `mcp.toolcall`
  command into per-domain delegates rather than flattening tools into domain
  commands.
- **Channel-owned binding.** The binding store moved out of Core. A binding is
  an expected route keyed by the channel instance and opaque provider meta;
  Core's delivery primitive is `team.submit` with an optional `team_name`
  (present when the Channel selects a TeamLeader, absent when the Dispatcher
  Agent is the recipient — the unbound fallback is product behavior).
- **Deleted rather than migrated.** The Core collaboration-space container and
  its commands/events, the Core binding store, `resolveTarget`-style
  Core-to-Channel queries, persisted `role` and the `team_member` vocabulary,
  per-caller submission wrappers (`channelInput` / `scheduledInput` /
  `controlInput`), provider `waitIdle`, and the request-ledger/name-claim
  machinery around Team creation. The valid readable Team record is the sole
  Team-existence, name-ownership, and idempotency authority.
- **Model-visible failures.** Domain-authored failures render code, reason,
  and next step; every other error keeps its native message under its own or
  the `INTERNAL` code. No sanitized catch-all, no per-delegate error allowlist.
- **Fresh-install modeling.** Local Team/Agent runtime state is disposable;
  incompatible shapes fail loudly for manual rebuild. No compatibility
  readers, backfill, or migration branches were built.

## Consequences

- A new Agent Runtime implements a factory and three handle methods plus
  neutral `readRecentActivity`; a new Channel implements lifecycle, `invoke`,
  `onMessage`, and optional MCP tools. Neither requires Core changes.
- Core stays free of provider-native syntax and per-provider branches;
  architecture tests assert the seam (`core-provider-neutrality.test.ts`,
  `removed-surfaces.test.ts`, `collection-ownership.test.ts` and package
  `import-boundary` tests).
- Turn-level display anchors and correlation live in the Channel; Core carries
  no presentation state and no opaque round-trip fields.
- The deleted surfaces stay deleted unless a new decision record supersedes
  this one; reintroducing them piecemeal is the failure mode the negative
  surface tests exist to catch.

## Numbered-section citations

Test comments cite this decision as "minimize-provider-boundaries decision
record §N". Those section numbers refer to the archived final design, which
this record accepts:
[`technical-design/final.md`](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md)
— §1 Agent Runtime contract, §2 Channel contract, §3 Channel-owned routing and
provisioning, §4 Lifecycle and concurrency, §5 Change inventory, §6
Implementation sequence, §7 Verification, §8 Release and knowledge updates, §9
Rejected alternatives, §10 Known risks and bounded trade-offs.

## Alternatives Considered

The archived design's §9 records the rejected directions with reasons. The
recurring ones, rejected by explicit operator ruling: exposure policies and
per-caller allowlists over the shared registry; durable provisioning sagas and
Team-creation ledgers; upgrade-compatibility readers for disposable state;
Core-held presentation correlation; per-source submission wrappers surviving as
a `kind` discriminant. The full requirement lineage, per-item operator
decisions, and the TeamLeader failure ledger live in the task archive:
[`minimize-provider-boundaries/`](/.agents/tasks/architecture/minimize-provider-boundaries/README.md).
