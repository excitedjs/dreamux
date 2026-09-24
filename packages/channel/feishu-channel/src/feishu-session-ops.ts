/**
 * Feishu channel session — heavyweight operations extracted from the
 * `FeishuChannelSession` class so the session file stays under the max-lines
 * lint rule.
 *
 * All helpers take a `SessionHandle` — a plain bundle of the resources a
 * helper needs (the session options, in-memory state, bot, access mutex, bot
 * display name). The class keeps these fields `private` and builds a handle
 * at every call site with a thin getter; free functions never see the class.
 */

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
  type FeishuSendOptions,
} from '@excitedjs/feishu-transport';
import type {
  ChannelOutboundTarget,
  FeishuBot,
  FeishuCardActionEvent,
  FeishuInboundEvent,
} from './bot.js';
import { channelOutboundToFeishuTarget } from './bot.js';
import {
  DREAMUX_ACTION_KEY,
  DREAMUX_PAIRING_CARD_ACTION,
  DREAMUX_PAIRING_TOKEN_KEY,
  buildPairingSuccessCard,
  rawCardActionResponse,
  type FeishuCardActionResponse,
} from './feishu-pairing-card.js';
import { introduceAckText } from './introduce.js';
import { PAIRING_TOKEN_REGEX } from './feishu-gate.js';
import { approvePairingByToken } from './feishu-gate-io.js';
import { AsyncMutex } from './lib/mutex.js';
import type { FeishuChannelSessionOptions } from './feishu-channel.js';
import type { PeerBot } from './chat-bots-store.js';
import type {
  FeishuInboundRoute,
  FeishuTargetRouter,
} from './feishu-target-router.js';
import {
  CHANNEL_REMINDER,
  describeSubmitOutcome,
  type FeishuChatSubmission,
  type FeishuInboundDelivery,
  type FeishuSubmitOutcome,
  type SubmitOutcomeMessages,
} from './feishu-submit.js';
import type {
  AskUserExpiry,
  AskUserRegistry,
  AskUserSettlement,
} from './feishu-ask-user.js';
import type { AskUserQuestionSpec } from './feishu-ask-user-card.js';
import type {
  FeishuExtensionActionResult,
  FeishuExtensionForward,
} from './extension.js';
import { FeishuOperationError } from './feishu-bounded-operation.js';
import {
  alwaysActiveSessionFence,
  type FeishuSessionFence,
} from './feishu-inbound-work.js';
import type { FeishuTarget } from './routing/target.js';

// ─────────────────────────────────────────────────────────────────────────
// In-memory state & constants (mirror the class fields)
// ─────────────────────────────────────────────────────────────────────────

/**
 * What a resolved extension card action gives `handleCardAction`: enough to
 * run it and to name it in a forward's delivery logs.
 */
export interface FeishuExtensionActionHandler {
  readonly extensionName: string;
  invoke(event: FeishuCardActionEvent): Promise<FeishuExtensionActionResult>;
}

/** Opaque resource bundle a session builds for each helper call. */
export interface SessionHandle {
  opts: FeishuChannelSessionOptions;
  bot: FeishuBot;
  accessMutex: AsyncMutex;
  botDisplayName: string;
  targetRouter: FeishuTargetRouter;
  sessionFence: FeishuSessionFence;
  /**
   * Where an accepted message goes. The inbound helper reaches routing,
   * provisioning, and submission only through this one capability, so it never
   * learns what a binding or a space policy is.
   */
  delivery: FeishuInboundDelivery;
  /** Open ask-user rounds; a question outlives the tool call that asked it. */
  askUser: AskUserRegistry;
  /** The extension claiming a card action key, ready to run, if any. */
  extensionAction(key: string): FeishuExtensionActionHandler | undefined;
}

