import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, onTestFailed } from 'vitest';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import { readSkillAdapterManifest } from '../src/skill-adapter.js';
import { materializeClaudeSkillAddDir } from '../src/skill-materializer.js';

let skillPublicationDiagnostic:
  ReturnType<typeof observeSkillPublication> | undefined;

describe('Claude skill materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    const diagnostic = skillPublicationDiagnostic;
    diagnostic?.stage('cleanup', 'before fixture removal');
    diagnostic?.dump('afterEach.beforeCleanup');
    try {
      await Promise.all(
        roots
          .splice(0)
          .map((root) => rm(root, { recursive: true, force: true })),
      );
    } finally {
      diagnostic?.stage('cleanup', 'fixture removal settled');
      diagnostic?.dump('afterEach.afterCleanup');
      diagnostic?.stop();
      skillPublicationDiagnostic = undefined;
    }
  });

  it('publishes one readable view for simultaneous runtime starts', async () => {
    const fixture = await createFixture();
    const target = await adapterRoot(fixture);
    const published = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
      ),
    );
    expect(published).toEqual(
      Array.from({ length: 4 }, () => ({
        status: 'fulfilled',
        value: target,
      })),
    );
    expect(await realpath(join(target, '.claude', 'skills', 'review'))).toBe(
      await realpath(fixture.skill),
    );
    await expectNoLeftovers(dirname(target));
  });

  it('converges when a concurrent valid winner occupies the target directory', async () => {
    const fixture = await createFixture();
    const target = await adapterRoot(fixture);
    const firstReady = deferred();
    const releaseFirst = deferred();
    const first = materializeClaudeSkillAddDir(
      fixture.cacheDir,
      fixture.sources,
      {
        beforePublish: async () => {
          firstReady.resolve();
          await releaseFirst.promise;
        },
      },
    );
    await firstReady.promise;

    await materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources);
    releaseFirst.resolve();
    await expect(first).resolves.toBe(target);

    expect(await realpath(join(target, '.claude', 'skills', 'review'))).toBe(
      await realpath(fixture.skill),
    );
    await expect(
      readFile(join(target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 2');
  });

  it('replaces a malformed target a concurrent writer left behind', async () => {
    const diagnostic = observeSkillPublication();
    skillPublicationDiagnostic = diagnostic;
    onTestFailed(() => diagnostic.dump('onTestFailed'));
    diagnostic.stage('test', 'createFixture.await');
    const fixture = await createFixture();
    diagnostic.stage('test', 'adapterRoot.await');
    const target = await adapterRoot(fixture);
    const publishReady = deferred();
    const releasePublish = deferred();
    diagnostic.stage('test', 'materializing.start');
    const materializing = materializeClaudeSkillAddDir(
      fixture.cacheDir,
      fixture.sources,
      {
        beforePublish: async () => {
          diagnostic.stage('hook', 'entered; resolving publishReady');
          publishReady.resolve();
          diagnostic.stage('hook', 'releasePublish.await');
          await releasePublish.promise;
          diagnostic.stage('hook', 'releasePublish.resolved');
        },
      },
    );
    diagnostic.stage('test', 'publishReady.await');
    await publishReady.promise;
    diagnostic.stage('test', 'malformed.mkdir.await');
    await mkdir(target, { recursive: true });
    diagnostic.stage('test', 'malformed.writeFile.await');
    await writeFile(
      join(target, '.dreamux-skill-adapter.json'),
      '{"version":1}\n',
    );
    diagnostic.stage('test', 'releasePublish.resolve');
    releasePublish.resolve();

    diagnostic.stage('test', 'materializing.expect.await');
    await expect(materializing).resolves.toBe(target);
    diagnostic.stage('test', 'manifest.expect.await');
    await expect(
      readFile(join(target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 2');
    diagnostic.stage('test', 'adapter.realpath.await');
    const adapterRealpath = await realpath(
      join(target, '.claude', 'skills', 'review'),
    );
    diagnostic.stage('test', 'source.realpath.await');
    expect(adapterRealpath).toBe(await realpath(fixture.skill));
    diagnostic.stage('test', 'expectNoLeftovers.await');
    await expectNoLeftovers(dirname(target));
    diagnostic.stage('test', 'assertions.complete');
  });

  it('refreshes a root left by the previous adapter version in place', async () => {
    const fixture = await createFixture();
    const target = await adapterRoot(fixture);
    await mkdir(join(target, '.claude', 'skills'), { recursive: true });
    await symlink(
      fixture.skill,
      join(target, '.claude', 'skills', 'stale-name'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(
      join(target, '.dreamux-skill-adapter.json'),
      JSON.stringify({
        version: 1,
        key: basename(target),
        sources: [{ name: 'review', path: fixture.source }],
      }),
    );

    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).resolves.toBe(target);
    await expect(
      readFile(join(target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 2');
    expect(await realpath(join(target, '.claude', 'skills', 'review'))).toBe(
      await realpath(fixture.skill),
    );
    await expect(
      lstat(join(target, '.claude', 'skills', 'stale-name')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expectNoLeftovers(dirname(target));
  });

  /**
   * An in-place package upgrade renames the skills under a source root whose own
   * name and path never change. The root is keyed by the roots alone, so the
   * upgrade lands on the same directory; the manifest records the children, so
   * the stale view is detected and replaced there.
   */
  it('refreshes the same adapter root in place when a child skill is renamed under an unchanged root', async () => {
    const fixture = await createFixture();
    const root = await adapterRoot(fixture);
    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).resolves.toBe(root);
    const beforeManifest = await readFile(
      join(root, '.dreamux-skill-adapter.json'),
      'utf8',
    );

    const renamedSkill = join(fixture.source, 'code-review');
    await rename(fixture.skill, renamedSkill);

    expect(await adapterRoot(fixture)).toBe(root);
    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).resolves.toBe(root);
    expect(await realpath(join(root, '.claude', 'skills', 'code-review'))).toBe(
      await realpath(renamedSkill),
    );
    await expect(
      lstat(join(root, '.claude', 'skills', 'review')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const afterManifest = await readFile(
      join(root, '.dreamux-skill-adapter.json'),
      'utf8',
    );
    expect(afterManifest).not.toBe(beforeManifest);
    expect(afterManifest).toContain('code-review');
    await expectNoLeftovers(dirname(root));
  });

  it('names the skill source when its root can no longer be read', async () => {
    const fixture = await createFixture();
    await materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources);

    await rm(fixture.source, { recursive: true, force: true });

    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).rejects.toThrow(
      `skill source "review" root ${fixture.source} cannot be read: `,
    );
  });

  async function expectNoLeftovers(dir: string): Promise<void> {
    const leftovers = await readdir(dir);
    expect(
      leftovers.filter(
        (name) => name.endsWith('.tmp') || name.endsWith('.stale'),
      ),
    ).toEqual([]);
  }

  async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-skills-'));
    roots.push(root);
    const source = join(root, 'source');
    const skill = join(source, 'review');
    const cacheDir = join(root, 'cache');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: review\n---\n');
    return {
      source,
      skill,
      cacheDir,
      sources: [{ name: 'review', path: source, source: 'test' }] as const,
    };
  }

  /** The root the current on-disk inventory keys, as the materializer derives it. */
  async function adapterRoot(fixture: {
    cacheDir: string;
    sources: readonly AgentRuntimeSkillSource[];
  }): Promise<string> {
    const manifest = await readSkillAdapterManifest(fixture.sources);
    return join(fixture.cacheDir, 'claude-code', 'skills', manifest.key);
  }
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Observation only: no promise handlers, error listeners, timers, or gate changes. */
function observeSkillPublication() {
  const started = performance.now();
  const stages: Record<string, string> = {};
  const pending = new Map<
    number,
    {
      asyncId: number;
      triggerAsyncId: number;
      type: string;
      startedMs: number;
      callsite: string | undefined;
    }
  >();
  const completed: Array<{ asyncId: number; resourceElapsedMs: number }> = [];
  const elapsed = () => Number((performance.now() - started).toFixed(3));
  const print = (event: string, detail: Record<string, unknown>) => {
    console.error(
      'PR476_SKILL_DIAG ' +
        JSON.stringify({
          event,
          elapsedMs: elapsed(),
          pid: process.pid,
          stages: { ...stages },
          ...detail,
        }),
    );
  };
  const hook = createHook({
    init(asyncId, type, triggerAsyncId) {
      if (
        type !== 'FSREQPROMISE' &&
        type !== 'FSREQCALLBACK' &&
        type !== 'FILEHANDLECLOSEREQ'
      )
        return;
      pending.set(asyncId, {
        asyncId,
        triggerAsyncId,
        type,
        startedMs: elapsed(),
        callsite: new Error('native FS resource creation').stack,
      });
    },
    destroy(asyncId) {
      const operation = pending.get(asyncId);
      if (operation === undefined) return;
      completed.push({
        asyncId,
        resourceElapsedMs: Number((elapsed() - operation.startedMs).toFixed(3)),
      });
      pending.delete(asyncId);
    },
  });
  hook.enable();
  return {
    stage(actor: string, stage: string) {
      stages[actor] = stage;
      print('stage', { pendingNativeAsyncIds: [...pending.keys()] });
    },
    dump(trigger: string) {
      print('snapshot', {
        trigger,
        pendingNativeFS: [...pending.values()].map((operation) => ({
          ...operation,
          resourceAgeMs: Number((elapsed() - operation.startedMs).toFixed(3)),
        })),
        completedNativeFS: completed,
      });
    },
    stop() {
      hook.disable();
    },
  };
}
