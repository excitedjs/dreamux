import type { ChannelRouteOwner, ChannelService } from '../../src/service/channel-service/index.js';
import type { TeamCollection } from '../../src/service/team-collection/index.js';
import type {
  AcceptedTeamDissolve,
  TeamLogicalCloseExecutor,
} from '../../src/service/team-collection/types.js';
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
  const allocated = new Set<string>();
  const known = new Set<string>();
  const operations = new Map<string, {
    teamName: string;
    leaderName: string;
    note: string;
    logicalMilestone: Promise<never>;
    started: boolean;
    resolveLogical: (value: never) => void;
    rejectLogical: (error: unknown) => void;
    targetHandoffs: Set<string>;
  }>();
  let nextName = 0;
  return {
    async claimName(prefix: string, claimToken: string) {
      while (true) {
        const name = `${prefix}-${String(nextName).padStart(4, '0')}`;
        nextName += 1;
        if (allocated.has(name) || open.has(name)) continue;
        allocated.add(name);
        return { name, token: claimToken };
      }
    },
    async create(input: CreatedTeam & { name: string }) {
      created.push(input);
      allocated.add(input.name);
      known.add(input.name);
      open.set(input.name, `${input.name}-leader`);
      return {
        team: { team_name: input.name, leader_name: `${input.name}-leader` },
        leader: null,
        member_count: 0,
        status: null,
      };
    },
    async isOpenTeam(name: string) {
      return open.has(name);
    },
    async hasTeam(name: string) {
      return known.has(name);
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
    async withRoutableTeamLeaderLease<T>(
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
    async withTeamRouteClosing<T>(
      name: string,
      task: (owner: ChannelRouteOwner) => Promise<T>,
    ) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not open`);
      return task({ kind: 'team' as const, teamName: name, leaderName: leader });
    },
    async acceptDissolve(input: {
      teamId: string;
      note: string;
      requester: { kind: string; leaderName?: string; handoffId?: string };
    }): Promise<AcceptedTeamDissolve> {
      const leader = open.get(input.teamId);
      if (leader === undefined) throw new Error(`Team ${input.teamId} is not open`);
      if (
        input.requester.kind !== 'dispatcher' &&
        input.requester.leaderName !== null &&
        input.requester.leaderName !== leader
      ) {
        throw new Error(`Team ${input.teamId} generation is not current`);
      }
      const operationId = `operation-${input.teamId}`;
      const existing = operations.get(operationId);
      if (existing !== undefined) {
        if (input.requester.handoffId !== undefined) {
          existing.targetHandoffs.add(input.requester.handoffId);
        }
        return fakeHandle(operationId, existing);
      }
      let resolveLogical!: (value: never) => void;
      let rejectLogical!: (error: unknown) => void;
      const logicalMilestone = new Promise<never>((done, fail) => {
        resolveLogical = done;
        rejectLogical = fail;
      });
      void logicalMilestone.catch(() => undefined);
      const operation = {
        teamName: input.teamId,
        leaderName: leader,
        note: input.note,
        resolveLogical,
        rejectLogical,
        logicalMilestone,
        targetHandoffs: new Set(
          input.requester.handoffId === undefined
            ? []
            : [input.requester.handoffId],
        ),
        started: false,
      };
      operations.set(operationId, operation);
      return fakeHandle(operationId, operation);
    },
    startAcceptedDissolve(
      handle: AcceptedTeamDissolve,
      close: TeamLogicalCloseExecutor,
    ) {
      const operation = operations.get(handle.operationId);
      if (operation === undefined) throw new Error('missing fake operation');
      if (operation.started) return;
      operation.started = true;
      void close({
        operationId: handle.operationId,
        teamId: operation.teamName,
        note: operation.note,
        owner: {
          kind: 'team',
          teamName: operation.teamName,
          leaderName: operation.leaderName,
        },
        dissolve: {
          operation_id: handle.operationId,
          requester_kind: 'dispatcher',
          leader_name: null,
          target_handoff_ids: [...operation.targetHandoffs],
          note: operation.note,
          accepted_at: Date.now(),
          phase: 'complete',
          last_error: null,
          cleanup_attempts: 0,
          next_retry_at: null,
        },
        worktree: {
          mode: 'reuse-cwd',
          slug: null,
          path: '/tmp',
          branch: null,
          base_ref: null,
          cleanup: 'keep',
          cleanup_state: 'not-managed',
          cleanup_error: null,
        },
      }).then(
        (summary) => {
          operation.resolveLogical(summary as never);
        },
        (error) => {
          operation.rejectLogical(error);
        },
      );
    },
    async closeAcceptedResources(input: { teamId: string }) {
      dissolved.push(input.teamId);
      open.delete(input.teamId);
      return {
        team: { team_name: input.teamId },
        leader: null,
        member_count: 0,
      };
    },
    async recoverDissolves() {},
    async hasAcceptedTargetDissolveHandoff(input: {
      teamId: string;
      operationId: string;
      handoffId: string;
    }) {
      const operation = operations.get(input.operationId);
      return operation?.teamName === input.teamId &&
        operation.targetHandoffs.has(input.handoffId);
    },
    async get(name: string) {
      return { id: name };
    },
  } as unknown as TeamCollection;
}

function fakeHandle(
  operationId: string,
  operation: {
    teamName: string;
    logicalMilestone: Promise<never>;
    targetHandoffs: Set<string>;
    started: boolean;
  },
): AcceptedTeamDissolve {
  return {
    operationId,
    receipt: {
      accepted: true,
      team_name: operation.teamName,
      status: 'closing',
    },
    logicalClosed: operation.logicalMilestone,
  };
}

export function fakeChannels() {
  const boundOwners = new Map<string, ChannelRouteOwner>();
  const claimIds = new Map<string, string | null>();
  const claimedTargetMetas = new Map<string, Record<string, unknown>>();
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
      return { active: true, team_name: input.team.team_name };
    },
    async bindResolvedTargetIfAvailableToOwner(input: {
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
      return { active: true, team_name: input.team.team_name };
    },
    async claimResolvedTarget(input: {
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
      claimedTargetMetas.set(input.target.target_key, input.target.meta ?? {});
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
        transferred.push({ active: false, team_name: owner.teamName });
      }
      return transferred;
    },
  };
  return {
    boundOwners,
    claimIds,
    claimedTargetMetas,
    service: service as unknown as ChannelService,
  };
}
