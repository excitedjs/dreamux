/**
 * The single composition root of the Core Command catalog.
 *
 * Each domain contributes its own definitions; this module only concatenates
 * them into the one registry the whole process shares. Adding a Command means
 * adding it to its owning domain module — never to an adapter, and never to a
 * second registry.
 */
import { serverCommands } from '../server-commands.js';
import { dispatcherCommands } from '../service/dispatchers/commands.js';
import { mcpCommands } from '../service/mcp/commands.js';
import { schedulerCommands } from '../service/scheduler/commands.js';
import { teamCommands } from '../service/team-collection/commands.js';
import { teammateCommands } from '../service/teammate-collection/commands.js';
import { workflowCommands } from '../service/workflow-service/commands.js';
import type { CoreCommandHost } from './host.js';
import { CoreCommands } from './registry.js';

export function createCoreCommandRegistry(host: CoreCommandHost): CoreCommands {
  return new CoreCommands([
    ...serverCommands(host),
    ...dispatcherCommands(host),
    ...teamCommands(host),
    ...teammateCommands(host),
    ...workflowCommands(host),
    ...schedulerCommands(host),
    ...mcpCommands(host),
  ]);
}
