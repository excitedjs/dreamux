/**
 * The cron MCP server, implemented by the scheduler that owns the jobs.
 *
 * A cron job belongs to exactly one conversational agent — the Dispatcher Agent
 * or one Team's TeamLeader — and this delegate holds that agent's own
 * {@link SchedulerCommands} directly. That is what makes the old defensive
 * scrubbing unnecessary: the shim used to strip a `dispatcher_id`/`team_id` a
 * model might have injected before re-applying the descriptor-bound scope,
 * because the target was a Command parameter. Here the target is not a
 * parameter at all, so there is nothing to strip and nothing to override.
 */
import {
  mustNonEmptyString,
  mustString,
  optionalBooleanField,
  optionalNullableStringField,
  optionalStringField,
  type CommandPayload,
} from '../../command/payload.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  OPEN_OBJECT,
  READ_ONLY_ANNOTATIONS,
  arrayOf,
  closedObjectSchema,
  toolMetadata,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import type { CronJob } from './store.js';
import type { SchedulerCommands } from './types.js';

export const CRON_MCP_SERVER_NAME = 'cron';

const IDENTITY = { name: 'dreamux-cron', version: '0.4.0' };

/** The only cron failure a model can act on is its own malformed request. */
const PUBLIC_CODES = ['BAD_REQUEST'] as const;

/**
 * Build the cron delegate for one owner.
 *
 * `scheduler` is resolved lazily rather than captured: a Team's scheduler is
 * created with the Team and a Dispatcher's with its agent, and the delegate is
 * built at runtime-launch time, which may precede either.
 */
export function createCronMcpDelegate(input: {
  scheduler: () => Promise<SchedulerCommands>;
}): McpServerDelegate {
  const tools = cronToolDescriptors();
  return {
    name: CRON_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { identity: IDENTITY, tools };
    },
    async call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool([...PUBLIC_CODES], async () =>
        serve(await input.scheduler(), call),
      );
    },
  };
}

async function serve(
  scheduler: SchedulerCommands,
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const args = call.arguments as CommandPayload;
  switch (call.name) {
    case 'cron_create':
      return { structured: cronJobFields(await scheduler.create({
        cron: mustString(args, 'cron'),
        prompt: mustNonEmptyString(args, 'prompt'),
        ...optionalStringField(args, 'title'),
        ...optionalBooleanField(args, 'recurring'),
        ...optionalStringField(args, 'tz'),
      })) };
    case 'cron_update':
      return { structured: cronJobFields(await scheduler.update({
        id: mustString(args, 'id'),
        ...optionalStringField(args, 'cron'),
        ...optionalStringField(args, 'prompt'),
        ...optionalNullableStringField(args, 'title'),
        ...optionalBooleanField(args, 'recurring'),
        ...optionalStringField(args, 'tz'),
        ...optionalBooleanField(args, 'enabled'),
      })) };
    case 'cron_list':
      return { structured: { jobs: (await scheduler.list()).jobs } };
    case 'cron_delete':
      return { structured: await scheduler.delete(mustString(args, 'id')) };
    default:
      // Unreachable: Core admits a call only against this delegate's own frozen
      // catalog, so a name that is not one of the above never arrives here.
      throw new Error(`unknown cron tool '${call.name}'`);
  }
}

function cronJobFields(job: CronJob): Record<string, unknown> {
  return {
    id: job.id,
    dispatcher_id: job.dispatcher_id,
    ...(job.title !== undefined ? { title: job.title } : {}),
    cron: job.cron,
    tz: job.tz,
    recurring: job.recurring,
    action: job.action,
    enabled: job.enabled,
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_run_at: job.next_run_at,
    last_fired_at: job.last_fired_at,
  };
}

function cronToolDescriptors(): McpToolDescriptor[] {
  return [
    tool(
      'cron_create',
      'Create a durable Dreamux cron job for this agent. cron is a standard 5-field local-time expression (M H DoM Mon DoW); prefer off-:00/:30 minutes for approximate schedules. prompt is the text injected into this dispatcher or TeamLeader agent. recurring defaults to true; use recurring:false for one-shot reminders. dreamux jobs are always persisted and do not auto-expire. tz is resolved and stored. Cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents.',
      {
        cron: { type: 'string', minLength: 1, maxLength: 200 },
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        recurring: { type: 'boolean' },
        tz: { type: 'string', minLength: 1, maxLength: 100 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      ['cron', 'prompt'],
      {
        title: 'Create a cron job',
        output: cronJobSchema(),
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    tool('cron_list', 'List durable cron jobs for this agent.', {}, [], {
      title: 'List cron jobs',
      output: closedObjectSchema({ jobs: arrayOf(OPEN_OBJECT) }, ['jobs']),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool(
      'cron_delete',
      'Delete a cron job by id.',
      { id: { type: 'string', minLength: 1, maxLength: 128 } },
      ['id'],
      {
        title: 'Delete a cron job',
        output: closedObjectSchema(
          { id: { type: 'string' }, deleted: { type: 'boolean' } },
          ['id', 'deleted'],
        ),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
    tool(
      'cron_update',
      'Update a cron job by id. Same behavior as cron_create: cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents.',
      {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        cron: { type: 'string', minLength: 1, maxLength: 200 },
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        recurring: { type: 'boolean' },
        tz: { type: 'string', minLength: 1, maxLength: 100 },
        title: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
        enabled: { type: 'boolean' },
      },
      ['id'],
      {
        title: 'Update a cron job',
        output: cronJobSchema(),
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
  ];
}

function cronJobSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      id: { type: 'string' },
      dispatcher_id: { type: 'string' },
      title: { type: 'string' },
      cron: { type: 'string' },
      tz: { type: 'string' },
      recurring: { type: 'boolean' },
      action: OPEN_OBJECT,
      enabled: { type: 'boolean' },
      created_at: { type: 'integer' },
      updated_at: { type: 'integer' },
      next_run_at: { type: ['integer', 'null'] },
      last_fired_at: { type: ['integer', 'null'] },
    },
    [
      'id',
      'dispatcher_id',
      'cron',
      'tz',
      'recurring',
      'action',
      'enabled',
      'created_at',
      'updated_at',
      'next_run_at',
      'last_fired_at',
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
  },
): McpToolDescriptor {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}
