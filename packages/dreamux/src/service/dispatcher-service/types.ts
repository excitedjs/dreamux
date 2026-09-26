import type {
  AgentRuntimeStatus,
  CoreCommandRegistry,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { ConfigReader } from '../../config/service.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentIdentityStore } from '../agent/store.js';
import type { AgentEntityIdentityStatus } from '../agent/identity.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';

export interface DispatcherServiceOptions {
  id: string;
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
  status: AgentEntityIdentityStatus;
  session_id: string | null;
  enabled: boolean;
}

export interface DispatcherRuntimeStatus {
  status: string | null;
  sessionId: string | null;
  lastError: string | null;
}

export interface LiveDispatcherRuntimeStatus {
  status: AgentRuntimeStatus;
  sessionId: string | null;
  lastError: string | null;
}
