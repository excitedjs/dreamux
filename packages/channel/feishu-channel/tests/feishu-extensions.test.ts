/**
 * The Feishu plugin and its extension surface, driven the way Dreamux drives
 * them: the plugin's factory, its contributed provider captured through a
 * `ContributeHost`, extensions registered through the published api, and
 * sessions created by that provider over a fake bot.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ChannelCorePort,
  ChannelDiagnosticContext,
  ChannelDiagnosticRunner,
  ChannelMcpCaller,
  ChannelProvider,
  ContributeHost,
  DreamuxLogger,
  DreamuxPlugin,
  JsonValue,
  ServerHost,
  TeamSummary,
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
import { channelPathSegment, routingDocumentFilename } from '../src/routing/store.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';
import { teamSummary } from './helpers/team-status.js';

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

/** The invoke port carries JSON; a Core `TeamSummary` crosses it as plain data. */
const asPortResult = (summary: TeamSummary): JsonValue =>
  JSON.parse(JSON.stringify(summary)) as JsonValue;

/** A Core port whose `team.status` answers immediately, for any Team name. */
function teamStatusPort(): ChannelCorePort {
  return {
    invoke: {
      invoke: async (command, payload) => {
        if (command !== 'team.status') {
          throw new Error(`unexpected command ${command}`);
        }
        const teamName = (payload as Record<string, unknown>)['team_name'] as string;
        return asPortResult(teamSummary(teamName));
      },
    },
    events: { subscribe: () => ({ unsubscribe: () => undefined }) },
  };
}

/** A Core port whose single `team.status` answer is held until `release`. */
function heldTeamStatusPort(): {
  port: ChannelCorePort;
  release(summary: TeamSummary): void;
} {
  let settle!: (value: JsonValue) => void;
  const pending = new Promise<JsonValue>((resolve) => {
    settle = resolve;
  });
  return {
    port: {
      invoke: {
        invoke: async (command) => {
          if (command !== 'team.status') {
            throw new Error(`unexpected command ${command}`);
          }
          return pending;
        },
      },
      events: { subscribe: () => ({ unsubscribe: () => undefined }) },
    },
    release: (summary) => settle(asPortResult(summary)),
  };
}

/** A recording `DreamuxLogger`: no helper in `tests/helpers/` records log calls. */
function recordingLog(): {
  log: DreamuxLogger;
  records: Array<{ fields: Record<string, unknown>; message: string }>;
} {
  const records: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return {
    records,
    log: {
      error: (fields: Record<string, unknown> | string, message?: string) => {
        if (typeof fields === 'string') {
          records.push({ fields: {}, message: fields });
          return;
        }
        records.push({ fields, message: message ?? '' });
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    },
  };
}

const diagnosticContext: ChannelDiagnosticContext<FeishuChannelConfig> = {
  dispatcher_id: 'disp-1',
  channel_id: 'primary',
  provider: 'builtin:feishu',
  config: { appId: 'app-1', appSecret: 'secret' },
  env: {},
  scope: 'foreground',
};

const diagnosticRunner: ChannelDiagnosticRunner = {
  check: async () => true,
  capture: async () => '',
};

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
  logger: DreamuxLogger = silentLog,
) {
  return provider.createSession({
    dispatcher_id: 'disp-1',
    channel_id: channelId,
    provider: 'builtin:feishu',
    config: { appId: 'app-1', appSecret: 'secret' },
    logger,
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

  it('rejects a second extension with the same name', () => {
    const { api } = loadFeishu();
    api.extensions.register(extension('alpha'));
    expect(() => api.extensions.register(extension('alpha'))).toThrow(
      'Feishu extension "alpha" is registered twice',
    );
  });

  it('rejects a second tool in the same extension repeating an earlier tool\'s name and caller kind', () => {
    const { api } = loadFeishu();
    expect(() =>
      api.extensions.register(extension('alpha', {
        tools: [
          tool('lookup', ['dispatcher']),
          tool('lookup', ['dispatcher']),
        ],
      })),
    ).toThrow(
      'Feishu extension "alpha" tool "lookup" (caller dispatcher) conflicts with another tool of the same extension',
    );
  });

  it('allows the same tool name offered to two different caller kinds within one extension\'s own tools', () => {
    const { api } = loadFeishu();
    expect(() =>
      api.extensions.register(extension('alpha', {
        tools: [
          tool('lookup', ['dispatcher']),
          tool('lookup', ['team_leader']),
        ],
      })),
    ).not.toThrow();
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

  it('runs no extension close when the session was never initialized', async () => {
    const closed: string[] = [];
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      close: async () => {
        closed.push('alpha');
      },
    }));
    const instance = await createSession(provider);

    await instance.session.close();

    expect(closed).toEqual([]);
  });
});

