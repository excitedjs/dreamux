# Final solution — acknowledge an inbound event before its work runs

## What changes and where

One structural change, in two packages, plus one knowledge and one test
consequence.

### 1. The transport stops serialising the route behind identity resolution

`packages/channel/feishu-transport/src/transport/feishu.ts`

Today `withSelfIdentityRecovery` wraps the message route so every inbound awaits
`selfIdentity.ensureResolved()` *before* the route runs. That lookup is up to
three attempts with 500 ms and 1 000 ms backoff, and it happens inside the
platform's 3 s acknowledgement window. It is also not the route's concern: the
gate reads `botOpenId` at the moment it runs, and `start` already awaits
`ensureResolved()` once before the socket opens.

Change: delete `withSelfIdentityRecovery` and register `routes` directly. The
`ensureResolved()` call in `openInbound` stays — that is the one that makes a
normal start already-resolved, and it is outside the acknowledgement path
because it runs before `ws.start`. The transport gains one explicit member,
`ensureSelfIdentity()`, which is the same cache call the wrapper used.

The retry is **moved, not dropped**, and it lands where the acknowledgement no
longer has to wait for it: `session.resolveIdentityThen` runs it inside the
message's own detached work, ahead of the gate that reads `botOpenId`. That
keeps the 2026-08-31 rule — the first inbound after a failed lookup retries
before its own gate reads identity — while taking the lookup off the 3-second
window.

The lookup is bounded **end to end**, because it now runs inside work the
session drains on close: an endpoint that accepted the connection and never
answered would otherwise hold a shutdown open indefinitely. A per-request
timeout is not enough — the SDK performs a tenant-token exchange before the call
itself and owns both, with no timeout on either — so `withDeadline` wraps the
whole lookup at `LOOKUP_DEADLINE_MS` (5 s), well inside the daemon's own 15 s
shutdown deadline. The same bound is applied to `resolveAppOwner`, which reaches
the same drained set through the tracked card-action route; that widening is
recorded here rather than left implicit.

This correction is recorded because the first version of this solution said the
retry would simply be dropped and would happen "on the next inbound, or in the
gate's own resolution attempt". The gate has no resolution attempt — it only
reads `botOpenId` — so that wording described a behaviour the code does not
have.

### 2. The session owns the inbound work before acknowledging

`packages/channel/feishu-channel/src/session/session.ts`

Today the route awaits its work:

```ts
onMessage: async (event) => {
  if (!this.lifecycle.isLive()) return;
  await this.lifecycle.track(onMessage(this.inboundHandle(), event));
},
```

Change it to hand the work to the lifecycle and return:

```ts
onMessage: (event) => {
  if (!this.lifecycle.isLive()) return;
  this.runDetachedInbound(
    this.resolveIdentityThen(() => onMessage(this.inboundHandle(), event)),
    { chat_id: event.chatId, message_id: event.messageId },
  );
},
```

`runDetachedInbound(work, scope)` is one private session method that:

- hands the promise to `this.lifecycle.track(...)` — the same owner teardown
  already drains, so no new mechanism and no new state;
- attaches the one failure handler this shape now needs, because nothing awaits
  the promise any more: it logs at `error` with the channel scope fields plus
  the ids that address the event. There is no abort branch — the chat path
  already swallows a teardown abort in its own delivery, the document-comment
  path returns on its liveness fence instead of throwing, and identity
  resolution reports rather than rejects, so no path can deliver one.

`resolveIdentityThen` is the second private method: it retries the bot's own
identity before running the message, inside this same detached work (see item 1).

The same shape applies to `onDocComment`, whose `deliver` runs N submissions
under the same unbounded deadline and is the other route that can exceed the
window. `onBotMemberAdded` and `onCardAction` are deliberately unchanged: the
first is a single bounded store write, and the second already answers the
callback itself and detaches only the settlement it cannot afford to wait for.

### 3. The two recorded ACK statements are corrected, not deleted

- `.agents/domains/channel.md` — the "Feishu event routes" section states that
  every route awaits its handler before the SDK acks. It now states which routes
  the platform acknowledgement waits for and which hand their work to the
  session, and why: the platform gives 3 seconds, the inbound path's own budget
  is 60, and a message held past the window is re-pushed.
- `.agents/domains/feishu-pairing-access.md` — the same sentence in the pairing
  page's route paragraph.
- `packages/channel/feishu-channel/src/bot.ts` and
  `packages/channel/feishu-channel/src/feishu-document-comments.ts` — the code
  comments asserting queue-before-ACK, and the document-comment note that
  justifies running N submissions concurrently *because* the route awaits them.

### 4. The issue #63 live gate waits for the fact, not for the function

`packages/dreamux/tests/codex-inbound-live.test.ts`

The second inbound currently does `await routes.onMessage(...)` and then asserts
`turns()` already holds two entries with the second ack defined. After this
change `onMessage` returns before submitting, so that synchronous count is no
longer a statement about submission.

Change: keep the call, drop the synchronous count, and wait for the second
`turn/start` to be acknowledged — `waitFor(() => turns().length === 2 &&
turns()[1]!.ack !== undefined)`. The ack has to be in the predicate, not on the
next line: the request spy pushes its row before awaiting the real call and
assigns `ack` only after it resolves, so a count alone goes true a round trip
early. Everything else stays: the ack still has to precede the blocking
command's `item/completed` and the single `turn/completed`, the folded turn id
still has to match, and the reply still has to land on the marker message. The
gate keeps proving non-blocking folding; it stops proving that the
acknowledgement and the submission are the same instant.

### 5. The channel test harness follows

