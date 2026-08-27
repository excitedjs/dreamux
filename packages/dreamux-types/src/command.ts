/**
 * The generic Core Command port (declaration-only).
 *
 * There is one authoritative Command registry, not an admin method table plus a
 * separate Channel catalog. Every adapter — the `admin.sock` NDJSON server, the
 * in-process Channel invoker, and the Channel MCP stdio shim — resolves the same
 * definition, runs the same validation, attaches its factual caller context,
 * executes the same domain handler, and returns the same typed result or error.
 *
 * These types carry no exposure/audience property, allowlist, describe-by-caller
 * hook, or capability negotiation: every registered Command is callable through
 * every adapter, subject only to its ordinary input and domain invariants.
 * Canonical Command payloads themselves live with the domain that owns them
 * (see `team.ts`).
 */
import type { JsonSchema, JsonValue } from './json.js';

/**
 * Who is calling a Channel-MCP-scoped operation. Core injects Channel MCP only
 * into Dispatcher and TeamLeader runtimes, so those are the only two callers.
 * `team_name` is the Team store key — the same value Core publishes on every
 * Team/TeamMate event — so a Channel may join tool calls and events on it
 * without Core learning any Channel concept.
 */
export type ChannelMcpCaller =
  | { readonly kind: 'dispatcher' }
  | {
      readonly kind: 'team_leader';
      readonly team_name: string;
      readonly leader_name: string;
    };

/** Which adapter admitted this Command invocation. */
export type CoreCommandSource = 'admin_socket' | 'channel' | 'mcp_proxy';

/**
 * Factual invocation context. Some domain operations, logging, deduplication,
 * and the Channel-MCP lease consume these fields. They never filter the
 * registry.
 */
export interface CoreCommandContext {
  readonly source: CoreCommandSource;
  readonly dispatcher_id?: string;
  readonly channel_id?: string;
  readonly caller?: ChannelMcpCaller;
}

/**
 * One domain-owned Command. Parsing, schemas, and execution belong to the
 * domain that owns the action, not to a transport adapter.
 */
export interface CoreCommandDefinition<Name extends string, Input, Output> {
  readonly name: Name;
  readonly version: 1;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  parse(payload: JsonValue): Input;
  execute(context: CoreCommandContext, input: Input): Promise<Output>;
}

export interface CoreCommandRegistry {
  invoke(
    context: CoreCommandContext,
    name: string,
    payload: JsonValue,
  ): Promise<JsonValue>;
}

/**
 * A typed Command failure returned across the generic port. `code` stays an
 * open string because each domain owns its own failure vocabulary; the two
 * codes that carry a cross-domain rule are named by
 * {@link ChannelCommandRetryableErrorCode}.
 */
export interface ChannelCommandError {
  readonly code: string;
  readonly message: string;
}

/**
 * The only pre-admission failures that permit a Channel to remove a stale
 * binding and retry once to the Dispatcher Agent. Every other failure — and any
 * `ambiguous` outcome — is never retried.
 */
export type ChannelCommandRetryableErrorCode = 'TEAM_NOT_FOUND' | 'TEAM_CLOSED';
