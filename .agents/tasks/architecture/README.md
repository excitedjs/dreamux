# Architecture Tasks

## Scope

- Cross-cutting architecture boundaries, public contracts, layering, and capability ownership.

## Code signals

| Area | Current code signal |
| --- | --- |
| Architecture contracts | `packages/dreamux-types/src; Core boundaries=packages/dreamux/src` |

## Child Scopes

## Tasks
- [Harness Gaps](/.agents/tasks/architecture/harness-gaps/README.md) — `intake`: Track executable-guard gaps (parity gate regression, dependency graph, AST neutrality, knowledge-delta drift) until implemented or rejected.
- [Task System Records](/.agents/tasks/architecture/task-system/README.md) — `done`: Preserve the development task system decisions: capability-domain task routing and the lean development task with GitHub solution review.
- [Repository Guardrail Records](/.agents/tasks/architecture/repository-guardrails/README.md) — `done`: Preserve the repository guardrail decisions: the anti-leak guardrail, npm release OIDC, and the no-sync-IO lint gate with the 700-line cap.
- [Platform Run Roots And Logging Records](/.agents/tasks/architecture/platform-run-roots-and-logging/README.md) — `done`: Preserve the runtime run-root and logging decisions.
- [Service Topology Foundation Records](/.agents/tasks/architecture/service-topology-foundations/README.md) — `done`: Preserve the service-layer topology decisions: the Collection + Service split, entity-owned TeamMate lifecycle and object turns, and the JSON document store.
- [NPM Package Split Records](/.agents/tasks/architecture/npm-package-split/README.md) — `done`: Preserve the issue #209 packaging decisions: the npm package split and channel targets, CLI and package naming, the monorepo-only install model, and the Rush/pnpm monorepo choice.
- [Providerization Epic Records](/.agents/tasks/architecture/providerization-epic/README.md) — `done`: Preserve the accepted providerization decisions (issues #110/#135): the AgentRuntime provider architecture, provider references and the process-local registry, providerized config compatibility, and agents[] normalization.
- [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md) — `done`: Reduce Agent Runtime and Channel contracts to minimal Command-invocation and Core-event ports without reducing Channel's external-interaction responsibility. Merged as PR #350 (+#353, #356); the task archive (requirement, final design, verification) is the decision record.
