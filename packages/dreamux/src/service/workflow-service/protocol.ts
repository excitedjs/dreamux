import type { JsonSchema } from '@excitedjs/dreamux-types';
import { isPlainObject } from '@excitedjs/dreamux-utils';

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  /** Carried verbatim to the runtime; the child sends it as JSON. */
  schema?: JsonSchema;
  agentType?: string;
  intent?: string;
  identity?: string;
}

export interface WorkflowRunStartMessage {
  type: 'run_start';
  script: string;
  args: unknown;
}

export interface WorkflowAgentResultMessage {
  type: 'agent_result';
  index: number;
  result?: unknown;
  error?: string | undefined;
}

export interface WorkflowAbortMessage {
  type: 'abort';
}

export type WorkflowRunnerParentMessage =
  WorkflowRunStartMessage | WorkflowAgentResultMessage | WorkflowAbortMessage;

export interface WorkflowAgentStartMessage {
  type: 'agent_start';
  index: number;
  prompt: string;
  options: WorkflowAgentOptions;
}

export interface WorkflowEmitMessage {
  type: 'emit';
  kind: 'phase' | 'log';
  message: string;
}

export type WorkflowRunResultMessage =
  | {
      type: 'run_result';
      status: 'completed';
      result?: unknown;
    }
  | {
      type: 'run_result';
      status: 'failed';
      error: string;
    };

export type WorkflowRunnerChildMessage =
  WorkflowAgentStartMessage | WorkflowEmitMessage | WorkflowRunResultMessage;

export function normalizeAgentOptions(
  options: WorkflowAgentOptions,
): WorkflowAgentOptions {
  const normalized: WorkflowAgentOptions = {};
  for (const key of [
    'label',
    'phase',
    'agentType',
    'intent',
    'identity',
  ] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new Error(`workflow agent option ${key} must be a string`);
    }
    normalized[key] = value;
  }
  if (options.schema !== undefined) {
    if (!isPlainObject(options.schema)) {
      throw new Error('workflow agent option schema must be an object');
    }
    normalized.schema = options.schema;
  }
  return normalized;
}

/** The child decoder: validates a message the parent process receives from
 * the forked child. */
export function isWorkflowRunnerChildMessage(
  message: unknown,
): message is WorkflowRunnerChildMessage {
  if (!isPlainObject(message) || typeof message.type !== 'string') return false;
  switch (message.type) {
    case 'agent_start':
      return (
        Number.isSafeInteger(message.index) &&
        typeof message.prompt === 'string' &&
        isPlainObject(message.options)
      );
    case 'emit':
      return (
        (message.kind === 'phase' || message.kind === 'log') &&
        typeof message.message === 'string'
      );
    case 'run_result':
      return (
        message.status === 'completed' ||
        (message.status === 'failed' && typeof message.error === 'string')
      );
    default:
      return false;
  }
}

/** The parent decoder: validates a message the child process receives from
 * the parent. */
export function parseParentMessage(
  value: unknown,
): WorkflowRunnerParentMessage | null {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;

  if (value.type === 'run_start' && typeof value.script === 'string') {
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
