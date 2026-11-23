# Integrate Antigravity runtime

## Current state

- Goal: Support Antigravity CLI in one external Dreamux provider through config-selected tmux and ACP modes, defaulting to tmux and using operator-authenticated agy installations
- State: `blocked`
- Requirement: [Current requirement](/.agents/tasks/architecture/integrate-antigravity-runtime/requirement.md)
- Final solution: [Dual-transport Antigravity provider](/.agents/tasks/architecture/integrate-antigravity-runtime/technical-design/final.md)
- Verification: [Local gates, native evidence, and coverage limits](/.agents/tasks/architecture/integrate-antigravity-runtime/verification.md)
- Solution review Issue: Not created.
- Blockers: Real TUI model admission remains blocked by the native eligibility
  response. Busy native-queue non-truncation, Escape interruption, and merged-turn
  completion still require live evidence; ACP still has no native interrupted
  activity id for the optional display marker. Full dual-transport readiness is
  not claimed.
- Next action: Resume at `review` only when the three named TUI behaviors have
  real native evidence. Implementation findings and CI are closed; do not invent
  fallback identifiers, hidden transport switching, or new defensive mechanisms
  while the environment blocker remains.
- Related tasks: Builds on [Providerization Epic Records](/.agents/tasks/architecture/providerization-epic/README.md).

## Stage decisions

- 2026-11-23 intake: The operator selected "新建任务" on the task-creation card,
  authorizing this independent Antigravity integration record.
- 2026-11-23 requirement: The operator confirmed one provider with
  config-selected tmux and ACP modes, defaulting to tmux, and user-managed
  native `agy` authentication. A subsequent explicit refinement aligned the
  capability surface with Claude Code/Codex and removed the proposed
  Antigravity-specific login prompt.
- 2026-11-23 solution review: The operator rejected the provider-specific
  owner/systemd complexity, required direct challenge of any model proposing
  greater complexity, and ruled that no model may introduce defensive scenarios
  absent from existing repository code. The solution was revised to direct
  existing-provider lifecycle ownership and botmux's native transport evidence.
- 2026-11-23 solution: The operator selected "确认方案" on the solution
  confirmation card, approving the simplified direct-provider design and its
  no-new-defensive-scenarios boundary. This decision did not authorize
  implementation.
- 2026-11-24 independent review close: Devbox verified all five implementation
  findings closed on [draft PR #493](https://github.com/excitedjs/dreamux/pull/493), including the Core completion-router and
  scheduler outcomes of native-queue admission. The implementation review passed
  with no remaining code finding. Full readiness remains blocked on the three
  named real-TUI behaviors; all required CI passed after the runner-only retry.
  No GitHub approval or merge was granted.
- 2026-11-24 implementation review: Devbox requested changes for busy-news loss,
  unverified tmux Escape evidence, ACP transcript-coupled hanging, and two release
  metadata/documentation nits. The operator selected "走原生队列", authorizing
  removal of the tmux busy-news refusal in favor of agy's native input path with
  no provider queue or synthetic `appended`. Escape and native queue behavior stay
  explicitly unverified; the hypothetical future-format recovery mechanism was
  rejected under the no-new-defensive-scenarios ruling. Re-review is pending.
- 2026-11-24 review delivery: The operator instructed, "你开 PR 交给 devbox
  去 review", authorizing commit, push, and PR creation so the external reviewer
  can access the complete change. Because full readiness remains blocked by the
  recorded native capability/coverage gaps, the PR is for review only and this
  record resumes at `review` when feedback arrives. No merge is authorized.
- 2026-11-24 implementation: Full Rush build, lint, test, and test typechecking
  passed. Native evidence and all unverified scenarios were recorded in the
  verification document. The operator selected "进入独立复审" on the review
  authorization card, authorizing independent review of the complete change;
  this did not authorize PR creation or merge.
- 2026-11-24 ordinary-input correction: The operator observed, "botmux 也没处理
  这个吧？另外，channel 的输入都是被 XML 标签包裹的，我怀疑你根本就是在防御
  一个不可能发生的场景". Source verification confirmed that Core renders every
  ordinary channel body inside its XML provenance envelope and that botmux uses
  raw slash passthrough only for explicitly selected native commands. The
  proposed leading-slash special acceptance criterion and blocker were removed;
  the provider adds no slash-specific behavior.

## Development approval

- Status: Granted on 2026-11-23 through the development-authorization card and
  the operator's explicit "授权开发" response.
- Approved implementation boundary: The linked confirmed requirement and final
  solution: one external provider with default tmux and resident ACP, direct
  existing-provider process lifecycle, native capability probes, focused tests,
  required documentation and change files. No Core special case, builtin
  promotion, authentication subsystem, transport fallback, systemd/owner
  infrastructure, or defensive scenario absent from existing repository code.

## Delivery

- Pull request: [Draft PR #493](https://github.com/excitedjs/dreamux/pull/493),
  opened for the operator-requested independent Devbox review; not approved for
  merge.
- Knowledge closeout: Pending.
