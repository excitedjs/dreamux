import type { ChannelTarget } from '@excitedjs/dreamux-types';

import type { ChannelRouteOwner } from '../channel-service/index.js';
import type { ProvisionedTargetRecord } from './types.js';

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
  };
}