describe('extension lifecycle races and failure attribution', () => {
  it('a close landing mid-start waits for the in-flight start, then closes what it opened, and session.start() rejects', async () => {
    const events: string[] = [];
    let closeCount = 0;
    let beganStart!: () => void;
    const startBegan = new Promise<void>((resolve) => {
      beganStart = resolve;
    });
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      start: async () => {
        events.push('start:begin');
        beganStart();
        await held;
        events.push('start:end');
      },
      close: async () => {
        closeCount += 1;
        events.push('close');
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());

    const starting = instance.session.start();
    await startBegan;
    const closing = instance.session.close();
    releaseHeld();

    await expect(starting).rejects.toThrow(/closed during startup/);
    await expect(closing).resolves.toBeUndefined();
    // Not just "close fired after start began" — the fix is specifically that
    // close waits for the in-flight start to finish before closing it.
    expect(events).toEqual(['start:begin', 'start:end', 'close']);
    // `start()`'s own catch also tears the lifecycle down, so close is called
    // twice; the extension's own close callback must still fire exactly once.
    expect(closeCount).toBe(1);
  });

  it('close waits for an in-flight instance-api bindTeam before closing extensions and draining the store, and the binding lands on disk', async () => {
    let captured: FeishuInstanceApi | undefined;
    const { api, provider } = loadFeishu();
    api.extensions.register(extension<FeishuInstanceApi>('alpha', {
      initialize: async (context) => {
        captured = context.api;
        return context.api;
      },
    }));
    const instance = await createSession(provider, 'primary');
    const held = heldTeamStatusPort();
    await instance.session.initialize(held.port);
    await instance.session.start();

    // Called directly from the test, not through a tracked tool/action, so
    // this only proves something if `bindTeam` itself is tracked.
    const bindTeamPromise = captured!.bindTeam({
      target: chatTarget('oc_untracked', 'group'),
      teamName: 'alpha-team',
      display: '',
    });
    let closeResolved = false;
    const closing = instance.session.close().then(() => {
      closeResolved = true;
    });
    // An ordering flag, not just a final state check: close() must not have
    // resolved yet while the bindTeam it is waiting for is still held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeResolved).toBe(false);

    held.release(teamSummary('alpha-team'));
    await bindTeamPromise;
    await closing;
    expect(closeResolved).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(dir, routingDocumentFilename('primary')), 'utf8'),
    ) as { bindings: Array<{ team_name: string }> };
    expect(onDisk.bindings.map((b) => b.team_name)).toContain('alpha-team');
  });

  it('an initialize throw from a later extension fails the session and still closes an extension that already initialized', async () => {
    const closed: string[] = [];
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      close: async () => {
        closed.push('alpha');
      },
    }));
    api.extensions.register(extension('beta', {
      initialize: async () => {
        throw new Error('beta init failed');
      },
    }));
    const instance = await createSession(provider);

    await expect(instance.session.initialize(inertPort())).rejects.toThrow('beta init failed');

    expect(closed).toEqual(['alpha']);
  });

  it('a start throw from one extension fails the session and closes every initialized extension, including one whose start never ran', async () => {
    const closed: string[] = [];
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      close: async () => {
        closed.push('alpha');
      },
    }));
    api.extensions.register(extension('beta', {
      start: async () => {
        throw new Error('beta start failed');
      },
      close: async () => {
        closed.push('beta');
      },
    }));
    api.extensions.register(extension('gamma', {
      close: async () => {
        closed.push('gamma');
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());

    await expect(instance.session.start()).rejects.toThrow('beta start failed');

    // gamma's start never ran (beta's threw first), but its initialize
    // already succeeded, so it still gets a close.
    expect(closed).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('logs an initialize failure once, naming the extension, before it propagates', async () => {
    const { log, records } = recordingLog();
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      initialize: async () => {
        throw new Error('init boom');
      },
    }));
    const instance = await createSession(provider, 'primary', log);

    await expect(instance.session.initialize(inertPort())).rejects.toThrow('init boom');

    expect(records).toEqual([
      {
        fields: { feishu_extension: 'alpha', err: { message: 'init boom' } },
        message: 'Feishu extension initialize failed',
      },
    ]);
  });

  it('logs a start failure once, naming the extension, before it propagates', async () => {
    const { log, records } = recordingLog();
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      start: async () => {
        throw new Error('start boom');
      },
    }));
    const instance = await createSession(provider, 'primary', log);
    await instance.session.initialize(inertPort());

    await expect(instance.session.start()).rejects.toThrow('start boom');

    expect(records).toEqual([
      {
        fields: { feishu_extension: 'alpha', err: { message: 'start boom' } },
        message: 'Feishu extension start failed',
      },
    ]);
  });

  it('logs a card-action rejection and still delivers it to the caller, and logs a close failure, each once', async () => {
    const bot = createFakeFeishuBot();
    const { log, records } = recordingLog();
    const { api, provider } = loadFeishu([bot]);
    api.extensions.register(extension('alpha', {
      cardActions: [{
        key: 'alpha_fail',
        handle: async () => {
          throw new Error('card boom');
        },
      }],
      close: async () => {
        throw new Error('close boom');
      },
    }));
    const instance = await createSession(provider, 'primary', log);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    await expect(
      bot.injectCardAction({ actionValue: { dreamux_action: 'alpha_fail' }, raw: {} }),
    ).rejects.toThrow('card boom');

    await instance.session.close();

    expect(records).toEqual([
      {
        fields: { feishu_extension: 'alpha', err: { message: 'card boom' } },
        message: 'Feishu extension card action failed',
      },
      {
        fields: { feishu_extension: 'alpha', err: { message: 'close boom' } },
        message: 'Feishu extension close failed',
      },
    ]);
  });

  it('aborts context.signal once the instance begins closing', async () => {
    let captured: AbortSignal | undefined;
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      initialize: async (context) => {
        captured = context.signal;
        return undefined;
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();
    expect(captured!.aborted).toBe(false);

    await instance.session.close();

    expect(captured!.aborted).toBe(true);
  });
});

