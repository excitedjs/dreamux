# Feishu binding notification events

- **Status:** Accepted
- **Date:** 2026-07-24
- **Affects:** Channel core-event ABI, channel binding lifecycle,
  collaboration-space persistence, built-in Feishu Channel delivery
- **PR / Issue:** N/A

## Context

Users need visible confirmation in Feishu when a group, topic, or
collaboration-space binding actually changes. The implementation has to keep
Dreamux core provider-neutral, preserve binding authority and lifecycle
contracts, and avoid a new durable notification queue.

Feishu topic notifications need a reply anchor. Core already persists
provider-owned target `meta` opaquely on channel bindings, and Feishu owns the
meaning of message ids.

## Decision

Add public neutral `binding.route` and `binding.collaboration_space` core event
kinds to the existing dispatcher-wide `ChannelCoreEventSource`. Owning services
publish these events only after their stores return real atomic transition
results. Core carries endpoint snapshots, Team projections, and opaque provider
metadata; it does not introduce a `notification_address` capability and does
not interpret Feishu selector fields.

Both event kinds are action-discriminated unions. Bound route events require the
runtime-bearing current Team projection, unbound route events require only the
previous owner, and collaboration-space policy is required only on bound
events. The owning service exposes one publishing mutation path per route
operation; callers cannot select a parallel silent service mutation.

Feishu records the triggering inbound topic `message_id` in the normalized
topic target `meta`. Collaboration target claims persist a copy of target
`meta`, `targetFromRecord()` restores it, and channel bindings persist it. The
built-in Feishu provider subscribes to the dispatcher-wide event source, filters
events by `endpoint.provider === "builtin:feishu"`, and serializes best-effort
static card delivery.

## Consequences

- The core event ABI grows additively; external providers can ignore the new
  event kinds.
- Event publication remains live-session-only. There is no history, retry,
  acknowledgement, or durable outbox.
- Binding stores stay pure: they return transition DTOs under the existing
  write fence and never publish events themselves.
- Idempotent route and collaboration-space rebinds may refresh display or
  provider metadata under that fence while remaining `unchanged`, so they
  publish no event.
- The route-bound projection comes from `TeamCollection` under the route
  lifecycle lease and includes the TeamLeader runtime id and runtime cwd.
- Dispatcher-wide broadcast is intentional. Channel sessions filter by provider
  ref instead of receiving channel-id scoped streams.
- Feishu topic route cards reply to the persisted triggering message. Missing
  or malformed legacy topic metadata warns and skips rather than sending to the
  group root.
- Feishu collaboration-space cards send fresh top-level messages to the
  container chat, which creates a new topic in a Feishu topic group.
- Feishu notification sends and the session-close drain are deadline-bounded.
  Close aborts remaining notification work after its settle window, so a hung
  remote request cannot hold dispatcher shutdown.
- Feishu cards render plain text only and do not expose raw provider `meta`,
  `claim_id`, prompts, or raw errors.

Guards live in root-export/external-provider fixture tests, binding-store
transition tests, channel-service event tests, collaboration-space persistence
and dispatcher routing tests, Feishu topic normalization tests, and Feishu card
delivery tests.

## Alternatives Considered

- **Add `notification_address` to the neutral target contract:** rejected
  because Feishu already owns the necessary addressing facts in provider target
  `meta`, and a new neutral capability would make core responsible for a
  provider-specific delivery concern.
- **Channel-id scoped binding event sources:** rejected because the dispatcher
  already gives every Channel session a dispatcher-wide source, configuration
  enforces one provider ref per dispatcher, and endpoint snapshots already carry
  the provider ref needed for filtering.
- **Publish from stores:** rejected because stores own persistence transitions
  only. Services own lifecycle semantics, Team projections, and event
  publication.
