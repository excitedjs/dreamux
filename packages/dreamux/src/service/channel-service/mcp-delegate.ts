/**
 * The Channel MCP server, one per configured channel that publishes tools.
 *
 * This is the same delegate contract every internal domain implements, which is
 * the point: Channel is not a special case of the MCP infrastructure, it is one
 * implementation of it. Nothing in the lease registry, the two transport
 * Commands, the descriptor, or the shim knows a Channel exists.
 *
 * What differs is only what a delegate is supposed to differ in — where its
 * catalog comes from and what its calls reach. The catalog is the provider's
 * own, asked for per caller, and Core neither authors nor interprets a tool in
 * it. A call goes to the created instance's MCP capability or to the provider's
 * sessionless one, exactly as the registration declared.
 *
 * Both are proven before the catalog is fixed, and the surviving registrations
 * are the single set that answers `describe` and routes `call`. A tool whose
 * handler does not exist is therefore never advertised, rather than advertised
 * and then failed at invocation — which is what the registration contract
 * requires and the only honest thing to show a model.
 *
 * Core deliberately runs no egress gate here. It no longer resolves a target
 * out of a provider's own tool arguments, and it holds no proof that a message
 * belongs to one — those were Core re-deriving Channel facts from Channel data.
 * The Channel is told who is calling, in the call context, and owns its own
 * access rules.
 */
import type {
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpCaller,
  ChannelMcpToolDescriptor,
  ChannelMcpToolOutcome,
  ChannelProvider,
  ChannelSessionMcpCapability,
} from '@excitedjs/dreamux-types';

import { runDelegateCall } from '../mcp/projection.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';

const IDENTITY_VERSION = '0.4.0';

/**
 * The namespace every Channel MCP server is named in.
 *
 * A configured channel id is an operator's own string, chosen without knowing
 * which servers Dreamux composes beside it, so using it bare would let a
 * channel called `team` or `cron` collide with an internal delegate. The prefix
 * makes the two families structurally disjoint instead of relying on operators
 * to avoid names they were never told about. It does not replace the generic
 * uniqueness proof the composition boundary runs — nothing here can see the
 * rest of the set — it only keeps this domain from being the reason that proof
 * fails.
 *
 * Prefixing is also all this domain does to the id. The name that comes out is
 * a logical one, and it reaches every runtime and every model unchanged.
 */
const SERVER_NAME_PREFIX = 'channel-';

/**
 * What actually serves one tool: the created instance's capability for a
 * `session` registration, the provider's sessionless entry for a `provider`
 * one. Core holds it as a bound function so the two are interchangeable at the
 * only place that matters — dispatch — and neither is looked up again after the
 * catalog is fixed.
 */
type ChannelToolHandler = (
  call: ChannelMcpCall,
  context: ChannelMcpCallContext,
) => Promise<ChannelMcpToolOutcome>;

/**
 * The only failures Core itself may show the model here.
 *
 * Both come from the Team lease a TeamLeader-scoped call is dispatched under:
 * the Team was dissolved or closed between the lease being minted and the call
 * arriving. They are Core's own typed domain facts, raised on the way in, and
 * they are all Core has to project — a Channel states its own refusals as
 * results, so no Channel failure passes through an error code here and Core
 * never decides which of them a model may read. Anything else stays unsurfaced:
 * Core logs it in full and the model sees the fixed sanitized error.
 */
const PUBLIC_CODES = ['TEAM_NOT_FOUND', 'TEAM_CLOSED'] as const;

