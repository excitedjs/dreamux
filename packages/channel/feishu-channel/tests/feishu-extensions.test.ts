/**
 * The Feishu plugin and its extension surface, driven the way Dreamux drives
 * them: the plugin's factory, its contributed provider captured through a
 * `ContributeHost`, extensions registered through the published api, and
 * sessions created by that provider over a fake bot.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ChannelCorePort,
  ChannelMcpCaller,
  ChannelProvider,
  ContributeHost,
  DreamuxLogger,
  DreamuxPlugin,
  ServerHost,
} from '@excitedjs/dreamux-types';

import feishuPluginFactory, {
  createFeishuPlugin,
  type FeishuApi,
  type FeishuExtension,
  type FeishuExtensionContext,
  type FeishuExtensionTool,
  type FeishuInstanceApi,
} from '../src/index.js';
import type { FeishuChannelConfig } from '../src/provider.js';
import { FeishuOperationError } from '../src/feishu-bounded-operation.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-extensions-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Loaded {
  plugin: DreamuxPlugin;
  api: FeishuApi;
  provider: ChannelProvider<FeishuChannelConfig>;
}

/** Run the plugin's `contribute` and hand back what Dreamux would hold. */
function loadFeishu(bots: FakeFeishuBot[] = []): Loaded {
  let next = 0;
  const plugin = createFeishuPlugin({
    botFactory: () => bots[next++] ?? createFakeFeishuBot(),
  });
  const provided: ChannelProvider<unknown>[] = [];
  const host: ContributeHost = {
    logger: silentLog,
    channelProviders: {
      contribute: (name, provider) => {
        expect(name).toBe('feishu');
        provided.push(provider as ChannelProvider<unknown>);
      },
    },
    agentRuntimeProviders: {
      contribute: () => {
        throw new Error('the Feishu plugin contributes no agent runtime');
      },
    },
  };
  plugin.contribute?.(host);
  expect(provided).toHaveLength(1);
  return {
    plugin,
    api: plugin.api as FeishuApi,
    provider: provided[0] as ChannelProvider<FeishuChannelConfig>,
  };
}

function inertPort(): ChannelCorePort {
  return {
    invoke: { invoke: async () => ({}) },
    events: { subscribe: () => ({ unsubscribe: () => undefined }) },
  };
}

function tool<S>(
  name: string,
  callers: FeishuExtensionTool<S>['callers'],
  handle: FeishuExtensionTool<S>['handle'] = async () => ({ ok: true }),
): FeishuExtensionTool<S> {
  return {
    name,
    title: name,
    description: `${name} test tool`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: {},
    callers,
    parse: (raw) => raw,
    handle,
  };
}

function extension<S>(
  name: string,
  parts: Partial<FeishuExtension<S>> = {},
): FeishuExtension<S> {
  return {
    name,
    tools: [],
    cardActions: [],
    initialize: async () => undefined as S,
    start: async () => undefined,
    close: async () => undefined,
    ...parts,
  };
}

async function createSession(
  provider: ChannelProvider<FeishuChannelConfig>,
  channelId = 'primary',
) {
  return provider.createSession({
    dispatcher_id: 'disp-1',
    channel_id: channelId,
    provider: 'builtin:feishu',
    config: { appId: 'app-1', appSecret: 'secret' },
    logger: silentLog,
    state_root: dir,
    cache_root: dir,
  });
}

const DISPATCHER: ChannelMcpCaller = { kind: 'dispatcher' };
const LEADER: ChannelMcpCaller = {
  kind: 'team_leader',
  team_name: 'alpha',
  leader_name: 'alpha-leader',
};

describe('the Feishu plugin', () => {
  it('is a zero-argument default factory named feishu whose api is typed for other plugins', () => {
    const plugin = feishuPluginFactory();
    expect(plugin.name).toBe('feishu');
    expect(plugin.api).toBeDefined();

    // Type-level: the augmentation types `for('feishu')` as FeishuApi.
    const typed = (host: ServerHost): void => {
      host.hooks.plugin.for('feishu').tap('alpha', (api) => {
        expectTypeOf(api).toEqualTypeOf<FeishuApi>();
      });
      // @ts-expect-error -- no plugin api is declared under this name.
      host.hooks.plugin.for('missing');
    };
    void typed;
  });

  it('adds registered extension tools to the provider catalog for their caller kinds only', () => {
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      tools: [tool('alpha_lookup', ['team_leader'])],
    }));
    const names = (caller: ChannelMcpCaller) =>
      provider.mcp!.describe({ appId: 'app-1', appSecret: 'secret' }, { caller })
        .map((registration) => registration.tool.name);

    expect(names(LEADER)).toContain('alpha_lookup');
    expect(names(DISPATCHER)).not.toContain('alpha_lookup');
  });
});

