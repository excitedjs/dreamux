/**
 * What a Feishu MCP tool is, and what it is allowed to reach.
 *
 * A definition carries its own descriptor, its own parser, its own handler,
 * and the callers it is offered to. That last field is the whole authorization
 * story: Core freezes one catalog per caller and admits only what that catalog
 * advertises, so a tool a TeamLeader is not offered is a tool a TeamLeader
 * cannot name — there is no second check at invoke time to keep in step.
 */
import type { TransactionalStore } from '@excitedjs/dreamux-utils';
import type { ChatBotsState } from '../chat-bots-store.js';
import type { FeishuOutbound } from '../outbound/index.js';
import type { FeishuCardActions } from '../session/card-actions.js';
import type {
  ChannelMcpCaller,
  ChannelMcpToolAnnotations,
  JsonValue,
} from '@excitedjs/dreamux-types';

import type { FeishuDocumentComments } from '../feishu-document-comments.js';
import type { FeishuRouting } from '../routing/index.js';
import type { FeishuBindingOperations } from '../routing/operations.js';

/** Logger shape used by the Feishu session — pino-style, fields-first. */
export type ChannelLogger = import('@excitedjs/dreamux-types').DreamuxLogger;

export interface WireChatBot {
  open_id: string;
  name?: string;
}

export interface FeishuListChatBotsResult {
  chat_id: string;
  known: WireChatBot[];
  trusted: WireChatBot[];
}

/**
 * The live session capability tool handlers run against.
 *
 * This view is built once from actual session owners. Tool handlers map their
 * results to the tool wire shape; outbound, card actions, routing, bindings,
 * document subscriptions, and chat-bot state remain with their own objects.
 */
export interface FeishuToolSession {
  readonly logger: ChannelLogger;
  readonly channelId: string;
  readonly outbound: Pick<FeishuOutbound, 'sendText' | 'react'>;
  readonly cardActions: Pick<FeishuCardActions, 'askUserQuestion'>;
  readonly chatBotsStore: TransactionalStore<ChatBotsState>;
  readonly bindings: Pick<
    FeishuBindingOperations,
    'bindChannel' | 'unbindChannel' | 'bindSpace' | 'unbindSpace'
  >;
  readonly routing: Pick<
    FeishuRouting,
    'listBindings' | 'spaceByName' | 'listSpaces' | 'listSubscriptions'
  >;
  readonly docComments: Pick<
    FeishuDocumentComments,
    'subscribe' | 'unsubscribe'
  >;
}

export interface FeishuToolContext {
  readonly caller: ChannelMcpCaller;
  readonly session: FeishuToolSession;
}

export type FeishuToolResult = Readonly<Record<string, JsonValue>>;

export interface FeishuToolDef<TInput = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: ChannelMcpToolAnnotations;
  /** Which callers this tool is advertised to. */
  callers: readonly ChannelMcpCaller['kind'][];
  parse(raw: unknown): TInput;
  handle(ctx: FeishuToolContext, input: TInput): Promise<FeishuToolResult>;
  successText?(result: FeishuToolResult): string | undefined;
}
