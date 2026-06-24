// Lint config for @excitedjs/feishu-channel.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the provider
// side of the neutrality import boundary (issue #209): a channel provider must
// implement the neutral @excitedjs/dreamux-types contract and must never import
// @excitedjs/dreamux core. The boundary is centralized in @excitedjs/eslint-config.
import baseConfig, { withProviderImportBoundary } from '@excitedjs/eslint-config';

export default withProviderImportBoundary(baseConfig);