describe('extension registration conflicts', () => {
  it('rejects a tool name a built-in tool already offers the same caller', () => {
    const { api } = loadFeishu();
    expect(() =>
      api.extensions.register(extension('alpha', { tools: [tool('reply', ['team_leader'])] })),
    ).toThrow('Feishu extension "alpha" tool "reply" (caller team_leader) conflicts with built-in Feishu tool');
  });

  it('allows a built-in tool name for a caller kind the built-in is not offered to', () => {
    const { api } = loadFeishu();
    expect(() =>
      api.extensions.register(extension('alpha', {
        tools: [tool('bind_collaboration_space', ['team_leader'])],
      })),
    ).not.toThrow();
  });

  it('rejects a tool name another extension offers the same caller, naming both', () => {
    const { api } = loadFeishu();
    api.extensions.register(extension('alpha', { tools: [tool('lookup', ['dispatcher'])] }));
    api.extensions.register(extension('beta', { tools: [tool('lookup', ['team_leader'])] }));
    expect(() =>
      api.extensions.register(extension('gamma', { tools: [tool('lookup', ['dispatcher'])] })),
    ).toThrow('Feishu extension "gamma" tool "lookup" (caller dispatcher) conflicts with extension "alpha"');
  });

  it.each(['approve_pairing', 'ask_user_pick'])(
    'rejects card action key %s when it is built in',
    (key) => {
      const { api } = loadFeishu();
      expect(() =>
        api.extensions.register(extension('alpha', {
          cardActions: [{ key, handle: async () => ({}) }],
        })),
      ).toThrow(`Feishu extension "alpha" card action "${key}" conflicts with built-in Feishu card action`);
    },
  );

  it('rejects a card action key another extension claimed, naming both', () => {
    const { api } = loadFeishu();
    api.extensions.register(extension('alpha', {
      cardActions: [{ key: 'ack', handle: async () => ({}) }],
    }));
    expect(() =>
      api.extensions.register(extension('beta', {
        cardActions: [{ key: 'ack', handle: async () => ({}) }],
      })),
    ).toThrow('Feishu extension "beta" card action "ack" conflicts with extension "alpha"');
  });

  it('rejects a second extension with the same name', () => {
    const { api } = loadFeishu();
    api.extensions.register(extension('alpha'));
    expect(() => api.extensions.register(extension('alpha'))).toThrow(
      'Feishu extension "alpha" is registered twice',
    );
  });
});

