/**
 * The single composition root of the Core Command catalog.
 *
 * Each domain contributes its own definitions; this module only concatenates
 * them into the one registry the whole process shares. Adding a Command means
 * adding it to its owning domain module — never to an adapter, and never to a
 * second registry.
 *
 * Domain factories receive this actual host through structural views naming
 * only the services they use. `Server.dispatchers` resolves the late startup
 * edge. Its addressed lookup validates current configuration before touching
 * that accessor, preserving pre-start missing-id and not-found errors as well
 * as the configured-id check before a live cache hit. Domain modules import neither Server nor
 * this composition module.
 */

import { CoreCommands } from '../command/registry.js';
import { configCommands } from '../config/commands.js';
import { serverCommands } from '../server-commands.js';
import { teammateCommands } from '../service/agent/commands.js';
import { channelCommands } from '../service/channel-service/commands.js';
import { dispatcherCommands } from '../service/dispatchers/commands.js';
import { mcpCommands } from '../service/mcp/commands.js';
import { schedulerCommands } from '../service/scheduler/commands.js';
import { teamCommands } from '../service/team/commands.js';
import { workflowCommands } from '../service/workflow-service/commands.js';
import type { CoreCommandHost } from './command-host.js';

export function createCoreCommandRegistry(host: CoreCommandHost): CoreCommands {
  return new CoreCommands([
    ...serverCommands(host),
    ...configCommands(host.config),
    ...dispatcherCommands(host),
    ...channelCommands(host),
    ...teamCommands(host),
    ...teammateCommands(host),
    ...workflowCommands(host),
    ...schedulerCommands(host),
    ...mcpCommands(host.mcpLeases),
  ]);
}
