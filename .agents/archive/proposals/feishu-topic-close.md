# Feishu topic-close lifecycle

- **Status:** Implemented; current behavior is documented in
  [Channel runtime](../../reference/channel-runtime.md)

## Intent

Close a collaboration-space Team when its bound Feishu topic is closed.

The observed production case left the collaboration target `active` and the
Team `running` after the topic closed. Feishu delivered no dedicated topic-close
event to the current Channel route table. A later reply failed with Feishu code
`230019` (`The thread does NOT exist`). The Feishu event catalog does expose
`im.message.recalled_v1`, which is the provider signal available when the topic
root is recalled.

## Design

- Extend the typed Feishu event-route seam with `im.message.recalled_v1` and
  normalize only its bounded routing fields: event id, chat id, message id,
  recall type, and recall time.
- Keep topic identity resolution in `FeishuTargetRouter`. A recalled message may
  produce a close route only when the session previously observed that exact
  message as a topic root. Root classification uses the recorded inbound
  ancestry (`root_id` and `parent_id` are absent); it must not assume Feishu's
  thread id equals the root message id. Recalling a topic reply, an ordinary
  group message, or an unknown message must not close a target.
- Pass the neutral `ChannelRoutes.targetLifecycle` capability into the Feishu
  session. When a recalled topic root resolves safely, emit one
  `target_closed` event with the provider-owned target and container.
- Treat Feishu send code `230019` as a second authoritative closed-topic signal.
  If the failed reply targets any previously observed message in a topic, emit
  the same neutral `target_closed` event before preserving the original send
  failure. Errors for ordinary chats, unknown messages, or any other upstream
  code do not emit lifecycle events.
- Keep SDK/axios error-shape parsing in `@excitedjs/feishu-transport`, the sole
  Lark SDK owner. The transport converts outbound SDK failures into a public,
  safe structured error containing only bounded upstream code, message, and log
  id fields; it retains no raw response, request config, request body, headers,
  credentials, or SDK error object. The Feishu Channel recognizes `230019` only
  through that transport-owned contract.
- Let existing Dreamux collaboration routing own acceptance, idempotency, and
  Team closure. The Feishu package must not access collaboration or Team state.
- Add bounded structured logs at both Feishu signal points and at neutral
  lifecycle emission. Do not log message content or raw Feishu payloads.
- Make collaboration lifecycle acceptance ignore a duplicate `target_closed`
  while the target is already `closing` without a recorded failure. A failed
  close remains retryable: accepting its next close signal clears `last_error`
  before one new Team-dissolve attempt starts. Restart recovery still resumes a
  durable `closing` record directly.
- Add patch change files for `@excitedjs/feishu-transport`,
  `@excitedjs/feishu-channel`, and `@excitedjs/dreamux`.

## Lifecycle and failure semantics

- Feishu event handlers remain tracked by the session lifecycle and must not
  emit after the session fence is revoked.
- The recall handler awaits `targetLifecycle` before acknowledging the event.
  A lifecycle error therefore keeps the provider event retryable.
- The `230019` fallback attempts lifecycle delivery before rethrowing the
  original send error. A lifecycle failure must be logged, but must not replace
  the original provider error returned to the reply caller.
- The outbound reply captures the session fence at call start and checks that
  exact fence immediately before fallback emission. If session close revoked it
  while the send was in flight, a later `230019` must not emit lifecycle state.
- Duplicate recall and `230019` signals are allowed. Core's collaboration target
  lifecycle is authoritative: it ignores a target that is already closing with
  no failure, while a closing target with `last_error` accepts one retry and
  clears that error before the retry starts.
- If `targetLifecycle` is absent, the Feishu session remains compatible with an
  older host and logs that the close signal could not be delivered.

## Acceptance

Focused tests must prove all of the following:

1. A recalled, previously observed topic root emits the exact neutral
   `target_closed` target and `topic_group` container with the Feishu event id.
2. A recalled topic reply, ordinary group message, unknown message, or malformed
   recall event does not emit `target_closed`.
3. A `230019` failure replying to any observed topic message emits
   `target_closed` and still returns the original send failure.
4. Other send failures and failures on ordinary chats do not emit lifecycle
   events.
5. A reply that starts, then crosses session close before returning `230019`,
   does not emit a lifecycle event.
6. Duplicate close signals do not start a concurrent second Team close in core,
   while a signal after a recorded close failure starts one retry.
7. A dispatcher-level test sends the lifecycle event through
   `ChannelRoutes.targetLifecycle`, drains collaboration lifecycle tasks, and
   proves the target is `closed` and its Team is no longer open.
8. Session shutdown prevents late lifecycle emission and does not change the
   existing non-blocking inbound or shutdown ordering contracts.
9. Logs contain bounded identifiers and upstream code only, never message
   content, raw event payloads, or credentials.

Full Rush build/lint/test, the knowledge-base check, and the existing CI gate
must pass. The exact reviewed head is published through the repository's
feature-branch alpha workflow after the PR is open and CI is green.

## Out of scope

- Worktree cleanup behavior, cleanup timeouts, Team close tool timeouts, or
  retention policy changes.
- Polling Feishu for topic state or deriving topic identity in Dreamux core.
- Closing a topic that produces neither a recall event nor a later `230019`
  response; Feishu exposes no safe provider fact for that case.
- Changing collaboration-space persistence or Team dissolve semantics.
