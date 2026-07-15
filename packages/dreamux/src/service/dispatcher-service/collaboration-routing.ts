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
  const task = doHandleCollaborationTargetLifecycle({
    dispatcherAgentRuntime,
    channelId,
    event,
    channels,
    collaborationSpaces,
  });
  collaborationSpaces.trackLifecycleTask('accept', task);
  return task;
}

async function doHandleCollaborationTargetLifecycle(input: {
  dispatcherAgentRuntime: string;
  channelId: string;
  event: ChannelTargetLifecycleEvent;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
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

  if (event.kind === 'target_closed') {
    const closeInput = {
      channelId,
      provider: channels.channelProviderRef(channelId),
      container: event.container,
      target: event.target,
      ...(event.event_id !== undefined ? { eventId: event.event_id } : {}),
    };
    const accepted = await collaborationSpaces.acceptTargetClosedForClose(closeInput);
    if (accepted === null) return;
    collaborationSpaces.startTargetClose(accepted);
    return;
  }
  throw new Error(
    `unknown channel target lifecycle event kind ${JSON.stringify(
      (event as { kind?: unknown }).kind,
    )}`,
  );
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
    let exactBindingUnavailable = false;
    try {
      await collaborationSpaces.reconcileInboundTargetRoute({
        channelId,
        target,
      });
      const direct = await deliverToFirstBoundTarget({
        channelId,
        turn,
        targets: [target],
        channels,
        teams,
      });
      if (direct.status === 'delivered') return direct.result;
      exactBindingUnavailable = direct.status === 'unavailable';
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
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
          if (provisioned.lifecycle_status === 'detached') return fallback(turn);
          if (provisioned.lifecycle_status !== 'active') {
            return {
              status: 'failed',
              error: new Error(
                `collaboration target '${target.target_key}' is not active`,
              ),
            };
          }
          const provisionedRoute = await deliverToFirstBoundTarget({
            channelId,
            turn,
            targets: [target],
            channels,
            teams,
          });
          if (provisionedRoute.status === 'delivered') {
            return provisionedRoute.result;
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
      const claimedRoute = await deliverToFirstBoundTarget({
        channelId,
        turn,
        targets: [target],
        channels,
        teams,
      });
      if (claimedRoute.status === 'delivered') return claimedRoute.result;
      return {
        status: 'failed',
        error: new Error(
          `collaboration target '${target.target_key}' is active but has no open Team route`,
        ),
      };
    }
    if (exactBindingUnavailable) return fallback(turn);
    try {
      const lessSpecific = await deliverToFirstBoundTarget({
        channelId,
        turn,
        targets: target.binding_fallbacks ?? [],
        channels,
        teams,
      });
      if (lessSpecific.status === 'delivered') return lessSpecific.result;
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
  return fallback(turn);
}

async function deliverToFirstBoundTarget(input: {
  channelId: string;
  turn: InboundTurnInput;
  targets: ChannelInboundEnvelope['target'][];
  channels: ChannelService;
  teams: TeamCollection;
}): Promise<
  | { status: 'missing' }
  | { status: 'unavailable' }
  | { status: 'delivered'; result: AgentRuntimeTurnResult }
> {
  for (const target of input.targets) {
    const routed = await input.channels.resolveInboundBinding({
      channelId: input.channelId,
      target,
    });
    if (routed === null) continue;
    if (!(await input.teams.isOpenTeam(routed.owner.teamName))) {
      return { status: 'unavailable' };
    }
    if (input.teams.hasTaskAttempt?.(routed.owner.teamName) === true) {
      return {
        status: 'delivered',
        result: {
          status: 'failed',
          error: new Error(
            'strict task targets do not accept conversational channel delivery',
          ),
        },
      };
    }
    const team = await input.teams.get(routed.owner.teamName);
    return {
      status: 'delivered',
      result: await team.deliverToLeader(input.turn),
    };
  }
  return { status: 'missing' };
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
  if (!binding.enabled || binding.repositorySource === 'channel') return undefined;
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