/** Build a package-private handle from a session's internal fields. */
export function sessionHandle(input: {
  opts: FeishuChannelSessionOptions;
  bot: FeishuBot;
  accessMutex: AsyncMutex;
  botDisplayName: string;
  targetRouter: FeishuTargetRouter;
  delivery: FeishuInboundDelivery;
  askUser: AskUserRegistry;
  sessionFence?: FeishuSessionFence;
  extensionAction: (key: string) => FeishuExtensionActionHandler | undefined;
}): SessionHandle {
  return {
    opts: input.opts,
    bot: input.bot,
    accessMutex: input.accessMutex,
    botDisplayName: input.botDisplayName,
    targetRouter: input.targetRouter,
    delivery: input.delivery,
    askUser: input.askUser,
    sessionFence: input.sessionFence ?? alwaysActiveSessionFence(),
    extensionAction: input.extensionAction,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}

const log = (h: SessionHandle): DreamuxLogger => h.opts.log;

function openIdLogFields(name: string, openId: string): Record<string, unknown> {
  return { [`${name}_len`]: openId.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Reply + reaction primitives (were `private sendReply` / `addReaction`)
// ─────────────────────────────────────────────────────────────────────────

export async function sendReply(
  h: SessionHandle,
  input: {
    chatId: string;
    text: string;
    messageId?: string;
    onMessageCreated?: FeishuSendOptions['onMessageCreated'];
  },
): Promise<{ messageIds: string[] }> {
  let result: { messageIds: string[] };
  try {
    result = await h.bot.send(
      channelOutboundToFeishuTarget({
        conversationId: input.chatId,
        ...(input.messageId !== undefined ? { replyTo: input.messageId } : {}),
      }),
      input.text,
      { onMessageCreated: input.onMessageCreated },
    );
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.opts.dispatcherId,
        chat_id: input.chatId,
        message_id: input.messageId,
        err: errInfo(err),
      },
      'feishu send failed',
    );
    throw err;
  }
  log(h).info(
    {
      dispatcher_id: h.opts.dispatcherId,
      chat_id: input.chatId,
      message_id: input.messageId,
      message_ids: result.messageIds,
    },
    'feishu message sent',
  );
  return result;
}

export async function sendCard(
  h: SessionHandle,
  input: {
    target: ChannelOutboundTarget;
    card: unknown;
    signal?: AbortSignal;
    mode?: 'inbound' | 'background';
  },
): Promise<{ messageIds: string[] }> {
  if (!h.sessionFence.isCurrent()) {
    throw new FeishuOperationError('aborted');
  }
  let result: { messageIds: string[] };
  try {
    result = await h.bot.sendCard(
      channelOutboundToFeishuTarget(input.target),
      input.card,
      input.signal !== undefined ? { signal: input.signal } : undefined,
    );
  } catch (err) {
    if (input.mode !== 'background') {
      log(h).error(
        {
          dispatcher_id: h.opts.dispatcherId,
          chat_id: input.target.conversationId,
          message_id: input.target.replyTo,
          err: errInfo(err),
        },
        'feishu sendCard failed',
      );
    }
    throw err;
  }
  if (!h.sessionFence.isCurrent()) {
    throw new FeishuOperationError('aborted');
  }
  if (input.mode !== 'background') {
    log(h).info(
      {
        dispatcher_id: h.opts.dispatcherId,
        chat_id: input.target.conversationId,
        message_id: input.target.replyTo,
        message_ids: result.messageIds,
      },
      'feishu interactive card sent',
    );
  }
  return result;
}

export async function addReaction(
  h: SessionHandle,
  input: { messageId: string; emoji: string; chatId?: string },
): Promise<string> {
  let reactionId: string;
  try {
    reactionId = await h.bot.addReaction(input.messageId, input.emoji);
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: input.messageId,
        err: errInfo(err),
      },
      'feishu add-reaction failed',
    );
    throw err;
  }
  log(h).info(
    {
      dispatcher_id: h.opts.dispatcherId,
      chat_id: input.chatId,
      message_id: input.messageId,
      emoji: input.emoji,
      reaction_id: reactionId,
    },
    'feishu reaction added',
  );
  return reactionId;
}

/**
 * Where a sent message actually is, asked of Feishu rather than assumed.
 *
 * A message sent as a reply lives in the replied-to message's topic, which
 * only Feishu can report. An ask-user round is opened before its card exists,
 * so nothing it holds says where the card landed; a message this fails to
 * locate is a failed delivery — the chat the question was asked from is a
 * guess, and a guess puts one conversation's answer in front of another.
 */
export async function readMessageRoute(
  h: SessionHandle,
  messageId: string,
): Promise<FeishuInboundRoute> {
  const read = await h.bot.readMessage?.({ messageId });
  const message = read?.items.find((item) => item.messageId === messageId);
  if (message === undefined || message.chatId === '') {
    throw new Error(`Feishu reported no chat for message ${messageId}`);
  }
  return h.targetRouter.project({
    chatId: message.chatId,
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
  });
}

