import type { ChannelRouteOwner, ChannelService } from '../../src/service/channel-service/index.js';
import type { TeamCollection } from '../../src/service/team-collection/index.js';
import { testDreamuxConfig } from './config.js';

export const log = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export interface CreatedTeam {
  name: string;
  leaderAgentRuntime: string;
  identity?: string;
  repoCwd?: string;
  worktree?: Record<string, unknown>;
}

export function fakeConfig() {
  return {
    ...testDreamuxConfig([]),
    agents: {
      'agent-a': { provider: 'test:runtime', config: {} },
      'agent-b': { provider: 'test:runtime', config: {} },
    },
  };
}

export function fakeTeams(created: CreatedTeam[], dissolved: string[]) {
  const open = new Map<string, string>();
  return {
    async create(input: CreatedTeam & { name: string }) {
      created.push(input);
      open.set(input.name, `${input.name}-leader`);
      return {
        team: { team_name: input.name, leader_name: `${input.name}-leader` },
        leader: null,
        member_count: 0,
        turn: null,
      };
    },
    async isOpenTeam(name: string) {
      return open.has(name);
    },
    async requireOpenTeamRouteOwner(name: string) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not open`);
      return { kind: 'team' as const, teamName: name, leaderName: leader };
    },
    async requireRoutableTeamOwner(name: string) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not routable`);
      return { kind: 'team' as const, teamName: name, leaderName: leader };
    },
    async withRoutableTeamOwner<T>(
      name: string,
      task: (owner: ChannelRouteOwner) => Promise<T>,
    ) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not routable`);
      return task({ kind: 'team' as const, teamName: name, leaderName: leader });
    },
    async withRoutableTeamLeaderLease<T>(
      lease: { teamId: string; leaderName: string },
      task: (owner: ChannelRouteOwner) => Promise<T>,
    ) {
      const leader = open.get(lease.teamId);
      if (leader === undefined || leader !== lease.leaderName) {
        throw new Error(`Team ${lease.teamId} generation is not routable`);
      }
      return task({
        kind: 'team' as const,
        teamName: lease.teamId,
        leaderName: leader,
      });
    },
    async withRoutableTeamProjection<T>(
      name: string,
      task: (projection: {
        team_name: string;
        leader_name: string;
        leader_agent_runtime: string;
        runtime_cwd: string;
      }) => Promise<T>,
    ) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not routable`);
      return task({
        team_name: name,
        leader_name: leader,
        leader_agent_runtime: 'agent-a',
        runtime_cwd: `/tmp/dreamux-test/${name}`,
      });
    },
    async withRoutableTeamLeaderProjectionLease<T>(
      lease: { teamId: string; leaderName: string },
      task: (projection: {
        team_name: string;
        leader_name: string;
        leader_agent_runtime: string;
        runtime_cwd: string;
      }) => Promise<T>,
    ) {
      const leader = open.get(lease.teamId);
      if (leader === undefined || leader !== lease.leaderName) {
        throw new Error(`Team ${lease.teamId} generation is not routable`);
      }
      return task({
        team_name: lease.teamId,
        leader_name: leader,
        leader_agent_runtime: 'agent-a',
        runtime_cwd: `/tmp/dreamux-test/${lease.teamId}`,
      });
    },
    async withTeamRouteClosing<T>(
      name: string,
      task: (owner: ChannelRouteOwner) => Promise<T>,
    ) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not open`);
      return task({ kind: 'team' as const, teamName: name, leaderName: leader });
    },
    async get(name: string) {
      return {
        async dissolve() {
          dissolved.push(name);
          open.delete(name);
          return {
            team: { team_name: name },
            leader: null,
            member_count: 0,
          };
        },
      };
    },
  } as unknown as TeamCollection;
}

export function fakeChannels() {
  const boundOwners = new Map<string, ChannelRouteOwner>();
  const claimIds = new Map<string, string | null>();
  const targetMetas = new Map<string, Record<string, unknown>>();
  const service = {
    resolveChannelId(requested?: string) {
      return requested ?? 'primary';
    },
    channelProviderRef(channelId: string) {
      if (channelId !== 'primary') throw new Error(`unknown channel ${channelId}`);
      return 'builtin:test';
    },
    async resolveInboundBinding(input: { target: { target_key: string } }) {
      const owner = boundOwners.get(input.target.target_key);
      return owner === undefined
        ? null
        : {
            binding: {
              active: true,
              claim_id: claimIds.get(input.target.target_key) ?? null,
            },
            owner,
          };
    },
    async bindResolvedTarget(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string; meta?: Record<string, unknown> };
    }) {
      boundOwners.set(input.target.target_key, input.owner);
      claimIds.set(input.target.target_key, null);
      targetMetas.set(input.target.target_key, input.target.meta ?? {});
      return { active: true, team_name: input.owner.teamName };
    },
    async bindResolvedTargetIfAvailableToOwner(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (owner !== undefined && claimIds.get(input.target.target_key) !== null) {
        throw new Error('target is managed by an active collaboration route');
      }
      if (
        owner !== undefined &&
        (owner.teamName !== input.owner.teamName ||
          owner.leaderName !== input.owner.leaderName)
      ) {
        throw new Error(`target already bound to Team ${owner.teamName}`);
      }
      if (owner !== undefined) {
        return { active: true, team_name: owner.teamName };
      }
      boundOwners.set(input.target.target_key, input.owner);
      claimIds.set(input.target.target_key, null);
      return { active: true, team_name: input.owner.teamName };
    },
    async bindResolvedTargetWithTransition(input: {
      team: { team_name: string; leader_name: string };
      target: { target_key: string; meta?: Record<string, unknown> };
    }) {
      const owner = {
        kind: 'team' as const,
        teamName: input.team.team_name,
        leaderName: input.team.leader_name,
      };
      boundOwners.set(input.target.target_key, owner);
      claimIds.set(input.target.target_key, null);
      targetMetas.set(input.target.target_key, input.target.meta ?? {});
      return { active: true, team_name: input.team.team_name };
    },
    async bindResolvedTargetIfAvailableToOwnerWithTransition(input: {
      team: { team_name: string; leader_name: string };
      target: { target_key: string; meta?: Record<string, unknown> };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (owner !== undefined && claimIds.get(input.target.target_key) !== null) {
        throw new Error('target is managed by an active collaboration route');
      }
      if (
        owner !== undefined &&
        (owner.teamName !== input.team.team_name ||
          owner.leaderName !== input.team.leader_name)
      ) {
        throw new Error(`target already bound to Team ${owner.teamName}`);
      }
      if (owner !== undefined) {
        return { active: true, team_name: owner.teamName };
      }
      boundOwners.set(input.target.target_key, {
        kind: 'team' as const,
        teamName: input.team.team_name,
        leaderName: input.team.leader_name,
      });
      claimIds.set(input.target.target_key, null);
      targetMetas.set(input.target.target_key, input.target.meta ?? {});
      return { active: true, team_name: input.team.team_name };
    },
    async claimResolvedTarget(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string; meta?: Record<string, unknown> };
      claimId: string;
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (
        owner !== undefined &&
        (owner.teamName !== input.owner.teamName ||
          owner.leaderName !== input.owner.leaderName)
      ) {
        throw new Error(`target already bound to Team ${owner.teamName}`);
      }
      if (
        owner !== undefined &&
        claimIds.get(input.target.target_key) !== input.claimId
      ) {
        throw new Error('target already has a different active route claim');
      }
      boundOwners.set(input.target.target_key, input.owner);
      claimIds.set(input.target.target_key, input.claimId);
      targetMetas.set(input.target.target_key, input.target.meta ?? {});
      return { active: true, team_name: input.owner.teamName };
    },
    async claimResolvedTargetWithTransition(input: {
      team: { team_name: string; leader_name: string };
      target: { target_key: string; meta?: Record<string, unknown> };
      claimId: string;
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (
        owner !== undefined &&
        (owner.teamName !== input.team.team_name ||
          owner.leaderName !== input.team.leader_name)
      ) {
        throw new Error(`target already bound to Team ${owner.teamName}`);
      }
      if (
        owner !== undefined &&
        claimIds.get(input.target.target_key) !== input.claimId
      ) {
        throw new Error('target already has a different active route claim');
      }
      boundOwners.set(input.target.target_key, {
        kind: 'team' as const,
        teamName: input.team.team_name,
        leaderName: input.team.leader_name,
      });
      claimIds.set(input.target.target_key, input.claimId);
      targetMetas.set(input.target.target_key, input.target.meta ?? {});
      return { active: true, team_name: input.team.team_name };
    },
    async transferResolvedTargetBack(input: {
      expectedOwner?: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (owner === undefined) return null;
      if (
        input.expectedOwner !== undefined &&
        (owner.teamName !== input.expectedOwner.teamName ||
          owner.leaderName !== input.expectedOwner.leaderName)
      ) {
        throw new Error('owner mismatch');
      }
      boundOwners.delete(input.target.target_key);
      claimIds.delete(input.target.target_key);
      targetMetas.delete(input.target.target_key);
      return { active: false, team_name: owner.teamName };
    },
    async releaseResolvedTargetIfOwned(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (owner === undefined) return null;
      if (
        owner.teamName !== input.owner.teamName ||
        owner.leaderName !== input.owner.leaderName
      ) {
        return null;
      }
      boundOwners.delete(input.target.target_key);
      claimIds.delete(input.target.target_key);
      targetMetas.delete(input.target.target_key);
      return { active: false, team_name: owner.teamName };
    },
    async releaseResolvedTargetIfClaimed(input: {
      claimId: string;
      target: { target_key: string };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (
        owner === undefined ||
        claimIds.get(input.target.target_key) !== input.claimId
      ) {
        return null;
      }
      boundOwners.delete(input.target.target_key);
      claimIds.delete(input.target.target_key);
      targetMetas.delete(input.target.target_key);
      return { active: false, team_name: owner.teamName };
    },
    async transferAllForOwner(owner: ChannelRouteOwner) {
      const transferred: Array<{ active: false; team_name: string }> = [];
      for (const [targetKey, current] of [...boundOwners]) {
        if (
          current.teamName !== owner.teamName ||
          current.leaderName !== owner.leaderName
        ) {
          continue;
        }
        boundOwners.delete(targetKey);
        claimIds.delete(targetKey);
        targetMetas.delete(targetKey);
        transferred.push({ active: false, team_name: owner.teamName });
      }
      return transferred;
    },
  };
  return {
    boundOwners,
    claimIds,
    targetMetas,
    service: service as unknown as ChannelService,
  };
}
