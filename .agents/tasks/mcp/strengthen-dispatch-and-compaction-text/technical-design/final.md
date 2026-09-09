# Final technical solution

## Decision and boundary

The original two items use the minimal-change fast path. The operator approved
the additional Channel success-text capability and continued direct TeamLeader
implementation with one independent read-only review on 2026-09-09. No state,
configuration, dependency, routing, or completion-delivery change is introduced.

Requirement: [requirement.md](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/requirement.md).
Baseline: `dd2fc68`, branch `fix/async-receipt-guidance-cot-label`.

## Receipt wording

Restore only the three reminder string values from the parent of `dc2b7eb`
(#380) in `/packages/dreamux/src/service/mcp/dispatch-reminders.ts`. Verified
with `git show dc2b7eb^:packages/dreamux/src/service/mcp/dispatch-reminders.ts`.
The operator requested the version immediately before the current wording; do
not invent a stronger or hybrid version. The operator approved development
against this version on 2026-09-09.

Team:

> Reminder: The Team task was submitted successfully. Dreamux core will automatically push the Team completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.

TeamMate:

> Reminder: The TeamMate task was submitted successfully. Dreamux core will automatically push the TeamMate completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.

Workflow:

> Reminder: The workflow runs in the background. When it finishes, Dreamux automatically pushes the terminal completion into the caller's current context. Unless the user explicitly asks for a status check, do not call or poll workflow_status or other status/read tools; wait for the system push. If there is no other work, the turn may end naturally.

This restores normal-case `Do not poll` and natural turn ending rather than
`DO NOT POLL`, `MUST`, or `end this turn now`. Exact restoration also removes the
current strings' result-prediction and shared-file cautions; no enforcement or
collaboration capability is removed. Correct the nearby comment that attributes
the current wording to Claude Code; keep its runtime visibility explanation.
The existing attachment selectors, descriptions, schemas, structured outputs,
role prompts, and completion mechanisms remain untouched. Sharing the Team
constant deliberately includes the existing `team.send` consumer.

## Compaction label

Change `COMPACTED_SESSION_MESSAGE` to `COMPACTED SESSION` at:

- `/packages/agent-runtime/codex/src/turn-manager.ts`;
- `/packages/agent-runtime/claude-code/src/runtime-activity.ts`.

Align label assertions in `codex-runtime.test.ts`, `runtime-activity.test.ts`,
and `runtime-background.test.ts`. Keep completion-only emission and summary
suppression assertions intact. Adjust directly adjacent current-label comments
without rewriting unrelated documentation or native protocol handling.

## Verification and closeout

- Inspect actual delegate success results for applicable dispatch operations;
  preserve the negative reminder cases and structured results. Extend existing
  receipt tests where needed to cover the explicit no-polling obligation without
  copying whole prose sentences or adding a new test framework.
- Run the repository monorepo gates with
  `node common/scripts/install-run-rush.js`: `build`, `lint`, `test`, and
  `typecheck:tests`; run `update` first if workspace dependencies require it.
- Run `.agents/scripts/check.sh` and the task initializer's `check` command.
- The COT change is provider-emitted text, not a frontend implementation. Verify
  provider activity output through existing runtime tests; report live Feishu
  card and real-model compliance observations as not run unless actually tested.
  Do not restart or deploy the host to obtain them.
- Run one independent read-only implementation review after TeamLeader checks.
- Update the current wording facts in `.agents/domains/model-facing-writing.md`,
  `.agents/domains/provider-runtime.md`, and `.agents/product/README.md`; link
  the new task without rewriting historical operator rulings or generated
  changelogs. Record the prior model-facing wording as superseded only within
  this dispatch-reminder boundary.
- Generate patch Rush change notes for the five affected publishable packages
  through `rush change`. No upgrade, rebuild, or migration is introduced.
- The operator subsequently authorized commit, push, and opening a PR targeting
  `next` on 2026-09-09. Merge, deployment, and Team dissolution are not authorized.

## Binding notification receipts

The operator approved this additive Channel result capability on 2026-09-09:
"可以，合并做了就行" (approved; implement together). Continue direct TeamLeader
implementation and review the combined change once in an independent read-only
review. The standard MCP result envelope already supports the text; only the
internal Channel-to-Core result carrier needs extending.

- Let `ChannelMcpToolOutcome` carry optional success `text` separately from its
  existing `value`. Core forwards it into the existing delegate success `text`
  carrier without reading tool names or changing structured results.
- Add an optional result-to-success-text function to `FeishuToolDef`, invoked
  only after a successful tool outcome by `createFeishuSessionMcp`. This keeps
  text selection beside the tool's own contract and preserves all existing
  handlers' structured return values and output schemas.
- Both caller-specific `bind_channel` definitions provide the bind message;
  both `unbind_channel` definitions provide the unbind message only when
  `unbound` is true. Shared routing-tool wording stays in `routing-tools.ts`.
- Binding text: `Binding succeeded. The system will automatically send a notification card; no additional user notification is needed.`
- Unbinding text: `Unbinding succeeded. The system will automatically send a notification card; no additional user notification is needed.`
- Do not attach the message to no-op unbinds, failures, or other tools. Do not
  change routing, card dispatch, best-effort delivery, ownership checks, tool
  descriptions, or collaboration-space operations. The text describes automatic
  notification, not confirmed receipt of the card.
- Add behavioral tests for both caller scopes, successful bind and actual
  unbind, no-op/refused calls, and neutral Core pass-through with unchanged
  structured data. Update the Channel knowledge owner and corresponding patch
  change notes alongside the original verification gates.
- Claude Code's existing suppression of MCP content text beside structured
  content remains unchanged; this request adds only the extra text carrier.

## Residual limitation

Strong reminder text is not an enforcement layer. Receipt and activity tests
can verify what Codex is shown, not guarantee the choices of every future model
turn. The requested solution is wording-only; a tool-level polling blocker is
not part of this task.
