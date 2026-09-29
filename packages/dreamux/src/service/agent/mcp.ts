/**
 * The TeamMate MCP server, implemented by the collection that owns the roster.
 *
 * One delegate serves both callers, and they are two genuinely different
 * objects rather than one object told who is asking: a Dispatcher Agent's
 * delegate holds the real `DispatcherService` itself, a TeamLeader's holds
 * that Team's `TeamLeaderHandle` (each named here only through the narrow
 * structural interface declared below, so this collection-tier file need not
 * import the concrete class or interface). The handle carries no lease of
 * its own: each surface it exposes (`teammates`, `workflows`) fences every
 * verb itself, against a concurrent dissolve, through its own
 * constructor-injected `admit` — this file only forwards a call to that
 * surface.
 *
 * The Workflow tools are composed onto this same catalog and call dispatch
 * from `workflow-service/mcp.js`: they are advertised on this server because
 * they are the same caller's work, reaching the same handle's `workflows`,
 * but their descriptors and handlers belong to the domain that owns them.
 *
 * The input codecs and the submission-receipt projection belong to the owning
 * domain and live with the types and records they read; what stays here is
 * this surface's: the two scopes, the advertised catalog, and the
 * model-facing text a tool chooses to say.
 *
 * Failures are thrown, not classified: each domain's failures state their own
 * reason and next step, and the admission boundary every delegate is reached
 * through renders them.
 */
import type { JsonSchema } from '@excitedjs/dreamux-types';

import type { CommandPayload } from '../../command/payload.js';
import { OBJECT, arrayOf, objectSchema } from '../../command/schema.js';
import { mapAgentActivityCommandError } from './activity.js';
import type { AgentEntitySpawnResult } from './identity.js';
import type {
  SpawnTeamMateRequest,
  TeamLeaderTeammateOps,
  TeammateOps,
} from './types.js';
import type { WorkflowOps } from '../workflow-service/index.js';
import { TEAMMATE_DISPATCH_SUCCESS_REMINDER } from '../mcp/dispatch-reminders.js';
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
import { WORKFLOW_TOOL_RECORDS } from '../workflow-service/mcp.js';
import {
  REPO_REQUEST_SCHEMA,
  repoRequest,
  repoWorktree,
} from '../worktree/repo-request.js';
import type { TeamMateWorktreeRequest } from '../worktree/types.js';
import {
  agentCloseRequest,
  agentEntityLastQuery,
  agentEntityNameParam,
  agentSendRequest,
  agentSpawnRequest,
  historyQuery,
  teammateReceiptSchema,
} from './requests.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

/**
 * Structural stand-in for `DispatcherService`, naming only the members this
 * delegate calls. `DispatcherService` satisfies this shape without either
 * file needing to name the other, so this collection-tier file needs no
 * import from the orchestration tier that owns the concrete class. Exported
 * so `dispatcher-service/mcp-delegates.ts`, the one caller that passes a
 * `DispatcherService` in as this scope, can extend it with the few members
 * it also needs instead of restating these three.
 */
export interface TeamMateMcpDispatcherScope {
  readonly teammates: TeammateOps;
  readonly workflows: WorkflowOps;
  workspace(): Promise<string>;
}

/**
 * Structural stand-in for `TeamLeaderHandle`, for the same reason: this
 * collection-tier file needs no import from the team tier that owns the
 * concrete interface. `teammates` is `TeamLeaderTeammateOps` (`./types.js`),
 * the same derived type `TeamLeaderHandle` declares its own `teammates`
 * field with, so `spawn`'s omission is stated once rather than by two
 * independent `Pick`s that could drift apart.
 */
interface TeamMateMcpTeamLeaderScope {
  readonly teammates: TeamLeaderTeammateOps;
  readonly workflows: WorkflowOps;
  spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>,
  ): Promise<AgentEntitySpawnResult>;
}

