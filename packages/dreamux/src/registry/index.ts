/**
 * Provider registry + provider references.
 *
 * Process-local provider registration/lookup and the public provider-ref
 * grammar. Every built-in provider registers through its always-loaded
 * plugin's `contribute()` (`../plugin/loader.js`) before config validation
 * runs; external `npm:` refs are dynamically loaded after, by the provider
 * package loader in this directory.
 */

// This directory's own barrel (not the package entry point), re-exporting
// every submodule the registry is made of. eslint-disable, not an entryFiles
// exclusion: only the package's declared entry point(s) are exempted from
// the package-wide re-export ban.
/* eslint-disable no-restricted-syntax -- directory barrel, see comment above */
export * from './provider-ref.js';
export * from './registry.js';
export * from './builtins.js';
export * from './provider-loader.js';
/* eslint-enable no-restricted-syntax -- end of directory barrel */
