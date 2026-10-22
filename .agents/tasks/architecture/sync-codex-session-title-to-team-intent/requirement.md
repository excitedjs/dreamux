# Requirement

## Outcome

When a native Codex title notification arrives, its title replaces the Team
intent displayed by `/teams`. Reuse that existing title signal without asking
the TeamLeader to produce another summary.

## Operator decisions

The following are English translations of the operator's instructions on
2026-10-22, not broader standing rules:

- Expose the event through the neutral protocol with a reasonable namespace;
  Dreamux Core receives it and updates the Team intent.
- For this delivery, do not support Claude; support Codex only.

## Accepted scope

- Consume Codex `thread/name/updated` for the runtime's own thread.
- Represent the title as a provider-neutral `session.title.changed` state event.
- A Team consumes its own leader's title and persists it as `TeamRecord.intent`.
  Member titles do not replace the Team's topic. The separate leader recovery
  intent keeps its existing semantics.
- A subsequent `/teams` invocation displays the updated intent through the
  existing list projection. Previously sent cards remain snapshots.
- Creation and restored Teams both receive subsequent title updates. Revoked
  runtime generations cannot write newer owners' state.
- Preserve the initial Team intent until a usable native title is received.

## Boundaries

This does not introduce a title generator, a model tool, recap generation,
polling, Claude integration, or cross-app-server title synchronization. Codex
notifications describe names written through its connected app-server; this
does not promise that a bare app-server autonomously creates titles. Dreamux's
current private app-server has no automatic title producer; without a client
writing a name to that instance, the original Team intent remains unchanged.

## Acceptance

Verify native thread scoping, durable neutral delivery and lease rejection,
leader-only Team persistence across reconstruction, and the Team-list/card
projection. Pass Rush build, lint, test, and typecheck:tests. Distinguish native
protocol observation from a deployed Feishu client acceptance test.
