/**
 * The instance capability an extension uses to deliver input it owns: after a
 * click it has already answered, and from a timer that never saw a callback.
 *
 * Everything here runs through the real plugin, provider and session — the
 * published extension api, the real routing document, the real access gate and
 * the real typed Core client — with only Core's answers and Feishu's own
 * platform scripted. The contract under test is the precondition (the
 * conversation must still route to the expected Team), the outcome taxonomy
 * (Core's actual answer, or a refusal this Channel proved without invoking
 * anything), the payload rules (the checked target owns provenance; the caller
 * owns text, identity and reminder) and the lifecycle (close refuses new work
 * and drains in-flight work to its actual answer instead of guessing one).
 *
 * Presentation is asserted the same way: the operation claims no anchor and
 * registers no echo correlation, so Core's later input event for that same
 * source id is still rendered by the existing COT rules at whatever anchor
 * already stands — unlike a detached extension forward, which keeps its
 * existing anchor and correlation effects.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelProvider,
  ContributeHost,
  DreamuxLogger,
  DreamuxPlugin,
  JsonValue,
  ServerHost,
  TeamSummary,
} from '@excitedjs/dreamux-types';

import { createFeishuBot } from '../src/bot.js';
vi.mock('../src/bot.js', () => ({ createFeishuBot: vi.fn() }));

import { defaultDispatcherAccessState } from '../src/access/state.js';
import { CHANNEL_REMINDER } from '../src/feishu-submit.js';
import {
  createFeishuPlugin,
  type FeishuApi,
  type FeishuBoundTeamSubmitOutcome,
  type FeishuExtension,
  type FeishuInstanceApi,
} from '../src/index.js';
import type { FeishuChannelConfig } from '../src/provider.js';
import {
  chatTarget,
  topicTarget,
  type FeishuTarget,
} from '../src/routing/target.js';
import type { FeishuChannelSession } from '../src/session/session.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';
import { createFakeCotClient } from './helpers/fake-feishu-cot.js';
import { teamSummary } from './helpers/team-status.js';

const GROUP = chatTarget('oc_group', 'group');

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLog,
};

let dir: string;
/** Every session this test created, so teardown never depends on its assertions. */
const runningSessions: Array<{ close(): Promise<void> }> = [];
/** Every Command this test holds open, so teardown can answer one its assertions never reached. */
const heldCommands: HeldCommand[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-input-delivery-'));
  runningSessions.length = 0;
  heldCommands.length = 0;
});

