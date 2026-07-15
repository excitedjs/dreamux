/**
 * Runtime assertion that the external-provider fixture (which imports
 * `@excitedjs/dreamux-types` only) behaves, proving the type package is enough
 * to author a provider against. Type-only imports compile away, so this also
 * confirms the package surface is consumable. The fixture's
 * `@excitedjs/dreamux-types`-only import discipline is checked in
 * `import-boundary.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import {
  EXTERNAL_RUNTIME_CAPABILITIES,
  describeConfigContext,
  fixtureChannelFactory,
  fixtureChannelProvider,
  fixtureTaskChannelProvider,
  fixtureRuntimeFactory,
  fixtureRuntimeProvider,
} from './fixtures/external-provider.js';

describe('external provider fixture', () => {
  it('declares neutral runtime capabilities', () => {
    expect(EXTERNAL_RUNTIME_CAPABILITIES.resume.supported).toBe(false);
  });

  it('narrows provider descriptors to their kind (P2)', () => {
    expect(fixtureRuntimeProvider.descriptor.kind).toBe('agentRuntime');
    expect(fixtureChannelProvider.descriptor.kind).toBe('channel');
  });

  it('factories echo the seed descriptor from the loader context (P1)', async () => {
    const runtime = await fixtureRuntimeFactory({
      ref: 'npm:@example/fixture-runtime',
      descriptor: fixtureRuntimeProvider.descriptor,
    });
    expect(runtime.descriptor.kind).toBe('agentRuntime');
    const channel = await fixtureChannelFactory({
      ref: 'npm:@example/fixture-channel',
      descriptor: fixtureChannelProvider.descriptor,
    });
    expect(channel.descriptor.kind).toBe('channel');
  });

  it('delivers a plain text turn through required completionInput', async () => {
    const runtime = fixtureRuntimeProvider.createRuntime({
      identity: { runtime_id: 'd1', checkpoint_id: null },
      config: { model: 'm' },
      cwd: '/tmp/fixture',
      mcpServers: [],
    });
    expect(runtime.completionInput).toBeDefined();
    const result = await runtime.completionInput({
      text: 'done',
      sourceId: 't1',
    });
    expect(result).toEqual({ status: 'submitted', turnId: 't1' });
  });

  it('formats a config-read context', () => {
    expect(
      describeConfigContext({
        providerRef: 'npm:@example/fixture',
        agentId: 'a1',
        file: 'config.json',
        prefix: 'agents[0]',
      }),
    ).toBe('npm:@example/fixture:a1');
  });

  it('implements a full AgentRuntimeProvider against types only', async () => {
    expect(fixtureRuntimeProvider.descriptor.kind).toBe('agentRuntime');
    // `readConfig` is sync-or-async (parity with `ChannelProvider.readConfig`,
    // F4); awaiting covers both shapes.
    const config = await fixtureRuntimeProvider.readConfig?.(
      { model: 'fixture-model' },
      {
        providerRef: 'npm:@example/fixture-runtime',
        agentId: 'a1',
        file: 'config.json',
        prefix: 'agents[0]',
      },
    );
    expect(config).toEqual({ model: 'fixture-model' });

    const runtime = fixtureRuntimeProvider.createRuntime({
      identity: { runtime_id: 'd1', checkpoint_id: null },
      config: config ?? { model: 'default' },
      cwd: '/tmp/fixture',
      mcpServers: [],
    });
    expect(runtime.getStatus()).toBe('declared');
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');
    const result = await runtime.channelInput({ text: 'hi', sourceId: 'm1' });
    expect(result).toEqual({ status: 'submitted', turnId: 'm1' });
    await runtime.stop();
    expect(runtime.getStatus()).toBe('stopped');
  });

  it('resolves a channel target through the fixture session', async () => {
    const session = fixtureChannelProvider.createSession({
      dispatcher_id: 'd1',
      channel_id: 'fixture',
      provider: 'npm:@example/fixture-channel',
      config: {},
    });
    const target = await session.resolveTarget({ id: 'group-123' });
    expect(target).toEqual({
      target_type: 'group',
      target_key: 'group-123',
      bindable: true,
    });
  });

  it('authors a strict task channel against the public package root', async () => {
    expect(fixtureTaskChannelProvider.taskChannel).toEqual({
      protocol: 'task_channel_host_v1',
      schema_versions: [1],
      capabilities: [
        'durable_task_submission_v1',
        'host_event_stream_v1',
        'logical_repository_binding_v1',
      ],
    });
    const resolved = await fixtureTaskChannelProvider.resolveRepositoryBinding?.(
      { repository_key: 'repository-a' },
      {
        dispatcher_id: 'dispatcher-a',
        channel_id: 'remote-tasks',
        provider: fixtureTaskChannelProvider.ref,
        config: {
          repositories: {
            'repository-a': {
              cwd: '/tmp/example-repository',
              revision: 'revision-1',
            },
          },
        },
      },
    );
    expect(resolved).toEqual({
      cwd: '/tmp/example-repository',
      binding_revision: 'revision-1',
    });
  });
});
