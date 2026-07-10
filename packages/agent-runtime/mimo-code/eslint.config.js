// Lint config for @excitedjs/agent-runtime-mimo-code.
//
// Provider packages implement the neutral @excitedjs/dreamux-types contract and
// must not import @excitedjs/dreamux core. The shared config also enforces the
// no synchronous blocking IO gate for package source.
import baseConfig, { withProviderImportBoundary } from '@excitedjs/eslint-config';

export default withProviderImportBoundary(baseConfig);
