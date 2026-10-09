/**
 * The generic Core Command port's shape.
 *
 * There is one authoritative Command registry, not an admin method table plus a
 * separate Channel catalog. Both adapters — the `admin.sock` NDJSON server and
 * the in-process Channel invoker — resolve the same definition, run the same
 * validation, attach their factual caller context, execute the same domain
 * handler, and return the same typed result or error. See `registry.ts` for the
 * one implementation every adapter shares.
 *
 * Declared in core, not `@excitedjs/dreamux-types`: every consumer of these four
 * types is inside this package. An external Agent Runtime or Channel provider
 * never sees a Command directly — a Channel's own generic port is the published
 * `JsonInvoker` (`@excitedjs/dreamux-types`'s `invoke.ts`), a different seam.
 */
import type { JsonSchema, JsonValue } from '@excitedjs/dreamux-types';

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
