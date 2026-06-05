# @excitedjs/eslint-config

This private workspace package is the shared ESLint flat config for the
Dreamux monorepo.

## Responsibilities

- Own the repository-wide lint rules that packages consume through thin
  `eslint.config.js` files.
- Keep the synchronous blocking IO ban centralized.
- Enforce reasoned inline disables and report stale disable comments.
- Stay dependency-light and runtime-free: this package configures linting only.

## Boundaries

- Do not add runtime behavior, CLI commands, or package-source helpers here.
- Do not add package-specific business rules that only apply to one package;
  keep this config shared or use scoped overrides with clear comments.
- Do not weaken the `src/**/*.ts` synchronous blocking IO gate without updating
  the repository decision records and tests.
- Do not introduce formatting churn. This package is for lint policy, not code
  style rewrites.

## Upstream / Downstream Contract

- Upstream: ESLint, `eslint-plugin-n`, `typescript-eslint`, and
  `eslint-comments`.
- Downstream: all monorepo packages that run `eslint .`.
- Any new rule should be cheap enough for `rush lint` to run without a prior
  build unless there is a separate design decision to change that.
