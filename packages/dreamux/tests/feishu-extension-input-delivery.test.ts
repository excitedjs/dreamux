/**
 * The extension delivery capability driven end to end through Core.
 *
 * The layers that own the facts stay real: the plugin loader imports the real
 * Feishu plugin, the real plugin host runs its `server` and publishes its api
 * through `hooks.plugin.for('feishu')`, the real Feishu provider builds and
 * starts a real channel session over a real routing document, and the Command
 * the extension's delivery invokes is Core's own `team.submit` against a real
 * Team. Only the two external layers are controlled — the Feishu platform (a
 * fake bot, so nothing leaves the process) and the agent runtime (the shared
 * `ControlledRuntimeProvider`).
 *
 * What a hand-built host could not prove is exactly what this arm exists for:
 * an external-style extension registered through the real publication hook
 * reaches a real session, and the outcome it observes is Core's actual
 * admission answer rather than a stubbed success.
 *
 * Four facts are only Core's to state, so only this arm states them: the
 * duplicate ledger is scoped to the recipient, not to the Channel that
 * delivered (a second Feishu instance submitting the same source id to the
 * same Team is a duplicate); the reminder is what Core renders into the input
 * the runtime reads, one sibling slot after the envelope; a caller's own note
 * replaces the Channel's standing one rather than joining it; and an attribute
 * whose name is an own `__proto__` key crosses the Command boundary as data
 * and reaches the model as an ordinary rendered attribute.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelProvider, DreamuxPlugin } from '@excitedjs/dreamux-types';
import type {
  FeishuBoundTeamSubmitOutcome,
  FeishuCardActionEvent,
  FeishuChannelConfig,
  FeishuExtension,
  FeishuInstanceApi,
  FeishuTarget,
} from '@excitedjs/feishu-channel';
import * as botModule from '../../channel/feishu-channel/dist/bot.js';
import type {
  FeishuBot,
  FeishuInboundRoutes,
} from '../../channel/feishu-channel/dist/bot.js';
import { CHANNEL_REMINDER } from '../../channel/feishu-channel/dist/feishu-submit.js';

import { ConfigService } from '../src/config/service.js';
import { globalConfigFile } from '../src/config/config.js';
import { dispatcherCacheDir, dispatcherDir } from '../src/platform/paths.js';
import { createChannelCorePort } from '../src/service/channel-service/core-port.js';
import { startPlugins } from '../src/plugin/host.js';
import type { LoadedPlugin } from '../src/plugin/loader.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { Server } from '../src/server.js';
import { capturingLogger } from './helpers/command-harness.js';
import { ControlledRuntimeProvider } from './helpers/controlled-runtime-provider.js';
import { teamRequest } from './helpers/real-dispatcher.js';

const DISPATCHER = 'delivery-arm';
const CHANNEL = 'primary';
const SECOND_CHANNEL = 'secondary';
const GROUP: FeishuTarget = { kind: 'group', chatId: 'oc_live' };
const SECOND_GROUP: FeishuTarget = { kind: 'group', chatId: 'oc_second' };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

/** A card click as Feishu delivers it, for a person the access file admits. */
function cardClick(): FeishuCardActionEvent {
  return {
    operatorOpenId: 'operator',
    openChatId: GROUP.chatId,
    openMessageId: 'om_live_card',
    actionValue: { dreamux_action: 'acme_decide', decision: 'approve' },
    raw: {},
  };
}

/** How many reminder siblings one rendered input carries; the contract is one. */
function reminderSlots(rendered: string): number {
  return (rendered.match(/<reminder>/gu) ?? []).length;
}

/** The extension's own scheduled work, for the arms that want some. */
interface TimerPlan {
  readonly everyMs: number;
  readonly text: string;
  readonly sourceId: string;
}

