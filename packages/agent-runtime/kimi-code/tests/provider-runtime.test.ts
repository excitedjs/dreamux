import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createKimiCodeAgentRuntimeProvider,
  kimiCodeAcpMcpServers,
  readDispatcherKimiCodeConfig,
  type KimiCodeAcpClient,
  type KimiCodeAcpClientFactory,
  type KimiCodeAcpClientSpec,
  type KimiCodeAcpPromptResult,
  type KimiCodeAcpSessionRequest,
} from '../src/index.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeStateCallbacks,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

describe('kimi-code provider config', () => {
  it('parses defaults and validates string fields', () => {
    expect(readDispatcherKimiCodeConfig({}, 'config.json', 'agents[0].config.')).toMatchObject({
      bin: 'kimi',
      home_dir: null,
      extra_args: [],
      extra_env: {},
    });
    expect(() =>
      readDispatcherKimiCodeConfig(
        { bin: '' },
        'config.json',
        'agents[0].config.',
      ),
    ).toThrow(/bin must be a non-empty string/);
  });

  it('maps Dreamux MCP descriptors to ACP stdio descriptors', () => {
    expect(
      kimiCodeAcpMcpServers([
        { name: 'fs', command: 'mcp-fs', args: ['--root', '/repo'] },
      ]),
    ).toEqual([
      { name: 'fs', command: 'mcp-fs', args: ['--root', '/repo'], env: [] },
    ]);
  });
});

