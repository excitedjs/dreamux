/**
 * The Workflow namespace's canonical Commands.
 *
 * A Workflow run belongs to the addressed dispatcher's own collection. There is
 * no caller-kind selector: a TeamLeader's Workflow surface is its own MCP
 * delegate, bound to the Team that delegate was built for, so nothing a
 * model sends can select a scope here. Run admission, concurrency, and record
 * semantics stay inside the workflow service.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { mustDispatcher, type CoreCommandHost } from '../../command/host.js';
import { ValidationError, errorMessage } from '../../command/errors.js';
import {
  commandPayload,
  mustNonEmptyString,
  optionalNonBlankString,
} from '../../command/payload.js';
import {
  ANY,
  INTEGER,
  NON_EMPTY_STRING,
  OBJECT,
  STRING,
  objectSchema,
} from '../../command/schema.js';
import { parseWorkflowMaxConcurrency } from './limits.js';
import type {
  WorkflowListResult,
  WorkflowRunAccepted,
  WorkflowRunInput,
  WorkflowRunRecord,
  WorkflowStopResult,
} from './types.js';

interface WorkflowRunCommandInput {
  request: WorkflowRunInput;
}

interface WorkflowRunIdInput {
  runId: string;
}

export function workflowCommands(
  host: CoreCommandHost,
): readonly AnyCoreCommand[] {
  const run: CoreCommandDefinition<
    'workflow.run',
    WorkflowRunCommandInput,
    WorkflowRunAccepted
  > = {
    name: 'workflow.run',
    version: 1,
    input: objectSchema({
      script: NON_EMPTY_STRING,
      scriptPath: NON_EMPTY_STRING,
      args: ANY,
      max_concurrency: INTEGER,
    }),
    output: objectSchema({ run_id: STRING }, ['run_id']),
    parse(payload) {
      const params = commandPayload(payload);
      const rawMaxConcurrency = params['max_concurrency'];
      let maxConcurrency: number;
      try {
        maxConcurrency = parseWorkflowMaxConcurrency(rawMaxConcurrency);
      } catch (error) {
        throw new ValidationError(errorMessage(error));
      }
      const script = optionalNonBlankString(params, 'script');
      const scriptPath = optionalNonBlankString(params, 'scriptPath');
      if (script === null && scriptPath === null) {
        throw new ValidationError('workflow.run requires either script or scriptPath');
      }
      return {
        request: {
          ...(script !== null ? { script } : {}),
          ...(scriptPath !== null ? { scriptPath } : {}),
          ...(Object.hasOwn(params, 'args') ? { args: params['args'] } : {}),
          ...(rawMaxConcurrency !== undefined && rawMaxConcurrency !== null
            ? { max_concurrency: maxConcurrency }
            : {}),
        },
      };
    },
    async execute(context, input) {
      return mustDispatcher(host, context).workflows.run(input.request);
    },
  };

  const status: CoreCommandDefinition<
    'workflow.status',
    WorkflowRunIdInput,
    WorkflowRunRecord
  > = {
    name: 'workflow.status',
    version: 1,
    input: objectSchema({ run_id: NON_EMPTY_STRING }, ['run_id']),
    output: OBJECT,
    parse: (payload) => runIdInput(payload),
    async execute(context, input) {
      return mustDispatcher(host, context).workflows.status({
        run_id: input.runId,
      });
    },
  };

  const stop: CoreCommandDefinition<
    'workflow.stop',
    WorkflowRunIdInput,
    WorkflowStopResult
  > = {
    name: 'workflow.stop',
    version: 1,
    input: objectSchema({ run_id: NON_EMPTY_STRING }, ['run_id']),
    output: OBJECT,
    parse: (payload) => runIdInput(payload),
    async execute(context, input) {
      return mustDispatcher(host, context).workflows.stop({
        run_id: input.runId,
      });
    },
  };

  const list: CoreCommandDefinition<
    'workflow.list',
    Record<string, never>,
    WorkflowListResult
  > = {
    name: 'workflow.list',
    version: 1,
    input: objectSchema({}),
    output: OBJECT,
    parse: () => ({}),
    async execute(context) {
      return mustDispatcher(host, context).workflows.list();
    },
  };

  return [run, status, stop, list] as unknown as readonly AnyCoreCommand[];
}

function runIdInput(payload: Parameters<typeof commandPayload>[0]): WorkflowRunIdInput {
  return { runId: mustNonEmptyString(commandPayload(payload), 'run_id') };
}
