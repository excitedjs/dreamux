/**
 * Real built-in channel package-loader contract test (issue #209 slice 5).
 *
 * Proves the generic channel package-loader path is real for Feishu: the
 * `builtin:feishu` alias resolves to `@excitedjs/feishu-channel` via
 * `BUILTIN_PROVIDER_PACKAGES`, the loader imports the ACTUAL package (default
 * importer, no fake module), selects its default-export factory, and the loaded
 * provider satisfies the `ChannelProvider` contract end-to-end — including a
 * genuinely functional `createSession` whose neutral `resolveTarget` /
 * `messageBelongsToTarget` / `tools` are wired to the real Feishu session.
 *
 * Production wires Feishu through the core-owned adapter instead (core's
 * dispatcher still drives the result-returning inbound submitter + the core MCP
 * descriptor); this test exercises the package's neutral contract directly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelProvider,
  ChannelSession,
} from '@excitedjs/dreamux-types';
import type { FeishuChannelConfig } from '@excitedjs/feishu-channel';

import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { loadChannelProviders } from '../src/channel/external-channel-provider.js';

const tmpDirs: string[] = [];
const sessions: ChannelSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadRealFeishuProvider(): Promise<
  ChannelProvider<FeishuChannelConfig>
> {
  const registry = createBuiltinProviderRegistry();
  // Default importer => real `import('@excitedjs/feishu-channel')`.
  await loadChannelProviders({ registry, refs: ['builtin:feishu'] });
  const descriptor = registry.resolve('builtin:feishu');
  const impl = registry.getImplementation(descriptor.id);
  return impl as ChannelProvider<FeishuChannelConfig>;
}

describe('builtin:feishu loads the real @excitedjs/feishu-channel package', () => {
  it('satisfies the ChannelProvider contract through the generic loader', async () => {
    const provider = await loadRealFeishuProvider();

    expect(provider.ref).toBe('builtin:feishu');
    expect(provider.descriptor.kind).toBe('channel');
    expect(provider.descriptor.ref.raw).toBe('builtin:feishu');
    expect(typeof provider.createSession).toBe('function');
  });

  it('parses Feishu channel config via the loaded provider readConfig', async () => {
    const provider = await loadRealFeishuProvider();

    const config = provider.readConfig!(
      { app_id: 'app-x', app_secret: 'secret-x' },
      { dispatcher_id: 'flow', channel_id: 'feishu', provider: 'builtin:feishu' },
    );
    expect(config).toMatchObject({ appId: 'app-x', appSecret: 'secret-x' });
  });

  it('builds a functional neutral session from the create context', async () => {
    const provider = await loadRealFeishuProvider();
    const config = await provider.readConfig!(
      { app_id: 'app-x', app_secret: 'secret-x' },
      { dispatcher_id: 'flow', channel_id: 'feishu', provider: 'builtin:feishu' },
    );

    const tmp = mkdtempSync(join(tmpdir(), 'dx-feishu-loader-'));
    tmpDirs.push(tmp);
    const session = provider.createSession({
      dispatcher_id: 'flow',
      channel_id: 'feishu',
      provider: 'builtin:feishu',
      config,
      state_root: tmp,
      cache_root: tmp,
    });
    sessions.push(session);

    expect(session.provider).toBe('builtin:feishu');
    expect(session.channel_id).toBe('feishu');

    const target = await session.resolveTarget({ chat_id: 'chat-1', chat_type: 'group' });
    expect(target.target_key).toBe('chat-1');
    expect(target.target_type).toBe('group');
    expect(target.bindable).toBe(true);

    expect(session.messageBelongsToTarget!({ target, message_id: 'm-1' })).toBe(false);
    expect(session.tools!({ dispatcher_id: 'flow', channel_id: 'feishu' }).map((t) => t.name)).toEqual([
      'reply',
      'react',
      'list_chat_bots',
    ]);
  });
});
