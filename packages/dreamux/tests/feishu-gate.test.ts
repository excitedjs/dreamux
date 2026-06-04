import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TRUST_DOMAIN_WARNING,
  defaultDispatcherAccessState,
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
  type DispatcherAccessState,
} from '../src/channel/feishu-gate.js';
import { dispatcherAccessPath, resetRuntimeConfig } from '../src/runtime/paths.js';

describe('dreamuxFeishuGate', () => {
  it('delivers direct messages only from allowed senders', () => {
    const access = state({
      dm: { allow_users: ['sender-allowed'] },
    });

    expect(gate({ chatType: 'p2p', senderId: 'sender-allowed' }, access))
      .toMatchObject({ action: 'deliver' });
    expect(gate({ chatType: 'p2p', senderId: 'sender-other' }, access))
      .toMatchObject({
        action: 'drop',
        reason: 'direct sender not allowed',
      });
  });

  it('drops self-sent, bot-sender, and missing-sender messages', () => {
    const access = state();

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

  it('requires a bot mention before group delivery', () => {
    const access = state();

    expect(gate({}, access)).toMatchObject({ action: 'deliver' });
    expect(gate({ mentions: [] }, access)).toMatchObject({
      action: 'drop',
      reason: 'bot not mentioned',
    });
    expect(gate({ botOpenId: undefined }, access)).toMatchObject({
      action: 'drop',
      reason: 'group message requires a bot mention but bot open_id is unknown',
    });
  });

  it('enforces configured group chat allowlists', () => {
    const access = state({
      group: {
        ...defaultDispatcherAccessState().group,
        allow_chats: ['chat-group-a'],
      },
    });

    expect(gate({ chatId: 'chat-group-a' }, access)).toMatchObject({
      action: 'deliver',
    });
    expect(gate({ chatId: 'chat-group-b' }, access)).toMatchObject({
      action: 'drop',
      reason: 'group chat not allowed',
    });
  });

  it('enforces follow-user allowlists across groups', () => {
    const access = state({
      group: {
        ...defaultDispatcherAccessState().group,
        follow_users: ['sender-allowed'],
      },
    });

    expect(gate({ senderId: 'sender-allowed' }, access)).toMatchObject({
      action: 'deliver',
    });
    expect(gate({ senderId: 'sender-other' }, access)).toMatchObject({
      action: 'drop',
      reason: 'sender not allowed by follow-user gate',
    });
  });

  it('records a trust-domain warning when one dispatcher observes multiple chats', () => {
    const first = gate({ chatId: 'chat-group-a' }, state());
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

  it('defaults missing access.json and writes owner-only access state', () => {
    expect(loadDispatcherAccess('flow')).toEqual(defaultDispatcherAccessState());

    const access = state({
      dm: { allow_users: ['sender-allowed'] },
      observed_chats: ['chat-group-a'],
    });
    saveDispatcherAccess('flow', access);

    const path = dispatcherAccessPath('flow');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      dm: { allow_users: ['sender-allowed'] },
      observed_chats: ['chat-group-a'],
    });
    expect(loadDispatcherAccess('flow')).toEqual(access);
  });
});

function state(
  overrides: Partial<DispatcherAccessState> = {},
): DispatcherAccessState {
  return {
    ...defaultDispatcherAccessState(),
    ...overrides,
  };
}

function gate(
  overrides: Partial<Parameters<typeof dreamuxFeishuGate>[0]> = {},
  access = state(),
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
