import type {
  DispatcherService,
  TeamLeaderHandle,
} from '../service/dispatcher-service/index.js';
import type { Server } from '../server.js';
import { AdminError } from './protocol.js';
import {
  mustDispatcherId,
  mustExistingDispatcher,
  mustString,
  optionalString,
} from './params.js';

export type TeammateTarget = { dispatcher: DispatcherService } & (
  | { callerKind: 'dispatcher'; service: DispatcherService }
  | { callerKind: 'team_leader'; service: TeamLeaderHandle });

/** Resolve the existing teammate caller scope for admin-facing capabilities. */
export async function teammateTargetFor(
  server: Server,
  params: Record<string, unknown> | undefined,
): Promise<TeammateTarget> {
  const dispatcherId = mustDispatcherId(params);
  mustExistingDispatcher(server, dispatcherId);
  const dispatcher = server.getDispatcher(dispatcherId);
  const callerKind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (callerKind === 'dispatcher') {
    return { dispatcher, callerKind, service: dispatcher };
  }
  if (callerKind === 'team_leader') {
    return {
      dispatcher,
      callerKind,
      service: await dispatcher.team(mustString(params, 'team_id')),
    };
  }
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher or team_leader",
  );
}
