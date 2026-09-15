/**
 * The three document tools are one definition each, offered to both callers,
 * and the recipient is derived from the caller rather than named in an
 * argument. These tests pin exactly that: the same call from a TeamLeader and
 * from the Dispatcher reaches two different recipients, and neither can name
 * the other's — there is no field with which to try.
 */
import type { ChannelMcpCaller } from '@excitedjs/dreamux-types';
import { describe, expect, it } from 'vitest';

import {
  listSubscriptionsDef,
  subscribeDocumentDef,
  unsubscribeDocumentDef,
} from '../src/tools/document-tools.js';
import { findFeishuTool } from '../src/tools/registry.js';
import type { FeishuDocumentSubscriptionView } from '../src/routing/index.js';
import type { FeishuToolContext, FeishuToolSession } from '../src/tools/types.js';

const dispatcher: ChannelMcpCaller = { kind: 'dispatcher' };
const teamLeader: ChannelMcpCaller = {
  kind: 'team_leader',
  team_name: 'my-team',
  leader_name: 'leader-1',
};

interface Recorded {
  readonly subscribes: Array<{
    document: string;
    type: string | null;
    teamName: string | null;
  }>;
  readonly unsubscribes: Array<{ document: string; teamName: string | null }>;
  readonly listed: Array<string | null>;
}

function fakeSession(
  rows: Record<string, readonly FeishuDocumentSubscriptionView[]> = {},
): FeishuToolSession & Recorded {
  const subscribes: Recorded['subscribes'] = [];
  const unsubscribes: Recorded['unsubscribes'] = [];
  const listed: Recorded['listed'] = [];
  return {
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    },
    channelId: 'chan-1',
    async sendText() {
      throw new Error('not used');
    },
    async react() {
      throw new Error('not used');
    },
    async listKnownChatBots() {
      throw new Error('not used');
    },
    async askUserQuestion() {
      throw new Error('not used');
    },
    async bindChannel() {
      throw new Error('not used');
    },
    async unbindChannel() {
      throw new Error('not used');
    },
    listBindings() {
      return [];
    },
    async bindSpace() {
      throw new Error('not used');
    },
    async unbindSpace() {
      throw new Error('not used');
    },
    getSpace() {
      return undefined;
    },
    listSpaces() {
      return [];
    },
    async subscribeDocument(input) {
      subscribes.push(input);
      return {
        file_token: 'doc_tok',
        file_type: 'docx',
        already_subscribed: false,
      };
    },
    async unsubscribeDocument(input) {
      unsubscribes.push(input);
      return { file_token: 'doc_tok', unsubscribed: true };
    },
    listSubscriptions(teamName) {
      listed.push(teamName);
      return rows[teamName ?? '__dispatcher__'] ?? [];
    },
    subscribes,
    unsubscribes,
    listed,
  };
}

function ctx(
  caller: ChannelMcpCaller,
  session: FeishuToolSession,
): FeishuToolContext {
  return { caller, session };
}

describe('the document tools are one definition for both callers', () => {
  it.each(['subscribe_document', 'unsubscribe_document', 'list_subscriptions'])(
    '%s resolves to the same definition for either caller',
    (name) => {
      const forDispatcher = findFeishuTool(name, 'dispatcher');
      const forLeader = findFeishuTool(name, 'team_leader');
      expect(forDispatcher).toBeDefined();
      expect(forLeader).toBe(forDispatcher);
    },
  );

  it('no document tool accepts a field that would name another recipient', () => {
    for (const def of [
      subscribeDocumentDef,
      unsubscribeDocumentDef,
      listSubscriptionsDef,
    ]) {
      const properties = (def.inputSchema as {
        properties: Record<string, unknown>;
      }).properties;
      expect(Object.keys(properties)).not.toContain('team_name');
    }
  });
});

describe('subscribe_document derives its recipient from the caller', () => {
  it('a TeamLeader subscribes for its own Team', async () => {
    const session = fakeSession();

    await subscribeDocumentDef.handle(ctx(teamLeader, session), {
      document: 'doc_tok',
      type: 'docx',
    });

    expect(session.subscribes).toEqual([
      { document: 'doc_tok', type: 'docx', teamName: 'my-team' },
    ]);
  });

  it('the Dispatcher subscribes for the Dispatcher Agent', async () => {
    const session = fakeSession();

    await subscribeDocumentDef.handle(ctx(dispatcher, session), {
      document: 'doc_tok',
      type: null,
    });

    expect(session.subscribes).toEqual([
      { document: 'doc_tok', type: null, teamName: null },
    ]);
  });
});

describe('unsubscribe_document reaches only the caller\'s own row', () => {
  it('a TeamLeader removes its own Team\'s row', async () => {
    const session = fakeSession();

    await unsubscribeDocumentDef.handle(ctx(teamLeader, session), {
      document: 'doc_tok',
    });

    expect(session.unsubscribes).toEqual([
      { document: 'doc_tok', teamName: 'my-team' },
    ]);
  });

  it('the Dispatcher removes the Dispatcher Agent\'s row', async () => {
    const session = fakeSession();

    await unsubscribeDocumentDef.handle(ctx(dispatcher, session), {
      document: 'doc_tok',
    });

    expect(session.unsubscribes).toEqual([
      { document: 'doc_tok', teamName: null },
    ]);
  });
});

describe('list_subscriptions is caller-scoped', () => {
  const leaderRow: FeishuDocumentSubscriptionView = {
    file_token: 'doc_leader',
    file_type: 'docx',
    created_at: 1,
  };
  const dispatcherRow: FeishuDocumentSubscriptionView = {
    file_token: 'doc_dispatcher',
    file_type: 'docx',
    created_at: 2,
  };

  it('a TeamLeader sees its own rows and nothing else', async () => {
    const session = fakeSession({
      'my-team': [leaderRow],
      __dispatcher__: [dispatcherRow],
    });

    const result = await listSubscriptionsDef.handle(
      ctx(teamLeader, session),
      {},
    );

    expect(session.listed).toEqual(['my-team']);
    expect(result).toEqual({
      channel_id: 'chan-1',
      subscriptions: [leaderRow],
    });
  });

  it('the Dispatcher sees its own rows, not the whole channel', async () => {
    const session = fakeSession({
      'my-team': [leaderRow],
      __dispatcher__: [dispatcherRow],
    });

    const result = await listSubscriptionsDef.handle(
      ctx(dispatcher, session),
      {},
    );

    expect(session.listed).toEqual([null]);
    expect(result).toEqual({
      channel_id: 'chan-1',
      subscriptions: [dispatcherRow],
    });
  });
});
