// Lint config for @excitedjs/dreamux-plugin-bootstrap.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the provider
// side of the neutrality import boundary (issue #209): a plugin package
// compiles against the neutral @excitedjs/dreamux-types contract and must
// never import @excitedjs/dreamux core. The boundary is centralized in
// @excitedjs/eslint-config.
import baseConfig, { withProviderImportBoundary } from '@excitedjs/eslint-config';

export default withProviderImportBoundary(baseConfig);
