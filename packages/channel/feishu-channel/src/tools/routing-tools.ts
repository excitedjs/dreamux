/**
 * Routing tools: bind, unbind, and read this Channel's own bindings.
 *
 * They replaced Team MCP's `bind_channel`/`transfer_back`, and the move is the
 * point: only Feishu knows what a chat, a topic, and a parent group are, so
 * only Feishu can say which of them a Team answers in. There is no
 * `transfer_back` — rebinding a target to a different Team is `bind_channel`
 * with a different `team_name`, and the previous owner is reported back.
 *
 * `bind_channel` and `unbind_channel` exist twice, once per caller, and that is
 * the authorization: two definitions, disjoint catalogs, different authority.
 * The Dispatcher's names a Team and may move any route. The TeamLeader's has no
 * team field at all — its Team is the one Core baked into the lease — and it
 * reaches only routes that are free or already its own. A TeamLeader therefore
 * cannot address another Team, correctly or otherwise, because the argument
 * that would say so does not exist.
 *
 * `list_bindings` stays Dispatcher-only: it is the whole Channel's routing
 * table, which is an operator read rather than a Team's own business. A view
 * that also wants every Team, bound or not, joins it with `team.list`; nothing
 * here mirrors Core state to make that one call.
 */
import type {
  FeishuBindTargetSelector,
  FeishuToolContext,
  FeishuToolDef,
  FeishuToolResult,
} from './types.js';
import {
  asRecord,
  closedObjectSchema,
  nonEmptyString,
  optionalString,
  requireString,
} from './schema.js';

const mutating = { readOnlyHint: false, destructiveHint: false } as const;

interface TargetInput {
  chatId: string;
  threadId: string | null;
}

interface BindInput extends TargetInput {
  teamName: string;
  display: string | null;
}

const targetProperties = {
  chat_id: {
    ...nonEmptyString,
    description: 'Feishu chat id (an ordinary group, or a topic group).',
  },
  thread_id: {
    ...nonEmptyString,
    description:
      'Optional Feishu topic/thread id. Supply it to route one topic ' +
      'instead of the whole chat.',
  },
};

const displayProperty = {
  ...nonEmptyString,
  description: 'Optional human label for this target in listings.',
};

const bindOutputSchema = closedObjectSchema(
  {
    chat_id: nonEmptyString,
    thread_id: { type: ['string', 'null'] },
    team_name: nonEmptyString,
    previous_team_name: { type: ['string', 'null'] },
  },
  ['chat_id', 'thread_id', 'team_name', 'previous_team_name'],
);

const unbindOutputSchema = closedObjectSchema(
  {
    chat_id: nonEmptyString,
    thread_id: { type: ['string', 'null'] },
    unbound: { type: 'boolean' },
    team_name: { type: ['string', 'null'] },
  },
  ['chat_id', 'thread_id', 'unbound', 'team_name'],
);

function parseTarget(obj: Record<string, unknown>): TargetInput {
  return {
    chatId: requireString(obj, 'chat_id'),
    threadId: optionalString(obj, 'thread_id'),
  };
}

function selector(input: TargetInput): FeishuBindTargetSelector {
  return {
    chatId: input.chatId,
    ...(input.threadId !== null ? { threadId: input.threadId } : {}),
  };
}

/**
 * The Team this call already belongs to.
 *
 * Not a check on the arguments — there is nothing to check. It reads the Team
 * Core bound into the lease, which is the only Team a self-service definition
 * can ever act on.
 */
function leaseTeamName(ctx: FeishuToolContext): string {
  if (ctx.caller.kind !== 'team_leader') {
    // Unreachable: a self-service definition is advertised to, and resolved
    // for, the TeamLeader caller alone.
    throw new Error('a self-service routing tool requires a TeamLeader caller');
  }
  return ctx.caller.team_name;
}

async function runBind(
  ctx: FeishuToolContext,
  input: BindInput,
  requireOwner?: string,
): Promise<FeishuToolResult> {
  const result = await ctx.session.bindChannel({
    target: selector(input),
    teamName: input.teamName,
    display: input.display,
    ...(requireOwner !== undefined ? { requireOwner } : {}),
  });
  return {
    chat_id: input.chatId,
    thread_id: input.threadId,
    team_name: result.team_name,
    previous_team_name: result.previous_team_name,
  };
}

async function runUnbind(
  ctx: FeishuToolContext,
  input: TargetInput,
  requireOwner?: string,
): Promise<FeishuToolResult> {
  const result = await ctx.session.unbindChannel(selector(input), requireOwner);
  return {
    chat_id: input.chatId,
    thread_id: input.threadId,
    unbound: result.team_name !== null,
    team_name: result.team_name,
  };
}

