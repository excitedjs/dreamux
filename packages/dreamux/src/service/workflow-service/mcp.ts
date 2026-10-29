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
 * Request readers are shared with Commands through `requests.ts`. This module
 * owns compact MCP results; Commands keep their full record projections there.
 */
import type { JsonSchema } from '@excitedjs/dreamux-types';

import type { CommandPayload } from '../../command/payload.js';
import { arrayOf, objectSchema } from '../../command/schema.js';
import { WORKFLOW_RUN_SUCCESS_REMINDER } from '../mcp/dispatch-reminders.js';
import type { McpToolSuccess } from '../mcp/projection.js';
import { quoteModelValue } from '@excitedjs/dreamux-utils';
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
import { workflowRunIdParam, workflowRunInput } from './requests.js';

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

const WORKFLOW_RUN_STATUS_SCHEMA: JsonSchema = {
  type: 'string',
  enum: ['running', 'completed', 'failed', 'stopped'],
};

const WORKFLOW_AGENT_STATUS_SCHEMA: JsonSchema = {
  type: 'string',
  enum: ['queued', 'running', 'completed', 'failed', 'stopped'],
};

/**
 * The four Workflow tools (`workflow_run`/`workflow_status`/`workflow_stop`/
 * `workflow_list`), for the TeamMate MCP delegate to fold into its own catalog
 * and call dispatch.
 */
export const WORKFLOW_TOOL_RECORDS: WorkflowMcpToolRecord[] = [
  {
    descriptor: tool(
      'workflow_run',
      'The bundled `dynamic-workflow` skill covers the script API. Start a deterministic multi-agent workflow and return { run_id } immediately; Dreamux pushes one terminal completion when the run finishes. Provide either `script` (inline module source) or `scriptPath` (a path to a module file readable by the Dreamux server): one of the two is required, and a call with neither is rejected.',
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
        annotations: MUTATING_ANNOTATIONS,
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
        output: objectSchema({ status: WORKFLOW_RUN_STATUS_SCHEMA }, [
          'status',
        ]),
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
        output: objectSchema({ runs: arrayOf(workflowListRowSchema()) }, [
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
    text:
      `Started workflow run ${quoteModelValue(accepted.run_id)}.` +
      `\n\n${WORKFLOW_RUN_SUCCESS_REMINDER}`,
  };
}

async function workflowStatus(
  workflows: WorkflowOps,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const record = await workflows.status({ run_id: workflowRunIdParam(args) });
  return {
    structured: {
      run_id: record.run_id,
      status: record.status,
      phase: record.phase,
      last_log: record.last_log,
      result: record.result ?? null,
      error: record.error,
      created_at: record.created_at,
      updated_at: record.updated_at,
      ended_at: record.ended_at,
      // `index` is the runner-assigned call identity: normalization can drop
      // an agent from the record and a script may continue after a caught
      // failure, so it need not equal the array position; while `name` and
      // `label` are nullable it is the only stable call/log key.
      agents: record.agents.map((agent) => ({
        index: agent.index,
        name: agent.name,
        label: agent.label,
        status: agent.status,
        phase: agent.phase,
        result: agent.result ?? null,
        error: agent.error,
      })),
    },
  };
}

async function workflowStop(
  workflows: WorkflowOps,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await workflows.stop({ run_id: workflowRunIdParam(args) });
  return { structured: { status: result.status } };
}

async function workflowList(workflows: WorkflowOps): Promise<McpToolSuccess> {
  const result = await workflows.list();
  // `created_at` is the only stable identifier when a script names no phase,
  // so it stays in the scan row; the per-agent detail belongs to status.
  return {
    structured: {
      runs: result.runs.map((run) => ({
        run_id: run.run_id,
        status: run.status,
        phase: run.phase,
        created_at: run.created_at,
      })),
    },
  };
}

function workflowRunIdSchema(): JsonSchema {
  return { type: 'string', minLength: 1, pattern: '^[a-z0-9-]+$' };
}

function workflowRunSchema(): JsonSchema {
  return objectSchema(
    {
      run_id: workflowRunIdSchema(),
      status: WORKFLOW_RUN_STATUS_SCHEMA,
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
      'run_id',
      'status',
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
      status: WORKFLOW_AGENT_STATUS_SCHEMA,
      phase: { type: ['string', 'null'] },
      result: {},
      error: { type: ['string', 'null'] },
    },
    ['index', 'name', 'label', 'status', 'phase', 'result', 'error'],
  );
}

function workflowListRowSchema(): JsonSchema {
  return objectSchema(
    {
      run_id: workflowRunIdSchema(),
      status: WORKFLOW_RUN_STATUS_SCHEMA,
      phase: { type: ['string', 'null'] },
      created_at: { type: 'integer' },
    },
    ['run_id', 'status', 'phase', 'created_at'],
  );
}