`packages/channel/feishu-channel/tests/helpers/fake-feishu-bot.ts`'s `inject`
awaits `routes.onMessage`, and ~18 call sites then assert effects on the next
line. Those assertions were true because the route awaited its work; after this
change they read state before the work has run.

Change: `inject` keeps awaiting the route (that is the platform's own shape —
it awaits the handler), and each affected site gains a `waitFor` on the effect it
asserts, using the helpers the suites already have (`waitFor` in
`feishu-channel-session.test.ts` and `feishu-cot-delivery.test.ts`, `settle` in
the COT suites). This is mechanical and per-site; the assertions themselves do
not change. A site that asserts *absence* (no second delivery, no extra send)
needs the opposite treatment — it must first wait for the work it expects to be
finished, otherwise it proves nothing. Those sites are identified during
implementation and each gets an explicit positive wait before the negative
assertion.

### 6. The bot-added event id is read from where the SDK actually puts it

`packages/channel/feishu-transport/src/parse/bot-member.ts`

The decoder reads `raw.header.event_id`, but the SDK flattens the v2 envelope
before dispatching, so the handler receives `event_id` at the top level and no
`header`. The read therefore always yields `''`, the store's id list is never
populated, and the repository's only event-id dedupe is dead — confirmed by 124
real chats holding zero recorded ids.

Change: read the id from the top level, keeping the existing tolerance for a
bare event body (an adapter that passes the body alone carries no envelope id,
and `''` there is already the documented "not recorded" value). No other field
in the decoder changes, and no consumer changes: `recordBotAdded` already treats
`''` as "no id".

This is the one behavior change in the task that is not about timing, and the
operator asked for it explicitly rather than leaving it as a follow-up.

## Boundary

In scope:

- the acknowledgement timing for `im.message.receive_v1` and
  `drive.notice.comment_add_v1`;
- the identity lookup that sits ahead of the message route;
- the knowledge statements and code comments that describe the old ordering;
- the two test surfaces above.

Out of scope, and stated so they are not inferred:

- **Any Channel-side dedupe.** The operator ruled 「只改 ack，接受残留」. No
  seen-set, no `event_id` read, no message-id ledger.
- **Any durable pre-acknowledgement record, replay, or retry.** Failure recovery
  is a log line and nothing more.
- **The COT anchor.** `advanceAnchor` keeps no same-anchor short circuit, and
  `submissionProvesNoAdmission` keeps its current membership. A residual
  duplicate still re-runs the inbound path and may still reopen a card. That is
  the accepted remainder, recorded as a known limitation.
- **Core.** No admission, submission, or projection change. The duplicate
  refusal this task relies on already exists.
Nothing else. The one item that was going to be a follow-up — the dead
bot-member event-id read — is now item 6 above, by the operator's request.

## Contracts, state, compatibility

- No persisted file changes shape, moves, or gains a field. No upgrade action,
  no `BREAKING:`, no `Rebuild:`.
- `FeishuTransport` and `FeishuBot` each gain one required member,
  `ensureSelfIdentity()`. That is a public shape change on a published package,
  so it is an ordinary `minor` note on the 0.x line — not upgrade-blocking at
  runtime, but a consumer that implements either interface must add it. Beyond
  that the change is one of when a route resolves, not of what it accepts or
  returns.
- The operator-visible behaviour change is the one the requirement asks for: a
  slow inbound is no longer re-pushed for missing the platform deadline.
- The change file is an ordinary note on `@excitedjs/feishu-channel` and
  `@excitedjs/feishu-transport`; both are 0.x, so no `major` type.

## Verification

| Acceptance criterion | How it is verified |
| --- | --- |
| 1. The acknowledgement no longer waits for the work | A channel test drives a route whose submission never resolves and asserts the route's returned promise settles; the submission still completes afterwards. |
| 2. The session owns the work before acknowledging | A channel test starts a slow inbound, closes the session, and asserts `close()` does not return until that inbound's submission has settled. |
| 3. A post-acknowledgement failure is logged, not thrown | A channel test makes the inbound path reject and asserts the failure is reported once with the event's ids and no unhandled rejection; a second case aborts via teardown and asserts no report. A failure that also produced a send error logs twice — the send's own line and this one — which is the same layering `introduce ack failed` and the pairing-prompt failure already use: one line says which call failed, the other says the inbound was lost. |
| 4. Document comments share the shape | The same route-shape test applied to `onDocComment`. |
| 5. The #63 gate still proves folding | The rewritten live gate, run under `DREAMUX_RUN_LIVE_MODEL_GATE=1`. |
| 6. Core still refuses a duplicate | Unchanged existing Core coverage plus the channel's existing duplicate-outcome tests; no new work. |
| 7. A redelivered bot-added event is a no-op | Two halves, neither able to cover the other's: a transport test feeds the decoder the flattened payload the SDK actually delivers and asserts it yields a non-empty id; a channel test feeds the same event twice through the session route and asserts the committed `chat-bots.json` recorded that id once. |

Local gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.
The live gate is the only one that cannot run in a default hosted environment;
it fails loudly when Codex is absent rather than skipping silently.

## Unresolved decisions and known limitations

- **A residual duplicate still reopens a COT card.** Accepted by the operator.
  It is not fixed here, and it is not silently claimed to be fixed.
- **A message that fails after the acknowledgement is lost.** Accepted by the
  operator. There is no replay.
- **The exact failure-handler placement** — one session-level helper versus a
  per-route inline handler — is an implementation choice within the approved
  boundary, not a separate decision.
- **Whether the identity wrapper's removal regresses the mention gate in
  practice** is argued from the gate's fail-closed behaviour, not measured. If
  implementation shows a message being dropped that the old wrapper would have
  delivered, that is a finding to report, not to paper over.
