import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import * as lark from '@larksuiteoapi/node-sdk';
import type {
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  createFeishuTransport,
  type FeishuMessageResourceRequest,
  type FeishuMessageReadMode,
  type InboundRoutes,
} from '@excitedjs/feishu-transport';
import { vi } from 'vitest';

import { createFeishuBot } from '../../src/bot.js';
import {
  FeishuChannelSession,
  type FeishuInboundSubmitter,
} from '../../src/feishu-channel.js';
import {
  defaultDispatcherAccessState,
  saveDispatcherAccess,
} from '../../src/feishu-gate.js';

type ContactResponse = {
  code?: number;
  data?: { user?: { name?: string } };
};

type MessageReadResponse = {
  data?: { items?: unknown[] };
};

interface HarnessOptions {
  contactLookup?: (input: unknown) => Promise<ContactResponse>;
  submitTurn?: (
    input: InboundTurnInput,
  ) => Promise<AgentRuntimeTurnResult>;
}

export interface RealFeishuHarness {
  readonly session: FeishuChannelSession;
  readonly stateDir: string;
  readonly submitted: InboundTurnInput[];
  readonly contactUserGet: ReturnType<typeof vi.fn>;
  readonly messageGet: ReturnType<typeof vi.fn>;
  readonly resourceGet: ReturnType<typeof vi.fn>;
  readonly reactionCreate: ReturnType<typeof vi.fn>;
  readonly reactionDelete: ReturnType<typeof vi.fn>;
  setMessageRead(
    messageId: string,
    mode: FeishuMessageReadMode,
    response: MessageReadResponse | Promise<MessageReadResponse> | Error,
  ): void;
  setResource(fileKey: string, value: Buffer | Error): void;
  dispatch(raw: unknown): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

const harnesses = new Set<RealFeishuHarness>();

export async function cleanupRealFeishuHarnesses(): Promise<void> {
  await Promise.allSettled([...harnesses].map(async (harness) => harness.close()));
  harnesses.clear();
}

export async function createRealFeishuHarness(
  options: HarnessOptions = {},
): Promise<RealFeishuHarness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-real-'));
  const access = defaultDispatcherAccessState();
  access.dm_policy = 'allowlist';
  access.allow_users = ['ou_allowed'];
  access.group = {
    policy: 'allowlist',
    allow_chats: ['oc_group'],
    require_mention: false,
  };
  await saveDispatcherAccess(stateDir, access);

  const reads = new Map<
    string,
    MessageReadResponse | Promise<MessageReadResponse> | Error
  >();
  const resources = new Map<string, Buffer | Error>();
  const messageGet = vi.fn(async (input: {
    path: { message_id: string };
    params: { card_msg_content_type?: string };
  }) => {
    const mode = input.params.card_msg_content_type === 'user_card_content'
      ? 'user_card_content'
      : 'default';
    const value = reads.get(`${mode}:${input.path.message_id}`);
    if (value === undefined) {
      throw new Error(`missing read ${mode}:${input.path.message_id}`);
    }
    if (value instanceof Error) throw value;
    return await value;
  });
  const resourceGet = vi.fn(async (input: {
    path: { message_id: string; file_key: string };
    params: { type: string };
  }) => {
    const value = resources.get(input.path.file_key);
    if (value === undefined) {
      throw new Error(`missing resource ${input.path.file_key}`);
    }
    if (value instanceof Error) throw value;
    return {
      getReadableStream: () => Readable.from([value]),
      headers: {},
    };
  });
  const contactUserGet = vi.fn(
    options.contactLookup ?? (async () => ({ code: 0 })),
  );
  const reactionCreate = vi.fn(async () => ({
    data: { reaction_id: `reaction-${reactionCreate.mock.calls.length}` },
  }));
  const reactionDelete = vi.fn(async () => ({}));
  const sdkClient = {
    contact: { v3: { user: { get: contactUserGet } } },
    im: {
      v1: {
        message: { get: messageGet },
        messageResource: { get: resourceGet },
      },
      message: {
        create: vi.fn(async () => ({ data: { message_id: 'om_sent' } })),
        reply: vi.fn(async () => ({ data: { message_id: 'om_reply' } })),
        patch: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      messageReaction: {
        create: reactionCreate,
        delete: reactionDelete,
      },
      chat: {
        get: vi.fn(async () => ({ data: { chat_mode: 'group' } })),
        create: vi.fn(async () => ({ data: { chat_id: 'oc_created' } })),
        members: { create: vi.fn(async () => ({})) },
      },
    },
    drive: {
      fileComment: { batchQuery: vi.fn(async () => ({ data: { items: [] } })) },
      meta: { batchQuery: vi.fn(async () => ({ data: { metas: [] } })) },
    },
    request: vi.fn(async () => ({})),
  };
  let routes: InboundRoutes | undefined;
  const transport = createFeishuTransport(
    { appId: 'app-test', appSecret: 'secret' },
    {
      client: sdkClient as unknown as lark.Client,
      webSocketRegistration: {
        async open(nextRoutes) {
          routes = nextRoutes;
          return { openId: 'ou_bot', appName: 'Dreamux' };
        },
        close() {
          routes = undefined;
        },
      },
    },
  );
  const bot = createFeishuBot(
    { appId: 'app-test', appSecret: 'secret', logger: logger() },
    { createTransport: () => transport },
  );
  const submitted: InboundTurnInput[] = [];
  const submitter: FeishuInboundSubmitter = {
    submitTurn: async (input) => {
      submitted.push(input);
      return options.submitTurn?.(input) ??
        { status: 'submitted', turnId: `turn-${input.sourceId}` };
    },
  };
  const session = new FeishuChannelSession({
    dispatcherId: 'dispatcher-a',
    appId: 'app-test',
    appSecret: 'secret',
    stateDir,
    attachmentCacheDir: join(stateDir, 'attachments'),
    log: logger(),
    botFactory: () => bot,
  });
  let closed = false;
  const harness: RealFeishuHarness = {
    session,
    stateDir,
    submitted,
    contactUserGet,
    messageGet,
    resourceGet,
    reactionCreate,
    reactionDelete,
    setMessageRead(messageId, mode, response): void {
      reads.set(`${mode}:${messageId}`, response);
    },
    setResource(fileKey, value): void {
      resources.set(fileKey, value);
    },
    async dispatch(raw): Promise<void> {
      const route = routes?.['im.message.receive_v1'];
      if (route === undefined) throw new Error('real Feishu route is not active');
      await route(raw);
    },
    async start(): Promise<void> {
      closed = false;
      await session.start(submitter);
    },
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        await session.close();
      }
      rmSync(stateDir, { recursive: true, force: true });
      harnesses.delete(harness);
    },
  };
  harnesses.add(harness);
  await harness.start();
  return harness;
}

