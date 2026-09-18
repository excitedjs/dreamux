/**
 * `FeishuChannelSession` integration coverage (COVERAGE CELL F): the exact
 * fallback/typed-rejection contract from `requirement.md`'s "Channel-owned
 * external routing" section — a typed pre-admission
 * `TEAM_NOT_FOUND`/`TEAM_CLOSED` removes the stale binding and delivers
 * exactly once to the Dispatcher Agent through `dispatcher.submit`; an
 * ambiguous or unknown post-submit outcome must never double-deliver — plus
 * the Collaboration Space provisioning contract: a run that never delivers to
 * its Team answers the triggering message in place with the fixed failure
 * notice and invokes no `dispatcher.submit`, while `failed` / `ambiguous` /
 * `error` post no notice — and the shutdown/close ordering contract: a
 * Channel-owned asynchronous mutation tail (the routing-document write)
 * settles before `close()` returns, and no presentation callback fires after
 * the session's own fence is aborted.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelEventSubscription,
  DreamuxLogger,
  JsonValue,
  TeamStateEvent,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import { defaultDispatcherAccessState, saveDispatcherAccess } from '../src/feishu-gate.js';
import { routingDocumentFilename } from '../src/routing/store.js';
import { spaceId as deriveSpaceId } from '../src/routing/naming.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';
import { teamSummary } from './helpers/team-status.js';

let dir: string;
let attachDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-session-state-'));
  attachDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-session-attach-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(attachDir, { recursive: true, force: true });
});

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

interface FakePort {
  port: ChannelCorePort;
  emit(event: ChannelCoreEvent): void;
  calls: Array<{ command: string; payload: JsonValue }>;
}

function fakePort(
  invoke: (command: string, payload: JsonValue) => Promise<JsonValue>,
): FakePort {
  const listeners: Array<(event: ChannelCoreEvent) => void | Promise<void>> = [];
  const calls: FakePort['calls'] = [];
  return {
    calls,
    port: {
      invoke: {
        invoke: async (command, payload) => {
          calls.push({ command, payload });
          return invoke(command, payload);
        },
      },
      events: {
        subscribe(listener): ChannelEventSubscription {
          listeners.push(listener);
          return { unsubscribe: () => undefined };
        },
      },
    },
    emit(event) {
      for (const listener of listeners) void listener(event);
    },
  };
}

async function newSession(
  bot: FakeFeishuBot,
  channelId = 'chan-session',
): Promise<FeishuChannelSession> {
  return new FeishuChannelSession({
    dispatcherId: 'disp-1',
    channelId,
    appId: 'app-1',
    appSecret: '',
    stateDir: dir,
    attachmentCacheDir: attachDir,
    log: silentLog,
    botFactory: () => bot,
  });
}

function teamClosedError(): Error & { code: string } {
  const err = new Error('team is closed') as Error & { code: string };
  err.code = 'TEAM_CLOSED';
  return err;
}

function teamNotFoundError(): Error & { code: string } {
  const err = new Error('no such team') as Error & { code: string };
  err.code = 'TEAM_NOT_FOUND';
  return err;
}

/**
 * Poll until `predicate` is true or the timeout elapses. The store's own
 * commit is real (bounded) filesystem I/O, so a plain microtask flush is not
 * always enough; a short bounded poll is deterministic without depending on
 * wall-clock timing of the production code itself.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function readBindings(channelId: string): Array<Record<string, unknown>> {
  const filename = routingDocumentFilename(channelId);
  const onDisk = JSON.parse(readFileSync(join(dir, filename), 'utf8')) as {
    bindings: Array<Record<string, unknown>>;
  };
  return onDisk.bindings;
}

describe('FeishuChannelSession.deliver — typed pre-admission rejection fallback', () => {
  it('TEAM_CLOSED during a refused dissolve: removes the route neutrally and falls back once', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-closed';
    const session = await newSession(bot, channelId);
    let submitCalls = 0;
    const port = fakePort(async (command, payload) => {
      if (command !== 'team.submit' && command !== 'dispatcher.submit') {
        throw new Error(`unexpected ${command}`);
      }
      submitCalls += 1;
      const p = payload as Record<string, unknown>;
      if (command === 'team.submit' && p['team_name'] !== undefined) {
        throw teamClosedError();
      }
      return { status: 'submitted', turn_id: 'turn-fallback-1' };
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_closed', 'group'),
      teamName: 'closing-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_closed', 'group'),
      containerChatId: null,
      submission: {
        kind: 'chat',
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-1',
        anchor: { chatId: 'oc_closed', messageId: 'm1', target: chatTarget('oc_closed', 'group') },
      },
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-fallback-1' });
    expect(submitCalls).toBe(2);
    expect(session.routing.bindingFor(chatTarget('oc_closed', 'group'))).toBeUndefined();
    expect(bot.sentCards).toHaveLength(1);
    expect(JSON.stringify(bot.sentCards[0]!.card)).toContain('Dreamux route ended');
    expect(JSON.stringify(bot.sentCards[0]!.card)).not.toMatch(/dissolved|remains active|Team closed/);

    // The pending non-force dissolve is refused; Core still reports an open Team.
    port.emit({
      schema_version: 1, kind: 'team.state', occurred_at: Date.now(),
      team_name: 'closing-team', leader_name: 'leader-1', status: 'running', teammates: [],
    });
    expect(bot.sentCards).toHaveLength(1);
    expect(readBindings(channelId)).toEqual([]);
    expect(port.calls.map((call) => call.command)).toEqual([
      'team.submit',
      'dispatcher.submit',
    ]);

    await session.close();
  });

  it('TEAM_NOT_FOUND: removes the stale binding silently (no card) and delivers once to the Dispatcher Agent', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-notfound';
    const session = await newSession(bot, channelId);
    let submitCalls = 0;
    const port = fakePort(async (command, payload) => {
      if (command !== 'team.submit' && command !== 'dispatcher.submit') {
        throw new Error(`unexpected ${command}`);
      }
      submitCalls += 1;
      const p = payload as Record<string, unknown>;
      if (command === 'team.submit' && p['team_name'] !== undefined) {
        throw teamNotFoundError();
      }
      return { status: 'submitted', turn_id: 'turn-fallback-2' };
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_stale', 'group'),
      teamName: 'gone-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_stale', 'group'),
      containerChatId: null,
      submission: {
        kind: 'chat',
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-2',
        anchor: { chatId: 'oc_stale', messageId: 'm2', target: chatTarget('oc_stale', 'group') },
      },
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-fallback-2' });
    expect(submitCalls).toBe(2);
    expect(port.calls.map((call) => call.command)).toEqual([
      'team.submit',
      'dispatcher.submit',
    ]);
    expect(session.routing.bindingFor(chatTarget('oc_stale', 'group'))).toBeUndefined();
    // TEAM_NOT_FOUND is this Channel correcting its own stale document: silent.
    expect(bot.sentCards).toHaveLength(0);

    await session.close();
  });

  it('an ambiguous/unknown post-submit outcome is never retried and never falls back (no double delivery)', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-ambiguous';
    const session = await newSession(bot, channelId);
    let submitCalls = 0;
    const port = fakePort(async () => {
      submitCalls += 1;
      // An unknown boundary failure: no `.code`, so commandErrorCode() is
      // null and submit() must classify this as 'error', never 'rejected'.
      throw new Error('unknown transport failure');
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_ambiguous', 'group'),
      teamName: 'ambiguous-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_ambiguous', 'group'),
      containerChatId: null,
      submission: {
        kind: 'chat',
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-3',
        anchor: { chatId: 'oc_ambiguous', messageId: 'm3', target: chatTarget('oc_ambiguous', 'group') },
      },
    });

    expect(outcome.status).toBe('error');
    // Exactly one attempt: no fallback submit, and the binding this Channel
    // could not prove stale is left exactly as it was.
    expect(submitCalls).toBe(1);
    expect(session.routing.bindingFor(chatTarget('oc_ambiguous', 'group'))?.team_name).toBe(
      'ambiguous-team',
    );

    await session.close();
  });
});

describe('FeishuChannelSession — team.state closed invalidates every binding to that Team', () => {
  it('removes every binding to a closed Team and cards each removed target', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-team-state';
    const session = await newSession(bot, channelId);
    const port = fakePort(async () => {
      throw new Error('no Command expected in this test');
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_x', 'group'),
      teamName: 'dying-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await session.routing.bind({
      target: topicTarget('oc_x', 'thread_1'),
      teamName: 'dying-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await session.routing.bind({
      target: chatTarget('oc_y', 'group'),
      teamName: 'surviving-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const closed: TeamStateEvent = {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: Date.now(),
      team_name: 'dying-team',
      leader_name: 'leader-1',
      status: 'closed',
      teammates: [],
    };
    port.emit(closed);

    // Let the fire-and-forget forgetTeamRoutes() chain actually finish —
    // both its store commit and its (still-live, not-yet-closed) card
    // notification — before this test closes the session. The immediate,
    // no-wait variant of this same sequence is the next test below.
    await waitFor(
      () => session.routing.bindingFor(chatTarget('oc_x', 'group')) === undefined,
    );
    await waitFor(() => bot.sentCards.length >= 2);
    for (const { card } of bot.sentCards) {
      expect(JSON.stringify(card)).toContain('Dreamux team dissolved');
      expect(JSON.stringify(card)).toContain('all of its routes were removed automatically.');
      expect(JSON.stringify(card)).not.toContain('remains active');
    }

    await session.close();

    expect(readBindings(channelId).map((b) => b['team_name'])).toEqual([
      'surviving-team',
    ]);
    expect(bot.sentCards.length).toBeGreaterThanOrEqual(1);
  });

  it('closing the session immediately after the event still drains the routing-document write, but drops the now-post-close card', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-team-state-race';
    const session = await newSession(bot, channelId);
    const port = fakePort(async () => {
      throw new Error('no Command expected in this test');
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_race', 'group'),
      teamName: 'racing-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const closed: TeamStateEvent = {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: Date.now(),
      team_name: 'racing-team',
      leader_name: 'leader-1',
      status: 'closed',
      teammates: [],
    };
    // Emit, then close in the very same synchronous turn — before the
    // fire-and-forget forgetTeamRoutes() chain has had a chance to run any
    // of its own awaits.
    port.emit(closed);
    await session.close();

    // The mutation tail (the routing document write) still settled: close()
    // awaits the store's own commit queue regardless of who queued it.
    expect(readBindings(channelId)).toEqual([]);

    // But no card exists — announceRoutesRemoved's notify() only reaches the
    // network after the write resolves, by which point close() has already
    // aborted this session's fence, and notify() refuses to run past that
    // point. No presentation callback fires after final close.
    expect(bot.sentCards).toHaveLength(0);
  });
});

/**
 * A routing document written before `bind`/`bindSpace` refused the
 * binding/space coexistence can still hold it on disk. Those refusals guard
 * writes, and a write is a deliberate act an operator is present for; startup
 * is not. A channel that would not come up because of state it already has is
 * strictly worse than one that comes up and keeps behaving as it did — the
 * operator would lose every other conversation this channel serves in order to
 * be told about one misconfigured chat.
 *
 * So document validation stays shape-only and nothing on the startup path
 * writes: `initialize` loads and subscribes, `start` wires the bot, and the
 * only event-driven routing write removes rows. This test holds that open.
 */