export interface ChannelMcpDelegateInput {
  dispatcherId: string;
  /** The configured channel this server serves: Core's id, not a session's. */
  channelId: string;
  provider: ChannelProvider<unknown>;
  /** The provider's already-parsed config view for this channel. */
  config: unknown;
  caller: ChannelMcpCaller;
  /**
   * This channel's created-instance MCP capability, or `null` when the instance
   * composed no session tools.
   *
   * A value rather than a lookup: it is the proof that a `session` registration
   * has a handler, and it has to be taken at the moment the catalog is fixed,
   * not rediscovered per call. The instance a Channel builds owns this
   * capability for its whole life, so what is proven here stays true for the
   * generation the catalog was frozen for.
   */
  sessionMcp: ChannelSessionMcpCapability | null;
  /**
   * How a call enters the dispatcher.
   *
   * The dispatcher scope admits the operation against shutdown; a TeamLeader
   * scope additionally takes that Team's leader lease, so a channel call is
   * serialized against a concurrent dissolve. Neither rule belongs in this file
   * — it is handed the entry it should use.
   */
  dispatch: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createChannelMcpDelegate(
  input: ChannelMcpDelegateInput,
): McpServerDelegate {
  // The configured id, carried verbatim behind a constant prefix. Nothing here
  // rewrites it to suit a runtime's configuration format: a channel is named to
  // the model the way its operator named it, and each runtime adapter quotes
  // whatever it is handed. The prefix is constant and config already keeps
  // channel ids unique per dispatcher, so two channels cannot collide either.
  const serverName = `${SERVER_NAME_PREFIX}${input.channelId}`;
  // Fixed once, here, and only from registrations whose declared target has a
  // handler right now. Binding the handler *is* the availability proof, so the
  // advertised list and the dispatch table cannot disagree: a tool is in both
  // or in neither.
  const handlers = new Map<string, ChannelToolHandler>();
  const tools: ChannelMcpToolDescriptor[] = [];
  const providerInvoke = input.provider.mcp?.invoke?.bind(input.provider.mcp);
  const registrations =
    input.provider.mcp?.describe(input.config, { caller: input.caller }) ?? [];
  for (const registration of registrations) {
    const handler =
      registration.target === 'session'
        ? input.sessionMcp?.invoke.bind(input.sessionMcp)
        : providerInvoke;
    // No handler means this channel cannot serve the tool at all, so it is not
    // advertised. That is the registration contract, not a Core policy.
    if (handler === undefined) continue;
    handlers.set(registration.tool.name, handler);
    tools.push(registration.tool);
  }
  return {
    // Namespaced by Core, from the configured channel id, which is Core's own
    // fact. A provider never names the server it is exposed through.
    name: serverName,
    describe(): McpDelegateDescription {
      return {
        identity: {
          name: `dreamux-channel-${input.channelId}`,
          version: IDENTITY_VERSION,
        },
        tools,
      };
    },
    async call(call: McpDelegateCall): Promise<McpDelegateResult> {
      const handler = handlers.get(call.name);
      if (handler === undefined) {
        // Unreachable: Core admits a call only against this delegate's own
        // frozen catalog, and that catalog was taken from the same loop that
        // filled this map, so every advertised name has an entry here.
        throw new Error(
          `channel '${input.channelId}' has no handler for tool ` +
            `'${call.name}'`,
        );
      }
      return runDelegateCall([...PUBLIC_CODES], () =>
        input.dispatch(() => invoke(input, handler, call)),
      );
    },
  };
}

/**
 * Hand the call to the Channel and pass its answer straight through.
 *
 * Both shapes are the Channel's decision and neither is reinterpreted here. A
 * refusal keeps the Channel's own wording, because only the Channel knows what
 * is wrong with a Feishu chat, and Core has nothing to add to a sentence it
 * cannot read. An exception is not an answer at all and simply propagates.
 */
async function invoke(
  input: ChannelMcpDelegateInput,
  handler: ChannelToolHandler,
  call: McpDelegateCall,
): Promise<McpDelegateResult> {
  const channelCall: ChannelMcpCall = {
    name: call.name,
    arguments: call.arguments as ChannelMcpCall['arguments'],
  };
  // Routing identity is never part of the model-facing tool schema: it is what
  // Core baked into the lease that admitted this call.
  const context: ChannelMcpCallContext = {
    dispatcher_id: input.dispatcherId,
    channel_id: input.channelId,
    caller: input.caller,
  };
  const outcome = await handler(channelCall, context);
  return outcome.ok ? { ok: true, structured: outcome.value } : outcome;
}
