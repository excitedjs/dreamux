import type {
  AgentRuntimeStatus,
  CoreCommandRegistry,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { ChannelCommandRegistrar } from '../../command/channel-commands.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentEntityIdentityStatus } from '../agent-entity/types.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';

export interface DispatcherServiceOptions {
  id: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  /** The process-wide Agent-facing MCP lease registry this dispatcher mints into. */
  mcpLeases: McpLeaseRegistry;
  /**
   * The process-wide admitted Command port. This dispatcher's Channel sessions
   * invoke Commands through it, so they share the admin socket's catalog,
   * validation, and shutdown fence rather than getting a second surface.
   */
  commands: CoreCommandRegistry;
  /**
   * The registration half of the same port, which is Core-internal.
   *
   * A dispatcher registers its Channels' Commands and revokes them when it
   * stops; a Channel only ever invokes. Carrying registration as its own field
   * — rather than widening `commands` — keeps the provider-facing
   * {@link CoreCommandRegistry} exactly as narrow as it is today.
   */
  channelCommands: ChannelCommandRegistrar;
  /** Host home prefixes resolved by Server before this aggregate is built. */
  homePathPrefixes: readonly string[];
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  workflowLoggerFactory?: (dispatcherId: string) => DreamuxLogger;
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
