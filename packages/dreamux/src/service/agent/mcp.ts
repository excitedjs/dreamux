/**
 * The TeamMate MCP server, implemented by the collection that owns the roster.
 *
 * Owner delegates serve two genuinely different
 * objects: a Dispatcher Agent's
 * delegate holds the real `DispatcherService` itself, a TeamLeader's holds
 * that Team (each named here only through the narrow
 * structural interface declared below, so this collection-tier file need not
 * import the concrete class or interface). The Team admits tool access at
 * each former owner-lookup point; each child surface (`teammates`, `workflows`)
 * then fences its own operation through the actual Team. The adapter keeps
 * argument parsing in its original position relative to those checks.
 *
 * The Workflow tools are composed onto this same catalog and call dispatch
 * from `workflow-service/mcp.js`: they are advertised on this server because
 * they are the same caller's work, reaching the same handle's `workflows`,
 * but their descriptors and handlers belong to the domain that owns them.
 *
 * The ordinary-member surface is a separate authority object and lives in
 * `member-mcp.ts`: its scope, owner interface, `send`/`list` tools, and its
 * distinct receipt wording. This file keeps the Dispatcher and TeamLeader
 * roster tools and forwards a member scope to that delegate.
 *
 * The domain owns each record and its full read model. What stays here is this
 * surface's: the caller scopes, the advertised catalog, the model-facing
 * projection each tool publishes, and the text a tool chooses to say.
 *
 * Failures are thrown, not classified: each domain's failures state their own
 * reason and next step, and the admission boundary every delegate is reached
 * through renders them.
 */
import type { JsonSchema } from '@excitedjs/dreamux-types';

import type { CommandPayload } from '../../command/payload.js';
import {
  BOOLEAN,
  INTEGER,
  NULLABLE_STRING,
  OBJECT,
  STRING,
  arrayOf,
  objectSchema,
} from '../../command/schema.js';
import { TEAMMATE_DISPATCH_SUCCESS_REMINDER } from '../mcp/dispatch-reminders.js';
import {
  createToolRecordDelegate,
  submissionReceipt,
  type McpToolRecord,
  type McpToolSuccess,
} from '../mcp/projection.js';
import { quoteModelValue } from '@excitedjs/dreamux-utils';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  tool,
} from '../mcp/tool-metadata.js';
import type { McpServerDelegate } from '../mcp/types.js';
import type { WorkflowOps } from '../workflow-service/index.js';
import { WORKFLOW_TOOL_RECORDS } from '../workflow-service/mcp.js';
import {
  REPO_REQUEST_SCHEMA,
  repoRequest,
  repoWorktree,
} from '../worktree/repo-request.js';
import type { TeamMateWorktreeRequest } from '../worktree/types.js';
import { mapAgentActivityCommandError } from './activity.js';
import type { AgentEntitySpawnResult } from './identity.js';
import { createMemberMcpDelegate, type MemberMcpScope } from './member-mcp.js';
import {
  TEAMMATE_LIST_STATUSES,
  TEAMMATE_ROSTER_ROW_SCHEMA,
  teammateRosterPage,
} from './mcp-roster.js';
import {
  LIST_PAGE_PROPERTIES,
  PAGE_LIMIT_PROPERTY,
  listInputProperties,
} from '../mcp/list-page.js';
import {
  AGENT_RUNTIME_CAPABILITY_SCHEMA,
  agentCloseRequest,
  agentEntityLastQuery,
  agentEntityNameParam,
  agentSendRequest,
  agentSpawnRequest,
  historyQuery,
} from './requests.js';
import type { TeammateOps } from './types.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

/**
 * Structural stand-in for `DispatcherService`, naming only the members this
 * delegate calls. `DispatcherService` satisfies this shape without either
 * file needing to name the other, so this collection-tier file needs no
 * import from the orchestration tier that owns the concrete class. Exported
 * so `dispatcher-service/agent.ts`, the one caller that passes a
 * `DispatcherService` in as this scope, can extend it with the few members
 * it also needs instead of restating these three.
 */
