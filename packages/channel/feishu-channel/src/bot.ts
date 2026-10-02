/**
 * The `FeishuBot` adapter — one per Dispatcher (D3: 1 Dispatcher = 1 Bot).
 *
 * Since issue #25 PR1 this is a thin adapter over `@excitedjs/feishu-transport`
 * (the shared platform-I/O core): all Feishu SDK I/O and event/content
 * parsing — the inbound WebSocket, markdown→card render, content parse, the
 * inbound event-envelope decode, the outbound message API — lives in the
 * core, the single importer of `@larksuiteoapi/node-sdk`. `FeishuBot` is
 * `FeishuTransport`'s own shape, spread through as-is, with `start` adapted to
 * this package's typed route table and `selfId`/`selfName` renamed to
 * `botOpenId`/`botDisplayName`:
 *   - `start(routes)` takes one handler per Feishu event type (issue #62 seam):
 *     `onMessage` for `im.message.receive_v1` (decoded via the core's
 *     `parseFeishuInboundEvent`) and an optional `onBotMemberAdded` for
 *     `im.chat.member.bot.added_v1`. Each route awaits its handler, so the
 *     server gates and submits accepted inbound before the SDK acks.
 *   - Every other member (`send`, `sendCard`, `addReaction`, `editCard`,
 *     document/message reads, `cot`, `resolveAppOwner`, `close`, …) is the
 *     core transport's own member, forwarded unchanged; its optionality
 *     (`getChatMode?`, `readMessage?`, `resolveUserName?`, `resolveChatName?`,
 *     `cot?`) follows the transport contract. This adapter constructs the
 *     concrete transport; it has no alternate bot or transport factory.
 */

import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  DOC_COMMENT_EVENT_TYPE,
  createFeishuTransport,
  normalizeBotMemberAddedEvent,
  normalizeCardActionAck,
  normalizeCardActionEvent,
  normalizeCommentEvent,
  parseFeishuInboundEvent,
  type FeishuBotMemberAddedEvent,
  type FeishuCardActionEvent,
  type FeishuCommentEvent,
  type FeishuInboundEvent,
  type FeishuTransport,
  type TransportLogger,
} from '@excitedjs/feishu-transport';

/** The Feishu event_type carrying inbound chat messages. */
const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';

export type InboundHandler = (
  event: FeishuInboundEvent,
) => void | Promise<void>;

export type BotMemberAddedHandler = (
  event: FeishuBotMemberAddedEvent,
) => void | Promise<void>;

export type CardActionHandler = (
  event: FeishuCardActionEvent,
) => unknown | Promise<unknown>;

export type DocCommentHandler = (
  event: FeishuCommentEvent,
) => void | Promise<void>;

/**
 * The typed event-route seam (issue #62 Phase 1). `start` takes one handler per
 * Feishu event type instead of a single message handler, so a new event type is
 * wired by adding a field here and a transport route, without growing branches
 * in `Server`. Each route still awaits its handler before the SDK acks
 * (queue-before-ACK).
 *
 * This file used to say a third event type should promote the seam to a generic
 * `eventType -> handler` map. It stays typed instead, and knowingly: every route
 * carries a *different* payload type and its own normalizer, so one map value
 * type would have to be `(raw: unknown) => …` and each handler would re-narrow
 * what the seam exists to have narrowed already. The `Record` the table is built
 * into below is the transport's wire shape, not this contract.
 */
export interface FeishuInboundRoutes {
  /** `im.message.receive_v1` — a chat message. */
  onMessage: InboundHandler;
  /** `im.chat.member.bot.added_v1` — the bot was added to a chat. Optional. */
  onBotMemberAdded?: BotMemberAddedHandler;
  /** `card.action.trigger` — the user clicked an interactive card component. */
  onCardAction?: CardActionHandler;
  /** `drive.notice.comment_add_v1` — a comment or reply on a document. */
  onDocComment?: DocCommentHandler;
}

export type FeishuBot = Omit<
  FeishuTransport,
  'start' | 'selfId' | 'selfName'
> & {
  readonly botOpenId: string | undefined;
  readonly botDisplayName: string | undefined;
  start(routes: FeishuInboundRoutes): Promise<void>;
};

export interface CreateBotOptions {
  appId: string;
  appSecret: string;
  /**
   * Structured logger for the underlying transport's own diagnostics (Lark SDK
   * logging, WebSocket connection lifecycle, best-effort fetch/close failures).
   * Forwarded verbatim to `createFeishuTransport`. Omit to keep the transport's
   * historical stderr behavior. The server injects the dispatcher's
   * per-dispatcher channel logger here so connection/SDK lines land in
   * `logs/channel/<id>.log` alongside the host's own channel decisions.
   */
  logger?: TransportLogger;
}

export function createFeishuBot(opts: CreateBotOptions): FeishuBot {
  const transport = createFeishuTransport(
    {
      appId: opts.appId,
      appSecret: opts.appSecret,
    },
    // Forward the host's logger so the transport's own SDK / connection
    // diagnostics fold into the per-dispatcher channel log. `undefined` keeps
    // the transport's default stderr behavior, so always passing the option
    // object is safe and keeps the real wiring path explicit.
    { logger: opts.logger },
  );

  return {
    // Spreading a getter captures its current value as a plain property, so
    // this also copies `transport`'s own `selfId`/`selfName` (unresolved at
    // construction time) as inert, `FeishuBot`-untyped fields; `botOpenId`/
    // `botDisplayName` below close over `transport` directly so they always
    // read the live, later-resolved identity instead.
    ...transport,

    get botOpenId(): string | undefined {
      return transport.selfId;
    },
    get botDisplayName(): string | undefined {
      return transport.selfName;
    },

    async start(routes: FeishuInboundRoutes): Promise<void> {
      // The core opens the WebSocket and awaits each route handler before the
      // SDK acks; awaiting here keeps gate/submission work before ACK.
      // `start` rejects if the connection does not come up, so the server's
      // try/catch can fail the dispatcher loudly rather than leave it dark.
      const table: Record<string, (raw: unknown) => Promise<unknown>> = {
        [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown) => {
          const event = parseFeishuInboundEvent(raw);
          if (event === null) return;
          await routes.onMessage(event);
        },
      };
      if (routes.onBotMemberAdded !== undefined) {
        const onBotMemberAdded = routes.onBotMemberAdded;
        table[BOT_MEMBER_ADDED_EVENT_TYPE] = async (raw: unknown) => {
          const event = normalizeBotMemberAddedEvent(raw);
          if (event === null) return;
          await onBotMemberAdded(event);
        };
      }
      if (routes.onCardAction !== undefined) {
        const onCardAction = routes.onCardAction;
        table['card.action.trigger'] = async (raw: unknown) =>
          normalizeCardActionAck(
            await onCardAction(normalizeCardActionEvent(raw)),
            opts.logger,
          );
      }
      if (routes.onDocComment !== undefined) {
        const onDocComment = routes.onDocComment;
        table[DOC_COMMENT_EVENT_TYPE] = async (raw: unknown) => {
          const event = normalizeCommentEvent(raw);
          if (event === null) return;
          await onDocComment(event);
        };
      }
      await transport.start(table);
    },
  };
}
