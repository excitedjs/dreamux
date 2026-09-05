/**
 * The dispatcher-scoped half of the one Command registry: name encoding, whole
 * catalog atomicity, the registration lease, and the admission fence.
 *
 * Everything here drives the real `CoreCommands` — through the real
 * `CoreCommandPort` wherever a dispatcher would reach it — rather than a model
 * of it, because the properties under test are exactly the ones a description
 * would get wrong: whether a rejected catalog left residue, whether a name a
 * caller can address resolves to the registration that owns it, and whether a
 * fence and a drain are one indivisible step.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ChannelCommandDefinition } from '@excitedjs/dreamux-types';

import {
  channelCommandName,
  encodeChannelId,
  ChannelCommandRegistration,
  type ChannelCommandSource,
} from '../src/command/channel-commands.js';
import { CoreCommandPort } from '../src/command/port.js';
import { CoreCommands } from '../src/command/registry.js';
import { NO_INPUT, objectSchema } from '../src/command/schema.js';
import type { AnyCoreCommand } from '../src/command/registry.js';
import { fakeChannelCommand } from './helpers/command-harness.js';

const DISPATCHER = 'flow';

/** One empty registry behind the real admitted port, as `Server` composes it. */
function port(coreDefinitions: readonly AnyCoreCommand[] = []): CoreCommandPort {
  return new CoreCommandPort(new CoreCommands(coreDefinitions));
}

function source(
  channelId: string,
  ...definitions: readonly ChannelCommandDefinition[]
): ChannelCommandSource {
  return { channelId, definitions };
}

function channelContext(channelId = 'primary', dispatcherId = DISPATCHER) {
  return {
    source: 'channel' as const,
    dispatcher_id: dispatcherId,
    channel_id: channelId,
  };
}

describe('channel id encoding is injective over every id config admits', () => {
  it('leaves an already-safe id verbatim, so the common name is readable', () => {
    expect(encodeChannelId('primary')).toBe('primary');
    expect(encodeChannelId('feishu-bot_2')).toBe('feishu-bot_2');
    expect(channelCommandName('primary', 'bind_channel')).toBe(
      'channel.primary.bind_channel',
    );
  });

  it('encodes a dot so the full name still splits into exactly three parts', () => {
    // `a.b` unencoded would make `channel.a.b.cmd` parse as channel `a` with
    // local name `b.cmd` — two readings of one name.
    expect(encodeChannelId('a.b')).toBe('a%002Eb');
    expect(channelCommandName('a.b', 'cmd')).toBe('channel.a%002Eb.cmd');
    expect(channelCommandName('a.b', 'cmd').split('.')).toHaveLength(3);
  });

  it('encodes the escape character itself, so an id that spells an encoding is distinct from what it spells', () => {
    // The collision this rules out: id `a.b` and the literal id `a%002Eb` must
    // not produce the same segment.
    expect(encodeChannelId('a%002Eb')).toBe('a%0025002Eb');
    expect(encodeChannelId('a%002Eb')).not.toBe(encodeChannelId('a.b'));
  });

  it('encodes non-ASCII per UTF-16 code unit, keeping a surrogate pair distinct from its parts', () => {
    // U+1F600 is one code point stored as the surrogate pair D83D DE00.
    expect(encodeChannelId('\u{1F600}')).toBe('%D83D%DE00');
    expect(encodeChannelId('中')).toBe('%4E2D');
    expect(encodeChannelId('\uD83D')).toBe('%D83D');
    expect(encodeChannelId('\uDE00')).toBe('%DE00');
  });

  it('keeps two lone surrogates distinct — a UTF-8 encoder would fold both onto U+FFFD', () => {
    // This is why the encoding is per code unit. Config promises "non-empty
    // string", and a JS string may hold an unpaired surrogate; folding them
    // together would let two legal, distinct ids register the same name.
    const first = encodeChannelId('\uD800');
    const second = encodeChannelId('\uDC00');
    const replacement = encodeChannelId('�');
    expect(first).not.toBe(second);
    expect(first).not.toBe(replacement);
    expect(second).not.toBe(replacement);
  });

  it('registers two ids that differ only by an encoded character as two distinct names', () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('a.b', fakeChannelCommand('ping')),
      source('a%002Eb', fakeChannelCommand('ping')),
    ]);
    expect([...registrar.channelCommandNames(DISPATCHER)].sort()).toEqual([
      'channel.a%0025002Eb.ping',
      'channel.a%002Eb.ping',
    ]);
    batch.unregister();
  });
});

