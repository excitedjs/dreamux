// Core lint config for @excitedjs/dreamux.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus the core side
// of the neutrality import boundary (issue #209): core MUST NOT statically
// import a provider package — it calls only the neutral @excitedjs/dreamux-types
// contracts and resolves `builtin:*` to a package NAME the dynamic loader
// imports at runtime. The boundary (both directions) is centralized in
// @excitedjs/eslint-config so it is expressed once and consumed uniformly.
import baseConfig, { withCoreImportBoundary } from '@excitedjs/eslint-config';

export default withCoreImportBoundary(baseConfig);