afterEach(async () => {
  // Unconditional, and before mocks are restored or storage removed: a session
  // owns a live timer as soon as an extension started one, so a failed
  // assertion must not be what decides whether it stops.
  //
  // The held Commands are answered first, for the same reason: `close()` drains
  // the work tracked against it, so a Command whose own `resolve` an assertion
  // failure skipped would leave that drain — and this teardown — waiting
  // forever. Answering one the test already answered is a no-op.
  for (const held of heldCommands.splice(0)) {
    held.resolve({ status: 'failed', error: null });
  }
  for (const session of runningSessions.splice(0).reverse()) {
    await session.close();
  }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── The real plugin, provider and session ────────────────────────────────

interface Loaded {
  api: FeishuApi;
  provider: ChannelProvider<FeishuChannelConfig>;
}

/** Run the plugin's `contribute` and `server` the way Dreamux does. */
function loadFeishu(bots: FakeFeishuBot[] = []): Loaded {
  let next = 0;
  vi.mocked(createFeishuBot).mockImplementation(
    () => bots[next++] ?? createFakeFeishuBot(),
  );
  const plugin: DreamuxPlugin = createFeishuPlugin();
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
  const serverHost: ServerHost = {
    config: undefined,
    stateDir: join(dir, 'plugin-state'),
    logger: silentLog,
    get hooks(): ServerHost['hooks'] {
      throw new Error(
        'Feishu server initialization does not subscribe to host hooks',
      );
    },
  };
  plugin.server?.(serverHost);
  expect(provided).toHaveLength(1);
  return {
    api: plugin.api as FeishuApi,
    provider: provided[0] as ChannelProvider<FeishuChannelConfig>,
  };
}

/** The access file a click or message in `oc_group` is admitted under. */
function writeAccess(allowChats: string[]): void {
  writeFileSync(
    join(dir, 'access.json'),
    JSON.stringify({
      ...defaultDispatcherAccessState(),
      group: {
        policy: 'allowlist',
        allow_chats: allowChats,
        require_mention: true,
      },
    }),
  );
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

/** Planned work an extension does on its own, with no callback to answer. */
interface TimerPlan {
  /** How often the extension's own interval fires. */
  readonly everyMs: number;
  readonly text: string;
  readonly sourceId: string;
}

/** The extension under test: it holds the api and records what it decided. */
interface InputExtension {
  readonly extension: FeishuExtension<FeishuInstanceApi>;
  /** One entry per Feishu instance, keyed by that instance's channel id. */
  readonly apis: Map<string, FeishuInstanceApi>;
  readonly clicks: string[];
  /** One entry per click: the delivery the handler started before answering. */
  readonly deliveries: Array<Promise<FeishuBoundTeamSubmitOutcome>>;
  /** One entry per tick of this extension's own interval, in firing order. */
  readonly timerFires: Array<Promise<FeishuBoundTeamSubmitOutcome>>;
}

function inputExtension(
  target: FeishuTarget = GROUP,
  name = 'alpha',
  options: { readonly timer?: TimerPlan } = {},
): InputExtension {
  const apis = new Map<string, FeishuInstanceApi>();
  const clicks: string[] = [];
  const deliveries: InputExtension['deliveries'] = [];
  const timerFires: InputExtension['timerFires'] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const extension: FeishuExtension<FeishuInstanceApi> = {
    name,
    tools: [],
    cardActions: [
      {
        key: `${name}_decide`,
        async handle(state, event) {
          const decision = String(event.actionValue['decision'] ?? '');
          clicks.push(decision);
          // The click is answered here; the delivery it starts is awaited by
          // later work, which is what keeps the callback inside Feishu's
          // few-second window.
          deliveries.push(
            state.submitToBoundTeam({
              target,
              expectedTeamName: 'alpha',
              text: `decision ${decision}`,
              sourceId: 'click-1',
            }),
          );
          return {
            response: { toast: { type: 'success', content: '记录成功' } },
          };
        },
      },
    ],
    initialize: async (context) => {
      apis.set(context.channelId, context.api);
      return context.api;
    },
    // The documented home for an extension's timers: the bot connection is
    // live, so the outbound work this schedule does is allowed to start.
    start: async (state) => {
      const plan = options.timer;
      if (plan === undefined) return;
      timer = setInterval(() => {
        timerFires.push(
          state.submitToBoundTeam({
            target,
            expectedTeamName: name,
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
  return { extension, apis, clicks, deliveries, timerFires };
}

/** The api one instance's `initialize` handed this extension. */
function apiOf(
  holder: InputExtension,
  channelId = 'primary',
): FeishuInstanceApi {
  const api = holder.apis.get(channelId);
  if (api === undefined) {
    throw new Error(`the extension was not initialized for ${channelId}`);
  }
  return api;
}

// ── A scripted Core port ────────────────────────────────────────────────

interface CommandCall {
  readonly command: string;
  readonly payload: Record<string, unknown>;
}

/** What one submit Command answers: a result, or something to throw. */
type CoreAnswer = JsonValue | Promise<JsonValue> | { readonly throw: unknown };

function isThrownAnswer(
  answer: CoreAnswer,
): answer is { readonly throw: unknown } {
  return typeof answer === 'object' && answer !== null && 'throw' in answer;
}

interface ScriptedCore {
  readonly port: ChannelCorePort;
  readonly calls: CommandCall[];
  readonly submissions: CommandCall[];
  /** Deliver one Core event to this session's subscription. */
  publish(event: ChannelCoreEvent): void;
}

const asPortResult = (summary: TeamSummary): JsonValue =>
  JSON.parse(JSON.stringify(summary)) as JsonValue;

/**
 * A Core port that records every Command, answers `team.status` for any Team,
 * and plays one scripted answer per submit. An answer the script does not
 * cover is a plain success, so a test that cares whether a second call
 * happened asserts the recorded call count rather than relying on the script
 * running dry.
 */
function scriptedCore(plan: { answers?: CoreAnswer[] } = {}): ScriptedCore {
  const answers = [...(plan.answers ?? [])];
  const calls: CommandCall[] = [];
  const submissions: CommandCall[] = [];
  const listeners: Array<(event: ChannelCoreEvent) => void | Promise<void>> =
    [];
  const port: ChannelCorePort = {
    invoke: {
      async invoke(command, payload) {
        const call: CommandCall = {
          command,
          payload: payload as Record<string, unknown>,
        };
        calls.push(call);
        if (command === 'team.status') {
          return asPortResult(teamSummary(String(call.payload['team_name'])));
        }
        if (command === 'team.submit' || command === 'dispatcher.submit') {
          submissions.push(call);
          const next = answers.shift();
          if (next !== undefined && isThrownAnswer(next)) throw next.throw;
          return next === undefined
            ? { status: 'submitted', turn_id: `turn-${submissions.length}` }
            : ((await next) as JsonValue);
        }
        throw new Error(`unexpected Core command ${command}`);
      },
    },
    events: {
      subscribe(listener) {
        listeners.push(listener);
        return {
          unsubscribe: () => {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          },
        };
      },
    },
  };
  return {
    port,
    calls,
    submissions,
    publish: (event) => {
      for (const listener of [...listeners]) void listener(event);
    },
  };
}

/** A Team-leader input fact: the event Core publishes at submission time. */
function leaderInput(
  sourceId: string,
  content: string,
  teamName = 'alpha',
  teammateName = 'alpha-leader',
): ChannelCoreEvent {
  return {
    schemaVersion: 1,
    occurredAt: Date.now(),
    kind: 'teammate.input',
    teammateName,
    role: 'team_leader',
    teamName,
    source: 'feishu',
    sourceId,
    content,
    notice: null,
  };
}

/** Every projected body one COT card holds, in arrival order. */
function cotDeltas(cards: ReturnType<typeof createFakeCotClient>['cards']) {
  return cards
    .flatMap((card) => card.events)
    .filter((event) => event.eventType === 'TEXT_MESSAGE_CONTENT')
    .map((event) => event.content['delta']);
}

/** A Command failure as it crosses Core's port: an `Error` tagged with a code. */
function taggedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A deferred promise, for a Command the test decides when to answer. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/** One Command answer the test itself holds open. */
interface HeldCommand {
  readonly promise: Promise<JsonValue>;
  resolve(value: JsonValue): void;
}

/** A held Command, registered so the fixture can answer it if the test cannot. */
function heldCommand(): HeldCommand {
  const held = deferred<JsonValue>();
  heldCommands.push(held);
  return held;
}

/** One started session over its own bot, port and extension api. */
/**
 * The concrete Feishu session behind the neutral `ChannelSession` contract.
 * Inspecting the routing document is a test-only need here; no caller outside
 * this package holds a `FeishuChannelSession`.
 */
function feishuSession(instance: { session: unknown }): FeishuChannelSession {
  return instance.session as FeishuChannelSession;
}

/** One started session over its own bot, port and extension api. */
async function startedSession(input: {
  bots?: FakeFeishuBot[];
  channelId?: string;
  core?: ScriptedCore;
  extension?: InputExtension;
}) {
  const { api, provider } = loadFeishu(input.bots);
  const extension = input.extension ?? inputExtension();
  api.extensions.register(extension.extension);
  const core = input.core ?? scriptedCore();
  const instance = await createSession(provider, input.channelId ?? 'primary');
  runningSessions.push(instance.session);
  await instance.session.initialize(core.port);
  await instance.session.start();
  return { instance, core, extension };
}

/** Bind `oc_group` to a Team through the instance api Dreamux drives. */
async function bindGroup(
  api: FeishuInstanceApi,
  teamName = 'alpha',
): Promise<void> {
  await api.bindTeam({ target: GROUP, teamName, display: '' });
}

// ── Delivery from a click and from a timer ───────────────────────────────

describe('an extension delivers input through its own Feishu instance', () => {
  it('answers an admitted card click before the submission is admitted, and lets later work observe the outcome', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_group', 'group');
    writeAccess(['oc_group']);
    const held = heldCommand();
    const core = scriptedCore({ answers: [held.promise] });
    const { instance, extension } = await startedSession({
      bots: [bot],
      core,
    });
    await bindGroup(apiOf(extension));

    const clicked = bot.injectCardAction({
      operatorOpenId: 'operator',
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      actionValue: { dreamux_action: 'alpha_decide', decision: 'approve' },
      raw: {},
    });

    // The callback is answered while the Command it started is still pending:
    // acknowledgement does not wait for admission.
    await expect(clicked).resolves.toEqual({
      toast: { type: 'success', content: '记录成功' },
    });
    expect(extension.clicks).toEqual(['approve']);
    expect(core.submissions).toHaveLength(1);

    held.resolve({ status: 'submitted', turn_id: 'turn-click' });
    await expect(extension.deliveries[0]!).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-click',
    });
    expect(core.submissions[0]!.payload).toMatchObject({
      team_name: 'alpha',
      text: 'decision approve',
      source_id: 'click-1',
    });

    await instance.session.close();
  });

  it('delivers what its own timer produced, with no card callback, no sibling channel and no Core port of its own', async () => {
    const core = scriptedCore();
    const holder = inputExtension(GROUP, 'alpha', {
      timer: {
        everyMs: 50,
        text: 'nightly sweep found nothing',
        sourceId: 'timer-1',
      },
    });
    const { instance } = await startedSession({
      bots: [createFakeFeishuBot()],
      core,
      extension: holder,
    });
    await bindGroup(apiOf(holder));

    // Nothing called into this extension: its own interval fired. The schedule
    // is not synchronised with the awaited route commit above, so a tick that
    // lands before that commit refuses — the contract, not a failure — and a
    // tick after it is admitted. Wait for an admitted one rather than for
    // "some tick", so neither ordering can fail this test.
    await vi.waitFor(
      async () => {
        const outcomes = await Promise.all([...holder.timerFires]);
        expect(outcomes.some((outcome) => outcome.status === 'submitted')).toBe(
          true,
        );
      },
      { timeout: 3000, interval: 5 },
    );

    await instance.session.close();
    const outcomes = await Promise.all([...holder.timerFires]);
    let admitted = false;
    let submitted = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'submitted') {
        admitted = true;
        submitted += 1;
        continue;
      }
      // A tick refused before the first admission refused because the route
      // was not committed yet; one refused after it refused because teardown
      // had already fenced the instance. Each names its own phase, so a tick
      // is never read as the other's evidence.
      const legal = admitted
        ? outcome.status === 'refused' && outcome.reason === 'closed'
        : outcome.status === 'refused' && outcome.reason === 'binding_changed';
      expect(legal).toBe(true);
    }
    expect(submitted).toBeGreaterThanOrEqual(1);
    // One Command per admitted tick and none for a refused one, through this
    // instance's own port: no `dispatcher.submit` fallback, no second channel.
    expect(core.submissions).toHaveLength(submitted);
    expect(
      core.submissions.every(
        (call) =>
          call.payload['team_name'] === 'alpha' &&
          call.payload['text'] === 'nightly sweep found nothing' &&
          call.payload['source_id'] === 'timer-1',
      ),
    ).toBe(true);
    expect(holder.clicks).toEqual([]);
    expect(holder.apis.size).toBe(1);

    // Cleanup: teardown cleared the interval, so nothing fires past the next
    // few ticks and nothing more reaches Core.
    const fired = holder.timerFires.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(holder.timerFires).toHaveLength(fired);
    expect(core.submissions).toHaveLength(submitted);
  });

  it('accepts the target a card send reports, so the address comes from Feishu', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_group', 'group');
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ bots: [bot], core });
    await bindGroup(apiOf(extension));

    const sent = await apiOf(extension).sendCard({
      chatId: 'oc_group',
      card: { type: 'card' },
    });
    expect(sent.target).toEqual(GROUP);

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: sent.target,
        expectedTeamName: 'alpha',
        text: 'from the card',
        sourceId: 'card-1',
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });

    await instance.session.close();
  });
});

