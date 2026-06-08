import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  TRUST_DOMAIN_WARNING,
  defaultDispatcherAccessState,
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
  type DispatcherAccessState,
} from '../src/channel/feishu/feishu-gate.js';
import { dispatcherAccessPath, resetRuntimeConfig } from '../src/platform/paths.js';

describe('dreamuxFeishuGate', () => {
  it('delivers direct messages only from senders on the global allow-user list', () => {
    const access = state({ allow_users: ['sender-allowed'] });

    expect(gate({ chatType: 'p2p', senderId: 'sender-allowed' }, access))
      .toMatchObject({ action: 'deliver' });
    expect(gate({ chatType: 'p2p', senderId: 'sender-other' }, access))
      .toMatchObject({
        action: 'drop',
        reason: 'direct sender not allowed',
      });
  });

  it('drops self-sent, bot-sender, and missing-sender messages', () => {
    const access = state({ allow_users: ['sender-allowed'] });

    expect(gate({ senderId: '' }, access)).toMatchObject({
      action: 'drop',
      reason: 'missing sender id',
    });
    expect(gate({ senderId: 'bot-open-id' }, access)).toMatchObject({
      action: 'drop',
      reason: 'message sent by this bot',
    });
    expect(gate({ senderId: 'sender-bot', senderType: 'bot' }, access))
      .toMatchObject({
        action: 'drop',
        reason: 'bot sender type: bot',
      });
  });

  describe('follow-user policy — the global allow-user list gates every group', () => {
    const access = state({
      allow_users: ['sender-allowed'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    });

    it('delivers a global allow-user who @-mentions the bot in any group', () => {
      expect(gate({ chatId: 'chat-group-a' }, access)).toMatchObject({
        action: 'deliver',
      });
      // A different group the operator never configured — still delivered.
      expect(gate({ chatId: 'chat-group-z' }, access)).toMatchObject({
        action: 'deliver',
      });
    });

    it('ignores a configured chat allowlist under follow-user', () => {
      // allow_chats names only chat-group-a, but follow-user does not gate on
      // the chat: an allow-user is delivered in an unlisted chat all the same.
      const scoped = state({
        allow_users: ['sender-allowed'],
        group: {
          policy: 'follow-user',
          allow_chats: ['chat-group-a'],
          require_mention: true,
        },
      });
      expect(gate({ chatId: 'chat-group-z' }, scoped)).toMatchObject({
        action: 'deliver',
      });
    });

    it('drops a sender who is not on the global allow-user list', () => {
      expect(gate({ senderId: 'sender-other' }, access)).toMatchObject({
        action: 'drop',
        reason: 'sender not on allowlist',
      });
    });

    it('always requires an @-mention, regardless of require_mention', () => {
      expect(gate({ mentions: [] }, access)).toMatchObject({
        action: 'drop',
        reason: 'bot not mentioned',
      });
      const noMentionFlag = state({
        allow_users: ['sender-allowed'],
        group: {
          policy: 'follow-user',
          allow_chats: [],
          require_mention: false,
        },
      });
      expect(gate({ mentions: [] }, noMentionFlag)).toMatchObject({
        action: 'drop',
        reason: 'bot not mentioned',
      });
    });

    it('drops when the bot open_id is unknown', () => {
      expect(gate({ botOpenId: undefined }, access)).toMatchObject({
        action: 'drop',
        reason: 'group message requires a bot mention but bot open_id is unknown',
      });
    });
  });

  describe('allowlist policy — the chat is the unit of trust', () => {
    const access = state({
      // No global allow-user: allowlist mode trusts the group, not the sender.
      group: { policy: 'allowlist', allow_chats: ['chat-group-a'], require_mention: true },
    });

    it('delivers any member of an authorized chat once the bot is mentioned', () => {
      expect(gate({ chatId: 'chat-group-a', senderId: 'anyone' }, access))
        .toMatchObject({ action: 'deliver' });
    });

    it('drops a chat that is not on the allowlist', () => {
      expect(gate({ chatId: 'chat-group-b' }, access)).toMatchObject({
        action: 'drop',
        reason: 'group chat not allowed',
      });
    });

    it('honors require_mention in allowlist mode', () => {
      expect(gate({ chatId: 'chat-group-a', mentions: [] }, access))
        .toMatchObject({ action: 'drop', reason: 'bot not mentioned' });

      const open = state({
        group: { policy: 'allowlist', allow_chats: ['chat-group-a'], require_mention: false },
      });
      expect(gate({ chatId: 'chat-group-a', mentions: [] }, open))
        .toMatchObject({ action: 'deliver' });
    });
  });

  describe('block policy', () => {
    it('drops every group message', () => {
      const access = state({
        allow_users: ['sender-allowed'],
        group: { policy: 'block', allow_chats: [], require_mention: true },
      });
      expect(gate({}, access)).toMatchObject({
        action: 'drop',
        reason: 'group messages are blocked (group policy: block)',
      });
    });
  });

  describe('peer-bot trust is per-chat and never reached through allow_users', () => {
    const botBase = { senderId: 'peer-bot', senderType: 'bot' };
    // The default `gate` helper mention list @-mentions `bot-open-id`, the bot's
    // own open_id, so a bot message that keeps it counts as "@-mentions us".
    const mentionUs = [{ key: '@_bot', id: { open_id: 'bot-open-id' } }];

    it('drops an un-introduced bot sender', () => {
      const access = state({ group: { policy: 'allowlist', allow_chats: ['chat-group-a'], require_mention: true } });
      expect(gate(botBase, access)).toMatchObject({ action: 'drop' });
    });

    it('delivers a trusted bot that @-mentions us, under follow-user', () => {
      const access = state({
        allow_users: ['sender-allowed'],
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      });
      expect(
        gate(
          { ...botBase, mentions: mentionUs, trustedBotIds: new Set(['peer-bot']) },
          access,
        ),
      ).toMatchObject({ action: 'deliver' });
    });

    it('drops a trusted bot that does NOT @-mention us (#102: trust is not a mention bypass)', () => {
      const access = state({
        allow_users: ['sender-allowed'],
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      });
      expect(
        gate({ ...botBase, mentions: [], trustedBotIds: new Set(['peer-bot']) }, access),
      ).toMatchObject({ action: 'drop', reason: 'bot not mentioned' });
    });

    it('drops an untrusted bot even when it @-mentions us', () => {
      const access = state({
        allow_users: ['sender-allowed'],
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      });
      expect(
        gate({ ...botBase, mentions: mentionUs, trustedBotIds: new Set() }, access),
      ).toMatchObject({ action: 'drop', reason: 'bot sender type: bot' });
    });
  });

  it('shares one global list across direct and follow-user group delivery', () => {
    const access = state({
      allow_users: ['shared-user'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    });
    expect(gate({ chatType: 'p2p', senderId: 'shared-user' }, access))
      .toMatchObject({ action: 'deliver' });
    expect(gate({ chatType: 'group', senderId: 'shared-user' }, access))
      .toMatchObject({ action: 'deliver' });
  });

  it('records a trust-domain warning when one dispatcher observes multiple chats', () => {
    const access = state({
      allow_users: ['sender-allowed'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    });
    const first = gate({ chatId: 'chat-group-a' }, access);
    expect(first.action).toBe('deliver');
    if (first.action !== 'deliver') throw new Error('unreachable');
    expect(first.warning).toBeNull();

    const second = gate({ chatId: 'chat-group-b' }, first.access);

    expect(second.action).toBe('deliver');
    if (second.action !== 'deliver') throw new Error('unreachable');
    expect(second.warning).toBe(TRUST_DOMAIN_WARNING);
    expect(second.access.warnings).toEqual([TRUST_DOMAIN_WARNING]);
    expect(second.access.observed_chats).toEqual([
      'chat-group-a',
      'chat-group-b',
    ]);
  });
});

describe('dispatcher access state files', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-access-'));
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

  it('defaults a missing access.json to the secure follow-user shape', async () => {
    const loaded = await loadDispatcherAccess('flow');
    expect(loaded).toEqual(defaultDispatcherAccessState());
    expect(loaded.version).toBe(2);
    expect(loaded.allow_users).toEqual([]);
    expect(loaded.group.policy).toBe('follow-user');
  });

  it('writes owner-only v2 state and round-trips', async () => {
    const access = state({
      allow_users: ['sender-allowed'],
      observed_chats: ['chat-group-a'],
    });
    await saveDispatcherAccess('flow', access);

    const path = dispatcherAccessPath('flow');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toMatchObject({
      version: 2,
      allow_users: ['sender-allowed'],
      group: { policy: 'follow-user' },
    });
    // The legacy fields must not be written back.
    expect(onDisk.dm).toBeUndefined();
    expect(onDisk.group.follow_users).toBeUndefined();
    expect(await loadDispatcherAccess('flow')).toEqual(access);
  });

  describe('v2-only access schema (issue #98: no migration)', () => {
    it('fails loud on a legacy v1 file instead of migrating it', async () => {
      writeRawAccess('flow', {
        version: 1,
        dm: { allow_users: ['user-a'] },
        group: {
          allow_chats: [],
          follow_users: ['user-b'],
          require_mention: true,
        },
      });
      await expect(loadDispatcherAccess('flow')).rejects.toThrow(
        /unsupported schema version.*expected 2/s,
      );
    });

    it('error names the action: delete to reset, then recreate a v2 file', async () => {
      writeRawAccess('flow', { version: 1, dm: { allow_users: ['user-a'] } });
      await expect(loadDispatcherAccess('flow')).rejects.toThrow(
        /Delete it.*recreate it as a v2 access\.json/s,
      );
    });

    it('fails loud when the version field is missing', async () => {
      writeRawAccess('flow', {
        allow_users: ['user-a'],
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      });
      await expect(loadDispatcherAccess('flow')).rejects.toThrow(
        /unsupported schema version \(found missing/,
      );
    });

    it('does not infer from legacy fields present on a v2 file', async () => {
      // Legacy-only fields carry no meaning anymore: dm.* and group.follow_users
      // are ignored, and a present allow_chats does NOT infer an allowlist policy.
      writeRawAccess('flow', {
        version: 2,
        allow_users: ['user-a'],
        dm: { allow_users: ['ignored'] },
        group: {
          allow_chats: ['chat-group-a'],
          follow_users: ['ignored'],
          require_mention: true,
        },
      });
      const access = await loadDispatcherAccess('flow');
      expect(access.allow_users).toEqual(['user-a']);
      expect(access.group.policy).toBe('follow-user');
    });

    it('defaults an absent group.policy on a v2 file to secure follow-user', async () => {
      writeRawAccess('flow', {
        version: 2,
        allow_users: [],
        group: { allow_chats: ['chat-group-a'], require_mention: true },
      });
      expect((await loadDispatcherAccess('flow')).group.policy).toBe(
        'follow-user',
      );
    });

    it('honors an explicit group.policy on a v2 file', async () => {
      writeRawAccess('flow', {
        version: 2,
        allow_users: ['user-a'],
        group: {
          policy: 'allowlist',
          allow_chats: ['chat-group-a'],
          require_mention: true,
        },
      });
      expect((await loadDispatcherAccess('flow')).group.policy).toBe('allowlist');
    });

    it('rejects an invalid group.policy on a v2 file', async () => {
      writeRawAccess('flow', {
        version: 2,
        allow_users: [],
        group: { policy: 'nonsense', allow_chats: [], require_mention: true },
      });
      await expect(loadDispatcherAccess('flow')).rejects.toThrow(/group\.policy/);
    });
  });
});

function writeRawAccess(id: string, raw: unknown): void {
  const path = dispatcherAccessPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw), 'utf8');
}

function state(
  overrides: Partial<DispatcherAccessState> = {},
): DispatcherAccessState {
  const base = defaultDispatcherAccessState();
  return {
    ...base,
    ...overrides,
    group: { ...base.group, ...(overrides.group ?? {}) },
  };
}

function gate(
  overrides: Partial<Parameters<typeof dreamuxFeishuGate>[0]> = {},
  access = state({ allow_users: ['sender-allowed'] }),
) {
  return dreamuxFeishuGate(
    {
      senderId: 'sender-allowed',
      senderType: 'user',
      chatId: 'chat-group-a',
      chatType: 'group',
      botOpenId: 'bot-open-id',
      mentions: [
        {
          key: '@_user_1',
          id: { open_id: 'bot-open-id' },
          name: 'Dispatcher',
        },
      ],
      now: 1_700_000_000_000,
      ...overrides,
    },
    access,
  );
}
