import type {
  ChannelLogicalRepositoryBinding,
  ChannelTaskContainerIdentity,
  ChannelTaskContainerManifest,
} from '@excitedjs/dreamux-types';

import {
  containerManifestDigest,
  containerManifestKey,
} from '../../src/service/channel-task-host/container-manifest.js';
import { TaskHostStore } from '../../src/service/channel-task-host/store.js';
import type {
  TaskContainerManifestEntryRecord,
  TaskRepositoryPolicy,
} from '../../src/service/channel-task-host/types.js';

export interface TestContainerInput {
  container: ChannelTaskContainerIdentity;
  generation?: number;
  state?: 'active' | 'draining' | 'revoked';
  tombstonedAt?: number;
  logicalRepository?: ChannelLogicalRepositoryBinding | null;
  resolvedRepository?: TaskRepositoryPolicy | null;
}

export async function applyTestTaskManifest(
  store: TaskHostStore,
  containers: readonly TestContainerInput[],
  revision = 1,
): Promise<void> {
  await store.applyContainerManifest(testTaskManifestCandidate(containers, revision));
}

export function testTaskManifestCandidate(
  containers: readonly TestContainerInput[],
  revision = 1,
) {
  const entries = containers.map((input) => manifestEntry(input));
  entries.sort((left, right) =>
    containerManifestKey(left.container).localeCompare(
      containerManifestKey(right.container),
    ),
  );
  const manifest: ChannelTaskContainerManifest = {
    revision,
    entries: entries.map((entry) => ({
      container: structuredClone(entry.container),
      generation: entry.generation,
      state: entry.state,
      ...(entry.logical_repository !== null
          ? { repository: structuredClone(entry.logical_repository) }
          : {}),
      ...(entry.tombstoned_at !== null
        ? { tombstoned_at: entry.tombstoned_at }
        : {}),
    })),
  };
  return {
    manifest,
    digest: containerManifestDigest(manifest),
    entries,
  };
}

export function testTaskContainer(
  containerKey: string,
  input: Omit<TestContainerInput, 'container'> = {},
): TestContainerInput {
  return {
    container: {
      container_type: 'task-space',
      container_key: containerKey,
    },
    ...input,
  };
}

function manifestEntry(input: TestContainerInput): TaskContainerManifestEntryRecord {
  const generation = input.generation ?? 1;
  const state = input.state ?? 'active';
  const logicalRepository = input.logicalRepository === undefined
    ? { repository_key: 'repository-a' }
    : input.logicalRepository;
  const resolvedRepository = state === 'revoked'
    ? null
    : input.resolvedRepository ?? {
    source: 'channel',
    logical_key: logicalRepository?.repository_key ?? '@static',
    binding_revision: logicalRepository?.expected_revision ?? 'revision-1',
    fingerprint: 'a'.repeat(64),
    repo_cwd: '/tmp/example-repository',
    base_ref: null,
    base_commit: '0'.repeat(40),
  };
  return {
    container: structuredClone(input.container),
    generation,
    state,
    logical_repository: structuredClone(logicalRepository),
    resolved_repository: structuredClone(resolvedRepository),
    resolution: state === 'revoked'
      ? { status: 'revoked' }
      : {
          status: 'ready',
          binding_revision: resolvedRepository!.binding_revision,
          fingerprint: resolvedRepository!.fingerprint,
        },
    tombstoned_at: state === 'revoked' ? input.tombstonedAt ?? 1 : null,
  };
}
