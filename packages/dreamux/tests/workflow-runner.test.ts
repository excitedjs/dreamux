import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  WorkflowAgentStartMessage,
  WorkflowRunnerChildMessage,
  WorkflowRunnerParentMessage,
  WorkflowRunResultMessage,
} from '../src/service/workflow-service/protocol.js';
import { ForkedWorkflowRunner } from '../src/service/workflow-service/runner-process.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_PATH = join(
  PACKAGE_ROOT,
  'dist',
  'service',
  'workflow-service',
  'runner.js',
);
const liveChildren = new Set<ChildProcess>();

beforeAll(() => {
  if (!existsSync(RUNNER_PATH)) {
    throw new Error(
      `dist artefact ${RUNNER_PATH} is missing — run 'rush build' before these tests.`,
    );
  }
});

afterEach(async () => {
  await Promise.all(
    [...liveChildren].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await waitForExit(child).catch(() => undefined);
    }),
  );
  liveChildren.clear();
});

describe('workflow runner', () => {
  it('runs the workflow API through the child IPC channel', async () => {
    const agentStarts: WorkflowAgentStartMessage[] = [];
    const execution = await runScript(
      `
        export const meta = {
          name: 'research',
          description: 'exercise the workflow runner',
          phases: ['collect', 'shape'],
        };

        export default async function run() {
          phase('collect');
          log('topic:' + args.topic);
          const collected = await parallel([
            () => agent('first:' + args.topic, {
              label: 'first',
              phase: 'collect',
              schema: { type: 'object' },
              agentType: 'codex',
              intent: 'research',
              identity: 'focused researcher',
            }),
            () => agent('expected failure'),
            () => agent('third'),
            () => { throw new Error('thunk failure'); },
          ]);
          phase('shape');
          const piped = await pipeline(
            collected.filter(Boolean),
            (value) => ({ value }),
            async (value) => ({ ...value, done: true }),
          );
          return {
            collected,
            piped,
            epoch: new Date(0).toISOString(),
            rounded: Math.round(1.5),
            hidden: [
              typeof process,
              typeof require,
              typeof Buffer,
              typeof fetch,
              typeof setTimeout,
              typeof console,
            ],
          };
        }
      `,
      { topic: 'ipc' },
      (message, child) => {
        if (message.type !== 'agent_start') return;
        agentStarts.push(message);
        if (message.index === 0) {
          send(child, {
            type: 'agent_result',
            index: message.index,
            result: { answer: 1 },
          });
        } else if (message.index === 1) {
          send(child, {
            type: 'agent_result',
            index: message.index,
            error: 'runtime rejected outputSchema',
          });
        } else {
          send(child, {
            type: 'agent_result',
            index: message.index,
            result: 'third result',
          });
        }
      },
    );

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'completed',
      result: {
        collected: [{ answer: 1 }, null, 'third result', null],
        piped: [
          { value: { answer: 1 }, done: true },
          { value: 'third result', done: true },
        ],
        epoch: '1970-01-01T00:00:00.000Z',
        rounded: 2,
        hidden: [
          'undefined',
          'undefined',
          'undefined',
          'undefined',
          'undefined',
          'undefined',
        ],
      },
    });
    expect(execution.messages.slice(0, 2)).toEqual([
      { type: 'emit', kind: 'phase', message: 'collect' },
      { type: 'emit', kind: 'log', message: 'topic:ipc' },
    ]);
    expect(
      execution.messages.filter((message) => message.type === 'emit'),
    ).toContainEqual({ type: 'emit', kind: 'phase', message: 'shape' });
    expect(agentStarts).toHaveLength(3);
    expect(agentStarts[0]).toEqual({
      type: 'agent_start',
      index: 0,
      prompt: 'first:ipc',
      options: {
        label: 'first',
        phase: 'collect',
        schema: { type: 'object' },
        agentType: 'codex',
        intent: 'research',
        identity: 'focused researcher',
      },
    });
    expect(execution.exit).toEqual({ code: 0, signal: null });
  });

  it.each([
    ['Date.now()', 'Date.now() is disabled in workflows'],
    ['new Date()', 'new Date() without arguments is disabled in workflows'],
    ['Math.random()', 'Math.random() is disabled in workflows'],
  ])('fails loudly for nondeterministic expression %s', async (expression, error) => {
    const execution = await runScript(`
      export const meta = { name: 'invalid', description: 'invalid' };
      export default async function run() { return ${expression}; }
    `);

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'failed',
      error,
    });
  });

  it.each([
    [
      "import fs from 'node:fs';",
      'workflow imports are disabled: node:fs',
    ],
    [
      '',
      'workflow imports are disabled: node:fs',
    ],
  ])('rejects static and dynamic imports', async (staticImport, error) => {
    const execution = await runScript(`
      ${staticImport}
      export const meta = { name: 'imports', description: 'imports' };
      export default async function run() {
        ${staticImport === '' ? "return import('node:fs');" : 'return fs;'}
      }
    `);

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'failed',
      error,
    });
  });

  it('rejects an in-flight agent call when aborted', async () => {
    const execution = await runScript(
      `
        export const meta = { name: 'abort', description: 'abort' };
        export default async function run() { return agent('wait'); }
      `,
      undefined,
      (message, child) => {
        if (message.type === 'agent_start') send(child, { type: 'abort' });
      },
    );

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'failed',
      error: 'workflow aborted',
    });
  });

  it('force-stops a workflow that blocks the VM event loop', async () => {
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolveReadyPromise) => {
      resolveReady = resolveReadyPromise;
    });
    let resolveExit:
      | ((exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        }) => void)
      | undefined;
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExitPromise) => {
      resolveExit = resolveExitPromise;
    });
    const errors: Error[] = [];
    const runner = new ForkedWorkflowRunner(RUNNER_PATH, {
      onMessage(message) {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'emit' &&
          'message' in message &&
          message.message === 'busy-loop-ready'
        ) {
          resolveReady?.();
        }
      },
      onExit(exit) {
        resolveExit?.(exit);
      },
      onError(error) {
        errors.push(error);
      },
    });

    try {
      await withTimeout(runner.start(), 2_000, 'workflow runner start');
      await withTimeout(
        runner.send({
          type: 'run_start',
          script: `
            export const meta = { name: 'busy', description: 'busy loop' };
            export default async function run(){ while(true){} }
            log('busy-loop-ready');
          `,
          args: undefined,
        }),
        2_000,
        'workflow runner run_start',
      );
      await withTimeout(ready, 2_000, 'workflow runner busy-loop ready');

      await withTimeout(runner.stop(), 2_000, 'workflow runner forced stop');
      const exit = await withTimeout(
        exited,
        1_000,
        'workflow runner forced exit',
      );

      expect(errors).toEqual([]);
      expect(exit.code).toBeNull();
      expect(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL').toBe(true);
    } finally {
      await withTimeout(runner.stop(), 2_000, 'workflow runner cleanup').catch(
        () => undefined,
      );
    }
  });
});

