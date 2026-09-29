/**
 * What a Feishu MCP tool is, and what it is allowed to reach.
 *
 * A definition carries its own descriptor, its own parser, its own handler,
 * and the callers it is offered to. That last field is the whole authorization
 * story: Core freezes one catalog per caller and admits only what that catalog
 * advertises, so a tool a TeamLeader is not offered is a tool a TeamLeader
 * cannot name — there is no second check at invoke time to keep in step.
 */
import type {
  ChannelMcpCaller,
  ChannelMcpToolAnnotations,
  JsonValue,
} from '@excitedjs/dreamux-types';

import type { AskUserQuestionSpec } from '../cards/ask-user.js';
import type { FeishuBindingOperations } from '../routing/operations.js';
import type { FeishuRouting } from '../routing/index.js';
import type { FeishuDocumentComments } from '../feishu-document-comments.js';

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
 * `sendText`/`react`/`listKnownChatBots`/`askUserQuestion` carry session-owned
 * logic (mapping the outbound result to the tool's own wire shape, reading the
 * chat-bots store) and stay methods here. Routing, binding, and document-
 * subscription tools instead reach their real owners directly through the
 * narrow `Pick<>`s below — there is nothing for a re-declared forwarding
 * method to add between a tool handler and `FeishuBindingOperations` /
 * `FeishuRouting` / `FeishuDocumentComments`, which each already validate and
 * own their own state.
 */
export interface FeishuToolSession {
  readonly logger: ChannelLogger;
  readonly channelId: string;
  sendText(
    chatId: string,
    text: string,
    opts: {
      messageId?: string;
      /** The calling Team, or `null` for the Dispatcher Agent. */
      callerTeamName: string | null;
    },
  ): Promise<{ message_ids: string[] }>;
  react(
    chatId: string | undefined,
    messageId: string,
    emoji: string,
  ): Promise<{ reaction_id: string }>;
  listKnownChatBots(chatId: string): Promise<FeishuListChatBotsResult>;
  /**
   * Send a question card and return once it is sent. The answer is not awaited:
   * it reaches the model later as an inbound submission, so this resolves with
   * the round's identity rather than with what the user chose.
   */
  askUserQuestion(input: {
    chatId: string;
    text?: string;
    questions: readonly AskUserQuestionSpec[];
    messageId?: string;
  }): Promise<{ request_id: string }>;
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
