import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodexAgentRuntimeProvider } from '../src/agent-runtime/builtin/codex/provider.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from '../src/agent-runtime/builtin/codex/supervisor.js';
import { CodexWsClient } from '../src/agent-runtime/builtin/codex/rpc.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';
import type {
  AgentRuntime,
  AgentRuntimePathContext,
} from '../src/agent-runtime/types.js';

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

describe('codex teammate completion delivery (native inject + trigger)', () => {
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
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('flow');
    expect(row).not.toBeNull();
    const tmp = mkdtempSync(join(tmpdir(), 'dx-codex-completion-'));
    tmpDirs.push(tmp);
    const paths: AgentRuntimePathContext = {
      dispatcherDir: () => tmp,
      stdoutLogPath: () => join(tmp, 'out.log'),
      stderrLogPath: () => join(tmp, 'err.log'),
    };
    const provider = createCodexAgentRuntimeProvider({
      descriptor: createBuiltinProviderRegistry().resolve('builtin:codex'),
      codexProcessFactory: (o) => new NoopCodexProcess(o),
      codexClientFactory: () => new CodexWsClient({ url: fake.url }),
      codexHomeDoctor: () => {
        /* fake codex tests need no real operator auth */
      },
    });
    const runtime = provider.createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      cwd: tmp,
      mcpServers: [],
      paths,
      log: () => {
        /* test sink */
      },
    });
    runtimes.push(runtime);
    await runtime.start();
    return runtime;
  }

  it('injects a developer item then triggers a turn, reporting accepted', async () => {
    const fake = await startFakeCodex();
    fakes.push(fake);
    const runtime = await makeRuntime(fake);

    const result = await runtime.completionInput!({
      source: 'teammate',
      id: 'mate-1',
      status: 'completed',
      result: 'all done',
    });
    expect(result).toEqual({ status: 'accepted' });

    // Step 1: inject_items carried a developer-role message item (not a turn).
    expect(fake.injectItemsParams).toHaveLength(1);
    const inject = fake.injectItemsParams[0]!;
    expect(inject['threadId']).toBe(runtime.getThreadId());
    const items = inject['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.['type']).toBe('message');
    expect(items[0]?.['role']).toBe('developer');
    const content = items[0]?.['content'] as Array<Record<string, unknown>>;
    expect(content[0]?.['type']).toBe('input_text');
    const text = content[0]?.['text'] as string;
    expect(text).toContain('<teammate_session_completion');
    expect(text).toContain('source="teammate"');
    expect(text).toContain('id="mate-1"');
    expect(text).toContain('status="completed"');
    expect(text).toContain('all done');

    // Step 2: a trigger turn was submitted (and ordered after the inject).
    expect(fake.turnsHandled).toBe(1);
    const injectIdx = fake.methodLog.indexOf('thread/inject_items');
    const turnIdx = fake.methodLog.indexOf('turn/start');
    expect(injectIdx).toBeGreaterThanOrEqual(0);
    expect(turnIdx).toBeGreaterThan(injectIdx);
  });

  it('reports failed (after the item was injected) when the trigger turn is refused', async () => {
    const fake = await startFakeCodex({ failTurnStart: true });
    fakes.push(fake);
    const runtime = await makeRuntime(fake);

    const result = await runtime.completionInput!({
      source: 'teammate',
      id: 'mate-2',
      status: 'failed',
      result: 'it broke',
    });
    expect(result.status).toBe('failed');
    // The inject already happened; only the trigger failed. A retry re-injects.
    expect(fake.injectItemsParams).toHaveLength(1);
  });

  it('reports unsupported once the runtime is stopped', async () => {
    const fake = await startFakeCodex();
    fakes.push(fake);
    const runtime = await makeRuntime(fake);
    await runtime.stop();

    const result = await runtime.completionInput!({
      source: 'teammate',
      id: 'mate-3',
      status: 'completed',
      result: 'late',
    });
    expect(result.status).toBe('unsupported');
    expect(fake.injectItemsParams).toHaveLength(0);
  });
});
