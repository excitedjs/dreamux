/**
 * Provider registry + provider references.
 *
 * Process-local provider registration/lookup and the public provider-ref
 * grammar. Builtin providers are registered eagerly; external `npm:` runtime
 * refs are dynamically loaded before config validation resolves them.
 */

export * from './provider-ref.js';
export * from './registry.js';
export * from './builtins.js';
