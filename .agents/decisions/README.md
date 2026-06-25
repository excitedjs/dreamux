# Decision Records

Decision records use stable topic slugs, not sequence numbers. Do not create
`0001-...` style names; concurrent agents regularly collide on numbers, while
topic slugs remain reviewable and merge-friendly.

Decision files preserve history and rationale. For current behavior, start with
[current architecture](../reference/current-architecture.md), plus the focused
[state and paths](../reference/state-and-paths.md) and
[channel runtime](../reference/channel-runtime.md) references when those areas
are involved, then follow the decision trail.

## Current Architecture Trail

Read these first for today's system shape:

- [provider-architecture-realignment](provider-architecture-realignment.md)
- [npm-package-split-and-channel-targets](npm-package-split-and-channel-targets.md)
- [agents-config-normalization](agents-config-normalization.md)
- [runtime-run-root](runtime-run-root.md)
- [dispatcher-local-aggregate](dispatcher-local-aggregate.md)
- [install-model](install-model.md)

## Browse by Theme

| Theme | Records |
|---|---|
| Repository shape | [rush-pnpm-monorepo](rush-pnpm-monorepo.md), [install-model](install-model.md) |
| Runtime architecture | [provider-architecture-realignment](provider-architecture-realignment.md), [npm-package-split-and-channel-targets](npm-package-split-and-channel-targets.md), [agents-config-normalization](agents-config-normalization.md), [dispatcher-local-aggregate](dispatcher-local-aggregate.md), [runtime-run-root](runtime-run-root.md), [issue-110-epic-closure](issue-110-epic-closure.md), [top-level-design](top-level-design.md), [provider-references-and-capability-registry](provider-references-and-capability-registry.md), [agent-runtime-provider](agent-runtime-provider.md), [agent-activity-capability](agent-activity-capability.md), [channel-provider](channel-provider.md), [server-hosted-teammate](server-hosted-teammate.md), [providerized-config-state-compatibility](providerized-config-state-compatibility.md), [global-config-dir](global-config-dir.md), [logging](logging.md), [feishu-inbound-attachments](feishu-inbound-attachments.md), [channel-input-runtime-assembly](channel-input-runtime-assembly.md), [service-architecture-refactor](service-architecture-refactor.md), [cron-per-conversational-agent](cron-per-conversational-agent.md) |
| Persistence | [json-document-store](json-document-store.md), [runtime-run-root](runtime-run-root.md), [providerized-config-state-compatibility](providerized-config-state-compatibility.md) |
| Public surface | [cli-and-package-naming](cli-and-package-naming.md), [dispatcher-tm-boundary](dispatcher-tm-boundary.md), [dispatcher-tm-packaging](dispatcher-tm-packaging.md), [global-bin-onboard-serve](global-bin-onboard-serve.md), [global-config-dir](global-config-dir.md) |
| Release and safeguards | [npm-release-oidc](npm-release-oidc.md), [anti-leak-guardrail](anti-leak-guardrail.md), [no-sync-io-lint-gate](no-sync-io-lint-gate.md) |

## Historical or Superseded Background

These records are intentionally kept in `decisions/` because they are ADRs, but
they are not the first place to learn current behavior:

- [top-level-design](top-level-design.md) — original MVP baseline; still useful
  for unchanged local state/log/access foundations.
- [channel-provider](channel-provider.md) — historical channel-provider
  boundary, superseded by the package split and channel-target decisions.
- [dispatcher-tm-boundary](dispatcher-tm-boundary.md) — superseded by
  server-hosted TeamMate.
- [global-config-dir](global-config-dir.md) — superseded by top-level design.
- [server-hosted-teammate](server-hosted-teammate.md) — superseded for current
  implementation by provider realignment and the package split.

Historical proposals live in [archive/proposals](../archive/proposals/README.md)
instead of this decision index.

## Alphabetical Index

- [agent-activity-capability](agent-activity-capability.md)
- [agents-config-normalization](agents-config-normalization.md)
- [anti-leak-guardrail](anti-leak-guardrail.md)
- [agent-runtime-provider](agent-runtime-provider.md)
- [channel-provider](channel-provider.md)
- [channel-input-runtime-assembly](channel-input-runtime-assembly.md)
- [cli-and-package-naming](cli-and-package-naming.md)
- [cron-per-conversational-agent](cron-per-conversational-agent.md)
- [dispatcher-tm-boundary](dispatcher-tm-boundary.md)
- [dispatcher-tm-packaging](dispatcher-tm-packaging.md)
- [dispatcher-local-aggregate](dispatcher-local-aggregate.md)
- [feishu-inbound-attachments](feishu-inbound-attachments.md)
- [global-bin-onboard-serve](global-bin-onboard-serve.md)
- [global-config-dir](global-config-dir.md)
- [install-model](install-model.md)
- [issue-110-epic-closure](issue-110-epic-closure.md)
- [json-document-store](json-document-store.md)
- [logging](logging.md)
- [no-sync-io-lint-gate](no-sync-io-lint-gate.md)
- [npm-package-split-and-channel-targets](npm-package-split-and-channel-targets.md)
- [npm-release-oidc](npm-release-oidc.md)
- [provider-architecture-realignment](provider-architecture-realignment.md)
- [provider-references-and-capability-registry](provider-references-and-capability-registry.md)
- [providerized-config-state-compatibility](providerized-config-state-compatibility.md)
- [runtime-run-root](runtime-run-root.md)
- [rush-pnpm-monorepo](rush-pnpm-monorepo.md)
- [server-hosted-teammate](server-hosted-teammate.md)
- [service-architecture-refactor](service-architecture-refactor.md)
- [top-level-design](top-level-design.md)

## Adding a Record

Use `decisions/<topic-slug>.md`, with a kebab-case slug that names the
decision's subject. If two agents write records in parallel, the filenames
should remain distinct without negotiating a sequence number.
