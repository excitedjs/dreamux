import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import { taskChannelTarget, taskTeamProvisionInput } from './provisioning.js';
import type { TaskRuntimeExecutor } from './runtime-execution.js';
import { requiredTarget } from './service-helpers.js';
import type { TaskHostStore } from './store.js';
import {
  leaderResource,
  resourceEvent,
  taskLifecycleEvent,
  teamResource,
  worktreeResource,
} from './resources.js';

export interface ProvisionTaskTargetOptions {
  channelId: string;
  store: TaskHostStore;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  teams: TeamCollection;
  executor: TaskRuntimeExecutor;
  defaultLeaderAgentRuntime: () => string;
  runtimeSupportsDurableTasks: (agentRuntimeId: string) => boolean;
}

export async function provisionTaskTarget(
  opts: ProvisionTaskTargetOptions,
  targetId: string,
): Promise<void> {
  let target = requiredTarget(opts.store, targetId);
  if (target.terminal !== null) return;
  try {
    if (target.binding === null) {
      if (target.phase !== 'provisioning') {
        target = await opts.store.updateTarget(
          targetId,
          null,
          (next) => {
            next.phase = 'provisioning';
            next.blocked = null;
          },
          (record) => [
            { payload: { kind: 'task.lifecycle', phase: 'provisioning' } },
            resourceEvent(teamResource(record, 'provisioning')),
            resourceEvent(leaderResource(record, 'provisioning')),
            resourceEvent(worktreeResource(record, 'provisional')),
          ],
        );
      }
      if (target.resolved_repository === null) {
        throw new Error('active task target has no resolved repository policy');
      }
      const binding = await opts.collaborationSpaces.ensureTaskBinding({
        channelId: target.channel_id,
        provider: target.provider,
        container: target.container,
        repository: target.resolved_repository,
        leaderAgentRuntime: opts.defaultLeaderAgentRuntime(),
        identity: opts.channels
          .collaborationSpaceConfig(opts.channelId)
          .defaultBinding.identity,
      });
      if (!opts.runtimeSupportsDurableTasks(binding.leader_agent_runtime)) {
        throw new Error(
          'collaboration space leader runtime cannot durably accept task submissions',
        );
      }
      target = await opts.store.updateTarget(
        targetId,
        null,
        (next) => {
          next.binding = structuredClone(binding);
          next.phase = 'binding_resolved';
          next.blocked = null;
        },
        [{ payload: { kind: 'task.lifecycle', phase: 'binding_resolved' } }],
      );
    }

    if (!opts.runtimeSupportsDurableTasks(target.binding!.leader_agent_runtime)) {
      throw new Error(
        'collaboration space leader runtime cannot durably accept task submissions',
      );
    }

    const created = await opts.teams.ensureProvisioned(taskTeamProvisionInput(target));
    if (
      target.team.leader_name !== created.team.leader_name ||
      !['ready', 'running'].includes(target.phase)
    ) {
      target = await opts.store.updateTarget(
        targetId,
        null,
        (next) => {
          next.team.leader_name = created.team.leader_name;
          if (next.phase !== 'running') next.phase = 'ready';
          next.blocked = null;
        },
        (record) => [
          resourceEvent(teamResource(record, 'ready')),
          resourceEvent(leaderResource(record, 'ready')),
          resourceEvent(worktreeResource(record, 'ready')),
          { payload: { kind: 'task.lifecycle', phase: 'ready' } },
        ],
      );
    }
    await opts.teams.withRoutableTeamOwner(
      target.team.team_name,
      async (owner) => {
        await opts.channels.claimResolvedTarget({
          owner,
          channelId: target.channel_id,
          target: taskChannelTarget(target),
          claimId: target.team.route_claim_id,
        });
      },
    );
    if (target.team.route_reconciled_at === null) {
      target = await opts.store.updateTarget(
        targetId,
        null,
        (next) => {
          next.team.route_reconciled_at = Date.now();
        },
        (next) => [taskLifecycleEvent(next)],
      );
    }
    await opts.executor.executeRoot(targetId);
    await opts.executor.reconcileExisting(targetId);
  } catch (error) {
    const latest = opts.store.get(targetId);
    if (
      latest !== null &&
      latest.terminal === null &&
      latest.phase !== 'finalized'
    ) {
      await opts.store.updateTarget(
        targetId,
        null,
        (next) => {
          const fromPhase = next.blocked?.from_phase ?? next.phase;
          next.phase = 'blocked';
          next.blocked = {
            from_phase: fromPhase,
            code: 'TASK_PROVISIONING_FAILED',
            retryable: true,
            at: Date.now(),
          };
        },
        [{ payload: {
          kind: 'task.lifecycle',
          phase: 'blocked',
          blocked_code: 'TASK_PROVISIONING_FAILED',
          retryable: true,
        } }],
      );
    }
    throw error;
  }
}
