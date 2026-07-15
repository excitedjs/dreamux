import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InboundTurnInput } from '@excitedjs/dreamux-types';
import {
  defaultDispatcherAccessState,
  FeishuChannelSession,
  loadDispatcherAccess,
  saveDispatcherAccess,
  type FeishuCardActionResponse,
  type FeishuInboundEnvelope,
} from '../src/index.js';
import {
  buildPairingApprovalCard,
  DREAMUX_ACTION_KEY,
  DREAMUX_PAIRING_CARD_ACTION,
  DREAMUX_PAIRING_TOKEN_KEY,
} from '../src/feishu-pairing-card.js';
import { PAIRING_TOKEN_REGEX, generatePairingToken } from '../src/feishu-gate.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';

function logger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

function session(stateDir: string, bot: FakeFeishuBot): FeishuChannelSession {
  return new FeishuChannelSession({
    dispatcherId: 'flow',
    appId: 'app',
    appSecret: 'secret',
    stateDir,
    attachmentCacheDir: join(stateDir, 'attachments'),
    log: logger(),
    botFactory: () => bot,
  });
}

function inboundEvent(overrides: Partial<Parameters<FakeFeishuBot['inject']>[0]> = {}) {
  return {
    messageId: 'om_source',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_requester',
    senderType: 'user',
    senderName: '',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '<at id="fake-open-id-app"></at> hi' }),
    parsedText: '@bot hi',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app' },
        name: 'Bot',
      },
    ],
    createTime: '1782660000000',
    raw: {},
    ...overrides,
  };
}

async function start(session: FeishuChannelSession): Promise<void> {
  await session.start({
    submitTurn: async (
      _input: InboundTurnInput,
      _envelope: FeishuInboundEnvelope,
    ) => ({ status: 'submitted' }),
  });
}

