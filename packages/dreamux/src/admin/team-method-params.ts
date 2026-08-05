import {
  bundledSharedSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../platform/paths.js';
import type {
  ChannelBindingSummary,
  ChannelRouteOwner,
} from '../service/channel-service/index.js';
import type { DispatcherService } from '../service/dispatcher-service/index.js';
import { validateTeamMateName } from '../service/agent-entity/types.js';
import { validateTeamId } from '../service/team-collection/types.js';
import { mustString, optionalString, parseMessage } from './params.js';
import { AdminError } from './protocol.js';

export const TEAM_LEADER_REQUIRED_SKILL_SOURCES = [{
  name: 'team-leader',
  path: bundledTeamLeaderSkillRoot(),
  source: 'dreamux-core',
}, {
  name: 'shared',
  path: bundledSharedSkillRoot(),
  source: 'dreamux-core',
}] as const;

export function teamCallerKind(
  params: Record<string, unknown> | undefined,
): 'dispatcher' | 'team_leader' {
  // Omitted caller_kind preserves the existing dispatcher-scoped admin contract.
  const kind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (kind === 'dispatcher' || kind === 'team_leader') return kind;
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher or team_leader",
  );
}

export function mustTeamIdParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = mustString(params, key);
  try {
    return validateTeamId(value);
  } catch (error) {
    throw new AdminError('BAD_REQUEST', parseMessage(error));
  }
}

export function mustTeamMateNameParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = mustString(params, key);
  try {
    return validateTeamMateName(value);
  } catch (error) {
    throw new AdminError('BAD_REQUEST', parseMessage(error));
  }
}

function ownerForTeamRead(input: {
  team_name: string;
  leader_name: string;
}): ChannelRouteOwner {
  return {
    kind: 'team',
    teamName: input.team_name,
    leaderName: input.leader_name,
  };
}

export async function teamBindingFields(
  dispatcher: DispatcherService,
  team: { team_name: string; leader_name: string },
): Promise<{
  bound_target: ChannelBindingSummary | null;
  bound_targets: ChannelBindingSummary[];
}> {
  const bound_targets = await dispatcher.activeTeamBindingSummaries(
    ownerForTeamRead(team),
  );
  return {
    // Compatibility: preserve the former first-match projection and store order.
    bound_target: bound_targets[0] ?? null,
    bound_targets,
  };
}
