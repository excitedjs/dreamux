import type { ChannelTarget } from '@excitedjs/dreamux-types';

import type { ChannelRouteOwner } from '../channel-service/index.js';
import { validateTeamId } from '../team-collection/types.js';
import { hashTarget, nonBlank, slugFor } from './naming.js';
import { requiredBinding } from './support.js';
import {
  COLLABORATION_SPACE_RECORD_VERSION,
  type CollaborationSpaceProvisionInput,
  type CollaborationSpaceRecord,
  type ProvisionedTargetRecord,
} from './types.js';

/** Build the durable target claim before Team or route side effects begin. */
export function targetClaimRecord(input: {
  dispatcherId: string;
  space: CollaborationSpaceRecord;
  provision: CollaborationSpaceProvisionInput;
}): ProvisionedTargetRecord {
  const binding = requiredBinding(input.space);
  const { provision } = input;
  const targetHash = hashTarget({
    dispatcherId: input.dispatcherId,
    channelId: provision.channelId,
    containerKey: provision.container.container_key,
    bindingGeneration: binding.generation,
    targetKey: provision.target.target_key,
  });
  const display = nonBlank(provision.title) ?? nonBlank(provision.target.display) ?? null;
  const teamName = validateTeamId(`space-${slugFor(display)}-${targetHash}`);
  const now = Date.now();
  return {
    version: COLLABORATION_SPACE_RECORD_VERSION,
    dispatcher_id: input.dispatcherId,
    space_name: input.space.space_name,
    channel_id: provision.channelId,
    provider: provision.provider,
    container_key: provision.container.container_key,
    binding_generation: binding.generation,
    target_key: provision.target.target_key,
    target_type: provision.target.target_type,
    target_display: display,
    target_meta: provision.target.meta ?? {},
    team_name: teamName,
    leader_name: null,
    worktree_slug: teamName,
    lifecycle_status: 'creating',
    phase: 'claimed',
    claim_event_id: provision.eventId ?? null,
    close_event_id: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
    detached_at: null,
  };
}

/** Stable opaque claim token linking one durable target generation to its route. */
export function routeClaimIdForTarget(target: ProvisionedTargetRecord): string {
  return JSON.stringify([
    target.dispatcher_id,
    target.channel_id,
    target.container_key,
    target.binding_generation,
    target.target_key,
  ]);
}

export function ownerForTarget(target: ProvisionedTargetRecord): ChannelRouteOwner {
  if (target.leader_name === null) {
    throw new Error(
      `provisioned target ${JSON.stringify(target.target_key)} has no TeamLeader`,
    );
  }
  return {
    kind: 'team',
    teamName: target.team_name,
    leaderName: target.leader_name,
  };
}

export function targetFromRecord(target: ProvisionedTargetRecord): ChannelTarget {
  return {
    target_type: target.target_type,
    target_key: target.target_key,
    bindable: true,
    ...(target.target_display !== null ? { display: target.target_display } : {}),
    meta: target.target_meta,
  };
}