// ── The expected-Team precondition ───────────────────────────────────────

describe('delivery is constrained to the expected bound Team', () => {
  it('refuses an unbound conversation without invoking Core', async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'nobody is listening',
        sourceId: 's-unbound',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'binding_changed' });
    expect(core.submissions).toEqual([]);

    await instance.session.close();
  });

  it('refuses after a rebind instead of reaching the new owner, and leaves the committed route alone', async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension), 'alpha');
    await bindGroup(apiOf(extension), 'beta');

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'stale decision',
        sourceId: 's-rebound',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'binding_changed' });

    expect(core.submissions).toEqual([]);
    expect(feishuSession(instance).routing.listBindings()).toEqual([
      expect.objectContaining({ chat_id: 'oc_group', team_name: 'beta' }),
    ]);

    await instance.session.close();
  });

  it('refuses after an unbind, and does not provision, fall back or create a Team', async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension));
    await feishuSession(instance).routing.unbind(GROUP);

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'after the release',
        sourceId: 's-unbound-late',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'binding_changed' });

    expect(core.calls.filter((call) => call.command !== 'team.status')).toEqual(
      [],
    );

    await instance.session.close();
  });

  it('refuses a Collaboration Space topic that ordinary inbound would provision for, and creates nothing', async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await feishuSession(instance).routing.bindSpace({
      spaceName: 'space-1',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'claude-code',
      identity: null,
      repo: null,
    });
    const topic = topicTarget('oc_space', 'omt_1');

    // The ordinary inbound path really would provision here: the container
    // carries a Space policy and the topic has no binding of its own.
    expect(feishuSession(instance).routing.plan(topic, 'oc_space').kind).toBe(
      'provision',
    );

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: topic,
        expectedTeamName: 'alpha',
        text: 'no Team yet',
        sourceId: 's-provision',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'binding_changed' });

    expect(core.calls.filter((call) => call.command !== 'team.status')).toEqual(
      [],
    );
    expect(feishuSession(instance).routing.listSpaces()).toHaveLength(1);

    await instance.session.close();
  });

  it("lets a topic deliver through its group's binding, without writing a topic row", async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension));

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: topicTarget('oc_group', 'omt_1'),
        expectedTeamName: 'alpha',
        text: 'in the topic',
        sourceId: 's-topic',
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });

    expect(core.submissions[0]!.payload).toMatchObject({
      team_name: 'alpha',
      attrs: { source: 'feishu', chat_id: 'oc_group', thread_id: 'omt_1' },
    });
    expect(feishuSession(instance).routing.listBindings()).toEqual([
      expect.objectContaining({
        target_kind: 'group',
        chat_id: 'oc_group',
        thread_id: null,
      }),
    ]);

    await instance.session.close();
  });

  it('cannot retarget a Command already sent, and the next call observes the new binding', async () => {
    const held = heldCommand();
    const core = scriptedCore({ answers: [held.promise] });
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension), 'alpha');

    const inFlight = apiOf(extension).submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'decided before the rebind',
      sourceId: 's-inflight',
    });
    await bindGroup(apiOf(extension), 'beta');

    held.resolve({ status: 'submitted', turn_id: 'turn-alpha' });
    await expect(inFlight).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-alpha',
    });
    expect(core.submissions[0]!.payload['team_name']).toBe('alpha');

    await expect(
      apiOf(extension).submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'after the rebind',
        sourceId: 's-after',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'binding_changed' });
    expect(core.submissions).toHaveLength(1);

    await instance.session.close();
  });
});

