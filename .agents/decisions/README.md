# Decision Records

Decision records use stable topic slugs, not sequence numbers. Do not create
`0001-...` style names; concurrent agents regularly collide on numbers, while
topic slugs remain reviewable and merge-friendly.

## Browse by Theme

| Theme | Records |
|---|---|
| Repository shape | [rush-pnpm-monorepo](rush-pnpm-monorepo.md), [install-model](install-model.md) |
| Runtime architecture | [top-level-design](top-level-design.md), [global-config-dir](global-config-dir.md), [logging](logging.md) |
| Public surface | [cli-and-package-naming](cli-and-package-naming.md), [dispatcher-tm-boundary](dispatcher-tm-boundary.md), [dispatcher-tm-packaging](dispatcher-tm-packaging.md), [global-bin-onboard-serve](global-bin-onboard-serve.md), [global-config-dir](global-config-dir.md) |
| Release and safeguards | [npm-release-oidc](npm-release-oidc.md), [anti-leak-guardrail](anti-leak-guardrail.md), [no-sync-io-lint-gate](no-sync-io-lint-gate.md) |

## Alphabetical Index

- [anti-leak-guardrail](anti-leak-guardrail.md)
- [cli-and-package-naming](cli-and-package-naming.md)
- [dispatcher-tm-boundary](dispatcher-tm-boundary.md)
- [dispatcher-tm-packaging](dispatcher-tm-packaging.md)
- [global-bin-onboard-serve](global-bin-onboard-serve.md)
- [global-config-dir](global-config-dir.md)
- [install-model](install-model.md)
- [logging](logging.md)
- [no-sync-io-lint-gate](no-sync-io-lint-gate.md)
- [npm-release-oidc](npm-release-oidc.md)
- [rush-pnpm-monorepo](rush-pnpm-monorepo.md)
- [top-level-design](top-level-design.md)

## Adding a Record

Use `decisions/<topic-slug>.md`, with a kebab-case slug that names the
decision's subject. If two agents write records in parallel, the filenames
should remain distinct without negotiating a sequence number.
