import type {
  CollaborationSpaceRecord,
  CollaborationSpaceView,
  ProvisionedTargetRecord,
  ProvisionedTargetStatus,
  ProvisionedTargetView,
} from './types.js';

export function targetCounts(
  targets: ProvisionedTargetRecord[],
): Record<ProvisionedTargetStatus, number> {
  return {
    creating: countTargets(targets, 'creating'),
    active: countTargets(targets, 'active'),
    detached: countTargets(targets, 'detached'),
    closing: countTargets(targets, 'closing'),
    closed: countTargets(targets, 'closed'),
    failed: countTargets(targets, 'failed'),
  };
}

export function targetView(target: ProvisionedTargetRecord): ProvisionedTargetView {
  return {
    space_name: target.space_name,
    channel_id: target.channel_id,
    provider: target.provider,
    container_key: target.container_key,
    binding_generation: target.binding_generation,
    target_type: target.target_type,
    target_key: target.target_key,
    target_display: target.target_display,
    team_name: target.team_name,
    leader_name: target.leader_name,
    lifecycle_status: target.lifecycle_status,
    phase: target.phase,
    last_error: target.last_error,
    created_at: target.created_at,
    updated_at: target.updated_at,
    closed_at: target.closed_at,
    detached_at: target.detached_at,
  };
}

export function spaceView(
  space: CollaborationSpaceRecord,
  targets: ProvisionedTargetRecord[],
): CollaborationSpaceView {
  return {
    space_name: space.space_name,
    channel_id: space.channel_id,
    provider: space.provider,
    container_type: space.container_type,
    container_key: space.container_key,
    display: space.display,
    canonical_url: space.canonical_url,
    status: space.status,
    current_binding: space.current_binding === null
      ? null
      : {
          generation: space.current_binding.generation,
          worktree: space.current_binding.worktree,
          leader_agent_runtime: space.current_binding.leader_agent_runtime,
          has_identity: space.current_binding.identity !== null,
          bound_at: space.current_binding.bound_at,
        },
    last_binding_generation: space.last_binding_generation,
    target_counts: targetCounts(targets),
    created_at: space.created_at,
    updated_at: space.updated_at,
    unbound_at: space.unbound_at,
    unbound_note: space.unbound_note,
  };
}

function countTargets(
  targets: ProvisionedTargetRecord[],
  status: ProvisionedTargetStatus,
): number {
  return targets.filter((target) => target.lifecycle_status === status).length;
}