describe('extension lifecycle per Feishu channel instance', () => {
  it('initializes before the bot starts, starts after it, and closes after in-flight calls settle while refusing new ones', async () => {
    const events: string[] = [];
    const bot = createFakeFeishuBot();
    const startBot = bot.start.bind(bot);
    Object.assign(bot, {
      start: async (routes: Parameters<FakeFeishuBot['start']>[0]) => {
        events.push('bot.start');
        await startBot(routes);
      },
    });
    const { api, provider } = loadFeishu([bot]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.extensions.register(extension<{ id: string }>('alpha', {
      tools: [tool('alpha_slow', ['dispatcher'], async ({ state }) => {
        events.push(`tool:begin:${state.id}`);
        await held;
        events.push('tool:end');
        return { ok: true };
      })],
      initialize: async () => {
        events.push('initialize');
        return { id: 'state-1' };
      },
      start: async (state) => {
        events.push(`start:${state.id}`);
      },
      close: async (state) => {
        events.push(`close:${state.id}`);
      },
    }));
    const instance = await createSession(provider);
    const context = { dispatcher_id: 'disp-1', channel_id: 'primary', caller: DISPATCHER };

    await instance.session.initialize(inertPort());
    await instance.session.start();
    const inFlight = instance.mcp!.invoke({ name: 'alpha_slow', arguments: {} }, context);
    await Promise.resolve();
    const closing = instance.session.close();
    const refused = await instance.mcp!.invoke({ name: 'alpha_slow', arguments: {} }, context);
    expect(events).not.toContain('close:state-1');
    release();
    await closing;

    expect(await inFlight).toMatchObject({ ok: true });
    expect(refused).toEqual({ ok: false, message: 'The Feishu channel is not accepting tool calls' });
    expect(events).toEqual([
      'initialize',
      'bot.start',
      'start:state-1',
      'tool:begin:state-1',
      'tool:end',
      'close:state-1',
    ]);
  });

  it('gives each Feishu channel instance its own state and state root', async () => {
    const contexts: FeishuExtensionContext[] = [];
    const seen: string[] = [];
    const { api, provider } = loadFeishu([createFakeFeishuBot(), createFakeFeishuBot()]);
    api.extensions.register(extension<string>('alpha', {
      tools: [tool('alpha_whoami', ['dispatcher'], async ({ state }) => {
        seen.push(state);
        return { state };
      })],
      initialize: async (context) => {
        contexts.push(context);
        return context.channelId;
      },
    }));
    const first = await createSession(provider, 'primary');
    const second = await createSession(provider, 'secondary');
    for (const instance of [first, second]) {
      await instance.session.initialize(inertPort());
      await instance.session.start();
    }

    for (const [instance, channelId] of [[first, 'primary'], [second, 'secondary']] as const) {
      await instance.mcp!.invoke(
        { name: 'alpha_whoami', arguments: {} },
        { dispatcher_id: 'disp-1', channel_id: channelId, caller: DISPATCHER },
      );
    }

    expect(seen).toEqual(['primary', 'secondary']);
    expect(contexts[0]?.stateRoot).not.toBe(contexts[1]?.stateRoot);
    expect(contexts[0]?.stateRoot.startsWith(join(dir, 'feishu-extensions', 'alpha'))).toBe(true);
    await first.session.close();
    await second.session.close();
  });

  it('dispatches a card action by its dreamux_action key to the instance state', async () => {
    const bot = createFakeFeishuBot();
    const { api, provider } = loadFeishu([bot]);
    const handled: Array<{ state: string; value: unknown }> = [];
    api.extensions.register(extension<string>('alpha', {
      cardActions: [{
        key: 'alpha_ack',
        handle: async (state, event) => {
          handled.push({ state, value: event.actionValue['item'] });
          return {};
        },
      }],
      initialize: async () => 'state-1',
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    await bot.injectCardAction({
      actionValue: { dreamux_action: 'alpha_ack', item: 'i-1' },
      raw: {},
    });

    expect(handled).toEqual([{ state: 'state-1', value: 'i-1' }]);
    await instance.session.close();
  });

  it('fences the instance api once the instance began closing', async () => {
    let captured: FeishuInstanceApi | undefined;
    const fromClose: unknown[] = [];
    const { api, provider } = loadFeishu();
    api.extensions.register(extension<FeishuInstanceApi>('alpha', {
      initialize: async (context) => {
        captured = context.api;
        return context.api;
      },
      close: async (instanceApi) => {
        fromClose.push(
          await instanceApi
            .sendCard({ chatId: 'oc_x', card: {}, mode: 'background' })
            .catch((err: unknown) => err),
        );
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();
    await instance.session.close();

    expect(fromClose[0]).toBeInstanceOf(FeishuOperationError);
    expect((fromClose[0] as FeishuOperationError).reason).toBe('aborted');
    await expect(captured!.editCard('om_x', {})).rejects.toMatchObject({ reason: 'aborted' });
    await expect(captured!.readMessageRoute('om_x')).rejects.toMatchObject({ reason: 'aborted' });
    expect(
      await captured!.submitToTeam('alpha', {
        kind: 'chat',
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-1',
        anchor: null,
      } as unknown as Parameters<FeishuInstanceApi['submitToTeam']>[1]),
    ).toEqual({ status: 'error', message: 'Feishu session is not live' });
  });

  it('closes every extension even when one close throws, in reverse registration order', async () => {
    const closed: string[] = [];
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      close: async () => {
        closed.push('alpha');
      },
    }));
    api.extensions.register(extension('beta', {
      close: async () => {
        closed.push('beta');
        throw new Error('close failed');
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    await instance.session.close();

    expect(closed).toEqual(['beta', 'alpha']);
  });
});
