# Verification

## Gates

All four Rush gates green from the repository root after the review round, run by
the developer and re-run by the TeamLeader for build, lint, and `typecheck:tests`:

- `rush build` — 8 operations, up to date (cache hit over unchanged inputs; the
  compile itself is covered by `typecheck:tests`, which ran fresh).
- `rush lint` — 7 SUCCESS, 1 NO OP.
- `rush test` — 4 SUCCESS, 3 SUCCESS WITH WARNINGS. The warnings are stderr
  written by tests that deliberately exercise failure and stop paths, plus the
  live Codex suite's own logs.
- `rush typecheck:tests` — 6 SUCCESS, 2 NO OP.
- `rush change --verify` and `git diff --check` clean.
- `.agents/scripts/check.sh` — KB OK, 157 files reachable.

## What the tests lock

- `packages/channel/feishu-channel/tests/feishu-slash-commands.test.ts` covers
  recognition (mention-prefixed, trailing text ignored, case-insensitive,
  mid-message rejected, non-text rejected, group mention required, direct message
  without mention) and dispatch (bound vs unbound `/stop`, `idle` rendered
  distinctly, every Core failure answered with one line, `/dissolve` answering an
  accepted request with `silent` and its no-bound and refused outcomes in words,
  running-only filtering with stable colours and current
  chat names, chat-id fallback when one lookup fails), plus the placement
  guarantee that a command in a Collaboration Space topic neither provisions a
  Team nor opens a COT anchor.
- `packages/dreamux/tests/team-dissolve-contract.test.ts` gains a case for each
  requester: a non-forced dissolve of a Team with a blocked worktree rejects and
  leaves the Team open and admitting. The pre-existing receipt tests kept their
  assertions and only gained `await`; the one whose title claimed a
  dispatcher-triggered dissolve always returns before assessment was renamed to
  say what it actually locks, which is the forced case.
- `packages/dreamux/tests/removed-surfaces.test.ts` still pins the exact
  `AgentRuntime` method set, now `interrupt/start/stop/submit`.

## Live probe: what an interrupt actually looks like

Three captures against a real `claude` 2.1.263 in `--input-format stream-json`
resident mode, and two against a real `codex` app-server. They exist because
review round 2 asked whether an ordering hazard was reachable, and the answer
overturned a claim the TeamLeader had already stated as confirmed.

### Claude Code

| Probe | What was interrupted | Result envelope | Order |
| --- | --- | --- | --- |
| 1 | mid-stream (`terminal_reason: aborted_streaming`) | `error_during_execution`, `is_error: true`, no `result`, `user_message_uuid` = the interrupted command | `[Request interrupted by user]` → artifact → `cancelled` |
| 2 | a 60s tool call (`terminal_reason: aborted_tools`) | same shape | same order |
| 3 | not an interrupt: a steer sent mid-tool-call | one `result/success`, no artifact at all | the tool ran to completion; the steer was queued and answered after it |

What this changed:

- **The recognition condition was wrong on the branch and would have failed
  every real interrupt.** It required `user_message_uuid === null` and no result
  text. The real artifact carries the interrupted command's own uuid, so it fell
  through to the ordinary result path and reported the turn `failed` — the exact
  outcome the capability exists to prevent. The unit test passed because its
  fixture was fabricated from the same wrong belief. Nothing in the artifact's
  shape distinguishes it from a genuine execution failure, so the discriminator
  is now our own accepted interrupt request, and the fixture is the captured
  envelope.
- **A finding was rejected by deleting code rather than adding it.** Review
  argued that if `command_lifecycle: cancelled` settled the turn before the
  artifact arrived, the artifact would land on an empty `pending` and reap the
  resident child. The chain was real; the ordering never occurred. Rather than
  add an absorber for an unobserved race, the settlement on `cancelled` was
  removed, so the artifact is the only place an interrupt can settle and the
  chain has no entry point.
