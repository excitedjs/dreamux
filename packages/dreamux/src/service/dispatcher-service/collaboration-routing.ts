import type {
  ChannelCollaborationTargetEnsureInput,
  ChannelCollaborationTargetEnsureResult,
  ChannelContainer,
  ChannelExactDeliveryInput,
  ChannelExactDeliveryResult,
  ChannelInboundEnvelope,
  ChannelScopedOperationFailureCode,
  ChannelTargetLifecycleEvent,
  DreamuxLogger,
  DreamuxManagedRepoRequest,
  InboundTurnInput,
  InboundDeliveryResult,
} from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';
import { channelOriginFromRoute } from '../channel-origin.js';
import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import { CollaborationTargetOperationError } from '../collaboration-space/operation-error.js';
import type { TeamCollection } from '../team-collection/index.js';
import { TeamUnavailableError } from '../team-collection/errors.js';
import { validateTeamId } from '../team-collection/types.js';

const ROUTE_IDENTITY_MAX = 512;
const DISPLAY_TEXT_MAX = 4_096;
const SOURCE_ID_MAX = 1_024;
const REPO_PATH_MAX = 4_096;

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

export async function ensureCollaborationTarget(input: {
  channelId: string;
  dispatcherAgentRuntime: string;
  request: ChannelCollaborationTargetEnsureInput;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  log: DreamuxLogger;
}): Promise<ChannelCollaborationTargetEnsureResult> {
  let request: ChannelCollaborationTargetEnsureInput;
  try {
    request = normalizeEnsureInput(input.request);
  } catch {
    return rejectedChannelOperation('invalid_input');
  }
  try {
    const record = await input.collaborationSpaces.acceptAndProvisionTarget(
      provisionInputForTarget({
        channelId: input.channelId,
        container: request.container,
        target: request.target,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.repo !== undefined ? { repo: request.repo } : {}),
        channels: input.channels,
      }),
      {
        allowMissing: false,
        strict: true,
        defaultBinding: defaultBindingForChannel({
          channels: input.channels,
          channelId: input.channelId,
          dispatcherAgentRuntime: input.dispatcherAgentRuntime,
        }),
      },
    );
    if (record === null) {
      return rejectedChannelOperation('collaboration_space_unavailable');
    }
    const ready = await input.collaborationSpaces.requireReadyTarget({
      record,
      target: request.target,
    });
    return { status: 'ready', team_name: ready.team_name };
  } catch (error) {
    const result = rejectedForCollaborationError(error);
    logStrictOperationFailure(input.log, input.channelId, 'ensure', result, error);
    return result;
  }
}

export async function deliverExactCollaborationTarget(input: {
  channelId: string;
  request: ChannelExactDeliveryInput;
  collaborationSpaces: CollaborationSpaceService;
  log: DreamuxLogger;
}): Promise<ChannelExactDeliveryResult> {
  let request: ChannelExactDeliveryInput;
  try {
    request = normalizeExactDeliveryInput(input.request);
  } catch {
    return { status: 'failed' };
  }
  try {
    const result = await input.collaborationSpaces.deliverExact({
      channelId: input.channelId,
      target: request.target,
      expectedTeamName: request.expected_team_name,
      turn: request.turn,
    });
    switch (result.status) {
      case 'submitted':
        return { status: 'submitted' };
      case 'duplicate':
        return { status: 'duplicate' };
      case 'stopped':
        return { status: 'stopped' };
      case 'ambiguous': {
        const rejected = rejectedChannelOperation('operation_failed');
        logStrictOperationFailure(
          input.log,
          input.channelId,
          'deliver',
          rejected,
          result.error,
        );
        return { status: 'ambiguous' };
      }
      case 'failed': {
        const rejected = rejectedChannelOperation('operation_failed');
        logStrictOperationFailure(
          input.log,
          input.channelId,
          'deliver',
          rejected,
          result.error,
        );
        return { status: 'failed' };
      }
    }
  } catch (error) {
    const result = rejectedForCollaborationError(error);
    logStrictOperationFailure(input.log, input.channelId, 'deliver', result, error);
    if (error instanceof CollaborationTargetOperationError) {
      return { status: 'failed' };
    }
    // The delivery command may already have crossed the entity admission
    // boundary before an untyped rejection reaches this adapter. Preserve the
    // uncertainty so callers never retry it as a proven pre-admission failure.
    return { status: 'ambiguous' };
  }
}

export function rejectedChannelOperation(
  code: ChannelScopedOperationFailureCode,
): {
  status: 'rejected';
  rejection: { code: ChannelScopedOperationFailureCode; retryable: boolean };
} {
  return {
    status: 'rejected',
    rejection: {
      code,
      retryable:
        code === 'collaboration_space_unavailable' ||
        code === 'target_closing' ||
        code === 'route_unavailable' ||
        code === 'dispatcher_unavailable' ||
        code === 'operation_failed',
    },
  };
}