describe('extension state root', () => {
  it('does not create an extension\'s stateRoot directory', async () => {
    let stateRoot: string | undefined;
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      initialize: async (context) => {
        stateRoot = context.stateRoot;
        return undefined;
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    expect(existsSync(stateRoot!)).toBe(false);

    await instance.session.close();
  });

  it('an extension\'s stateRoot channel segment matches channelPathSegment exactly', async () => {
    let stateRoot: string | undefined;
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      initialize: async (context) => {
        stateRoot = context.stateRoot;
        return undefined;
      },
    }));
    const instance = await createSession(provider, 'primary');
    await instance.session.initialize(inertPort());
    await instance.session.start();

    expect(stateRoot).toBe(join(dir, 'feishu-extensions', 'alpha', channelPathSegment('primary')));

    await instance.session.close();
  });
});

describe('FeishuInstanceApi happy paths', () => {
  it('owner resolves null for an unbound target, the Team once bound, and a topic inherits its group binding', async () => {
    let captured: FeishuInstanceApi | undefined;
    const { api, provider } = loadFeishu();
    api.extensions.register(extension<FeishuInstanceApi>('alpha', {
      initialize: async (context) => {
        captured = context.api;
        return context.api;
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(teamStatusPort());
    await instance.session.start();

    const group = chatTarget('oc_group', 'group');
    const topic = topicTarget('oc_group', 'omt_1');
    expect(captured!.owner(group)).toBeNull();

    await captured!.bindTeam({ target: group, teamName: 'alpha-team', display: '' });

    expect(captured!.owner(group)).toBe('alpha-team');
    expect(captured!.owner(topic)).toBe('alpha-team');

    await instance.session.close();
  });

  it('readMessageRoute resolves the target the fake bot reports for that message', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('msg-1', {
      items: [{
        messageId: 'msg-1',
        messageType: 'text',
        content: '{}',
        mentions: [],
        deleted: false,
        malformed: false,
        chatId: 'oc_read',
      }],
    });
    let captured: FeishuInstanceApi | undefined;
    const { api, provider } = loadFeishu([bot]);
    api.extensions.register(extension<FeishuInstanceApi>('alpha', {
      initialize: async (context) => {
        captured = context.api;
        return context.api;
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    await expect(captured!.readMessageRoute('msg-1')).resolves.toEqual({
      target: chatTarget('oc_read', 'group'),
    });

    await instance.session.close();
  });

  it('editCard lands in the fake bot\'s edited cards', async () => {
    const bot = createFakeFeishuBot();
    let captured: FeishuInstanceApi | undefined;
    const { api, provider } = loadFeishu([bot]);
    api.extensions.register(extension<FeishuInstanceApi>('alpha', {
      initialize: async (context) => {
        captured = context.api;
        return context.api;
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    await captured!.editCard('om_target', { type: 'card', body: 'x' });

    expect(bot.editedCards).toEqual([{ messageId: 'om_target', card: { type: 'card', body: 'x' } }]);

    await instance.session.close();
  });

  it('bindTeam rebinds a target another Team currently owns, with no ownership check', async () => {
    let captured: FeishuInstanceApi | undefined;
    const { api, provider } = loadFeishu();
    api.extensions.register(extension<FeishuInstanceApi>('alpha', {
      initialize: async (context) => {
        captured = context.api;
        return context.api;
      },
    }));
    const instance = await createSession(provider);
    await instance.session.initialize(teamStatusPort());
    await instance.session.start();
    const target = chatTarget('oc_owned', 'group');

    await captured!.bindTeam({ target, teamName: 'team-a', display: '' });
    expect(captured!.owner(target)).toBe('team-a');

    // No `requireOwner` is passed here at all — the instance api's bindTeam
    // has no such parameter — so a rebind away from team-a succeeds.
    await captured!.bindTeam({ target, teamName: 'team-b', display: '' });
    expect(captured!.owner(target)).toBe('team-b');

    await instance.session.close();
  });

});

describe('extension tools through the MCP capability', () => {
  it('an extension tool\'s successText reaches the MCP outcome\'s text field', async () => {
    const greetTool: FeishuExtensionTool<undefined> = {
      name: 'alpha_greet',
      title: 'alpha_greet',
      description: 'alpha_greet test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      annotations: {},
      callers: ['dispatcher'],
      parse: (raw) => raw,
      handle: async () => ({ ok: true }),
      successText: () => 'greeted',
    };
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', { tools: [greetTool] }));
    const instance = await createSession(provider);
    await instance.session.initialize(inertPort());
    await instance.session.start();

    const outcome = await instance.mcp!.invoke(
      { name: 'alpha_greet', arguments: {} },
      { dispatcher_id: 'disp-1', channel_id: 'primary', caller: DISPATCHER },
    );

    expect(outcome).toMatchObject({ ok: true, text: 'greeted' });

    await instance.session.close();
  });

  it('an extension tool\'s catalog registration carries its full descriptor, not just its name', () => {
    const { api, provider } = loadFeishu();
    api.extensions.register(extension('alpha', {
      tools: [tool('alpha_describe', ['dispatcher'])],
    }));
    const registrations = provider.mcp!.describe(
      { appId: 'app-1', appSecret: 'secret' },
      { caller: DISPATCHER },
    );

    const registration = registrations.find((r) => r.tool.name === 'alpha_describe');

    expect(registration).toMatchObject({
      tool: {
        name: 'alpha_describe',
        title: 'alpha_describe',
        description: 'alpha_describe test tool',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        annotations: {},
      },
      target: 'session',
    });
  });
});

describe('the Feishu provider diagnostic', () => {
  it('reports no extensions when none are registered', async () => {
    const { provider } = loadFeishu();

    const result = await provider.diagnostic!.runDiagnostic(diagnosticContext, diagnosticRunner);

    expect(result.detail).toContain('extensions: none');
  });

});
