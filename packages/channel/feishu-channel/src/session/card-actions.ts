/**
 * How this session answers a card click, and how a card's answer reaches
 * whoever owns the conversation it hangs under.
 *
 * A card click resolves to one of three payloads: an extension's own claimed
 * key, one of the ask-user answer keys, or the pairing-approval key. The first
 * two are answered only for a person the conversation's inbound access policy
 * admits, decided before either handler runs; the pairing key is the App
 * Owner's and is checked against the App Owner instead. None of them are this
 * session's routing decision — each ends by handing the click's answer text to
 * `deliver`, the same submission path an ordinary inbound message takes,
 * addressed at the card it was clicked on rather than at whatever chat the
 * click event names.
 */
import type { AskUserExpiry } from '../ask-user/registry.js';
import type { AskUserQuestionSpec } from '../cards/ask-user.js';
import type { FeishuInboundRouter } from '../inbound/router.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { errorInfo } from '@excitedjs/dreamux-utils';
import {
  FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
  type FeishuCardActionEvent,
} from '@excitedjs/feishu-transport';

import type { FeishuAccess } from '../access/index.js';
import type { GateInbound } from '../access/gate.js';
import { PAIRING_TOKEN_REGEX } from '../access/state.js';
import type {
  AskUserRegistry,
  AskUserSettlement,
} from '../ask-user/registry.js';
import type { FeishuBot } from '../bot.js';
import {
  DREAMUX_ACTION_KEY,
  DREAMUX_PAIRING_TOKEN_KEY,
  builtinCardAction,
} from '../card-actions.js';
import {
  buildPairingSuccessCard,
  rawCardActionResponse,
  type FeishuCardActionResponse,
} from '../cards/pairing.js';
import type { FeishuExtensionForward } from '../extension.js';
import type { FeishuSessionExtensions } from '../feishu-extensions.js';
import {
  chatSubmission,
  describeSubmitOutcome,
  type FeishuChatSubmission,
  type FeishuSubmitOutcome,
  type SubmitOutcomeMessages,
} from '../feishu-submit.js';
import type { FeishuInboundTargeting } from '../inbound/target.js';
import type { FeishuOutbound, FeishuSender } from '../outbound/index.js';
import type { FeishuTarget } from '../routing/target.js';

/** The card-action callback's own answer, or nothing for a key it does not own. */
export type FeishuCardActionResult =
  FeishuCardActionResponse | Record<string, never>;

/** The card-action-forward path's words for each outcome. The classification is shared. */
const EXTENSION_FORWARD_MESSAGES: SubmitOutcomeMessages = {
  submitted: '[extension] card forward delivered',
  not_admitted: '[extension] card forward was not admitted',
  rejected: '[extension] card forward was rejected before admission',
  ambiguous: '[extension] card forward admission was ambiguous',
  failed: '[extension] failed to deliver card forward',
};

function openIdLogFields(
  name: string,
  openId: string,
): Record<string, unknown> {
  return { [`${name}_len`]: openId.length };
}

/**
 * Build the ordinary inbound submission a card's text becomes, anchored at
 * the card's own message. Every card-driven delivery goes through this — an
 * ask-user answer and an extension's forwarded card action alike — so the
 * address is always read from the card, never guessed or named by the caller.
 */
function cardSubmission(input: {
  target: FeishuTarget;
  cardMessageId: string;
  text: string;
  sourceId: string;
  attrs?: Readonly<Record<string, string>> | undefined;
}): FeishuChatSubmission {
  const { target, cardMessageId } = input;
  return chatSubmission({
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
    sourceId: input.sourceId,
    anchor: {
      chatId: target.chatId,
      // The card, never `sourceId`: this id is handed to Feishu as a COT
      // presentation's origin, and a synthetic one would be sent to the API
      // as if it were real.
      messageId: cardMessageId,
      target,
    },
  });
}

export interface FeishuCardActionsOptions {
  readonly dispatcherId: string;
  readonly log: DreamuxLogger;
  readonly bot: FeishuBot;
  readonly access: FeishuAccess;
  readonly extensions: FeishuSessionExtensions;
  readonly askUser: AskUserRegistry;
  readonly targetRouter: FeishuInboundTargeting;
  readonly outbound: FeishuOutbound;
  readonly router: FeishuInboundRouter;
}

