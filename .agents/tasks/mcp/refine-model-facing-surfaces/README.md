# Refine the model-facing surfaces of the TeamLeader

## Current state

- Goal: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) — operator rulings R1–R20 recorded verbatim, evidence, and proposed changes 1–12; frozen for the solution phase at the revision that records R20 (2026-09-06).
- Final solution: [technical-design/final.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md) (2026-09-06), adjudicated from [draft.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/draft.md) and the two reviews under `technical-design/reviews/` (Codex and Seed runtimes, R18; the Codex file includes its reconsideration under R21).
- Solution review Issue: Not created.
- Blockers: None.
- Next action: Open the PR on `next`; after the merge and release, run the post-release acceptance probes of final.md §1 on the operator's Codex TeamLeader and a Claude Code TeamLeader.
- Verification: [verification.md](/.agents/tasks/mcp/refine-model-facing-surfaces/verification.md) — implementation method, gates, built-artifact probes, the independent review with adjudication, the live probes of final.md §8, residual risk.
- Lineage: the deep review of PR #369 (https://github.com/excitedjs/dreamux/pull/369) on 2026-09-05; that PR's own record (`relocate-role-skill-guidance`, on the PR branch) holds the 2026-09-02 rulings this task builds on. This task adds one delivery line to that PR's record (draft §3.11): #369 is not merged and its content ships through this task's PR.
- Related tasks: None.

## Development approval

- Status: Granted by the operator on 2026-09-06 (chat message answering the approval card), verbatim: "进开发。你自己用 ultracode 模式一次性搞定。" Bound to [requirement.md](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) R1–R24 and [technical-design/final.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md) as committed at `a169ac94`.
- Approved implementation boundary: final.md §6 (source files in `packages/dreamux`, `packages/channel/feishu-channel`, `packages/agent-runtime/claude-code`; the renamed skill roots and three `SKILL.md` files; the tests of final.md §7; the KB pages and README of §3.10; three change files of §3.11; the task records of §3.13). Non-goals: final.md §5. The three approval-time questions of final.md §9 are settled by R22 (public-artifact rule dropped; second channel-reply sentence deleted) and R23/R24 (Claude adapter fix A, in this PR).
- Implementation method (operator ruling in the same answer): the ultracode workflow, driven by this TeamLeader; member models per R25: opus for the agents that write code, sonnet for the rest.
- Correction to the approved text (implementation, 2026-09-06): final.md §2, §3.7 and §6 counted four `ChannelProviderCatalog.resolve` callers and listed `runnable-channel.ts` as touched. `onboard/wizard.ts` is a fifth caller, so §3.7's return-shape change forces a type-only adaptation there, and `runnable-channel.ts` needs no edit. No requirement, behavior, or scope changes; the three sections now say so.

## Delivery

- Pull request / CI / merge: https://github.com/excitedjs/dreamux/pull/380 (opened 2026-09-06 on `next` from the closeout commit; CI pending at the time of writing; merge pending the operator). #369 stays unmerged and is closed by the operator.
- Knowledge closeout (2026-09-06):
  - Task record (this directory): requirement.md carries R1–R27 verbatim; technical-design/final.md corrected for the fifth `resolve` caller, the new `system-prompt.ts` module, the renamed product page, and the test table; verification.md written.
  - Sibling task record: [relocate-role-skill-guidance](/.agents/tasks/mcp/relocate-role-skill-guidance/README.md) gained the delivery line that #369 ships through this task's PR (final.md §3.13).
  - Product: [dynamic-workflow-usage.md](/.agents/product/dynamic-workflow-usage.md) follows the shared skill's new path. [`.agents/product/README.md`](/.agents/product/README.md): N/A — no catalog entry describes role prompts, dispatch reminders, bundled skill names, or the channel server name; the user-visible behavior of every tool is unchanged.
  - Domains: [channel.md](/.agents/domains/channel.md) (provider-named server, `source` attribute, channel-owned reminder), [dispatcher-skill.md](/.agents/domains/dispatcher-skill.md) (skill names and load triggers), [model-facing-writing.md](/.agents/domains/model-facing-writing.md) (the surface rules of final.md §3.10 and the pre-query visibility facts from review finding 6), [provider-runtime.md](/.agents/domains/provider-runtime.md) (adapter identity and manifest v2).
  - dev-workflow skill: SKILL.md and the implementation, implementation-review, and solution-consultation references name the `dynamic-workflow` skill.
  - Directory `CLAUDE.md` files, `.agents/glossary.md`, `.agents/root.md`: N/A — none names the old skill names or the configured-id server name (verified by search).
  - `dreamux-maintenance`: N/A — no config or persisted-state shape changed; the Claude adapter cache is a rebuildable cache artifact no maintenance reference describes.
  - Change files: `@excitedjs/dreamux` (minor, with the upgrade note on the reserved skill names), `@excitedjs/feishu-channel` (minor), `@excitedjs/agent-runtime-claude-code` (patch); #369's two files replaced.