/**
 * Build the ordinary inbound submission a card's text becomes, anchored at
 * the card's own message. Every card-driven delivery goes through this —
 * an ask-user answer and an extension's forwarded card action alike — so the
 * address is always read from the card, never guessed or named by the caller.
 */
function cardSubmission(input: {
  target: FeishuTarget;
  cardMessageId: string;
  text: string;
  sourceId: string;
  attrs?: Readonly<Record<string, string>>;
}): FeishuChatSubmission {
  const { target, cardMessageId } = input;
  return {
    kind: 'chat',
    attrs: {
      // Same provenance the inbound envelope carries, in the same place: the
      // delivery arrives as a channel message and reads like one.
      source: 'feishu',
      chat_id: target.chatId,
      ...(target.threadId !== undefined ? { thread_id: target.threadId } : {}),
      message_id: cardMessageId,
      ...(input.attrs ?? {}),
    },
    text: input.text,
    reminder: CHANNEL_REMINDER,
    sourceId: input.sourceId,
    anchor: {
      chatId: target.chatId,
      // The card, never `sourceId`: this id is handed to Feishu as a COT
      // presentation's origin, and a synthetic one would be sent to the API
      // as if it were real.
      messageId: cardMessageId,
      target,
    },
  };
}

/**
 * Resolve where a card lives and deliver its text to whichever Team or
 * Dispatcher Agent owns that conversation, as an ordinary inbound submission.
 * The one mechanism both `deliverAskUserSettlement` and
 * `deliverExtensionForward` use — the address is always read from the card
 * via `readMessageRoute`, never guessed or named by the caller.
 */
async function deliverToCardOwner(
  h: SessionHandle,
  input: {
    cardMessageId: string;
    text: string;
    sourceId: string;
    attrs?: Readonly<Record<string, string>>;
  },
): Promise<{ target: FeishuTarget; outcome: FeishuSubmitOutcome }> {
  const route = await readMessageRoute(h, input.cardMessageId);
  const { target } = route;
  const outcome = await h.delivery.deliver({
    target,
    containerChatId: route.containerChatId,
    submission: cardSubmission({ target, ...input }),
  });
  return { target, outcome };
}

/**
 * Hand a settled ask-user round to Core as an ordinary inbound submission.
 *
 * The answer travels the path a typed reply travels, so nothing downstream has
 * to learn that a card produced it. A delivery that fails is logged and
 * dropped, exactly as the inbound path treats a message Core would not take:
 * re-delivering risks a second turn for one answer, and the user can say it
 * again. A card that cannot be located fails the same way, for the same reason.
 */
async function deliverAskUserSettlement(
  h: SessionHandle,
  settlement: AskUserSettlement,
): Promise<void> {
  const { cardMessageId } = settlement;
  try {
    if (cardMessageId === undefined) {
      throw new Error('the question card reported no message id');
    }
    const { target, outcome } = await deliverToCardOwner(h, {
      cardMessageId,
      text: settlement.text,
      sourceId: settlement.sourceId,
      attrs: {
        // Anyone in the chat may answer the card; this is deliberate, so
        // there is no check on who clicked. Carrying the clicker keeps the
        // fact the model would otherwise lose.
        ...(settlement.operatorOpenId !== undefined
          ? { sender_id: settlement.operatorOpenId }
          : {}),
        ask_user_request_id: settlement.requestId,
      },
    });
    // An `unsubmitted` (or `rejected`) outcome here means a `provision` plan
    // produced no recipient. Unlike the inbound chat path, this settlement
    // posts no in-place failure notice and takes no Dispatcher fallback: this
    // log line is the whole handling. A settled card answer is not a queued
    // human message awaiting delivery — handing it to a different recipient
    // would risk a second turn for one answer, and the human can send it again
    // as an ordinary message. `failed`, `ambiguous`, and `error` settle on the
    // same terms.
    log(h).info(
      {
        dispatcher_id: h.opts.dispatcherId,
        chat_id: target.chatId,
        ask_user_request_id: settlement.requestId,
        ask_user_outcome: settlement.outcome,
        status: outcome.status,
      },
      '[ask-user] answer delivered',
    );
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: cardMessageId,
        ask_user_request_id: settlement.requestId,
        err: errInfo(err),
      },
      '[ask-user] answer delivery failed',
    );
  }
}

