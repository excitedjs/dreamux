import { createHash } from 'node:crypto';

import { validateDispatcherId } from '../../platform/dispatcher-id.js';
import type { AgentEntityIdentity } from './identity.js';

export function dispatcherRuntimeId(dispatcherId: string): string {
  return validateDispatcherId(dispatcherId);
}

export function childAgentRuntimeId(identity: AgentEntityIdentity): string {
  return childRuntimeId(identity.dispatcher_id, runtimeIdentityName(identity));
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
