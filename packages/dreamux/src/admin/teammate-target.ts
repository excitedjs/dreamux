import type {
  DispatcherService,
  TeamLeaderHandle,
} from '../service/dispatcher-service/index.js';
import { AdminError } from './protocol.js';
import { mustString, optionalString } from './params.js';

export type TeammateTarget =
  | { callerKind: 'dispatcher'; service: DispatcherService }
  | { callerKind: 'team_leader'; service: TeamLeaderHandle };

/** Resolve the existing teammate caller scope for admin-facing capabilities. */
export async function teammateTargetFor(
  dispatcher: DispatcherService,
  params: Record<string, unknown> | undefined,
): Promise<TeammateTarget> {
  const callerKind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (callerKind === 'dispatcher') {
    return { callerKind, service: dispatcher };
  }
  if (callerKind === 'team_leader') {
    return {
      callerKind,
      service: await dispatcher.team(mustString(params, 'team_id')),
    };
  }
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher or team_leader",
  );
}
