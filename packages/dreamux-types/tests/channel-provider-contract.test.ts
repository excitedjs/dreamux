/**
 * Channel provider/session/instance seam (issue #209 minimize-provider-boundaries).
 *
 * A Channel session is controlled directly in-process through a small
 * lifecycle (`initialize`/`start`/`close`) and reaches Core through exactly
 * two generic ports (the Command invoker and the live event source). Every
 * `ChannelSession.reply`/`react` shorthand, every routing/target concept
 * (`ChannelRoutes`, `resolveTarget`, `resolveInboundBinding`,
 * `messageBelongsToTarget`), and MCP composition are deliberately NOT part of
 * the base lifecycle — MCP is an optional, separately-composed capability so a
 * Channel with no tools implements no fake members.
 */
import { describe, expect, it } from 'vitest';

import type {
  ChannelCommandCapability,
  ChannelCommandDefinition,
  ChannelCorePort,
  ChannelCoreEvent,
  ChannelEventSource,
  ChannelEventSubscription,
  ChannelInstance,
  ChannelProvider,
  ChannelSession,
} from '../src/channel.js';
import type { JsonValue } from '../src/json.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B
  ? 1
  : 0
  ? true
  : false;

function assertType<T extends true>(_proof?: T): void {
  // Compile-time-only: see agent-runtime-handle-contract.test.ts for the pattern's rationale.
}

describe('ChannelSession is exactly initialize/start/close — no reply/react shorthand', () => {
  it('the interface has no member beyond the three lifecycle methods', () => {
    assertType<Equal<keyof ChannelSession, 'initialize' | 'start' | 'close'>>();
  });

  it('a fake session runs the full lifecycle: initialize before start, close awaits its own tail', async () => {
    const calls: string[] = [];
    let mutationTailSettled = false;

    const port: ChannelCorePort = {
      invoke: {
        async invoke(method: string, _params: JsonValue): Promise<JsonValue> {
          calls.push(`invoke:${method}`);
          return null;
        },
      },
      events: {
        subscribe(): ChannelEventSubscription {
          calls.push('subscribe');
          return { unsubscribe: () => calls.push('unsubscribe') };
        },
      },
    };

    const session: ChannelSession = {
      async initialize(receivedPort: ChannelCorePort): Promise<void> {
        calls.push('initialize');
        // A real Channel attaches its event consumer here, before any
        // external I/O opens — that ordering is what makes
        // subscribe-before-admission provable.
        receivedPort.events.subscribe(() => {});
      },
      async start(): Promise<void> {
        calls.push('start');
      },
      async close(): Promise<void> {
        calls.push('close');
        await Promise.resolve();
        mutationTailSettled = true;
      },
    };

    await session.initialize(port);
    await session.start();
    await session.close();

    expect(calls).toEqual(['initialize', 'subscribe', 'start', 'close']);
    expect(mutationTailSettled).toBe(true);
  });
});

describe('ChannelCorePort carries exactly the invoke and events generic ports', () => {
  it('no other Core capability leaks in through the port', () => {
    assertType<Equal<keyof ChannelCorePort, 'invoke' | 'events'>>();
  });
});

describe('ChannelEventSource / ChannelEventSubscription stay minimal', () => {
  it('the source exposes only subscribe, the subscription only unsubscribe', () => {
    assertType<Equal<keyof ChannelEventSource, 'subscribe'>>();
    assertType<Equal<keyof ChannelEventSubscription, 'unsubscribe'>>();
  });

  it('subscribe delivers the whole ChannelCoreEvent union to one listener', () => {
    const received: ChannelCoreEvent[] = [];
    const source: ChannelEventSource = {
      subscribe(listener: (event: ChannelCoreEvent) => void | Promise<void>) {
        // Simulate one live delivery.
        void listener({
          schema_version: 1,
          kind: 'team.state',
          occurred_at: Date.now(),
          team_name: 'team-1',
          leader_name: 'leader-1',
          status: 'running',
          teammates: [],
        });
        return { unsubscribe: () => {} };
      },
    };

    const subscription = source.subscribe((event) => {
      received.push(event);
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('team.state');
    subscription.unsubscribe();
  });
});

describe('ChannelInstance composes MCP and Commands as optional, never required fake members', () => {
  it('a minimal Channel with no tools and no Commands omits both and still satisfies ChannelInstance', () => {
    const session: ChannelSession = {
      async initialize(): Promise<void> {},
      async start(): Promise<void> {},
      async close(): Promise<void> {},
    };
    const instance: ChannelInstance = { session };

    expect(instance.mcp).toBeUndefined();
    expect(instance.commands).toBeUndefined();
    expect(Object.keys(instance)).toEqual(['session']);
  });

  it('ChannelInstance has exactly session and the optional mcp/commands — nothing else', () => {
    assertType<Equal<keyof ChannelInstance, 'session' | 'mcp' | 'commands'>>();
  });

  it('a Channel that declares Commands composes them beside the session, authored like a Core one', async () => {
    const session: ChannelSession = {
      async initialize(): Promise<void> {},
      async start(): Promise<void> {},
      async close(): Promise<void> {},
    };
    // A Channel-owned Command is a whole definition, not a handler reference:
    // it declares its own schemas and parses its own payload, which is what
    // lets Core validate it through the identical path a Core Command takes.
    const bind: ChannelCommandDefinition<{ chat: string }, { bound: boolean }> = {
      local_name: 'bind_channel',
      version: 1,
      input: {
        type: 'object',
        additionalProperties: false,
        properties: { chat: { type: 'string' } },
        required: ['chat'],
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: { bound: { type: 'boolean' } },
        required: ['bound'],
      },
      parse(payload) {
        return { chat: (payload as { chat: string }).chat };
      },
      async execute() {
        return { bound: true };
      },
    };
    const commands: ChannelCommandCapability = {
      definitions: () => [bind as ChannelCommandDefinition],
    };
    const instance: ChannelInstance = { session, commands };

    expect(instance.commands?.definitions()).toHaveLength(1);
    expect(instance.commands?.definitions()[0]?.local_name).toBe('bind_channel');
    // The whole capability is one method: Core reads a catalog, it never asks
    // a Channel to add, remove, or re-describe one Command at a time.
    assertType<Equal<keyof ChannelCommandCapability, 'definitions'>>();
    assertType<
      Equal<
        keyof ChannelCommandDefinition,
        'local_name' | 'version' | 'input' | 'output' | 'parse' | 'execute'
      >
    >();
  });
});

describe('ChannelProvider composes optional capabilities rather than fake methods', () => {
  it('createSession is the only required member; config/identity/onboard/diagnostic/mcp are optional', () => {
    assertType<
      Equal<
        keyof ChannelProvider<unknown>,
        'createSession' | 'config' | 'identity' | 'onboard' | 'diagnostic' | 'mcp'
      >
    >();
  });

  it('a bare provider that implements only createSession is a valid ChannelProvider', async () => {
    const session: ChannelSession = {
      async initialize(): Promise<void> {},
      async start(): Promise<void> {},
      async close(): Promise<void> {},
    };
    const provider: ChannelProvider<{ token: string }> = {
      async createSession() {
        return { session };
      },
    };

    expect(provider.config).toBeUndefined();
    expect(provider.mcp).toBeUndefined();
    const instance = await provider.createSession({
      dispatcher_id: 'd1',
      channel_id: 'c1',
      provider: 'fake',
      config: { token: 'tok' },
    });
    expect(instance.session).toBe(session);
  });
});