/** The one thing this test's extension is: a card action that later delivers. */
interface Arm {
  readonly server: Server;
  readonly provider: ControlledRuntimeProvider;
  readonly bot: FeishuBot;
  readonly routes: () => FeishuInboundRoutes;
  /** The api the real publication hook handed the extension, per instance. */
  readonly apis: Map<string, FeishuInstanceApi>;
  /** One promise per click: the delivery the handler started before answering. */
  readonly deliveries: Array<Promise<FeishuBoundTeamSubmitOutcome>>;
  readonly expectedTeamName: { value: string };
  /** One entry per tick of the extension's own schedule, in firing order. */
  readonly timerDeliveries: Array<Promise<FeishuBoundTeamSubmitOutcome>>;
  readonly clicks: string[];
  startTeam(): Promise<string>;
  /**
   * A second, independently built Feishu channel instance over the same
   * dispatcher: the real provider the real plugin contributed, a real session,
   * and a real Core port of its own. It is not in the dispatcher's channel
   * list, because Core allows one channel per provider per dispatcher — what
   * it shares with the configured instance is the Team it can reach, which is
   * what Core's duplicate ledger is scoped to.
   */
  startSecondChannel(): Promise<{ api: FeishuInstanceApi }>;
}

/** A Feishu platform stand-in: nothing this arm does leaves the process. */
function fakeFeishuBot(): {
  bot: FeishuBot;
  routes: () => FeishuInboundRoutes;
} {
  let routes: FeishuInboundRoutes | undefined;
  const landings = new Map<string, string>();
  let nextMessage = 0;
  const bot: FeishuBot = {
    appId: 'app-live',
    botOpenId: 'fake-bot',
    botDisplayName: 'Delivery Arm',
    async start(next) {
      routes = next;
    },
    async close() {
      routes = undefined;
    },
    async getChatMode() {
      return 'group';
    },
    async send(target) {
      const messageId = `sent-${++nextMessage}`;
      landings.set(messageId, target.chatId);
      return {
        messages: [{ messageId, chatId: target.chatId, threadId: undefined }],
      };
    },
    async sendCard(target) {
      const messageId = `card-${++nextMessage}`;
      landings.set(messageId, target.chatId);
      return {
        messages: [{ messageId, chatId: target.chatId, threadId: undefined }],
      };
    },
    async readMessage(request) {
      const chatId = landings.get(request.messageId);
      if (chatId === undefined) throw new Error('unknown fake message');
      return {
        items: [
          {
            messageId: request.messageId,
            messageType: 'text',
            content: '{}',
            mentions: [],
            deleted: false,
            malformed: false,
            chatId,
          },
        ],
      };
    },
    async editCard() {},
    async addReaction() {
      return 'reaction-live';
    },
    async resolveAppOwner() {
      return {};
    },
    fetchDocMeta: async () => {
      throw new Error('no document fixture');
    },
    fetchDocCommentText: async () => {
      throw new Error('no document fixture');
    },
    resolveWikiNode: async () => null,
    fetchMessageResource: async () => {
      throw new Error('no resource fixture');
    },
  };
  return {
    bot,
    routes: () => {
      if (routes === undefined) throw new Error('the bot was never started');
      return routes;
    },
  };
}

