# Requirement

## Initial request

Separate the streaming-display surface from the push-back mechanism it is
currently built on.

Display is not only the Feishu COT card. Any surface that shows what a
channel-facing TeamLeader or the Dispatcher is doing while it is doing it — a
web timeline, a future client — wants the same facts. Today every one of those
facts must hang off a Dreamux submission, and each new display requirement has
been paid for with a mechanism that compensates for that.

The operator's framing: put the runtime's event-stream pushes under one
`Activity` namespace rather than re-deriving a curated model from submissions.

## What is already established

Read [runtime-input-semantics.md](runtime-input-semantics.md) first. It records
the input semantics, the live probe, the per-input identities that exist at the
provider boundary, and what the official documentation does and does not
guarantee. The analysis below assumes those facts; two earlier attempts in this
area were wrong from reasoning about half the machinery, so a claim that
contradicts that file needs evidence, not argument.

Two boundaries are already settled and are not open questions here:

- **Verbatim pass-through is rejected.** Handing provider payloads through
  unchanged would put Claude Code's stream-json shape and Codex's thread-item
  shape into Core and into every Channel — the coupling
  [minimize-provider-boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md)
  removed. Whatever crosses stays provider-neutral.
- **`source_id` is not the junk.** A Channel that hides its own inbound body
  while showing every other producer's needs an identity that crosses the seam.
  Neither runtime's per-input id is visible to a Channel, and `RuntimeSubmission`
  carries none back, so the identity has to cross at the Core command layer.
  `source_id` already did. Any design that claims to delete it must first say
  which identity replaces it.

## Settled design direction

Ruled by the operator on 2026-09-02, before the questions below were answered.
Recorded here so a proposal is measured against it rather than re-deriving it.

- **The neutral Activity shape stays.** It exists because the two runtimes'
  tool-call formats differ too much to hand through, and that reason has not
  changed. Provider wire shapes do not reach Core or a Channel.
- **Completeness increases.** The problem is not that the shape is neutral, it
  is that the set is curated: two kinds exist, so every other runtime fact must
  be smuggled through some other path or dropped. Each runtime fact a display
  needs gets its own neutral kind.
- **Attribution moves from submission to actor.** An activity names the Agent
  whose runtime produced it. A Channel already matches on that — recipient
  identity is a team name, or the Dispatcher — so nothing needs a `turn_id` to
  be placed. This is what removes representative attribution, the drop when no
  Dreamux container exists, and the bespoke actor-scoped terminal event.
- **The one identity the requirement forces travels with the input.** Hiding the
  Channel's own body while showing every other producer's cannot be answered by
  actor identity: an operator message, a task push and a cron fire are all the
  same actor. Something must say "this input is mine". Today that identity goes
  down as `source_id`, is retained on the turn, and comes back out on
  `teammate.turn.submitted`. It should instead travel *with the input* —
  `AgentRuntimeSubmissionInput` is `{ text: string }` today; a caller-supplied id
  on it, echoed by the runtime on the input fact, deletes the return path
  entirely. Claude Code already generates exactly such an id internally
  (`commandUuid` in `writeSteer`); this supplies it instead. Codex needs it
  supplied: every codex submission goes through `turn/start`, and several of
  those calls can return the *same* `response.turn.id` — that id names the
  folded native turn, not the input — so codex holds no per-input identity to
  map from.

## Operator ruling: two published kinds, split by producer

Ruled 2026-09-02, after the first two versions of the design had been reviewed.
The operator's words, which proposed the split as a reading of the design:

> 「我理解一下，就是输入这块用的都是TeamMate的Input事件，而且这个Input是天然带
> source id的？所以可以通过这个source id去过滤用户通过飞书channel发回来的消息？
> 其余所有的事件用的都是Activity事件？」

It was a better boundary than the design's own, which had folded the input fact
into one `teammate.activity` kind as a fourth discriminant. It was put back to
the operator with what changes and what it costs, and confirmed: 「ok，出技术方案」.

So: **`teammate.input` published by Core, `teammate.activity` published by a
runtime.** Four core event kinds, not three.

One correction was made to the reading in the same exchange, and it matters for
implementation: the input fact does not carry a `sourceId` *only* when it comes
from a Channel. A cron fire, a task push and a restart notice carry one too. The
Channel's test is therefore a **comparison against ids it itself submitted**,
never a presence check — which is exactly the `source_id` mechanism already
chosen over text matching, with one hop removed.

