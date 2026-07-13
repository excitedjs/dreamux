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
        : { binding: { active: true }, owner };
    },
    async bindResolvedTarget(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      boundOwners.set(input.target.target_key, input.owner);
      return { active: true, team_name: input.owner.teamName };
    },
    async claimResolvedTarget(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (
        owner !== undefined &&
        (owner.teamName !== input.owner.teamName ||
          owner.leaderName !== input.owner.leaderName)
      ) {
        throw new Error(`target already bound to Team ${owner.teamName}`);
      }
      boundOwners.set(input.target.target_key, input.owner);
      return { active: true, team_name: input.owner.teamName };
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
      return { active: false, team_name: owner.teamName };
    },
  };
  return {
    boundOwners,
    service: service as unknown as ChannelService,
  };
}
