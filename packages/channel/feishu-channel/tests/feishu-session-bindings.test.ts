/**
 * `FeishuBindingOperations` is where every operator-visible routing decision
 * happens: the durable row, the COT route-ownership fence, and the card that
 * tells the conversation, all from one place (COVERAGE CELL F).
 *
 * The load-bearing contract under test is synchronous pre-validation: a
 * manual `bindChannel` must ask Core whether the target Team is routable
 * *before* it persists the binding and *before* it renders a card, so a bind
 * to a nonexistent or closed Team never becomes durable or user-visible. That
 * ordering is asserted by recording the sequence of side effects (Core ask,
 * disk state, card send) rather than by inspecting internals.
 *
 * A direct-message target is refused by the binding operation before Core is
 * queried or a row can be written.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DreamuxLogger,
  JsonValue,
  TeamSummary,
} from '@excitedjs/dreamux-types';

import { teamSummary } from './helpers/team-status.js';

import { FeishuRouting } from '../src/routing/index.js';
import {
  readRoutingDocument,
  routingDocumentPath,
} from '../src/routing/store.js';
import {
  chatTarget,
  topicTarget,
  type FeishuTarget,
} from '../src/routing/target.js';
import { FeishuBindingOperations } from '../src/routing/operations.js';
import { FeishuCotAdapter } from '../src/cot/adapter.js';
import { FeishuCoreCommands } from '../src/feishu-core-commands.js';
import { FeishuTeamSubmitter } from '../src/session/submitter.js';
import { createFeishuLifecycle } from '../src/session/lifecycle.js';
import { FeishuProvisioning } from '../src/feishu-provisioning.js';
import { FeishuInboundRouter } from '../src/inbound/router.js';
import { chatSubmission } from '../src/feishu-submit.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  createFakeCotClient,
  cotTerminal,
  cotTerminalCount,
  cotTexts,
  type FakeCotClient,
} from './helpers/fake-feishu-cot.js';

let dir: string;
const adapters: FeishuCotAdapter[] = [];
const log: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => log,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-binding-ops-'));
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  routing: FeishuRouting;
  cot: FeishuCotAdapter;
  cotClient: FakeCotClient;
  router: FeishuInboundRouter;
  ops: FeishuBindingOperations;
  calls: string[];
  notifications: Array<{
    target: unknown;
    card: unknown;
    replyTo: string | null;
    hasFallbackAnchor: boolean;
  }>;
  cotCalls: Array<{ op: 'released' | 'claimed'; teamName: string }>;
  setStatus(teamName: string, status: 'running' | 'closed' | 'missing'): void;
}

/** The invoke port carries JSON; a Core `TeamSummary` crosses it as plain data. */
const asPortResult = (summary: TeamSummary): JsonValue =>
  JSON.parse(JSON.stringify(summary)) as JsonValue;

