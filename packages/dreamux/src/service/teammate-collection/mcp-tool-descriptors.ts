/**
 * The TeamMate MCP server's tool catalog: every tool descriptor this delegate
 * advertises, and the JSON Schemas those descriptors are built from.
 *
 * Split from the delegate itself so that what a caller may ask for is stated in
 * one place and what happens when they ask is stated in another. The catalog is
 * still the delegate's own — it is derived from the caller kind and handed back
 * to {@link createTeamMateMcpDelegate}, which freezes it into the lease.
 */
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  OPEN_OBJECT,
  READ_ONLY_ANNOTATIONS,
  SUBMISSION_ERROR_SCHEMA,
  SUBMISSION_STATUS_SCHEMA,
  arrayOf,
  closedObjectSchema,
  repoInputSchema,
  toolMetadata,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import {
  MAX_WORKFLOW_MAX_CONCURRENCY,
  MIN_WORKFLOW_MAX_CONCURRENCY,
} from '../workflow-service/limits.js';
import type { TeamMateMcpScope } from './mcp-delegate.js';

/**
 * One spawnable agent runtime row of `get_capabilities`.
 *
 * The shape is Core-owned and closed: `tags` and `public_config` are the
 * provider's own declared facts, but Core normalized, bounded, and froze them
 * at registration, so what a caller sees here is a validated snapshot rather
 * than whatever object the provider happened to return. `public_config` stays
 * an open object because its keys are the provider's vocabulary — Core carries
 * them without interpreting them.
 */
const AGENT_RUNTIME_CAPABILITY_SCHEMA: Record<string, unknown> =
  closedObjectSchema(
    {
      id: { type: 'string' },
      spawn: closedObjectSchema({ agent_runtime: { type: 'string' } }, [
        'agent_runtime',
      ]),
      runtime_available: { type: 'boolean' },
      unsupported_reason: { type: ['string', 'null'] },
      tags: arrayOf({ type: 'string' }),
      public_config: { type: ['object', 'null'] },
    },
    [
      'id',
      'spawn',
      'runtime_available',
      'unsupported_reason',
      'tags',
      'public_config',
    ],
  );

