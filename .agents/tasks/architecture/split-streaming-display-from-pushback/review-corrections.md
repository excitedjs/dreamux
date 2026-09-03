# Review corrections

Two independent reviewers read this design on 2026-09-02, in two rounds: one for
architecture and entropy, one for source-verifiable claims. Round 1 read
[analysis.md](analysis.md); round 2 read
[technical-design/final.md](technical-design/final.md).
Every finding recorded here was re-checked against the source before it was
accepted, and the ones that changed the design are marked as such.

This file exists so the design can be read without a defence of its own history,
and so a later reader can tell which claims were tested and which were merely
written down.

## Findings that changed the design

- **The runtime never sees the original body.** `submitAdmitted` hands the
  runtime `renderSubmission(input)` — the assembled XML envelope — and keeps the
  body separately as `prompt` (`teammate-service/index.ts:246`, `:259`), with an
  in-place comment giving the reason. Having the runtime echo its own `text`
  would have shown `<cron …>` and `<reminder>` markup on the card for every
  producer but the hidden Feishu inbound. Found by both reviewers
  independently. **The input fact moved to Core.**

- **Putting `sourceId` on the provider seam reverses a recorded ruling.** #350
  records the operator moving "stable source identity and duplicate admission
  from the Agent Runtime seam to the Core admission owner", and
  `AgentRuntimeSubmissionInput`'s docstring states the seam carries "no source
  identity". The 2026-09-02 direction this task recorded carries no operator
  words authorising the reversal — only the choice of `source_id` over text
  matching — so extending it that far was the design's own step, not a ruling.
  **The seam is now untouched.**

- **"Naturally ordered" was false.** Codex subscribes to notifications before
  `turn/start` resolves and supports an item or terminal arriving first; that
  race is what `pendingActivity` buffers today. **Emitting the input before the
  runtime is called removes the race by construction**, rather than accepting
  disorder or re-adding a buffer.

- **The activity-fact dedupe has no named repeater.** Both runtimes generate an
  activity id at emit time and no producer repeats one; the test asserting the
  dedupe names nobody. **It is deleted rather than re-keyed by actor**, which
  would have kept the mechanism alive under a new name.

## Corrections to fact, not to design

- Claude Code's per-command id is generated in `ClaudeCodeRuntime.acceptInput`
  (`runtime.ts:247`) and passed down; `writeSteer`'s `randomUUID()` is only a
  default parameter.
- "Codex's stream carries no user-message item" is narrower than stated:
  `itemActivity` projects only assistant messages and recognised tool items, and
  `ThreadItem.type` is an open string the collector does not filter. The source
  proves such an item would not be *projected*, not that the protocol never
  sends one.
- The stop path *was* changed by #357, in both runtimes. Settlement was not.
- `teammate.turn.settled` was introduced by #299 and removed by #338 before
  #347 reintroduced it.
- The per-submission activity dedupe lives in `conversation-projection.ts`, not
  in `turn-coordinator`.
- `teammate.state` has no reader in any Channel in this repository. It is not
  display cost, but it is not evidence of a non-display consumer either.
- The volume figures were taken from a `git show --stat` total line, which
  counts test files the accompanying filter had removed from the listing.

## Overclaims withdrawn

- **"Seven core event kinds become three."** A Channel still discriminates four
  sub-kinds inside one activity kind, and the whitepaper is explicit that
  collapsing N methods into one N-valued discriminant is not a boundary
  reduction. [analysis.md](analysis.md) now states the reduction that is real.

## Confirmed under challenge

The load-bearing claims held. The push activity path serves the projection and
nothing else, and `readRecentActivity` is a genuinely separate cold read. Codex
has no per-input identity — every submission goes through `turn/start`, and
several calls can return one `turn.id` that names the folded native turn. The
activity sink was already an empty seam before COT. `origin`, `prompt` and
`intent` had no reader before COT. Codex's `nativeTurnEnded` flag is redundant
against the current call graph. And the central claim survived both reviews:
`turnsBySubmission`, the early-activity buffer and the second sink are three
consequences of keying display on `RuntimeSubmission`, and attributing to the
Agent removes the reason for all three.

## Round 2

The design had changed in response to round 1, and the technical design document
now existed. Both reviewers were sent back with different targets: one to judge
whether publishing before the provider call created new problems, one to walk
every arrow of the two diagrams against the source.

### Findings that changed the design

- **There are two `runtime.submit` call sites, and the design named one.**
  `submitPreparedCompletion` (`teammate-service/index.ts:451`) is the completion
  re-entry, and `attachSubmission` calls `projectSubmitted` unconditionally — so
  a TeamLeader's card shows a TeamMate's answer arriving today. Publishing the
  input at `submitAdmitted` only would have deleted that display silently. Found
  by the architecture review, chain independently verified by the other. **Both
  sites now publish.**

