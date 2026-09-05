/**
 * The dispatcher-scoped half of the one Command registry.
 *
 * Core Commands are process-level and fixed at composition. A Channel's
 * Commands are neither: the instance that serves them is built per dispatcher,
 * per start, and it stops. So they are held here, keyed by the dispatcher that
 * built them, and reached through the same {@link CoreCommands} entry point —
 * there is no second registry, no second invoke path, and no second result.
 *
 * Two scopes, for two different reasons. The `channel.<channel_id>.` namespace
 * keeps two Channels of one dispatcher from colliding; the dispatcher partition
 * lets two dispatchers configure the same channel id without either seeing the
 * other's handler.
 *
 * A registration is also the admission fence for what it registered. A
 * definition exists from the moment its dispatcher's catalog is registered —
 * before any session has started — so that a caller never depends on channel
 * start order. Until the owning session is live, and again once it is closing,
 * the Command answers {@link ChannelCommandUnavailableError}, which says
 * "known, not serving now" rather than "no such Command".
 */
import type {
  ChannelCommandDefinition,
  CoreCommandContext,
  JsonValue,
} from '@excitedjs/dreamux-types';

import { validateDispatcherId } from '../state/dispatcher-id.js';
import { StatedFailure, ValidationError, throwCallerMistake } from './errors.js';

/**
 * The namespace Core reserves for Channel-registered Commands. No Core Command
 * may live under it, which is what makes the two halves of the registry
 * distinguishable by name alone.
 */
export const CHANNEL_COMMAND_PREFIX = 'channel.';

/**
 * One name segment: no dot, so `channel.<channel_id>.<local_name>` parses back
 * to exactly one channel id and one local name.
 *
 * This is the syntax a Channel package authors its `local_name` in. It is a
 * rule on new code — a package chooses its own Command names — so Core rejects
 * a `local_name` it cannot register verbatim rather than rewriting it into
 * something the package never wrote.
 */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const NAME_SEGMENT_RULE =
  'start with an ASCII letter or digit and contain only ASCII letters, ' +
  'digits, underscore, or dash';

/** Code units a channel id may carry into a command name unencoded. */
const CHANNEL_ID_SAFE = /^[A-Za-z0-9_-]$/;

/**
 * Encode one channel id into a single unambiguous name segment.
 *
 * A channel id is operator config, and its contract is "non-empty, unique
 * within its dispatcher" — dots, colons, slashes, and non-ASCII are all legal
 * today. Rejecting them here would narrow a config contract Core already
 * accepted, so the id is encoded rather than refused.
 *
 * The encoding is per UTF-16 code unit, not per code point: an unsafe unit
 * becomes `%` followed by exactly four upper-case hex digits. A JS string is a
 * code-unit sequence and config only promises "non-empty string", so it may
 * hold an unpaired surrogate; a UTF-8 encoder would fold every such unit onto
 * U+FFFD and make two distinct legal ids collide. Encoding the units keeps the
 * map injective over every string the config contract admits.
 *
 * `%` is itself unsafe, so it is encoded too (`a.b` → `a%002Eb`, the literal id
 * `a%002Eb` → `a%0025002Eb`), the fixed width makes the encoding readable back
 * one unit at a time, and the segment contains no dot — so the full name still
 * splits into exactly three parts.
 */
