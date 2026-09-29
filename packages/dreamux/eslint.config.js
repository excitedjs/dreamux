// Core lint config for @excitedjs/dreamux.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the core side
// of the neutrality import boundary (issue #209): core MUST NOT statically
// import a provider package — it calls only the neutral @excitedjs/dreamux-types
// contracts and resolves `builtin:*` to a package NAME the dynamic loader
// imports at runtime. The boundary (both directions) is centralized in
// @excitedjs/eslint-config so it is expressed once and consumed uniformly.
// The package-wide re-export ban is centralized there too (code-organization
// refactor, H6) — this package has no root src/index.ts, so only
// src/service/index.ts is excluded: smoke-built-cli still asserts its exact
// export surface until that barrel is deleted in a later refactor stage.
import baseConfig, {
  withCoreImportBoundary,
  withPackageEntryOnlyReexports,
} from '@excitedjs/eslint-config';

export default [
  {
    ignores: ['tests/fixtures/workflows/*.mjs'],
  },
  ...withPackageEntryOnlyReexports(withCoreImportBoundary(baseConfig), {
    entryFiles: ['src/service/index.ts'],
  }),
];