describe('registration is whole-catalog and atomic', () => {
  it('refuses an empty channel id rather than registering an unaddressable name', () => {
    const registrar = port();
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('', fakeChannelCommand('ping')),
      ]),
    ).toThrow(/empty channel id/);
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
  });

  it('refuses two sources for one channel id, which would orphan the first registration', () => {
    const registrar = port();
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('primary', fakeChannelCommand('ping')),
        source('primary', fakeChannelCommand('pong')),
      ]),
    ).toThrow(/registered channel commands for "primary" twice/);
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
  });

  it('lets two channels of one dispatcher declare the same local_name, because the id segment separates them', async () => {
    // Encoding is injective, so two distinct channel ids can never produce one
    // name. This is the property that makes a per-Channel `local_name` the
    // Channel's own choice rather than a dispatcher-wide namespace to police.
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
      source('secondary', fakeChannelCommand('ping')),
    ]);
    expect([...registrar.channelCommandNames(DISPATCHER)].sort()).toEqual([
      'channel.primary.ping',
      'channel.secondary.ping',
    ]);
    batch.unregister();
  });

  it('refuses a name one channel declares twice, and leaves nothing behind', () => {
    const registrar = port();
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('primary', fakeChannelCommand('ping'), fakeChannelCommand('ping')),
      ]),
    ).toThrow(/"channel\.primary\.ping" is registered twice/);
    // The whole point of atomicity: the first, valid definition of the pair is
    // not left resolvable by the failure that rejected the second.
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
  });

  it('rejects the whole catalog when a LATER channel fails, leaving the earlier channel unregistered', async () => {
    const registrar = port();
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('primary', fakeChannelCommand('alpha')),
        source('secondary', fakeChannelCommand('beta')),
        // The third channel's own declaration is the one that fails; the first
        // two were perfectly valid and must not survive it.
        source('tertiary', fakeChannelCommand('has.dot')),
      ]),
    ).toThrow(/cannot be part of a command name/);
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
    // And nothing is invocable, not merely unlisted.
    await expect(
      registrar.invoke(channelContext(), 'channel.primary.alpha', { note: 'x' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
    // The rejected attempt also took no lease, so the dispatcher can retry.
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('primary', fakeChannelCommand('alpha')),
      ]),
    ).not.toThrow();
  });

  it('rejects a malformed Channel-declared schema at registration, naming the channel and local name', () => {
    const registrar = port();
    const malformed = fakeChannelCommand('broken', {
      input: { type: 'not-a-real-type' } as never,
    });
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [source('primary', malformed)]),
    ).toThrow(/channel "primary" command "broken" declares a malformed input schema/);
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
  });

  it('rejects a malformed declared OUTPUT schema too, before any invocation could reach it', () => {
    const registrar = port();
    const malformed = fakeChannelCommand('broken', {
      output: { type: 'object', unsupported: true } as never,
    });
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [source('primary', malformed)]),
    ).toThrow(/channel "primary" command "broken" declares a malformed output schema/);
  });

  it('rejects a local_name that cannot be one name segment', () => {
    const registrar = port();
    for (const bad of ['has.dot', '_leading', 'has space', '', 'ünicode']) {
      expect(() =>
        registrar.registerChannelCommands(DISPATCHER, [
          source('primary', fakeChannelCommand(bad)),
        ]),
        `local_name ${JSON.stringify(bad)} must be refused`,
      ).toThrow(/cannot be part of a command name/);
    }
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
  });

  it('rejects a version other than 1, because only version 1 exists', () => {
    const registrar = port();
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('primary', fakeChannelCommand('ping', { version: 2 as never })),
      ]),
    ).toThrow(/only version 1 exists/);
  });

  it('rejects a Channel name that would collide with a Core Command', () => {
    // A Core Command may not live under `channel.`, so the only way to collide
    // is for a Core Command to be named one — which construction already
    // refuses. Both halves of that rule are proven here.
    expect(
      () =>
        new CoreCommands([
          {
            name: 'channel.primary.ping',
            version: 1,
            input: NO_INPUT,
            output: objectSchema({}),
            parse: (payload) => payload,
            execute: async () => ({}),
          } as AnyCoreCommand,
        ]),
    ).toThrow(/reserved "channel\." namespace/);
  });
});

