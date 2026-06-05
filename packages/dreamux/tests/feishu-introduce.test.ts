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

describe('canRunIntroduce — allowlist policy: sender-scoped, not group-scoped', () => {
  it('authorizes an allowlisted sender in an allowlisted chat', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(true);
  });

  it('rejects a non-allowlisted sender even in an allowlisted chat', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' }),
    ).toBe(false);
  });

  it('rejects an allowlisted sender in a chat that is not allowlisted', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' }),
    ).toBe(false);
  });

  it('does NOT treat "any member of an allowlisted group" as authorized (empty allowlist)', () => {
    const access = state({
      allow_users: [],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'anyone' }),
    ).toBe(false);
  });

  it('never fires for direct messages', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(false);
  });
});

describe('canRunIntroduce — follow-user policy: allow_chats is ignored', () => {
  // The bug this PR fixes: under `follow-user` the delivery gate ignores
  // `allow_chats`, but introduce used to demand the chat be named anyway, so an
  // `allow_users` sender could chat in a brand-new group yet never `/introduce`
  // there. Authorization must now mirror the gate: only `allow_users` matters.
  it('authorizes an allow_user in a group that is NOT in allow_chats', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: [] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'brand-new-chat', senderId: 'user-a' }),
    ).toBe(true);
  });

  it('authorizes an allow_user even when allow_chats names only other chats', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: ['some-other-chat'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'brand-new-chat', senderId: 'user-a' }),
    ).toBe(true);
  });

  it('rejects a sender who is not on allow_users, regardless of the chat', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: [] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'brand-new-chat', senderId: 'stranger' }),
    ).toBe(false);
  });
});

describe('canRunIntroduce — block policy never authorizes', () => {
  it('rejects even an allow_user in an otherwise-named chat', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'block', allow_chats: ['chat-a'] },
    });
    expect(
      canRunIntroduce(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe(false);
  });
});

describe('introduceDenyReason — stable diagnostic codes (issue #77)', () => {
  // canRunIntroduce is the boolean projection; every reason code maps 1:1 to a
  // rejection point and is logged verbatim, so an operator can tell an
  // introduce blocked by the allowlist apart from an ordinary gate drop.
  it('returns null (authorized) for an allowlisted sender in an allowlisted chat', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBeNull();
  });

  it('returns null (authorized) for an allow_user in an unconfigured follow-user group', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: [] },
    });
    expect(
      introduceDenyReason(access, {
        chatType: 'group',
        chatId: 'brand-new-chat',
        senderId: 'user-a',
      }),
    ).toBeNull();
  });

  it('reports non_group for a direct message', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe('non_group');
  });

  it('reports empty_sender_id when the sender id is missing', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: '' }),
    ).toBe('empty_sender_id');
  });

  it('reports group_blocked under the block policy', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'block', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' }),
    ).toBe('group_blocked');
  });

  it('reports chat_not_allowlisted under allowlist when the chat is not named', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' }),
    ).toBe('chat_not_allowlisted');
  });

  it('does NOT report chat_not_allowlisted under follow-user (allow_chats is ignored)', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: ['some-other-chat'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' }),
    ).toBeNull();
  });

  it('reports sender_not_followed when allow_users is empty (the misleading case)', () => {
    const access = state({
      allow_users: [],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'anyone' }),
    ).toBe('sender_not_followed');
  });

  it('reports sender_not_followed when allow_users is non-empty but excludes the sender', () => {
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'allowlist', allow_chats: ['chat-a'] },
    });
    expect(
      introduceDenyReason(access, { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' }),
    ).toBe('sender_not_followed');
  });

  it('reports sender_not_followed under follow-user for a non-allow_user (NOT chat_not_allowlisted)', () => {
    // The regression guard for this PR: a stranger in an unconfigured follow-user
    // group must be denied for being off the allowlist, never for the chat being
    // unlisted — that proves the chat check is skipped under follow-user.
    const access = state({
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: [] },
    });
    expect(
      introduceDenyReason(access, {
        chatType: 'group',
        chatId: 'brand-new-chat',
        senderId: 'stranger',
      }),
    ).toBe('sender_not_followed');
  });

  it('stays consistent with canRunIntroduce across every branch', () => {
    const cases: DispatcherAccessState[] = [
      state({ allow_users: ['user-a'], group: { policy: 'allowlist', allow_chats: ['chat-a'] } }),
      state({ allow_users: ['user-a'], group: { policy: 'follow-user', allow_chats: [] } }),
      state({ allow_users: ['user-a'], group: { policy: 'block', allow_chats: ['chat-a'] } }),
    ];
    const inputs = [
      { chatType: 'group', chatId: 'chat-a', senderId: 'user-a' },
      { chatType: 'p2p', chatId: 'chat-a', senderId: 'user-a' },
      { chatType: 'group', chatId: 'chat-a', senderId: '' },
      { chatType: 'group', chatId: 'chat-other', senderId: 'user-a' },
      { chatType: 'group', chatId: 'chat-a', senderId: 'user-x' },
    ];
    for (const access of cases) {
      for (const input of inputs) {
        expect(canRunIntroduce(access, input)).toBe(introduceDenyReason(access, input) === null);
      }
    }
  });
});

