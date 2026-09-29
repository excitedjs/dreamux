// Lint config for @excitedjs/feishu-channel.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the provider
// side of the neutrality import boundary (issue #209): a channel provider must
// implement the neutral @excitedjs/dreamux-types contract and must never import
// @excitedjs/dreamux core. The boundary is centralized in @excitedjs/eslint-config.
// The package-wide re-export ban is centralized there too (code-organization
// refactor, H6) — only this package's own root barrel (src/index.ts) may
// re-export another module.
import baseConfig, {
  withProviderImportBoundary,
  withPackageEntryOnlyReexports,
} from '@excitedjs/eslint-config';

export default withPackageEntryOnlyReexports(
  withProviderImportBoundary(baseConfig),
  { entryFiles: ['src/index.ts'] },
);
