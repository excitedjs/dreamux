import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
    const firstReady = deferred();
    const releaseFirst = deferred();
    const first = materializeClaudeSkillAddDir(
      fixture.target,
      fixture.sources,
      {
        beforePublish: async () => {
          firstReady.resolve();
          await releaseFirst.promise;
        },
      },
    );
    await firstReady.promise;

    await materializeClaudeSkillAddDir(fixture.target, fixture.sources);
    releaseFirst.resolve();
    await expect(first).resolves.toBeUndefined();

    expect(await readlink(join(
      fixture.target,
      '.claude',
      'skills',
      'review',
    ))).toBe(fixture.skill);
    await expect(
      readFile(join(fixture.target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 1');
  });

  it('fails loud when a concurrent winner leaves a malformed target', async () => {
    const fixture = await createFixture();
    const publishReady = deferred();
    const releasePublish = deferred();
    const materializing = materializeClaudeSkillAddDir(
      fixture.target,
      fixture.sources,
      {
        beforePublish: async () => {
          publishReady.resolve();
          await releasePublish.promise;
        },
      },
    );
    await publishReady.promise;
    await mkdir(fixture.target, { recursive: true });
    await writeFile(
      join(fixture.target, '.dreamux-skill-adapter.json'),
      '{"version":1}\n',
    );
    releasePublish.resolve();

    await expect(materializing).rejects.toThrow(
      /invalid Claude skill adapter/u,
    );
    await expect(lstat(fixture.target)).resolves.toMatchObject({});
    const leftovers = await readdir(dirname(fixture.target));
    expect(leftovers.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-skills-'));
    roots.push(root);
    const source = join(root, 'source');
    const skill = join(source, 'review');
    const target = join(root, 'cache', 'adapter');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: review\n---\n');
    return {
      source,
      skill,
      target,
      sources: [{ name: 'review', path: source, source: 'test' }] as const,
    };
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
