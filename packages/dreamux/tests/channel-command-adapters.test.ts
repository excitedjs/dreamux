/**
 * Adapter equivalence for the dispatcher-scoped half of the registry.
 *
 * A Channel Command is registered by a dispatcher and served by a Channel, but
 * it is still a Command in the one registry — so the `admin.sock` NDJSON server
 * and the in-process Channel invoker must answer it identically, including its
 * two failures that have no Core analogue (`CHANNEL_COMMAND_UNAVAILABLE`, and a
 * name that resolves only inside its own dispatcher partition).
 *
 * Both adapters here are the real production objects over one shared
 * `CoreCommandPort`, exactly as `core-command-adapters.test.ts` builds them for
 * the Core half.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import type { ChannelCommandBatch } from '../src/command/channel-commands.js';
import {
  externalBindCommand,
  externalFaultingCommand,
} from './fixtures/external-channel-command.js';
import {
  createCommandHarness,
  createHarnessChannelInvoker,
  fakeChannelCommand,
  startHarnessAdminSocket,
  HARNESS_CHANNEL_ID,
  HARNESS_DISPATCHER_ID,
  type CommandHarness,
  type HarnessAdminSocket,
} from './helpers/command-harness.js';

const NAME = `channel.${HARNESS_CHANNEL_ID}.ping`;

/** Register one open Channel Command into a harness's real registry. */
function registerPing(
  harness: CommandHarness,
  overrides: Parameters<typeof fakeChannelCommand>[1] = {},
): ChannelCommandBatch {
  const batch = harness.port.registerChannelCommands(HARNESS_DISPATCHER_ID, [
    {
      channelId: HARNESS_CHANNEL_ID,
      definitions: [fakeChannelCommand('ping', overrides)],
    },
  ]);
  batch.get(HARNESS_CHANNEL_ID)?.openAdmission();
  return batch;
}