export interface TeamMateMcpDispatcherScope {
  readonly teammates: TeammateOps;
  readonly workflows: WorkflowOps;
  workspace(): Promise<string>;
}

/** Structural view of the Team's scoped collections, without a team-tier import. */
interface TeamMateMcpTeamLeaderScope {
  readonly teammates: TeammateOps;
  readonly workflows: WorkflowOps;
  admitLeaderTools<T>(operation: () => Promise<T>): Promise<T>;
}

/** The dispatcher, Team, or member scope this caller operates on. */
export type TeamMateMcpScope =
  | {
      readonly kind: 'dispatcher';
      readonly dispatcher: TeamMateMcpDispatcherScope;
    }
  | {
      readonly kind: 'team_leader';
      readonly team: TeamMateMcpTeamLeaderScope;
    }
  | MemberMcpScope;

type OwnerMcpScope = Exclude<TeamMateMcpScope, { kind: 'member' }>;

export function createTeamMateMcpDelegate(
  scope: TeamMateMcpScope,
): McpServerDelegate {
  if (scope.kind === 'member') {
    return createMemberMcpDelegate(scope, TEAMMATE_MCP_SERVER_NAME);
  }
  return createToolRecordDelegate(
    TEAMMATE_MCP_SERVER_NAME,
    teammateToolRecords(scope),
  );
}

/**
 * The roster operations both scopes share, spelled once.
 *
 * the Team's `teammates` is deliberately a structural match for the
 * dispatcher's `teammates` on exactly these verbs, so read and send paths need
 * no branch at all — only `spawn` differs, because only `spawn` differs.
 */
async function teammates(scope: OwnerMcpScope) {
  if (scope.kind === 'dispatcher') return scope.dispatcher.teammates;
  return scope.team.admitLeaderTools(async () => scope.team.teammates);
}

async function workflows(scope: OwnerMcpScope) {
  if (scope.kind === 'dispatcher') return scope.dispatcher.workflows;
  return scope.team.admitLeaderTools(async () => scope.team.workflows);
}

/** One recovery-search row; all fields are the record's own facts. */
const TEAMMATE_HISTORY_ROW_SCHEMA: JsonSchema = objectSchema(
  {
    name: STRING,
    status: STRING,
    agent_runtime: STRING,
    intent: NULLABLE_STRING,
    source_repo: NULLABLE_STRING,
    updated_at: INTEGER,
    close_note_preview: NULLABLE_STRING,
  },
  [
    'name',
    'status',
    'agent_runtime',
    'intent',
    'source_repo',
    'updated_at',
    'close_note_preview',
  ],
);

/** One activity observation, without the roster detail the call did not ask for. */
const TEAMMATE_LAST_SCHEMA: JsonSchema = objectSchema(
  {
    status: STRING,
    runtime_status: NULLABLE_STRING,
    last_error: NULLABLE_STRING,
    records: arrayOf(OBJECT),
    next_cursor: NULLABLE_STRING,
    truncated: BOOLEAN,
    transcript_path: NULLABLE_STRING,
  },
  [
    'status',
    'runtime_status',
    'last_error',
    'records',
    'next_cursor',
    'truncated',
    'transcript_path',
  ],
);

/** What a close leaves to inspect: the lifecycle status and cleanup outcome. */
const TEAMMATE_CLOSE_SCHEMA: JsonSchema = objectSchema(
  {
    status: STRING,
    repo: objectSchema({ path: STRING, cleanup_state: STRING }, [
      'path',
      'cleanup_state',
    ]),
  },
  ['status', 'repo'],
);

