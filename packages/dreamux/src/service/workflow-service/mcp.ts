/**
 * The Workflow tools advertised on the TeamMate MCP server.
 *
 * A workflow run belongs to whichever caller started it — the Dispatcher Agent
 * or a Team's TeamLeader — and both already resolve the same {@link WorkflowOps}
 * surface per call. Workflow has no MCP server of its own: it is composed onto
 * the TeamMate server's catalog and call dispatch, so this module owns only the
 * tool descriptors and the handlers that read a request and project a result,
 * in the same `{descriptor, execute}` tool-record shape every domain's `mcp.ts`
 * uses.
 *
 * The request readers and the result projection live in `requests.ts`, shared
 * unchanged with `commands.ts`.
 */
import type { JsonSchema } from '@excitedjs/dreamux-types';

import type { CommandPayload } from '../../command/payload.js';
import { arrayOf, objectSchema } from '../../command/schema.js';
import { WORKFLOW_RUN_SUCCESS_REMINDER } from '../mcp/dispatch-reminders.js';
import type { McpToolSuccess } from '../mcp/projection.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  tool,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import type { WorkflowOps } from './index.js';
import {
  DEFAULT_WORKFLOW_MAX_CONCURRENCY,
  MAX_WORKFLOW_MAX_CONCURRENCY,
  MIN_WORKFLOW_MAX_CONCURRENCY,
} from './limits.js';
import {
  workflowRunIdParam,
  workflowRunInput,
  workflowRunResult,
} from './requests.js';

/**
 * One Workflow tool, paired with the handler that serves it against a
 * resolved {@link WorkflowOps}.
 */
interface WorkflowMcpToolRecord {
  readonly descriptor: McpToolDescriptor;
  readonly execute: (
    workflows: WorkflowOps,
    args: CommandPayload,
  ) => Promise<McpToolSuccess>;
}

/**
 * The four Workflow tools (`workflow_run`/`workflow_status`/`workflow_stop`/
 * `workflow_list`), for the TeamMate MCP delegate to fold into its own catalog
 * and call dispatch.
 */