- **The fail-open guard had no home.** `projectDisplay` /
  `warnProjectionFailure` are what make display fail-open today, and the change
  list deleted them without reinstating them at the new call sites. Worse than
  untidy: `projectInput` runs inside the admission ledger closure, so an
  uncaught throw would reject the admission. **The guard moves with the calls.**

- **"The card already handles a failed submission" was false, and cited a ruling
  that was not recorded.** A `stopped`, `skipped` or pre-admission `failed`
  outcome creates no `EntityTurn` and guarantees no native end, so an input
  published before admission could leave a card open indefinitely. The
  operator's actual words are 「那几个情况应该直接把卡片置成失败」, and the
  design must now meet that rather than cite it. **The same call site publishes
  a terminal when the outcome is not `submitted`.**

- **The implementation sequence was not executable.** Steps called projection
  entry points that a later step created; one step could not compile. `seal.ts`'s
  `KINDS` is a `ReadonlySet<string>` that silently drops an unlisted kind and no
  channel test crosses it, so it belongs in step 1. **The sequence is rewritten**,
  and "step 7 must land whole" is withdrawn — three of its deletions are
  independent.

- **`occurredAt` would have been lost.** It lives on the `RuntimeActivityEvent`
  wrapper being deleted. **It moves onto `RuntimeActivity`.**

- **`team.state` must stay in the Feishu switch.** It drives the leader close
  fence and the current-card interrupt. The switch goes to three cases, not two.

- **`dreamux-types/src/channel.ts` and `src/index.ts`** re-export everything
  being removed and were missing from the file list.

### Corrections to the diagrams

Both diagrams were wrong in ways that mattered, and both are redrawn:

- The push-back entry was labelled MCP `team.submit`. The Agent-facing tool is
  `team.send`; an external `team.submit` Command sets **no** initiator
  (`dispatcher-service/index.ts:475`), so a Feishu message or cron fire does not
  close the push-back loop at all.
- The COT diagram omitted the bus `emit`, the scoped source and
  `FeishuChannel.onCoreEvent`, and omitted the separate `attachSubmission` and
  settlement arrows.
- The "five cases" did not match the five projected kinds: the session ignores
  `.settled`, and its fifth case is `team.state`.

### Unresolved, and recorded as such

The two reviews **disagree about the activity-fact dedupe**. One found no named
repeater and called it defence without a scenario. The other returned
UNDETERMINED with a mechanism: codex does not deduplicate repeated
`item/started` / `item/completed` notifications and its activity ids are
deterministic, so a repeat would collide. A named mechanism outranks an absence
of one, so the dedupe stays pending a probe.

**Resolved at implementation: deleted.** Its key was the `RuntimeSubmission`
that `RuntimeActivityEvent` carried, and this change deletes that wrapper — the
activity sink now takes a bare `RuntimeActivity`, so no submission reaches the
projection to key on. The instruction to re-key it by actor does not survive
contact either: an actor-keyed set over a long-lived agent is either unbounded
or, at the 512 cap it carried, silently drops every later fact. The probe
therefore never became the deciding question, and `conversation-projection.ts`
carries no dedupe today; [technical-design/final.md](technical-design/final.md)
keeps the full reasoning, including where the fix would belong if a probe ever
names a repeater.

### The disagreement that was settled

`EntityTurn.id` keeps a caller-facing reader — `teamSubmitResult` returns it as
`turn_id`. The architecture review had listed it among fields losing their last
reader; the verification review confirmed it does not, and the architecture
review accepted the correction on re-read.

### One wording correction to this file

The deletion table said both reviews found no path can report a native turn end
twice. Precisely: no path can report twice **for one record object**. There is
an unguarded double report **by turn id** — `failProtocol` deletes a record, a
late `turn/start` response rebuilds it, and `failRecord` reports `failed` a
second time. The flag never guarded that path, and the second report is harmless
because no card is open. The claim is per-record, not per-turn-id.
*(Superseded 2026-09-03: the operator ruled the provider's COT-related state
out, so neither the flag nor the per-turn-id table that was to replace it
exists, and the per-record/per-turn-id distinction has no subject left to draw.
`failRecord` now reports nothing on the display line; `failProtocol` reports one
end on its first failure; and `TurnManager.stop()` reports an interrupted end
without asking whether a turn was open — so a native terminal followed by a
teardown end is the shape this layer is meant to produce, not an unguarded path.
The Channel absorbs the extra one: with no card open there is nothing to finish
(`feishu-cot-adapter.ts`'s `finishCard`). See [requirement.md](requirement.md)
§ Ruling on display state.)*
