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

import type { AskUserQuestionSpec } from '../feishu-ask-user-card.js';
import type { FeishuSpaceRecord } from '../routing/document.js';
import type { FeishuBindingView } from '../routing/index.js';
import type { FeishuTargetKind } from '../routing/target.js';

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

export interface FeishuBindTargetSelector {
  chatId: string;
  threadId?: string;
}

export interface FeishuSpacePolicyInput {
  spaceName: string;
  chatId: string;
  display: string | null;
  leaderAgentRuntime: string;
  identity: string | null;
  repo: { path: string; base_ref: string | null } | null;
}

/**
 * The live session capability tool handlers run against. It is deliberately a
 * plain function bundle: definitions stay unit-testable and never reach into
 * the session class.
 */
export interface FeishuToolSession {
  readonly logger: ChannelLogger;
  readonly channelId: string;
  sendText(
    chatId: string,
    text: string,
    opts?: { messageId?: string; mentionUserIds?: string[] },
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
    questions: readonly AskUserQuestionSpec[];
    messageId?: string;
  }): Promise<{ request_id: string }>;
  /**
   * `requireOwner` is the Team a route must already belong to, if any Team
   * does. A Dispatcher omits it and may move any route; a TeamLeader passes
   * its own Team and reaches only its own.
   */
  bindChannel(input: {
    target: FeishuBindTargetSelector;
    teamName: string;
    display: string | null;
    requireOwner?: string;
  }): Promise<{ team_name: string; previous_team_name: string | null }>;
  unbindChannel(
    target: FeishuBindTargetSelector,
    requireOwner?: string,
  ): Promise<{ team_name: string | null }>;
  listBindings(): readonly FeishuBindingView[];
  bindSpace(input: FeishuSpacePolicyInput): Promise<FeishuSpaceRecord>;
  unbindSpace(spaceName: string): Promise<FeishuSpaceRecord | null>;
  getSpace(spaceName: string): FeishuSpaceRecord | undefined;
  listSpaces(): readonly FeishuSpaceRecord[];
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
}

export interface FeishuTargetSelectorFields {
  kind: FeishuTargetKind;
  chat_id: string;
  thread_id: string | null;
}
