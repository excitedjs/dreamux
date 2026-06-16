/**
 * Host-owned pieces of the neutral `@excitedjs/dreamux-types` create context
 * (issue #209 cleanup).
 *
 * There are no host↔neutral adapters here: core's logger IS the neutral
 * `DreamuxLogger` (see `platform/logger.ts`, pino wrapped at construction) and
 * the dispatcher store implements the neutral `AgentRuntimeStateCallbacks`
 * directly, so both are injected into the create context as-is. The only thing
 * that lives here is the host's process-env injection seam below.
 */

/**
 * The host's neutral process-env injection seam (settled env-boundary decision,
 * issue #209). Core merges these entries into every runtime's spawn env after
 * `process.env` and before the provider's own `config.extra_env`. It is empty
 * today — the dreamux host injects nothing — but is the single, discoverable
 * place to add a host-owned env entry should one ever be needed, so providers
 * never reach back into core for it. A provider's `extra_env` is its OWN config
 * and is never routed through here.
 */
export const HOST_INJECT_ENV: Record<string, string> = {};