describe('Owner-only pairing approval card', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-card-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('sends an interactive approval card when the gate returns pair', async () => {
    const bot = createFakeFeishuBot('app');
    const s = session(stateDir, bot);
    await start(s);

    await bot.inject(inboundEvent());

    expect(bot.sentMessages).toHaveLength(0);
    expect(bot.sentCards).toHaveLength(1);
    const card = bot.sentCards[0]?.card as {
      elements: Array<{ actions?: Array<{ value?: Record<string, unknown> }> }>;
    };
    const buttonValue = card.elements.flatMap((e) => e.actions ?? [])[0]?.value;
    expect(buttonValue?.[DREAMUX_ACTION_KEY]).toBe(DREAMUX_PAIRING_CARD_ACTION);
    const token = buttonValue?.[DREAMUX_PAIRING_TOKEN_KEY];
    expect(token).toMatch(PAIRING_TOKEN_REGEX);
    const renderedCard = JSON.stringify(card);
    expect(renderedCard).toContain('用户请求访问 Fake app');
    expect(renderedCard).toContain('"en_us":"User requests access to Fake app"');
    expect(renderedCard).toContain('申请人：<at id=\\"ou_requester\\"></at>');
    expect(renderedCard).toContain('Requester: <at id=\\"ou_requester\\"></at>');
    expect(renderedCard).toContain('仅 App Owner 可以点击批准');
    expect(renderedCard).toContain('Only the App Owner can approve');
    expect(renderedCard).toContain('"content":"批准授权"');
    expect(renderedCard).toContain('"en_us":"Approve"');
    expect(JSON.stringify(card)).not.toContain(`配对码`);
    expect(JSON.stringify(card).replace(JSON.stringify(buttonValue), '')).not.toContain(
      String(token),
    );

    const access = await loadDispatcherAccess(stateDir);
    expect(access.pending[String(token)]?.sender_id).toBe('ou_requester');
  });

  it('rejects non-Owner clicks with toast only and leaves pending intact', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setAppOwner({ creatorOpenId: 'ou_owner' });
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      pending: {
        [token]: {
          kind: 'dm',
          sender_id: 'ou_requester',
          chat_id: 'oc_group',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          replies: 1,
        },
      },
    });
    await start(s);

    const result = await bot.injectCardAction({
      operatorOpenId: 'ou_not_owner',
      actionValue: {
        [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
        [DREAMUX_PAIRING_TOKEN_KEY]: token,
      },
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      raw: {},
    }) as FeishuCardActionResponse;

    expect(result).toEqual({
      toast: {
        type: 'error',
        content: '只有 App Owner 才有权限点击批准授权',
      },
    });
    const access = await loadDispatcherAccess(stateDir);
    expect(access.pending[token]).toBeDefined();
    expect(access.allow_users).toEqual([]);
  });

  it('lets an Owner approve the pending token and replaces the card with a green success card', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setAppOwner({ creatorOpenId: 'ou_owner' });
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      pending: {
        [token]: {
          kind: 'dm',
          sender_id: 'ou_requester',
          chat_id: 'oc_group',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          replies: 1,
        },
      },
    });
    await start(s);

    const result = await bot.injectCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: {
        [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
        [DREAMUX_PAIRING_TOKEN_KEY]: token,
      },
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      raw: {},
    }) as FeishuCardActionResponse;

    expect(result.toast?.type).toBe('success');
    expect(result.card?.type).toBe('raw');
    expect((result.card?.data as { header?: { template?: string } }).header?.template).toBe('green');
    const renderedCard = JSON.stringify(result.card?.data);
    expect(renderedCard).toContain('授权成功');
    expect(renderedCard).toContain('"en_us":"Authorized"');
    expect(renderedCard).toContain('Owner 校验通过');
    expect(renderedCard).toContain('"en_us":"Owner verification passed');
    expect(renderedCard).not.toContain(
      'Owner 校验通过，访问权限已写入允许列表。\\n\\nOwner verification passed',
    );
    expect(renderedCard).not.toContain(token);
    expect(renderedCard).not.toContain('配对码');
    const access = await loadDispatcherAccess(stateDir);
    expect(access.allow_users).toEqual(['ou_requester']);
    expect(access.pending[token]).toBeUndefined();
  });

  it('returns an Owner lookup error toast when owner resolution fails', async () => {
    const bot = createFakeFeishuBot('app');
    vi.spyOn(bot, 'resolveAppOwner').mockRejectedValueOnce(new Error('permission denied'));
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      pending: {
        [token]: {
          kind: 'dm',
          sender_id: 'ou_requester',
          chat_id: 'oc_group',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          replies: 1,
        },
      },
    });
    await start(s);

    const result = await bot.injectCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: {
        [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
        [DREAMUX_PAIRING_TOKEN_KEY]: token,
      },
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      raw: {},
    }) as FeishuCardActionResponse;

    expect(result).toEqual({
      toast: {
        type: 'error',
        content: 'Owner 校验失败，请稍后重试',
      },
    });
    const access = await loadDispatcherAccess(stateDir);
    expect(access.pending[token]).toBeDefined();
    expect(access.allow_users).toEqual([]);
  });

  it('returns a warning toast when the hidden token is no longer pending', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setAppOwner({ creatorOpenId: 'ou_owner' });
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await start(s);

    const result = await bot.injectCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: {
        [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
        [DREAMUX_PAIRING_TOKEN_KEY]: token,
      },
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      raw: {},
    }) as FeishuCardActionResponse;

    expect(result).toEqual({
      toast: {
        type: 'warning',
        content: '授权请求不存在或已过期',
      },
    });
    const access = await loadDispatcherAccess(stateDir);
    expect(access.allow_users).toEqual([]);
    expect(access.pending[token]).toBeUndefined();
  });

  it('closes a duplicate approval with a success toast and success card', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setAppOwner({ creatorOpenId: 'ou_owner' });
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      allow_users: ['ou_requester'],
      pending: {
        [token]: {
          kind: 'dm',
          sender_id: 'ou_requester',
          chat_id: 'oc_group',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          replies: 1,
        },
      },
    });
    await start(s);

    const result = await bot.injectCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: {
        [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
        [DREAMUX_PAIRING_TOKEN_KEY]: token,
      },
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      raw: {},
    }) as FeishuCardActionResponse;

    expect(result.toast).toEqual({
      type: 'success',
      content: '用户 ou_requester 已在允许列表，授权请求已关闭',
    });
    expect(result.card?.type).toBe('raw');
    expect((result.card?.data as { header?: { template?: string } }).header?.template).toBe('green');
    expect(JSON.stringify(result.card?.data)).toContain('目标已经在允许列表');
    const access = await loadDispatcherAccess(stateDir);
    expect(access.allow_users).toEqual(['ou_requester']);
    expect(access.pending[token]).toBeUndefined();
  });

  it('does not approve stale group-kind pending entries from the Owner card path', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setAppOwner({ creatorOpenId: 'ou_owner' });
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      pending: {
        [token]: {
          kind: 'group',
          sender_id: 'ou_requester',
          chat_id: 'oc_group',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          replies: 1,
        },
      },
    });
    await start(s);

    const result = await bot.injectCardAction({
      operatorOpenId: 'ou_owner',
      actionValue: {
        [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
        [DREAMUX_PAIRING_TOKEN_KEY]: token,
      },
      openChatId: 'oc_group',
      openMessageId: 'om_card',
      raw: {},
    }) as FeishuCardActionResponse;

    expect(result).toEqual({
      toast: {
        type: 'error',
        content: '授权请求类型已不再支持',
      },
    });
    const access = await loadDispatcherAccess(stateDir);
    expect(access.allow_users).toEqual([]);
    expect(access.group.allow_chats).toEqual([]);
    expect(access.pending[token]).toBeDefined();
  });

  it('references the existing approval card instead of resending it', async () => {
    const bot = createFakeFeishuBot('app');
    const s = session(stateDir, bot);
    await start(s);

    await bot.inject(inboundEvent({ messageId: 'om_first' }));
    expect(bot.sentCards).toHaveLength(1);
    const promptMessageId = bot.sentCards[0]?.messageIds[0];
    expect(promptMessageId).toBeDefined();
    const firstAccess = await loadDispatcherAccess(stateDir);
    const token = Object.keys(firstAccess.pending)[0];
    expect(token).toBeDefined();
    if (token === undefined || promptMessageId === undefined) return;
    expect(firstAccess.pending[token]?.replies).toBe(1);
    expect(firstAccess.pending[token]?.prompt_message_id).toBe(promptMessageId);

    await bot.inject(inboundEvent({ messageId: 'om_second' }));
    expect(bot.sentCards).toHaveLength(1);
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]?.target.replyToMessageId).toBe(promptMessageId);
    expect(bot.sentMessages[0]?.target.mentionUserIds).toEqual(['ou_requester']);
    expect(bot.sentMessages[0]?.text).toContain('已有授权卡');
    const secondAccess = await loadDispatcherAccess(stateDir);
    expect(secondAccess.pending[token]?.replies).toBe(1);
    expect(secondAccess.pending[token]?.prompt_message_id).toBe(promptMessageId);

    await bot.inject(inboundEvent({ messageId: 'om_third' }));
    expect(bot.sentCards).toHaveLength(1);
    expect(bot.sentMessages).toHaveLength(2);
    expect(bot.sentMessages[1]?.target.replyToMessageId).toBe(promptMessageId);
    const thirdAccess = await loadDispatcherAccess(stateDir);
    expect(thirdAccess.pending[token]?.replies).toBe(1);
    expect(thirdAccess.pending[token]?.prompt_message_id).toBe(promptMessageId);
  });

  it('returns an error toast when approval cannot be persisted', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setAppOwner({ creatorOpenId: 'ou_owner' });
    const token = generatePairingToken();
    const s = session(stateDir, bot);
    await saveDispatcherAccess(stateDir, {
      ...defaultDispatcherAccessState(),
      pending: {
        [token]: {
          kind: 'dm',
          sender_id: 'ou_requester',
          chat_id: 'oc_group',
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          replies: 1,
        },
      },
    });
    await start(s);
    chmodSync(stateDir, 0o500);
    try {
      const result = await bot.injectCardAction({
        operatorOpenId: 'ou_owner',
        actionValue: {
          [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
          [DREAMUX_PAIRING_TOKEN_KEY]: token,
        },
        openChatId: 'oc_group',
        openMessageId: 'om_card',
        raw: {},
      }) as FeishuCardActionResponse;

      expect(result).toEqual({
        toast: {
          type: 'error',
          content: '授权写入失败，请重试',
        },
      });
    } finally {
      chmodSync(stateDir, 0o700);
    }
    const access = await loadDispatcherAccess(stateDir);
    expect(access.allow_users).toEqual([]);
    expect(access.pending[token]).toBeDefined();
  });
});