// ── Outcomes ────────────────────────────────────────────────────────────

describe('the outcome is what Core said, never a boolean', () => {
  const cases: Array<{
    name: string;
    answer: CoreAnswer;
    expected: FeishuBoundTeamSubmitOutcome;
  }> = [
    {
      name: 'a submission',
      answer: { status: 'submitted', turn_id: 'turn-9' },
      expected: { status: 'submitted', turnId: 'turn-9' },
    },
    {
      name: 'a submission with no turn id',
      answer: { status: 'submitted' },
      expected: { status: 'submitted', turnId: null },
    },
    {
      name: 'a duplicate',
      answer: { status: 'duplicate' },
      expected: { status: 'duplicate' },
    },
    {
      name: 'a stopped turn',
      answer: { status: 'stopped' },
      expected: { status: 'stopped' },
    },
    {
      name: 'a failed runtime admission',
      answer: {
        status: 'failed',
        error: { code: 'runtime_rejected', message: 'runtime refused' },
      },
      expected: {
        status: 'failed',
        error: { code: 'runtime_rejected', message: 'runtime refused' },
      },
    },
    {
      name: 'an ambiguous admission',
      answer: {
        status: 'ambiguous',
        error: { code: 'timeout', message: 'no receipt in time' },
      },
      expected: {
        status: 'ambiguous',
        error: { code: 'timeout', message: 'no receipt in time' },
      },
    },
    {
      name: 'a named-Team rejection',
      answer: { throw: taggedError('no such Team', 'TEAM_NOT_FOUND') },
      expected: {
        status: 'rejected',
        code: 'TEAM_NOT_FOUND',
        message: 'no such Team',
      },
    },
    {
      name: 'a closed-Team rejection',
      answer: { throw: taggedError('the Team closed', 'TEAM_CLOSED') },
      expected: {
        status: 'rejected',
        code: 'TEAM_CLOSED',
        message: 'the Team closed',
      },
    },
    {
      name: 'an unknown invocation failure',
      answer: { throw: new Error('the port exploded') },
      expected: { status: 'error', message: 'the port exploded' },
    },
  ];

  it.each(cases)(
    'returns $name unchanged, with no retry and no fallback',
    async (testCase) => {
      const core = scriptedCore({ answers: [testCase.answer] });
      const { instance, extension } = await startedSession({ core });
      await bindGroup(apiOf(extension));

      await expect(
        apiOf(extension).submitToBoundTeam({
          target: GROUP,
          expectedTeamName: 'alpha',
          text: 'one decision',
          sourceId: 's-outcome',
        }),
      ).resolves.toEqual(testCase.expected);

      // One Command for one call: nothing retried, and no `dispatcher.submit`
      // fallback behind a rejection.
      expect(core.submissions).toHaveLength(1);
      expect(core.submissions[0]!.command).toBe('team.submit');
      // A rejection does not reconcile or drop the route either.
      expect(feishuSession(instance).routing.listBindings()).toEqual([
        expect.objectContaining({ team_name: 'alpha' }),
      ]);

      await instance.session.close();
    },
  );
});