describe('one batch per dispatcher is the registration lease', () => {
  it('refuses a second batch while the first is live', () => {
    const registrar = port();
    registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('other', fakeChannelCommand('pong')),
      ]),
    ).toThrow(/already has a registered channel command catalog/);
    // The live catalog is untouched by the rejected attempt.
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual(['channel.primary.ping']);
  });

  it('an all-empty catalog registers no name but still holds the lease', () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [source('primary')]);
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
    // Owning nothing is not the same as owning no lifecycle: this dispatcher
    // still has a registration, and only its own batch may give it back.
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [source('primary')]),
    ).toThrow(/already has a registered channel command catalog/);
    batch.unregister();
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [
        source('primary', fakeChannelCommand('ping')),
      ]),
    ).not.toThrow();
  });

  it('unregister releases the lease and removes every name it registered', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
      source('secondary', fakeChannelCommand('pong')),
    ]);
    batch.get('primary')?.openAdmission();
    expect(registrar.channelCommandNames(DISPATCHER)).toHaveLength(2);

    batch.unregister();

    expect(registrar.channelCommandNames(DISPATCHER)).toEqual([]);
    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
  });

  it('unregister is idempotent and a superseded batch cannot release the run that replaced it', () => {
    const registrar = port();
    const first = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    first.unregister();
    const second = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('pong')),
    ]);

    // A late `unregister()` from the superseded batch must not revoke the run
    // that replaced it, nor release its lease.
    first.unregister();

    expect(registrar.channelCommandNames(DISPATCHER)).toEqual(['channel.primary.pong']);
    expect(() =>
      registrar.registerChannelCommands(DISPATCHER, [source('primary')]),
    ).toThrow(/already has a registered channel command catalog/);
    second.unregister();
  });

  it('scopes names per dispatcher: two dispatchers may configure the same channel id', async () => {
    const registrar = port();
    const executeA = vi.fn(async () => ({ echoed: 'a' }));
    const executeB = vi.fn(async () => ({ echoed: 'b' }));
    const a = registrar.registerChannelCommands('alpha', [
      source('primary', fakeChannelCommand('ping', { execute: executeA })),
    ]);
    const b = registrar.registerChannelCommands('beta', [
      source('primary', fakeChannelCommand('ping', { execute: executeB })),
    ]);
    a.get('primary')?.openAdmission();
    b.get('primary')?.openAdmission();

    await registrar.invoke(
      channelContext('primary', 'alpha'),
      'channel.primary.ping',
      { note: 'x' },
    );

    expect(executeA).toHaveBeenCalledTimes(1);
    expect(executeB).not.toHaveBeenCalled();

    // And revoking one dispatcher's batch leaves the other's resolvable.
    a.unregister();
    expect(registrar.channelCommandNames('alpha')).toEqual([]);
    expect(registrar.channelCommandNames('beta')).toEqual(['channel.primary.ping']);
    await expect(
      registrar.invoke(channelContext('primary', 'beta'), 'channel.primary.ping', {
        note: 'x',
      }),
    ).resolves.toEqual({ echoed: 'b' });
    b.unregister();
  });
});

