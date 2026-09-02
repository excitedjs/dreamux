/**
 * The one authoritative Core Command registry.
 *
 * It holds domain-owned {@link CoreCommandDefinition} objects and nothing else:
 * no schema copy, no per-adapter handler table, no exposure/audience property,
 * allowlist, or capability negotiation. Every registered Command is callable
 * through every adapter, subject only to its own input and domain invariants.
 *
 * An adapter's whole job is to name the Command, hand over a JSON payload, and
 * attach its factual caller context. Bounding, validation, resolution, and
 * execution happen here, once — including for the in-process Channel invoker,
 * whose payload never passed through a transport parser at all.
 *
 * The enforced result contract is deliberately precise rather than total: every
 * result is canonicalized through Core's JSON boundary, so what each adapter
 * receives is exactly the value a `JSON.stringify` round trip yields, and is
 * then validated against the Command's declared `output`. That declared shape
 * is closed at the level the Command owns; rich, evolving domain DTOs nested
 * inside it stay open `OBJECT` on purpose.
 *
 * Result *size* is not enforced here at all. Some Commands bound their own
 * result (activity pages, `*.history` cursors); others — `team.list`,
 * `teammate.list` — return one row per persisted entity and are unbounded
 * today. That is accepted: a generic ceiling here would be an arbitrary limit
 * no product path needs, and the right fix for a result that does grow is
 * pagination owned by the domain that produces it.
 */
import type {
  ChannelCommandDefinition,
  CoreCommandContext,
  CoreCommandDefinition,
  CoreCommandRegistry,
  JsonValue,
} from '@excitedjs/dreamux-types';

import {
  canonicalJsonValue,
  JsonValueError,
  JSON_VALUE_UNBOUNDED,
  type JsonValueBounds,
} from '../platform/json-value.js';
import {
  ChannelCommands,
  ChannelCommandUnavailableError,
  channelCommandDispatcher,
  CHANNEL_COMMAND_PREFIX,
  type ChannelCommandBatch,
  type ChannelCommandSource,
} from './channel-commands.js';
import {
  InternalError,
  UnknownCommandError,
  ValidationError,
} from './errors.js';
import {
  SchemaViolation,
  validateJsonSchema,
  validateSchemaDefinition,
} from './validate.js';

/**
 * Core's independent bounds on any Command payload, applied before a Command
 * sees it.
 *
 * The byte budget is the dominating one: `team.submit.text` carries a fully
 * rendered Channel message and the TeamMate tools already advertise 20 000-char
 * prompts, so it is sized well above those (256 KiB) while still refusing a
 * payload no legitimate caller sends. Depth and per-container entry counts are
 * generous relative to the deepest declared schema (a nested `leader`/`repo`
 * object) yet keep a hostile payload from costing unbounded validation work.
 */
export const COMMAND_PAYLOAD_BOUNDS: JsonValueBounds = {
  maxDepth: 16,
  maxEntries: 1024,
  maxBytes: 256 * 1024,
};

/** The canonical payload of an invocation that carried none. */
const EMPTY_PAYLOAD: JsonValue = canonicalJsonValue({}, COMMAND_PAYLOAD_BOUNDS);

/** A definition erased to what the registry itself needs to know. */
export type AnyCoreCommand = CoreCommandDefinition<string, unknown, unknown>;

/**
 * The part of a definition the shared validation steps read. Both halves of the
 * registry satisfy it, which is what lets one set of steps serve both: a
 * Channel Command differs only in how its name was derived.
 */
type SchemaOwner = Pick<AnyCoreCommand, 'input' | 'output'>;

export class CoreCommands implements CoreCommandRegistry {
  private readonly commands = new Map<string, AnyCoreCommand>();
  /**
   * The dispatcher-scoped half. Core Commands are fixed at composition; a
   * Channel's are registered when its dispatcher builds it and revoked when
   * that dispatcher stops, so they cannot live in the map above.
   */
  private readonly channelCommands = new ChannelCommands();

