# Final solution

## Contract

`AgentRuntimeSubmissionInput` gains one optional field:

```ts
export interface AgentRuntimeSubmissionInput {
  readonly text: string;
  readonly trigger?: TurnTrigger;
}

export type TurnTrigger =
  | 'user'
  | 'scheduled'
  | 'completion'
  | 'agent-task'
  | 'system';
```

`RuntimeAdmission` gains one variant:

```ts
| { status: 'appended' }
```

`appended` is the one admission that carries no turn: the provider put the text
into the live session as context instead of starting work. Nothing settles it,
so a caller awaiting a settlement has nothing to await.

The field is optional on purpose. A provider that has no such concept ignores
it, and a caller that supplies none gets the pre-existing ordinary-turn
behaviour — so the contract widens without breaking any existing adapter.

## Why a parameter and not a second method

An earlier draft added `inject?()` beside `submit`. That was the wrong shape: a
second method promises a second return type, and every caller would branch on
which one exists. A parameter states the same fact while leaving one method and
one return type — the provider decides internally how to honour it.

## Core: source to trigger

`submission-sources.ts` already owns the provenance names, so it owns the
mapping:

```ts
export function triggerForSource(source: string): TurnTrigger
```

A source this file does not name — a Channel's own inbound form, an operator's
`team.submit` — is `user`. Core cannot classify it, and `user` is the only value
permitted to interrupt, so the safe reading of "someone asked for this" is the
interrupting one.

## Codex adapter

The adapter tracks `thread/status/changed` (codex's own `ThreadStatus::Active`)
as `threadBusy`, then:

```ts
if (input.trigger !== undefined && input.trigger !== 'user') {
  if (this.threadBusy) return this.appendToThread(input.text);
}
return turnManager.submitInput(input);
```

`appendToThread` calls `thread/inject_items` with a `ResponseItem::Message`
whose role is `user`. That item is not an `AgentMessage`, so codex does not
classify it as queue-only mail and folds it into the current turn's next
sampling step; it also does not match the `has_user_input` check that cancels
sampling, which is why it does not interrupt.

Measured: same-turn delivery in three consecutive runs, no `item/completed`
loss, and no turn started while the thread is idle.

## Claude Code adapter

No change at all. That runtime already delivers a stream-json submission
mid-turn and never aborts a running response, so every trigger already behaves
the way only `user` may behave on a runtime that can interrupt. The trigger is
therefore neither acted on nor restated in the envelope.

An earlier revision wrote it into the envelope as `origin` with kind values
taken from the CLI's binary. Those values have no published documentation
behind them, and stating a protocol fact this package cannot verify is not
worth doing — so the mapping was removed rather than sourced.

## Receipts

- `toSubmissionResult` reports `appended` as `submitted` — the text was accepted.
- `teamSubmitResult` reports it as its own public `appended`: delivered, with no
  turn identity to name. `duplicate` would say the reverse — that Core refused
  before any submission.
- `asCompletionDeliveryResult` reports it as `accepted`.
- `failedAdmissionReason` returns `null`: the display surface should not be
  closed as failed.
- The admission ledger commits it, like `submitted`: the text is already in the
  thread, so replaying the same source id must not append it twice.

## Verification plan

- Codex adapter: appended on busy for each non-`user` trigger; turn started when
  idle; `user` still steers while busy; a foreign thread's status is ignored;
  an untriggered submission is unchanged.
- Claude adapter: the envelope is unchanged for every trigger.
- Core: every source maps to its trigger, an unknown source maps to `user`, and
  no non-`user` source can map to `user`.
- Contract tests: the input key set, the trigger union, and the admission union
  are each pinned.
