# Refine the model-facing surfaces of the TeamLeader

## Current state

- Goal: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) — operator rulings R1–R33 recorded verbatim (R28–R33 answer the external review of #380), evidence, and proposed changes 1–12; frozen for the solution phase at the revision that records R20 (2026-09-06).
- Final solution: [technical-design/final.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md) (2026-09-06), adjudicated from [draft.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/draft.md) and the two reviews under `technical-design/reviews/` (Codex and Seed runtimes, R18; the Codex file includes its reconsideration under R21).
- Solution review Issue: Not created.
- Blockers: None.
- Next action: None.
- Evidence: the acceptance probes of final.md §1 ran on the alpha built from the PR branch (verification.md, "Alpha acceptance"), and the external review round is answered (verification.md, "External review of #380").
- Verification: [verification.md](/.agents/tasks/mcp/refine-model-facing-surfaces/verification.md) — implementation method, gates, built-artifact probes, the independent review with adjudication, the live probes of final.md §8, the alpha acceptance, the external review round, residual risk.
- Lineage: the deep review of PR #369 (https://github.com/excitedjs/dreamux/pull/369) on 2026-09-05; that PR's own record (`relocate-role-skill-guidance`, on the PR branch) holds the 2026-09-02 rulings this task builds on. This task adds one delivery line to that PR's record (draft §3.11): #369 is not merged and its content ships through this task's PR.
- Related tasks: None.

## Development approval

- Status: Granted by the operator on 2026-09-06 (chat message answering the approval card), verbatim: "进开发。你自己用 ultracode 模式一次性搞定。" Bound to [requirement.md](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) R1–R24 and [technical-design/final.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md) as committed at `a169ac94`.
- Approved implementation boundary: final.md §6 (source files in `packages/dreamux`, `packages/channel/feishu-channel`, `packages/agent-runtime/claude-code`; the renamed skill roots and three `SKILL.md` files; the tests of final.md §7; the KB pages and README of §3.10; three change files of §3.11; the task records of §3.13). Non-goals: final.md §5. The three approval-time questions of final.md §9 are settled by R22 (public-artifact rule dropped; second channel-reply sentence deleted) and R23/R24 (Claude adapter fix A, in this PR).
- Implementation method (operator ruling in the same answer): the ultracode workflow, driven by this TeamLeader; member models per R25: opus for the agents that write code, sonnet for the rest.
- Correction to the approved text (implementation, 2026-09-06): final.md §2, §3.7 and §6 counted four `ChannelProviderCatalog.resolve` callers and listed `runnable-channel.ts` as touched. `onboard/wizard.ts` is a fifth caller, so §3.7's return-shape change forces a type-only adaptation there, and `runnable-channel.ts` needs no edit. No requirement, behavior, or scope changes; the three sections now say so.

## Delivery

- Pull request: [#380](https://github.com/excitedjs/dreamux/pull/380). [#369](https://github.com/excitedjs/dreamux/pull/369) is closed unmerged by the operator's ruling of 2026-09-05; its content ships here.
- External review (2026-09-06): eight findings by the non-author reviewer, ruled by the operator as R28–R33 and answered in one commit; the design's §3.1, §3.6, §3.7, §3.9 and the new §3.14 record what changed after approval: the TeamLeader prompt's workspace sentence, the workflow agent's shorter prompt, the envelope attribute order dropped as a contract, the adapter's stable directory, and the managed worktree's `delete-on-close` default.
- Post-merge correction (R34, 2026-09-06): the TeamLeader prompt's workspace sentence names only the workspace kind and its cleanup mode; the meaning of the modes at dissolve moved into the `dissolve` description. Follow-up PR #382 on `next` before the beta; final.md §3.1 and §3.14, the dispatcher-orchestration page, and the `@excitedjs/dreamux` change note follow. Its review added R35: `team.status` reports `worktree_mode` and `worktree_cleanup_mode`, since the lifecycle state alone cannot tell the Dispatcher whether a dissolve removes the worktree.
- Knowledge closeout (2026-09-06):
  - Task record (this directory): requirement.md carries R1–R27 verbatim; technical-design/final.md corrected for the fifth `resolve` caller, the new `system-prompt.ts` module, the renamed product page, and the test table; verification.md written.
  - Sibling task record: [relocate-role-skill-guidance](/.agents/tasks/mcp/relocate-role-skill-guidance/README.md) gained the delivery line that #369 ships through this task's PR (final.md §3.13).
  - Product: [dynamic-workflow-usage.md](/.agents/product/dynamic-workflow-usage.md) follows the shared skill's new path. [`.agents/product/README.md`](/.agents/product/README.md): the Team dissolve bullet records the managed worktree's `delete-on-close` default (R31); otherwise N/A — no catalog entry describes role prompts, dispatch reminders, bundled skill names, or the channel server name.
  - Domains: [channel.md](/.agents/domains/channel.md) (provider-named server, `source` attribute, channel-owned reminder), [dispatcher-skill.md](/.agents/domains/dispatcher-skill.md) (skill names and load triggers), [model-facing-writing.md](/.agents/domains/model-facing-writing.md) (the surface rules of final.md §3.10 and the pre-query visibility facts from review finding 6), [provider-runtime.md](/.agents/domains/provider-runtime.md) (adapter root keyed by the source roots, inventory in the manifest, in-place refresh), [dispatcher-orchestration.md](/.agents/domains/dispatcher-orchestration.md) (managed worktree default `delete-on-close`, the TeamLeader told its workspace's fate).
  - dev-workflow skill: SKILL.md and the implementation, implementation-review, and solution-consultation references name the `dynamic-workflow` skill.
  - Directory `CLAUDE.md` files, `.agents/glossary.md`, `.agents/root.md`: N/A — none names the old skill names or the configured-id server name (verified by search).
  - `dreamux-maintenance`: `references/service-lifecycle.md` states the `worktree.cleanup` default written into the Team record (`delete-on-close` for a managed worktree requested without `cleanup`, R31); no other config or persisted-state shape changed, and the Claude adapter cache is a rebuildable cache artifact no maintenance reference describes.
  - Change files: `@excitedjs/dreamux` (minor; `BREAKING:` for the reserved skill names with `Rebuild:`, the `cleanup` default, the prompt changes), `@excitedjs/feishu-channel` (minor), `@excitedjs/agent-runtime-claude-code` (patch; the in-place refresh); #369's two files replaced.
