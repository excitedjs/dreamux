# Feishu binding notification cards

> **Archived 2026-09-01.** The cards shipped; the core-event seam they rode did not survive #350 — the Channel renders them from its own records. Current owners: [/.agents/product/README.md](/.agents/product/README.md), [/.agents/domains/channel.md](/.agents/domains/channel.md).

- **Status:** Accepted
- **Date:** 2026-07-24
- **Affects:** Channel core-event ABI, channel route lifecycle,
  collaboration spaces, built-in Feishu Channel UX

## Intent

Make successful Dreamux binding state visible where it matters. The built-in
Feishu Channel sends a card after a group, collaboration space, or topic is
actually bound, and sends a short card after the same live target is actually
unbound. This removes the need to ask whether a binding operation took effect.

## Scope

- A collaboration-space bind sends a card to its Feishu group container
  immediately. It does not wait for a Team to be provisioned. The card shows
  the space name, configured TeamLeader runtime, and repository/workspace
  policy.
- A Team route bind sends a card to the bound group or topic after the route is
  durable and the TeamLeader route lease is current. The card shows the Team
  name, concrete TeamLeader name, TeamLeader runtime, and runtime working
  directory.
- A real live-session route or collaboration-space unbind sends a concise card
  to the endpoint that was released. Explicit transfer-back, Team owner
  cleanup, and collaboration-space dissolve use the same state-transition
  notification.
- Dissolving a collaboration space with active topic Teams produces one
  route-unbound notification per released topic followed by one space-unbound
  notification in the group.
- Only `@excitedjs/feishu-channel` subscribes to these event kinds and renders
  cards. Other Channel providers receive the dispatcher broadcast but do not
  act on it.

Feishu currently does not emit provider target-closed lifecycle events. Detecting
an externally closed topic and notifying a target after it is closed are not
part of this change.

## Core Event Contract

Extend the existing root-exported `ChannelCoreEvent` union with two additive v1
event kinds:

- `binding.route` as an action-discriminated union: bound/replaced events require
  the current Team projection, including runtime and runtime cwd, while unbound
  events require the previous Team owner and fix the current Team to `null`;
- `binding.collaboration_space` as an action-discriminated union: bound events
  require the current repository/workspace policy, while unbound events fix it
  to `null`.

This is a public provider ABI addition and requires the corresponding
`@excitedjs/dreamux-types` minor change note, root-export guards, and external
provider fixture updates. Existing listeners remain opt-in by exact event kind;
no existing Team/agent/turn listener is invoked for a binding event.

An event endpoint snapshot is a dedicated immutable DTO, not a fabricated full
`ChannelTarget`. It contains stable type/key/display fields, the provider ref,
and the existing provider-owned target `meta` needed by the matching provider
to address the notification. It never contains binding fallbacks, `claim_id`,
identity configuration, prompts, or errors. Core persists and forwards `meta`
opaquely and never interprets Feishu keys or message ids.

No new notification-address capability is introduced. Feishu records the
triggering inbound `message_id` in the existing topic target `meta` when it
normalizes the target. `ProvisionedTargetRecord` also stores a copy of the
provider-owned target `meta` in the initial durable claim, and
`targetFromRecord()` restores it for resume/reclaim. This closes the crash
window between saving the collaboration target claim and creating the channel
binding. Existing records without that additive field project an empty object.

The same metadata is persisted with the channel binding, so the bound event can
reply to the triggering message and a later live unbind can reply within the
same topic. The Feishu Channel alone reads that selector; it is never rendered
in the card or logged as a raw object. A legacy or malformed topic endpoint
without a reply anchor is skipped with a warning and must not be silently sent
to the group root.

A collaboration-space event does not need a topic reply anchor. Its container
endpoint identifies the Feishu topic-group chat. The Feishu Channel sends a
fresh top-level card to that chat; in a topic group this creates the
collaboration-space binding notification as a new topic.

## Dispatcher Broadcast

Binding events use the existing dispatcher-wide `publish(...)` path and are
broadcast to every Channel session for that dispatcher, exactly like existing
Team/agent/turn core events. Dreamux configuration already enforces one Channel
per provider ref within a dispatcher. The endpoint snapshot names its provider;
the single `builtin:feishu` session subscribes to the two binding kinds and
ignores events whose provider is not `builtin:feishu`. No channel-id scope,
private scope envelope, or per-source filtering is added.

## Authoritative Transitions

Publish only after a durable transition. Store mutations return an atomic
transition result from inside their existing write lock:

- `unchanged`: same active owner and same provenance, or already inactive;
- `bound`: absent/inactive to active;
- `replaced`: active owner or provenance changed;
- `unbound`: active to inactive.

Refreshing display or provider metadata alone is `unchanged`. Moving a managed
claim (`claim_id != null`) to an explicit binding (`claim_id == null`) is
`replaced`, even when the Team owner tuple is unchanged. A replacement produces
one new-bound event and no transient old-owner unbound event.

`CollaborationSpaceStore` applies the same rule to explicit/default bind and
unbind. Replaying an explicit bind with the same policy refreshes container
metadata atomically and returns `unchanged`; changing policy still requires
dissolve/rebind. Concurrent default auto-bind callers publish only for the one
inserted binding.

