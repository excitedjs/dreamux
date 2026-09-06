import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import { readSkillAdapterManifest } from '../src/skill-adapter.js';
import { materializeClaudeSkillAddDir } from '../src/skill-materializer.js';

describe('Claude skill materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
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

    expect(await readlink(join(
      target,
      '.claude',
      'skills',
      'review',
    ))).toBe(fixture.skill);
    await expect(
      readFile(join(target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 2');
  });

  it('fails loud when a concurrent winner leaves a malformed target', async () => {
    const fixture = await createFixture();
    const target = await adapterRoot(fixture);
    const publishReady = deferred();
    const releasePublish = deferred();
    const materializing = materializeClaudeSkillAddDir(
      fixture.cacheDir,
      fixture.sources,
      {
        beforePublish: async () => {
          publishReady.resolve();
          await releasePublish.promise;
        },
      },
    );
    await publishReady.promise;
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, '.dreamux-skill-adapter.json'),
      '{"version":1}\n',
    );
    releasePublish.resolve();

    await expect(materializing).rejects.toThrow(
      /invalid Claude skill adapter/u,
    );
    await expect(lstat(target)).resolves.toMatchObject({});
    const leftovers = await readdir(dirname(target));
    expect(leftovers.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  /**
   * An in-place package upgrade renames the skills under a source root whose own
   * name and path never change. The child inventory is part of the adapter's
   * identity, so that upgrade lands on a new root with the new names, and the
   * root the previous inventory produced is left exactly as it was.
   */
  it('materializes a new adapter when a child skill is renamed under an unchanged root', async () => {
    const fixture = await createFixture();
    const before = await adapterRoot(fixture);
    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).resolves.toBe(before);
    const beforeManifest = await readFile(
      join(before, '.dreamux-skill-adapter.json'),
      'utf8',
    );

    const renamedSkill = join(fixture.source, 'code-review');
    await rename(fixture.skill, renamedSkill);

    const after = await adapterRoot(fixture);
    expect(after).not.toBe(before);
    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).resolves.toBe(after);
    expect(await readlink(join(
      after,
      '.claude',
      'skills',
      'code-review',
    ))).toBe(renamedSkill);
    await expect(
      lstat(join(after, '.claude', 'skills', 'review')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      readFile(join(before, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toBe(beforeManifest);
    expect(await readlink(join(
      before,
      '.claude',
      'skills',
      'review',
    ))).toBe(fixture.skill);
  });

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
