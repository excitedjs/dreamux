/**
 * The Workflow namespace's canonical Commands.
 *
 * A Workflow run belongs to the addressed dispatcher's own collection. There is
 * no caller-kind selector: a TeamLeader's Workflow surface is its own MCP
 * delegate, bound to the Team that delegate was built for, so nothing a
 * model sends can select a scope here. Run admission, concurrency, and record
 * semantics stay inside the workflow service.
 *
 * The run-request codec and the record projection live with the service's own
 * types, and a failure states its own reason and next step where it is raised.
 * The TeamMate MCP delegate that advertises the Workflow tools reads the same
 * helpers; neither adapter reads the other.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../../command/registry.js';
import { mustDispatcher, type CoreCommandHost } from '../../command/host.js';
import { commandPayload } from '../../command/payload.js';
import {
  ANY,
  INTEGER,
  NON_EMPTY_STRING,
  OBJECT,
  STRING,
  objectSchema,
} from '../../command/schema.js';
import {
  workflowRunIdParam,
  workflowRunInput,
  workflowRunResult,
  type WorkflowListResult,
  type WorkflowRunAccepted,
  type WorkflowRunInput,
  type WorkflowRunRecord,
  type WorkflowStopResult,
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
      return { request: workflowRunInput(commandPayload(payload)) };
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
      return workflowRunResult(
        await mustDispatcher(host, context).workflows.status({
          run_id: input.runId,
        }),
      );
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
      const result = await mustDispatcher(host, context).workflows.list();
      return { runs: result.runs.map(workflowRunResult) };
    },
  };

  return [run, status, stop, list] as unknown as readonly AnyCoreCommand[];
}

function runIdInput(payload: Parameters<typeof commandPayload>[0]): WorkflowRunIdInput {
  return { runId: workflowRunIdParam(commandPayload(payload)) };
}
