import type {
  TeamMateCallerPrincipal,
  TeamMateIdentity,
} from './types.js';

export function ownerForPrincipal(
  principal: TeamMateCallerPrincipal,
): TeamMateIdentity['owner'] {
  if (principal.kind === 'team_leader') {
    return {
      kind: 'team',
      dispatcher_id: principal.dispatcherId,
      team_id: principal.teamId,
      leader_name: principal.leaderName,
    };
  }
  return { kind: 'dispatcher', dispatcher_id: principal.dispatcherId };
}

/**
 * The single visibility predicate for the `teammate.*` surface (issue #199
 * Slice 4). Every scoped read enforces it through exactly one of two
 * chokepoints — list reads and single-record reads — so the rules below are
 * applied consistently and cannot be bypassed by a new read site.
 *
 * - A dispatcher sees only the ordinary TeamMates it directly spawned: a
 *   dispatcher-owned record with `role === 'teammate'`. A TeamLeader is also
 *   dispatcher-owned (its `owner.kind` is `dispatcher`), so `role` is what
 *   keeps a leader — and every Team member — out of the dispatcher's view; the
 *   dispatcher inspects Teams through the `team.*` surface instead.
 * - A TeamLeader sees only the members of its own Team.
 * - An ordinary TeamMate sees nothing (it cannot read peers).
 */
export function principalCanAccess(
  principal: TeamMateCallerPrincipal,
  identity: TeamMateIdentity,
): boolean {
  if (principal.kind === 'dispatcher') {
    return (
      identity.dispatcher_id === principal.dispatcherId &&
      identity.owner.kind === 'dispatcher' &&
      identity.role === 'teammate'
    );
  }
  if (principal.kind === 'team_leader') {
    return (
      identity.dispatcher_id === principal.dispatcherId &&
      identity.owner.kind === 'team' &&
      identity.owner.team_id === principal.teamId &&
      identity.role === 'team_member'
    );
  }
  if (principal.kind === 'team_service') {
    // Internal Team-service authority: its own TeamLeader (by concrete name)
    // plus the members of its Team. Never derived from a public caller.
    if (identity.dispatcher_id !== principal.dispatcherId) return false;
    if (identity.role === 'team_leader') return identity.name === principal.leaderName;
    return (
      identity.owner.kind === 'team' &&
      identity.owner.team_id === principal.teamId &&
      identity.role === 'team_member'
    );
  }
  return false;
}