/**
 * Hand an extension card action's forward to whichever Team or Dispatcher
 * Agent owns the card's conversation, as an ordinary inbound submission.
 *
 * The extension names what to say, never where: the card is the only address
 * it has, and Feishu re-derives the target from that card the same way an
 * ask-user answer does. A delivery that fails is logged and dropped, on the
 * same terms `deliverAskUserSettlement` drops one — a second attempt risks a
 * second turn for one click, and the failure is not the caller's to see: the
 * card callback already answered.
 */
async function deliverExtensionForward(
  h: SessionHandle,
  extensionName: string,
  cardMessageId: string | undefined,
  forward: FeishuExtensionForward,
): Promise<void> {
  try {
    if (cardMessageId === undefined) {
      throw new Error('the card reported no message id');
    }
    const { target, outcome } = await deliverToCardOwner(h, {
      cardMessageId,
      text: forward.text,
      sourceId: forward.sourceId,
      ...(forward.attrs !== undefined ? { attrs: forward.attrs } : {}),
    });
    const report = describeSubmitOutcome(outcome);
    const scope = { dispatcher_id: h.opts.dispatcherId, chat_id: target.chatId, feishu_extension: extensionName };
    log(h)[report.level]({ ...scope, ...report.fields }, EXTENSION_FORWARD_MESSAGES[report.kind]);
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: cardMessageId,
        feishu_extension: extensionName,
        err: errInfo(err),
      },
      '[extension] card forward delivery failed',
    );
  }
}

/** The extension-forward path's words for each outcome. The classification is shared. */
const EXTENSION_FORWARD_MESSAGES: SubmitOutcomeMessages = {
  submitted: '[extension] card forward delivered',
  not_admitted: '[extension] card forward was not admitted',
  rejected: '[extension] card forward was rejected before admission',
  ambiguous: '[extension] card forward admission was ambiguous',
  failed: '[extension] failed to deliver card forward',
};

/**
 * Send a question card and return the round's id.
 *
 * Nothing is awaited beyond the send. The click that answers arrives on the
 * card-action route, and the answer reaches Core as an inbound submission, so
 * the tool that called this is long finished by the time the user decides.
 *
 * `messageId` addresses the card the way `reply` addresses a message: the card
 * is sent as a reply to it, which is what puts it in that message's topic.
 * Without one the card is a new message in the chat, and in a topic group that
 * opens a topic of its own — right for a question that belongs to no particular
 * message, wrong for one that does. Where the answer goes is not decided here;
 * it is read back from the card that was actually sent.
 *
 * The round is put in play only once the card is really sent, so a send that
 * throws leaves no question behind and fails where the model can see it.
 */
export async function askUserQuestion(
  h: SessionHandle,
  input: {
    chatId: string;
    text?: string;
    questions: readonly AskUserQuestionSpec[];
    messageId?: string;
  },
): Promise<{ request_id: string }> {
  const opened = h.askUser.open(input);
  const sent = await sendCard(h, {
    target: {
      conversationId: input.chatId,
      ...(input.messageId !== undefined ? { replyTo: input.messageId } : {}),
    },
    card: opened.card,
    mode: 'inbound',
  });
  opened.activate(sent.messageIds[0]);
  return { request_id: opened.requestId };
}

/**
 * Close out a round that ran out of time.
 *
 * Both halves are best-effort and independent: the model is told there is no
 * answer, and the card is repainted so the user is not left looking at a
 * question that silently stopped working. A failed repaint must not cost the
 * model its notification, which is why the patch is awaited separately.
 */
export async function expireAskUserQuestion(
  h: SessionHandle,
  expiry: AskUserExpiry,
): Promise<void> {
  await deliverAskUserSettlement(h, expiry.settlement);
  const messageId = expiry.settlement.cardMessageId;
  if (messageId === undefined) return;
  try {
    await h.bot.editCard(messageId, expiry.card);
  } catch (err) {
    log(h).warn(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: messageId,
        ask_user_request_id: expiry.settlement.requestId,
        err: errInfo(err),
      },
      '[ask-user] expired card repaint failed',
    );
  }
}

/**
 * The card action this channel instance answers: an extension's claimed key
 * first, then the built-in pairing/ask-user handling below. An extension
 * action's `forward`, once its own callback answer is ready, is delivered the
 * same detached way `deliverAskUserSettlement` is.
 */