/**
 * What the two callers actually operate on.
 *
 * The dispatcher scope's `teammates` keeps `spawn` because its `spawn`
 * drives the collection directly; the Team scope's omits it because a Team
 * TeamMate is spawned into the Team's shared workspace, through the handle's
 * own `spawnTeamMate`.
 */
export type TeamMateMcpScope =
  | {
      readonly kind: 'dispatcher';
      readonly dispatcher: TeamMateMcpDispatcherScope;
    }
  | {
      readonly kind: 'team_leader';
      /**
       * Resolved per call, never captured. A handle held across calls would
       * keep answering for a Team object that has since closed, instead of
       * reaching whichever Team currently holds that id.
       */
      readonly team: () => Promise<TeamMateMcpTeamLeaderScope>;
    };

/** One tool this delegate advertises, paired with the handler that serves it. */
interface TeammateMcpToolRecord {
  readonly descriptor: McpToolDescriptor;
  readonly execute: (args: CommandPayload) => Promise<McpToolSuccess>;
}

export function createTeamMateMcpDelegate(
  scope: TeamMateMcpScope,
): McpServerDelegate {
  const records = teammateToolRecords(scope);
  const tools = records.map((record) => record.descriptor);
  return {
    name: TEAMMATE_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { tools };
    },
    call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(() => callTool(records, call));
    },
  };
}

async function callTool(
  records: readonly TeammateMcpToolRecord[],
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const record = records.find(
    (candidate) => candidate.descriptor.name === call.name,
  );
  if (record === undefined) {
    // Unreachable: Core admits a call only against this delegate's own frozen
    // catalog, so a name that is not in this delegate's own records never
    // arrives here.
    throw new Error(`unknown TeamMate tool '${call.name}'`);
  }
  return record.execute(call.arguments as CommandPayload);
}

/**
 * The roster operations both scopes share, spelled once.
 *
 * `TeamLeaderHandle.teammates` is deliberately a structural match for the
 * dispatcher's `teammates` on exactly these verbs, so read and send paths need
 * no branch at all — only `spawn` differs, because only `spawn` differs.
 */
async function teammates(scope: TeamMateMcpScope) {
  return scope.kind === 'dispatcher'
    ? scope.dispatcher.teammates
    : (await scope.team()).teammates;
}