describe('addressing a Channel Command is validated exactly as a Core one is', () => {
  it('a missing dispatcher_id is BAD_REQUEST, not a silent default', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke({ source: 'admin_socket' }, 'channel.primary.ping', {
        note: 'x',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    batch.unregister();
  });

  it('a malformed dispatcher_id is BAD_REQUEST, never UNKNOWN_METHOD', async () => {
    // Falling through to UNKNOWN_METHOD would tell the caller the Command does
    // not exist when the real fault is the address it used.
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    batch.get('primary')?.openAdmission();

    for (const malformed of ['-leading-dash', 'has space', 'a'.repeat(65), '']) {
      await expect(
        registrar.invoke(
          { source: 'admin_socket', dispatcher_id: malformed },
          'channel.primary.ping',
          { note: 'x' },
        ),
        `dispatcher_id ${JSON.stringify(malformed)} must be a caller mistake`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    batch.unregister();
  });

  it('a well-formed dispatcher_id that registered nothing is UNKNOWN_METHOD', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke(
        { source: 'admin_socket', dispatcher_id: 'some-other-dispatcher' },
        'channel.primary.ping',
        { note: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
    batch.unregister();
  });

  it('a valid dispatcher_id resolves and executes', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke(
        { source: 'admin_socket', dispatcher_id: DISPATCHER },
        'channel.primary.ping',
        { note: 'hello' },
      ),
    ).resolves.toEqual({ echoed: 'hello' });
    batch.unregister();
  });
});

describe('a Channel Command answers through the identical validation path', () => {
  it('validates the Channel-declared input before the handler runs', async () => {
    const registrar = port();
    const execute = vi.fn(async () => ({ echoed: 'never' }));
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping', { execute })),
    ]);
    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { wrong: 1 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
    batch.unregister();
  });

  it('reports a Channel result that violates its own declared output as INTERNAL, not the caller mistake', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source(
        'primary',
        fakeChannelCommand('ping', { execute: async () => ({}) as never }),
      ),
    ]);
    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    batch.unregister();
  });

  it('reports a non-JSON-representable Channel result as INTERNAL', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source(
        'primary',
        fakeChannelCommand('ping', {
          execute: async () => ({ echoed: () => {} }) as never,
        }),
      ),
    ]);
    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    batch.unregister();
  });

  it('passes the caller context through untouched, so a handler reads who called it', async () => {
    const registrar = port();
    const seen: unknown[] = [];
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source(
        'primary',
        fakeChannelCommand('ping', {
          async execute(context, input) {
            seen.push(context);
            return { echoed: input.note };
          },
        }),
      ),
    ]);
    batch.get('primary')?.openAdmission();

    await registrar.invoke(channelContext('primary'), 'channel.primary.ping', {
      note: 'x',
    });

    expect(seen).toEqual([
      { source: 'channel', dispatcher_id: DISPATCHER, channel_id: 'primary' },
    ]);
    batch.unregister();
  });
});

describe('the admission fence separates "not serving" from "no such Command"', () => {
  it('a registered but never-opened Command answers CHANNEL_COMMAND_UNAVAILABLE, retryably', async () => {
    const registrar = port();
    const execute = vi.fn(async () => ({ echoed: 'never' }));
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping', { execute })),
    ]);

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).rejects.toMatchObject({
      code: 'CHANNEL_COMMAND_UNAVAILABLE',
      action: expect.stringContaining('Retry'),
    });
    // Never reached the Channel's own handler, so nothing partial happened.
    expect(execute).not.toHaveBeenCalled();
    batch.unregister();
  });

  it('opens per registration, not per batch: one channel serving does not open its sibling', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
      source('secondary', fakeChannelCommand('pong')),
    ]);

    batch.get('primary')?.openAdmission();

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).resolves.toEqual({ echoed: 'x' });
    await expect(
      registrar.invoke(channelContext('secondary'), 'channel.secondary.pong', {
        note: 'x',
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_COMMAND_UNAVAILABLE' });
    batch.unregister();
  });

  it('a fenced Command answers unavailable rather than unknown, because the name is still real', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    batch.get('primary')?.openAdmission();
    batch.closeAdmission();

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_COMMAND_UNAVAILABLE' });
    // Still listed: fenced is not revoked.
    expect(registrar.channelCommandNames(DISPATCHER)).toEqual(['channel.primary.ping']);
    batch.unregister();
  });

  it('closeAdmission is idempotent and openAdmission after it serves again', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping')),
    ]);
    const registration = batch.get('primary')!;
    registration.closeAdmission();
    registration.closeAdmission();
    expect(registration.accepting).toBe(false);
    registration.openAdmission();
    expect(registration.accepting).toBe(true);

    await expect(
      registrar.invoke(channelContext(), 'channel.primary.ping', { note: 'x' }),
    ).resolves.toEqual({ echoed: 'x' });
    batch.unregister();
  });
});

