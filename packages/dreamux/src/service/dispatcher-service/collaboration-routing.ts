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

export async function handleCollaborationTargetLifecycle(input: {
  dispatcherId: string;
  dispatcherAgentRuntime: string;
  channelId: string;
  event: ChannelTargetLifecycleEvent;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  log: DreamuxLogger;
}): Promise<void> {
  const {
    dispatcherAgentRuntime,
    channelId,
    event,
    channels,
    collaborationSpaces,
  } = input;
  if (event.kind === 'target_created') {
    const provisionInput = provisionInputForTarget({
      channelId,
      container: event.container,
      target: event.target,
      ...(event.title !== undefined ? { title: event.title } : {}),
      ...(event.event_id !== undefined ? { eventId: event.event_id } : {}),
      channels,
    });
    const accepted = await collaborationSpaces.acceptTargetCreatedForProvision(provisionInput, {
      allowMissing: true,
      defaultBinding: defaultBindingForChannel({
        channels,
        channelId,
        dispatcherAgentRuntime,
      }),
    });
    if (accepted === null) return;
    collaborationSpaces.startAcceptedTargetProvision(accepted);
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
  collaborationSpaces.startTargetClose(closeInput);
}

export async function routeTeamOrCollaborationChannelInput(input: {
  channelId: string;
  dispatcherAgentRuntime: string;
  turn: InboundTurnInput;
  envelope: ChannelInboundEnvelope;
  channels: ChannelService;
  teams: TeamCollection;
  collaborationSpaces: CollaborationSpaceService;
  fallback: (turn: InboundTurnInput) => Promise<AgentRuntimeTurnResult>;
}): Promise<AgentRuntimeTurnResult> {
  const {
    channelId,
    dispatcherAgentRuntime,
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
        const provisionInput = provisionInputForTarget({
          channelId,
          container: envelope.container,
          target,
          ...(envelope.event_id !== undefined ? { eventId: envelope.event_id } : {}),
          channels,
        });
        const provisioned =
          await collaborationSpaces.acceptAndProvisionTarget(provisionInput, {
            defaultBinding: defaultBindingForChannel({
              channels,
              channelId,
              dispatcherAgentRuntime,
            }),
          });
        if (provisioned !== null) {
          if (provisioned.lifecycle_status !== 'active') {
            return {
              status: 'failed',
              error: new Error(
                `collaboration target '${target.target_key}' is not active`,
              ),
            };
          }
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
          return {
            status: 'failed',
            error: new Error(
              `collaboration target '${target.target_key}' is active but has no open Team route`,
            ),
          };
        }
      } catch (err) {
        return {
          status: 'failed',
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    let claimed: Awaited<
      ReturnType<CollaborationSpaceService['provisionClaimedTarget']>
    >;
    try {
      claimed = await collaborationSpaces.provisionClaimedTarget({
        channelId,
        provider: channels.channelProviderRef(channelId),
        target,
      });
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (claimed !== null) {
      if (claimed.lifecycle_status !== 'active') {
        return {
          status: 'failed',
          error: new Error(
            `collaboration target '${target.target_key}' is not active`,
          ),
        };
      }
      const claimedRoute = await channels.resolveInboundBinding({
        channelId,
        target,
      });
      if (
        claimedRoute !== null &&
        (await teams.isOpenTeam(claimedRoute.owner.teamName))
      ) {
        const team = await teams.get(claimedRoute.owner.teamName);
        return team.deliverToLeader(turn);
      }
      return {
        status: 'failed',
        error: new Error(
          `collaboration target '${target.target_key}' is active but has no open Team route`,
        ),
      };
    }
  }
  return fallback(turn);
}

function provisionInputForTarget(input: {
  channelId: string;
  channels: ChannelService;
  container: ChannelInboundEnvelope['container'];
  target: ChannelInboundEnvelope['target'];
  title?: string;
  eventId?: string;
}) {
  if (input.container === undefined) {
    throw new Error('collaboration-space provisioning requires a channel container');
  }
  return {
    channelId: input.channelId,
    provider: input.channels.channelProviderRef(input.channelId),
    container: input.container,
    target: input.target,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
  };
}

function defaultBindingForChannel(input: {
  channels: ChannelService;
  channelId: string;
  dispatcherAgentRuntime: string;
}) {
  const binding = input.channels
    .collaborationSpaceConfig(input.channelId)
    .defaultBinding;
  if (!binding.enabled) return undefined;
  return {
    leaderAgentRuntime: input.dispatcherAgentRuntime,
    ...(binding.repo !== null
      ? {
          repo: {
            cwd: binding.repo.cwd,
            ...(binding.repo.baseRef !== null ? { baseRef: binding.repo.baseRef } : {}),
          },
        }
      : {}),
    ...(binding.identity !== null ? { identity: binding.identity } : {}),
  };
}
