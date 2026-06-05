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
  introduceAckText,
  introduceDenyReason,
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

function state(overrides: Partial<DispatcherAccessState> = {}): DispatcherAccessState {
  const base = defaultDispatcherAccessState();
  return {
    ...base,
    ...overrides,
    group: { ...base.group, ...(overrides.group ?? {}) },
  };
}

function textContent(text: string): string {
  return JSON.stringify({ text });
}

describe('canRunIntroduce — sender-scoped, not group-scoped', () => {
  it('authorizes an allowlisted sender in an allowlisted chat', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(true);
  });

  it('rejects a non-allowlisted sender even in an allowlisted chat', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' }),
    ).toBe(false);
  });

  it('rejects an allowlisted sender in a chat that is not allowlisted', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' }),
    ).toBe(false);
  });

  it('does NOT treat "any member of an allowlisted group" as authorized (empty allowlist)', () => {
    const access = state({ allow_users: [], group: { allow_chats: ['chat-a'] } });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'anyone' }),
    ).toBe(false);
  });

  it('never fires for direct messages', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      canRunIntroduce(access, { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(false);
  });
});

describe('introduceDenyReason — stable diagnostic codes (issue #77)', () => {
  // canRunIntroduce is the boolean projection; every reason code maps 1:1 to a
  // rejection point and is logged verbatim, so an operator can tell an
  // introduce blocked by the allowlist apart from an ordinary gate drop.
  it('returns null (authorized) for an allowlisted sender in an allowlisted chat', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBeNull();
  });

  it('reports non_group for a direct message', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      introduceDenyReason(access, { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe('non_group');
  });

  it('reports empty_sender_id when the sender id is missing', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: '' }),
    ).toBe('empty_sender_id');
  });

  it('reports chat_not_allowlisted when the chat is not explicitly allowlisted', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' }),
    ).toBe('chat_not_allowlisted');
  });

  it('reports sender_not_followed when allow_users is empty (the misleading case)', () => {
    const access = state({ allow_users: [], group: { allow_chats: ['chat-a'] } });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'anyone' }),
    ).toBe('sender_not_followed');
  });

  it('reports sender_not_followed when allow_users is non-empty but excludes the sender', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' }),
    ).toBe('sender_not_followed');
  });

  it('stays consistent with canRunIntroduce across every branch', () => {
    const access = state({ allow_users: ['user-a'], group: { allow_chats: ['chat-a'] } });
    const inputs = [
      { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' },
      { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' },
      { chatType: 'group', chatId: 'chat-a', senderId: '' },
      { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' },
      { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' },
    ];
    for (const input of inputs) {
      expect(canRunIntroduce(access, input)).toBe(introduceDenyReason(access, input) === null);
    }
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

describe('introduceAckText', () => {
  it('counts every introduced peer and renders display names', () => {
    expect(
      introduceAckText([
        { openId: 'peer-a', name: 'Peer A' },
        { openId: 'peer-b', name: 'Peer B' },
      ]),
    ).toBe('✅ 已认识本群 2 个伙伴：@Peer A @Peer B');
  });

  it('uses a stable non-id fallback when Feishu omits a display name', () => {
    expect(introduceAckText([{ openId: 'peer-a' }])).toBe(
      '✅ 已认识本群 1 个伙伴：@伙伴',
    );
  });

  it('returns null when there is no external peer to acknowledge', () => {
    expect(introduceAckText([])).toBeNull();
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
    const access = state({ group: { policy: 'allowlist', allow_chats: ['chat-a'] } });
    expect(dreamuxFeishuGate(base, access)).toMatchObject({ action: 'drop' });
  });

  it('delivers a bot sender that was introduced (trusted), without a mention', () => {
    const access = state({ group: { policy: 'allowlist', allow_chats: ['chat-a'] } });
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

  it('observing a bot records awareness but never trust', async () => {
    await observeKnownBot('d1', 'chat-a', { openId: 'peer-a', name: 'Peer A' });
    const entry = (await loadChatBots('d1')).chats['chat-a'];
    expect(entry?.known).toEqual(['peer-a']);
    expect(entry?.trusted ?? []).toEqual([]);
    expect((await trustedBotIds('d1', 'chat-a')).has('peer-a')).toBe(false);
  });

  it('introducing a bot records trust (and awareness)', async () => {
    const added = await trustIntroducedBots('d1', 'chat-a', [
      { openId: 'peer-a', name: 'Peer A' },
    ]);
    expect(added).toEqual(['peer-a']);
    const entry = (await loadChatBots('d1')).chats['chat-a'];
    expect(entry?.trusted).toEqual(['peer-a']);
    expect(entry?.known).toEqual(['peer-a']);
    expect((await trustedBotIds('d1', 'chat-a')).has('peer-a')).toBe(true);
  });

  it('recordBotAdded is idempotent by event id and flags a baseline', async () => {
    expect(await recordBotAdded('d1', 'chat-a', 'evt-1')).toBe(true);
    expect(await recordBotAdded('d1', 'chat-a', 'evt-1')).toBe(false);
    expect((await loadChatBots('d1')).chats['chat-a']?.needsBaseline).toBe(true);
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

  it('arms a generation-stamped pending baseline carrying the trusted bots', async () => {
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    const pending = await pendingBaseline('d1', 'chat-a');
    expect(pending.needsBaseline).toBe(true);
    expect(pending.generation).toBe(1);
    expect(pending.trusted).toEqual([{ openId: 'peer-a', name: 'Peer A' }]);
  });

  it('only trusted (not passively known) bots ride the pending baseline', async () => {
    await observeKnownBot('d1', 'chat-a', { openId: 'known-only', name: 'Known' });
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    expect((await pendingBaseline('d1', 'chat-a')).trusted).toEqual([
      { openId: 'peer-a', name: 'Peer A' },
    ]);
  });

  it('re-introducing an already-trusted bot does not re-arm the one-shot', async () => {
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    await clearBaselineIfCurrent(
      'd1',
      'chat-a',
      (await pendingBaseline('d1', 'chat-a')).generation,
    );
    expect((await pendingBaseline('d1', 'chat-a')).needsBaseline).toBe(false);
    const added = await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    expect(added).toEqual([]);
    expect((await pendingBaseline('d1', 'chat-a')).needsBaseline).toBe(false);
  });

  it('clears the flag when the generation still matches the snapshot', async () => {
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    const snapshot = await pendingBaseline('d1', 'chat-a');
    await clearBaselineIfCurrent('d1', 'chat-a', snapshot.generation);
    expect((await pendingBaseline('d1', 'chat-a')).needsBaseline).toBe(false);
  });

  it('does NOT clear when a newer event bumped the generation mid-enqueue', async () => {
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a' }]);
    const stale = await pendingBaseline('d1', 'chat-a'); // generation 1
    // A second /introduce arrives before the stale clear runs.
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-b' }]); // generation 2
    await clearBaselineIfCurrent('d1', 'chat-a', stale.generation);
    const after = await pendingBaseline('d1', 'chat-a');
    expect(after.needsBaseline).toBe(true);
    expect(after.trusted).toEqual([{ openId: 'peer-a' }, { openId: 'peer-b' }]);
  });

  it('listChatBots returns known and trusted separately, with names', async () => {
    await observeKnownBot('d1', 'chat-a', { openId: 'known-a', name: 'Known A' });
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-a', name: 'Peer A' }]);
    const listing = await listChatBots('d1', 'chat-a');
    expect(listing.known).toEqual([
      { openId: 'known-a', name: 'Known A' },
      { openId: 'peer-a', name: 'Peer A' },
    ]);
    expect(listing.trusted).toEqual([{ openId: 'peer-a', name: 'Peer A' }]);
  });

  it('returns empty listings/baseline for an unknown chat', async () => {
    expect(await listChatBots('d1', 'nope')).toEqual({ known: [], trusted: [] });
    expect(await pendingBaseline('d1', 'nope')).toEqual({
      needsBaseline: false,
      generation: 0,
      trusted: [],
    });
  });
});
