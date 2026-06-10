# Decision Records

Decision records use stable topic slugs, not sequence numbers. Do not create
`0001-...` style names; concurrent agents regularly collide on numbers, while
topic slugs remain reviewable and merge-friendly.

## Browse by Theme

| Theme | Records |
|---|---|
| Repository shape | [rush-pnpm-monorepo](rush-pnpm-monorepo.md), [install-model](install-model.md) |
| Runtime architecture | [top-level-design](top-level-design.md), [issue-110-epic-closure](issue-110-epic-closure.md), [provider-references-and-capability-registry](provider-references-and-capability-registry.md), [agent-runtime-provider](agent-runtime-provider.md), [channel-provider](channel-provider.md), [server-hosted-teammate](server-hosted-teammate.md), [providerized-config-state-compatibility](providerized-config-state-compatibility.md), [agents-config-normalization](agents-config-normalization.md), [global-config-dir](global-config-dir.md), [logging](logging.md), [feishu-inbound-attachments](feishu-inbound-attachments.md), [channel-input-runtime-assembly](channel-input-runtime-assembly.md), [runtime-run-root](runtime-run-root.md) |
| Public surface | [cli-and-package-naming](cli-and-package-naming.md), [dispatcher-tm-boundary](dispatcher-tm-boundary.md), [dispatcher-tm-packaging](dispatcher-tm-packaging.md), [global-bin-onboard-serve](global-bin-onboard-serve.md), [global-config-dir](global-config-dir.md) |
| Release and safeguards | [npm-release-oidc](npm-release-oidc.md), [anti-leak-guardrail](anti-leak-guardrail.md), [no-sync-io-lint-gate](no-sync-io-lint-gate.md) |

## Alphabetical Index

- [agents-config-normalization](agents-config-normalization.md)
- [anti-leak-guardrail](anti-leak-guardrail.md)
- [agent-runtime-provider](agent-runtime-provider.md)
- [channel-provider](channel-provider.md)
- [channel-input-runtime-assembly](channel-input-runtime-assembly.md)
- [cli-and-package-naming](cli-and-package-naming.md)
- [dispatcher-tm-boundary](dispatcher-tm-boundary.md)
- [dispatcher-tm-packaging](dispatcher-tm-packaging.md)
- [feishu-inbound-attachments](feishu-inbound-attachments.md)
- [global-bin-onboard-serve](global-bin-onboard-serve.md)
- [global-config-dir](global-config-dir.md)
- [install-model](install-model.md)
- [issue-110-epic-closure](issue-110-epic-closure.md)
- [logging](logging.md)
- [no-sync-io-lint-gate](no-sync-io-lint-gate.md)
- [npm-release-oidc](npm-release-oidc.md)
- [provider-references-and-capability-registry](provider-references-and-capability-registry.md)
- [providerized-config-state-compatibility](providerized-config-state-compatibility.md)
- [runtime-run-root](runtime-run-root.md)
- [rush-pnpm-monorepo](rush-pnpm-monorepo.md)
- [server-hosted-teammate](server-hosted-teammate.md)
- [top-level-design](top-level-design.md)

## Adding a Record

Use `decisions/<topic-slug>.md`, with a kebab-case slug that names the
decision's subject. If two agents write records in parallel, the filenames
should remain distinct without negotiating a sequence number.
