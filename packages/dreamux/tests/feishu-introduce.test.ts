/**
 * Issue #62 — group `/introduce` hard contract.
 *
 * The rule under test: in a group, `/introduce` triggers if and only if the
 * sender is on the allowlist; no `@`-mention of our bot is required, and being
 * "any member of an allowlisted group" is NOT enough.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultDispatcherAccessState,
  dreamuxFeishuGate,
  type DispatcherAccessState,
} from '../src/channel/feishu-gate.js';
import {
  canRunIntroduce,
  detectIntroduce,
  introducedPeers,
} from '../src/channel/introduce.js';
import {
  clearBaselineIfCurrent,
  listChatBots,
  loadChatBots,
  observeKnownBot,
  pendingBaseline,
  recordBotAdded,
  trustIntroducedBots,
  trustedBotIds,
} from '../src/channel/chat-bots-store.js';
import { resetRuntimeConfig } from '../src/runtime/paths.js';
import type { Mention } from '@excitedjs/feishu-transport';

function state(group: Partial<DispatcherAccessState['group']> = {}): DispatcherAccessState {
  const base = defaultDispatcherAccessState();
  return { ...base, group: { ...base.group, ...group } };
}

function textContent(text: string): string {
  return JSON.stringify({ text });
}

describe('canRunIntroduce — sender-scoped, not group-scoped', () => {
  it('authorizes an allowlisted sender in an allowlisted chat', () => {
    const access = state({ allow_chats: ['chat-a'], follow_users: ['user-a'] });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(true);
  });

  it('rejects a non-allowlisted sender even in an allowlisted chat', () => {
    const access = state({ allow_chats: ['chat-a'], follow_users: ['user-a'] });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' }),
    ).toBe(false);
  });

  it('rejects an allowlisted sender in a chat that is not allowlisted', () => {
    const access = state({ allow_chats: ['chat-a'], follow_users: ['user-a'] });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' }),
    ).toBe(false);
  });

  it('does NOT treat "any member of an allowlisted group" as authorized (empty allowlist)', () => {
    const access = state({ allow_chats: ['chat-a'], follow_users: [] });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'anyone' }),
    ).toBe(false);
  });

  it('never fires for direct messages', () => {
    const access = state({ allow_chats: ['chat-a'], follow_users: ['user-a'] });
    expect(
      canRunIntroduce(access, { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(false);
  });
});

describe('detectIntroduce — no @-mention required', () => {
  it('matches a bare /introduce', () => {
    expect(detectIntroduce('text', textContent('/introduce'), [])).toBe(true);
  });

  it('matches /introduce after stripping a leading mention token', () => {
    const mentions: Mention[] = [{ key: '@_user_1', id: { open_id: 'bot' }, name: 'Bot' }];
    expect(
      detectIntroduce('text', textContent('@_user_1 /introduce @_user_2'), mentions),
    ).toBe(true);
  });

  it('strips the longest mention key first when keys overlap', () => {
    // `@_user_1` is a prefix of `@_user_10`; checking the shorter key first
    // would consume a partial token and false-negate the command.
    const mentions: Mention[] = [
      { key: '@_user_1', id: { open_id: 'a' } },
      { key: '@_user_10', id: { open_id: 'b' } },
    ];
    expect(
      detectIntroduce('text', textContent('@_user_10 /introduce'), mentions),
    ).toBe(true);
  });

  it('does not match /introduce in the middle of a message', () => {
    expect(detectIntroduce('text', textContent('hello /introduce'), [])).toBe(false);
  });

  it('does not match a longer word like /introducer', () => {
    expect(detectIntroduce('text', textContent('/introducer'), [])).toBe(false);
  });

  it('ignores non-text messages and malformed content', () => {
    expect(detectIntroduce('post', textContent('/introduce'), [])).toBe(false);
    expect(detectIntroduce('text', 'not-json', [])).toBe(false);
  });
});

describe('introducedPeers', () => {
  it('returns mentioned peers excluding our own bot, deduplicated', () => {
    const mentions: Mention[] = [
      { key: '@_user_1', id: { open_id: 'self-bot' }, name: 'Us' },
      { key: '@_user_2', id: { open_id: 'peer-a' }, name: 'Peer A' },
      { key: '@_user_3', id: { open_id: 'peer-a' }, name: 'Peer A again' },
      { key: '@_user_4', id: { union_id: 'peer-b' } },
    ];
    expect(introducedPeers(mentions, 'self-bot')).toEqual([
      { openId: 'peer-a', name: 'Peer A' },
      { openId: 'peer-b' },
    ]);
  });
});

describe('gate trust — only introduced bots may speak in a group', () => {
  const base = {
    senderId: 'peer-bot',
    senderType: 'bot',
    chatId: 'chat-a',
    chatType: 'group',
    botOpenId: 'self-bot',
    now: 1_700_000_000_000,
  };

  it('drops a bot sender that has not been introduced', () => {
    const access = state({ allow_chats: ['chat-a'] });
    expect(dreamuxFeishuGate(base, access)).toMatchObject({ action: 'drop' });
  });

  it('delivers a bot sender that was introduced (trusted), without a mention', () => {
    const access = state({ allow_chats: ['chat-a'] });
    expect(
      dreamuxFeishuGate({ ...base, trustedBotIds: new Set(['peer-bot']) }, access),
    ).toMatchObject({ action: 'deliver' });
  });
});

describe('chat-bots store — awareness vs trust are separate', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-chatbots-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('observing a bot records awareness but never trust', () => {
    observeKnownBot('d1', 'chat-a', { openId: 'peer-a', name: 'Peer A' });
    const entry = loadChatBots('d1').chats['chat-a'];
    expect(entry?.known).toEqual(['peer-a']);
    expect(entry?.trusted ?? []).toEqual([]);
    expect(trustedBotIds('d1', 'chat-a').has('peer-a')).toBe(false);
  });

  it('introducing a bot records trust (and awareness)', () => {
    const added = trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    expect(added).toEqual(['peer-a']);
    const entry = loadChatBots('d1').chats['chat-a'];
    expect(entry?.trusted).toEqual(['peer-a']);
    expect(entry?.known).toEqual(['peer-a']);
    expect(trustedBotIds('d1', 'chat-a').has('peer-a')).toBe(true);
  });

  it('recordBotAdded is idempotent by event id and flags a baseline', () => {
    expect(recordBotAdded('d1', 'chat-a', 'evt-1')).toBe(true);
    expect(recordBotAdded('d1', 'chat-a', 'evt-1')).toBe(false);
    expect(loadChatBots('d1').chats['chat-a']?.needsBaseline).toBe(true);
  });
});

describe('chat-bots store — one-shot pending context (issue #69)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-chatbots-pending-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('arms a generation-stamped pending baseline carrying the trusted bots', () => {
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    const pending = pendingBaseline('d1', 'chat-a');
    expect(pending.needsBaseline).toBe(true);
    expect(pending.generation).toBe(1);
    expect(pending.trusted).toEqual([{ openId: 'peer-a', name: 'Peer A' }]);
  });

  it('only trusted (not passively known) bots ride the pending baseline', () => {
    observeKnownBot('d1', 'chat-a', { openId: 'known-only', name: 'Known' });
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    expect(pendingBaseline('d1', 'chat-a').trusted).toEqual([
      { openId: 'peer-a', name: 'Peer A' },
    ]);
  });

  it('re-introducing an already-trusted bot does not re-arm the one-shot', () => {
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    clearBaselineIfCurrent('d1', 'chat-a', pendingBaseline('d1', 'chat-a').generation);
    expect(pendingBaseline('d1', 'chat-a').needsBaseline).toBe(false);
    const added = trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    expect(added).toEqual([]);
    expect(pendingBaseline('d1', 'chat-a').needsBaseline).toBe(false);
  });

  it('clears the flag when the generation still matches the snapshot', () => {
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    const snapshot = pendingBaseline('d1', 'chat-a');
    clearBaselineIfCurrent('d1', 'chat-a', snapshot.generation);
    expect(pendingBaseline('d1', 'chat-a').needsBaseline).toBe(false);
  });

  it('does NOT clear when a newer event bumped the generation mid-enqueue', () => {
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    const stale = pendingBaseline('d1', 'chat-a'); // generation 1
    // A second /introduce arrives before the stale clear runs.
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-b' }]); // generation 2
    clearBaselineIfCurrent('d1', 'chat-a', stale.generation);
    const after = pendingBaseline('d1', 'chat-a');
    expect(after.needsBaseline).toBe(true);
    expect(after.trusted).toEqual([{ openId: 'peer-a' }, { openId: 'peer-b' }]);
  });

  it('listChatBots returns known and trusted separately, with names', () => {
    observeKnownBot('d1', 'chat-a', { openId: 'known-a', name: 'Known A' });
    trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    const listing = listChatBots('d1', 'chat-a');
    expect(listing.known).toEqual([
      { openId: 'known-a', name: 'Known A' },
      { openId: 'peer-a', name: 'Peer A' },
    ]);
    expect(listing.trusted).toEqual([{ openId: 'peer-a', name: 'Peer A' }]);
  });

  it('returns empty listings/baseline for an unknown chat', () => {
    expect(listChatBots('d1', 'nope')).toEqual({ known: [], trusted: [] });
    expect(pendingBaseline('d1', 'nope')).toEqual({
      needsBaseline: false,
      generation: 0,
      trusted: [],
    });
  });
});
