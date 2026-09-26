/**
 * The single composition root of the Core Command catalog.
 *
 * Each domain contributes its own definitions; this module only concatenates
 * them into the one registry the whole process shares. Adding a Command means
 * adding it to its owning domain module — never to an adapter, and never to a
 * second registry.
 *
 * Every domain's `xCommands` factory takes the narrowest resolver it actually
 * calls, not the full {@link CoreCommandHost}: a `service/*` module importing
 * this file's `CoreCommandHost` would be an upward edge (composition-tier),
 * exactly what the per-domain factories exist to avoid. This is the one place
 * that is allowed to know every domain type, so it is also the one place that
 * resolves `mustDispatcher`'s not-found handling — built once below and handed
 * to every domain that needs it, rather than each domain re-deriving it.
 */
import type { CoreCommandContext } from '@excitedjs/dreamux-types';

import { serverCommands } from '../server-commands.js';
import { configCommands } from '../config/commands.js';
import { channelCommands } from '../service/channel-service/commands.js';
import { dispatcherCommands } from '../service/dispatchers/commands.js';
import { mcpCommands } from '../service/mcp/commands.js';
import { schedulerCommands } from '../service/scheduler/commands.js';
import { teamCommands } from '../service/team-collection/commands.js';
import { teammateCommands } from '../service/agent/commands.js';
import { workflowCommands } from '../service/workflow-service/commands.js';
import { CoreCommands } from '../command/registry.js';
import {
  mustDispatcher,
  mustDispatcherRow,
  type CoreCommandHost,
} from './command-host.js';

export function createCoreCommandRegistry(host: CoreCommandHost): CoreCommands {
  // Built once and handed to every domain that resolves a dispatcher through
  // caller context, so `mustDispatcher`'s not-found handling is not
  // re-derived per domain. Each domain factory below only ever declares the
  // narrower shape it actually calls on the result (`DispatcherService`
  // itself structurally satisfies every one of those narrower parameter
  // types, so passing this same function to more than one factory needs no
  // per-domain wrapping).
  const dispatcher = (context: CoreCommandContext) =>
    mustDispatcher(host, context);
  return new CoreCommands([
    ...serverCommands(host),
    ...configCommands(host.config),
    ...dispatcherCommands({
      summarize: () => host.summarize(),
      dispatcherRuntimeStatus: (id) => host.dispatcherRuntimeStatus(id),
      dispatcherRow: (id) => mustDispatcherRow(host, id),
      dispatcher,
    }),
    ...channelCommands(dispatcher),
    ...teamCommands(dispatcher),
    ...teammateCommands(dispatcher),
    ...workflowCommands((context) => dispatcher(context).workflows),
    ...schedulerCommands(dispatcher),
    ...mcpCommands(host.mcpLeases),
  ]);
}