async function startArm(
  options: { readonly timer?: TimerPlan } = {},
): Promise<Arm> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-feishu-delivery-'));
  vi.stubEnv('DREAMUX_ROOT', join(root, 'state'));
  const log = capturingLogger([]);
  const registry = new ProviderRegistry();
  const provider = new ControlledRuntimeProvider();
  registry.register(
    {
      id: 'controlled',
      kind: 'agentRuntime',
      ref: parseProviderRef('builtin:controlled'),
    },
    provider,
  );

  const stateRoot = dispatcherDir(DISPATCHER);
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    join(stateRoot, 'access.json'),
    JSON.stringify({
      version: 3,
      dm_policy: 'pairing',
      group: {
        policy: 'allowlist',
        allow_chats: [GROUP.chatId],
        require_mention: true,
      },
      allow_users: [],
      pending: {},
    }),
    { mode: 0o600 },
  );

  await writeFile(
    globalConfigFile(),
    JSON.stringify({
      agents: [
        { id: 'controlled', provider: 'builtin:controlled', config: {} },
      ],
      dispatchers: [
        {
          id: DISPATCHER,
          cwd: root,
          enabled: true,
          workspace: { enabled: false },
          channels: [
            {
              id: CHANNEL,
              provider: 'builtin:feishu',
              config: { app_id: 'app-live', app_secret: 'fake-secret' },
            },
          ],
          agentRuntime: 'controlled',
        },
      ],
    }),
    { mode: 0o600 },
  );
  // The real plugin loader runs inside this read: it imports the Feishu plugin
  // and contributes the provider the config above addresses.
  const config = await ConfigService.open({ providerRegistry: registry });

  const primaryBot = fakeFeishuBot();
  const secondBot = fakeFeishuBot();
  const bot = primaryBot.bot;
  // One bot per session, in creation order: the configured channel first, any
  // instance this arm builds afterwards next.
  let created = 0;
  vi.spyOn(botModule, 'createFeishuBot').mockImplementation(() =>
    created++ === 0 ? primaryBot.bot : secondBot.bot,
  );

  // The external-style extension, registered by a plugin through the real
  // publication hook — the same tap any other plugin would use.
  const apis = new Map<string, FeishuInstanceApi>();
  const deliveries: Arm['deliveries'] = [];
  const timerDeliveries: Arm['timerDeliveries'] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const clicks: string[] = [];
  const expectedTeamName = { value: '' };
  const extension: FeishuExtension<FeishuInstanceApi> = {
    name: 'acme',
    tools: [],
    cardActions: [
      {
        key: 'acme_decide',
        async handle(state, event) {
          const decision = String(event.actionValue['decision'] ?? '');
          clicks.push(decision);
          deliveries.push(
            state.submitToBoundTeam({
              target: GROUP,
              expectedTeamName: expectedTeamName.value,
              text: `decision ${decision}`,
              sourceId: 'acme-click-1',
            }),
          );
          return {
            response: { toast: { type: 'success', content: '已记录' } },
          };
        },
      },
    ],
    initialize: async (context) => {
      apis.set(context.channelId, context.api);
      return context.api;
    },
    // The documented home for an extension's timers: the connection is live
    // and the outbound work a schedule does is allowed to start.
    start: async (state) => {
      const plan = options.timer;
      if (plan === undefined) return;
      timer = setInterval(() => {
        timerDeliveries.push(
          state.submitToBoundTeam({
            target: GROUP,
            expectedTeamName: expectedTeamName.value,
            text: plan.text,
            sourceId: plan.sourceId,
          }),
        );
      }, plan.everyMs);
    },
    close: async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
  const externalPlugin: DreamuxPlugin = {
    name: 'acme-extension',
    server(host) {
      host.hooks.plugin.for('feishu').tap('register', (api) => {
        api.extensions.register(extension);
      });
    },
  };
  const asLoadedPlugin = (
    name: string,
    plugin: DreamuxPlugin,
  ): LoadedPlugin => ({
    name,
    source: `plugins[0] ("npm:@acme/${name}")`,
    plugin,
    entry: null,
    config: undefined,
    providers: [],
  });

  const started = startPlugins(
    [...config.plugins, asLoadedPlugin('acme-extension', externalPlugin)],
    log,
  );

  const server = new Server({
    config,
    providerRegistry: registry,
    hooks: started.hooks,
    adminSocketPath: join(root, 'admin.sock'),
    logger: log,
    channelLoggerFactory: () => log,
    workflowLoggerFactory: () => log,
  });
  cleanups.push(async () => {
    try {
      await server.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A client-side read only: the provider list proves the plugin loaded.
  expect(config.plugins.map((loaded) => loaded.name)).toContain('feishu');

  return {
    server,
    provider,
    bot,
    routes: primaryBot.routes,
    apis,
    deliveries,
    timerDeliveries,
    clicks,
    expectedTeamName,
    async startTeam() {
      await server.start();
      const created = await server.dispatchers
        .get(DISPATCHER)
        .teams.createFromRequest(teamRequest('acme-setup'));
      expectedTeamName.value = created.team_name;
      return created.team_name;
    },
    async startSecondChannel() {
      // The real provider the real plugin contributed, so this instance runs
      // the same registered extension and the same routing/access code.
      const feishu = registry.getImplementation(
        'feishu',
      ) as ChannelProvider<FeishuChannelConfig>;
      const lease = createChannelCorePort({
        registry: server.commands,
        dispatcherId: DISPATCHER,
        channelId: SECOND_CHANNEL,
        events: { subscribe: () => ({ unsubscribe: () => undefined }) },
        log,
      });
      const instance = await feishu.createSession({
        dispatcher_id: DISPATCHER,
        channel_id: SECOND_CHANNEL,
        provider: 'builtin:feishu',
        config: { appId: 'app-live', appSecret: 'fake-secret' },
        logger: log,
        state_root: dispatcherDir(DISPATCHER),
        cache_root: dispatcherCacheDir(DISPATCHER),
      });
      cleanups.push(async () => {
        await instance.session.close();
        lease.closeAdmission();
      });
      await instance.session.initialize(lease.port);
      await instance.session.start();
      const api = apis.get(SECOND_CHANNEL);
      if (api === undefined) {
        throw new Error(
          'the extension was not initialized for the second channel',
        );
      }
      return { api };
    },
  };
}

describe('an extension delivers through a real Feishu session and real Core', () => {
  it('answers an admitted click, then observes real admission, real deduplication and a refused rebind', async () => {
    const arm = await startArm();
    const teamName = await arm.startTeam();
    const api = arm.apis.get(CHANNEL)!;
    await api.bindTeam({ target: GROUP, teamName, display: '' });

    // A real admitted click reaches the extension's own card action.
    const answered = await arm.routes().onCardAction?.(cardClick());
    expect(answered).toEqual({
      toast: { type: 'success', content: '已记录' },
    });
    expect(arm.clicks).toEqual(['approve']);

    // Later work observes Core's own answer for that click.
    const outcome = await arm.deliveries[0]!;
    expect(outcome.status).toBe('submitted');
    expect(typeof (outcome as { turnId: string | null }).turnId).toBe('string');
    expect(
      (outcome as { turnId: string | null }).turnId?.length,
    ).toBeGreaterThan(0);

    // Core's source ledger is real: the same id is not admitted twice.
    await expect(
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: teamName,
        text: 'decision approve',
        sourceId: 'acme-click-1',
      }),
    ).resolves.toEqual({ status: 'duplicate' });

    // A rebind moves the route; the old expected Team is refused and nothing
    // reaches the runtime behind the new owner.
    const other = await arm.server.dispatchers
      .get(DISPATCHER)
      .teams.createFromRequest(teamRequest('acme-second'));
    const admittedBefore = arm.provider.runtimes.reduce(
      (total, runtime) => total + runtime.inputs.length,
      0,
    );
    await api.bindTeam({
      target: GROUP,
      teamName: other.team_name,
      display: '',
    });
    await expect(
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: teamName,
        text: 'decision approve',
        sourceId: 'acme-click-stale',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'binding_changed' });
    expect(
      arm.provider.runtimes.reduce(
        (total, runtime) => total + runtime.inputs.length,
        0,
      ),
    ).toBe(admittedBefore);
  });

  it("delivers the extension's own scheduled work through the same real session", async () => {
    const arm = await startArm({
      timer: {
        everyMs: 25,
        text: 'the timer decided again',
        sourceId: 'acme-timer-2',
      },
    });
    await arm.startTeam();

    // Nothing called into the extension: its own schedule fired. `start` ran
    // before any Team existed, so the first fire is a refusal rather than a
    // silent delivery to a replacement recipient.
    await vi.waitFor(() => {
      expect(arm.timerDeliveries.length).toBeGreaterThanOrEqual(1);
    });
    await expect(arm.timerDeliveries[0]!).resolves.toEqual({
      status: 'refused',
      reason: 'binding_changed',
    });

    const teamName = arm.expectedTeamName.value;
    await arm.apis
      .get(CHANNEL)!
      .bindTeam({ target: GROUP, teamName, display: '' });

    // The same schedule, still firing, now reaches the bound Team: Core admits
    // the first fire, and every later fire of that one source id is a
    // duplicate, so the runtime reads the decision once. No card callback ran.
    const delivered = (): number =>
      arm.provider.runtimes
        .flatMap((runtime) => runtime.inputs)
        .filter((text) => text.includes('the timer decided again')).length;
    await vi.waitFor(() => {
      expect(delivered()).toBe(1);
    });
    expect(arm.clicks).toEqual([]);

    // Cleanup: teardown cleared the schedule, so nothing fires past the next
    // few ticks and nothing more reaches Core.
    await arm.server.shutdown();
    const fired = arm.timerDeliveries.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(arm.timerDeliveries).toHaveLength(fired);
    expect(delivered()).toBe(1);
  });

  it('counts one submission per source id across two Feishu instances that reach one Team', async () => {
    const arm = await startArm();
    const teamName = await arm.startTeam();
    const primary = arm.apis.get(CHANNEL)!;
    await primary.bindTeam({ target: GROUP, teamName, display: '' });
    const second = await arm.startSecondChannel();
    await second.api.bindTeam({
      target: SECOND_GROUP,
      teamName,
      display: '',
    });

    const admitted = (): number =>
      arm.provider.runtimes.reduce(
        (total, runtime) => total + runtime.inputs.length,
        0,
      );
    const before = admitted();

    await expect(
      primary.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: teamName,
        text: 'one decision',
        sourceId: 'shared-source',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });

    // The very same source id, delivered by a different Feishu instance from a
    // different conversation, to the same Team: Core's ledger belongs to the
    // recipient, so this is a duplicate and not a second admission — the
    // runtime sees the decision once, whichever channel it arrived on.
    await expect(
      second.api.submitToBoundTeam({
        target: SECOND_GROUP,
        expectedTeamName: teamName,
        text: 'one decision',
        sourceId: 'shared-source',
      }),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(admitted()).toBe(before + 1);
  });

  it("renders the caller's note as one reminder slot after Core's own envelope", async () => {
    const arm = await startArm();
    const teamName = await arm.startTeam();
    const api = arm.apis.get(CHANNEL)!;
    await api.bindTeam({ target: GROUP, teamName, display: '' });

    const deliver = (text: string, sourceId: string, reminder?: string) =>
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: teamName,
        text,
        sourceId,
        ...(reminder === undefined ? {} : { reminder }),
      });

    await expect(
      deliver('the default note', 'note-default'),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      deliver(
        'the caller note',
        'note-caller',
        'Reply in the thread it names.',
      ),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      deliver('the silent note', 'note-empty', ''),
    ).resolves.toMatchObject({ status: 'submitted' });

    // What the runtime actually reads, for each of the three calls.
    const rendered = arm.provider.runtimes.flatMap((runtime) => runtime.inputs);
    expect(rendered).toEqual([
      `<channel source="feishu" chat_id="oc_live">the default note</channel>\n\n` +
        `<reminder>${CHANNEL_REMINDER}</reminder>`,
      '<channel source="feishu" chat_id="oc_live">the caller note</channel>\n\n' +
        '<reminder>Reply in the thread it names.</reminder>',
      '<channel source="feishu" chat_id="oc_live">the silent note</channel>',
    ]);
    // One slot, never repeated inside the envelope: omitted, the caller's own
    // note replaces the channel's standing one, and an empty string sends none.
    expect(rendered.map(reminderSlots)).toEqual([1, 1, 0]);
  });

  it('hands Core caller metadata whose name is an own __proto__ key', async () => {
    const arm = await startArm();
    const teamName = await arm.startTeam();
    const api = arm.apis.get(CHANNEL)!;
    await api.bindTeam({ target: GROUP, teamName, display: '' });

    await expect(
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: teamName,
        text: 'the faithful body',
        sourceId: 'proto-1',
        attrs: {
          business_key: 'BL-7',
          // A computed key, so this is an own entry named `__proto__` — not a
          // prototype — on the caller's metadata.
          ['__proto__']: 'proto-7',
        },
      }),
    ).resolves.toMatchObject({ status: 'submitted' });

    // Core's Command boundary canonicalizes the payload and its renderer
    // writes every attribute name it is handed, so the entry reaches the model
    // as ordinary metadata rather than being dropped on the way.
    const rendered = arm.provider.runtimes.flatMap((runtime) => runtime.inputs);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('business_key="BL-7"');
    expect(rendered[0]).toContain('__proto__="proto-7"');
    expect(rendered[0]).toContain('>the faithful body</channel>');
  });
});
