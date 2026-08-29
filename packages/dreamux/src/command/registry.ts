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

export class CoreCommands implements CoreCommandRegistry {
  private readonly commands = new Map<string, AnyCoreCommand>();

  constructor(definitions: readonly AnyCoreCommand[]) {
    for (const definition of definitions) {
      if (this.commands.has(definition.name)) {
        // Two owners for one name would mean two authorities for one action.
        throw new Error(
          `core command ${JSON.stringify(definition.name)} is registered twice`,
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

  async invoke(
    context: CoreCommandContext,
    name: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    const definition = this.commands.get(name);
    if (definition === undefined) {
      throw new UnknownCommandError(name);
    }
    const bounded = boundedPayload(payload);
    validateInput(definition, bounded);
    const input = definition.parse(bounded);
    const output = await definition.execute(context, input);
    // Canonicalize before validating, so the schema checks the value adapters
    // actually receive rather than the pre-serialization object graph.
    const result = canonicalResult(definition, output);
    validateOutput(definition, result);
    return result;
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
function canonicalResult(definition: AnyCoreCommand, output: unknown): JsonValue {
  try {
    return canonicalJsonValue(output, JSON_VALUE_UNBOUNDED);
  } catch (error) {
    if (error instanceof JsonValueError) {
      throw new InternalError(
        `${definition.name} produced a result that is not JSON-representable ` +
          `— ${error.message}`,
      );
    }
    throw error;
  }
}

function validateInput(definition: AnyCoreCommand, payload: JsonValue): void {
  try {
    validateJsonSchema(payload, definition.input);
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new ValidationError(
        `invalid ${definition.name} payload — ${error.message}`,
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
function validateOutput(definition: AnyCoreCommand, output: JsonValue): void {
  try {
    validateJsonSchema(output, definition.output);
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new InternalError(
        `${definition.name} produced a result that violates its declared ` +
          `output schema — ${error.message}`,
      );
    }
    throw error;
  }
}
