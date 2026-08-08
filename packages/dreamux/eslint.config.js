// Core lint config for @excitedjs/dreamux.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the core side
// of the neutrality import boundary (issue #209): core MUST NOT statically
// import a provider package — it calls only the neutral @excitedjs/dreamux-types
// contracts and resolves `builtin:*` to a package NAME the dynamic loader
// imports at runtime. The boundary (both directions) is centralized in
// @excitedjs/eslint-config so it is expressed once and consumed uniformly.
import baseConfig, {
  SYNC_DESTRUCTURE_SELECTOR,
  withCoreImportBoundary,
} from '@excitedjs/eslint-config';

const SERVICE_REEXPORT_SELECTORS = [
  {
    selector: 'ExportAllDeclaration',
    message:
      'Service submodules must not re-export another module. Import the owning module directly, or add an intentional export to src/service/index.ts.',
  },
  {
    selector: 'ExportNamedDeclaration[source]',
    message:
      'Service submodules must not re-export another module. Import the owning module directly, or add an intentional export to src/service/index.ts.',
  },
];

export default [
  {
    ignores: [
      'tests/fixtures/workflows/code-review-max.mjs',
      'tests/fixtures/workflows/deep-research-max.mjs',
    ],
  },
  ...withCoreImportBoundary(baseConfig),
  {
    files: ['src/service/**/*.ts'],
    ignores: ['src/service/index.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        SYNC_DESTRUCTURE_SELECTOR,
        ...SERVICE_REEXPORT_SELECTORS,
      ],
    },
  },
];
