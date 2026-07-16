import type {
  ChannelTaskReceipt,
  ChannelTaskSubmitInput,
  ChannelTaskSubmitResult,
} from '@excitedjs/dreamux-types';

import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { CanonicalTaskIdentity } from './identity.js';
import type { TaskHostStore } from './store.js';
import { matchesDuplicate, rejected } from './service-helpers.js';
import { TaskHostBackpressureError } from './capacity.js';
import { TaskManifestFenceError, TaskTargetConflictError } from './types.js';

export interface TaskAdmissionContext {
  dispatcherId: string;
  channelId: string;
  provider: string;
  collaborationSpaces: CollaborationSpaceService;
  store: TaskHostStore;
  defaultLeaderAgentRuntime: () => string;
  runtimeSupportsDurableTasks: (agentRuntimeId: string) => boolean;
  assertSessionActive: () => void;
  startLifecycle: (targetId: string) => void;
}

/** Complete every fail-closed pre-receipt check before the durable claim. */
export async function admitTaskSubmission(
  context: TaskAdmissionContext,
  input: ChannelTaskSubmitInput,
  identity: CanonicalTaskIdentity,
  fingerprint: string,
): Promise<ChannelTaskSubmitResult> {
  try {
    context.store.assertManifestRevision(input.manifest_revision);
  } catch (error) {
    if (error instanceof TaskManifestFenceError) {
      return rejected(error.code, error.message, error.retryable);
    }
    throw error;
  }
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

  let manifestEntry;
  try {
    manifestEntry = context.store.authorizeNewSubmission({
      manifestRevision: input.manifest_revision,
      container: input.container,
      containerGeneration: input.container_generation,
    });
  } catch (error) {
    if (error instanceof TaskManifestFenceError) {
      return rejected(error.code, error.message, error.retryable);
    }
    throw error;
  }
  if (manifestEntry.resolution.status === 'unavailable') {
    return rejected(
      manifestEntry.resolution.code,
      'task container repository policy is unavailable',
      manifestEntry.resolution.retryable,
    );
  }
  if (manifestEntry.resolved_repository === null) {
    return rejected(
      'TASK_REPOSITORY_BINDING_MISSING',
      'task container has no resolved managed repository',
      false,
    );
  }
  if (!logicalRepositoryMatches(
    input.repository,
    manifestEntry.logical_repository,
  )) {
    return rejected(
      'TASK_REPOSITORY_BINDING_MISMATCH',
      'task repository does not match the applied container manifest',
      false,
    );
  }
  let inspected;
  try {
    inspected = await context.collaborationSpaces.inspectTaskBinding({
      channelId: context.channelId,
      container: input.container,
      repository: manifestEntry.resolved_repository,
    });
  } catch {
    return rejected(
      'TASK_REPOSITORY_BINDING_MISMATCH',
      'collaboration space repository policy does not match the task',
      false,
    );
  }
  context.assertSessionActive();
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
    manifest_revision: input.manifest_revision,
    container_generation: input.container_generation,
  };
  try {
    context.assertSessionActive();
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
      manifestRevision: input.manifest_revision,
      containerGeneration: input.container_generation,
      logicalRepository: manifestEntry.logical_repository,
      resolvedRepository: manifestEntry.resolved_repository,
      requestFingerprint: fingerprint,
      receipt,
      title: input.title ?? null,
      turn: input.turn,
      teamName: identity.teamName,
      worktreeSlug: identity.worktreeSlug,
      routeClaimId: identity.routeClaimId,
    }, context.assertSessionActive);
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
    if (error instanceof TaskManifestFenceError) {
      return rejected(error.code, error.message, error.retryable);
    }
    throw error;
  }
}

function logicalRepositoryMatches(
  delivered: ChannelTaskSubmitInput['repository'],
  manifest: NonNullable<ChannelTaskSubmitInput['repository']> | null,
): boolean {
  if (delivered === undefined) return true;
  if (manifest === null || delivered.repository_key !== manifest.repository_key) {
    return false;
  }
  return delivered.expected_revision === undefined ||
    delivered.expected_revision === manifest.expected_revision;
}
