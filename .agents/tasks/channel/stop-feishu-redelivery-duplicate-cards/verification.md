# Verification

## What was run

| Gate | Command | Result |
| --- | --- | --- |
| Build | `node common/scripts/install-run-rush.js build` | PASS (9 operations) |
| Lint | `node common/scripts/install-run-rush.js lint` | PASS (9 operations) |
| Test | `node common/scripts/install-run-rush.js test` | PASS (8 operations, one with warnings — see below) |
| Test typecheck | `node common/scripts/install-run-rush.js typecheck:tests` | PASS (8 operations) |
| Change files | `rush change --verify` | Change files present for both packages |

`rush update` was run first: the worktree had no installed dependencies after
being reset to `origin/next`, and `rush build` failed with "Link flag invalid"
until it did.

## The one warning

`@excitedjs/dreamux` reports `SUCCESS WITH WARNINGS` on its test run. The
warning is the live gate's own skip notice:

```
[codex-live] Real #63 model gate excluded; set DREAMUX_RUN_LIVE_MODEL_GATE=1 with usable auth.
This run does not certify folding.
```

That gate is the one thing this change cannot certify in a default environment.
**It was run once**, by the test-integrity review lens, under
`DREAMUX_RUN_LIVE_MODEL_GATE=1` against a real Codex install: it passed in
119.7 s. That run predates the corrected wait predicate, so the current gate has
not been executed — see the coverage limits below. Anyone validating this change
must run it with `DREAMUX_RUN_LIVE_MODEL_GATE=1` before treating the gate as
still proving folding.

## New coverage

`packages/channel/feishu-channel/tests/feishu-inbound-acknowledgement.test.ts`
(7 tests) holds the inbound work open with a spy and asserts the contract at the
acknowledgement boundary:

- the message route resolves while its delivery is still running;
- the document-comment route does the same;
- `close()` reaches its drain and stays unresolved while inbound work is in
  flight, then resolves once that work settles;
- a failure after the acknowledgement is reported once, with the dispatcher id,
  the chat id, the message id and the error text (a failure that also broke a
  send logs that send's own line too, as `introduce ack failed` already does);
- a document comment the teardown stopped mid-delivery reports nothing;
- the identity lookup is still parked when the route returns, and the delivery
  has not begun — so the lookup is inside the work, not on the ack path;
- a redelivered bot-added event records once, read back from the committed
  `chat-bots.json`.

`packages/channel/feishu-transport/tests/bot-member.test.ts` gains one case: the
flattened payload a live route actually receives now yields a non-empty event
id. A second case — a nested `header.event_id` winning when both are present —
was written and then deleted, because the SDK flattens the envelope, so that
input cannot occur and the case pinned an arbitrary precedence instead of a
contract. The `header`-first `||` in the decoder is therefore implemented but
not separately exercised; only the flattened payload is.

That case and the channel case are the two halves of acceptance criterion 7: the
transport proves the decoder yields an id from the payload the platform
delivers, the channel proves the id reaches the store and dedupes there. Neither
can cover the other's half.

## Mutation checks

Four corrections in this change are test-shaped, so each was verified by
deleting the behaviour and confirming a test fails:

| Deleted behaviour | Result |
| --- | --- |
| `await this.lifecycle.drain()` in `teardown()` | the AC-2 test fails |
| the fence in `deliverUnclaimed` (the cold-open path) | the teardown-silence test fails |
| `added.eventId` forwarded to `recordBotAdded` | the bot-added dedupe test fails |
| `withDeadline` around the identity lookup | the never-answering-client test times out |
| the fence in `deliverTo` (the subscriber path) | **no test fails** — the teardown-silence case drives an event with no subscribers, so it exercises only the cold-open fence |
| `waitFor` predicate without `ack !== undefined` | reviewed, not mutated: the live gate is the only surface and it costs ~2 min per run |

The first version of the AC-2 test passed with the drain deleted — it waited one
microtask, which is not enough for `close()` to reach the drain. It now waits
for the drain call and then for a bounded window, which is what makes the
deletion observable.

`packages/channel/feishu-transport/tests/self-identity.test.ts` was rewritten
from "the next message retries" to "an explicit call retries", plus a new case
asserting that a raw dispatch no longer performs a lookup itself. The behavior
still exists; its call site moved from the transport to the session.

## Existing coverage updated, not weakened

39 channel tests failed after the change because they asserted effects on the
line after `inject`. Each was repaired by waiting for the effect — through
`session.lifecycle.drain()`, which is the session's own "this inbound is done"
signal — and no assertion was relaxed or deleted. The two helpers that inject
now take the session explicitly so a test cannot drain the wrong one.

Two negative-assertion sites were checked specifically, because a negative
assertion that runs too early proves nothing:

- `feishu-cot.test.ts` "is inert before start and after close" waits for the
  inbound to settle before asserting the card count stayed at one;
- the provisioning failure tests assert the *absence* of extra submissions and
  now drain first.

## Coverage limits and residual risk

- **The live #63 gate was run by one review lens, not by the TeamLeader's own
  gates.** It passed in 119.7 s against a real Codex install under
  `DREAMUX_RUN_LIVE_MODEL_GATE=1`, which retires the earlier "not executed"
  risk; the gate's own wait was corrected after that run and has not been
  re-executed since.
- The acknowledgement timing is verified at the route boundary, not against the
  Feishu platform. No test asserts that Feishu stops re-pushing; the claim is
  that the route returns well inside the window, which the boundary tests show.
- The identity retry is covered by the channel test that holds the lookup open,
  which proves it does not sit on the acknowledgement path. No test drives a
  message through an unresolved identity end to end, so a lookup that keeps
  failing at runtime is not exercised here.
- The identity lookup's deadline is covered twice. Two tests drive a client that
  never settles: one asserts the lookup gives up at all, the other asserts it
  finishes inside the host's fifteen-second shutdown deadline — reverting to a
  per-request timeout alone fails both. The inner token leg was measured
  separately against a real SDK client with only the token endpoint black-holed:
  the lookup that used to stay pending past 40 s now ends at the deadline.
- A residual at-least-once duplicate still re-runs the inbound path and may
  still reopen a COT card. That is the accepted remainder of 「只改 ack，接受残留」
  and is recorded as a known limitation in the final solution, not fixed.
