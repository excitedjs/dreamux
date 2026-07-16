import type {
  AgentRuntimeTurnResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import {
  TeamUnavailableError,
  type TeamCollection,
} from '../team-collection/index.js';
import {
  CollaborationTargetOperationError,
  type CollaborationTargetOperationFailureCode,
} from './operation-error.js';
import type { CollaborationSpaceStore } from './store.js';
import { assertSameContainer, routeKey } from './support.js';
import { routeClaimIdForTarget } from './target.js';
import type {
  CollaborationSpaceProvisionInput,
  ProvisionedTargetRecord,
} from './types.js';

export function collaborationTargetFailure(
  strict: boolean,
  code: CollaborationTargetOperationFailureCode,
  message: string,
): Error {
  return strict
    ? new CollaborationTargetOperationError(code, message)
    : new Error(message);
}

/** Readiness and exact-route helper; it owns no target state or lifecycle. */
export class CollaborationTargetStrictOperations {
  constructor(private readonly opts: {
    dispatcherId: string;
    teams: TeamCollection;
    channels: ChannelService;
    store: CollaborationSpaceStore;
    targetLocks: KeyedAsyncQueue;
  }) {}

  async assertTargetIdentity(
    input: CollaborationSpaceProvisionInput,
    bindingGeneration: number,
  ): Promise<void> {
    const space = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space !== null) {
      try {
        assertSameContainer(space, input.channelId, input.container);
      } catch {
        throw new CollaborationTargetOperationError(
          'target_conflict',
          'channel container identity conflicts with the existing collaboration space',
        );
      }
    }
    const latest = await this.opts.store.findLatestTargetByChannelTarget(
      this.opts.dispatcherId,
      {
        channelId: input.channelId,
        targetKey: input.target.target_key,
      },
    );
    if (latest === null) return;
    if (
      latest.container_key !== input.container.container_key ||
      latest.target_type !== input.target.target_type
    ) {
      throw new CollaborationTargetOperationError(
        'target_conflict',
        'channel target identity conflicts with an existing collaboration target',
      );
    }
    if (
      latest.binding_generation !== bindingGeneration &&
      latest.lifecycle_status === 'closing'
    ) {
      throw new CollaborationTargetOperationError(
        'target_closing',
        'a prior collaboration target generation is closing',
      );
    }
    if (
      latest.binding_generation !== bindingGeneration &&
      latest.lifecycle_status !== 'closed' &&
      latest.lifecycle_status !== 'detached'
    ) {
      throw new CollaborationTargetOperationError(
        'target_conflict',
        'a prior collaboration target generation is still active',
      );
    }
  }

  requireReadyTarget(input: {
    record: ProvisionedTargetRecord;
    target: CollaborationSpaceProvisionInput['target'];
  }): Promise<ProvisionedTargetRecord> {
    return this.withVerifiedActiveTarget(
      {
        channelId: input.record.channel_id,
        target: input.target,
        expectedTeamName: input.record.team_name,
      },
      async (record) => record,
    );
  }

  deliverExact(input: {
    channelId: string;
    target: CollaborationSpaceProvisionInput['target'];
    expectedTeamName: string;
    turn: InboundTurnInput;
  }): Promise<AgentRuntimeTurnResult> {
    return this.withVerifiedActiveTarget(input, async (record) => {
      const team = await this.opts.teams.get(record.team_name);
      return team.deliverToLeader(input.turn);
    });
  }

  private async withVerifiedActiveTarget<T>(
    input: {
      channelId: string;
      target: CollaborationSpaceProvisionInput['target'];
      expectedTeamName: string;
    },
    task: (record: ProvisionedTargetRecord) => Promise<T>,
  ): Promise<T> {
    return this.opts.targetLocks.run(
      routeKey({ channelId: input.channelId, targetKey: input.target.target_key }),
      async () => {
        const record = await this.opts.store.findLatestTargetByChannelTarget(
          this.opts.dispatcherId,
          {
            channelId: input.channelId,
            targetKey: input.target.target_key,
          },
        );
        if (record === null) {
          throw new CollaborationTargetOperationError(
            'route_unavailable',
            'collaboration target does not exist',
          );
        }
        if (record.target_type !== input.target.target_type) {
          throw new CollaborationTargetOperationError(
            'target_conflict',
            'channel target type conflicts with the provisioned target',
          );
        }
        if (record.lifecycle_status === 'closed') {
          throw new CollaborationTargetOperationError(
            'target_closed',
            'collaboration target is closed',
          );
        }
        if (record.lifecycle_status === 'closing') {
          throw new CollaborationTargetOperationError(
            'target_closing',
            'collaboration target is closing',
          );
        }
        if (
          record.lifecycle_status !== 'active' ||
          record.phase !== 'bound' ||
          record.leader_name === null
        ) {
          throw new CollaborationTargetOperationError(
            'route_unavailable',
            'collaboration target is not ready',
          );
        }
        if (record.team_name !== input.expectedTeamName) {
          throw new CollaborationTargetOperationError(
            'target_conflict',
            'collaboration target belongs to a different Team',
          );
        }
        try {
          return await this.opts.teams.withRoutableTeamOwner(
            record.team_name,
            async (owner) => {
              const routed = await this.opts.channels.resolveInboundBinding({
                channelId: input.channelId,
                target: input.target,
              });
              if (
                owner.leaderName !== record.leader_name ||
                routed === null ||
                routed.owner.teamName !== owner.teamName ||
                routed.owner.leaderName !== owner.leaderName ||
                routed.binding.claim_id !== routeClaimIdForTarget(record)
              ) {
                throw new CollaborationTargetOperationError(
                  'route_unavailable',
                  'collaboration target has no matching authoritative route',
                );
              }
              return task(record);
            },
          );
        } catch (error) {
          if (error instanceof TeamUnavailableError) {
            throw new CollaborationTargetOperationError(
              'route_unavailable',
              'collaboration target Team is not routable',
            );
          }
          throw error;
        }
      },
    );
  }
}
