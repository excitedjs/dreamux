import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCodexAgentRuntimeProvider,
  dispatcherCodexConfig,
  CodexProcess,
  type CodexProcessOptions,
  CodexWsClient,
} from '@excitedjs/agent-runtime-codex';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDispatcherConfig } from './helpers/config.js';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';
import type {
  AgentRuntime,
  AgentRuntimePathContext,
  AgentRuntimeStateCallbacks,
} from '@excitedjs/dreamux-types';

/** A codex app-server child stub: the runtime talks to the fake over WS instead. */
class NoopCodexProcess extends CodexProcess {
  constructor(opts: CodexProcessOptions) {
    super(opts);
  }
  override async start(): Promise<void> {
    /* no child; the runtime connects to the in-process fake codex */
  }
  override async reap(): Promise<void> {
    /* nothing to reap */
  }
}

describe('codex plain completionInput delivery', () => {
  const tmpDirs: string[] = [];
  const fakes: FakeCodex[] = [];
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    for (const fake of fakes.splice(0)) await fake.close();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function makeRuntime(fake: FakeCodex): Promise<AgentRuntime> {
    const dispatcher = testDispatcherConfig({ id: 'flow' });
    const tmp = mkdtempSync(join(tmpdir(), 'dx-codex-completion-'));
    tmpDirs.push(tmp);
    const paths: AgentRuntimePathContext = {
      cacheDir: () => tmp,
      logsDir: () => tmp,
      runtimeSocketDirs: () => [join(tmp, 'sockets')],
    };
    const provider = createCodexAgentRuntimeProvider({
      descriptor: createBuiltinProviderRegistry().resolve('builtin:codex'),
      codexProcessFactory: (o) => new NoopCodexProcess(o),
      codexClientFactory: () => new CodexWsClient({ url: fake.url }),
      codexHomeDoctor: () => {
        /* fake codex tests need no real operator auth */
      },
      validateTranscriptPath: async (path) => path,
    });
    const runtime = provider.createRuntime({
      identity: { runtime_id: 'flow', checkpoint: null },
      config: dispatcherCodexConfig(dispatcher),
      cwd: tmp,
      mcpServers: [],
      activitySink: () => {
        /* this suite asserts admission/dedupe, not live activity */
      },
      state: noopState(),
      paths,
    });
    runtimes.push(runtime);
    await runtime.start();
    return runtime;
  }

  it('submits plain text through turn/start without channel XML or inject_items', async () => {
    const fake = await startFakeCodex();
    fakes.push(fake);
    const runtime = await makeRuntime(fake);

    const result = await runtime.completionInput({
      text: 'TeamMate reviewer has finished its task. Output below:\n\nall done',
      sourceId: 'completion:mate-1',
    });
    expect(result).toMatchObject({ status: 'submitted' });

    expect(fake.injectItemsParams).toHaveLength(0);
    expect(fake.turnsHandled).toBe(1);
    const input = fake.turnStartParams[0]?.['input'] as Array<Record<string, unknown>>;
    expect(input[0]?.['text']).toBe(
      'TeamMate reviewer has finished its task. Output below:\n\nall done',
    );
    expect(input[0]?.['text']).not.toContain('<channel');
  });

  it('dedupes repeated stable sourceIds without a second model-visible turn', async () => {
    const fake = await startFakeCodex();
    fakes.push(fake);
    const runtime = await makeRuntime(fake);

    await expect(
      runtime.completionInput({ text: 'done once', sourceId: 'completion:mate-1' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      runtime.completionInput({ text: 'done once', sourceId: 'completion:mate-1' }),
    ).resolves.toEqual({ status: 'duplicate' });

    expect(fake.turnsHandled).toBe(1);
    expect(fake.injectItemsParams).toHaveLength(0);
  });

  it('reports an ambiguous native refusal and never repeats the source write', async () => {
    const fake = await startFakeCodex({ failTurnStart: true });
    fakes.push(fake);
    const runtime = await makeRuntime(fake);

    const result = await runtime.completionInput({
      text: 'delivery that fails',
      sourceId: 'completion:mate-2',
    });
    expect(result.status).toBe('ambiguous');
    await expect(runtime.completionInput({
      text: 'must not be written twice',
      sourceId: 'completion:mate-2',
    })).resolves.toEqual({ status: 'duplicate' });
    expect(fake.turnStartParams).toHaveLength(1);
    expect(fake.injectItemsParams).toHaveLength(0);
  });

  it('reports stopped once the runtime is stopped', async () => {
    const fake = await startFakeCodex();
    fakes.push(fake);
    const runtime = await makeRuntime(fake);
    await runtime.stop();

    const result = await runtime.completionInput({
      text: 'late',
      sourceId: 'completion:mate-3',
    });
    expect(result.status).toBe('stopped');
    expect(fake.injectItemsParams).toHaveLength(0);
  });
});

function noopState(): AgentRuntimeStateCallbacks {
  return {
    async setStatus() {},
    async setCheckpoint() {},
  };
}