export async function handleCardAction(
  h: SessionHandle,
  event: FeishuCardActionEvent,
): Promise<FeishuCardActionResponse | Record<string, never>> {
  const key = String(event.actionValue[DREAMUX_ACTION_KEY] ?? '');
  const extension = h.extensionAction(key);
  if (extension !== undefined) {
    const { response, forward } = await extension.invoke(event);
    if (forward !== undefined) {
      void deliverExtensionForward(h, extension.extensionName, event.openMessageId, forward);
    }
    return response;
  }

  const applied = h.askUser.apply(event);
  if (applied.kind !== 'ignored') {
    if (applied.kind === 'settled') {
      // Detached deliberately. Feishu gives a card callback a few seconds
      // before it gives up and the click looks dead, and handing the answer to
      // Core means waking an agent — long enough to lose that window. Delivery
      // logs its own failure at error level and has nothing to report back
      // here anyway.
      void deliverAskUserSettlement(h, applied.settlement);
    }
    return applied.response;
  }

  if (key !== DREAMUX_PAIRING_CARD_ACTION) return {};

  const token = String(event.actionValue[DREAMUX_PAIRING_TOKEN_KEY] ?? '');
  if (!PAIRING_TOKEN_REGEX.test(token)) {
    return { toast: { type: 'error', content: '授权请求已失效或格式错误' } };
  }

  const operatorOpenId = event.operatorOpenId ?? '';
  if (operatorOpenId === '') {
    return { toast: { type: 'error', content: '身份解析失败：未获取到你的 open_id' } };
  }

  let ownerSet: Set<string>;
  try {
    const owner = await h.bot.resolveAppOwner();
    ownerSet = new Set(
      [
        owner.creatorOpenId,
        owner.ownerType === undefined ||
        owner.ownerType === FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER
          ? owner.ownerOpenId
          : undefined,
      ].filter((id): id is string => id !== undefined && id !== ''),
    );
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.opts.dispatcherId,
        ...openIdLogFields('operator_open_id', operatorOpenId),
        err: errInfo(err),
      },
      '[card-action] owner lookup failed',
    );
    return { toast: { type: 'error', content: 'Owner 校验失败，请稍后重试' } };
  }

  if (ownerSet.size === 0) {
    return {
      toast: {
        type: 'error',
        content: 'Owner 校验配置错误：未解析到 App Owner',
      },
    };
  }
  if (!ownerSet.has(operatorOpenId)) {
    return {
      toast: {
        type: 'error',
        content: '只有 App Owner 才有权限点击批准授权',
      },
    };
  }

  const result = await approvePairingByToken(
    {
      stateDir: h.opts.stateDir,
      accessMutex: h.accessMutex,
      dispatcherId: h.opts.dispatcherId,
      log: h.opts.log,
    },
    token,
  );
  if (result.status !== 'ok') {
    return {
      toast: {
        type: result.status === 'not_found' ? 'warning' : 'error',
        content: result.message,
      },
    };
  }

  const duplicate = result.details?.['duplicate'] === true;
  return rawCardActionResponse(
    buildPairingSuccessCard({ duplicate }),
    { type: 'success', content: result.message },
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Introduce ack (was `private sendIntroduceAck`)
// ─────────────────────────────────────────────────────────────────────────

export async function sendIntroduceAck(
  h: SessionHandle,
  event: FeishuInboundEvent,
  peers: PeerBot[],
): Promise<void> {
  const text = introduceAckText(peers);
  if (text === null) return;
  let result: { messageIds: string[] };
  try {
    result = await h.bot.send(
      channelOutboundToFeishuTarget({ conversationId: event.chatId }),
      text,
    );
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.opts.dispatcherId,
        chat_id: event.chatId,
        message_id: event.messageId,
        peer_count: peers.length,
        err: errInfo(err),
      },
      'introduce ack failed',
    );
    return;
  }
  log(h).info(
    {
      dispatcher_id: h.opts.dispatcherId,
      chat_id: event.chatId,
      message_id: event.messageId,
      peer_count: peers.length,
      message_ids: result.messageIds,
    },
    'introduce ack sent',
  );
}

// Inbound message handler moved to `feishu-session-inbound.ts` (keeps this
// file under the max-lines lint rule; onMessage alone is ~270 lines).
