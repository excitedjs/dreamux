# Promote model and effort to first-class runtime parameters

## Current state

- Goal: Make model and reasoning effort first-class agents[] parameters (defaultModel / defaultEffort) and add /model and /effort commands that switch them on a running runtime
- State: `blocked`
- Requirement: [Final requirement](/.agents/tasks/architecture/promote-runtime-model-and-effort/requirement.md) — confirmed by the operator on 2026-09-20
- Final solution: [Codex keyword alignment](/.agents/tasks/architecture/promote-runtime-model-and-effort/technical-design/final.md) — covers requirement behavior 7 only, written on 2026-09-20 after the operator asked for that slice first ("把那个 Ultrathink 的改动先做一下"). Behaviors 1 to 6 have no solution yet.
- Solution review Issue: Not created.
- Blockers: Behaviors 1 to 6 are paused — the operator stopped the task on 2026-09-20 ("先停在这里，今天不开发") before choosing a solution path. The keyword slice (behavior 7) is delivered.
- Next action: The operator picks a solution path for behaviors 1 to 6.
- Related tasks: shares the `agents[]` configuration surface with [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md), whose requirement and final solution are recorded and whose development the operator deferred on 2026-09-20; whichever task lands first fixes the shape the other builds on.

## Development approval

- Status: Granted for the keyword slice on 2026-09-20. The operator asked for it
  first ("把那个 Ultrathink 的改动先做一下"), then answered the
  solution-path and development-authorization card: "快速通道，直接开发（推荐）"
  and "授权开发". Behaviors 1 to 6 remain unauthorized.
- Approved implementation boundary: `packages/agent-runtime/codex/src/reasoning-effort.ts`,
  `packages/agent-runtime/codex/src/events.ts`,
  `packages/agent-runtime/codex/src/turn-manager.ts`,
  `packages/agent-runtime/codex/tests/codex-ultrathink.test.ts`,
  `packages/agent-runtime/codex/README.md`,
  `.agents/product/README.md`, `.agents/domains/provider-runtime.md`, and one
  ordinary change file. Review is the pull-request review the operator chose
  rather than a local reviewer seat.

## Delivery

- Delivered: requirement behavior 7 — the Codex keyword now matches on a word
  boundary and a matching submission carries Claude Code's sentence as its own
  input item. Behaviors 1 to 6 are not implemented.
- Verification: `rush build`, `rush lint`, `rush test` and
  `rush typecheck:tests` all pass, plus `.agents/scripts/check.sh`. The
  narrowing is covered by test cases for `ultrathinking`, `x_ultrathink_y` and
  `prefixULTRATHINKsuffix`; the last of these asserted the opposite before this
  change.
- Coverage limit: no live Codex run exercised the added input item; the wire
  shape is asserted against the fake client only.
- Knowledge closeout: the product catalog entry, the provider-runtime section
  and the package README were rewritten in the same change. The maintenance
  skill is untouched — no config or persisted state moved.