describe('drain converges what admission already accepted', () => {
  it('a handler that closes its own session synchronously is still drained', async () => {
    // The race `admit` exists for: a bind that fails its precondition tears its
    // session down from inside the handler. If the fence-check and the drain
    // entry were separate statements, this call would be running against state
    // that shutdown believed it had already converged.
    const registrar = port();
    let batchRef: { closeAdmission(): void } | null = null;
    let handlerFinished = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source(
        'primary',
        fakeChannelCommand('bind', {
          async execute(_context, input) {
            // Synchronously, before its first await: exactly the reentry the
            // indivisible admit step has to survive.
            batchRef?.closeAdmission();
            await gate;
            handlerFinished = true;
            return { echoed: input.note };
          },
        }),
      ),
    ]);
    batchRef = batch;
    batch.get('primary')?.openAdmission();

    const inFlight = registrar.invoke(channelContext(), 'channel.primary.bind', {
      note: 'x',
    });
    // The fence the handler itself closed is already refusing the next caller.
    await expect(
      registrar.invoke(channelContext(), 'channel.primary.bind', { note: 'y' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_COMMAND_UNAVAILABLE' });

    const drained = batch.drain().then(() => {
      // Drain must not resolve before the accepted call finished.
      expect(handlerFinished).toBe(true);
    });
    release();
    await Promise.all([inFlight, drained]);
    batch.unregister();
  });

  it('drain returns even when the admitted handler rejects', async () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source(
        'primary',
        fakeChannelCommand('ping', {
          async execute() {
            throw new Error('channel handler blew up');
          },
        }),
      ),
    ]);
    batch.get('primary')?.openAdmission();

    const rejected = registrar.invoke(channelContext(), 'channel.primary.ping', {
      note: 'x',
    });
    await expect(rejected).rejects.toThrow(/channel handler blew up/);
    // A rejection that escaped the drain set unobserved would hang this await.
    await expect(batch.drain()).resolves.toBeUndefined();
    batch.unregister();
  });

  it('a run that throws synchronously leaves no entry the drain would wait on forever', async () => {
    // `admit` takes the drain entry before it calls `run`, so a `run` that
    // throws before ever producing a promise must still release that entry.
    // Driven directly against the registration because the registry always
    // hands `admit` an async function; this proves the primitive itself.
    const registration = new ChannelCommandRegistration(DISPATCHER, 'primary', []);
    registration.openAdmission();

    expect(() =>
      registration.admit((): Promise<never> => {
        throw new Error('synchronous handler failure');
      }),
    ).toThrow(/synchronous handler failure/);

    await expect(registration.drain()).resolves.toBeUndefined();
  });

  it('a run that returns an already-rejected promise is likewise released', async () => {
    const registration = new ChannelCommandRegistration(DISPATCHER, 'primary', []);
    registration.openAdmission();

    const admitted = registration.admit(() =>
      Promise.reject(new Error('already rejected')),
    );
    await expect(admitted).rejects.toThrow(/already rejected/);

    await expect(registration.drain()).resolves.toBeUndefined();
  });

  it('drain on a fence that never admitted anything returns immediately', async () => {
    const registration = new ChannelCommandRegistration(DISPATCHER, 'primary', []);
    expect(registration.admit(async () => null)).toBeNull();
    await expect(registration.drain()).resolves.toBeUndefined();
  });
});

describe('the batch is a read model of what it registered', () => {
  it('reports names per channel, and nothing for a channel it does not hold', () => {
    const registrar = port();
    const batch = registrar.registerChannelCommands(DISPATCHER, [
      source('primary', fakeChannelCommand('ping'), fakeChannelCommand('pong')),
      source('quiet'),
    ]);

    expect(batch.get('primary')?.names).toEqual([
      'channel.primary.ping',
      'channel.primary.pong',
    ]);
    expect(batch.get('quiet')?.names).toEqual([]);
    expect(batch.get('never-configured')).toBeNull();
    expect([...batch.namesByChannel()]).toEqual([
      ['primary', ['channel.primary.ping', 'channel.primary.pong']],
      ['quiet', []],
    ]);
    batch.unregister();
  });
});
