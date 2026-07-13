// Lint config for @excitedjs/agent-runtime-kimi-code.
//
// Provider packages implement the neutral @excitedjs/dreamux-types contract and
// must not import @excitedjs/dreamux core. The shared config owns that boundary.
import baseConfig, { withProviderImportBoundary } from '@excitedjs/eslint-config';

export default withProviderImportBoundary(baseConfig);