describe('a Channel Command answers identically through both adapters', () => {
  let admin: HarnessAdminSocket | null = null;
  let batch: ChannelCommandBatch | null = null;

  afterEach(async () => {
    batch?.unregister();
    batch = null;
    if (admin !== null) {
      await admin.close();
      admin = null;
    }
  });

  it('returns the same result to an admin.sock caller and to the Channel invoker', async () => {
    const harness = createCommandHarness();
    batch = registerPing(harness);
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    // The admin caller states the dispatcher in its envelope; the Channel
    // invoker bound it once at construction. Both address the same partition.
    const viaAdmin = await admin.send(NAME, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      note: 'hello',
    });
    const viaChannel = await lease.port.invoke.invoke(NAME, { note: 'hello' });

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
    expect(viaChannel).toEqual({ echoed: 'hello' });
  });

  it('rejects an invalid payload as BAD_REQUEST on both, without the Channel handler running', async () => {
    const execute = vi.fn(async () => ({ echoed: 'never' }));
    const harness = createCommandHarness();
    batch = registerPing(harness, { execute });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send(NAME, { dispatcher_id: HARNESS_DISPATCHER_ID });
    expect(viaAdmin.ok).toBe(false);
    expect((viaAdmin as { error: { code: string } }).error.code).toBe('BAD_REQUEST');

    await expect(lease.port.invoke.invoke(NAME, {})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports CHANNEL_COMMAND_UNAVAILABLE on both while the registration is fenced', async () => {
    const harness = createCommandHarness();
    batch = registerPing(harness);
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    batch.closeAdmission();

    const viaAdmin = await admin.send(NAME, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      note: 'x',
    });
    expect(viaAdmin.ok).toBe(false);
    expect((viaAdmin as { error: { code: string; action?: string } }).error).toMatchObject({
      code: 'CHANNEL_COMMAND_UNAVAILABLE',
      action: expect.stringContaining('Retry'),
    });

    await expect(lease.port.invoke.invoke(NAME, { note: 'x' })).rejects.toMatchObject({
      code: 'CHANNEL_COMMAND_UNAVAILABLE',
    });
  });

  it('reports UNKNOWN_METHOD on both once the batch is revoked', async () => {
    const harness = createCommandHarness();
    const registered = registerPing(harness);
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    registered.unregister();

    const viaAdmin = await admin.send(NAME, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      note: 'x',
    });
    expect((viaAdmin as { error: { code: string } }).error.code).toBe('UNKNOWN_METHOD');
    await expect(lease.port.invoke.invoke(NAME, { note: 'x' })).rejects.toMatchObject({
      code: 'UNKNOWN_METHOD',
    });
  });

  it('answers BAD_REQUEST on an admin call that names no dispatcher, and UNKNOWN_METHOD on one that names another', async () => {
    // The Channel invoker cannot produce either case — it binds its own
    // dispatcher at construction and never reads one from the caller — so this
    // is where the two adapters legitimately differ in what they can express,
    // and the admin half must still classify both correctly.
    const harness = createCommandHarness();
    batch = registerPing(harness);
    admin = await startHarnessAdminSocket(harness);

    const missing = await admin.send(NAME, { note: 'x' });
    expect((missing as { error: { code: string } }).error.code).toBe('BAD_REQUEST');

    const malformed = await admin.send(NAME, {
      dispatcher_id: 'not a valid id',
      note: 'x',
    });
    expect((malformed as { error: { code: string } }).error.code).toBe('BAD_REQUEST');

    const otherDispatcher = await admin.send(NAME, {
      dispatcher_id: 'some-other-dispatcher',
      note: 'x',
    });
    expect((otherDispatcher as { error: { code: string } }).error.code).toBe(
      'UNKNOWN_METHOD',
    );
  });

  it('carries a Channel-authored refusal as an ordinary result on both adapters', async () => {
    // A refusal a caller acts on is a declared *output*, not a throw: an
    // external Channel imports `@excitedjs/dreamux-types` only, and that
    // package is declaration-only — there is no Core error base for it to
    // construct. So this is the whole refusal mechanism a real provider has,
    // and both adapters must carry it unchanged.
    const harness = createCommandHarness();
    const registered = harness.port.registerChannelCommands(HARNESS_DISPATCHER_ID, [
      {
        channelId: HARNESS_CHANNEL_ID,
        definitions: [
          externalBindCommand({
            localName: 'bind',
            refuse: (input) =>
              input.chat_id === 'p2p-chat' ? 'a p2p chat is never bindable' : null,
          }),
        ],
      },
    ]);
    registered.get(HARNESS_CHANNEL_ID)?.openAdmission();
    batch = registered;
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);
    const bind = `channel.${HARNESS_CHANNEL_ID}.bind`;

    const refusedViaAdmin = await admin.send(bind, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      chat_id: 'p2p-chat',
    });
    expect(refusedViaAdmin.ok).toBe(true);
    expect((refusedViaAdmin as { result: unknown }).result).toEqual({
      bound: false,
      reason: 'a p2p chat is never bindable',
    });
    await expect(lease.port.invoke.invoke(bind, { chat_id: 'p2p-chat' })).resolves.toEqual(
      { bound: false, reason: 'a p2p chat is never bindable' },
    );

    const acceptedViaAdmin = await admin.send(bind, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      chat_id: 'oc-group',
    });
    expect((acceptedViaAdmin as { result: unknown }).result).toEqual({
      bound: true,
      reason: null,
    });
    await expect(lease.port.invoke.invoke(bind, { chat_id: 'oc-group' })).resolves.toEqual(
      { bound: true, reason: null },
    );
  });

  it('reports an ordinary throw from a Channel handler as INTERNAL on both adapters', async () => {
    // The most an externally-authored handler can express by throwing, since
    // it has no Core failure class: a plain `Error`. Core does not invent a
    // next step for it — it is an unclassified implementation fault, and both
    // adapters say exactly that.
    const harness = createCommandHarness();
    const registered = harness.port.registerChannelCommands(HARNESS_DISPATCHER_ID, [
      {
        channelId: HARNESS_CHANNEL_ID,
        definitions: [externalFaultingCommand('bind')],
      },
    ]);
    registered.get(HARNESS_CHANNEL_ID)?.openAdmission();
    batch = registered;
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);
    const bind = `channel.${HARNESS_CHANNEL_ID}.bind`;

    const viaAdmin = await admin.send(bind, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      chat_id: 'oc-group',
    });
    expect((viaAdmin as { error: unknown }).error).toEqual({
      code: 'INTERNAL',
      message: 'the channel provider hit an unhandled condition',
    });
    await expect(
      lease.port.invoke.invoke(bind, { chat_id: 'oc-group' }),
    ).rejects.toMatchObject({
      message: 'the channel provider hit an unhandled condition',
    });
  });

  it('refuses a result its own declared output schema does not admit', async () => {
    // The counterpart guarantee to "a refusal is a declared output": the
    // declaration is enforced, so a Channel cannot smuggle an undeclared shape
    // through the same door.
    const harness = createCommandHarness();
    const registered = harness.port.registerChannelCommands(HARNESS_DISPATCHER_ID, [
      {
        channelId: HARNESS_CHANNEL_ID,
        definitions: [
          {
            ...externalBindCommand({ localName: 'bind' }),
            async execute() {
              return { bound: false, reason: null, internal_detail: 'leaked' };
            },
          },
        ],
      },
    ]);
    registered.get(HARNESS_CHANNEL_ID)?.openAdmission();
    batch = registered;
    const lease = createHarnessChannelInvoker(harness);

    await expect(
      lease.port.invoke.invoke(`channel.${HARNESS_CHANNEL_ID}.bind`, {
        chat_id: 'oc-group',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('the external fixture depends on @excitedjs/dreamux-types alone', () => {
    // The guarantee the two tests above rest on. If this fixture ever reaches
    // into the host package, they stop proving anything about what an external
    // Channel can do — so the import restriction is asserted, not assumed.
    const fixture = readFileSync(
      new URL('./fixtures/external-channel-command.ts', import.meta.url),
      'utf8',
    );
    const imports = [...fixture.matchAll(/from\s+'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(['@excitedjs/dreamux-types']);
  });

  it('is refused by the process shutdown fence on both adapters, before the Channel handler', async () => {
    const execute = vi.fn(async () => ({ echoed: 'never' }));
    const harness = createCommandHarness();
    batch = registerPing(harness, { execute });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    harness.port.closeAdmission();

    const viaAdmin = await admin.send(NAME, {
      dispatcher_id: HARNESS_DISPATCHER_ID,
      note: 'x',
    });
    expect((viaAdmin as { error: { code: string } }).error.code).toBe(
      'SERVER_SHUTTING_DOWN',
    );
    await expect(lease.port.invoke.invoke(NAME, { note: 'x' })).rejects.toMatchObject({
      code: 'SERVER_SHUTTING_DOWN',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies the same payload bounds a Core Command gets', async () => {
    const harness = createCommandHarness();
    batch = registerPing(harness);
    const lease = createHarnessChannelInvoker(harness);
    const { COMMAND_PAYLOAD_BOUNDS } = await import('../src/command/registry.js');

    await expect(
      lease.port.invoke.invoke(NAME, {
        note: 'x'.repeat(COMMAND_PAYLOAD_BOUNDS.maxBytes + 1_024),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('registration reaches the registry only through the port, and the port never fences it', () => {
    // Registration is the process composing itself, not a caller reaching in,
    // so it is deliberately outside the admission fence — otherwise a
    // dispatcher could never register after any prior shutdown fenced the port.
    const harness = createCommandHarness();
    harness.port.closeAdmission();

    const registered = harness.port.registerChannelCommands('late-dispatcher', [
      { channelId: 'c1', definitions: [fakeChannelCommand('ping')] },
    ]);
    expect(harness.port.channelCommandNames('late-dispatcher')).toEqual([
      'channel.c1.ping',
    ]);
    registered.unregister();
  });
});
