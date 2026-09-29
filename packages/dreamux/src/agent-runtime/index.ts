// This directory's own barrel (not the package entry point), re-exporting
// every submodule the AgentRuntime seam is made of. eslint-disable, not an
// entryFiles exclusion: `agent-runtime/` stays a stable src/ layer (audit
// §6.1), but only the package's declared entry point(s) are exempted from
// the package-wide re-export ban.
/* eslint-disable no-restricted-syntax -- directory barrel, see comment above */
export * from './capabilities.js';
export * from './catalog.js';
export * from './host-paths.js';
export * from './host-context.js';
export * from './external-provider.js';
/* eslint-enable no-restricted-syntax -- end of directory barrel */
