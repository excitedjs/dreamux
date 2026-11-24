import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareNativeCustomizations } from '../src/native-customizations.js';
import { defaultAntigravityConfig } from '../src/config.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe('prepareNativeCustomizations', () => {
  it('materializes Core skills in provider cache without a custom agent', async () => {
    const { context, dir, firstSkill } = await fixture();
    const options = await prepareNativeCustomizations(context);
    expect(options.skillAddDir).not.toBeNull();
    const root = options.skillAddDir!;
    expect(root.startsWith(join(dir, 'cache'))).toBe(true);
    expect(await readdir(join(root, '.agents', 'skills'))).toEqual(['one']);
    expect(await readlink(join(root, '.agents', 'skills', 'one'))).toBe(
      firstSkill,
    );
    const second = await prepareNativeCustomizations(context);
    expect(second.skillAddDir).toBe(root);
    expect(second.nativeLogPath).not.toBe(options.nativeLogPath);
    await expect(
      readdir(join(dir, '.gemini', 'config', 'agents')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds tmux MCP config and role rules in provider cache', async () => {
    const { context } = await fixture();
    const options = await prepareNativeCustomizations({
      ...context,
      config: { ...context.config, transport: 'tmux' },
      mcpServers: [
        {
          name: 'selected',
          command: 'example',
          args: ['serve'],
          env: { TEST_VALUE: 'public' },
        },
      ],
      systemPrompt: { append: ['role instruction'] },
    });
    const root = options.skillAddDir!;
    const mcp = JSON.parse(
      await readFile(join(root, '.agents', 'mcp_config.json'), 'utf8'),
    );
    expect(mcp).toEqual({
      mcpServers: {
        selected: {
          command: 'example',
          args: ['serve'],
          env: { TEST_VALUE: 'public' },
        },
      },
    });
    const rule = await readFile(
      join(root, '.agents', 'rules', 'dreamux.md'),
      'utf8',
    );
    expect(rule).toBe('---\ntrigger: always_on\n---\nrole instruction\n');
    expect(rule).not.toContain('disabledTools');
  });

  it('omits --add-dir when Core supplies no skills', async () => {
    const { context } = await fixture();
    const options = await prepareNativeCustomizations({
      ...context,
      skillSources: [],
    });
    expect(options.skillAddDir).toBeNull();
  });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agy-acp-options-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const firstSkill = join(dir, 'sources', 'one');
  await mkdir(firstSkill, { recursive: true });
  const context: AgentRuntimeCreateContext<
    ReturnType<typeof defaultAntigravityConfig>
  > = {
    identity: { runtimeId: 'runtime', sessionId: null },
    config: {
      ...defaultAntigravityConfig(),
      transport: 'acp',
      extra_env: { HOME: dir },
    },
    cwd: dir,
    mcpServers: [],
    skillSources: [
      { name: 'test', path: join(dir, 'sources'), source: 'admin' },
    ],
    disabledFeatures: ['userInterrupt', 'cron'],
    paths: {
      cacheDir: () => join(dir, 'cache'),
      logsDir: () => join(dir, 'logs'),
      runtimeSocketDirs: () => [],
    },
    state: { publish: async () => undefined },
    events: () => undefined,
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => context.logger,
    },
  };
  return { context, dir, firstSkill };
}
