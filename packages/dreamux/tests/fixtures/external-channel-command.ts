/**
 * A Channel Command authored the way an external provider must author one:
 * importing `@excitedjs/dreamux-types` and nothing else.
 *
 * That single import restriction is the point of this file, and
 * `channel-command-adapters.test.ts` asserts it by reading this source back.
 * An external Channel package may not depend on `@excitedjs/dreamux`, and the
 * types package is declaration-only — it publishes no error base, no registry,
 * and no value at all — so anything this fixture can do is exactly what a real
 * external Channel can do, and anything it cannot do is a capability Core would
 * be pretending to offer.
 *
 * The consequence this fixture exists to pin down is how a refusal is reported.
 * A provider here has no Core failure class to construct, so a business outcome
 * a caller is meant to read and act on is a *value* the handler returns and the
 * declared output schema admits. Throwing is left for what it actually means:
 * an implementation fault nobody classified.
 */
import type {
  ChannelCommandDefinition,
  JsonValue,
} from '@excitedjs/dreamux-types';

interface BindInput {
  readonly chat_id: string;
}

/**
 * The refusal shape, declared in the schema like any other answer.
 *
 * `bound: false` with a provider-owned `reason` is how this Channel says no.
 * A caller branches on the field rather than on an error class it could not
 * import anyway, and the value survives both adapters unchanged because it is
 * an ordinary successful result.
 */
interface BindOutput {
  readonly bound: boolean;
  readonly reason: string | null;
}

/**
 * One Command that answers, and refuses, entirely through its own output.
 *
 * `refuse` decides which of the two declared answers this instance gives, so a
 * test can drive the refusal path without the fixture needing a second
 * definition or any Core-owned vocabulary.
 */
export function externalBindCommand(options: {
  localName: string;
  refuse?: (input: BindInput) => string | null;
}): ChannelCommandDefinition {
  const definition: ChannelCommandDefinition<BindInput, BindOutput> = {
    local_name: options.localName,
    version: 1,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { chat_id: { type: 'string' } },
      required: ['chat_id'],
    },
    output: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bound: { type: 'boolean' },
        reason: { type: ['string', 'null'] },
      },
      required: ['bound', 'reason'],
    },
    parse(payload: JsonValue): BindInput {
      return { chat_id: (payload as { chat_id: string }).chat_id };
    },
    async execute(_context, input): Promise<BindOutput> {
      const reason = options.refuse?.(input) ?? null;
      return reason === null
        ? { bound: true, reason: null }
        : { bound: false, reason };
    },
  };
  return definition as ChannelCommandDefinition;
}

/**
 * The other half of the contract: a handler that genuinely breaks.
 *
 * A provider authored against the types package alone can only throw an
 * ordinary `Error`, so this is the most a real external Channel can express by
 * throwing — and the test pins what Core makes of it.
 */
export function externalFaultingCommand(
  localName: string,
): ChannelCommandDefinition {
  const definition: ChannelCommandDefinition<BindInput, BindOutput> = {
    ...(externalBindCommand({ localName }) as ChannelCommandDefinition<
      BindInput,
      BindOutput
    >),
    async execute(): Promise<BindOutput> {
      throw new Error('the channel provider hit an unhandled condition');
    },
  };
  return definition as ChannelCommandDefinition;
}