interface RunnerExecution {
  result: WorkflowRunResultMessage;
  messages: WorkflowRunnerChildMessage[];
  exit: { code: number | null; signal: NodeJS.Signals | null };
}

async function runScript(
  script: string,
  args: unknown = undefined,
  onMessage?: (message: WorkflowRunnerChildMessage, child: ChildProcess) => void,
): Promise<RunnerExecution> {
  const child = fork(RUNNER_PATH, [], {
    execArgv: ['--experimental-vm-modules'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  liveChildren.add(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const messages: WorkflowRunnerChildMessage[] = [];
  const result = await withTimeout(
    new Promise<WorkflowRunResultMessage>((resolveResult, rejectResult) => {
      child.on('message', (value: unknown) => {
        const message = value as WorkflowRunnerChildMessage;
        messages.push(message);
        try {
          onMessage?.(message, child);
        } catch (error) {
          rejectResult(error);
          return;
        }
        if (message.type === 'run_result') resolveResult(message);
      });
      child.once('error', rejectResult);
      child.once('exit', (code, signal) => {
        rejectResult(
          new Error(
            `workflow runner exited before run_result (${String(code)}/${String(signal)}): ${stderr}`,
          ),
        );
      });
      send(child, { type: 'run_start', script, args });
    }),
    5_000,
    'workflow runner result',
  );
  const exit = await withTimeout(waitForExit(child), 2_000, 'workflow runner exit');
  liveChildren.delete(child);
  return { result, messages, exit };
}

function send(child: ChildProcess, message: WorkflowRunnerParentMessage): void {
  child.send(message);
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
