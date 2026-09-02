# Review corrections

Two independent reviewers read the design in [analysis.md](analysis.md) on
2026-09-02: one for architecture and entropy, one for source-verifiable claims.
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