describe('kimi-code runtime', () => {
  let root: string;
  let client: FakeKimiClient;
  let runtime: AgentRuntime | null;
  let state: CapturingState;
  let settled: TurnSettledSignal[];
  let events: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-kimi-runtime-'));
    client = new FakeKimiClient();
    runtime = null;
    state = new CapturingState();
    settled = [];
    events = [];
  });

  afterEach(async () => {
    await runtime?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('materializes append instructions and skill sources into KIMI_CODE_HOME', async () => {
    const skillDir = await makeSkill(root, 'dispatcher');
    runtime = makeRuntime({
      systemPrompt: { append: ['Dreamux append prompt'] },
      skillSources: [{ name: 'dispatcher', path: skillDir, source: 'dreamux-core' }],
    });

    await runtime.start();

    const home = join(root, 'dispatcher', 'kimi-code-home');
    await expect(readFile(join(home, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'Dreamux append prompt',
    );
    await expect(realpath(join(home, 'skills', 'dispatcher'))).resolves.toBe(
      await realpath(skillDir),
    );
    expect(client.spec?.env['KIMI_CODE_HOME']).toBe(home);
  });

  it('submits completion turns once per source id and settles with text', async () => {
    runtime = makeRuntime();
    await runtime.start();

    const first = await runtime.completionInput({ text: 'hello', sourceId: 'm1' });
    const duplicate = await runtime.completionInput({ text: 'hello again', sourceId: 'm1' });
    await runtime.waitIdle?.();

    expect(first.status).toBe('submitted');
    expect(duplicate).toEqual({ status: 'duplicate' });
    expect(client.prompts).toEqual(['hello']);
    expect(settled).toMatchObject([
      { status: 'completed', result: { text: 'assistant: hello' } },
    ]);
  });

  it('calls channel accepted hooks after dedupe and before prompt submission', async () => {
    runtime = makeRuntime();
    await runtime.start();

    const first = await runtime.channelInput(
      {
        text: 'raw',
        sourceId: 'channel-1',
        source: 'feishu',
        attrs: [['message_id', 'm1']],
        body: 'body',
      },
      {
        onAccepted: () => {
          events.push('accepted');
        },
      },
    );
    const duplicate = await runtime.channelInput({
      text: 'raw',
      sourceId: 'channel-1',
    });
    await runtime.waitIdle?.();

    expect(first.status).toBe('submitted');
    expect(duplicate).toEqual({ status: 'duplicate' });
    expect(events).toEqual(['accepted', 'prompt']);
    expect(client.prompts[0]).toContain('<channel source="feishu"');
  });

  it('replaces a lost checkpoint when ACP resume fails', async () => {
    client.resumeError = new Error('missing session');
    client.nextSessionId = 'new-session';
    runtime = makeRuntime({
      identityCheckpoint: 'old-session',
    });

    await runtime.start();

    expect(runtime.getCheckpoint()).toEqual({ id: 'new-session' });
    expect(runtime.wasCheckpointResumed()).toBe(false);
    expect(state.lost).toEqual([
      {
        lost: { id: 'old-session' },
        replacement: { id: 'new-session' },
        error: 'kimi-code session resume failed: missing session',
      },
    ]);
  });

  function makeRuntime(
    options: {
      systemPrompt?: AgentRuntimeCreateContext['systemPrompt'];
      skillSources?: AgentRuntimeCreateContext['skillSources'];
      identityCheckpoint?: string;
    } = {},
  ): AgentRuntime {
    const provider = createKimiCodeAgentRuntimeProvider({
      clientFactory: fakeClientFactory,
    });
    return provider.createRuntime({
      identity: {
        runtime_id: 'dispatcher',
        checkpoint_id: options.identityCheckpoint ?? null,
      },
      config: readDispatcherKimiCodeConfig({}, 'config.json', 'agents[0].config.'),
      cwd: join(root, 'work'),
      mcpServers: [],
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
      ...(options.skillSources !== undefined
        ? { skillSources: options.skillSources }
        : {}),
      state,
      paths: {
        dispatcherDir: (id) => join(root, id),
        logsDir: () => join(root, 'logs'),
        runtimeSocketDirs: () => [join(root, 'run')],
      },
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
      },
      onTurnSettled: (signal) => settled.push(signal),
    });
  }

  const fakeClientFactory: KimiCodeAcpClientFactory = (
    spec: KimiCodeAcpClientSpec,
  ) => {
    client.spec = spec;
    return client;
  };

  async function makeSkill(base: string, name: string): Promise<string> {
    const dir = join(base, 'source-skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: test\n---\n# ${name}\n`,
    );
    return dir;
  }

  class FakeKimiClient implements KimiCodeAcpClient {
    spec: KimiCodeAcpClientSpec | null = null;
    nextSessionId = 'session-1';
    resumeError: Error | null = null;
    prompts: string[] = [];
    private alive = false;

    async start(): Promise<void> {
      this.alive = true;
    }

    async createSession(_input: KimiCodeAcpSessionRequest): Promise<string> {
      return this.nextSessionId;
    }

    async resumeSession(
      sessionId: string,
      _input: KimiCodeAcpSessionRequest,
    ): Promise<string> {
      if (this.resumeError !== null) throw this.resumeError;
      return sessionId;
    }

    async prompt(
      _sessionId: string,
      text: string,
    ): Promise<KimiCodeAcpPromptResult> {
      events.push('prompt');
      this.prompts.push(text);
      return { stopReason: 'end_turn', text: `assistant: ${text}` };
    }

    async stop(): Promise<void> {
      this.alive = false;
    }

    isAlive(): boolean {
      return this.alive;
    }
  }

  class CapturingState implements AgentRuntimeStateCallbacks {
    checkpoints: { id: string }[] = [];
    lost: Array<{
      lost: { id: string };
      replacement: { id: string };
      error: string;
    }> = [];

    async setStatus(): Promise<void> {
      // Captured tests assert checkpoint/settlement behavior only.
    }

    async setCheckpoint(checkpoint: { id: string }): Promise<void> {
      this.checkpoints.push(checkpoint);
    }

    async recordLostCheckpoint(
      lost: { id: string },
      replacement: { id: string },
      error: string,
    ): Promise<void> {
      this.lost.push({ lost, replacement, error });
      await this.setCheckpoint(replacement);
    }
  }
});