export class FeishuCardActions {
  constructor(private readonly opts: FeishuCardActionsOptions) {
    opts.askUser.events.on('expired', (expiry) => {
      void this.expireAskUserQuestion(expiry);
    });
  }

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
   * message, wrong for one that does. In a Collaboration Space chat that choice
   * is not the sender's to make, so the outbound address rule applies to the
   * card as it does to a reply. Where the answer goes is not decided here; it is
   * read back from the card that was actually sent.
   *
   * The round is put in play only once the card is really sent, so a send that
   * throws leaves no question behind and fails where the model can see it.
   */
  async askUserQuestion(input: {
    chatId: string;
    text?: string;
    questions: readonly AskUserQuestionSpec[];
    messageId?: string;
    sender: FeishuSender;
  }): Promise<{ request_id: string }> {
    const opened = this.opts.askUser.open(input);
    const sent = await this.opts.outbound.sendCard({
      target: {
        chatId: input.chatId,
        ...(input.messageId !== undefined
          ? { replyToMessageId: input.messageId }
          : {}),
      },
      sender: input.sender,
      card: opened.card,
      mode: 'inbound',
    });
    opened.activate(sent.messages[0]);
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
  private async expireAskUserQuestion(expiry: AskUserExpiry): Promise<void> {
    await this.deliverAskUserSettlement(expiry.settlement);
    const messageId = expiry.settlement.cardMessageId;
    if (messageId === undefined) return;
    try {
      await this.opts.bot.editCard(messageId, expiry.card);
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: messageId,
          ask_user_request_id: expiry.settlement.requestId,
          err: errorInfo(err),
        },
        '[ask-user] expired card repaint failed',
      );
    }
  }

  /**
   * The card action this channel instance answers: an extension's claimed key
   * first, then whichever built-in `card-actions.ts` says the key belongs to.
   * A key that is neither is answered with nothing — some other, unrelated
   * card. An extension action's `forward`, once its own callback answer is
   * ready, is delivered the same detached way an ask-user settlement is.
   *
   * An extension's handler and an ask-user answer both change something — a
   * round's state, whatever the handler does — so each is reached only after
   * `refuseUnadmitted` has passed the click. Pairing approval is not: the App
   * Owner who clicks it need not be admitted by the chat's policy, and is
   * checked as the App Owner instead.
   */
  async handle(event: FeishuCardActionEvent): Promise<FeishuCardActionResult> {
    const key = String(event.actionValue[DREAMUX_ACTION_KEY] ?? '');
    const extension = this.opts.extensions.action(key);
    if (extension !== undefined) {
      const refusal = await this.refuseUnadmitted(event);
      if (refusal !== undefined) return refusal;
      const { response, forward } = await extension.invoke(event);
      if (forward !== undefined) {
        void this.deliverExtensionForward(
          extension.extensionName,
          event.openMessageId,
          forward,
        );
      }
      return response;
    }

    switch (builtinCardAction(key)) {
      case 'ask_user':
        return this.handleAskUserCardAction(event);
      case 'pairing':
        return this.handlePairingCardAction(event);
      default:
        return {};
    }
  }

  /**
   * Hand a settled ask-user round to Core as an ordinary inbound submission.
   *
   * The answer travels the path a typed reply travels, so nothing downstream has
   * to learn that a card produced it. A delivery that fails is logged and
   * dropped, exactly as the inbound path treats a message Core would not take:
   * re-delivering risks a second turn for one answer, and the user can say it
   * again. A card that cannot be located fails the same way, for the same reason
   * — which is rare here: the round's own `activate()` already recorded where
   * its card landed, so this normally resolves without asking Feishu at all.
   */
  async deliverAskUserSettlement(settlement: AskUserSettlement): Promise<void> {
    const { cardMessageId } = settlement;
    try {
      if (cardMessageId === undefined) {
        throw new Error('the question card reported no message id');
      }
      const { target, outcome } = await this.deliverToCardOwner({
        cardMessageId,
        text: settlement.text,
        sourceId: settlement.sourceId,
        attrs: {
          // The click was admitted before it reached the round, so there is
          // nothing to check here. Carrying the clicker keeps the fact the
          // model would otherwise lose: which admitted person answered.
          ...(settlement.operatorOpenId !== undefined
            ? { sender_id: settlement.operatorOpenId }
            : {}),
          ask_user_request_id: settlement.requestId,
        },
        knownLanding:
          settlement.chatId !== undefined
            ? { chatId: settlement.chatId, threadId: settlement.threadId }
            : undefined,
      });
      // An `unsubmitted` (or `rejected`) outcome here means a `provision` plan
      // produced no recipient. Unlike the inbound chat path, this settlement
      // posts no in-place failure notice and takes no Dispatcher fallback: this
      // log line is the whole handling. A settled card answer is not a queued
      // human message awaiting delivery — handing it to a different recipient
      // would risk a second turn for one answer, and the human can send it again
      // as an ordinary message. `failed`, `ambiguous`, and `error` settle on the
      // same terms.
      this.opts.log.info(
        {
          dispatcher_id: this.opts.dispatcherId,
          chat_id: target.chatId,
          ask_user_request_id: settlement.requestId,
          ask_user_outcome: settlement.outcome,
          status: outcome.status,
        },
        '[ask-user] answer delivered',
      );
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: cardMessageId,
          ask_user_request_id: settlement.requestId,
          err: errorInfo(err),
        },
        '[ask-user] answer delivery failed',
      );
    }
  }

  private async handleAskUserCardAction(
    event: FeishuCardActionEvent,
  ): Promise<FeishuCardActionResult> {
    const refusal = await this.refuseUnadmitted(event);
    if (refusal !== undefined) return refusal;
    const applied = this.opts.askUser.apply(event);
    if (applied.kind === 'settled') {
      // Detached deliberately. Feishu gives a card callback a few seconds
      // before it gives up and the click looks dead, and handing the answer to
      // Core means waking an agent — long enough to lose that window. Delivery
      // logs its own failure at error level and has nothing to report back
      // here anyway.
      void this.deliverAskUserSettlement(applied.settlement);
    }
    return applied.response;
  }

  /**
   * The toast that refuses a click by someone the conversation's inbound policy
   * does not admit, or `undefined` when the click may go on.
   *
   * The decision is the access gate's own, over the same held state and the
   * same table an inbound message from this person would meet. Three facts stand
   * in for the message the gate is used to seeing. The person is the click's
   * operator, a human. The chat is the one the click names. The bot counts as
   * mentioned: a click on this bot's own card addresses it as directly as a
   * mention does, and requiring another one would refuse every click in a group
   * that asks for mentions.
   *
   * The gate reads a direct chat and a group differently, and the event says
   * which this is only by the chat's id, so the gate is asked for both kinds
   * and the kind is established only when the two answers differ. It comes
   * from the chat itself, never from the access lists the gate is judging:
   * the kind an inbound event in this chat reported, else Feishu. So a click in
   * a chat this session has routed an admitted message from needs no lookup and no permission
   * beyond the click itself. When the answer does
   * depend on the kind and none of those can say, the click is refused rather
   * than admitted on a guess, unlike topic detection, which degrades to an
   * ordinary group when the same read fails. Likewise when the operator or the
   * chat is missing from the event.
   */
  private async refuseUnadmitted(
    event: FeishuCardActionEvent,
  ): Promise<FeishuCardActionResponse | undefined> {
    const { operatorOpenId, openChatId } = event;
    if (operatorOpenId === undefined || openChatId === undefined) {
      return this.refuseUnconfirmed(event, false);
    }
    const facts: Omit<GateInbound, 'chat_type'> = {
      sender_id: operatorOpenId,
      chat_id: openChatId,
      is_bot_sender: false,
      trusted_bot: false,
      // A card callback reaches only the app that sent the card, so a click is
      // addressed to this bot as a mention is; `false` would refuse every
      // click in a group that requires mentions.
      bot_mentioned: true,
    };
    const asDirect = await this.opts.access.decide({
      ...facts,
      chat_type: 'p2p',
    });
    const asGroup = await this.opts.access.decide({
      ...facts,
      chat_type: 'group',
    });
    let decision = asDirect;
    let chatType: 'p2p' | 'group' | undefined;
    if ((asDirect.action === 'deliver') !== (asGroup.action === 'deliver')) {
      chatType = await this.opts.targetRouter.chatType(openChatId);
      if (chatType === undefined) return this.refuseUnconfirmed(event, true);
      decision = chatType === 'p2p' ? asDirect : asGroup;
    }
    if (decision.action === 'deliver') return undefined;
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: openChatId,
        ...(chatType !== undefined ? { chat_type: chatType } : {}),
        sender_id: operatorOpenId,
        message_id: event.openMessageId,
        reason:
          decision.action === 'drop' ? decision.reason : 'pairing_required',
      },
      '[card-action] click refused: sender not admitted by the access policy',
    );
    return {
      toast: { type: 'error', content: '你没有权限操作这张卡片' },
    };
  }

  /** A click the gate has nothing to decide on: the toast says what is missing. */
  private refuseUnconfirmed(
    event: FeishuCardActionEvent,
    kindNeeded: boolean,
  ): FeishuCardActionResponse {
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: event.openChatId,
        message_id: event.openMessageId,
        has_operator: event.operatorOpenId !== undefined,
        has_chat: event.openChatId !== undefined,
        chat_kind_needed: kindNeeded,
      },
      '[card-action] click refused: operator or chat kind could not be established (a chat kind lookup needs the bot to hold a group information read permission)',
    );
    return {
      toast: {
        type: 'error',
        content:
          '无法确认你的身份或所在会话的类型；若持续出现，请联系管理员检查机器人的群信息读取权限',
      },
    };
  }

  private async handlePairingCardAction(
    event: FeishuCardActionEvent,
  ): Promise<FeishuCardActionResult> {
    const token = String(event.actionValue[DREAMUX_PAIRING_TOKEN_KEY] ?? '');
    if (!PAIRING_TOKEN_REGEX.test(token)) {
      return { toast: { type: 'error', content: '授权请求已失效或格式错误' } };
    }

    const operatorOpenId = event.operatorOpenId ?? '';
    if (operatorOpenId === '') {
      return {
        toast: { type: 'error', content: '身份解析失败：未获取到你的 open_id' },
      };
    }

    let ownerSet: Set<string>;
    try {
      const owner = await this.opts.bot.resolveAppOwner();
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
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          ...openIdLogFields('operator_open_id', operatorOpenId),
          err: errorInfo(err),
        },
        '[card-action] owner lookup failed',
      );
      return {
        toast: { type: 'error', content: 'Owner 校验失败，请稍后重试' },
      };
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

    const result = await this.opts.access.approvePairingByToken(token);
    if (result.status !== 'ok') {
      return {
        toast: {
          type: result.status === 'not_found' ? 'warning' : 'error',
          content: result.message,
        },
      };
    }

    const duplicate = result.details?.['duplicate'] === true;
    return rawCardActionResponse(buildPairingSuccessCard({ duplicate }), {
      type: 'success',
      content: result.message,
    });
  }

  /**
   * Resolve where a card lives and deliver its text to whichever Team or
   * Dispatcher Agent owns that conversation, as an ordinary inbound submission.
   * The one mechanism both `deliverAskUserSettlement` and
   * `deliverExtensionForward` use.
   *
   * The address is read from the card, never guessed or named by the caller —
   * but "read from the card" costs a live `outbound.locate` round trip only when
   * nothing already knows where that card landed. An ask-user round's own card
   * names its `knownLanding` (recorded by `activate()` off the send response)
   * and skips it; `deliverExtensionForward`'s card, sent by code this session
   * does not own, never has one and always resolves live.
   */
  private async deliverToCardOwner(input: {
    cardMessageId: string;
    text: string;
    sourceId: string;
    attrs?: Readonly<Record<string, string>> | undefined;
    knownLanding?:
      { chatId: string; threadId?: string | undefined } | undefined;
  }): Promise<{ target: FeishuTarget; outcome: FeishuSubmitOutcome }> {
    const { knownLanding, ...submission } = input;
    const route =
      knownLanding !== undefined
        ? await this.opts.targetRouter.project(knownLanding)
        : await this.opts.outbound.locate(input.cardMessageId);
    const { target } = route;
    const outcome = await this.opts.router.deliver({
      target,
      containerChatId: route.containerChatId,
      submission: cardSubmission({ target, ...submission }),
    });
    return { target, outcome };
  }

  /**
   * Hand an extension card action's forward to whichever Team or Dispatcher
   * Agent owns the card's conversation, as an ordinary inbound submission.
   *
   * The extension names what to say, never where: the card is the only address
   * it has, so Feishu is always asked where that card landed (unlike an
   * ask-user answer, which usually already knows). A delivery that fails is
   * logged and dropped, on the same terms `deliverAskUserSettlement` drops one
   * — a second attempt risks a second turn for one click, and the failure is
   * not the caller's to see: the card callback already answered.
   */
  private async deliverExtensionForward(
    extensionName: string,
    cardMessageId: string | undefined,
    forward: FeishuExtensionForward,
  ): Promise<void> {
    try {
      if (cardMessageId === undefined) {
        throw new Error('the card reported no message id');
      }
      const { target, outcome } = await this.deliverToCardOwner({
        cardMessageId,
        text: forward.text,
        sourceId: forward.sourceId,
        attrs: forward.attrs,
      });
      const report = describeSubmitOutcome(outcome);
      const scope = {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: target.chatId,
        feishu_extension: extensionName,
      };
      this.opts.log[report.level](
        { ...scope, ...report.fields },
        EXTENSION_FORWARD_MESSAGES[report.kind],
      );
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: cardMessageId,
          feishu_extension: extensionName,
          err: errorInfo(err),
        },
        '[extension] card forward delivery failed',
      );
    }
  }
}
