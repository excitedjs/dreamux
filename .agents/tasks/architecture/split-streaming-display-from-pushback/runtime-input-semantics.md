# Runtime input semantics, and what display is currently built on

Facts this task depends on. Most of them were never written down: they came out
of operator clarification, a live probe run on 2026-09-02, and reading the two
runtime packages. Recorded here because the design questions below are decided
by them, and because two earlier analyses in this area were wrong from reasoning
about half the machinery.

## What "steer" means, and why the word is borrowed

`steer` is a Codex concept. Codex distinguishes two behaviours:

- **Codex queue** — the backlog is sent *after the current turn ends*, forming a
  new turn.
- **Codex steer** — the message is injected *before the next turn starts*.

Claude Code has no such distinction: writing to its stdin **is** the queue, and
that queue behaves like Codex's steer.

Dreamux unifies the two under one name. **Dreamux `steer` = Claude Code's queue
+ Codex's steer**, and its meaning is precise: the message is injected **after
the next tool call finishes and before the next model call** — not at a turn
boundary. That distinction is the whole reason a second message usually joins
the turn already running instead of waiting for it.

## The two outcomes Dreamux guarantees

Stated by the operator, and confirmed by the probe below.

1. **Steer lands.** The model is still emitting tool calls, so an injection
   point exists. The input joins the running turn, and two sends produce **one**
   `result`.
2. **Steer misses.** The message reaches the runtime boundary's queue after the
   model has begun its final assistant message with no further tool calls, so
   this turn has no injection point left. The runtime returns that turn's
   `result`, then takes the queued message, **starts a new turn**, and returns a
   second `result`.

Both are correct behaviour, not failure modes.

## Live probe, 2026-09-02

Two probe TeamMates, one per runtime, asked for a 2000-word tool-free story,
then sent a follow-up immediately — which lands in outcome 2, because a story
with no tool calls has no injection point.

| | first send (long, tool-free) | follow-up sent immediately |
|---|---|---|
| `claude` | story delivered | `OK` delivered as a **second** completion |
| `codex` | **lost** | `OK` delivered |

Second probe: `sleep 20` then reply, follow-up sent immediately — outcome 1,
because the sleep guarantees a tool call and therefore an injection point. Both
runtimes returned **one** completion each.

**The evidence is the completion count, not the text.** The follow-up said
"reply with exactly OK2", which licenses the model to drop the earlier answer
from its reply, so the text cannot distinguish "folded" from "lost". One
completion means folded; two mean two native turns. Design a content-level probe
with additive instructions if that ever needs proving.

Codex losing the first answer in outcome 2 is Codex's own behaviour — the
operator confirms it shows the same way in Codex's GUI and TUI. It is the one
user-visible behavioural difference between the two runtimes that Dreamux
neither causes nor can fix.

## Why the second turn is delivered rather than dropped

The mechanism is in `/packages/agent-runtime/claude-code/src/rpc.ts`:

- a `PendingTurn` tracks `submitted` and `terminal` command ids, and **does not
  settle until every submitted command reaches a terminal lifecycle state**;
- **any** `command_lifecycle` frame for a command resolves its write waiter, so
  a merely `queued` acknowledgement already counts as a confirmed write.

So the resident window spans both `result`s in outcome 2. `ClaudeCodeRuntime`
never nulls `activeTurn` between them, and the second turn's activity is
projected normally.

This is also exactly why one resident window must report **one native turn end
per `result`** rather than one per window: with a single end, the second turn's
card would never close. That correction is the reason for the
`fix(claude): end each native result boundary` commit.

## The per-input identity that exists, and where it stops

Both runtimes know which input they are running, and neither fact reaches a
consumer:

- **Claude Code** emits `command_lifecycle` frames carrying
  `queued` / `started` / `completed` / `cancelled` / `discarded`, keyed by a
  `commandUuid`. `/packages/agent-runtime/claude-code/src/stream.ts` parses all
  five; `handleProtocolEvent` acts only on `started`, and the rest are dropped.
  The uuid is generated inside `writeSteer` — Core did not supply it and the
  Channel never sees it.
- **Codex** learns the native turn id synchronously, as the `turn/start`
  response (`response.turn.id` in `/packages/agent-runtime/codex/src/turn-manager.ts`),
  and binds the submission to it.

`RuntimeSubmission` is `{ settled: Promise<RuntimeSubmissionSettlement> }` and
carries no provider-side identity back to Core. `RuntimeActivity` has exactly
two kinds, `assistant.message` and `tool.call`, and every activity event must
name a `submission` to exist at all. *(Superseded 2026-09-03 — this task
deleted the submission key: `RuntimeActivity` is keyed on the Agent and names
no submission, and a third kind, `turn.ended`, reports the runtime's own
terminal — and, when a live native session is torn down, an `interrupted` end.
See `/packages/dreamux-types/src/agent-runtime.ts`.)*

