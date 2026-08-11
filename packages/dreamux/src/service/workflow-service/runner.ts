import {
  createContext,
  Script,
  SourceTextModule,
  type Context,
} from 'node:vm';

import type {
  WorkflowAgentOptions,
  WorkflowAgentResultMessage,
  WorkflowRunnerChildMessage,
  WorkflowRunnerParentMessage,
} from './protocol.js';
import { isRecord } from './run-support.js';
import { compileWorkflowScript } from './script-compiler.js';

interface PendingAgent {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_HELPER_ITEMS = 4096;

const pendingAgents = new Map<number, PendingAgent>();
let nextAgentIndex = 0;
let started = false;
let aborted = false;
let finished = false;

process.on('message', (message: unknown) => {
  const parentMessage = parseParentMessage(message);
  if (parentMessage === null) return;

  switch (parentMessage.type) {
    case 'run_start':
      if (started || finished) return;
      started = true;
      void runWorkflow(parentMessage.script, parentMessage.args);
      return;
    case 'agent_result':
      settleAgent(parentMessage);
      return;
    case 'abort':
      abortWorkflow();
      return;
  }
});

process.on('disconnect', () => {
  abortWorkflow();
});

async function runWorkflow(script: string, args: unknown): Promise<void> {
  try {
    if (aborted) throw new Error('workflow aborted');

    const compiledSource = compileWorkflowScript(script);
    const context = createWorkflowContext(args);
    await installDeterministicIntrinsics(context);
    // Metadata is valid; now expose the orchestration primitives and run the
    // submitted top-level body through one private async closure.
    installWorkflowPrimitives(context);
    const compiled = new Script(compiledSource, {
      filename: 'dreamux-workflow.mjs',
      importModuleDynamically: async (specifier) => {
        throw new Error(`workflow imports are disabled: ${specifier}`);
      },
    });
    const result: unknown = await compiled.runInContext(context);
    if (aborted) throw new Error('workflow aborted');
    if (pendingAgents.size > 0) {
      throw new Error('workflow completed with unawaited agent calls');
    }
    await finish({ type: 'run_result', status: 'completed', result });
  } catch (error) {
    await finish({
      type: 'run_result',
      status: 'failed',
      error: errorMessage(error),
    });
  }
}

function createWorkflowContext(args: unknown): Context {
  return createContext({
    args,
    phase: (message: unknown): void => emit('phase', message),
    log: (message: unknown): void => emit('log', message),
    console: undefined,
  });
}

/** Expose orchestration primitives after metadata validation succeeds. */
function installWorkflowPrimitives(context: Context): void {
  const sandbox = context as Context & {
    agent?: typeof startAgent;
    parallel?: typeof parallel;
    pipeline?: typeof pipeline;
  };
  sandbox.agent = startAgent;
  sandbox.parallel = parallel;
  sandbox.pipeline = pipeline;
}

async function installDeterministicIntrinsics(context: Context): Promise<void> {
  const bootstrap = new SourceTextModule(
    `
      const NativeDate = Date;
      class WorkflowDate extends NativeDate {
        constructor(...values) {
          if (values.length === 0) {
            throw new Error('new Date() without arguments is disabled in workflows');
          }
          super(...values);
        }

        static now() {
          throw new Error('Date.now() is disabled in workflows');
        }
      }

      Object.defineProperty(globalThis, 'Date', {
        value: WorkflowDate,
        writable: false,
        configurable: false,
      });
      Object.defineProperty(Math, 'random', {
        value() {
          throw new Error('Math.random() is disabled in workflows');
        },
        writable: false,
        configurable: false,
      });
    `,
    { context, identifier: 'dreamux-workflow-bootstrap.mjs' },
  );
  await bootstrap.link(() => {
    throw new Error('workflow bootstrap imports are disabled');
  });
  await bootstrap.evaluate();
}

async function startAgent(
  prompt: unknown,
  options: WorkflowAgentOptions = {},
): Promise<unknown> {
  if (aborted) throw new Error('workflow aborted');
  if (typeof prompt !== 'string') {
    throw new Error('agent prompt must be a string');
  }
  if (!isRecord(options)) {
    throw new Error('agent options must be an object');
  }

  const index = nextAgentIndex;
  nextAgentIndex += 1;
  const result = new Promise<unknown>((resolve, reject) => {
    pendingAgents.set(index, { resolve, reject });
  });

  try {
    send({ type: 'agent_start', index, prompt, options });
  } catch (error) {
    pendingAgents.delete(index);
    throw error;
  }
  return result;
}

async function parallel(thunks: unknown): Promise<unknown[]> {
  if (!Array.isArray(thunks)) {
    throw new Error('parallel expects an array of functions');
  }
  if (thunks.length > MAX_HELPER_ITEMS) {
    throw new Error(`parallel supports at most ${MAX_HELPER_ITEMS} functions`);
  }
  return Promise.all(
    thunks.map(async (thunk: unknown) => {
      try {
        if (typeof thunk !== 'function') {
          throw new Error('parallel expects an array of functions');
        }
        return await Reflect.apply(thunk, undefined, []);
      } catch {
        return null;
      }
    }),
  );
}

async function pipeline(
  items: unknown,
  ...stages: unknown[]
): Promise<unknown[]> {
  if (!Array.isArray(items)) {
    throw new Error('pipeline expects an array of items');
  }
  if (items.length > MAX_HELPER_ITEMS) {
    throw new Error(`pipeline supports at most ${MAX_HELPER_ITEMS} items`);
  }
  if (stages.some((stage) => typeof stage !== 'function')) {
    throw new Error('pipeline stages must be functions');
  }

  return Promise.all(
    items.map(async (item: unknown, index: number) => {
      try {
        let value = item;
        for (const stage of stages) {
          value = await Reflect.apply(
            stage as (...args: unknown[]) => unknown,
            undefined,
            [value, item, index],
          );
        }
        return value;
      } catch {
        return null;
      }
    }),
  );
}

function emit(kind: 'phase' | 'log', message: unknown): void {
  if (typeof message !== 'string') {
    throw new Error(`${kind} message must be a string`);
  }
  send({ type: 'emit', kind, message });
}

function settleAgent(message: WorkflowAgentResultMessage): void {
  const pending = pendingAgents.get(message.index);
  if (pending === undefined) return;
  pendingAgents.delete(message.index);

  if (message.error !== undefined) {
    pending.reject(new Error(message.error));
    return;
  }
  pending.resolve(message.result);
}

function abortWorkflow(): void {
  if (aborted) return;
  aborted = true;
  for (const pending of pendingAgents.values()) {
    pending.reject(new Error('workflow aborted'));
  }
  pendingAgents.clear();
}

async function finish(message: WorkflowRunnerChildMessage): Promise<void> {
  if (finished) return;
  finished = true;

  try {
    await sendAndFlush(message);
  } catch (error) {
    if (message.type === 'run_result' && message.status === 'completed') {
      try {
        await sendAndFlush({
          type: 'run_result',
          status: 'failed',
          error: `workflow result could not be sent: ${errorMessage(error)}`,
        });
      } catch {
        process.exitCode = 1;
      }
    } else {
      process.exitCode = 1;
    }
  } finally {
    if (process.connected) process.disconnect();
  }
}

function send(message: WorkflowRunnerChildMessage): void {
  if (process.send === undefined || !process.connected) {
    throw new Error('workflow runner IPC channel is unavailable');
  }
  process.send(message);
}

async function sendAndFlush(message: WorkflowRunnerChildMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error('workflow runner IPC channel is unavailable'));
      return;
    }
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function parseParentMessage(value: unknown): WorkflowRunnerParentMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  if (
    value.type === 'run_start' &&
    typeof value.script === 'string'
  ) {
    return {
      type: 'run_start',
      script: value.script,
      args: value.args,
    };
  }
  if (
    value.type === 'agent_result' &&
    Number.isSafeInteger(value.index) &&
    (value.error === undefined || typeof value.error === 'string')
  ) {
    return {
      type: 'agent_result',
      index: value.index as number,
      result: value.result,
      error: value.error,
    };
  }
  if (value.type === 'abort') return { type: 'abort' };
  return null;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}