function teammateToolRecords(scope: OwnerMcpScope): McpToolRecord[] {
  const callerKind = scope.kind;
  // Dispatcher handoffs discover their guide at the tool. The TeamLeader's
  // launch prompt already routes missing collaboration guidance to teamwork.
  const handOffSkillPointer =
    callerKind === 'dispatcher'
      ? 'The bundled `dispatcher-workflow` skill covers how to brief a TeamMate or a Team. '
      : '';
  const spawnProperties: Record<string, JsonSchema> = {
    name_prefix: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'Requested label; use the concrete, never-reused name returned in the result for later calls.',
    },
    prompt: {
      type: 'string',
      minLength: 1,
      maxLength: 20000,
      description: "The TeamMate's first turn.",
    },
    agent_runtime: {
      type: 'string',
      description:
        'Agent runtime id from get_capabilities.agent_runtimes[].id.',
    },
    intent: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description:
        'One-line subject of the work; shown in list and history and kept ' +
        'for recovery.',
    },
    identity: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description:
        'Standing instructions for every turn, retained after reopening ' +
        'and not editable through send.',
    },
  };
  if (callerKind === 'dispatcher') {
    spawnProperties['repo'] = {
      ...REPO_REQUEST_SCHEMA,
      description:
        "Where the TeamMate works; omit for the dispatcher's workspace default: a fresh per-TeamMate directory, or the dispatcher's own directory when workspace isolation is disabled.",
    };
  }
  const spawnDescription =
    callerKind === 'dispatcher'
      ? `${handOffSkillPointer}Start a resumable TeamMate agent managed by this dispatcher and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. repo is optional: omit it to let Dreamux allocate the work directory by the dispatcher's workspace policy (a fresh per-TeamMate directory, or the dispatcher's own directory when workspace isolation is disabled), or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, cleanup? } to choose an existing path or create a managed git worktree. Returns a receipt at once; the completion is pushed later as a new message.`
      : "Start a resumable Dreamux TeamMate in this Team's shared workspace and submit its first turn; returns its concrete name for later calls. This creates an independent runtime session through Dreamux; native subagent tools are a separate mechanism. Returns a receipt at once; the completion is pushed later as a new message.";
  const sendDescription =
    callerKind === 'dispatcher'
      ? `${handOffSkillPointer}Send a turn to a TeamMate agent; reopens a closed one from the runtime-native session recorded on it (interpreted by its agent_runtime) first. Pass intent to update the recorded recovery subject before the turn. Returns a receipt at once; the completion is pushed later as a new message.`
      : 'Send a turn to a TeamMate; a closed member reopens with its recorded runtime session and standing identity. Returns a receipt at once; the completion is pushed later as a new message.';

  return [
    {
      descriptor: tool(
        'spawn',
        spawnDescription,
        spawnProperties,
        ['name_prefix', 'prompt', 'intent'],
        {
          title: 'Spawn a TeamMate',
          annotations: MUTATING_ANNOTATIONS,
        },
      ),
      execute: (args) => spawn(scope, args),
    },
    {
      descriptor: tool(
        'send',
        sendDescription,
        {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete name returned by spawn.',
          },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
            description: 'The next turn.',
          },
          intent: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: 'Replaces the recorded subject before the turn.',
          },
        },
        ['name', 'prompt'],
        {
          title: 'Send a TeamMate turn',
          annotations: MUTATING_ANNOTATIONS,
        },
      ),
      execute: (args) => send(scope, args),
    },
    {
      descriptor: tool(
        'close',
        'Close a named TeamMate agent and retain its history; send reopens it later. note is required: it records why a recoverable session was stopped.',
        {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete name returned by spawn.',
          },
          note: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: 'Why the TeamMate is closed; recorded on it.',
          },
        },
        ['name', 'note'],
        {
          title: 'Close a TeamMate',
          output: TEAMMATE_CLOSE_SCHEMA,
          annotations: DESTRUCTIVE_ANNOTATIONS,
        },
      ),
      execute: (args) => close(scope, args),
    },
    {
      descriptor: tool(
        'history',
        'Search this TeamMate set for recovery (closed included). A compact recovery list keyed by concrete name, not a raw event timeline. Returns { items, next_cursor }.',
        {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'Exact concrete name.',
          },
          status: {
            type: 'string',
            enum: ['starting', 'running', 'degraded', 'closed', 'stopped'],
            description: 'Filter by lifecycle status.',
          },
          agent_runtime: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: 'Exact agent runtime id.',
          },
          repo: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description:
              'Case-insensitive substring of the source repository path.',
          },
          grep: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description:
              'Case-insensitive substring over name, agent runtime, source ' +
              'repository, intent, and close note.',
          },
          since: {
            type: 'integer',
            description:
              "Epoch milliseconds; lower bound on a record's last update.",
          },
          until: {
            type: 'integer',
            description:
              "Epoch milliseconds; upper bound on a record's last update.",
          },
          limit: PAGE_LIMIT_PROPERTY,
          cursor: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description: 'next_cursor from the previous page.',
          },
        },
        [],
        {
          title: 'Search TeamMates',
          output: objectSchema(
            {
              items: arrayOf(TEAMMATE_HISTORY_ROW_SCHEMA),
              next_cursor: NULLABLE_STRING,
            },
            ['items', 'next_cursor'],
          ),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: (args) => history(scope, args),
    },
    {
      descriptor: tool(
        'list',
        'List a page of this TeamMate set. Defaults to non-closed members; use status all or closed to find members for recovery. Rows contain concrete name, status, runtime, and intent.',
        listInputProperties(TEAMMATE_LIST_STATUSES),
        [],
        {
          title: 'List TeamMates',
          output: objectSchema(
            {
              teammates: arrayOf(TEAMMATE_ROSTER_ROW_SCHEMA),
              ...LIST_PAGE_PROPERTIES,
            },
            ['teammates', 'total', 'next_cursor'],
          ),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: (args) => list(scope, args),
    },
    {
      descriptor: tool(
        'status',
        "Read one TeamMate's identity and live runtime status by its concrete name, for an explicit check.",
        {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete name returned by spawn.',
          },
        },
        ['name'],
        {
          title: 'Read TeamMate status',
          output: objectSchema({ teammate: OBJECT }, ['teammate']),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: (args) => status(scope, args),
    },
    {
      descriptor: tool(
        'last',
        "Read a TeamMate's recent activity without starting or resuming it. Returns assistant messages oldest first, including an in-progress turn. limit defaults to 20 (range 1..200); use cursor for older pages. include_tools defaults to false; set it to true to include tool records and keep that choice when paging. Native turn_id is included only when known (not a Core submission ID). transcript_path is the provider-confirmed current-session file, or null; it may be compressed and does not list ancestor files.",
        {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete name returned by spawn.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Records to return; default 20, max 200.',
          },
          cursor: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description:
              'next_cursor from the previous page, for older records.',
          },
          include_tools: {
            type: 'boolean',
            default: false,
            description:
              'Include tool records; default false returns assistant messages only.',
          },
        },
        ['name'],
        {
          title: 'Read recent TeamMate activity',
          output: TEAMMATE_LAST_SCHEMA,
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: (args) => last(scope, args),
    },
    {
      descriptor: tool(
        'get_capabilities',
        'List the agent runtimes this caller can spawn. Each row carries the runtime id, an optional description of when to use it, and optional tags, so two configured runtimes can be told apart without naming a provider.',
        {},
        [],
        {
          title: 'List TeamMate capabilities',
          output: objectSchema(
            { agent_runtimes: arrayOf(AGENT_RUNTIME_CAPABILITY_SCHEMA) },
            ['agent_runtimes'],
          ),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: () => capabilities(scope),
    },
    ...WORKFLOW_TOOL_RECORDS.map((record) => ({
      descriptor: record.descriptor,
      execute: async (args: CommandPayload) =>
        record.execute(await workflows(scope), args),
    })),
  ];
}

async function spawn(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const request = agentSpawnRequest(args);
  let result: AgentEntitySpawnResult;
  if (scope.kind === 'team_leader') {
    // A Team TeamMate always inherits the Team's shared workspace, which is why
    // the leader catalog does not advertise `repo` at all.
    const members = await teammates(scope);
    result = await members.spawn({
      name: request.name,
      prompt: request.prompt,
      intent: request.intent,
      ...(request.agentRuntime !== null
        ? { agentRuntime: request.agentRuntime }
        : {}),
      ...(request.identity !== null ? { identity: request.identity } : {}),
    });
  } else {
    const repo = repoWorktree(repoRequest(args, 'repo'));
    const cwd =
      repo === null ? null : (repo.cwd ?? (await scope.dispatcher.workspace()));
    const worktree: TeamMateWorktreeRequest | null = repo?.worktree ?? null;
    result = await scope.dispatcher.teammates.spawn({
      name: request.name,
      prompt: request.prompt,
      intent: request.intent,
      ...(cwd !== null ? { cwd } : {}),
      ...(request.agentRuntime !== null
        ? { agentRuntime: request.agentRuntime }
        : {}),
      ...(request.identity !== null ? { identity: request.identity } : {}),
      ...(worktree !== null ? { worktree } : {}),
    });
  }
  // A Dispatcher-spawned TeamMate owns a workspace the caller may have to
  // inspect; a Team member inherits the Team's shared directory, already
  // stated in its prompt, so repeating it here adds nothing.
  const repo =
    scope.kind === 'dispatcher'
      ? {
          path: result.teammate.repo.path,
          branch: result.teammate.repo.branch,
        }
      : null;
  const structured = {
    name: result.teammate.name,
    status: result.status,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(repo !== null ? { repo } : {}),
  };
  if (result.status !== 'submitted') return { structured };

  let location = '';
  if (repo !== null) {
    location = ` in ${quoteModelValue(repo.path)}`;
    if (repo.branch !== null) {
      location += ` on branch ${quoteModelValue(repo.branch)}`;
    }
  }
  return {
    structured,
    text:
      `Started TeamMate ${quoteModelValue(result.teammate.name)}${location}.` +
      `\n\n${TEAMMATE_DISPATCH_SUCCESS_REMINDER}`,
  };
}

async function send(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const request = agentSendRequest(args);
  const result = await (
    await teammates(scope)
  ).send({
    name: request.name,
    prompt: request.prompt,
    ...(request.intent !== null ? { intent: request.intent } : {}),
  });
  return submissionReceipt(result, TEAMMATE_DISPATCH_SUCCESS_REMINDER);
}

async function close(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const { teammate } = await (
    await teammates(scope)
  ).close(agentCloseRequest(args));
  // The cleanup outcome is the fact a caller may still have to act on:
  // retained-dirty/unmerged/error means work survived the close.
  return {
    structured: {
      status: teammate.status,
      repo: {
        path: teammate.repo.path,
        cleanup_state: teammate.repo.cleanup_state,
      },
    },
  };
}

async function history(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const page = await (await teammates(scope)).history(historyQuery(args));
  return {
    structured: {
      items: page.items.map(
        ({
          name,
          status,
          agent_runtime,
          intent,
          source_repo,
          updated_at,
          close_note_preview,
        }) => ({
          name,
          status,
          agent_runtime,
          intent,
          source_repo,
          updated_at,
          close_note_preview,
        }),
      ),
      next_cursor: page.next_cursor,
    },
  };
}

async function list(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const rows = await (await teammates(scope)).list();
  return { structured: teammateRosterPage(rows, args) };
}

async function status(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: {
      teammate: await (
        await teammates(scope)
      ).status(agentEntityNameParam(args, 'name')),
    },
  };
}

async function last(
  scope: OwnerMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const name = agentEntityNameParam(args, 'name');
  const query = agentEntityLastQuery(args);
  try {
    const result = await (
      await teammates(scope)
    ).last(name, {
      ...query,
      includeTools: query.includeTools ?? false,
    });
    // The caller asked to observe activity, not to re-read the roster row it
    // already has from `status`/`list`.
    return {
      structured: {
        status: result.teammate.status,
        runtime_status: result.teammate.runtime_status,
        last_error: result.teammate.last_error,
        records: result.records,
        next_cursor: result.next_cursor,
        truncated: result.truncated,
        transcript_path: result.transcript_path,
      },
    };
  } catch (error) {
    // The reader's internal reason vocabulary never leaves this call: a
    // recognized reason becomes the Activity failure that states its own next
    // step, and anything else passes through with the type and message it
    // already had.
    return mapAgentActivityCommandError(error);
  }
}

async function capabilities(scope: OwnerMcpScope): Promise<McpToolSuccess> {
  return { structured: await (await teammates(scope)).getCapabilities() };
}