export const bindChannelDef: FeishuToolDef<BindInput> = {
  name: 'bind_channel',
  title: 'Bind a Feishu conversation to a Team',
  description:
    'Route a Feishu group or topic to a Team. Inbound messages there are ' +
    'delivered to that Team\'s TeamLeader. Rebinding reports the ' +
    'previous Team.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema(
    {
      ...targetProperties,
      team_name: {
        ...nonEmptyString,
        description:
          'team_name of an existing, open Team; a missing or closed Team ' +
          'is refused and nothing changes.',
      },
      display: displayProperty,
    },
    ['chat_id', 'team_name'],
  ),
  outputSchema: bindOutputSchema,
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'bind_channel arguments');
    return {
      ...parseTarget(obj),
      teamName: requireString(obj, 'team_name'),
      display: optionalString(obj, 'display'),
    };
  },
  async handle(ctx, input) {
    return runBind(ctx, input);
  },
};

export const leaderBindChannelDef: FeishuToolDef<
  TargetInput & { display: string | null }
> = {
  name: 'bind_channel',
  title: 'Bind a Feishu conversation to your Team',
  description:
    'Route a Feishu group or topic to your own Team, so messages there ' +
    'reach you directly. Only a free conversation or one already routed ' +
    'to your Team can be bound here; a conversation another Team answers ' +
    'in is outside this caller\'s authority.',
  callers: ['team_leader'],
  inputSchema: closedObjectSchema(
    { ...targetProperties, display: displayProperty },
    ['chat_id'],
  ),
  outputSchema: bindOutputSchema,
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'bind_channel arguments');
    return {
      ...parseTarget(obj),
      display: optionalString(obj, 'display'),
    };
  },
  async handle(ctx, input) {
    const teamName = leaseTeamName(ctx);
    return runBind(ctx, { ...input, teamName }, teamName);
  },
};

export const unbindChannelDef: FeishuToolDef<TargetInput> = {
  name: 'unbind_channel',
  title: 'Unbind a Feishu conversation',
  description:
    'Stop routing a Feishu group or topic to a Team. The Team is not ' +
    'dissolved and keeps working; the conversation simply has no route.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema(targetProperties, ['chat_id']),
  outputSchema: unbindOutputSchema,
  annotations: mutating,
  parse(raw) {
    return parseTarget(asRecord(raw, 'unbind_channel arguments'));
  },
  async handle(ctx, input) {
    return runUnbind(ctx, input);
  },
};

export const leaderUnbindChannelDef: FeishuToolDef<TargetInput> = {
  name: 'unbind_channel',
  title: 'Release one of your Feishu conversations',
  description:
    'Stop routing a Feishu group or topic to your own Team. Your Team keeps ' +
    'working; the conversation simply has no route. A conversation that is ' +
    'not routed to you is left untouched.',
  callers: ['team_leader'],
  inputSchema: closedObjectSchema(targetProperties, ['chat_id']),
  outputSchema: unbindOutputSchema,
  annotations: mutating,
  parse(raw) {
    return parseTarget(asRecord(raw, 'unbind_channel arguments'));
  },
  async handle(ctx, input) {
    return runUnbind(ctx, input, leaseTeamName(ctx));
  },
};

export const listBindingsDef: FeishuToolDef<Record<string, never>> = {
  name: 'list_bindings',
  title: 'List Feishu bindings',
  description:
    'List every Feishu target this channel routes, with the Team it routes ' +
    'to. This is the authoritative binding read for this channel; combine it ' +
    'with the Team list to see unbound Teams.',
  callers: ['dispatcher'],
  inputSchema: closedObjectSchema({}),
  outputSchema: closedObjectSchema(
    {
      channel_id: nonEmptyString,
      bindings: {
        type: 'array',
        items: closedObjectSchema(
          {
            target_kind: { type: 'string' },
            chat_id: nonEmptyString,
            thread_id: { type: ['string', 'null'] },
            display: { type: ['string', 'null'] },
            team_name: nonEmptyString,
            origin: { type: 'string' },
            space_name: { type: ['string', 'null'] },
            created_at: { type: 'number' },
            updated_at: { type: 'number' },
          },
          [
            'target_kind',
            'chat_id',
            'thread_id',
            'display',
            'team_name',
            'origin',
            'space_name',
            'created_at',
            'updated_at',
          ],
        ),
      },
    },
    ['channel_id', 'bindings'],
  ),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  parse(raw) {
    asRecord(raw ?? {}, 'list_bindings arguments');
    return {};
  },
  async handle(ctx) {
    return {
      channel_id: ctx.session.channelId,
      bindings: ctx.session.listBindings().map((row) => ({ ...row })),
    };
  },
};
