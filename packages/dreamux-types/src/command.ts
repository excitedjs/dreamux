/**
 * The generic Core Command port (declaration-only).
 *
 * There is one authoritative Command registry, not an admin method table plus a
 * separate Channel catalog. Both adapters — the `admin.sock` NDJSON server and
 * the in-process Channel invoker — resolve the same definition, run the same
 * validation, attach their factual caller context, execute the same domain
 * handler, and return the same typed result or error.
 *
 * These types carry no exposure/audience property, allowlist, describe-by-caller
 * hook, or capability negotiation: every registered Command is callable through
 * every adapter, subject only to its ordinary input and domain invariants.
 * Canonical Command payloads themselves live with the domain that owns them
 * (see `team.ts`).
 */
import type { JsonSchema, JsonValue } from './json.js';

/**
 * Which adapter admitted this Command invocation.
 *
 * There are exactly two, because an Agent no longer reaches Commands at all: an
 * Agent-facing MCP tool is served by its own delegate behind a runtime-generation
 * lease, so no adapter has to describe itself as “the MCP proxy”.
 */
export type CoreCommandSource = 'admin_socket' | 'channel';

/**
 * Factual invocation context. Some domain operations, logging, and deduplication
 * consume these fields. They never filter the registry.
 *
 * There is no caller identity here. Caller scope belongs to whoever bound it —
 * for MCP that is the delegate the lease resolves to — and a Command that read
 * one would be re-deriving a fact a lower layer already owns.
 */
export interface CoreCommandContext {
  readonly source: CoreCommandSource;
  readonly dispatcher_id?: string;
  readonly channel_id?: string;
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
  /**
   * The next step the failure stated for itself, when it stated one.
   *
   * Present exactly when the failure's own author wrote both halves of it — the
   * reason and what to do about it — so a caller rendering this for an agent can
   * repeat it as it stands. Absent means no next step was ever authored: a
   * renderer carries the `code` and the `message` alone, and says nothing more.
   */
  readonly action?: string;
}

/**
 * The only pre-admission failures that permit a Channel to remove a stale
 * binding and retry once to the Dispatcher Agent. Every other failure — and any
 * `ambiguous` outcome — is never retried.
 */
export type ChannelCommandRetryableErrorCode = 'TEAM_NOT_FOUND' | 'TEAM_CLOSED';