  constructor(definitions: readonly AnyCoreCommand[]) {
    for (const definition of definitions) {
      if (this.commands.has(definition.name)) {
        // Two owners for one name would mean two authorities for one action.
        throw new Error(
          `core command ${JSON.stringify(definition.name)} is registered twice`,
        );
      }
      if (definition.name.startsWith(CHANNEL_COMMAND_PREFIX)) {
        // The prefix is what makes the two halves distinguishable by name
        // alone; a Core Command inside it would make resolution ambiguous.
        throw new Error(
          `core command ${JSON.stringify(definition.name)} uses the reserved ` +
            `${JSON.stringify(CHANNEL_COMMAND_PREFIX)} namespace`,
        );
      }
      // Every declared branch is proven here, not on the first invocation that
      // happens to reach it: a malformed schema is a composition error, so it
      // stops the server from starting rather than surfacing as a request error.
      assertSchemaDefinition(definition, 'input');
      assertSchemaDefinition(definition, 'output');
      this.commands.set(definition.name, definition);
    }
  }

  /** Every registered name, in registration order. Diagnostics only. */
  names(): readonly string[] {
    return [...this.commands.keys()];
  }

  /**
   * Register one dispatcher's whole Channel catalog, atomically.
   *
   * Validation matches the Core half exactly — malformed schemas and duplicate
   * names are composition errors that fail the caller's start, not request
   * errors discovered later.
   */
  registerChannelCommands(
    dispatcherId: string,
    sources: readonly ChannelCommandSource[],
  ): ChannelCommandBatch {
    for (const source of sources) {
      for (const definition of source.definitions) {
        assertChannelSchemaDefinition(source.channelId, definition, 'input');
        assertChannelSchemaDefinition(source.channelId, definition, 'output');
      }
    }
    return this.channelCommands.register(dispatcherId, sources, (name) => {
      if (this.commands.has(name)) {
        throw new Error(
          `channel command ${JSON.stringify(name)} collides with a core command`,
        );
      }
    });
  }

  /** Every Channel Command name registered for one dispatcher. */
  channelCommandNames(dispatcherId: string): readonly string[] {
    return this.channelCommands.names(dispatcherId);
  }

  async invoke(
    context: CoreCommandContext,
    name: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    if (name.startsWith(CHANNEL_COMMAND_PREFIX)) {
      return this.invokeChannelCommand(context, name, payload);
    }
    const definition = this.commands.get(name);
    if (definition === undefined) {
      throw new UnknownCommandError(name);
    }
    const bounded = boundedPayload(payload);
    validateInput(definition, bounded, name);
    const input = definition.parse(bounded);
    const output = await definition.execute(context, input);
    // Canonicalize before validating, so the schema checks the value adapters
    // actually receive rather than the pre-serialization object graph.
    const result = canonicalResult(output, name);
    validateOutput(definition, result, name);
    return result;
  }

  /**
   * One Channel Command, through the identical path.
   *
   * The only two additions are the ones a dynamic registration requires: the
   * dispatcher partition it resolves in, and the admission fence that separates
   * "registered but not serving" from "no such Command". Bounding, validation,
   * parsing, canonicalization, and output checking are the same steps, in the
   * same order, so a Channel Command answers exactly as a Core one does.
   *
   * Everything from `parse` onward runs inside the registration's `admit`,
   * because all of it is Channel-owned code that may synchronously close its
   * own session. Admission and the drain entry are taken together there, so no
   * accepted call can be missed by the drain that precedes session close.
   */
  private async invokeChannelCommand(
    context: CoreCommandContext,
    name: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    const dispatcherId = channelCommandDispatcher(context, name);
    const entry = this.channelCommands.resolve(dispatcherId, name);
    if (entry === undefined) {
      throw new UnknownCommandError(name);
    }
    const bounded = boundedPayload(payload);
    validateInput(entry.definition, bounded, name);
    const admitted = entry.registration.admit(async () => {
      const input = entry.definition.parse(bounded);
      const output = await entry.definition.execute(context, input);
      const result = canonicalResult(output, name);
      validateOutput(entry.definition, result, name);
      return result;
    });
    if (admitted === null) {
      throw new ChannelCommandUnavailableError(name);
    }
    return admitted;
  }
}

