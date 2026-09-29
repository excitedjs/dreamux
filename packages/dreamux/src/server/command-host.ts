import type { DispatcherCommandHost } from '../command/host.js';
import type { DispatcherConfig } from '../config/config.js';
import type { ConfigService } from '../config/service.js';
import type { DispatcherService } from '../service/dispatcher-service/index.js';
import type { Dispatchers } from '../service/dispatchers/index.js';
import type { McpLeaseRegistry } from '../service/mcp/leases.js';

/** Server's actual owners; its dispatchers accessor resolves the pre-start edge. */
export interface CoreCommandHost extends DispatcherCommandHost<DispatcherService> {
  configuredDispatcher(id: string): DispatcherConfig;
  readonly dispatchers: Dispatchers;
  readonly mcpLeases: McpLeaseRegistry;
  readonly config: ConfigService;
}
