import type {
  AgentRuntimeStatus,
  CoreCommandRegistry,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DispatcherConfig } from '../../config/config.js';
import type { ConfigReader } from '../../config/service.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentIdentityStore } from '../agent/store.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import type { RestartIntentConsumer } from './restart-intent.js';

export interface DispatcherServiceOptions {
  id: string;
  /**
   * This dispatcher's own config entry, resolved once by
   * `Dispatchers.dispatcherOptions()` instead of re-derived independently
   * here, by `ChannelService`, and by `DispatcherLifecycle` from
   * the same live `config.current().dispatchers.find(...)` lookup.
   */
  dispatcher: DispatcherConfig;
  config: ConfigReader;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  /**
   * The dispatcher-root Agent's own identity store, shared with `Dispatchers`'
   * read-only fallback reader (`summarize()`/`status()` when no live runtime
   * status exists) so the two never hold independently cached committed
   * values over the same `identity.json`.
   */
  identities: AgentIdentityStore;
  /** The process-wide Agent-facing MCP lease registry this dispatcher mints into. */
  mcpLeases: McpLeaseRegistry;
  /**
   * The one restart marker this whole process loaded at boot (issue #78),
   * resolved once by `server.ts` before any `Dispatchers`/`DispatcherService`
   * exists and forwarded unchanged from here on — there is no setter, because
   * a marker loaded after a dispatcher already started could never reach an
   * agent that activates lazily, and R11 removes the only surface
   * (`dispatcher start`) that could have restarted one to pick it up.
   */
  restartIntent: RestartIntentConsumer;
  /**
   * The process-wide admitted Command port. This dispatcher's Channel sessions
   * invoke Commands through it, so they share the admin socket's catalog,
   * validation, and shutdown fence rather than getting a second surface.
   */
  commands: CoreCommandRegistry;
  /** Host home prefixes resolved by Server before this aggregate is built. */
  homePathPrefixes: readonly string[];
  adminSocketPath?: string | undefined;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  workflowLoggerFactory?: ((dispatcherId: string) => DreamuxLogger) | undefined;
  log: DreamuxLogger;
}

export interface DispatcherSummary {
  dispatcher_id: string;
  channel_identity: string;
  status: AgentRuntimeStatus;
  session_id: string | null;
  enabled: boolean;
}

/** One dispatcher's runtime-status projection, live or cold, always speaking `AgentRuntimeStatus`. */
export interface DispatcherRuntimeStatus {
  status: AgentRuntimeStatus;
  sessionId: string | null;
  lastError: string | null;
}