async function harness(
  readStatus?: (teamName: string) => Promise<TeamSummary>,
  createTeam?: () => Promise<TeamSummary>,
): Promise<Harness> {
  const routing = new FeishuRouting({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await routing.initialize();
  const statuses = new Map<string, 'running' | 'closed' | 'missing'>();
  const calls: string[] = [];
  const notifications: Harness['notifications'] = [];
  const cotCalls: Harness['cotCalls'] = [];
  const lifecycle = createFeishuLifecycle();
  const cotClient = createFakeCotClient();
  const cot = new FeishuCotAdapter({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    log,
    cotClient,
    lifecycle,
  });
  adapters.push(cot);
  const release = cot.onRouteReleased.bind(cot);
  const claim = cot.onRouteClaimed.bind(cot);
  vi.spyOn(cot, 'onRouteReleased').mockImplementation((input) => {
    cotCalls.push({ op: 'released', teamName: input.teamName });
    release(input);
  });
  vi.spyOn(cot, 'onRouteClaimed').mockImplementation((input) => {
    cotCalls.push({ op: 'claimed', teamName: input.teamName });
    claim(input);
  });
  const commands = new FeishuCoreCommands();
  commands.initialize({
    invoke: async (command, payload) => {
      calls.push(command);
      if (command === 'team.create' && createTeam !== undefined)
        return asPortResult(await createTeam());
      if (command === 'team.submit' || command === 'dispatcher.submit') {
        return { status: 'submitted', turn_id: 'turn-1' };
      }
      if (command !== 'team.status')
        throw new Error(`unexpected command ${command}`);
      const teamName = (payload as Record<string, unknown>)[
        'team_name'
      ] as string;
      if (readStatus !== undefined)
        return asPortResult(await readStatus(teamName));
      const status = statuses.get(teamName) ?? 'missing';
      if (status === 'missing') {
        throw Object.assign(
          new Error(`Team ${JSON.stringify(teamName)} does not exist`),
          {
            code: 'TEAM_NOT_FOUND',
          },
        );
      }
      return asPortResult(teamSummary(teamName, status));
    },
  });
  const ops = new FeishuBindingOperations({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    log,
    routing,
    cot,
    commands,
    outbound: {
      notify(target, card, replyTo, onSent) {
        calls.push('notify');
        notifications.push({
          target,
          card,
          replyTo,
          hasFallbackAnchor: onSent !== undefined,
        });
        onSent?.(`notice-${notifications.length}`);
      },
    },
  });
  const submitter = new FeishuTeamSubmitter({ lifecycle, cot, commands });
  const provisioning = new FeishuProvisioning({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    log,
    routing,
    submitter,
    commands,
    bindings: ops,
  });
  const router = new FeishuInboundRouter({
    log,
    routing,
    bindings: ops,
    provisioning,
    submitter,
    commands,
    bot: createFakeFeishuBot(),
  });
  return {
    routing,
    ops,
    cot,
    cotClient,
    router,
    calls,
    notifications,
    cotCalls,
    setStatus: (teamName, status) => statuses.set(teamName, status),
  };
}

describe('FeishuBindingOperations — manual bind synchronous validation', () => {
  it('refuses direct messages before querying Core or writing any binding row', async () => {
    const h = await harness();
    await expect(
      h.ops.bindChannel({
        target: chatTarget('oc_dm', 'p2p'),
        teamName: 'team-a',
        display: null,
      }),
    ).rejects.toThrow(
      'A Feishu direct message chat cannot be bound to a Team.',
    );
    expect(h.routing.listBindings()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.cotCalls).toEqual([]);
  });

  it('announces the displaced Team on a rebind, but not on first or same-Team binds', async () => {
    const h = await harness();
    h.setStatus('team-a', 'running');
    h.setStatus('team-b', 'running');
    const target = chatTarget('oc_rebind', 'group');
    await h.ops.bindChannel({ target, teamName: 'team-a', display: null });
    expect(JSON.stringify(h.notifications[0]!.card)).not.toContain(
      'Previous Team',
    );
    const result = await h.ops.bindChannel({
      target,
      teamName: 'team-b',
      display: null,
    });
    expect(result).toEqual({
      team_name: 'team-b',
      previous_team_name: 'team-a',
    });
    expect(h.routing.bindingFor(target)?.team_name).toBe('team-b');
    expect(h.notifications[1]).toMatchObject({
      target,
      hasFallbackAnchor: true,
    });
    expect(JSON.stringify(h.notifications[1]!.card)).toContain(
      'Previous Team: team-a',
    );
    await h.ops.bindChannel({ target, teamName: 'team-b', display: null });
    expect(JSON.stringify(h.notifications[2]!.card)).not.toContain(
      'Previous Team',
    );
    expect(h.cotCalls).toEqual([
      { op: 'claimed', teamName: 'team-a' },
      { op: 'released', teamName: 'team-a' },
      { op: 'claimed', teamName: 'team-b' },
      { op: 'claimed', teamName: 'team-b' },
    ]);
  });

  it.each(['topic-root', 'command-message', null] as const)(
    'announces in a separately bound topic using %s without giving its card to the new Team as an anchor',
    async (root) => {
      const h = await harness();
      h.setStatus('team-a', 'running');
      h.setStatus('team-b', 'running');
      const target = chatTarget('oc_group', 'group');
      const topic = topicTarget('oc_group', 'omt_a');
      await h.ops.bindChannel({
        target: topic,
        teamName: 'team-a',
        display: null,
      });
      if (root === 'topic-root') {
        await h.routing.bind({
          target: topic,
          teamName: 'team-a',
          display: null,
          spaceId: null,
          rootMessageId: 'topic-root',
        });
      }
      await h.ops.bindChannel({
        target,
        teamName: 'team-b',
        display: null,
        announceIn: topic,
        ...(root !== null ? { announceMessageId: 'command-message' } : {}),
      });
      expect(h.routing.plan(topic, null)).toMatchObject({
        kind: 'bound',
        teamName: 'team-a',
      });
      expect(h.routing.plan(target, null)).toMatchObject({
        kind: 'bound',
        teamName: 'team-b',
      });
      expect(h.notifications[1]).toMatchObject({
        target: topic,
        hasFallbackAnchor: false,
        replyTo: root,
      });
      expect(JSON.stringify(h.notifications[1]!.card)).toContain(
        'Dreamux group bound',
      );
      expect(h.cotCalls).toEqual([
        { op: 'claimed', teamName: 'team-a' },
        { op: 'claimed', teamName: 'team-b' },
      ]);
    },
  );

  it('asks Core team.status before persisting the binding and before rendering the card', async () => {
    const h = await harness();
    h.setStatus('team-open', 'running');
    const target = chatTarget('oc_group', 'group');

    await h.ops.bindChannel({
      target,
      teamName: 'team-open',
      display: null,
    });

    // Exact order: ask Core, then notify (persistence is not on this trace,
    // but is asserted below to have happened between them).
    expect(h.calls).toEqual(['team.status', 'notify']);
    expect(
      h.routing.bindingFor(chatTarget('oc_group', 'group'))?.team_name,
    ).toBe('team-open');
    expect(h.notifications).toHaveLength(1);
  });

  it('waits for complete canonical context before committing, including a lazy runtime', async () => {
    let resolveStatus!: (answer: TeamSummary) => void;
    const h = await harness(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const bind = vi.spyOn(h.routing, 'bind');
    const pending = h.ops.bindChannel({
      target: chatTarget('chat-a', 'group'),
      teamName: 'team-a',
      display: null,
    });
    expect(bind).not.toHaveBeenCalled();
    expect(h.notifications).toEqual([]);
    resolveStatus(teamSummary('team-a'));
    await pending;
    expect(bind).toHaveBeenCalledOnce();
    const card = JSON.stringify(h.notifications[0]!.card);
    expect(card).toContain('team-a-leader');
    expect(card).toContain('trae-gpt');
    expect(card).toContain('/workspace/team-a');
    expect(h.calls).toEqual(['team.status', 'notify']);
  });

  it('refuses a Team whose stored leader view is missing before binding or announcing', async () => {
    const h = await harness(async () => ({
      ...teamSummary('team-a'),
      leader_state: null,
    }));
    await expect(
      h.ops.bindChannel({
        target: chatTarget('chat-a', 'group'),
        teamName: 'team-a',
        display: null,
      }),
    ).rejects.toThrow('no readable TeamLeader identity');
    expect(h.routing.bindingFor(chatTarget('chat-a', 'group'))).toBeUndefined();
    expect(h.notifications).toEqual([]);
    expect(h.cotCalls).toEqual([]);
  });

  it('a bind to a nonexistent Team never becomes durable and never renders a card', async () => {
    const h = await harness();
    const target = chatTarget('oc_ghost', 'group');

    await expect(
      h.ops.bindChannel({ target, teamName: 'ghost-team', display: null }),
    ).rejects.toThrow(/does not exist/);

    expect(
      h.routing.bindingFor(chatTarget('oc_ghost', 'group')),
    ).toBeUndefined();
    expect(h.notifications).toHaveLength(0);
    expect(h.calls).toEqual(['team.status']);
  });

  it('a bind to a closed Team never becomes durable and never renders a card', async () => {
    const h = await harness();
    h.setStatus('closed-team', 'closed');
    const target = chatTarget('oc_closed', 'group');

    await expect(
      h.ops.bindChannel({ target, teamName: 'closed-team', display: null }),
    ).rejects.toThrow(/is closed/);

    expect(
      h.routing.bindingFor(chatTarget('oc_closed', 'group')),
    ).toBeUndefined();
    expect(h.notifications).toHaveLength(0);
  });
});

describe('FeishuBindingOperations — unbind, and closed-Team cleanup announcement', () => {
  it('unbindChannel releases the COT route and sends the unbound card only when something was actually removed', async () => {
    const h = await harness();
    h.setStatus('team-open', 'running');
    const target = chatTarget('oc_group', 'group');
    await h.ops.bindChannel({ target, teamName: 'team-open', display: null });
    h.notifications.length = 0;
    h.cotCalls.length = 0;

    const result = await h.ops.unbindChannel(target);
    expect(result.team_name).toBe('team-open');
    expect(JSON.stringify(h.notifications[0]!.card)).toContain(
      'the Team remains active.',
    );
    expect(h.cotCalls).toEqual([{ op: 'released', teamName: 'team-open' }]);
    expect(h.notifications).toHaveLength(1);
  });

  it('unbindChannel on an unrouted target is a no-op: no COT release, no card', async () => {
    const h = await harness();
    const result = await h.ops.unbindChannel(chatTarget('oc_never', 'group'));
    expect(result.team_name).toBeNull();
    expect(h.cotCalls).toEqual([]);
    expect(h.notifications).toEqual([]);
  });
});

describe('FeishuBindingOperations — announceRoutesRemoved and presentCommittedBind', () => {
  it('announceRoutesRemoved emits one COT release and one card per removed route', async () => {
    const h = await harness();
    const removed = [
      { target: chatTarget('oc_a', 'group'), display: 'A' },
      { target: chatTarget('oc_b', 'group'), display: null },
    ];

    for (const route of removed) {
      await h.routing.bind({
        ...route,
        teamName: 'closed-team',
        spaceId: null,
        rootMessageId: null,
      });
    }
    await h.ops.forgetTeamRoutes('closed-team', 'team_closed');
    expect(h.routing.listBindings()).toEqual([]);

    expect(h.cotCalls).toEqual([
      { op: 'released', teamName: 'closed-team' },
      { op: 'released', teamName: 'closed-team' },
    ]);
    expect(h.notifications).toHaveLength(2);
    for (const { card } of h.notifications) {
      expect(JSON.stringify(card)).toContain(
        'all of its routes were removed automatically.',
      );
      expect(JSON.stringify(card)).not.toContain('remains active');
    }
  });

  it('presents the committed root even if a later bind has replaced the current root', async () => {
    const h = await harness();
    const target = topicTarget('oc_new', 'omt_new');
    const input = {
      target,
      teamName: 'provisioned-team',
      display: null,
      spaceId: null,
      rootMessageId: 'committed-root',
    };
    const committed = await h.routing.bind(input);
    await h.routing.bind({ ...input, rootMessageId: 'later-root' });
    expect(h.routing.bindingFor(target)?.root_message_id).toBe('later-root');
    h.ops.presentCommittedBind({
      ...input,
      ...committed,
      leaderName: 'leader-a',
      agentRuntime: 'trae-gpt',
      runtimeCwd: '/workspace/team-a',
    });
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      target,
      replyTo: 'committed-root',
      hasFallbackAnchor: true,
    });
  });

  it('presentCommittedBind claims the COT route and sends a bound card with canonical runtime context', async () => {
    const h = await harness();
    const target = chatTarget('oc_new', 'group');
    const fallback = vi.spyOn(h.cot, 'setFallbackAnchorIfAbsent');

    const binding = await h.routing.bind({
      target,
      teamName: 'provisioned-team',
      display: null,
      spaceId: null,
      rootMessageId: null,
    });
    h.ops.presentCommittedBind({
      ...binding,
      target,
      display: null,
      teamName: 'provisioned-team',
      leaderName: 'leader-a',
      agentRuntime: 'trae-gpt',
      runtimeCwd: '/workspace/team-a',
    });

    expect(h.cotCalls).toEqual([
      { op: 'claimed', teamName: 'provisioned-team' },
    ]);
    expect(h.notifications).toEqual([
      {
        target,
        card: expect.anything(),
        replyTo: null,
        hasFallbackAnchor: true,
      },
    ]);
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith('provisioned-team', {
      chatId: target.chatId,
      messageId: 'notice-1',
      target,
      servingTarget: target,
    });
  });
});

async function seedRoute(
  h: Harness,
  target: FeishuTarget,
  teamName: string,
): Promise<void> {
  h.setStatus(teamName, 'running');
  await h.routing.bind({
    target,
    teamName,
    display: null,
    spaceId: null,
    rootMessageId: null,
  });
}

async function submitAt(
  h: Harness,
  target: FeishuTarget,
  messageId: string,
): Promise<void> {
  const outcome = await h.router.deliver({
    target,
    containerChatId: target.kind === 'topic' ? target.chatId : null,
    submission: chatSubmission({
      attrs: { source: 'feishu' },
      text: 'question',
      sourceId: messageId,
      anchor: { chatId: target.chatId, messageId, target },
    }),
  });
  expect(outcome.status).toBe('submitted');
  // All recording-client operations resolve immediately. The next event-loop
  // turn follows the adapter's queued promise work, including card appends.
  await nextTurn();
}

function speak(h: Harness, teamName: string, text: string): void {
  h.cot.handle({
    schemaVersion: 1,
    kind: 'teammate.activity',
    occurredAt: 1,
    teamName,
    role: 'team_leader',
    teammateName: `${teamName}-leader`,
    activity: { kind: 'assistant.message', occurredAt: 1, id: text, text },
  });
}

describe('COT route retirement through routing, submission, and binding owners', () => {
  it.each(['displaced', 'same-Team', 'failed-commit'] as const)(
    'slow provisioning retires only a displaced committed route (%s)',
    async (scenario) => {
      let entered!: () => void;
      const creating = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness(undefined, async () => {
        entered();
        await finish;
        return teamSummary('created-team');
      });
      const target = topicTarget('oc_race', 'thread_race');
      await h.routing.bindSpace({
        spaceName: 'race-space',
        containerChatId: target.chatId,
        display: null,
        leaderAgentRuntime: 'codex',
        identity: null,
        repo: null,
      });
      const pending = h.router.deliver({
        target,
        containerChatId: target.chatId,
        submission: chatSubmission({
          attrs: { source: 'feishu' },
          text: 'create A',
          sourceId: 'create-A',
          anchor: { chatId: target.chatId, messageId: 'create-A', target },
        }),
      });
      await creating;
      const manualTeam =
        scenario === 'same-Team' ? 'created-team' : 'manual-team';
      h.setStatus(manualTeam, 'running');
      const options = {
        dispatcherId: 'disp-1',
        channelId: 'chan-1',
        stateDir: dir,
      };
      const path = routingDocumentPath(options);
      const preserved = `${path}.preserved`;
      try {
        await h.ops.bindChannel({
          target,
          teamName: manualTeam,
          display: null,
        });
        await submitAt(h, target, 'manual-B');
        speak(h, manualTeam, 'manual output before A commits');
        await nextTurn();
        expect(h.cotClient.cards).toHaveLength(1);
        expect(cotTerminal(h.cotClient.cards[0]!)).toBeNull();
        expect(
          (await readRoutingDocument(options)).bindings[0]?.team_name,
        ).toBe(manualTeam);
        h.cotCalls.length = 0;
        h.notifications.length = 0;
        if (scenario === 'failed-commit') {
          renameSync(path, preserved);
          mkdirSync(path);
        }
        release();
        const outcome = await pending;
        await nextTurn();
        if (scenario === 'failed-commit') {
          expect(outcome.status).toBe('unsubmitted');
          expect(h.routing.bindingFor(target)?.team_name).toBe(manualTeam);
          expect(h.cotCalls).toEqual([]);
          expect(h.notifications).toEqual([]);
          expect(cotTerminal(h.cotClient.cards[0]!)).toBeNull();
          speak(h, manualTeam, 'still active after failed commit');
          await nextTurn();
          expect(h.cotClient.cards).toHaveLength(1);
          expect(cotTexts(h.cotClient.cards[0]!)).toContain(
            'still active after failed commit',
          );
        } else {
          expect(outcome.status).toBe('submitted');
          expect(h.routing.bindingFor(target)?.team_name).toBe('created-team');
          expect(
            (await readRoutingDocument(options)).bindings[0]?.team_name,
          ).toBe('created-team');
          expect(h.cotCalls).toEqual([
            ...(scenario === 'displaced'
              ? [{ op: 'released', teamName: manualTeam }]
              : []),
            { op: 'claimed', teamName: 'created-team' },
          ]);
          expect(h.notifications).toHaveLength(1);
          expect(
            JSON.stringify(h.notifications[0]!.card).includes('Previous Team'),
          ).toBe(scenario === 'displaced');
          expect(cotTerminal(h.cotClient.cards[0]!)).toBe(
            scenario === 'displaced' ? 'interrupted' : 'done',
          );
          expect(cotTerminalCount(h.cotClient.cards[0]!)).toBe(1);
          if (scenario === 'displaced')
            speak(h, manualTeam, 'late displaced output');
          speak(h, 'created-team', 'created owner can display');
          await nextTurn();
          expect(h.cotClient.cards).toHaveLength(2);
          expect(h.cotClient.cards[1]!.originMessageId).toBe('create-A');
          expect(cotTexts(h.cotClient.cards[1]!)).toContain(
            'created owner can display',
          );
          expect(h.cotClient.cards.flatMap(cotTexts)).not.toContain(
            'late displaced output',
          );
        }
        expect(h.calls.filter((call) => call === 'team.submit')).toHaveLength(
          scenario === 'failed-commit' ? 1 : 2,
        );
      } finally {
        release();
        await pending;
        if (scenario === 'failed-commit') {
          // The barrier reaches the IO failure only after the preserved file
          // exists; fixture restoration also runs after a failed assertion.
          if (existsSync(preserved)) {
            rmSync(path, { recursive: true, force: true });
            renameSync(preserved, path);
          }
        }
      }
      expect((await readRoutingDocument(options)).bindings[0]?.team_name).toBe(
        scenario === 'failed-commit' ? manualTeam : 'created-team',
      );
    },
  );

  it.each(['unbind', 'rebind'] as const)(
    'a parent %s interrupts the topic it served and preserves an independently bound topic',
    async (operation) => {
      const h = await harness();
      const parent = chatTarget('oc_parent', 'group');
      const inherited = topicTarget('oc_parent', 'thread_inherited');
      const exact = topicTarget('oc_parent', 'thread_exact');
      await seedRoute(h, parent, 'parent-team');
      await seedRoute(h, exact, 'exact-team');
      await submitAt(h, inherited, 'om_inherited');
      await submitAt(h, exact, 'om_exact');
      expect(h.cotClient.cards).toHaveLength(2);
      if (operation === 'unbind') await h.ops.unbindChannel(parent);
      else {
        h.setStatus('replacement-team', 'running');
        await h.ops.bindChannel({
          target: parent,
          teamName: 'replacement-team',
          display: null,
        });
      }
      await nextTurn();
      expect(cotTerminal(h.cotClient.cards[0]!)).toBe('interrupted');
      expect(cotTerminalCount(h.cotClient.cards[0]!)).toBe(1);
      expect(cotTerminal(h.cotClient.cards[1]!)).toBeNull();
      speak(h, 'parent-team', 'late parent output');
      speak(h, 'exact-team', 'exact route still active');
      await nextTurn();
      expect(h.cotClient.cards).toHaveLength(2);
      expect(cotTexts(h.cotClient.cards[1]!)).toContain(
        'exact route still active',
      );
    },
  );

  it('keeps the serving route captured before an exact route is added for another Team', async () => {
    const h = await harness();
    const parent = chatTarget('oc_parent', 'group');
    const topic = topicTarget('oc_parent', 'thread_shared');
    await seedRoute(h, parent, 'old-team');
    await submitAt(h, topic, 'om_old');
    h.setStatus('new-team', 'running');
    await h.ops.bindChannel({
      target: topic,
      teamName: 'new-team',
      display: null,
    });
    await submitAt(h, topic, 'om_new');
    await h.ops.unbindChannel(parent);
    await nextTurn();
    expect(h.cotClient.cards).toHaveLength(2);
    expect(cotTerminal(h.cotClient.cards[0]!)).toBe('interrupted');
    expect(cotTerminal(h.cotClient.cards[1]!)).toBeNull();
    speak(h, 'old-team', 'must not appear');
    speak(h, 'new-team', 'still exact');
    await nextTurn();
    expect(h.cotClient.cards).toHaveLength(2);
    expect(cotTexts(h.cotClient.cards[1]!)).toContain('still exact');
  });

  it('a silent committed removal retires its parent-served COT without any notification', async () => {
    const h = await harness();
    const parent = chatTarget('oc_parent', 'group');
    const topic = topicTarget('oc_parent', 'thread_child');
    await seedRoute(h, parent, 'gone-team');
    await submitAt(h, topic, 'om_before_remove');
    await h.ops.forgetTeamRoutes('gone-team', 'silent');
    await nextTurn();
    expect(h.routing.bindingFor(parent)).toBeUndefined();
    expect(
      (
        await readRoutingDocument({
          dispatcherId: 'disp-1',
          channelId: 'chan-1',
          stateDir: dir,
        })
      ).bindings,
    ).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(cotTerminal(h.cotClient.cards[0]!)).toBe('interrupted');
    expect(cotTerminalCount(h.cotClient.cards[0]!)).toBe(1);
    speak(h, 'gone-team', 'late after silent removal');
    await nextTurn();
    expect(h.cotClient.cards).toHaveLength(1);
  });

  it('a failed disk commit keeps the route and its COT active and announces nothing', async () => {
    const h = await harness();
    const parent = chatTarget('oc_parent', 'group');
    await seedRoute(h, parent, 'live-team');
    await submitAt(h, topicTarget('oc_parent', 'thread_child'), 'om_live');
    const options = {
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      stateDir: dir,
    };
    const path = routingDocumentPath(options);
    const preserved = `${path}.preserved`;
    renameSync(path, preserved);
    mkdirSync(path);
    try {
      // Replacing a directory with the atomic JSON write fails at the real IO
      // boundary, after the store already holds the last committed document.
      await h.ops.forgetTeamRoutes('live-team', 'silent');
    } finally {
      rmSync(path, { recursive: true, force: true });
      renameSync(preserved, path);
    }
    await nextTurn();
    expect(h.routing.bindingFor(parent)?.team_name).toBe('live-team');
    expect((await readRoutingDocument(options)).bindings[0]?.team_name).toBe(
      'live-team',
    );
    expect(h.cotCalls).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(cotTerminal(h.cotClient.cards[0]!)).toBeNull();
    speak(h, 'live-team', 'continued after failed removal');
    await nextTurn();
    expect(h.cotClient.cards).toHaveLength(1);
    expect(cotTexts(h.cotClient.cards[0]!)).toContain(
      'continued after failed removal',
    );
  });
});
