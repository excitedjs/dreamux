import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { resolveTaskRepositoryPolicy } from '../src/service/channel-task-host/repository-policy.js';
import type { ChannelService } from '../src/service/channel-service/index.js';

describe('task repository binding policy', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-repository-'));
    repo = join(root, 'repository');
    await execa('git', ['init', repo]);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    await execa('git', ['-C', repo, 'add', 'README.md']);
    await execa('git', [
      '-C', repo,
      '-c', 'user.name=Dreamux Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'fixture',
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves a logical key through the trusted channel-local resolver', async () => {
    const resolveRepositoryBinding = vi.fn(async () => ({
      cwd: repo,
      base_ref: 'HEAD',
      binding_revision: 'allowlist-revision-7',
    }));
    const channels = channelService('channel', resolveRepositoryBinding);

    const result = await resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: {
        repository_key: 'repository-a',
        expected_revision: 'allowlist-revision-7',
      },
    });
    expect(resolveRepositoryBinding).toHaveBeenCalledWith(
      'remote-tasks',
      {
        repository_key: 'repository-a',
        expected_revision: 'allowlist-revision-7',
      },
    );
    const canonicalRepo = await realpath(repo);
    expect(result).toMatchObject({
      status: 'resolved',
      policy: {
        source: 'channel',
        logical_key: 'repository-a',
        binding_revision: 'allowlist-revision-7',
        repo_cwd: canonicalRepo,
        base_ref: 'HEAD',
      },
    });
    if (result.status !== 'resolved') throw new Error('expected resolution');
    expect(result.policy.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const acceptedCommit = (await execa('git', ['-C', repo, 'rev-parse', 'HEAD']))
      .stdout.trim();
    expect(result.policy.base_commit).toBe(acceptedCommit);

    await writeFile(join(repo, 'LATER.md'), 'later\n');
    await execa('git', ['-C', repo, 'add', 'LATER.md']);
    await execa('git', [
      '-C', repo,
      '-c', 'user.name=Dreamux Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'later fixture',
    ]);
    const moved = await resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: { repository_key: 'repository-a' },
    });
    expect(moved.status).toBe('resolved');
    if (moved.status !== 'resolved') throw new Error('expected moved resolution');
    expect(moved.policy.base_commit).not.toBe(acceptedCommit);
    expect(moved.policy.fingerprint).not.toBe(result.policy.fingerprint);
  });

  it('rejects missing, unknown, and mismatched logical bindings with typed results', async () => {
    const channels = channelService('channel', vi.fn(async () => null));
    await expect(resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: undefined,
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_REPOSITORY_BINDING_MISSING',
      retryable: false,
    });
    await expect(resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: { repository_key: 'unknown' },
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_REPOSITORY_BINDING_MISSING',
      retryable: false,
    });

    const mismatched = channelService('channel', vi.fn(async () => ({
      cwd: repo,
      binding_revision: 'revision-2',
    })));
    await expect(resolveTaskRepositoryPolicy({
      channels: mismatched,
      channelId: 'remote-tasks',
      logical: {
        repository_key: 'repository-a',
        expected_revision: 'revision-1',
      },
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_REPOSITORY_BINDING_MISMATCH',
      retryable: false,
    });
  });

  it('marks resolver execution failure retryable but an allowlist miss permanent', async () => {
    const channels = channelService('channel', vi.fn(async () => {
      throw new Error('resolver unavailable');
    }));
    await expect(resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: { repository_key: 'repository-a' },
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_REPOSITORY_BINDING_MISSING',
      retryable: true,
    });
  });

  it('keeps static default binding compatible and ignores unused logical metadata', async () => {
    const resolver = vi.fn(async () => null);
    const channels = channelService('static', resolver, true, repo);
    const withoutLogical = await resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: undefined,
    });
    const withUnusedLogical = await resolveTaskRepositoryPolicy({
      channels,
      channelId: 'remote-tasks',
      logical: {
        repository_key: 'ignored',
        expected_revision: 'ignored',
      },
    });
    expect(withoutLogical).toMatchObject({
      status: 'resolved',
      policy: {
        source: 'static',
        logical_key: '@static',
        binding_revision: 'static-v1',
      },
    });
    expect(withUnusedLogical).toEqual(withoutLogical);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires an enabled default binding and a real managed Git repository', async () => {
    const disabled = channelService('static', vi.fn(), false, repo);
    await expect(resolveTaskRepositoryPolicy({
      channels: disabled,
      channelId: 'remote-tasks',
      logical: undefined,
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_DEFAULT_BINDING_DISABLED',
    });

    const directory = join(root, 'not-a-repository');
    await mkdir(directory);
    const invalid = channelService('static', vi.fn(), true, directory);
    await expect(resolveTaskRepositoryPolicy({
      channels: invalid,
      channelId: 'remote-tasks',
      logical: undefined,
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_REPOSITORY_NOT_MANAGED',
      retryable: false,
    });
  });
});

function channelService(
  repositorySource: 'static' | 'channel',
  resolver: (...args: unknown[]) => Promise<unknown>,
  enabled = true,
  staticRepo?: string,
): ChannelService {
  return {
    collaborationSpaceConfig: () => ({
      defaultBinding: {
        enabled,
        repositorySource,
        repo: repositorySource === 'static'
          ? { cwd: staticRepo ?? '/missing-test-repository', baseRef: null }
          : null,
        identity: null,
      },
    }),
    resolveRepositoryBinding: resolver,
  } as unknown as ChannelService;
}
