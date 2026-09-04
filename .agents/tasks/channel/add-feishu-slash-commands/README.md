# Feishu slash commands

## Current state

- Goal: Handle /stop, /teams, and /dissolve deterministically in the Feishu channel through one extensible command table
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/add-feishu-slash-commands/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/channel/add-feishu-slash-commands/technical-design/final.md)
- Verification: [Gates and coverage](/.agents/tasks/channel/add-feishu-slash-commands/verification.md)
- Solution review Issue: Not created. The operator waived solution
  consultation and the public review Issue for this task.
- Blockers: None. The dissolve-receipt question was ruled on by the operator and
  is recorded in the requirement and the solution.
- Next action: Open the PR against `next` and wait for CI. The independent xhigh
  review's two real regressions (an interrupted Claude Code turn settling as a
  failure; two concurrent non-forced dissolves both dismantling the Team) are
  fixed and re-reviewed at source; all gates are green.
- Related tasks: None.

## Development approval

- Status: Granted by the operator on 2026-09-04, in the Feishu work group, in
  response to a played-back requirement and a proposed solution path. The
  operator's words, verbatim: "基本上我都知道。直接开干吧" — "I already know
  most of it. Just go build it."
- The same message waived the three-proposal consultation and the public
  solution-review Issue. It did not waive recording the solution, which is why
  `technical-design/final.md` exists.
- Approved implementation boundary: `requirement.md` plus
  `technical-design/final.md`. Anything outside them returns to the operator.
- Re-approved on 2026-09-04 after the dissolve-receipt contract question, which
  the operator ruled on directly rather than choosing from the offered options.

## Delivery

- Commit: `670ae316`, one commit on top of `origin/next`, 65 files. The branch
  carries nothing else; the COT-spacing work it used to sit on top of is already
  merged upstream as `0d8098f1` (#378).
- Pull request / CI / merge: PR not yet opened.
- Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
  `rush change --verify`, and `.agents/scripts/check.sh` all green. Details and
  coverage in [verification.md](/.agents/tasks/channel/add-feishu-slash-commands/verification.md).

### Knowledge closeout

| Owner | Result |
| --- | --- |
| `.agents/tasks/**` | This record, `requirement.md`, `technical-design/final.md`, `verification.md`. |
| `.agents/product/README.md` | Three entries added: the slash-command surface, English channel-authored command/introduce text, and a non-forced dissolve refused before it is accepted. |
| `.agents/domains/channel.md` | Slash-command section: recognition, human-sender-only, single dispatch site, per-command behavior, stale-route reconciliation, chat-name resolution. |
| `.agents/domains/provider-runtime.md` | `AgentRuntime` is four methods, not three; turn-interruption semantics and why an interrupted turn needs its own settlement. |
| `.agents/glossary.md` | `Slash command` and `Turn interrupt (interrupt)` rows added — both collide with an existing term (`Command`, `stop`). |
| `packages/channel/feishu-channel/CLAUDE.md` | Slash-command ownership added to Responsibilities. |
| `.agents/root.md` | N/A. No routing entry point or repository-wide surface moved. |
| `dreamux-maintenance` | N/A. No config or persisted-state shape, validation, default, ownership, or meaning changed. `team.list` gained a projected field in a Command result, which is not persisted state. |
