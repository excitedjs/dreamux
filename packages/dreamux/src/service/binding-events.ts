import type {
  ChannelBindingCollaborationSpacePolicySnapshot,
  ChannelBindingEndpointSnapshot,
  ChannelBindingRouteOwnerSnapshot,
  ChannelBindingRouteTeamSnapshot,
} from '@excitedjs/dreamux-types';

import type {
  ChannelBinding,
  ChannelBindingBindTransition,
  ChannelBindingUnbindTransition,
} from './channel-binding/store.js';
import type { CollaborationSpaceBindTransition } from './collaboration-space/store.js';
import type { CollaborationSpaceRecord } from './collaboration-space/types.js';
import type { DispatcherCoreEventPublisher } from './dispatcher-core-events/index.js';
import type { TeamRouteProjection } from './team-collection/types.js';

export function publishRouteBindTransition(input: {
  coreEvents: DispatcherCoreEventPublisher | undefined;
  dispatcherId: string;
  transition: ChannelBindingBindTransition;
  currentTeam: TeamRouteProjection;
}): void {
  if (input.transition.transition === 'unchanged') return;
  input.coreEvents?.publish(input.dispatcherId, {
    schema_version: 1,
    kind: 'binding.route',
    occurred_at: input.transition.binding.updated_at,
    action: 'bound',
    transition: input.transition.transition,
    endpoint: endpointFromBinding(input.transition.binding),
    previous_team: activeTeamFromBinding(input.transition.previous),
    current_team: teamFromProjection(input.currentTeam),
  });
}

export function publishRouteUnbindTransition(input: {
  coreEvents: DispatcherCoreEventPublisher | undefined;
  dispatcherId: string;
  transition: ChannelBindingUnbindTransition;
}): void {
  if (input.transition.transition === 'unchanged') return;
  input.coreEvents?.publish(input.dispatcherId, {
    schema_version: 1,
    kind: 'binding.route',
    occurred_at: input.transition.binding.updated_at,
    action: 'unbound',
    transition: 'unbound',
    endpoint: endpointFromBinding(input.transition.binding),
    previous_team: teamOwnerFromBinding(input.transition.previous),
    current_team: null,
  });
}

export function publishCollaborationSpaceBindTransition(input: {
  coreEvents: DispatcherCoreEventPublisher | undefined;
  dispatcherId: string;
  transition: CollaborationSpaceBindTransition;
}): void {
  if (input.transition.transition !== 'bound') return;
  const space = input.transition.space;
  const binding = space.current_binding;
  if (binding === null) return;
  input.coreEvents?.publish(input.dispatcherId, {
    schema_version: 1,
    kind: 'binding.collaboration_space',
    occurred_at: space.updated_at,
    action: 'bound',
    transition: 'bound',
    container: endpointFromSpace(space),
    space_name: space.space_name,
    current_binding: collaborationPolicy(binding),
  });
}

export function publishCollaborationSpaceUnbound(input: {
  coreEvents: DispatcherCoreEventPublisher | undefined;
  dispatcherId: string;
  space: CollaborationSpaceRecord;
}): void {
  input.coreEvents?.publish(input.dispatcherId, {
    schema_version: 1,
    kind: 'binding.collaboration_space',
    occurred_at: input.space.updated_at,
    action: 'unbound',
    transition: 'unbound',
    container: endpointFromSpace(input.space),
    space_name: input.space.space_name,
    current_binding: null,
  });
}

function endpointFromBinding(binding: ChannelBinding): ChannelBindingEndpointSnapshot {
  return Object.freeze({
    provider: binding.provider,
    channel_id: binding.channel_id,
    endpoint_type: binding.target_type,
    endpoint_key: binding.target_key,
    display: binding.display,
    canonical_url: binding.canonical_url,
    meta: immutableMetadataSnapshot(binding.meta),
  });
}

function endpointFromSpace(
  space: CollaborationSpaceRecord,
): ChannelBindingEndpointSnapshot {
  return Object.freeze({
    provider: space.provider,
    channel_id: space.channel_id,
    endpoint_type: space.container_type,
    endpoint_key: space.container_key,
    display: space.display,
    canonical_url: space.canonical_url,
    meta: immutableMetadataSnapshot(space.meta),
  });
}

function teamFromProjection(
  projection: TeamRouteProjection,
): ChannelBindingRouteTeamSnapshot {
  return Object.freeze({
    team_name: projection.team_name,
    leader_name: projection.leader_name,
    leader_agent_runtime: projection.leader_agent_runtime,
    runtime_cwd: projection.runtime_cwd,
  });
}

function activeTeamFromBinding(
  binding: ChannelBinding | null,
): ChannelBindingRouteOwnerSnapshot | null {
  if (binding === null || !binding.active) return null;
  return Object.freeze({
    team_name: binding.team_name,
    leader_name: binding.leader_name,
  });
}

function teamOwnerFromBinding(
  binding: ChannelBinding,
): ChannelBindingRouteOwnerSnapshot {
  return Object.freeze({
    team_name: binding.team_name,
    leader_name: binding.leader_name,
  });
}

function collaborationPolicy(
  binding: NonNullable<CollaborationSpaceRecord['current_binding']>,
): ChannelBindingCollaborationSpacePolicySnapshot {
  const worktree = binding.worktree.mode === 'managed'
    ? Object.freeze({ ...binding.worktree })
    : Object.freeze({ mode: 'default' as const });
  return Object.freeze({
    leader_agent_runtime: binding.leader_agent_runtime,
    repo_cwd: binding.repo_cwd,
    worktree,
  });
}

function immutableMetadataSnapshot(
  meta: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const snapshot = JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
