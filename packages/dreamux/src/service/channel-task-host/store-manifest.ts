import type { ChannelTaskContainerIdentity } from '@excitedjs/dreamux-types';

import {
  containerManifestKey,
  validateContainerManifestTransition,
} from './container-manifest.js';
import { clone } from './store-support.js';
import type {
  TaskContainerManifestApplyCandidate,
  TaskContainerManifestRecord,
} from './types.js';
import {
  TASK_CONTAINER_MANIFEST_RECORD_VERSION,
  TaskManifestApplyError,
  TaskManifestFenceError,
} from './types.js';

export function prepareContainerManifestApply(
  current: TaskContainerManifestRecord,
  candidate: TaskContainerManifestApplyCandidate,
  appliedAt: number,
): { changed: boolean; record: TaskContainerManifestRecord } {
  if (candidate.manifest.revision < current.revision) {
    throw new TaskManifestApplyError(
      'TASK_MANIFEST_STALE',
      'container manifest revision is older than durable Host state',
    );
  }
  if (candidate.manifest.revision === current.revision) {
    if (candidate.digest !== current.digest) {
      throw new TaskManifestApplyError(
        'TASK_MANIFEST_CONFLICT',
        'container manifest revision was reused with different content',
      );
    }
    return { changed: false, record: clone(current) };
  }
  const next: TaskContainerManifestRecord = {
    version: TASK_CONTAINER_MANIFEST_RECORD_VERSION,
    revision: candidate.manifest.revision,
    digest: candidate.digest,
    applied_at: appliedAt,
    entries: freezeExistingGenerationResolutions(
      current,
      clone(candidate.entries),
    ),
  };
  try {
    validateContainerManifestTransition(current, next);
  } catch (error) {
    throw new TaskManifestApplyError(
      'TASK_MANIFEST_CONFLICT',
      error instanceof Error ? error.message : 'container manifest conflicts',
    );
  }
  return { changed: true, record: next };
}

export function assertTaskManifestRevision(
  manifest: TaskContainerManifestRecord,
  revision: number,
): void {
  if (revision !== manifest.revision) {
    throw new TaskManifestFenceError(
      'TASK_CONTAINER_MANIFEST_NOT_APPLIED',
      true,
      'task command manifest revision is not the applied Host revision',
    );
  }
}

export function authorizeTaskContainer(input: {
  manifest: TaskContainerManifestRecord;
  manifestRevision: number;
  container: ChannelTaskContainerIdentity;
  containerGeneration: number;
}): TaskContainerManifestRecord['entries'][number] {
  assertTaskManifestRevision(input.manifest, input.manifestRevision);
  const entry = input.manifest.entries.find((candidate) =>
    containerManifestKey(candidate.container) ===
      containerManifestKey(input.container)
  );
  if (entry === undefined || entry.state !== 'active') {
    throw new TaskManifestFenceError(
      'TASK_CONTAINER_NOT_AUTHORIZED',
      false,
      'task container is not active in the applied manifest',
    );
  }
  if (entry.generation !== input.containerGeneration) {
    throw new TaskManifestFenceError(
      'TASK_CONTAINER_GENERATION_MISMATCH',
      false,
      'task container generation does not match the applied manifest',
    );
  }
  return clone(entry);
}

function freezeExistingGenerationResolutions(
  current: TaskContainerManifestRecord,
  candidates: TaskContainerManifestRecord['entries'],
): TaskContainerManifestRecord['entries'] {
  for (const candidate of candidates) {
    if (candidate.state === 'revoked') continue;
    const prior = current.entries.find((entry) =>
      containerManifestKey(entry.container) ===
        containerManifestKey(candidate.container) &&
      entry.generation === candidate.generation &&
      sameLogicalRepository(entry.logical_repository, candidate.logical_repository)
    );
    if (prior?.resolved_repository === null || prior === undefined) continue;
    candidate.resolved_repository = clone(prior.resolved_repository);
    candidate.resolution = clone(prior.resolution);
  }
  return candidates;
}

function sameLogicalRepository(
  left: TaskContainerManifestRecord['entries'][number]['logical_repository'],
  right: TaskContainerManifestRecord['entries'][number]['logical_repository'],
): boolean {
  return left?.repository_key === right?.repository_key &&
    left?.expected_revision === right?.expected_revision;
}
