import type {
  AgentRuntimeTurnResult,
  ChannelCollaborationTargetEnsureInput,
  ChannelCollaborationTargetEnsureResult,
  ChannelExactDeliveryInput,
  ChannelExactDeliveryResult,
  ChannelInboundEnvelope,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import {
  deliverExactCollaborationTarget,
  ensureCollaborationTarget,
  rejectedChannelOperation,
  routeTeamOrCollaborationChannelInput,
} from './collaboration-routing.js';
import { errInfo } from './runtime-helpers.js';

interface DispatcherScopedChannelRoutingOptions {
  dispatcherId: string;
  dispatcherAgentRuntime: () => string;
  channels: ChannelService;
  teams: TeamCollection;
  collaborationSpaces: CollaborationSpaceService;
  log: DreamuxLogger;
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  fallback: (turn: InboundTurnInput) => Promise<AgentRuntimeTurnResult>;
  isUnavailable: () => boolean;
}

export interface DispatcherChannelSessionRouteLease {
  ensure(
    request: ChannelCollaborationTargetEnsureInput,
  ): Promise<ChannelCollaborationTargetEnsureResult>;
  deliverExact(
    request: ChannelExactDeliveryInput,
  ): Promise<ChannelExactDeliveryResult>;
  revoke(): void;
}

/** Dispatcher-owned adapters for the optional Channel collaboration ABI. */
export class DispatcherScopedChannelRouting {
  private readonly sessionLeases = new Set<DispatcherChannelSessionRouteLease>();

  constructor(private readonly opts: DispatcherScopedChannelRoutingOptions) {}

  createSessionLease(channelId: string): DispatcherChannelSessionRouteLease {
    let active = true;
    const lease: DispatcherChannelSessionRouteLease = {
      ensure: (request) =>
        active
          ? this.ensure(channelId, request)
          : Promise.resolve(rejectedChannelOperation('dispatcher_unavailable')),
      deliverExact: (request) =>
        active
          ? this.deliverExact(channelId, request)
          : Promise.resolve(rejectedChannelOperation('dispatcher_unavailable')),
      revoke: () => {
        active = false;
        this.sessionLeases.delete(lease);
      },
    };
    this.sessionLeases.add(lease);
    return lease;
  }

  revokeSessionLeases(): void {
    for (const lease of [...this.sessionLeases]) lease.revoke();
  }

  route(
    channelId: string,
    turn: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<AgentRuntimeTurnResult> {
    return this.opts.admit(() =>
      routeTeamOrCollaborationChannelInput({
        channelId,
        dispatcherAgentRuntime: this.opts.dispatcherAgentRuntime(),
        turn,
        envelope,
        channels: this.opts.channels,
        teams: this.opts.teams,
        collaborationSpaces: this.opts.collaborationSpaces,
        fallback: this.opts.fallback,
      }),
    );
  }

  async ensure(
    channelId: string,
    request: ChannelCollaborationTargetEnsureInput,
  ): Promise<ChannelCollaborationTargetEnsureResult> {
    try {
      return await this.opts.admit(() =>
        ensureCollaborationTarget({
          channelId,
          dispatcherAgentRuntime: this.opts.dispatcherAgentRuntime(),
          request,
          channels: this.opts.channels,
          collaborationSpaces: this.opts.collaborationSpaces,
          log: this.opts.log,
        }),
      );
    } catch (error) {
      return this.rejectUnavailable(channelId, 'ensure', error);
    }
  }

  async deliverExact(
    channelId: string,
    request: ChannelExactDeliveryInput,
  ): Promise<ChannelExactDeliveryResult> {
    try {
      return await this.opts.admit(() =>
        deliverExactCollaborationTarget({
          channelId,
          request,
          collaborationSpaces: this.opts.collaborationSpaces,
          log: this.opts.log,
        }),
      );
    } catch (error) {
      return this.rejectUnavailable(channelId, 'deliver', error);
    }
  }

  private rejectUnavailable(
    channelId: string,
    operation: 'ensure' | 'deliver',
    error: unknown,
  ) {
    const code = this.opts.isUnavailable()
      ? 'dispatcher_unavailable' as const
      : 'operation_failed' as const;
    this.opts.log.warn(
      {
        dispatcher_id: this.opts.dispatcherId,
        channel_id: channelId,
        operation,
        rejection_code: code,
        err: errInfo(error),
      },
      'scoped channel operation rejected',
    );
    return rejectedChannelOperation(code);
  }
}