The route-bound projection is produced by a `TeamCollection` capability under
the existing route lifecycle lease. It contains:

- route owner (`team_name`, concrete `leader_name`);
- `leader_agent_runtime`;
- `runtime_cwd`.

The same lease-protected projection is passed into explicit bind, managed claim,
and reconciliation reclaim. `ChannelService` must not re-read Team state after
the write, and the Feishu provider must not reconstruct Team facts from names or
the binding row.

## Path Disclosure And Content Safety

Absolute repository and runtime working directories are intentionally disclosed
to members of the bound Feishu group/topic because the operator requested those
facts in the confirmation card. This deliberately narrows the older core-event
allowlist rule:

- paths exist only in bound binding events, never ordinary Team/agent/turn
  events or general Team status projections;
- all Channel sessions receive the neutral event broadcast, but only the
  provider named by the endpoint may interpret its opaque metadata and the
  built-in Feishu provider is the only subscriber added by this change;
- the Feishu card sends the path only to the target being bound;
- identity configuration, credentials, prompts, `claim_id`, raw errors, and
  other paths remain excluded from the event;
- provider-owned endpoint metadata is carried only for delivery and is never
  rendered into the card or emitted as a raw log object.

Every external value is rendered as escaped text. Team/space names, runtime
ids, paths, refs, and target display values must not be
able to create Markdown links, mentions, tags, or card actions.

## Delivery Semantics

- Notifications are live-session and best-effort. Each real transition produces
  one `sendCard` attempt and one immediate retry if that attempt fails. A
  confirmed success reports one card. Two rejected or timed-out attempts log a
  warning without changing the binding result, but a timed-out attempt's remote
  delivery outcome may be unknown once the request has reached Feishu.
- Idempotent replays and already-unbound operations produce no send attempt.
- Pre-session startup reconciliation is intentionally silent because the
  live-only bus has no consumer or history at that point. Durable replay/outbox
  delivery remains out of scope.
- Notification tasks are independent; no local or remote ordering guarantee is
  provided between separate binding transitions.
- Revoking the existing core-event source prevents new attempts. Session close
  aborts in-flight notification work before closing the bot, and each remote
  attempt also has a fixed deadline.
- The Feishu transport accepts an `AbortSignal` for caller-owned card sends and
  passes it to the underlying HTTP request. If a live send reaches its deadline,
  the session aborts that request and makes its one immediate retry while the
  session remains live. Cancellation bounds local work but cannot retract a
  request already accepted by Feishu, so retry may duplicate a remotely accepted
  card. A durable outbox, provider idempotency key, ordering, and remote
  reconciliation remain out of scope.

## Card Content

Collaboration-space bound:

- collaboration-space name;
- configured TeamLeader runtime;
- configured repository cwd and base ref when managed, otherwise an explicit
  dispatcher-default workspace label.

Team route bound:

- binding kind (`group` or `topic`);
- Team name;
- concrete TeamLeader name;
- TeamLeader runtime;
- runtime working directory.

Unbound:

- a short target-aware message stating that the group, topic, or collaboration
  space is unbound.

## Acceptance

- Explicit group binding starts one Feishu card notification with the concrete
  TeamLeader name, runtime, and runtime cwd; a failed attempt is retried once.
- Collaboration-space binding starts one group-card notification before any Team is
  created, with configured runtime and repository/workspace policy. The card is
  a fresh top-level message in the topic group, so it creates a new topic.
- Automatic topic provisioning records the triggering inbound `message_id` in
  both the initial durable target claim and the resulting channel binding, then
  starts one reply-card notification to that message after the Team route is bound.
- Explicit and lifecycle-driven live unbinds start one concise notification per
  real transition; idempotent replays make none. Each notification has at most
  two local attempts.
- Every Channel source under one dispatcher receives the binding event, but
  only the single provider matching `endpoint.provider` acts; Feishu ignores
  non-Feishu endpoints.
- Store tests cover unchanged replay, inactive replay, reactivation,
  managed-to-explicit replacement, and concurrent default auto-bind.
- Metadata-only refresh makes no send attempt; legacy or malformed topic
  bindings without a reply anchor skip and warn.
- Crash/restart between the durable collaboration target claim and the channel
  route write restores the provider metadata from the target record before
  reclaim; legacy records without metadata remain compatible and skip/warn.
- A stale Team route lease fails before the binding write and emits no event.
- A failed card attempt is retried exactly once; failure of both attempts is
  contained and logged without changing the binding result.
- A hung card send cannot hold Feishu session close.
- Separate binding notifications have no ordering acceptance criterion.
- Pre-session startup reconciliation makes no attempt.
- Card-send failure is contained and logged without changing binding results.
- Card JSON cannot contain identity configuration, `claim_id`, prompts, raw
  provider metadata, raw errors, or unescaped mention/Markdown injection.
- Focused contract, bus, binding lifecycle, Feishu card, and topic routing tests
  pass together with the repository lint/build/test gates.

## Out Of Scope

- Notifications from non-Feishu providers.
- Durable notification history, retries, acknowledgements, or delivery status.
- Changes to binding authority, takeover rules, collaboration provisioning, or
  Team lifecycle semantics.
- Cards for ordinary Team/agent/turn core events.
- Interactive bind/unbind controls.
- Detecting or notifying externally closed Feishu topics.