export function encodeChannelId(channelId: string): string {
  let encoded = '';
  for (let index = 0; index < channelId.length; index += 1) {
    const unit = channelId[index] as string;
    if (CHANNEL_ID_SAFE.test(unit)) {
      encoded += unit;
      continue;
    }
    const code = channelId.charCodeAt(index);
    encoded += `%${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

/** The full registered name of one Channel Command. */
export function channelCommandName(
  channelId: string,
  localName: string,
): string {
  return `${CHANNEL_COMMAND_PREFIX}${encodeChannelId(channelId)}.${localName}`;
}

/**
 * The Command is registered, but the Channel instance behind it is not serving:
 * its dispatcher has not started it yet, or it is closing.
 *
 * Retryable by construction — the caller's request was well-formed and the name
 * is real — which is why it is not an `UNKNOWN_METHOD` and not an internal
 * defect.
 */
export class ChannelCommandUnavailableError extends StatedFailure {
  constructor(name: string) {
    super(
      'CHANNEL_COMMAND_UNAVAILABLE',
      `channel command '${name}' is registered but its channel is not serving requests`,
      'Retry once the channel is running; the command name is correct.',
    );
  }
}

/** What the registry keeps for one registered definition. */
interface ChannelCommandEntry {
  readonly name: string;
  readonly definition: ChannelCommandDefinition;
  readonly registration: ChannelCommandRegistration;
}

/**
 * One Channel's registered catalog, and the admission fence over it.
 *
 * It tracks its own accepted invocations because draining is per-Channel: a
 * closing session must let the calls it already accepted finish before its
 * definitions go away, while the rest of the dispatcher keeps serving.
 */
export class ChannelCommandRegistration {
  private admitting = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    readonly dispatcherId: string,
    readonly channelId: string,
    readonly names: readonly string[],
  ) {}

  /** Serve requests. Called once the owning session's own start has returned. */
  openAdmission(): void {
    this.admitting = true;
  }

  /** Refuse further requests. Synchronous and idempotent, like every fence. */
  closeAdmission(): void {
    this.admitting = false;
  }

  get accepting(): boolean {
    return this.admitting;
  }

  /** Await every invocation admitted before the fence closed. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Admit one invocation and run it, as a single indivisible step.
   *
   * Checking the fence, joining the drain set, and starting the handler cannot
   * be three separate statements. The handler is Channel-owned code: it may
   * synchronously reach back into its own session and close it — a bind that
   * fails its precondition and tears the session down does exactly that — and
   * if the fence closed and drained in the window between "admitted" and
   * "tracked", the session would be closed and its definitions revoked while
   * this call was still running. So the drain entry is registered *before* the
   * handler is invoked, and it is a separate promise from the handler's own
   * result so a rejection cannot escape the drain set unobserved.
   *
   * Returns `null` when the fence is closed; the caller turns that into the
   * retryable unavailable failure. It is the only way in, so there is no path
   * that runs a handler without being drained.
   *
   * `run()` is called inside a `try` because a function declared to return a
   * promise can still throw before producing one, and this method is reachable
   * by any holder of a registration. A throw that escaped between the drain
   * entry and the settlement wiring below would leave an entry nothing ever
   * removes, and {@link drain} — which shutdown awaits before closing the
   * session — would never return. The failure is re-raised unchanged; only the
   * bookkeeping is undone.
   */
  admit(run: () => Promise<JsonValue>): Promise<JsonValue> | null {
    if (!this.admitting) return null;
    let settle!: () => void;
    const tracked = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const release = (): void => {
      this.inFlight.delete(tracked);
      settle();
    };
    this.inFlight.add(tracked);
    let result: Promise<JsonValue>;
    try {
      result = run();
    } catch (error) {
      release();
      throw error;
    }
    void result.catch(() => {}).finally(release);
    return result;
  }
}

/**
 * Everything one dispatcher registered in a single atomic step, and the only
 * handle that can take it back.
 *
 * The batch is the unit because the catalog is validated as a whole: a
 * dispatcher whose second Channel declares a colliding name registers neither,
 * so a failed start never leaves half a catalog behind. It is also the
 * dispatcher's registration lease — while it is live no other batch may
 * register for that dispatcher, whether or not it named a single Command.
 */
export class ChannelCommandBatch {
  constructor(
    private readonly owner: ChannelCommands,
    readonly dispatcherId: string,
    private readonly registrations: ReadonlyMap<
      string,
      ChannelCommandRegistration
    >,
  ) {}

  /** The registration for one channel of this batch, or `null`. */
  get(channelId: string): ChannelCommandRegistration | null {
    return this.registrations.get(channelId) ?? null;
  }

  /** Every registered name, keyed by channel. Read-only projection. */
  namesByChannel(): ReadonlyMap<string, readonly string[]> {
    return new Map(
      [...this.registrations].map(([channelId, registration]) => [
        channelId,
        registration.names,
      ]),
    );
  }

  closeAdmission(): void {
    for (const registration of this.registrations.values()) {
      registration.closeAdmission();
    }
  }

  async drain(): Promise<void> {
    for (const registration of this.registrations.values()) {
      await registration.drain();
    }
  }

  /**
   * Remove every definition this batch registered and release the dispatcher.
   * Idempotent, and the only way the next start gets to register.
   */
  unregister(): void {
    for (const registration of this.registrations.values()) {
      this.owner.revoke(registration);
    }
    this.owner.release(this);
  }
}

/** What one Channel instance contributed to a dispatcher's catalog. */
export interface ChannelCommandSource {
  readonly channelId: string;
  readonly definitions: readonly ChannelCommandDefinition[];
}

/**
 * The registration half of the Command port, as a dispatcher sees it.
 *
 * A dispatcher registers and revokes its Channels' catalogs; it never reaches
 * the registry to invoke one. Naming that as its own interface keeps the
 * lifecycle's dependency exactly as wide as what it does.
 */
export interface ChannelCommandRegistrar {
  registerChannelCommands(
    dispatcherId: string,
    sources: readonly ChannelCommandSource[],
  ): ChannelCommandBatch;
  channelCommandNames(dispatcherId: string): readonly string[];
}

export class ChannelCommands {
  /** dispatcher id → full command name → entry. */
  private readonly byDispatcher = new Map<
    string,
    Map<string, ChannelCommandEntry>
  >();
  /**
   * dispatcher id → the batch that currently owns its catalog.
   *
   * Separate from the map above because the two are not the same fact: a
   * dispatcher whose Channels declare no Commands registers an empty catalog
   * and still owns its registration, and only its own batch may give it back.
   */
  private readonly owners = new Map<string, ChannelCommandBatch>();

  /**
   * Validate and register one dispatcher's whole Channel catalog.
   *
   * Nothing is inserted until every definition in every source has passed, so a
   * rejected catalog leaves the registry exactly as it was. Registrations start
   * closed: the definitions are resolvable immediately — that is the point, a
   * caller must not have to know channel start order — but they do not serve
   * until their session is live.
   *
   * One batch owns a dispatcher's whole catalog, so a dispatcher that already
   * has one cannot register a second: the batch is what closes, drains, and
   * revokes, and two of them would each hold half of a lifecycle neither can
   * complete. One source per channel id, and no empty id, for the same reason.
   */
  register(
    dispatcherId: string,
    sources: readonly ChannelCommandSource[],
    assertUnreserved: (name: string) => void,
  ): ChannelCommandBatch {
    const staged = new Map<string, ChannelCommandEntry>();
    const registrations = new Map<string, ChannelCommandRegistration>();
    if (this.owners.has(dispatcherId)) {
      throw new Error(
        `dispatcher ${JSON.stringify(dispatcherId)} already has a registered ` +
          'channel command catalog; revoke it before registering another',
      );
    }
    for (const source of sources) {
      if (source.channelId === '') {
        // An empty id would encode to an empty segment, so `channel..name`
        // would name a channel that cannot be identified — and the batch could
        // not report which channel to close. Config forbids it; the registry
        // says so itself rather than trusting its caller.
        throw new Error(
          `dispatcher ${JSON.stringify(dispatcherId)} registered channel ` +
            'commands for an empty channel id',
        );
      }
      if (registrations.has(source.channelId)) {
        // One registration per channel is what makes the batch a complete
        // handle: a second source for the same id would leave the first
        // source's entries owned by a registration the batch no longer holds,
        // so nothing could close, drain, or revoke them.
        throw new Error(
          `dispatcher ${JSON.stringify(dispatcherId)} registered channel ` +
            `commands for ${JSON.stringify(source.channelId)} twice`,
        );
      }
      const names: string[] = [];
      const registration = new ChannelCommandRegistration(
        dispatcherId,
        source.channelId,
        names,
      );
      for (const definition of source.definitions) {
        const name = validatedName(source.channelId, definition);
        assertUnreserved(name);
        if (staged.has(name)) {
          // Two owners for one name would mean two authorities for one action —
          // the same rule the Core half enforces at composition.
          throw new Error(
            `channel command ${JSON.stringify(name)} is registered twice in ` +
              `dispatcher ${JSON.stringify(dispatcherId)}`,
          );
        }
        staged.set(name, { name, definition, registration });
        names.push(name);
      }
      registrations.set(source.channelId, registration);
    }
    // An all-empty catalog leaves no entry behind: a dispatcher whose Channels
    // declare no Commands must look exactly like one that registered nothing.
    // It still takes the registration lease below — owning nothing is not the
    // same as owning no lifecycle.
    if (staged.size > 0) this.byDispatcher.set(dispatcherId, staged);
    const batch = new ChannelCommandBatch(this, dispatcherId, registrations);
    this.owners.set(dispatcherId, batch);
    return batch;
  }

  /**
   * Give the dispatcher's registration back, if this batch still holds it.
   *
   * Guarded by identity rather than by id so a late `unregister()` from a
   * superseded batch cannot release the run that replaced it.
   */
  release(batch: ChannelCommandBatch): void {
    if (this.owners.get(batch.dispatcherId) === batch) {
      this.owners.delete(batch.dispatcherId);
    }
  }

  /** Remove everything one registration owns. Idempotent. */
  revoke(registration: ChannelCommandRegistration): void {
    const commands = this.byDispatcher.get(registration.dispatcherId);
    if (commands === undefined) return;
    for (const name of registration.names) {
      if (commands.get(name)?.registration === registration) {
        commands.delete(name);
      }
    }
    if (commands.size === 0) this.byDispatcher.delete(registration.dispatcherId);
  }

  resolve(
    dispatcherId: string,
    name: string,
  ): ChannelCommandEntry | undefined {
    return this.byDispatcher.get(dispatcherId)?.get(name);
  }

  /** Every registered name for one dispatcher. Diagnostics only. */
  names(dispatcherId: string): readonly string[] {
    return [...(this.byDispatcher.get(dispatcherId)?.keys() ?? [])];
  }
}

function validatedName(
  channelId: string,
  definition: ChannelCommandDefinition,
): string {
  if (!NAME_SEGMENT.test(definition.local_name)) {
    throw new Error(
      `channel command local_name ${JSON.stringify(definition.local_name)} ` +
        `cannot be part of a command name; it must ${NAME_SEGMENT_RULE}`,
    );
  }
  if (definition.version !== 1) {
    throw new Error(
      `channel command ${JSON.stringify(definition.local_name)} declares ` +
        `version ${JSON.stringify(definition.version)}; only version 1 exists`,
    );
  }
  return channelCommandName(channelId, definition.local_name);
}

/**
 * Read the dispatcher a Channel Command invocation is scoped to.
 *
 * Addressing is validated exactly as it is for a Core dispatcher-scoped
 * Command — the same id rule, the same `RuleViolation` → `BAD_REQUEST`
 * narrowing — so a malformed `dispatcher_id` is the caller's mistake here too
 * rather than falling through to `UNKNOWN_METHOD`, which would tell the caller
 * the Command does not exist when the real fault is the address. What it
 * deliberately does not do is look the dispatcher up: a Channel Command is
 * resolved in the partition its own registration created, so it needs no host.
 */
export function channelCommandDispatcher(
  context: CoreCommandContext,
  name: string,
): string {
  const id = context.dispatcher_id;
  if (id === undefined) {
    throw new ValidationError(
      `channel command '${name}' is dispatcher-scoped and the caller supplied ` +
        'no dispatcher_id',
    );
  }
  try {
    return validateDispatcherId(id);
  } catch (error) {
    // The id rule speaks in its own words; only its type becomes the caller's.
    throwCallerMistake(error);
  }
}
