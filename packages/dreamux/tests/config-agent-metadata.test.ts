import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { mergeWithDefaults, stringifyConfig } from '../src/config/config.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { ControlledRuntimeProvider } from './helpers/controlled-runtime-provider.js';
import { createUnstartedCommandServer } from './helpers/command-harness.js';

function configFixture() {
  const registry = new ProviderRegistry();
  const provider = new ControlledRuntimeProvider();
  const read = vi.fn((raw: Record<string, unknown>) => ({
    ...raw,
    normalized: true,
  }));
  registry.register(
    {
      id: 'controlled',
      kind: 'agentRuntime',
      ref: parseProviderRef('builtin:controlled'),
    },
    {
      createRuntime: provider.createRuntime.bind(provider),
      readRecentActivity: provider.readRecentActivity.bind(provider),
      config: { read },
    },
  );
  const agent = {
    id: 'reviewer',
    provider: 'builtin:controlled',
    config: { model: 'example' },
  };
  return { registry, agent, read };
}

describe('agents[] host metadata', () => {
  it('round-trips metadata without forwarding it to the provider config reader', async () => {
    const { registry, agent, read } = configFixture();
    const entry = {
      ...agent,
      description: ' Reviews code. ',
      tags: ['review', '', 'review'],
      developerInstructions: 'Keep responses concise.\nPreserve evidence.',
    };
    const config = await mergeWithDefaults(
      { agents: [entry] },
      'config.json',
      registry,
    );
    expect(config.agents['reviewer']).toMatchObject({
      description: entry.description,
      tags: entry.tags,
      developerInstructions: entry.developerInstructions,
      config: { model: 'example', normalized: true },
    });
    expect(read.mock.calls[0]?.[0]).toEqual(agent.config);
    expect(JSON.parse(stringifyConfig(config)).agents).toEqual([entry]);
    expect(
      await mergeWithDefaults(
        JSON.parse(stringifyConfig(config)),
        'config.json',
        registry,
      ),
    ).toEqual(config);
  });

  it('keeps existing entries readable without adding metadata defaults', async () => {
    const { registry, agent } = configFixture();
    const config = await mergeWithDefaults(
      { agents: [agent] },
      'config.json',
      registry,
    );
    expect(config.agents['reviewer']).not.toHaveProperty('description');
    expect(config.agents['reviewer']).not.toHaveProperty('tags');
    expect(config.agents['reviewer']).not.toHaveProperty(
      'developerInstructions',
    );
    expect(JSON.parse(stringifyConfig(config)).agents).toEqual([agent]);
  });

  it('preserves explicitly empty metadata in file output', async () => {
    const { registry, agent } = configFixture();
    const entry = {
      ...agent,
      description: '',
      tags: [],
      developerInstructions: '',
    };
    const config = await mergeWithDefaults(
      { agents: [entry] },
      'config.json',
      registry,
    );
    expect(JSON.parse(stringifyConfig(config)).agents).toEqual([entry]);
  });

  it.each([
    ['description', 1, 'description must be a string'],
    ['description', null, 'description must be a string'],
    ['developerInstructions', [], 'developerInstructions must be a string'],
    ['developerInstructions', null, 'developerInstructions must be a string'],
    ['tags', 'review', 'tags must be an array of strings'],
    ['tags', null, 'tags must be an array of strings'],
    ['tags', ['review', 1], 'tags[1] must be a string'],
  ])('rejects malformed %s metadata: %j', async (key, value, message) => {
    const { registry, agent } = configFixture();
    await expect(
      mergeWithDefaults(
        { agents: [{ ...agent, [key as string]: value }] },
        'config.json',
        registry,
      ),
    ).rejects.toThrow(`agents[0].${message}`);
  });

  it('replaces metadata through the live config service and rejects invalid updates without writing', async () => {
    const fixture = await createUnstartedCommandServer();
    const entries = fixture.config.readAgents().map((agent) => ({
      ...agent,
      description: 'Current review runtime',
      tags: ['review'],
      developerInstructions: 'Check caller behavior.',
    }));
    const original = JSON.parse(await readFile(fixture.config.file, 'utf8'));
    await fixture.config.replaceAgents(entries);
    const saved = await readFile(fixture.config.file, 'utf8');
    expect(JSON.parse(saved)).toEqual({ ...original, agents: entries });
    expect(fixture.config.readAgents()).toEqual(entries);
    expect(fixture.config.current().agents['controlled']).toMatchObject({
      description: 'Current review runtime',
      tags: ['review'],
      developerInstructions: 'Check caller behavior.',
    });
    await expect(
      fixture.config.replaceAgents(
        entries.map((agent) => ({ ...agent, tags: [false] })),
      ),
    ).rejects.toThrow('tags[0] must be a string');
    expect(fixture.config.readAgents()).toEqual(entries);
    expect(await readFile(fixture.config.file, 'utf8')).toBe(saved);
  });
});