- **An inherited premise was left standing and labelled.** The
  `error_during_execution`-with-no-uuid branch predates this task (#342). Probe
  3 did not reproduce anything that would produce it, but only the
  tool-call-phase steer was probed, so the branch stays and both the source and
  the fixture now say the premise is unreproduced instead of asserting it.

### Codex

Two captures against `codex-cli 0.153.4`, driving `codex app-server` over its
WebSocket-on-unix-socket surface exactly as the provider does.

| Probe | Turn | `turn/completed` payload |
| --- | --- | --- |
| 4 | interrupted mid-tool-call after 12s | `turn.status: "interrupted"`, `error: null`, `items: []`, `itemsView: "notLoaded"` |
| 5 | answered normally | `turn.status: "completed"`, `error: null`, items present |

These were measured rather than read, on purpose: the codex claim already in
this task's record — that an interrupted turn reports `TurnStatus::Interrupted`
with no error — came from reading the Rust source at `rust-v0.137.0`, and the
Claude Code half of this same task had just shown what a source-shaped belief
costs when the wire disagrees. Here the source and the wire agree, and the wire
also settles the two facts the source could not: the camelCase spelling
`"interrupted"` reaches the client, and a normal turn says `"completed"`, so the
status alone is a sufficient discriminator.

The provider reads that status for both card facts: it pushes
`[Request interrupted by user]` and ends the turn `interrupted`. The second half
was added after the operator tested an alpha and saw codex's COT render
任务已完成 where Claude Code rendered 任务中断 — a card's terminal is
`turn.ended.status` verbatim, mapped by the Feishu channel to
`RUN_FINISHED status: done | interrupted`. What a stopped turn *delivers* is
unchanged and still differs: Claude Code settles its submissions `stopped`,
codex settles with the completion it reports over the items produced before the
interrupt. Nobody has asked for those to agree.

Not probed, and recorded as unknown: whether an interrupt arriving while a
command is still `queued` cancels it. `interruptTurn` would resolve
`interrupted` from the control response either way. With the `cancelled`
settlement removed, such a turn falls to the pre-existing "ended without running
any of its commands" failure rather than to any new path.

The probe scripts and raw captures are kept outside the repo, under
`.workspace/feishu-cot-docs/probes/` alongside the COT probes.

## Independent review

An xhigh `code-review` run over the whole diff, requested by the operator with
architecture soundness and over-defensive code as its focus, returned fifteen
findings. Two were real regressions the TeamLeader's own pre-review had missed:

- An interrupted Claude Code turn settled as a hard failure. `ranAnyCommand` is
  set only on a normal terminal, an interrupted command reaches
  `command_lifecycle: cancelled`, and the CLI's interrupt artifact is
  deliberately ignored — so the turn rejected with "ended without running any of
  its commands", or hung to the idle reaper where lifecycle events are absent,
  killing the session the interrupt existed to preserve. An interrupted turn now
  has its own settlement path.
- Two concurrent non-forced dissolves both dismantled the same Team. Moving the
  worktree assessment ahead of the receipt put an `await` before the
  single-operation fence, and nothing on the `admitOperation` path serializes.
  The order is now join, assess, re-check, publish.

One finding was rejected on evidence: it called the required `command()` method
on `FeishuInboundDelivery` a breaking change for external implementers. That
interface has exactly one implementer, `FeishuChannelSession`, and one consumer
inside the same package; the external implementer it described does not exist.
The operator ruled the package stays on `minor`, and the proposed public-export
widening was dropped with it.

One finding corrected the TeamLeader's own earlier instruction: the module
extracted to stay under the `max-lines` cap was a pure forwarder, which adds a
cross-file hop and removes nothing. It was replaced by two cohesive units —
`feishu-route-reconciliation.ts`, which owns route removal for both the closed
Team event and a Command's stale-route rejection, and `control-rpc.ts`, which
owns the Claude Code control-request channel and its one pending reply.

## TeamLeader pre-review

The TeamLeader read the whole diff and returned fifteen findings in one round:
six pieces of defensive code with no named scenario, documented rationale deleted
to fit a lint cap, two commands that answered nothing on failure, a card lost
whole to a single failed name lookup, `/stop` reaching the Dispatcher Agent from a
Collaboration Space topic, inaccurate change-file comments, and unrelated churn.
All were fixed or answered with a named scenario. One finding — that user-facing
text should follow the Channel's Chinese convention — was withdrawn after the
operator ruled the opposite.
