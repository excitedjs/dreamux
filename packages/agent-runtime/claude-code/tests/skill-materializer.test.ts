import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
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

  it('replaces a malformed target a concurrent writer left behind', async () => {
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

    await expect(materializing).resolves.toBe(target);
    await expect(
      readFile(join(target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 2');
    expect(await readlink(join(target, '.claude', 'skills', 'review'))).toBe(
      fixture.skill,
    );
    await expectNoLeftovers(dirname(target));
  });

  it('refreshes a root left by the previous adapter version in place', async () => {
    const fixture = await createFixture();
    const target = await adapterRoot(fixture);
    await mkdir(join(target, '.claude', 'skills'), { recursive: true });
    await symlink(
      fixture.skill,
      join(target, '.claude', 'skills', 'stale-name'),
      'dir',
    );
    await writeFile(
      join(target, '.dreamux-skill-adapter.json'),
      JSON.stringify({
        version: 1,
        key: target.split('/').at(-1),
        sources: [{ name: 'review', path: fixture.source }],
      }),
    );

    await expect(
      materializeClaudeSkillAddDir(fixture.cacheDir, fixture.sources),
    ).resolves.toBe(target);
    await expect(
      readFile(join(target, '.dreamux-skill-adapter.json'), 'utf8'),
    ).resolves.toContain('"version": 2');
    expect(await readlink(join(target, '.claude', 'skills', 'review'))).toBe(
      fixture.skill,
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
    expect(await readlink(join(
      root,
      '.claude',
      'skills',
      'code-review',
    ))).toBe(renamedSkill);
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
      leftovers.filter((name) => name.endsWith('.tmp') || name.endsWith('.stale')),
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