export async function routeTeamOrCollaborationChannelInput(input: {
  channelId: string;
  dispatcherAgentRuntime: string;
  turn: InboundTurnInput;
  envelope: ChannelInboundEnvelope;
  channels: ChannelService;
  teams: TeamCollection;
  collaborationSpaces: CollaborationSpaceService;
  fallback: (turn: InboundTurnInput, envelope: ChannelInboundEnvelope) =>
    Promise<InboundDeliveryResult>;
  log?: DreamuxLogger;
}): Promise<InboundDeliveryResult> {
  const {
    channelId,
    dispatcherAgentRuntime,
    turn,
    envelope,
    channels,
    teams,
    collaborationSpaces,
    fallback,
    log,
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
        envelope, log,
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
          if (provisioned.lifecycle_status === 'detached') return fallback(turn, envelope);
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
            envelope, log,
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
        envelope, log,
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
    if (exactBindingUnavailable) return fallback(turn, envelope);
    try {
      const lessSpecific = await deliverToFirstBoundTarget({
        channelId,
        turn,
        targets: target.binding_fallbacks ?? [],
        envelope, log,
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
  return fallback(turn, envelope);
}

async function deliverToFirstBoundTarget(input: {
  channelId: string;
  turn: InboundTurnInput;
  targets: ChannelInboundEnvelope['target'][];
  envelope: ChannelInboundEnvelope;
  log: DreamuxLogger | undefined;
  channels: ChannelService;
  teams: TeamCollection;
}): Promise<
  | { status: 'missing' }
  | { status: 'unavailable' }
  | { status: 'delivered'; result: InboundDeliveryResult }
> {
  for (const target of input.targets) {
    const routed = await input.channels.resolveInboundBinding({
      channelId: input.channelId,
      target,
    });
    if (routed === null) continue;
    const origin = channelOriginFromRoute({ envelope: input.envelope, binding: routed.binding });
    if (origin === null) {
      input.log?.warn(
        {
          channel_id: input.channelId,
          provider: input.envelope.provider,
          target_type: input.envelope.target.target_type,
        },
        'channel origin could not be snapshotted; delivering the turn without one',
      );
    }
    try {
      return {
        status: 'delivered',
        result: await input.teams.deliverToLeader(
          routed.owner.teamName,
          input.turn,
          origin ?? undefined,
        ),
      };
    } catch (error) {
      if (error instanceof TeamUnavailableError) {
        return { status: 'unavailable' };
      }
      throw error;
    }
  }
  return { status: 'missing' };
}

function provisionInputForTarget(input: {
  channelId: string;
  channels: ChannelService;
  container: ChannelInboundEnvelope['container'];
  target: ChannelInboundEnvelope['target'];
  title?: string;
  repo?: DreamuxManagedRepoRequest;
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
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
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

function normalizeEnsureInput(
  input: ChannelCollaborationTargetEnsureInput,
): ChannelCollaborationTargetEnsureInput {
  if (!isRecord(input)) throw new TypeError('ensure input must be an object');
  const repo =
    input.repo !== undefined ? normalizeManagedRepoRequest(input.repo) : undefined;
  return {
    container: normalizeContainer(input.container),
    target: normalizeStrictTarget(input.target),
    ...(input.title !== undefined
      ? { title: boundedString(input.title, DISPLAY_TEXT_MAX, true) }
      : {}),
    ...(repo !== undefined ? { repo } : {}),
  };
}

/**
 * Validate the optional repo request: nonblank bounded `path` and `base_ref`
 * selecting the source repository and ref for this provision call. A small
 * local validator is intentional — this is the only place the Channel seam
 * parses the request. Throws on any violation so `ensureCollaborationTarget`
 * maps it to `invalid_input`.
 */
function normalizeManagedRepoRequest(
  repo: DreamuxManagedRepoRequest,
): DreamuxManagedRepoRequest {
  if (!isRecord(repo)) throw new TypeError('repo must be an object');
  return {
    path: boundedString(repo.path, REPO_PATH_MAX),
    base_ref: boundedString(repo.base_ref, ROUTE_IDENTITY_MAX),
  };
}

function normalizeExactDeliveryInput(
  input: ChannelExactDeliveryInput,
): ChannelExactDeliveryInput {
  if (!isRecord(input)) throw new TypeError('delivery input must be an object');
  const expectedTeamName = boundedString(
    input.expected_team_name,
    ROUTE_IDENTITY_MAX,
  );
  validateTeamId(expectedTeamName);
  if (!isRecord(input.turn)) throw new TypeError('turn must be an object');
  return {
    target: normalizeStrictTarget(input.target),
    expected_team_name: expectedTeamName,
    turn: normalizeStrictTurn(input.turn),
  };
}

function normalizeStrictTurn(turn: InboundTurnInput): InboundTurnInput {
  if (typeof turn.text !== 'string') {
    throw new TypeError('turn text must be a string');
  }
  const sourceId = boundedString(turn.sourceId, SOURCE_ID_MAX, true);
  if (turn.source !== undefined && typeof turn.source !== 'string') {
    throw new TypeError('turn source must be a string');
  }
  if (turn.body !== undefined && typeof turn.body !== 'string') {
    throw new TypeError('turn body must be a string');
  }
  let attrs: Array<[string, string]> | undefined;
  if (turn.attrs !== undefined) {
    if (!Array.isArray(turn.attrs)) {
      throw new TypeError('turn attrs must be an array');
    }
    attrs = turn.attrs.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string'
      ) {
        throw new TypeError('turn attrs must contain string pairs');
      }
      return [entry[0], entry[1]];
    });
  }
  let attachments: InboundTurnInput['attachments'] | undefined;
  if (turn.attachments !== undefined) {
    if (!Array.isArray(turn.attachments)) {
      throw new TypeError('turn attachments must be an array');
    }
    attachments = turn.attachments.map((attachment) => {
      if (!isRecord(attachment) || typeof attachment.kind !== 'string') {
        throw new TypeError('turn attachment kind must be a string');
      }
      if (attachment.name !== undefined && typeof attachment.name !== 'string') {
        throw new TypeError('turn attachment name must be a string');
      }
      if (
        attachment.localPath !== undefined &&
        typeof attachment.localPath !== 'string'
      ) {
        throw new TypeError('turn attachment localPath must be a string');
      }
      return {
        kind: attachment.kind,
        ...(attachment.name !== undefined ? { name: attachment.name } : {}),
        ...(attachment.localPath !== undefined
          ? { localPath: attachment.localPath }
          : {}),
      };
    });
  }
  return {
    text: turn.text,
    sourceId,
    ...(turn.source !== undefined ? { source: turn.source } : {}),
    ...(attrs !== undefined ? { attrs } : {}),
    ...(turn.body !== undefined ? { body: turn.body } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

function normalizeContainer(container: ChannelContainer): ChannelContainer {
  if (!isRecord(container)) throw new TypeError('container must be an object');
  return {
    container_type: boundedString(container.container_type, ROUTE_IDENTITY_MAX),
    container_key: boundedString(container.container_key, ROUTE_IDENTITY_MAX),
    ...(container.display !== undefined
      ? { display: boundedString(container.display, DISPLAY_TEXT_MAX, true) }
      : {}),
    ...(container.canonical_url !== undefined
      ? {
          canonical_url: boundedString(
            container.canonical_url,
            DISPLAY_TEXT_MAX,
            true,
          ),
        }
      : {}),
  };
}

function normalizeStrictTarget(
  target: ChannelInboundEnvelope['target'],
): ChannelInboundEnvelope['target'] {
  if (!isRecord(target)) throw new TypeError('target must be an object');
  if (target.bindable !== true) throw new TypeError('target must be bindable');
  return {
    target_type: boundedString(target.target_type, ROUTE_IDENTITY_MAX),
    target_key: boundedString(target.target_key, ROUTE_IDENTITY_MAX),
    bindable: true,
    ...(target.display !== undefined
      ? { display: boundedString(target.display, DISPLAY_TEXT_MAX, true) }
      : {}),
    ...(target.canonical_url !== undefined
      ? {
          canonical_url: boundedString(
            target.canonical_url,
            DISPLAY_TEXT_MAX,
            true,
          ),
        }
      : {}),
  };
}

function boundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  if ((!allowEmpty && value.trim() === '') || value.length > maxLength) {
    throw new RangeError('string is outside the accepted bounds');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectedForCollaborationError(error: unknown): {
  status: 'rejected';
  rejection: { code: ChannelScopedOperationFailureCode; retryable: boolean };
} {
  return error instanceof CollaborationTargetOperationError
    ? rejectedChannelOperation(error.code)
    : rejectedChannelOperation('operation_failed');
}

function logStrictOperationFailure(
  log: DreamuxLogger,
  channelId: string,
  operation: 'ensure' | 'deliver',
  result: { rejection: { code: ChannelScopedOperationFailureCode } },
  error: unknown,
): void {
  if (result.rejection.code === 'invalid_input') return;
  log.warn(
    {
      channel_id: channelId,
      operation,
      rejection_code: result.rejection.code,
      err: errorInfo(error),
    },
    'strict channel collaboration operation rejected',
  );
}
