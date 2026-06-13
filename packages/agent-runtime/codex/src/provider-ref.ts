/**
 * The stable built-in provider ref this package ships behind. Dreamux core maps
 * `builtin:codex` to `@excitedjs/agent-runtime-codex`; the ref string is the
 * package's own public identity, so it is owned here rather than imported from
 * core (which this package must never depend on).
 */
export const BUILTIN_CODEX_PROVIDER_REF = 'builtin:codex';
