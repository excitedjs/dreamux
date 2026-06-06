/**
 * Capability Registry + provider references (issue #110 phase 1 skeleton).
 *
 * Process-local provider registration/lookup and the public provider-ref
 * grammar. Builtin providers run; external `npm:` refs are reserved syntax that
 * is parsed and validated but never loaded or executed in this phase.
 */

export * from './provider-ref.js';
export * from './registry.js';
export * from './builtins.js';