**Consequence.** A Channel that must hide the body of its *own* inbound while
showing every other producer's needs an identity that crosses the seam. Neither
runtime id qualifies, because neither is visible to the Channel. The identity
that does cross is `source_id`, already a `team.submit` parameter Core uses for
admission deduplication, echoed back on `teammate.turn.submitted`. That is not
an accident of the current design — it is the minimum the requirement admits.

## Where the two runtimes have already diverged

Codex keeps `unboundObservedTurnIds` and `pendingActivity`: it can observe a
native turn that no submission has bound yet, buffer its activity, and deliver
it when a submission binds. *(Superseded 2026-09-02 — the buffer went with the
submission key: `pendingActivity` is deleted, codex emits an observed item's
activity as it arrives whether or not a submission has bound, and
`unboundObservedTurnIds` survives only so the collector can release a turn no
submission ever bound.)* Claude Code has no equivalent —
`ClaudeCodeRuntime.onProtocolEvent` returns silently when `activeTurn` is
`null`, with no log.

The probe shows this costs nothing on the paths exercised today, because the
window does not drain early. It is recorded because the divergence is real and
because a silent drop leaves no evidence if it ever does happen.

## Attribution inside a folded turn is representative, not exact

*(Superseded 2026-09-02 — streamed activity is no longer attributed to any
submission: `RuntimeActivity` is keyed on the Agent, and the three events named
below — `teammate.turn.message`, `teammate.turn.tool_call` and
`teammate.native_turn.ended` — were deleted with the submission-keyed display
line, leaving `teammate.activity`, which carries no `turn_id` at all. Each
runtime still picks a representative, but it now settles push-back completions
only and feeds nothing on the display line. The conclusion generalized rather
than merely held: no display fact is attributed to a submission, not only the
terminal one.)*

While a native turn folds several submissions, both runtimes attribute streamed
activity to a representative: Claude Code uses `active.started[0]`, Codex uses
the first submission bound to the record. A `turn_id` on
`teammate.turn.message` / `teammate.turn.tool_call` is therefore sound for
display grouping and **not** evidence that a given output answers a given input.
A terminal fact must not be attributed that way at all, which is why
`teammate.native_turn.ended` carries no `turn_id`.

## What the official documentation does and does not say

From a documentation review on 2026-09-02. Sourcing matters here: some answers
came from pages that were opened directly, others only from search summaries,
and one central fact lives outside the narrative documentation entirely.

- **Queuing is documented.** A message written while a turn runs is queued and
  processed sequentially; it does not interrupt.
- **The turn-boundary race is not documented.** The closest statement is scoped
  to a turn ended by `--max-turns`, where a still-queued message "stays queued
  and starts a new turn with its own limit". Nothing generalises it to a turn
  ending in an ordinary `result`. Outcome 2 above is therefore established by
  observation, not by contract.
- **`command_lifecycle` is documented only in the SDK's own changelog**, not in
  the narrative reference pages. Treat it as a shipped protocol feature behind a
  version gate, not as a stable public contract.
- **No priority field is documented** on a stream-json input message, and a
  feature request for exactly that steering concept was closed unimplemented.
  Dreamux writes `priority: 'now'` on its steer envelope; it is most likely
  inert. Worth confirming before any design leans on it. *(Superseded
  2026-09-03 — the field is gone: the operator ruled `priority` out on
  2026-09-02 and this task removed it from `buildUserMessage`, so there is
  nothing left to confirm. See `requirement.md` § Ruled 2026-09-02,
  `priority` goes.)*
- **There is no stdin interrupt.** The only documented interrupt for a raw child
  process is SIGINT; writing another user message only queues.

## Sources

- [`/packages/agent-runtime/claude-code/src/rpc.ts`](/packages/agent-runtime/claude-code/src/rpc.ts)
- [`/packages/agent-runtime/claude-code/src/stream.ts`](/packages/agent-runtime/claude-code/src/stream.ts)
- [`/packages/agent-runtime/claude-code/src/runtime.ts`](/packages/agent-runtime/claude-code/src/runtime.ts)
- [`/packages/agent-runtime/codex/src/turn-manager.ts`](/packages/agent-runtime/codex/src/turn-manager.ts)
- [`/packages/dreamux-types/src/agent-runtime.ts`](/packages/dreamux-types/src/agent-runtime.ts)
- [`/packages/dreamux/src/channel/conversation-projection.ts`](/packages/dreamux/src/channel/conversation-projection.ts)
