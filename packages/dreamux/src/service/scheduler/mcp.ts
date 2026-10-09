/**
 * The cron MCP server, implemented by the scheduler that owns the jobs.
 *
 * A cron job belongs to exactly one conversational agent — the Dispatcher Agent
 * or one Team's TeamLeader — and this delegate holds the scheduler or its
 * actual admitting owner. That is what makes the old defensive
 * scrubbing unnecessary: the shim used to strip a `dispatcher_id`/`team_id` a
 * model might have injected before re-applying the descriptor-bound scope,
 * because the target was a Command parameter. Here the target is not a
 * parameter at all, so there is nothing to strip and nothing to override.
 *
 * The request readers and the result projection live in `requests.ts`, shared
 * unchanged with `commands.ts`; what stays here is this surface's advertised
 * catalog and its tool names.
 *
 * Failures are thrown, not classified: a cron failure states its own reason and
 * next step, and the admission boundary every delegate is reached through
 * renders it.
 */
import type { CommandPayload } from '../../command/payload.js';
import { OBJECT, arrayOf, objectSchema } from '../../command/schema.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  tool,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import {
  cronCreateRequest,
  cronJobIdParam,
  cronJobResult,
  cronListResult,
  cronUpdateRequest,
} from './requests.js';
import type { SchedulerCommands } from './types.js';

export const CRON_MCP_SERVER_NAME = 'cron';

/** One tool this delegate advertises, paired with the handler that serves it. */
interface CronMcpToolRecord {
  readonly descriptor: McpToolDescriptor;
  readonly execute: (
    scheduler: SchedulerCommands,
    args: CommandPayload,
  ) => Promise<McpToolSuccess>;
}

/**
 * Build the cron delegate for one owner.
 *
 * Both schedulers already exist when delegates are built. A Team must still
 * admit access before argument parsing: its leader's runtime lease can remain
 * valid while dispatcher or Team teardown is waiting on other children.
 */
export function createCronMcpDelegate(
  owner:
    | SchedulerCommands
    | {
        readonly scheduler: SchedulerCommands;
        admitLeaderTools<T>(operation: () => Promise<T>): Promise<T>;
      },
): McpServerDelegate {
  const tools = CRON_TOOL_RECORDS.map((record) => record.descriptor);
  return {
    name: CRON_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { tools };
    },
    call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(async () => {
        if ('admitLeaderTools' in owner) {
          const scheduler = await owner.admitLeaderTools(
            async () => owner.scheduler,
          );
          return serve(scheduler, call);
        }
        return serve(owner, call);
      });
    },
  };
}

async function serve(
  scheduler: SchedulerCommands,
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const record = CRON_TOOL_RECORDS.find(
    (candidate) => candidate.descriptor.name === call.name,
  );
  return record!.execute(scheduler, call.arguments as CommandPayload);
}

const CRON_TOOL_RECORDS: CronMcpToolRecord[] = [
  {
    descriptor: tool(
      'cron_create',
      'Create a durable Dreamux cron job for this agent. cron is a standard 5-field local-time expression (M H DoM Mon DoW); prefer off-:00/:30 minutes for approximate schedules. prompt is the text injected into this dispatcher or TeamLeader agent. recurring defaults to true; use recurring:false for one-shot reminders. dreamux jobs are always persisted and do not auto-expire. tz is resolved and stored. Cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents. A due job submits its prompt at once, even while a turn is running.',
      {
        cron: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Standard 5-field expression (minute hour day-of-month month day-of-week) in tz.',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description: 'The text submitted to this agent when the job fires.',
        },
        recurring: {
          type: 'boolean',
          description:
            'true (default) fires on every match. false fires at most once, at the next match, and is then disabled; a one-shot missed while Dreamux was stopped is disabled without firing.',
        },
        tz: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description:
            "IANA time zone for the expression; defaults to the host's local zone.",
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Short label shown in cron_list.',
        },
      },
      ['cron', 'prompt'],
      {
        title: 'Create a cron job',
        output: cronJobSchema(),
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    execute: cronCreate,
  },
  {
    descriptor: tool(
      'cron_list',
      'List durable cron jobs for this agent.',
      {},
      [],
      {
        title: 'List cron jobs',
        output: objectSchema({ jobs: arrayOf(OBJECT) }, ['jobs']),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    execute: cronList,
  },
  {
    descriptor: tool(
      'cron_delete',
      'Delete a cron job by id.',
      {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'The job id from cron_create or cron_list.',
        },
      },
      ['id'],
      {
        title: 'Delete a cron job',
        output: objectSchema(
          { id: { type: 'string' }, deleted: { type: 'boolean' } },
          ['id', 'deleted'],
        ),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
    execute: cronDelete,
  },
  {
    descriptor: tool(
      'cron_update',
      'Update a cron job by id. Same behavior as cron_create: cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents. A due job submits its prompt at once, even while a turn is running.',
      {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'The job id from cron_create or cron_list.',
        },
        cron: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Same meaning as in cron_create; an omitted field keeps its value.',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description:
            'Same meaning as in cron_create; an omitted field keeps its value.',
        },
        recurring: {
          type: 'boolean',
          description:
            'Same meaning as cron_create.recurring; an omitted field keeps its value.',
        },
        tz: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description:
            'Same meaning as in cron_create; an omitted field keeps its value.',
        },
        title: {
          type: ['string', 'null'],
          minLength: 1,
          maxLength: 200,
          description: 'New label; null removes it.',
        },
        enabled: {
          type: 'boolean',
          description:
            'false pauses the job without deleting it; true resumes it.',
        },
      },
      ['id'],
      {
        title: 'Update a cron job',
        output: cronJobSchema(),
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    execute: cronUpdate,
  },
];

async function cronCreate(
  scheduler: SchedulerCommands,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: cronJobResult(await scheduler.create(cronCreateRequest(args))),
  };
}

async function cronUpdate(
  scheduler: SchedulerCommands,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: cronJobResult(await scheduler.update(cronUpdateRequest(args))),
  };
}

async function cronList(scheduler: SchedulerCommands): Promise<McpToolSuccess> {
  return { structured: cronListResult(await scheduler.list()) };
}

async function cronDelete(
  scheduler: SchedulerCommands,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return { structured: await scheduler.delete(cronJobIdParam(args)) };
}

function cronJobSchema(): Record<string, unknown> {
  return objectSchema(
    {
      id: { type: 'string' },
      title: { type: 'string' },
      cron: { type: 'string' },
      tz: { type: 'string' },
      recurring: { type: 'boolean' },
      action: OBJECT,
      enabled: { type: 'boolean' },
      created_at: { type: 'integer' },
      updated_at: { type: 'integer' },
      next_run_at: { type: ['integer', 'null'] },
      last_fired_at: { type: ['integer', 'null'] },
    },
    [
      'id',
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