// ── Payload ─────────────────────────────────────────────────────────────

describe('the payload states provenance, identity and reminder', () => {
  it("keeps the checked target's provenance, and caller metadata cannot replace it", async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension));

    await apiOf(extension).submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'the faithful body',
      sourceId: 's1',
      attrs: {
        sender_id: 'ou_human',
        source: 'somewhere-else',
        chat_id: 'oc_elsewhere',
        thread_id: 'invented-thread',
        business_key: 'BL-7',
        // A computed key, so this stays an own entry named `__proto__` —
        // caller metadata on an open string-key map — instead of a prototype.
        ['__proto__']: 'proto-7',
      },
    });

    expect(core.submissions[0]!.payload).toEqual({
      team_name: 'alpha',
      // The caller's own entries survive — the three addresses among them
      // replaced by the checked target's — and so does the `__proto__` one.
      attrs: {
        sender_id: 'ou_human',
        business_key: 'BL-7',
        ['__proto__']: 'proto-7',
        source: 'feishu',
        chat_id: 'oc_group',
      },
      text: 'the faithful body',
      source_id: 's1',
      reminder: CHANNEL_REMINDER,
    });

    // And it arrives as data: the key is the delivery's own property, and the
    // delivery's prototype is still `Object.prototype` rather than the value
    // the caller attached to that name.
    const delivered = core.submissions[0]!.payload[
      'attrs'
    ] as unknown as object;
    expect(Object.getPrototypeOf(delivered)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(delivered, '__proto__')?.value).toBe(
      'proto-7',
    );

    await instance.session.close();
  });

  it('lets the caller replace the standing note, or deliberately send none', async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension));
    const api = apiOf(extension);

    await api.submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'default note',
      sourceId: 's-default',
    });
    await api.submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'own note',
      sourceId: 's-own',
      reminder:
        'This decision came from a timer; reply in the thread it names.',
    });
    await api.submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'no note',
      sourceId: 's-none',
      reminder: '',
    });

    expect(core.submissions[0]!.payload['reminder']).toBe(CHANNEL_REMINDER);
    expect(core.submissions[1]!.payload['reminder']).toBe(
      'This decision came from a timer; reply in the thread it names.',
    );
    expect(core.submissions[2]!.payload).not.toHaveProperty('reminder');
    // Replacement, not concatenation: the channel note is not added behind a
    // caller's own note.
    expect(core.submissions[1]!.payload['reminder']).not.toContain(
      CHANNEL_REMINDER,
    );

    await instance.session.close();
  });

  it('passes the caller source id through untouched, empty included', async () => {
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension));
    const api = apiOf(extension);

    await api.submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'retryable decision',
      sourceId: 'decision-42',
    });
    await api.submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'undeduplicated decision',
      sourceId: '',
    });

    expect(core.submissions[0]!.payload['source_id']).toBe('decision-42');
    expect(core.submissions[1]!.payload['source_id']).toBe('');

    await instance.session.close();
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────

