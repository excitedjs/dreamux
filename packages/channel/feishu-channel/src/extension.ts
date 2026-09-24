/**
 * The Feishu plugin's own extension surface.
 *
 * Feishu publishes this as its plugin `api`: another plugin receives it through
 * `hooks.plugin.for('feishu')` and registers extensions there, which is the
 * last step of plugin loading, so every extension tool and card action exists
 * before any Feishu channel instance is created. Each extension then lives per
 * Feishu channel instance: `initialize` returns that instance's state, and every
 * tool call and card action it handles receives that state, so two Feishu
 * channels never share one.
 */
import type { ChannelMcpCaller, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { FeishuCardActionEvent } from './bot.js';
import type { FeishuCardActionResponse } from './feishu-pairing-card.js';
import type { FeishuTarget } from './routing/target.js';
import type { FeishuToolDef, FeishuToolResult } from './tools/types.js';

export interface FeishuApi {
  readonly extensions: {
    /**
     * Throws on a blank (trimmed) extension name, tool name, or card action
     * key; a duplicate extension name; a tool name already offered to the
     * same caller kind; or a card action key already claimed, the
     * extension's own earlier entries included, naming both sources.
     */
    register<S>(extension: FeishuExtension<S>): void;
  };
}

export interface FeishuExtension<S> {
  readonly name: string;
  readonly tools: readonly FeishuExtensionTool<S>[];
  readonly cardActions: readonly FeishuExtensionAction<S>[];
  /**
   * Once per Feishu channel instance, after the routing store loaded; returns
   * that instance's state. Local IO only: the bot is not started yet and the
   * core channel contract forbids external IO during initialize. Of
   * `context.api`, only `owner` may be called here; outbound calls (`sendCard`,
   * `editCard`, `readMessageRoute`, `bindTeam`) wait for `start`.
   */
  initialize(context: FeishuExtensionContext): Promise<S>;
  /**
   * After the bot connection is live: the first point where `api` outbound
   * calls work. Start timers here.
   */
  start(state: S): Promise<void>;
  /**
   * After new tool calls and card actions are refused and in-flight ones
   * settled. The instance is already fenced: `readMessageRoute`, `bindTeam`,
   * `sendCard` and `editCard` reject with a `FeishuOperationError` of kind
   * `aborted`. Release local resources only.
   */
  close(state: S): Promise<void>;
}

/**
 * A Feishu MCP tool an extension adds. Same descriptor, caller list, and parse
 * step as a built-in tool; the handler receives this instance's state instead
 * of the built-in tool session. Refuse by throwing `PublicInvokeFailure`.
 */
export type FeishuExtensionTool<S, TInput = unknown> =
  Omit<FeishuToolDef<TInput>, 'handle'> & {
    handle(
      ctx: { readonly caller: ChannelMcpCaller; readonly state: S },
      input: TInput,
    ): Promise<FeishuToolResult>;
  };

/**
 * What a card action handler wants forwarded to the conversation's Team, as an
 * ordinary inbound submission. The handler states only what to say: Feishu
 * resolves the Team from the card's own message and delivers through the same
 * path an ask-user answer takes, so no extension holds Team-resolution or
 * delivery logic of its own.
 */
export interface FeishuExtensionForward {
  readonly text: string;
  /** The identity Core deduplicates a repeat delivery on. */
  readonly sourceId: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

export interface FeishuExtensionActionResult {
  /** The card callback's own answer. */
  readonly response: FeishuCardActionResponse | Record<string, never>;
  /** Delivered after `response` is handed back to Feishu, detached. */
  readonly forward?: FeishuExtensionForward;
}

export interface FeishuExtensionAction<S> {
  /** The card button value's `dreamux_action`. */
  readonly key: string;
  /**
   * `response` is awaited before Feishu gets the callback answer, and Feishu
   * gives a card callback only a few seconds before the click looks dead:
   * answer quickly. `forward`, if present, is delivered afterwards and does
   * not hold up the callback.
   */
  handle(
    state: S,
    event: FeishuCardActionEvent,
  ): Promise<FeishuExtensionActionResult>;
}

export interface FeishuExtensionContext {
  readonly dispatcherId: string;
  readonly channelId: string;
  /**
   * `<dispatcher state dir>/feishu-extensions/<extension name>/<channel segment>`:
   * one directory per extension per Feishu channel, so two Feishu channels on
   * one Dispatcher never share state. Not created for you.
   */
  readonly stateRoot: string;
  /** Aborted when this channel instance begins closing. */
  readonly signal: AbortSignal;
  readonly log: DreamuxLogger;
  readonly api: FeishuInstanceApi;
}

/** Bound to one Feishu channel instance and to its current lifecycle. */
export interface FeishuInstanceApi {
  /** The Team this conversation routes to; a topic inherits its group's binding. */
  owner(target: FeishuTarget): string | null;
  /** Where Feishu reports the message is, topic included. */
  readMessageRoute(messageId: string): Promise<{ target: FeishuTarget }>;
  /**
   * Bind a conversation to a Team, with the same validation and bound
   * notification the binding tools have.
   */
  bindTeam(input: {
    target: FeishuTarget;
    teamName: string;
    display: string;
  }): Promise<void>;
  /**
   * Send a card and read back where Feishu placed it. There is no idempotency
   * key, and the read-back runs after delivery: a rejection can mean the card
   * is already in the chat, so retrying on any rejection can post it twice.
   */
  sendCard(input: {
    chatId: string;
    replyTo?: string;
    card: unknown;
  }): Promise<{ messageId: string; target: FeishuTarget }>;
  editCard(messageId: string, card: unknown): Promise<void>;
}