async function workflows(scope: TeamMateMcpScope) {
  return scope.kind === 'dispatcher'
    ? scope.dispatcher.workflows
    : (await scope.team()).workflows;
}

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
const AGENT_RUNTIME_CAPABILITY_SCHEMA: JsonSchema = objectSchema(
  {
    id: { type: 'string' },
    spawn: objectSchema({ agent_runtime: { type: 'string' } }, [
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

function teammateToolRecords(scope: TeamMateMcpScope): TeammateMcpToolRecord[] {
  const callerKind = scope.kind;
  // The pointer to the hand-down skill opens the description of the tool the
  // model is about to call, which is where the intent to hand work down forms.
  // Which skill depends on who is calling: a TeamLeader hands work only to a
  // TeamMate, a Dispatcher to a TeamMate or a Team.
  const handOffSkillPointer =
    callerKind === 'dispatcher'
      ? 'The bundled `dispatcher-workflow` skill covers how to brief a TeamMate or a Team.'
      : 'The bundled `teamwork` skill covers how to brief a TeamMate.';
  const spawnProperties: Record<string, JsonSchema> = {
    name_prefix: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'Requested label; the concrete name comes back in the result.',
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
        "Standing role and boundaries appended to the TeamMate's system " +
        'prompt for every turn.',
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
      ? `${handOffSkillPointer} Start a resumable TeamMate agent managed by this dispatcher and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. repo is optional: omit it to let Dreamux allocate the work directory by the dispatcher's workspace policy (a fresh per-TeamMate directory, or the dispatcher's own directory when workspace isolation is disabled), or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, cleanup? } to choose an existing path or create a managed git worktree. Returns a receipt at once; the completion is pushed later as a new message.`
      : `${handOffSkillPointer} Start a resumable TeamMate agent in this Team's shared workspace and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. Coordinate edits so only one TeamMate writes the shared workspace unless the work is read-only, the edits are independent, or the user asked for parallel edits. This tool does not accept a repo parameter. Returns a receipt at once; the completion is pushed later as a new message.`;
  const sendDescription = `${handOffSkillPointer} Send a turn to a TeamMate agent; reopens a closed one from the runtime-native session recorded on it (interpreted by its agent_runtime) first. Pass intent to update the recorded recovery subject before the turn. Returns a receipt at once; the completion is pushed later as a new message.`;

  return [
    {
      descriptor: tool(
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
          output: teammateReceiptSchema,
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
          output: objectSchema({ teammate: OBJECT }, ['teammate']),
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
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Rows per page; default 20, max 100.',
          },
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
              items: arrayOf(OBJECT),
              next_cursor: { type: ['string', 'null'] },
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
        'List this TeamMate set (compact rows: concrete name, status, agent runtime, intent essentials).',
        {},
        [],
        {
          title: 'List TeamMates',
          output: objectSchema({ teammates: arrayOf(OBJECT) }, ['teammates']),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: () => list(scope),
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
        "Read a TeamMate's recent activity without starting or resuming it. Returns assistant messages and tool records oldest first, including an in-progress turn. limit defaults to 20 (range 1..200); use cursor for older pages and set include_tools=false to omit tool records.",
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
            description:
              'false omits tool records and returns assistant messages only.',
          },
        },
        ['name'],
        {
          title: 'Read recent TeamMate activity',
          output: objectSchema(
            {
              teammate: OBJECT,
              requested_records: { type: 'integer' },
              returned_records: { type: 'integer' },
              records: arrayOf(OBJECT),
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
      execute: (args) => last(scope, args),
    },
    {
      descriptor: tool(
        'get_capabilities',
        'List TeamMate verbs and spawnable agent runtimes. Each runtime row carries the tags and public_config the agent runtime declares about itself, so two configured runtimes can be told apart without naming a provider.',
        {},
        [],
        {
          title: 'List TeamMate capabilities',
          output: objectSchema(
            {
              verbs: arrayOf({ type: 'string' }),
              agent_runtimes: arrayOf(AGENT_RUNTIME_CAPABILITY_SCHEMA),
            },
            ['verbs', 'agent_runtimes'],
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
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const request = agentSpawnRequest(args);
  let result: AgentEntitySpawnResult;
  if (scope.kind === 'team_leader') {
    // A Team TeamMate always inherits the Team's shared workspace, which is why
    // the leader catalog does not advertise `repo` at all.
    result = await (
      await scope.team()
    ).spawnTeamMate({
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
  return submissionReceipt(result);
}

async function send(
  scope: TeamMateMcpScope,
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
  return submissionReceipt(result);
}

function submissionReceipt(result: AgentEntitySpawnResult): McpToolSuccess {
  return {
    structured: result,
    ...(result.status === 'submitted'
      ? { text: TEAMMATE_DISPATCH_SUCCESS_REMINDER }
      : {}),
  };
}

async function close(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await (await teammates(scope)).close(agentCloseRequest(args));
  return { structured: result };
}

async function history(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: await (await teammates(scope)).history(historyQuery(args)),
  };
}

async function list(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  return { structured: { teammates: await (await teammates(scope)).list() } };
}

async function status(
  scope: TeamMateMcpScope,
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
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const name = agentEntityNameParam(args, 'name');
  const query = agentEntityLastQuery(args);
  try {
    return { structured: await (await teammates(scope)).last(name, query) };
  } catch (error) {
    // The reader's internal reason vocabulary never leaves this call: a
    // recognized reason becomes the Activity failure that states its own next
    // step, and anything else passes through with the type and message it
    // already had.
    return mapAgentActivityCommandError(error);
  }
}

async function capabilities(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  return { structured: await (await teammates(scope)).getCapabilities() };
}