describe('the capability belongs to one instance and to its lifecycle', () => {
  it('refuses new work once closing and drains the Command already sent to its actual answer', async () => {
    const held = heldCommand();
    const core = scriptedCore({ answers: [held.promise] });
    const { instance, extension } = await startedSession({ core });
    await bindGroup(apiOf(extension));
    const api = apiOf(extension);

    const admitted = api.submitToBoundTeam({
      target: GROUP,
      expectedTeamName: 'alpha',
      text: 'decided just before close',
      sourceId: 's-drain',
    });
    let closed = false;
    const closing = instance.session.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Teardown is waiting on tracked work, not racing it.
    expect(closed).toBe(false);

    await expect(
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'too late',
        sourceId: 's-late',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'closed' });
    expect(core.submissions).toHaveLength(1);

    held.resolve({ status: 'failed', error: null });
    // The admitted call returns what Core actually said, not a refusal the
    // close could have guessed.
    await expect(admitted).resolves.toEqual({ status: 'failed', error: null });
    await closing;
    expect(closed).toBe(true);

    await expect(
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'after close',
        sourceId: 's-after-close',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'closed' });
    expect(core.submissions).toHaveLength(1);
  });

  it('keeps two Feishu instances on their own routing, Core port and lifecycle', async () => {
    const first = scriptedCore();
    const second = scriptedCore();
    const loaded = loadFeishu([createFakeFeishuBot(), createFakeFeishuBot()]);
    const firstExtension = inputExtension(GROUP, 'alpha');
    const secondExtension = inputExtension(GROUP, 'beta');
    loaded.api.extensions.register(firstExtension.extension);
    loaded.api.extensions.register(secondExtension.extension);
    const primary = await createSession(loaded.provider, 'primary');
    const secondary = await createSession(loaded.provider, 'secondary');
    runningSessions.push(primary.session, secondary.session);
    for (const [instance, core] of [
      [primary, first],
      [secondary, second],
    ] as const) {
      await instance.session.initialize(core.port);
      await instance.session.start();
    }
    await bindGroup(apiOf(firstExtension, 'primary'));
    await bindGroup(apiOf(secondExtension, 'secondary'));

    await expect(
      apiOf(firstExtension, 'primary').submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'primary input',
        sourceId: 'p-1',
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(first.submissions).toHaveLength(1);
    expect(second.submissions).toHaveLength(0);

    // What this proves is instance isolation — its own routing, port and
    // lifecycle — and nothing about the scope of Core's source-dedup ledger:
    // two scripted ports cannot answer that, because each was written to
    // accept whatever it is handed. Core's ledger is the recipient's, not the
    // Channel's, so the same id from another instance is a duplicate there;
    // `packages/dreamux/tests/feishu-extension-input-delivery.test.ts` proves
    // that against real Core.
    await primary.session.close();

    await expect(
      apiOf(secondExtension, 'secondary').submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'secondary input',
        sourceId: 'p-1',
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(second.submissions).toHaveLength(1);
    expect(second.submissions[0]!.payload['source_id']).toBe('p-1');

    await secondary.session.close();
  });
});

