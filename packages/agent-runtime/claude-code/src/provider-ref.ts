/**
 * The stable built-in provider ref this package ships behind. Dreamux core maps
 * `builtin:claude-code` to `@excitedjs/agent-runtime-claude-code`; the ref string
 * is the package's own public identity, so it is owned here rather than imported
 * from core (which this package must never depend on).
 */
export const BUILTIN_CLAUDE_CODE_PROVIDER_REF = 'builtin:claude-code';