## The three questions this task answers

### 1. Without COT, what could Core delete?

Take the display requirement away entirely and list what stops being needed.
The point is to measure what display actually costs, separately from what it is
worth. Expected candidates, to be confirmed or refuted against the source rather
than assumed:

- the conversation projection and the `ChannelCoreEvent` conversation kinds
- `teammate.native_turn.ended`, the `nativeTurn` provider sink, and the
  per-`result` end bookkeeping in both runtimes
- `source_id` echoed on the submitted fact
- the redaction and bounding applied to projected text
- whatever remains of activity plumbing that only display consumes

For each: is it display-only, or does something else depend on it? Anything a
non-display consumer needs is not a display cost and must be named as such.

### 2. If COT were designed from scratch, what would it be?

Design against the facts in `runtime-input-semantics.md`, not against the
current implementation. The question to answer first is what the unit of
display is. Today it is the Dreamux submission, which is why activity must be
attributed to one, why a folded turn picks a representative, and why a fact with
no owning submission has nowhere to go.

State plainly what each candidate design costs and what it deletes. A design
that adds a mechanism without removing at least the one it replaces has not
answered the question.

Constraints the answer must respect:

- Providers stay behind the neutral seam; a Channel never learns a provider's
  shape.
- Display is fail-open and best-effort. It must never affect admission,
  settlement, completion delivery, or shutdown.
- Projected text keeps its redaction and bounding wherever it comes from.
- The existing locked COT product model — one recipient, one anchor, at most one
  open card, closing on the runtime's own native end — stays in force unless
  this task explicitly changes it with the operator's agreement. Its record is
  [feishu-cot-conversation-cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md).

### 3. Anti-leak infrastructure, folded into this task

The public-repository red line is currently enforced only at release time, over
packed tarball contents. Nothing scans the tree, so an internal path in a file
that never reaches `dist` — a test, a fixture — can reach the default branch
undetected. That happened on 2026-09-02: an internal mount path landed in a test
file and was found by hand, not by a gate.

Required:

- Install gitleaks reproducibly on a developer machine, from a committed,
  version-pinned, checksum-verifying script.
- The pre-commit anti-leak gate **fails hard** when gitleaks is absent instead of
  warning and passing, and says that skipping is not permitted and installation
  is required.
- A tree-wide internal-content scan — the release gate's own patterns — that runs
  in the pre-commit hook and in CI, so a leak is caught before the default
  branch rather than at publish time.
- `.gitleaks.toml` stays untouched: it is shared canonical with the sibling
  repository, which legitimately contains the paths this scan rejects. The
  internal-path patterns live in their own script.

Two facts to design around, both already verified:

- `release.yml`'s version-bump job runs `rush install`, which installs the git
  hooks, and then commits **without** `--no-verify`. A hard-failing gate breaks
  the next stable release unless that job installs gitleaks too.
- A tree-wide scan is red on day one: reviewed public placeholder users
  (`me`, `example`, `op`, `meredith`, …) and four files that are themselves the
  guardrail definitions. The allowlist is by placeholder name and by
  pattern-definition file, never by directory — the leak that motivated this was
  in `tests/`.

## Acceptance criteria

- Not yet confirmed. To be written from the answers to questions 1 and 2, once
  the operator has ruled on the direction.

## Decisions and unknowns

- **Confirmed operator decisions:** the split is wanted; verbatim pass-through is
  not; anti-leak work is folded into this task.
- **Open:** whether question 2's answer changes the COT product model, and
  therefore whether this becomes a refactor or a requirement change.
- **Ruled 2026-09-02, `priority` goes.** The operator's words:
  「priority 直接删掉，哪怕它有，我也不要这个特性。」 So the question of whether
  Claude Code honours the `priority` field Dreamux writes on its steer envelope
  (`buildUserMessage(prompt, { priority: 'now', ...options }, commandUuid)` in
  `packages/agent-runtime/claude-code/src/rpc.ts:235`) is closed without needing
  a probe: the ruling covers both outcomes. The field is removed, and the two
  comments that explain it (`rpc.ts:16`, `:22`, `:293`) go with it. This is a
  requirement decision — an interrupting steer is a capability the operator is
  declining, not a refactor — so it is recorded here rather than smuggled in as
  cleanup.
