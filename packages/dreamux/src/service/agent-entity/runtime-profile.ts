import { createHash } from 'node:crypto';

import { validateDispatcherId } from '../../state/dispatcher-id.js';
import {
  DISPATCHER_AGENT_NAME,
  type AgentEntityIdentity,
} from './types.js';

export function dispatcherRuntimeId(dispatcherId: string): string {
  return validateDispatcherId(dispatcherId);
}

export function childAgentRuntimeId(identity: AgentEntityIdentity): string {
  return childRuntimeId(
    identity.dispatcher_id,
    runtimeIdentityName(identity),
  );
}

export function assertDispatcherScopedTeammate(
  identity: AgentEntityIdentity,
  dispatcherId: string,
): void {
  if (
    identity.dispatcher_id === dispatcherId &&
    identity.role === 'teammate' &&
    identity.team_id === null
  ) {
    return;
  }
  throw new Error(`agent ${JSON.stringify(identity.name)} does not exist`);
}

export function assertTeamScopedAgent(
  teamId: string,
): (identity: AgentEntityIdentity, dispatcherId: string) => void {
  return (identity, dispatcherId) => {
    if (
      identity.dispatcher_id === dispatcherId &&
      identity.team_id === teamId &&
      (identity.role === 'team_leader' || identity.role === 'team_member')
    ) {
      return;
    }
    throw new Error(`agent ${JSON.stringify(identity.name)} does not exist`);
  };
}

export function assertDispatcherRootAgent(
  identity: AgentEntityIdentity,
  dispatcherId: string,
): void {
  if (
    identity.dispatcher_id === dispatcherId &&
    identity.role === 'dispatcher' &&
    identity.team_id === null &&
    identity.name === DISPATCHER_AGENT_NAME
  ) {
    return;
  }
  throw new Error(`agent ${JSON.stringify(identity.name)} does not exist`);
}

function childRuntimeId(dispatcherId: string, name: string): string {
  const suffix = createHash('sha256')
    .update(`${dispatcherId}\0${name}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = dispatcherId.slice(0, 40);
  return validateDispatcherId(`${prefix}.tm.${suffix}`, 'teammate runtime id');
}

function runtimeIdentityName(identity: AgentEntityIdentity): string {
  return identity.team_id !== null
    ? `${identity.team_id}.${identity.name}`
    : identity.name;
}
