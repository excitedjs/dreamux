import type {
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelTargetLifecycleEvent,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import { errInfo } from './runtime-helpers.js';

export async function handleCollaborationTargetLifecycle(input: {
  dispatcherId: string;
  channelId: string;
  event: ChannelTargetLifecycleEvent;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  log: DreamuxLogger;
}): Promise<void> {
  const {
    dispatcherId,
    channelId,
    event,
    channels,
    collaborationSpaces,
    log,
  } = input;
  if (event.kind === 'target_created') {
    const provisionInput = {
      channelId,
      provider: channels.channelProviderRef(channelId),
      container: event.container,
      target: event.target,
      ...(event.title !== undefined ? { title: event.title } : {}),
      ...(event.event_id !== undefined ? { eventId: event.event_id } : {}),
    };
    const accepted = await collaborationSpaces.acceptTargetCreated(provisionInput);
    if (!accepted) return;
    void collaborationSpaces.provisionTarget(provisionInput).catch((err) => {
      log.error(
        {
          dispatcher_id: dispatcherId,
          channel_id: channelId,
          err: errInfo(err),
        },
        'collaboration target lifecycle provisioning failed',
      );
    });
    return;
  }

  const closeInput = {
    channelId,
    provider: channels.channelProviderRef(channelId),
    container: event.container,
    target: event.target,
    ...(event.event_id !== undefined ? { eventId: event.event_id } : {}),
  };
  const accepted = await collaborationSpaces.acceptTargetClosed(closeInput);
  if (!accepted) return;
  void collaborationSpaces.closeTarget(closeInput).catch((err) => {
    log.error(
      {
        dispatcher_id: dispatcherId,
        channel_id: channelId,
        err: errInfo(err),
      },
      'collaboration target lifecycle close failed',
    );
  });
}

export async function routeTeamOrCollaborationChannelInput(input: {
  channelId: string;
  turn: InboundTurnInput;
  envelope: ChannelInboundEnvelope;
  channels: ChannelService;
  teams: TeamCollection;
  collaborationSpaces: CollaborationSpaceService;
  fallback: (turn: InboundTurnInput) => Promise<AgentRuntimeTurnResult>;
}): Promise<AgentRuntimeTurnResult> {
  const {
    channelId,
    turn,
    envelope,
    channels,
    teams,
    collaborationSpaces,
    fallback,
  } = input;
  const target = envelope.target;
  if (target.bindable) {
    const routed = await channels.resolveInboundBinding({ channelId, target });
    if (routed !== null && (await teams.isOpenTeam(routed.owner.teamName))) {
      const team = await teams.get(routed.owner.teamName);
      return team.deliverToLeader(turn);
    }
    if (envelope.container !== undefined) {
      try {
        const provisionInput = {
          channelId,
          provider: envelope.provider,
          container: envelope.container,
          target,
          ...(envelope.event_id !== undefined ? { eventId: envelope.event_id } : {}),
        };
        const provisioned =
          await collaborationSpaces.acceptAndProvisionTarget(provisionInput);
        if (provisioned !== null && provisioned.lifecycle_status === 'active') {
          const provisionedRoute = await channels.resolveInboundBinding({
            channelId,
            target,
          });
          if (
            provisionedRoute !== null &&
            (await teams.isOpenTeam(provisionedRoute.owner.teamName))
          ) {
            const team = await teams.get(provisionedRoute.owner.teamName);
            return team.deliverToLeader(turn);
          }
        }
      } catch (err) {
        return {
          status: 'failed',
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  }
  return fallback(turn);
}
