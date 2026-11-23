import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultAntigravityConfig } from '../src/config.js';
import { prepareNativeProfile } from '../src/native-profile.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe('prepareNativeProfile', () => {
  it('renders the stable isolated role and native disabled tools', async () => {
    const { context, dir } = await fixture('tmux');
    const first = await prepareNativeProfile(context);
    const second = await prepareNativeProfile(context);
    expect(second.agentName).toBe(first.agentName);
    expect(second.nativeLogPath).not.toBe(first.nativeLogPath);
    const profile = await readFile(
      join(dir, '.gemini', 'config', 'agents', first.agentName, 'agent.md'),
      'utf8',
    );
    expect(profile).toContain('mainAgent: true\ninheritMcp: false\n');
    expect(profile).toContain('disabledTools: ["ask_question","schedule"]');
    expect(profile).toContain('"command":"core-mcp"');
    expect(profile).toContain('"DREAMUX_MCP_LEASE":"synthetic-lease"');
    expect(profile).toContain(join(dir, 'skills', 'one'));
    expect(profile.endsWith('replacement instructions\n')).toBe(true);
  });

  it('leaves session-provided MCP out of the ACP native profile', async () => {
    const { context, dir } = await fixture('acp');
    const options = await prepareNativeProfile(context);
    const profile = await readFile(
      join(dir, '.gemini', 'config', 'agents', options.agentName, 'agent.md'),
      'utf8',
    );
    expect(profile).toContain('mcpServers: []');
    expect(profile).not.toContain('core-mcp');
  });
});

async function fixture(transport: 'tmux' | 'acp') {
  const dir = await mkdtemp(join(tmpdir(), 'agy-profile-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'skills', 'one'), { recursive: true });
  const context: AgentRuntimeCreateContext<
    ReturnType<typeof defaultAntigravityConfig>
  > = {
    identity: { runtimeId: 'runtime', sessionId: null },
    config: {
      ...defaultAntigravityConfig(),
      transport,
      extra_env: { HOME: dir },
    },
    cwd: dir,
    systemPrompt: {
      replace: 'replacement instructions',
      append: ['ignored alternate representation'],
    },
    mcpServers: [
      {
        name: 'core',
        command: 'core-mcp',
        args: ['serve'],
        env: { DREAMUX_MCP_LEASE: 'synthetic-lease' },
      },
    ],
    skillSources: [
      { name: 'test', path: join(dir, 'skills'), source: 'admin' },
    ],
    disabledFeatures: ['userInterrupt', 'cron', 'unknown-feature'],
    paths: {
      cacheDir: () => join(dir, 'cache'),
      logsDir: () => join(dir, 'logs'),
      runtimeSocketDirs: () => [join(dir, 'run')],
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
  return { context, dir };
}
