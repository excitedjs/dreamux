// Lint config for @excitedjs/feishu-transport.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the provider
// side of the neutrality import boundary (issue #209): this platform-I/O package
// must stay host-agnostic and must never import @excitedjs/dreamux core (it must
// be usable by multiple hosts). The boundary is centralized in @excitedjs/eslint-config.
import baseConfig, { withProviderImportBoundary } from '@excitedjs/eslint-config';

export default withProviderImportBoundary(baseConfig);