/**
 * Canonicalize and bound one invocation payload.
 *
 * An absent payload is the empty object, so a Command with no required input
 * stays callable with no payload at all. Everything else is copied through
 * Core's JSON boundary, which rejects anything a persist/read round trip would
 * reshape, enforces the bounds above, carries a `__proto__` key as ordinary
 * data rather than invoking the prototype setter, and freezes the result — so
 * the payload cannot change under a Command that awaits between reads.
 */
function boundedPayload(payload: JsonValue | undefined): JsonValue {
  if (payload === null || payload === undefined) return EMPTY_PAYLOAD;
  try {
    return canonicalJsonValue(payload, COMMAND_PAYLOAD_BOUNDS);
  } catch (error) {
    if (error instanceof JsonValueError) {
      throw new ValidationError(`command payload ${error.message}`);
    }
    throw error;
  }
}

function assertSchemaDefinition(
  definition: AnyCoreCommand,
  side: 'input' | 'output',
): void {
  try {
    validateSchemaDefinition(definition[side]);
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new Error(
        `core command ${JSON.stringify(definition.name)} declares a malformed ` +
          `${side} schema — ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * The same composition-time schema proof, for a Channel-authored definition.
 *
 * A Channel package is a separate package on its own release line, so a
 * malformed schema is exactly as much a composition error as a Core one — it
 * fails the dispatcher start that tried to register it, naming the channel and
 * the local name an operator can act on.
 */
function assertChannelSchemaDefinition(
  channelId: string,
  definition: ChannelCommandDefinition,
  side: 'input' | 'output',
): void {
  try {
    validateSchemaDefinition(definition[side]);
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new Error(
        `channel ${JSON.stringify(channelId)} command ` +
          `${JSON.stringify(definition.local_name)} declares a malformed ` +
          `${side} schema — ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Put one result through Core's JSON boundary.
 *
 * A schema check alone cannot make a result safe to hand an adapter: an open
 * `OBJECT` only inspects the root, so a nested `undefined`, function, `NaN`,
 * cycle, or class instance would pass and then be silently reshaped — or
 * thrown on — by the adapter's own `JSON.stringify`. Canonicalizing here makes
 * every adapter receive the identical value, and makes a non-representable
 * result a loud `INTERNAL` defect instead of a quietly wrong response.
 *
 * No size ceiling is imposed. Not every result is bounded at its source — a
 * roster listing grows with the persisted entities — but no product path
 * produces an arbitrarily large one, so a generic limit here would only be an
 * arbitrary cutoff. Domain-owned pagination is the answer when one is needed.
 */
function canonicalResult(output: unknown, name: string): JsonValue {
  try {
    return canonicalJsonValue(output, JSON_VALUE_UNBOUNDED);
  } catch (error) {
    if (error instanceof JsonValueError) {
      throw new InternalError(
        `${name} produced a result that is not JSON-representable ` +
          `— ${error.message}`,
      );
    }
    throw error;
  }
}

function validateInput(
  definition: SchemaOwner,
  payload: JsonValue,
  name: string,
): void {
  try {
    validateJsonSchema(payload, definition.input);
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new ValidationError(
        `invalid ${name} payload — ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * A canonical result that does not match its own declared schema is a Core
 * defect, not a caller mistake: it is reported as `INTERNAL` so no adapter
 * presents it as something the caller can fix, and the message names the exact
 * path. The check covers what the Command declares — an open `OBJECT` is
 * checked as an object, deliberately not field by field.
 */
function validateOutput(
  definition: SchemaOwner,
  output: JsonValue,
  name: string,
): void {
  try {
    validateJsonSchema(output, definition.output);
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new InternalError(
        `${name} produced a result that violates its declared ` +
          `output schema — ${error.message}`,
      );
    }
    throw error;
  }
}