describe('FeishuChannelSession — a routing document predating the binding/space exclusion', () => {
  it('still starts, and keeps routing exactly as it did', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-legacy';
    const containerChatId = 'oc_legacy';
    writeFileSync(
      join(dir, routingDocumentFilename(channelId)),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'disp-1',
        channel_id: channelId,
        bindings: [{
          target: { kind: 'group', chat_id: containerChatId },
          display: null,
          team_name: 'team-a',
          origin: 'manual',
          space_id: null,
          created_at: 1,
          updated_at: 1,
        }],
        spaces: [{
          space_id: deriveSpaceId({
            dispatcherId: 'disp-1',
            channelId,
            containerChatId,
          }),
          space_name: 'legacy-space',
          container_chat_id: containerChatId,
          display: null,
          generation: 1,
          leader_agent_runtime: 'codex',
          identity: null,
          repo: null,
          created_at: 1,
          updated_at: 1,
        }],
        updated_at: 1,
      }),
    );
    const session = await newSession(bot, channelId);

    // The whole point: neither of these throws.
    await session.initialize(fakePort(async () => ({})).port);
    await session.start();

    expect(session.routing.listSpaces()).toHaveLength(1);
    expect(session.routing.listBindings()).toHaveLength(1);
    // Routing is unchanged for such a document — the conflict is reported by
    // the next write that touches it, not by refusing to serve the channel.
    expect(session.routing.plan(topicTarget(containerChatId, 'omt_new'), containerChatId))
      .toMatchObject({ kind: 'bound', teamName: 'team-a' });
    await session.close();
  });
});