// ── Presentation ────────────────────────────────────────────────────────

describe('delivery claims no anchor and hides no input', () => {
  it('opens no pre-admission receipt, leaves the standing anchor alone, and does not suppress the input echo', async () => {
    const bot = createFakeFeishuBot();
    const cotClient = createFakeCotClient();
    bot.setCot(cotClient);
    const core = scriptedCore();
    const { instance, extension } = await startedSession({ bots: [bot], core });
    const api = apiOf(extension);
    await bindGroup(api);

    // The bind announcement is an ordinary card and offers the Team its first
    // standing anchor; nothing has opened a COT presentation yet.
    expect(cotClient.cards).toEqual([]);

    await expect(
      api.submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'the extension decided',
        sourceId: 's-echo',
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    // The ordinary submitter would have claimed the anchor and opened a
    // pre-admission receipt here; this call does neither.
    expect(cotClient.cards).toEqual([]);

    core.publish(leaderInput('s-echo', 'the extension decided'));
    await vi.waitFor(() => {
      expect(cotClient.cards).toHaveLength(1);
    });
    // No correlation was registered for this source id, so Core's own input
    // event is still displayed at the standing anchor.
    expect(cotDeltas(cotClient.cards)).toEqual(['the extension decided']);

    await instance.session.close();
  });

  it('invents neither anchor nor presentation for a Team this session never announced', async () => {
    const bot = createFakeFeishuBot();
    const cotClient = createFakeCotClient();
    bot.setCot(cotClient);
    bot.setChatMode('oc_group', 'group');
    // A previous run committed this binding and is gone: the route outlives
    // the session, the anchor it once offered there does not. This session
    // therefore starts with a bound Team and no anchor for it — exactly the
    // case of a leader whose session restarted, and exactly where the
    // ordinary inbound path would have claimed an anchor first.
    const previous = await startedSession({
      bots: [bot],
      core: scriptedCore(),
    });
    await bindGroup(apiOf(previous.extension));
    await previous.instance.session.close();

    const core = scriptedCore();
    const holder = inputExtension();
    const { instance } = await startedSession({
      bots: [bot],
      core,
      extension: holder,
    });
    // The persisted binding really is this session's route.
    expect(apiOf(holder).owner(GROUP)).toBe('alpha');
    expect(cotClient.cards).toEqual([]);

    await expect(
      apiOf(holder).submitToBoundTeam({
        target: GROUP,
        expectedTeamName: 'alpha',
        text: 'the extension decided',
        sourceId: 's-anchorless',
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(core.submissions).toHaveLength(1);

    const cards = cotClient.cards.length;
    const sent = bot.sentCards.length;
    core.publish(leaderInput('s-anchorless', 'the extension decided'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Admission is not presentation, and this operation invented neither: it
    // claimed no anchor, so Core's own input event finds no anchor to render
    // at and opens no card, and nothing is sent to promise visibility.
    expect(cotClient.cards).toHaveLength(cards);
    expect(bot.sentCards).toHaveLength(sent);

    // The control, in this same session over the same adapter: a Team this
    // session did announce has an anchor, and the same kind of event for it
    // does render. That is what makes the silence above evidence about the
    // missing anchor rather than about the event never reaching the adapter.
    await apiOf(holder).bindTeam({
      target: chatTarget('oc_other', 'group'),
      teamName: 'beta',
      display: '',
    });
    // The card landing and the offer of a first anchor are two separate
    // asynchronous steps, and an input event that finds no anchor is never
    // retried — so the same event is republished until the offer has landed.
    await vi.waitFor(
      () => {
        core.publish(
          leaderInput('s-control', 'the beta decision', 'beta', 'beta-leader'),
        );
        expect(cotDeltas(cotClient.cards)).toContain('the beta decision');
      },
      { timeout: 3000, interval: 25 },
    );

    await instance.session.close();
  });

  it('keeps the detached extension forward on its ordinary routing, correlation and anchor path', async () => {
    const bot = createFakeFeishuBot();
    const cotClient = createFakeCotClient();
    bot.setCot(cotClient);
    bot.setChatMode('oc_group', 'group');
    writeAccess(['oc_group']);
    const held = heldCommand();
    const core = scriptedCore({ answers: [held.promise] });
    const loaded = loadFeishu([bot]);
    const holder = inputExtension();
    const forwarding: FeishuExtension<undefined> = {
      name: 'forwarder',
      tools: [],
      cardActions: [
        {
          key: 'forward_card',
          handle: async () => ({
            response: { toast: { type: 'info', content: '已转发' } },
            forward: { text: 'forwarded from the card', sourceId: 's-fwd' },
          }),
        },
      ],
      initialize: async () => undefined,
      start: async () => undefined,
      close: async () => undefined,
    };
    loaded.api.extensions.register(holder.extension);
    loaded.api.extensions.register(forwarding);
    const instance = await createSession(loaded.provider, 'primary');
    runningSessions.push(instance.session);
    await instance.session.initialize(core.port);
    await instance.session.start();
    await bindGroup(apiOf(holder));
    bot.setMessageRead('om_fwd_card', {
      items: [
        {
          messageId: 'om_fwd_card',
          messageType: 'text',
          content: '{}',
          mentions: [],
          deleted: false,
          malformed: false,
          chatId: 'oc_group',
        },
      ],
    });

    await expect(
      bot.injectCardAction({
        operatorOpenId: 'operator',
        openChatId: 'oc_group',
        openMessageId: 'om_fwd_card',
        actionValue: { dreamux_action: 'forward_card' },
        raw: {},
      }),
    ).resolves.toEqual({ toast: { type: 'info', content: '已转发' } });

    // The forward reaches the bound Team through the ordinary path, and opens
    // its pre-admission receipt there — unlike the constrained operation above.
    await vi.waitFor(() => {
      expect(core.submissions).toHaveLength(1);
    });
    expect(core.submissions[0]!.payload).toMatchObject({
      team_name: 'alpha',
      source_id: 's-fwd',
    });
    await vi.waitFor(() => {
      expect(cotClient.cards.length).toBeGreaterThan(0);
    });
    const opened = cotClient.cards.length;

    // Core publishes the input fact while the submission it admitted is still
    // outstanding. The forward registered a correlation for the id it handed
    // Core, so that echo is recognized as this session's own body and hidden.
    core.publish(leaderInput('s-fwd', 'forwarded from the card'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cotDeltas(cotClient.cards)).not.toContain('forwarded from the card');
    held.resolve({ status: 'submitted', turn_id: 'turn-fwd' });
    expect(cotClient.cards).toHaveLength(opened);

    await instance.session.close();
  });
});