describe('gate vs introduce parity — follow-user semantics must not drift', () => {
  // The user asked review to verify that the normal delivery gate and the
  // introduce gate agree under follow-user. Encode it so accidental drift fails
  // CI rather than relying on a human reviewer. We hold the @-mention satisfied
  // (introduce waives it; the gate requires it) and the sender human, then
  // compare `dreamuxFeishuGate` deliver/drop against introduce authorization.
  //
  // They must agree for `block` and `follow-user`. Under `allowlist` they
  // diverge BY DESIGN (issue #62): the gate lets any member of an allowlisted
  // chat speak, but introduce additionally requires the sender on `allow_users`
  // because it changes trust. That one divergence is asserted explicitly below.
  const POLICIES = ['block', 'follow-user', 'allowlist'] as const;
  const MENTION: Mention[] = [{ key: '@_bot', id: { open_id: 'self-bot' } }];

  for (const policy of POLICIES) {
    for (const chatInList of [false, true]) {
      for (const senderInList of [false, true]) {
        it(`policy=${policy} chatInList=${chatInList} senderInList=${senderInList}`, () => {
          const access = state({
            allow_users: senderInList ? ['user-a'] : [],
            group: { policy, allow_chats: chatInList ? ['chat-a'] : [] },
          });
          const gate = dreamuxFeishuGate(
            {
              senderId: 'user-a',
              senderType: 'user',
              chatId: 'chat-a',
              chatType: 'group',
              mentions: MENTION,
              botOpenId: 'self-bot',
              now: 1_700_000_000_000,
            },
            access,
          );
          const gateDelivers = gate.action === 'deliver';
          const introAuthorized =
            introduceDenyReason(access, {
              chatType: 'group',
              chatId: 'chat-a',
              senderId: 'user-a',
            }) === null;

          const intentionalAllowlistDivergence =
            policy === 'allowlist' && chatInList && !senderInList;
          if (intentionalAllowlistDivergence) {
            // Gate delivers (any member of the allowlisted chat), introduce does
            // not (trust-changing command is sender-scoped, #62).
            expect(gateDelivers).toBe(true);
            expect(introAuthorized).toBe(false);
          } else {
            expect(introAuthorized).toBe(gateDelivers);
          }
        });
      }
    }
  }
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
    ];
    expect(introducedPeers(mentions, 'self-bot')).toEqual([
      { openId: 'peer-a', name: 'Peer A' },
    ]);
  });

  // #102: trust identity is strictly the mention open_id. A mention with no
  // open_id is skipped — no union_id / user_id fallback — so the trusted set
  // only ever holds ids the inbound gate can match against a sender open_id.
  it('skips a mention that has no open_id (no union_id/user_id fallback)', () => {
    const mentions: Mention[] = [
      { key: '@_user_1', id: { union_id: 'peer-union' }, name: 'Union Only' },
      { key: '@_user_2', id: { user_id: 'peer-user' }, name: 'User Only' },
      { key: '@_user_3', name: 'No Id' },
      { key: '@_user_4', id: { open_id: 'peer-a' }, name: 'Peer A' },
    ];
    expect(introducedPeers(mentions, 'self-bot')).toEqual([
      { openId: 'peer-a', name: 'Peer A' },
    ]);
  });

  it('keeps only the open_id when a mention carries both open_id and union_id', () => {
    const mentions: Mention[] = [
      { key: '@_user_1', id: { open_id: 'peer-a', union_id: 'peer-union' }, name: 'Peer A' },
    ];
    // No `unionId` field on the result — union_id never enters trust.
    expect(introducedPeers(mentions, 'self-bot')).toEqual([
      { openId: 'peer-a', name: 'Peer A' },
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

  // A peer bot @-mentioning us is encoded as a mention resolving to botOpenId.
  const mentionUs = [{ key: '@_bot', id: { open_id: 'self-bot' } }];

  it('drops a bot sender that has not been introduced', () => {
    const access = state({ group: { policy: 'allowlist', allow_chats: ['chat-a'] } });
    expect(
      dreamuxFeishuGate({ ...base, mentions: mentionUs }, access),
    ).toMatchObject({ action: 'drop' });
  });

  it('delivers a trusted bot that @-mentions us', () => {
    const access = state({ group: { policy: 'allowlist', allow_chats: ['chat-a'] } });
    expect(
      dreamuxFeishuGate(
        { ...base, mentions: mentionUs, trustedBotIds: new Set(['peer-bot']) },
        access,
      ),
    ).toMatchObject({ action: 'deliver' });
  });

  it('drops a trusted bot that does NOT @-mention us (#102)', () => {
    const access = state({ group: { policy: 'allowlist', allow_chats: ['chat-a'] } });
    expect(
      dreamuxFeishuGate(
        { ...base, mentions: [], trustedBotIds: new Set(['peer-bot']) },
        access,
      ),
    ).toMatchObject({ action: 'drop', reason: 'bot not mentioned' });
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

  // #102: a peer introduced without a name still trusts its open_id; the
  // listing omits `name` entirely rather than echoing the raw open_id as a name.
  it('trusts an open_id with no name and omits name in the listing', async () => {
    await trustIntroducedBots('d1', 'chat-a', [{ openId: 'peer-noname' }]);
    expect((await trustedBotIds('d1', 'chat-a')).has('peer-noname')).toBe(true);
    const listing = await listChatBots('d1', 'chat-a');
    expect(listing.trusted).toEqual([{ openId: 'peer-noname' }]);
    expect(listing.trusted[0]).not.toHaveProperty('name');
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