export const WORKFLOW_TOOL_RECORDS: WorkflowMcpToolRecord[] = [
  {
    descriptor: tool(
      'workflow_run',
      'The bundled `dynamic-workflow` skill covers the script API. Start a deterministic multi-agent workflow from an inline module script (`script`) or a local file path (`scriptPath`) and return { run_id } immediately; Dreamux pushes one terminal completion when the run finishes.',
      {
        script: {
          type: 'string',
          minLength: 1,
          description: 'Inline workflow module source.',
        },
        scriptPath: {
          type: 'string',
          minLength: 1,
          description:
            'Path to a workflow module file readable by the Dreamux server.',
        },
        args: {
          type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
          description:
            'Optional direct JSON value available as the script-global args. ' +
            'Pass objects and arrays directly; do not JSON.stringify them.',
        },
        max_concurrency: {
          type: 'integer',
          minimum: MIN_WORKFLOW_MAX_CONCURRENCY,
          maximum: MAX_WORKFLOW_MAX_CONCURRENCY,
          description:
            'Agents allowed to run at once; default ' +
            `${DEFAULT_WORKFLOW_MAX_CONCURRENCY}, range ` +
            `${MIN_WORKFLOW_MAX_CONCURRENCY}..${MAX_WORKFLOW_MAX_CONCURRENCY}.`,
        },
      },
      [],
      {
        title: 'Run a workflow',
        output: objectSchema({ run_id: { type: 'string' } }, ['run_id']),
        annotations: MUTATING_ANNOTATIONS,
        inputConstraints: {
          anyOf: [{ required: ['script'] }, { required: ['scriptPath'] }],
        },
      },
    ),
    execute: workflowRun,
  },
  {
    descriptor: tool(
      'workflow_status',
      'Read phase, agent progress, concrete TeamMate names, and terminal result for one workflow run.',
      {
        run_id: {
          ...workflowRunIdSchema(),
          description: 'The run_id returned by workflow_run.',
        },
      },
      ['run_id'],
      {
        title: 'Read workflow status',
        output: workflowRunSchema(),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    execute: workflowStatus,
  },
  {
    descriptor: tool(
      'workflow_stop',
      'Stop one running workflow and return its resulting status.',
      {
        run_id: {
          ...workflowRunIdSchema(),
          description: 'The run_id returned by workflow_run.',
        },
      },
      ['run_id'],
      {
        title: 'Stop a workflow',
        output: objectSchema(
          { run_id: { type: 'string' }, status: { type: 'string' } },
          ['run_id', 'status'],
        ),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
    execute: workflowStop,
  },
  {
    descriptor: tool(
      'workflow_list',
      'List workflow runs in the current dispatcher or TeamLeader caller scope.',
      {},
      [],
      {
        title: 'List workflows',
        output: objectSchema({ runs: arrayOf(workflowRunSchema()) }, [
          'runs',
        ]),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    execute: workflowList,
  },
];

async function workflowRun(
  workflows: WorkflowOps,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const accepted = await workflows.run(workflowRunInput(args));
  return {
    structured: { run_id: accepted.run_id },
    text: WORKFLOW_RUN_SUCCESS_REMINDER,
  };
}

async function workflowStatus(
  workflows: WorkflowOps,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const record = await workflows.status({ run_id: workflowRunIdParam(args) });
  return { structured: workflowRunResult(record) };
}

async function workflowStop(
  workflows: WorkflowOps,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await workflows.stop({ run_id: workflowRunIdParam(args) });
  return { structured: { run_id: result.run_id, status: result.status } };
}

async function workflowList(workflows: WorkflowOps): Promise<McpToolSuccess> {
  const result = await workflows.list();
  return { structured: { runs: result.runs.map(workflowRunResult) } };
}

function workflowRunIdSchema(): JsonSchema {
  return { type: 'string', minLength: 1, pattern: '^[a-z0-9-]+$' };
}

function workflowRunSchema(): JsonSchema {
  return objectSchema(
    {
      version: { type: 'integer', const: 1 },
      run_id: workflowRunIdSchema(),
      dispatcher_id: { type: 'string' },
      team_id: { type: ['string', 'null'] },
      caller_kind: { type: 'string', enum: ['dispatcher', 'team_leader'] },
      script_hash: { type: 'string' },
      status: {
        type: 'string',
        enum: ['running', 'completed', 'failed', 'stopped'],
      },
      max_concurrency: { type: 'integer' },
      phase: { type: ['string', 'null'] },
      last_log: { type: ['string', 'null'] },
      agents: arrayOf(workflowAgentSchema()),
      // This is the one intentionally open JSON-valued extension field.
      result: {},
      error: { type: ['string', 'null'] },
      created_at: { type: 'integer' },
      updated_at: { type: 'integer' },
      ended_at: { type: ['integer', 'null'] },
    },
    [
      'version',
      'run_id',
      'dispatcher_id',
      'team_id',
      'caller_kind',
      'script_hash',
      'status',
      'max_concurrency',
      'phase',
      'last_log',
      'agents',
      'result',
      'error',
      'created_at',
      'updated_at',
      'ended_at',
    ],
  );
}

function workflowAgentSchema(): JsonSchema {
  return objectSchema(
    {
      index: { type: 'integer' },
      name: { type: ['string', 'null'] },
      label: { type: ['string', 'null'] },
      phase: { type: ['string', 'null'] },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'completed', 'failed', 'stopped'],
      },
      result: {},
      error: { type: ['string', 'null'] },
      created_at: { type: 'integer' },
      settled_at: { type: ['integer', 'null'] },
    },
    [
      'index',
      'name',
      'label',
      'phase',
      'status',
      'result',
      'error',
      'created_at',
      'settled_at',
    ],
  );
}
