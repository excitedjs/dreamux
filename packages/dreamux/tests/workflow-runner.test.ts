import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
import { normalizeWorkflowScript } from '../src/service/workflow-service/script-normalizer.js';

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
  it.each([
    [
      'default declaration',
      [
        '/* preserve leading source */',
        "export const meta = { name: 'legacy', description: 'legacy module' };",
        'export default async function run() {',
        '  return args;',
        '}',
        '',
      ].join('\r\n'),
    ],
    [
      'named default export',
      [
        "export const meta = { name: 'legacy', description: 'legacy module' };",
        'async function run() { return args; }',
        'export { run as default };',
        '',
      ].join('\r\n'),
    ],
  ])('returns legacy module source byte-for-byte unchanged for %s', (_kind, source) => {
    expect(normalizeWorkflowScript(source)).toBe(source);
  });

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
            (value, original, index) => {
              if (value === 'third result') throw new Error('item failed');
              return { value, original, index };
            },
            async (value, original, index) => ({
              ...value,
              laterOriginal: original,
              laterIndex: index,
              done: true,
            }),
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
          {
            value: { answer: 1 },
            original: { answer: 1 },
            index: 0,
            laterOriginal: { answer: 1 },
            laterIndex: 0,
            done: true,
          },
          null,
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

  it('runs an ultracode top-level body with literal object metadata', async () => {
    const execution = await runScript(
      `
        export const meta = {
          name: 'ultracode',
          description: 'top-level workflow body',
          whenToUse: 'when compatibility matters',
          phases: [
            'prepare',
            { title: 'finish', detail: 'return the value', model: 'inert' },
          ],
          future: { enabled: true, weight: 2, fallback: null },
        };

        function shape(value) {
          return { value, phase: 'finish' };
        }

        phase('prepare');
        const value = await Promise.resolve(args.value);
        if (value === null) return { early: true };
        phase('finish');
        return shape(value);
      `,
      { value: 42 },
    );

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'completed',
      result: { value: 42, phase: 'finish' },
    });
    expect(execution.messages.filter((message) => message.type === 'emit'))
      .toEqual([
        { type: 'emit', kind: 'phase', message: 'prepare' },
        { type: 'emit', kind: 'phase', message: 'finish' },
      ]);
  });

  it('passes stable original items and zero-based indexes to every pipeline stage', async () => {
    const execution = await runScript(`
      export const meta = { name: 'pipeline-args', description: 'pipeline args' };
      const items = [{ id: 'a' }, { id: 'b' }];
      return pipeline(
        items,
        (previous, original, index) => ({
          firstPrevious: previous.id,
          firstOriginal: original.id,
          firstIndex: index,
        }),
        (previous, original, index) => ({
          ...previous,
          laterOriginal: original.id,
          laterIndex: index,
        }),
      );
    `);

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'completed',
      result: [
        {
          firstPrevious: 'a',
          firstOriginal: 'a',
          firstIndex: 0,
          laterOriginal: 'a',
          laterIndex: 0,
        },
        {
          firstPrevious: 'b',
          firstOriginal: 'b',
          firstIndex: 1,
          laterOriginal: 'b',
          laterIndex: 1,
        },
      ],
    });
  });

  it('rejects direct agent errors while helpers contain them as null', async () => {
    const direct = await runScript(
      `
        export const meta = { name: 'direct-error', description: 'direct error' };
        export default async function run() {
          return agent('direct');
        }
      `,
      undefined,
      (message, child) => {
        if (message.type === 'agent_start') {
          send(child, {
            type: 'agent_result',
            index: message.index,
            error: 'invalid structured output',
          });
        }
      },
    );
    expect(direct.result).toEqual({
      type: 'run_result',
      status: 'failed',
      error: 'invalid structured output',
    });

    const contained = await runScript(
      `
        export const meta = { name: 'contained-error', description: 'contained error' };
        export default async function run() {
          const parallelResult = await parallel([() => agent('parallel')]);
          const pipelineResult = await pipeline(
            ['item'],
            () => agent('pipeline'),
            () => 'must not run',
          );
          return { parallelResult, pipelineResult };
        }
      `,
      undefined,
      (message, child) => {
        if (message.type === 'agent_start') {
          send(child, {
            type: 'agent_result',
            index: message.index,
            error: 'invalid structured output',
          });
        }
      },
    );
    expect(contained.result).toEqual({
      type: 'run_result',
      status: 'completed',
      result: {
        parallelResult: [null],
        pipelineResult: [null],
      },
    });
  });

  it('accepts 4096 helper inputs and rejects 4097 before invoking work', async () => {
    const execution = await runScript(`
      export const meta = { name: 'helper-limits', description: 'helper limits' };
      let thunkCalls = 0;
      let stageCalls = 0;
      let parallelError = null;
      let pipelineError = null;
      try {
        await parallel(Array.from({ length: 4097 }, () => () => {
          thunkCalls += 1;
          return true;
        }));
      } catch (error) {
        parallelError = error.message;
      }
      try {
        await pipeline(Array.from({ length: 4097 }, (_, index) => index), () => {
          stageCalls += 1;
          return true;
        });
      } catch (error) {
        pipelineError = error.message;
      }
      const parallelAccepted = await parallel(
        Array.from({ length: 4096 }, (_, index) => () => index),
      );
      const pipelineAccepted = await pipeline(
        Array.from({ length: 4096 }, (_, index) => index),
        (value) => value,
      );
      return {
        thunkCalls,
        stageCalls,
        parallelError,
        pipelineError,
        parallelAccepted: parallelAccepted.length,
        pipelineAccepted: pipelineAccepted.length,
      };
    `);

    expect(execution.result).toEqual({
      type: 'run_result',
      status: 'completed',
      result: {
        thunkCalls: 0,
        stageCalls: 0,
        parallelError: 'parallel supports at most 4096 functions',
        pipelineError: 'pipeline supports at most 4096 items',
        parallelAccepted: 4096,
        pipelineAccepted: 4096,
      },
    });
  });

  it.each([
    [
      `export const meta = {
        name: 'bad',
        description: 'bad',
        phases: [{ title: 1 }],
      };
      agent('must not start');`,
      'workflow meta phases must contain strings or objects with string title',
    ],
    [
      `export const meta = {
        name: 'bad',
        description: 'bad',
        whenToUse: true,
        phases: ['valid'],
      };
      agent('must not start');`,
      'workflow meta whenToUse must be a string',
    ],
    [
      `const description = 'dynamic';
      export const meta = { name: 'bad', description };
      agent('must not start');`,
      'workflow meta must be a recursively plain literal tree',
    ],
    [
      `export const meta = { name: 'bad', description: 'bad' };
      export const extra = true;
      agent('must not start');`,
      'ultracode workflow scripts may only export const meta',
    ],
    [
      `export const meta = { name: 'bad', description: 'bad' };
      export * as default from './other.mjs';
      agent('must not start');`,
      'ultracode workflow scripts may only export const meta',
    ],
  ])(
    'rejects invalid ultracode metadata or exports before agents start',
    async (script, error) => {
      const execution = await runScript(script);

      expect(execution.result).toEqual({
        type: 'run_result',
        status: 'failed',
        error,
      });
      expect(execution.messages.some((message) => message.type === 'agent_start'))
        .toBe(false);
    },
  );

  it.each([
    [
      'legacy module',
      `export const meta = {
        name: 'legacy-invalid',
        description: 'legacy metadata',
        whenToUse: true,
        phases: 'invalid',
      };
      export default async function run() {
        return agent('must not start');
      }`,
    ],
    [
      'ultracode',
      `export const meta = {
        name: 'ultracode-invalid',
        description: 'ultracode metadata',
        whenToUse: true,
        phases: 'invalid',
      };
      return agent('must not start');`,
    ],
  ])(
    'rejects malformed %s metadata before agents start',
    async (_dialect, script) => {
      const execution = await runScript(script);

      expect(execution.result).toEqual({
        type: 'run_result',
        status: 'failed',
        error:
          'workflow meta phases must contain strings or objects with string title',
      });
      expect(execution.messages.some((message) => message.type === 'agent_start'))
        .toBe(false);
    },
  );

  it('executes both issue #318 acceptance fixtures unmodified', async () => {
    const deepResearch = await readFile(
      join(PACKAGE_ROOT, 'tests', 'fixtures', 'workflows', 'deep-research-max.mjs'),
      'utf8',
    );
    const deepExecution = await runScript(
      deepResearch,
      { question: 'How does fixture compatibility work?', angles: 1, maxSources: 1 },
      (message, child) => {
        if (message.type !== 'agent_start') return;
        let result: unknown;
        if (message.prompt.startsWith('Decompose this research question')) {
          result = {
            angles: [{ name: 'compatibility', queries: ['workflow parity'] }],
          };
        } else if (message.prompt.startsWith('Research angle')) {
          result = {
            sources: [{
              url: 'https://example.com/source',
              title: 'Example source',
              why: 'fixture',
            }],
          };
        } else if (message.prompt.startsWith('Fetch ')) {
          result = {
            claims: [{
              text: 'The fixture executed.',
              quote: 'The fixture executed.',
            }],
          };
        } else if (message.prompt.startsWith('You are skeptic')) {
          result = { refuted: false, reasoning: 'synthetic verification' };
        } else if (message.prompt.startsWith('Write a research report')) {
          result = '# Synthetic report';
        } else if (message.prompt.startsWith('Question:')) {
          result = { gaps: [] };
        } else {
          throw new Error(`unexpected deep-research prompt: ${message.prompt}`);
        }
        send(child, { type: 'agent_result', index: message.index, result });
      },
    );
    expect(deepExecution.result).toEqual({
      type: 'run_result',
      status: 'completed',
      result: {
        question: 'How does fixture compatibility work?',
        report: '# Synthetic report',
        claimCount: 1,
        gaps: [],
      },
    });

    const codeReview = await readFile(
      join(PACKAGE_ROOT, 'tests', 'fixtures', 'workflows', 'code-review-max.mjs'),
      'utf8',
    );
    let emittedFinding = false;
    const reviewExecution = await runScript(
      codeReview,
      { target: 'HEAD~1..HEAD', maxRounds: 1 },
      (message, child) => {
        if (message.type !== 'agent_start') return;
        let result: unknown;
        if (message.prompt.startsWith('Inspect ')) {
          result = { eligible: true, reason: 'synthetic fixture run' };
        } else if (message.prompt.startsWith('For ')) {
          result = { paths: [] };
        } else if (message.prompt.startsWith('View ')) {
          result = 'Synthetic change summary';
        } else if (message.prompt.startsWith('Code review ')) {
          result = {
            findings: emittedFinding
              ? []
              : [{
                  file: 'src/example.ts',
                  line: 1,
                  title: 'Synthetic issue',
                  detail: 'Fixture finding',
                  reason: 'bug',
                }],
          };
          emittedFinding = true;
        } else if (message.prompt.startsWith('Confidence-score')) {
          result = { score: 100, reasoning: 'synthetic verification' };
        } else if (message.prompt.startsWith('Write the final code review')) {
          result = '### Code review\nFound 1 issue.';
        } else {
          throw new Error(`unexpected code-review prompt: ${message.prompt}`);
        }
        send(child, { type: 'agent_result', index: message.index, result });
      },
    );
    expect(reviewExecution.result).toMatchObject({
      type: 'run_result',
      status: 'completed',
      result: {
        issues: [{
          file: 'src/example.ts',
          confidence: 100,
          votes: 3,
          index: 0,
        }],
        report: '### Code review\nFound 1 issue.',
      },
    });
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

  it('does not spawn agents from top-level code before meta is validated', async () => {
    const execution = await runScript(`
      agent('spawn before meta validation');
      export const meta = { name: 'early-agent', description: 'early agent' };
      export default async function run() { return null; }
    `);

    expect(execution.result).toMatchObject({
      type: 'run_result',
      status: 'failed',
    });
    expect(
      execution.messages.some((m) => m.type === 'agent_start'),
    ).toBe(false);
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