describe('FeishuChannelSession.submit — session liveness fence', () => {
  it('refuses to submit once the session is not live, without reaching Core at all', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-not-live');
    const port = fakePort(async () => {
      throw new Error('must not be called: session was never initialized');
    });
    void port;

    const outcome = await session.submit(null, {
      kind: 'chat',
      attrs: {},
      text: 'hi',
      reminder: '',
      sourceId: 'msg-never',
      anchor: { chatId: 'oc_z', messageId: 'm', target: chatTarget('oc_z', 'group') },
    });
    expect(outcome).toEqual({ status: 'error', message: 'Feishu session is not live' });
  });
});

/**
 * The document-comment route end to end, because every part of it is wiring
 * the unit tests cannot cross: the event reaches the session's own handler,
 * the comment's text is read through the bot the session was built with, and
 * the submission takes the anchorless branch — a chain-of-thought card opened
 * here would have no visible message to hang under.
 */
describe('FeishuChannelSession — a document comment reaches Core', () => {
  it('carries the comment text read through the bot, and opens no card', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-doc-comment');
    const port = fakePort(async () => ({ status: 'submitted', turn_id: 'turn-doc-1' }));
    await session.initialize(port.port);
    await session.start();
    await session.routing.subscribe({
      fileToken: 'doc_tok',
      fileType: 'docx',
      teamName: 'team-a',
    });
    bot.setDocCommentText('rpl_1', {
      anchor: {
        kind: 'content',
        anchorId: 'blk_1',
        preview: 'the paragraph in question',
        deleted: false,
      },
      segments: [{ kind: 'text', text: 'please rework this' }],
    });

    await bot.injectDocComment({
      fileToken: 'doc_tok',
      fileType: 'docx',
      commentId: 'cmt_1',
      replyId: 'rpl_1',
      commenterId: 'ou_commenter',
      mentionedBot: true,
      timestamp: 1757894400000,
    });

    expect(bot.commentTextReads).toEqual([
      { fileToken: 'doc_tok', commentId: 'cmt_1', replyId: 'rpl_1' },
    ]);
    expect(port.calls).toHaveLength(1);
    const payload = port.calls[0]!.payload as Record<string, unknown>;
    expect(port.calls[0]!.command).toBe('team.submit');
    expect(payload['team_name']).toBe('team-a');
    expect(payload['source_id']).toBe('doc_tok:cmt_1:rpl_1');
    expect(payload['attrs']).toMatchObject({
      source: 'feishu',
      file_token: 'doc_tok',
      comment_id: 'cmt_1',
      reply_id: 'rpl_1',
      anchor: 'content',
      anchor_id: 'blk_1',
    });
    expect(payload['text']).toContain('<content>\nplease rework this\n</content>');
    expect(payload['text']).toContain('the paragraph in question');
    expect(bot.sentCards).toHaveLength(0);

    await session.close();
  });

  it('delivers an unsubscribed mention from a trusted commenter through dispatcher.submit, writing no row', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-doc-cold-open');
    const port = fakePort(async () => ({ status: 'submitted', turn_id: 'turn-cold-1' }));
    await saveDispatcherAccess(dir, {
      ...defaultDispatcherAccessState(),
      allow_users: ['ou_commenter'],
    });
    await session.initialize(port.port);
    await session.start();

    await bot.injectDocComment({
      fileToken: 'doc_cold',
      fileType: 'docx',
      commentId: 'cmt_1',
      replyId: '',
      commenterId: 'ou_commenter',
      mentionedBot: true,
      timestamp: 1757894400000,
    });

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.command).toBe('dispatcher.submit');
    expect(port.calls[0]!.payload).not.toHaveProperty('team_name');

    await session.close();
  });
});

