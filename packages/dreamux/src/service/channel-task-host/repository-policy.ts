import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import type {
  ChannelLogicalRepositoryBinding,
  ChannelTaskRejectCode,
} from '@excitedjs/dreamux-types';
import { execa } from 'execa';

import { isRealPathUnderDreamuxRoot } from '../../platform/paths.js';
import type { ChannelService } from '../channel-service/index.js';
import type { TaskRepositoryPolicy } from './types.js';

export type TaskRepositoryResolution =
  | { status: 'resolved'; policy: TaskRepositoryPolicy }
  | {
      status: 'rejected';
      code: ChannelTaskRejectCode;
      message: string;
      retryable: boolean;
    };

export async function resolveTaskRepositoryPolicy(input: {
  channels: ChannelService;
  channelId: string;
  logical: ChannelLogicalRepositoryBinding | undefined;
}): Promise<TaskRepositoryResolution> {
  const config = input.channels.collaborationSpaceConfig(input.channelId).defaultBinding;
  if (!config.enabled) {
    return rejected(
      'TASK_DEFAULT_BINDING_DISABLED',
      'automatic collaboration binding is disabled for this channel',
      false,
    );
  }

  let source: TaskRepositoryPolicy['source'];
  let cwd: string;
  let baseRef: string | null;
  let bindingRevision: string;
  let logicalKey: string;
  if (config.repositorySource === 'static') {
    if (config.repo === null) {
      return rejected(
        'TASK_REPOSITORY_BINDING_MISSING',
        'the channel default binding has no managed repository',
        false,
      );
    }
    source = 'static';
    cwd = config.repo.cwd;
    baseRef = config.repo.baseRef;
    bindingRevision = 'static-v1';
    logicalKey = '@static';
  } else {
    if (input.logical === undefined) {
      return rejected(
        'TASK_REPOSITORY_BINDING_MISSING',
        'this channel requires a logical repository binding',
        false,
      );
    }
    let resolved;
    try {
      resolved = await input.channels.resolveRepositoryBinding(
        input.channelId,
        input.logical,
      );
    } catch {
      return rejected(
        'TASK_REPOSITORY_BINDING_MISSING',
        'the logical repository binding could not be resolved',
        true,
      );
    }
    if (resolved === null) {
      return rejected(
        'TASK_REPOSITORY_BINDING_MISSING',
        'the logical repository binding is not in the local channel policy',
        false,
      );
    }
    source = 'channel';
    cwd = resolved.cwd;
    baseRef = resolved.base_ref ?? null;
    bindingRevision = resolved.binding_revision;
    logicalKey = input.logical.repository_key;
  }

  if (
    source === 'channel' &&
    input.logical !== undefined &&
    input.logical.expected_revision !== undefined &&
    input.logical.expected_revision !== bindingRevision
  ) {
    return rejected(
      'TASK_REPOSITORY_BINDING_MISMATCH',
      'the logical repository binding revision does not match local policy',
      false,
    );
  }

  try {
    const policy = await validateManagedRepository({
      source,
      logicalKey,
      bindingRevision,
      cwd,
      baseRef,
    });
    return { status: 'resolved', policy };
  } catch {
    return rejected(
      'TASK_REPOSITORY_NOT_MANAGED',
      'the resolved repository is not an available managed Git repository',
      false,
    );
  }
}

async function validateManagedRepository(input: {
  source: TaskRepositoryPolicy['source'];
  logicalKey: string;
  bindingRevision: string;
  cwd: string;
  baseRef: string | null;
}): Promise<TaskRepositoryPolicy> {
  const info = await stat(input.cwd);
  if (!info.isDirectory()) throw new Error('repository binding is not a directory');
  const canonicalCwd = await realpath(input.cwd);
  if (await isRealPathUnderDreamuxRoot(canonicalCwd)) {
    throw new Error('repository binding is under Dreamux state');
  }
  const rootResult = await execa('git', ['rev-parse', '--show-toplevel'], {
    cwd: canonicalCwd,
  });
  const repoRoot = await realpath(rootResult.stdout.trim());
  const baseRef = input.baseRef ?? 'HEAD';
  const baseResult = await execa(
    'git',
    ['rev-parse', '--verify', `${baseRef}^{commit}`],
    { cwd: repoRoot },
  );
  const baseCommit = baseResult.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
    throw new Error('repository binding did not resolve to a canonical commit object id');
  }
  const fingerprint = createHash('sha256')
    .update(input.source)
    .update('\0')
    .update(input.logicalKey)
    .update('\0')
    .update(input.bindingRevision)
    .update('\0')
    .update(repoRoot)
    .update('\0')
    .update(baseRef)
    .digest('hex');
  return {
    source: input.source,
    logical_key: input.logicalKey,
    binding_revision: input.bindingRevision,
    fingerprint,
    repo_cwd: repoRoot,
    base_ref: input.baseRef,
    base_commit: baseCommit,
  };
}

function rejected(
  code: ChannelTaskRejectCode,
  message: string,
  retryable: boolean,
): TaskRepositoryResolution {
  return { status: 'rejected', code, message, retryable };
}
