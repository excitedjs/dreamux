/**
 * The reply tool's contract: three fields, a body that reaches Feishu exactly
 * as written, and a platform refusal the model can act on.
 *
 * Mentions are no longer a separate argument — they are written in the body in
 * Feishu's own syntax — so the schema is the place that has to stay closed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ChannelCorePort,
  ChannelEventSubscription,
  ChannelMcpCaller,
  DreamuxLogger,
  JsonValue,
} from '@excitedjs/dreamux-types';

import {
  createFeishuTransport,
  type FeishuTransportOptions,
} from '@excitedjs/feishu-transport';

import { createFeishuBot, type FeishuBot } from '../src/bot.js';
import { FeishuChannelSession } from '../src/feishu-channel.js';
import {
  defaultDispatcherAccessState,
  saveDispatcherAccess,
} from '../src/feishu-gate.js';
import { createFeishuSessionMcp } from '../src/feishu-session-mcp.js';
import { findFeishuTool } from '../src/tools/registry.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

let dir: string;
let attachDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-reply-state-'));
  attachDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-reply-attach-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(attachDir, { recursive: true, force: true });
});

const caller: ChannelMcpCaller = {
  kind: 'team_leader',
  team_name: 'team-1',
  leader_name: 'team-1-leader',
};

interface Logged {
  fields: Record<string, unknown> | string;
  message: string;
}

function recordingLog(lines: Logged[]): DreamuxLogger {
  const record = (
    fields: Record<string, unknown> | string,
    message?: string,
  ): void => {
    lines.push({ fields, message: message ?? '' });
  };
  return {
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
  };
}

const APP_SECRET = 'fake-not-a-real-secret';

function inertPort(): ChannelCorePort {
  return {
    invoke: { invoke: async (): Promise<JsonValue> => null },
    events: {
      subscribe(): ChannelEventSubscription {
        return { unsubscribe: () => undefined };
      },
    },
  };
}

const AUDIT_REFUSAL = {
  code: 230028,
  msg: 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS',
  error: { log_id: 'log_example' },
};

/**
 * A bot over the real transport, with the Lark client replaced by one that
 * answers the way the platform answered the captured refusal. Nothing between
 * that response and the tool result is stubbed, so this is the sentence the
 * caller actually receives.
 */
function refusingBot(): FeishuBot {
  const client = {
    request: async (): Promise<never> => {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: AUDIT_REFUSAL },
      });
    },
  } as unknown as FeishuTransportOptions['client'];
  const creds = { appId: 'app-1', appSecret: APP_SECRET };
  return createFeishuBot(
    { ...creds },
    { createTransport: () => createFeishuTransport(creds, { client }) },
  );
}

function session(bot: FeishuBot, log: DreamuxLogger): FeishuChannelSession {
  return new FeishuChannelSession({
    dispatcherId: 'disp-1',
    channelId: 'chan-reply',
    appId: 'app-1',
    appSecret: APP_SECRET,
    stateDir: dir,
    attachmentCacheDir: attachDir,
    log,
    botFactory: () => bot,
  });
}

describe('the reply tool contract', () => {
  it('takes exactly chat_id, message_id and text', () => {
    const def = findFeishuTool('reply', 'team_leader');
    const schema = def?.inputSchema as {
      properties: Record<string, { description?: string }>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      'chat_id',
      'message_id',
      'text',
    ]);
    expect(schema.required.sort()).toEqual(['chat_id', 'text']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties['text']?.description).toContain(
      '<at user_id="ou_example">Example</at>',
    );
  });

  it('carries nothing beyond those three fields into the session call', () => {
    const def = findFeishuTool('reply', 'team_leader');

    // The closed schema is what refuses an unknown argument upstream; parsing
    // additionally keeps one from reaching the send path if it ever did.
    expect(def?.parse({
      chat_id: 'oc_chat',
      text: 'hi',
      mention_user_ids: ['ou_example'],
    })).toEqual({ chatId: 'oc_chat', text: 'hi' });
  });
});

describe('replying through the MCP capability', () => {
  it('sends the authored body verbatim, threaded under the source message', async () => {
    const bot = createFakeFeishuBot();
    const value = session(bot, recordingLog([]));
    const mcp = createFeishuSessionMcp(value, recordingLog([]));
    const body = 'Done. <at user_id="ou_example">Example</at>\n\n```ts\nok()\n```';

    const outcome = await mcp.invoke(
      {
        name: 'reply',
        arguments: { chat_id: 'oc_chat', message_id: 'om_source', text: body },
      },
      { dispatcher_id: 'disp-1', channel_id: 'chan-reply', caller },
    );

    expect(outcome.ok).toBe(true);
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]?.text).toBe(body);
    expect(bot.sentMessages[0]?.target).toEqual({
      chatId: 'oc_chat',
      replyToMessageId: 'om_source',
    });
    await value.close();
  });

  it('carries the platform refusal into the log and the tool result', async () => {
    const channelLines: Logged[] = [];
    const mcpLines: Logged[] = [];
    const body = 'reach me at nobody@example.com';
    const value = session(refusingBot(), recordingLog(channelLines));
    const mcp = createFeishuSessionMcp(value, recordingLog(mcpLines));

    const thrown = await mcp.invoke(
      {
        name: 'reply',
        arguments: { chat_id: 'oc_chat', message_id: 'om_source', text: body },
      },
      { dispatcher_id: 'disp-1', channel_id: 'chan-reply', caller },
    ).then(() => undefined, (err: unknown) => err as Error);

    // Core renders a thrown tool failure as its own message under a generic
    // code, so this message is the whole of what the model gets to act on.
    expect(thrown?.message).toBe(
      'Feishu message.reply failed (HTTP 400, code 230028, ' +
        `log_id=log_example): ${AUDIT_REFUSAL.msg}`,
    );

    const logged = [...channelLines, ...mcpLines]
      .map((line) => JSON.stringify(line))
      .join('\n');
    expect(logged).toContain('code 230028');
    expect(logged).toContain('log_id=log_example');
    // The reply body and the credentials never travel with the failure.
    expect(logged).not.toContain(APP_SECRET);
    expect(logged).not.toContain(body);
    await value.close();
  });
});

describe('the pairing resend reminder', () => {
  it('mentions the requester by writing the tag into its own body', async () => {
    const bot = createFakeFeishuBot();
    const now = Date.now();
    await saveDispatcherAccess(dir, {
      ...defaultDispatcherAccessState(),
      pending: {
        'pending-token': {
          kind: 'dm',
          sender_id: 'ou_requester',
          chat_id: 'oc_dm',
          created_at: now,
          expires_at: now + 60_000,
          replies: 1,
          prompt_message_id: 'om_prompt',
        },
      },
    });
    const value = session(bot, recordingLog([]));
    await value.initialize(inertPort());
    await value.start();

    await bot.inject({
      messageId: 'om_repeat',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_requester',
      senderType: 'user',
      senderName: 'Requester',
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello again' }),
      contentParts: [{ kind: 'text', text: 'hello again' }],
      mentions: [],
      createTime: String(now),
      raw: {},
    });

    expect(bot.sentMessages).toHaveLength(1);
    const sent = bot.sentMessages[0];
    expect(sent?.text.startsWith('<at user_id="ou_requester"></at>\n')).toBe(true);
    expect(sent?.target).toEqual({
      chatId: 'oc_dm',
      replyToMessageId: 'om_prompt',
    });
    await value.close();
  });
});