/**
 * The notice every failed Collaboration Space provisioning answers with:
 * fixed wording, under the triggering message, naming no reason.
 */
const PROVISIONING_FAILURE_NOTICE =
  'Could not start a Team for this conversation. The reason is in the Dreamux log.';

/**
 * A started session whose only allowlisted chat is a topic-mode Collaboration
 * Space container, with one Space bound and no topic binding yet: every
 * inbound topic message plans `provision`.
 */
async function provisioningSession(
  channelId: string,
  invoke: (command: string, payload: JsonValue) => Promise<JsonValue>,
): Promise<{ bot: FakeFeishuBot; session: FeishuChannelSession; port: FakePort }> {
  const bot = createFakeFeishuBot();
  bot.setChatMode('oc_space', 'topic');
  const session = await newSession(bot, channelId);
  const port = fakePort(invoke);
  await saveDispatcherAccess(dir, {
    ...defaultDispatcherAccessState(),
    group: {
      policy: 'allowlist',
      allow_chats: ['oc_space'],
      require_mention: true,
    },
  });
  await session.initialize(port.port);
  await session.routing.bindSpace({
    spaceName: 'space-a',
    containerChatId: 'oc_space',
    display: null,
    leaderAgentRuntime: 'codex',
    identity: null,
    repo: null,
  });
  await session.start();
  return { bot, session, port };
}

