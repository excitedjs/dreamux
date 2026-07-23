import type { ChannelRouteOwner } from '../channel-service/index.js';
import type { TeamRouteProjection } from './types.js';

export function routeOwnerFromProjection(
  projection: TeamRouteProjection,
): ChannelRouteOwner {
  return {
    kind: 'team',
    teamName: projection.team_name,
    leaderName: projection.leader_name,
  };
}