export function rawMessage(
  messageId: string,
  messageType: string,
  content: unknown,
  input: {
    parentId?: string;
    rootId?: string;
    threadId?: string;
    chatId?: string;
    chatType?: 'group' | 'p2p';
    senderId?: string;
    senderType?: string;
    senderName?: string;
    mentions?: Array<{
      key: string;
      id?: { open_id?: string };
      name?: string;
    }>;
  } = {},
): unknown {
  return {
    event: {
      sender: {
        sender_id: { open_id: input.senderId ?? 'ou_allowed' },
        sender_type: input.senderType ?? 'user',
        ...(input.senderName !== undefined
          ? { sender_name: input.senderName }
          : {}),
      },
      message: {
        message_id: messageId,
        chat_id: input.chatId ?? 'oc_dm',
        chat_type: input.chatType ?? 'p2p',
        message_type: messageType,
        content: JSON.stringify(content),
        create_time: '1710000000000',
        mentions: input.mentions ?? [],
        ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
        ...(input.rootId !== undefined ? { root_id: input.rootId } : {}),
        ...(input.threadId !== undefined ? { thread_id: input.threadId } : {}),
      },
    },
  };
}

export function rawReadItem(
  messageId: string,
  messageType: string,
  content: unknown,
  input: {
    mentions?: Array<{
      key?: string;
      id?: string;
      id_type?: string;
      name?: string;
    }>;
    deleted?: boolean;
  } = {},
): unknown {
  return {
    message_id: messageId,
    msg_type: messageType,
    body: {
      content: typeof content === 'string' ? content : JSON.stringify(content),
    },
    mentions: input.mentions ?? [],
    ...(input.deleted === true ? { deleted: true } : {}),
  };
}

function logger(): DreamuxLogger {
  const noop = (): void => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger(),
  } as unknown as DreamuxLogger;
}

export function messageResourceCalls(
  harness: RealFeishuHarness,
): FeishuMessageResourceRequest[] {
  return harness.resourceGet.mock.calls.map(([input]) => {
    const call = input as {
      path: { message_id: string; file_key: string };
      params: { type: 'file' | 'image' };
    };
    return {
      messageId: call.path.message_id,
      fileKey: call.path.file_key,
      type: call.params.type,
    };
  });
}

export function messageReadCalls(
  harness: RealFeishuHarness,
): Array<{
  messageId: string;
  cardContent: FeishuMessageReadMode;
}> {
  return harness.messageGet.mock.calls.map(([input]) => {
    const call = input as {
      path: { message_id: string };
      params: { card_msg_content_type?: string };
    };
    return {
      messageId: call.path.message_id,
      cardContent: call.params.card_msg_content_type === 'user_card_content'
        ? 'user_card_content'
        : 'default',
    };
  });
}