export function teammateToolDescriptors(
  callerKind: TeamMateMcpScope['kind'],
): McpToolDescriptor[] {
  const readTools: McpToolDescriptor[] = [
    tool(
      'history',
      'Search this TeamMate set for recovery (closed included). A compact recovery list keyed by concrete name, not a raw event timeline. Returns { items, next_cursor }.',
      {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        status: {
          type: 'string',
          enum: ['starting', 'running', 'degraded', 'closed', 'stopped'],
        },
        agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
        repo: { type: 'string', minLength: 1, maxLength: 4096 },
        grep: { type: 'string', minLength: 1, maxLength: 500 },
        since: { type: 'integer' },
        until: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      [],
      {
        title: 'Search TeamMates',
        output: closedObjectSchema(
          {
            items: arrayOf(OPEN_OBJECT),
            next_cursor: { type: ['string', 'null'] },
          },
          ['items', 'next_cursor'],
        ),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'list',
      'List this TeamMate set (compact rows: concrete name, status, agent runtime, intent essentials).',
      {},
      [],
      {
        title: 'List TeamMates',
        output: closedObjectSchema({ teammates: arrayOf(OPEN_OBJECT) }, [
          'teammates',
        ]),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'status',
      'Read one TeamMate identity and live runtime status by its concrete name.',
      { name: { type: 'string', minLength: 1, maxLength: 64 } },
      ['name'],
      {
        title: 'Read TeamMate status',
        output: closedObjectSchema({ teammate: OPEN_OBJECT }, ['teammate']),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'last',
      'Read a TeamMate\'s recent activity without starting or resuming it. Returns assistant messages and tool records oldest first, including an in-progress turn. limit defaults to 20 (range 1..200); use cursor for older pages and set include_tools=false to omit tool records.',
      {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        cursor: { type: 'string', minLength: 1, maxLength: 4096 },
        include_tools: { type: 'boolean' },
      },
      ['name'],
      {
        title: 'Read recent TeamMate activity',
        output: closedObjectSchema(
          {
            teammate: OPEN_OBJECT,
            requested_records: { type: 'integer' },
            returned_records: { type: 'integer' },
            records: arrayOf(OPEN_OBJECT),
            next_cursor: { type: ['string', 'null'] },
            truncated: { type: 'boolean' },
          },
          [
            'teammate',
            'requested_records',
            'returned_records',
            'records',
            'next_cursor',
            'truncated',
          ],
        ),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'get_capabilities',
      'List TeamMate verbs and spawnable agent runtimes. Each runtime row carries the tags and public_config the agent runtime declares about itself, so two configured runtimes can be told apart without naming a provider.',
      {},
      [],
      {
        title: 'List TeamMate capabilities',
        output: closedObjectSchema(
          {
            verbs: arrayOf({ type: 'string' }),
            agent_runtimes: arrayOf(AGENT_RUNTIME_CAPABILITY_SCHEMA),
          },
          ['verbs', 'agent_runtimes'],
        ),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
  ];
  const spawnProperties: Record<string, unknown> = {
    name_prefix: { type: 'string', minLength: 1, maxLength: 64 },
    prompt: { type: 'string', minLength: 1, maxLength: 20000 },
    agent_runtime: {
      type: 'string',
      description:
        'Spawnable agents[].id returned by get_capabilities.agent_runtimes[].id.',
    },
    intent: { type: 'string', minLength: 1, maxLength: 2000 },
    identity: { type: 'string', minLength: 1, maxLength: 4000 },
  };
  if (callerKind === 'dispatcher') {
    spawnProperties['repo'] = repoInputSchema();
  }
  const spawnDescription =
    callerKind === 'dispatcher'
      ? 'Start a resumable TeamMate agent managed by this dispatcher and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. repo is optional: omit it to let Dreamux allocate a fresh per-TeamMate work directory, or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, slug?, cleanup? } to choose an existing path or create a managed git worktree.'
      : 'Start a resumable TeamMate agent in this Team\'s shared workspace and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. Coordinate edits so only one TeamMate writes the shared workspace unless the work is read-only or edits are independent. This tool does not accept a repo parameter.';
  const teammateReceiptSchema = closedObjectSchema(
    {
      teammate: OPEN_OBJECT,
      status: SUBMISSION_STATUS_SCHEMA,
      error: SUBMISSION_ERROR_SCHEMA,
    },
    ['teammate', 'status'],
  );
  const workflowTools: McpToolDescriptor[] = [
    tool(
      'workflow_run',
      'Load the bundled `workflow` skill before use. Start a deterministic multi-agent workflow from an inline module script (`script`) or a local file path (`scriptPath`) and return { run_id } immediately; Dreamux pushes one terminal completion when the run finishes.',
      {
        script: { type: 'string', minLength: 1 },
        scriptPath: { type: 'string', minLength: 1 },
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
        },
      },
      [],
      {
        title: 'Run a workflow',
        output: closedObjectSchema({ run_id: { type: 'string' } }, ['run_id']),
        annotations: MUTATING_ANNOTATIONS,
        inputConstraints: {
          anyOf: [{ required: ['script'] }, { required: ['scriptPath'] }],
        },
      },
    ),
    tool(
      'workflow_status',
      'Load the bundled `workflow` skill before use. Read phase, agent progress, concrete TeamMate names, and terminal result for one workflow run.',
      { run_id: workflowRunIdSchema() },
      ['run_id'],
      {
        title: 'Read workflow status',
        output: workflowRunSchema(),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'workflow_stop',
      'Load the bundled `workflow` skill before use. Stop one running workflow and return its resulting status.',
      { run_id: workflowRunIdSchema() },
      ['run_id'],
      {
        title: 'Stop a workflow',
        output: closedObjectSchema(
          { run_id: { type: 'string' }, status: { type: 'string' } },
          ['run_id', 'status'],
        ),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
    tool(
      'workflow_list',
      'Load the bundled `workflow` skill before use. List workflow runs in the current dispatcher or TeamLeader caller scope.',
      {},
      [],
      {
        title: 'List workflows',
        output: closedObjectSchema({ runs: arrayOf(workflowRunSchema()) }, [
          'runs',
        ]),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
  ];
  return [
    tool(
      'spawn',
      spawnDescription,
      spawnProperties,
      ['name_prefix', 'prompt', 'intent'],
      {
        title: 'Spawn a TeamMate',
        output: teammateReceiptSchema,
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    tool(
      'send',
      'Send a turn to a TeamMate agent; reopens a closed one from the runtime-native session recorded on it (interpreted by its agent_runtime) first. Pass intent to update the recorded recovery subject before the turn.',
      {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        intent: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      ['name', 'prompt'],
      {
        title: 'Send a TeamMate turn',
        output: teammateReceiptSchema,
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    tool(
      'close',
      'Close a named TeamMate agent and retain its history; send reopens it later. note is required: it records why a recoverable session was stopped.',
      {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        note: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      ['name', 'note'],
      {
        title: 'Close a TeamMate',
        output: closedObjectSchema({ teammate: OPEN_OBJECT }, ['teammate']),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
    ...readTools,
    ...workflowTools,
  ];
}

function workflowRunIdSchema(): Record<string, unknown> {
  return { type: 'string', minLength: 1, pattern: '^[a-z0-9-]+$' };
}

function workflowRunSchema(): Record<string, unknown> {
  return closedObjectSchema(
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

function workflowAgentSchema(): Record<string, unknown> {
  return closedObjectSchema(
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

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  meta: {
    title: string;
    output: Record<string, unknown>;
    annotations: McpToolAnnotations;
    inputConstraints?: Record<string, unknown>;
  },
): McpToolDescriptor {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    ...(meta.inputConstraints !== undefined
      ? { inputConstraints: meta.inputConstraints }
      : {}),
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}
