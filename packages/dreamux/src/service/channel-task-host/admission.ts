import type {
  ChannelTaskReceipt,
  ChannelTaskSubmitInput,
  ChannelTaskSubmitResult,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { CanonicalTaskIdentity } from './identity.js';
import { resolveTaskRepositoryPolicy } from './repository-policy.js';
import type { TaskHostStore } from './store.js';
import { matchesDuplicate, rejected } from './service-helpers.js';
import { TaskHostBackpressureError } from './capacity.js';
import { TaskTargetConflictError } from './types.js';

export interface TaskAdmissionContext {
  dispatcherId: string;
  channelId: string;
  provider: string;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  store: TaskHostStore;
  defaultLeaderAgentRuntime: () => string;
  runtimeSupportsDurableTasks: (agentRuntimeId: string) => boolean;
  startLifecycle: (targetId: string) => void;
}

/** Complete every fail-closed pre-receipt check before the durable claim. */
export async function admitTaskSubmission(
  context: TaskAdmissionContext,
  input: ChannelTaskSubmitInput,
  identity: CanonicalTaskIdentity,
  fingerprint: string,
): Promise<ChannelTaskSubmitResult> {
  const existing = context.store.get(identity.targetId);
  if (existing !== null) {
    if (!matchesDuplicate(existing, input, fingerprint)) {
      return rejected(
        'TASK_ATTEMPT_CONFLICT',
        'task attempt was already accepted with different input',
        false,
      );
    }
    if (existing.terminal === null && existing.blocked?.retryable === true) {
      context.startLifecycle(existing.target_id);
    }
    return { status: 'accepted', receipt: existing.receipt };
  }
  if (!context.store.canAcceptTask()) {
    return rejected(
      'TASK_HOST_BACKPRESSURE',
      'task host durable capacity is temporarily exhausted',
      true,
    );
  }

  const repository = await resolveTaskRepositoryPolicy({
    channels: context.channels,
    channelId: context.channelId,
    logical: input.repository,
  });
  if (repository.status === 'rejected') return repository;
  let inspected;
  try {
    inspected = await context.collaborationSpaces.inspectTaskBinding({
      channelId: context.channelId,
      container: input.container,
      repository: repository.policy,
    });
  } catch {
    return rejected(
      'TASK_REPOSITORY_BINDING_MISMATCH',
      'collaboration space repository policy does not match the task',
      false,
    );
  }
  const leaderAgentRuntime = inspected?.leader_agent_runtime ??
    context.defaultLeaderAgentRuntime();
  if (!context.runtimeSupportsDurableTasks(leaderAgentRuntime)) {
    return rejected(
      'TASK_HOST_CAPABILITY_UNAVAILABLE',
      'the selected agent runtime cannot durably accept task submissions',
      false,
    );
  }

  const now = Date.now();
  const receipt: ChannelTaskReceipt = {
    receipt_id: identity.receiptId,
    target_id: identity.targetId,
    attempt: structuredClone(input.attempt),
    revision: 1,
    accepted_at: now,
  };
  try {
    const claimed = await context.store.claim({
      dispatcherId: context.dispatcherId,
      channelId: context.channelId,
      provider: context.provider,
      targetId: identity.targetId,
      canonicalTargetKey: identity.targetKey,
      attempt: input.attempt,
      container: {
        container_type: input.container.container_type,
        container_key: input.container.container_key,
      },
      logicalRepository: input.repository ?? null,
      resolvedRepository: repository.policy,
      requestFingerprint: fingerprint,
      receipt,
      title: input.title ?? null,
      turn: input.turn,
      teamName: identity.teamName,
      worktreeSlug: identity.worktreeSlug,
      routeClaimId: identity.routeClaimId,
    });
    context.startLifecycle(identity.targetId);
    return { status: 'accepted', receipt: claimed.record.receipt };
  } catch (error) {
    if (error instanceof TaskTargetConflictError) {
      return rejected(
        'TASK_ATTEMPT_CONFLICT',
        'task attempt was already accepted with different input',
        false,
      );
    }
    if (error instanceof TaskHostBackpressureError) {
      return rejected(
        'TASK_HOST_BACKPRESSURE',
        'task host durable capacity is temporarily exhausted',
        true,
      );
    }
    throw error;
  }
}
