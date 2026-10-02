/**
 * Host-owned pieces of the neutral `@excitedjs/dreamux-types` create context
 * (issue #209 cleanup).
 *
 * There are no host↔neutral adapters here: core's logger IS the neutral
 * `DreamuxLogger` (see `platform/logger.ts`, pino wrapped at construction) and
 * the entity's runtime state issues the neutral `AgentRuntimeStateSink` lease
 * directly, so both are injected into the create context as-is.
 */

export const DISABLE_FEATURE_CRON = 'cron';

/**
 * Disable the runtime's model-facing "ask the user a question" capability. A
 * Dreamux agent reaches a human only through its channel, so a tool that blocks
 * the turn waiting for an out-of-band answer just wedges. Emitted for every
 * agent as a core-wide rule; each runtime maps this neutral name to its own
 * mechanism (see that runtime package). The guarantee is at the Dreamux-authored
 * launch level; operator `extra_args` remains a raw, unpoliced escape hatch on
 * every runtime.
 */
export const DISABLE_FEATURE_USER_INTERRUPT = 'userInterrupt';
