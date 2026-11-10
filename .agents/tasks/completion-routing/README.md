# Completion Routing Tasks

## Scope

- Cross-provider completion delivery semantics: logical completion identity, at-most-once ordered push-back, and turn settlement contracts.

## Code signals

| Area | Current code signal |
| --- | --- |
| completion-router | `packages/dreamux/src/service/completion-router` |

## Child Scopes

## Tasks
- [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — Replace Claude request windows with resident-session settlement and correct native failure reporting, retaining background work and Core completion-token routing. Original delivery: PR #344.
- [Drop lifecycle-stop completion pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/README.md) — Stop reporting a turn or Workflow terminal to the owner whose own close, stop, dissolve, or shutdown ended it, by reading the scope fence on the recipient side rather than retiring obligations on the producer side.
- [Trigger-aware delivery](/.agents/tasks/completion-routing/trigger-aware-delivery/README.md) — Only a person's message may interrupt work in progress; a completion report reaches a busy Codex recipient as appended context and starts a turn only when the thread is idle.