async function injectTopicMessage(
  bot: FakeFeishuBot,
  messageId: string,
): Promise<void> {
  await bot.inject({
    messageId,
    chatId: 'oc_space',
    chatType: 'group',
    threadId: 'omt_topic',
    senderId: 'ou_human',
    senderType: 'user',
    senderName: 'Human',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '@_user_1 please start' }),
    text: '@_user_1 please start',
    resources: [],
    mentions: [{
      key: '@_user_1',
      name: 'Dreamux',
      id: { open_id: bot.botOpenId },
    }],
    createTime: '1',
    raw: {},
  });
}

describe('FeishuChannelSession.deliver — a provisioning failure answers in place', () => {
  it('a throwing team.create posts the notice under the triggering message and submits nothing', async () => {
    const { bot, session, port } = await provisioningSession('chan-provision-throws', async (command) => {
      if (command === 'team.create') {
        throw Object.assign(
          new Error('request_id replayed with a different payload'),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
      }
      throw new Error(`unexpected ${command}`);
    });

    await injectTopicMessage(bot, 'om_provision_throw');

    expect(port.calls.map((call) => call.command)).toEqual(['team.create']);
    expect(bot.sentMessages).toEqual([
      expect.objectContaining({
        chatId: 'oc_space',
        text: PROVISIONING_FAILURE_NOTICE,
        target: { chatId: 'oc_space', replyToMessageId: 'om_provision_throw' },
      }),
    ]);
    expect(
      session.routing.bindingFor(topicTarget('oc_space', 'omt_topic')),
    ).toBeUndefined();

    await session.close();
  });

  it('a replayed closed Team and an empty Team name each post the notice and invoke no submit', async () => {
    for (const createResult of [
      teamSummary('ghost-team', 'closed'),
      { ...teamSummary('space-team-1'), team_name: '' },
    ]) {
      const { bot, session, port } = await provisioningSession(
        `chan-provision-${createResult.team_name === '' ? 'empty' : 'closed'}`,
        async (command) => {
          if (command !== 'team.create') throw new Error(`unexpected ${command}`);
          return createResult as unknown as JsonValue;
        },
      );

      await injectTopicMessage(bot, `om_provision_${createResult.team_name === '' ? 'empty' : 'closed'}`);

      expect(port.calls.map((call) => call.command)).toEqual(['team.create']);
      expect(bot.sentMessages.map((message) => message.text)).toEqual([
        PROVISIONING_FAILURE_NOTICE,
      ]);

      await session.close();
    }
  });

  it('a rejected submission to the just-provisioned Team posts the notice without a Dispatcher fallback', async () => {
    const { bot, session, port } = await provisioningSession('chan-provision-rejected', async (
      command,
    ) => {
      if (command === 'team.create') {
        return teamSummary('fresh-team') as unknown as JsonValue;
      }
      if (command === 'team.submit') throw teamClosedError();
      throw new Error(`unexpected ${command}`);
    });

    await injectTopicMessage(bot, 'om_provision_rejected');

    expect(port.calls.map((call) => call.command)).toEqual([
      'team.create',
      'team.submit',
    ]);
    expect(bot.sentMessages.map((message) => message.text)).toEqual([
      PROVISIONING_FAILURE_NOTICE,
    ]);
    // Unlike the bound-plan fallback, the provision branch reconciles nothing
    // and never calls dispatcher.submit: the rejection is answered in place.
    expect(
      session.routing.bindingFor(topicTarget('oc_space', 'omt_topic'))?.team_name,
    ).toBe('fresh-team');

    await session.close();
  });

  it('a concurrent waiter that finds the failed run installed no route gets its own notice', async () => {
    let resolveCreate!: (value: JsonValue) => void;
    const { bot, session, port } = await provisioningSession('chan-provision-waiter', async (
      command,
    ) => {
      if (command !== 'team.create') throw new Error(`unexpected ${command}`);
      return new Promise<JsonValue>((resolve) => {
        resolveCreate = resolve;
      });
    });

    // Deterministic rendezvous. The second message's admission gate does real
    // access.json IO, so merely having injected it does not mean its delivery
    // has reached provisioning: resolving the run at that point lets the first
    // run delete its in-flight entry before the second arrives, which opens a
    // second run that then waits forever. Entry into `deliver` is the right
    // fence — plan() and provisionForInbound() follow synchronously, so a
    // second deliver entry with still one team.create means the waiter joined
    // the first run; a second team.create would fail this wait instead of
    // hanging the test.
    let deliverEntries = 0;
    const originalDeliver = session.deliver.bind(session);
    session.deliver = ((input) => {
      deliverEntries += 1;
      return originalDeliver(input);
    }) as typeof session.deliver;

    const first = injectTopicMessage(bot, 'om_provision_first');
    await waitFor(() => port.calls.some((call) => call.command === 'team.create'));
    const second = injectTopicMessage(bot, 'om_provision_second');
    await waitFor(
      () =>
        deliverEntries === 2 &&
        port.calls.filter((call) => call.command === 'team.create').length === 1,
    );

    resolveCreate(teamSummary('ghost-team', 'closed') as unknown as JsonValue);
    await Promise.all([first, second]);

    expect(port.calls.map((call) => call.command)).toEqual(['team.create']);
    expect(bot.sentMessages.map((message) => message.target.replyToMessageId)).toEqual([
      'om_provision_first',
      'om_provision_second',
    ]);
    expect(bot.sentMessages.every((message) => message.text === PROVISIONING_FAILURE_NOTICE))
      .toBe(true);

    await session.close();
  });

  it.each([
    ['failed', { status: 'failed', error: { code: 'TEAM_SUBMIT_FAILED', message: 'native down' } }],
    ['ambiguous', { status: 'ambiguous', error: null }],
  ] as const)(
    'a %s admission after provisioning posts no notice and no Dispatcher submission',
    async (_label, submitResult) => {
      const { bot, session, port } = await provisioningSession(
        `chan-provision-${_label}`,
        async (command) => {
          if (command === 'team.create') {
            return teamSummary('fresh-team') as unknown as JsonValue;
          }
          if (command === 'team.submit') return submitResult;
          throw new Error(`unexpected ${command}`);
        },
      );

      await injectTopicMessage(bot, `om_provision_${_label}`);

      expect(port.calls.map((call) => call.command)).toEqual([
        'team.create',
        'team.submit',
      ]);
      expect(bot.sentMessages).toEqual([]);

      await session.close();
    },
  );

  it('an unknown error after provisioning posts no notice and no Dispatcher submission', async () => {
    const { bot, session, port } = await provisioningSession('chan-provision-error', async (
      command,
    ) => {
      if (command === 'team.create') {
        return teamSummary('fresh-team') as unknown as JsonValue;
      }
      if (command === 'team.submit') throw new Error('unknown transport failure');
      throw new Error(`unexpected ${command}`);
    });

    await injectTopicMessage(bot, 'om_provision_error');

    expect(port.calls.map((call) => call.command)).toEqual([
      'team.create',
      'team.submit',
    ]);
    expect(bot.sentMessages).toEqual([]);

    await session.close();
  });

  it('an unbound conversation delivers through dispatcher.submit and posts no notice', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-unbound-inbound';
    const session = await newSession(bot, channelId);
    const port = fakePort(async (command) => {
      if (command !== 'dispatcher.submit') throw new Error(`unexpected ${command}`);
      return { status: 'submitted', turn_id: 'turn-unbound-1' };
    });
    await saveDispatcherAccess(dir, {
      ...defaultDispatcherAccessState(),
      group: {
        policy: 'allowlist',
        allow_chats: ['oc_unbound'],
        require_mention: true,
      },
    });
    await session.initialize(port.port);
    await session.start();

    await bot.inject({
      messageId: 'om_unbound',
      chatId: 'oc_unbound',
      chatType: 'group',
      senderId: 'ou_human',
      senderType: 'user',
      senderName: 'Human',
      messageType: 'text',
      rawContent: JSON.stringify({ text: '@_user_1 hello' }),
      text: '@_user_1 hello',
      resources: [],
      mentions: [{
        key: '@_user_1',
        name: 'Dreamux',
        id: { open_id: bot.botOpenId },
      }],
      createTime: '1',
      raw: {},
    });

    expect(port.calls.map((call) => call.command)).toEqual(['dispatcher.submit']);
    expect(port.calls[0]!.payload).not.toHaveProperty('team_name');
    expect(bot.sentMessages).toEqual([]);

    await session.close();
  });
});
