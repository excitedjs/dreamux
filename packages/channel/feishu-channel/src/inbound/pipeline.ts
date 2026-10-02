/**
 * Feishu channel session — the inbound message handler, owned by `inbound/`
 * rather than by `session/session.ts` because delivery is Core-facing and
 * transport-shaped (a `FeishuInboundEvent` in, a Command outcome out) while
 * the session class owns bot lifecycle and construction.
 *
 * Owns the full onMessage flow: introduce/trusted-bot injection, the
 * access decisions and send-before-save pairing IO, and the delivery path.
 * Access policy decides whether a message may be interpreted at all; routing then decides where the interpreted message goes,
 * and the two stay separate — an allowed message with no route is not
 * delivered anywhere. `FeishuInboundHandle` is this module's own narrow view
 * of the session — the collaborators an inbound event actually reaches, not
 * the session's full internal bag — so this file is written once against a
 * stable, self-describing parameter instead of a session-shaped grab bag.
 */

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { TransactionalStore } from '@excitedjs/dreamux-utils';
import {
  isBotMentioned,
  isBotSenderType,
  type FeishuInboundEvent,
  type FeishuSendResult,
} from '@excitedjs/feishu-transport';
import type { FeishuBot } from '../bot.js';
import { CHANNEL_SENDER, type FeishuOutbound } from '../outbound/index.js';
import type { FeishuLifecycle } from '../session/lifecycle.js';
import { formatFeishuMessageForRuntime } from './attachments.js';
import { isFeishuOperationError } from '../feishu-bounded-operation.js';
import { enrichFeishuInbound } from './enrich.js';
import {
  createFeishuInboundWork,
  runFeishuInboundWork,
  type FeishuInboundWorkContext,
} from './work.js';
import type { FeishuInboundTargeting } from './target.js';
import {
  clearBaselineIfCurrent,
  listChatBots,
  observeKnownBot,
  pendingBaseline,
  trustIntroducedBots,
  trustedBotIds,
  type ChatBotsState,
  type PeerBot,
} from '../chat-bots-store.js';
import {
  detectIntroduce,
  introduceAckText,
  introducedPeers,
} from '../introduce.js';
import {
  detectFeishuSlashCommand,
  type FeishuSlashCommandInvocation,
} from '../feishu-slash-commands.js';
import { PAIRING_TOKEN_REGEX } from '../access/state.js';
import type { GateInbound } from '../access/gate.js';
import type { FeishuAccess } from '../access/index.js';
import { buildPairingApprovalCard } from '../cards/pairing.js';
import {
  chatSubmission,
  describeSubmitOutcome,
  type FeishuChatSubmission,
  type FeishuInboundDelivery,
  type FeishuSubmitOutcome,
  type SubmitOutcomeMessages,
} from '../feishu-submit.js';
import type { FeishuTarget } from '../routing/target.js';

/**
 * The collaborators one accepted inbound event needs, and no more: this is
 * the narrow, inbound-owned replacement for the deleted `SessionHandle` bag
 * (which also carried `askUser`/`extensionAction`, neither ever read on this
 * path). `delivery` is the one seam back into `session/` — routing plan +
 * submission — that this module never bypasses with a concrete session
 * reference, so the dependency direction (inbound → session) stays one way.
 */
export interface FeishuInboundHandle {
  readonly log: DreamuxLogger;
  readonly dispatcherId: string;
  readonly attachmentCacheDir: string;
  readonly bot: FeishuBot;
  readonly access: FeishuAccess;
  readonly chatBotsStore: TransactionalStore<ChatBotsState>;
  readonly botDisplayName: string;
  readonly targetRouter: FeishuInboundTargeting;
  readonly outbound: FeishuOutbound;
  readonly lifecycle: FeishuLifecycle;
  readonly delivery: FeishuInboundDelivery;
}

const log = (h: FeishuInboundHandle): DreamuxLogger => h.log;
const FEISHU_USER_NAME_LOOKUP_TIMEOUT_MS = 2_000;

type ClassifiedInbound =
  | { chatType: 'p2p' | 'group'; senderKind: 'human' | 'bot' }
  | { reason: 'unsupported_chat_type' | 'sender_unknown' };

function classifyInbound(event: FeishuInboundEvent): ClassifiedInbound {
  if (event.chatType !== 'p2p' && event.chatType !== 'group') {
    return { reason: 'unsupported_chat_type' };
  }
  if (event.senderType === 'user' && event.senderId !== '') {
    return { chatType: event.chatType, senderKind: 'human' };
  }
  if (isBotSenderType(event.senderType) && event.senderId !== '') {
    return { chatType: event.chatType, senderKind: 'bot' };
  }
  return { reason: 'sender_unknown' };
}

function pairingTokenLogFields(token: string): Record<string, unknown> {
  return {
    pairing_token_len: PAIRING_TOKEN_REGEX.test(token) ? 6 : token.length,
  };
}

/**
 * Best-effort acknowledgement that `/introduce` trusted one or more peer
 * bots. Its only caller is `onMessage` below, and every fact it needs
 * (`outbound`, `log`, `dispatcherId`) is already on this module's own handle,
 * so it stays inbound-local rather than a session method reached back into.
 * It answers the `/introduce` message, so it replies to it: an unaddressed send
 * into a topic chat would open a topic of its own.
 */
async function sendIntroduceAck(
  h: FeishuInboundHandle,
  event: FeishuInboundEvent,
  peers: PeerBot[],
): Promise<void> {
  const text = introduceAckText(peers);
  if (text === null) return;
  let result: FeishuSendResult;
  try {
    result = await h.outbound.sendText({
      chatId: event.chatId,
      text,
      messageId: event.messageId,
      sender: CHANNEL_SENDER,
    });
  } catch (err) {
    log(h).error(
      {
        dispatcher_id: h.dispatcherId,
        chat_id: event.chatId,
        message_id: event.messageId,
        peer_count: peers.length,
        err:
          err instanceof Error
            ? { message: err.message, stack: err.stack }
            : { message: String(err) },
      },
      'introduce ack failed',
    );
    return;
  }
  log(h).info(
    {
      dispatcher_id: h.dispatcherId,
      chat_id: event.chatId,
      message_id: event.messageId,
      peer_count: peers.length,
      message_ids: result.messages.map((m) => m.messageId),
    },
    'introduce ack sent',
  );
}

export async function onMessage(
  h: FeishuInboundHandle,
  event: FeishuInboundEvent,
): Promise<void> {
  // Classify once at the raw Channel boundary. Unknown chat/sender shapes must
  // not be projected into the public gate's `is_bot_sender: false` human
  // precondition, nor reach passive observation, /introduce, or pairing.
  const classification = classifyInbound(event);
  if ('reason' in classification) {
    log(h).info(
      {
        chat_id: event.chatId,
        chat_type: event.chatType,
        sender_id: event.senderId,
        message_id: event.messageId,
        reason: classification.reason,
      },
      'feishu inbound dropped',
    );
    return;
  }

  const access = await h.access.inboundPolicy({
    chatType: classification.chatType,
    chatId: event.chatId,
    senderId: event.senderId,
  });

  if (
    classification.chatType === 'group' &&
    classification.senderKind === 'bot' &&
    access.observeBots
  ) {
    await observeKnownBot(h.chatBotsStore, event.chatId, {
      openId: event.senderId,
      ...(event.senderName !== '' ? { name: event.senderName } : {}),
    });
  }
  if (detectIntroduce(event.messageType, event.rawContent, event.mentions)) {
    const denyReason = access.introduceDenyReason;
    if (denyReason === null) {
      const peers: PeerBot[] = introducedPeers(event.mentions, h.bot.botOpenId);
      if (peers.length > 0) {
        await trustIntroducedBots(h.chatBotsStore, event.chatId, peers);
        await sendIntroduceAck(h, event, peers);
      }
      log(h).info(
        {
          chat_id: event.chatId,
          sender_id: event.senderId,
          trusted_peers: peers.length,
        },
        'introduce consumed',
      );
      return;
    }
    log(h).info(
      {
        chat_id: event.chatId,
        sender_id: event.senderId,
        message_id: event.messageId,
        reason: denyReason,
      },
      'introduce detected but not authorized',
    );
  }

  const trustedBots =
    classification.chatType === 'group'
      ? await trustedBotIds(h.chatBotsStore, event.chatId)
      : undefined;

  const senderIsBot = classification.senderKind === 'bot';
  const botMentioned = isBotMentioned(event.mentions, h.bot.botOpenId);
  const inbound: GateInbound = {
    chat_type: classification.chatType,
    sender_id: event.senderId,
    chat_id: event.chatId,
    is_bot_sender: senderIsBot,
    trusted_bot:
      senderIsBot && classification.chatType === 'group'
        ? (trustedBots?.has(event.senderId) ?? false)
        : false,
    bot_mentioned: botMentioned,
  };

  const action = await h.access.gate(inbound);

  if (action.action === 'drop') {
    log(h).info(
      {
        chat_id: event.chatId,
        chat_type: event.chatType,
        sender_id: event.senderId,
        ...(event.senderUnionId !== undefined && event.senderUnionId !== ''
          ? { sender_union_id: event.senderUnionId }
          : {}),
        message_id: event.messageId,
        reason: action.reason,
        context: action.context,
      },
      'feishu inbound dropped',
    );
    return;
  }

  if (action.action === 'pair') {
    const pairAction = action;
    if (pairAction.is_resend && pairAction.prompt_message_id !== undefined) {
      try {
        await h.outbound.sendText({
          chatId: inbound.chat_id,
          text:
            `<at user_id="${inbound.sender_id}"></at>\n` +
            '已有授权卡，请点击已发出的授权卡完成授权。\n' +
            'An approval card already exists. Please use the existing card to authorize access.',
          messageId: pairAction.prompt_message_id,
          sender: CHANNEL_SENDER,
        });
      } catch (err) {
        log(h).error(
          {
            err:
              err instanceof Error
                ? { message: err.message, stack: err.stack }
                : { message: String(err) },
            ...pairingTokenLogFields(pairAction.token),
            prompt_message_id: pairAction.prompt_message_id,
            kind: pairAction.kind,
            chat_id: inbound.chat_id,
          },
          '[feishu-pair] failed to reference existing pairing prompt',
        );
        return;
      }
      await h.access.refreshPairing(pairAction);
      return;
    }

    const card = buildPairingApprovalCard({
      token: pairAction.token,
      botDisplayName: h.botDisplayName,
      requesterOpenId: inbound.sender_id,
    });
    let sentCardMessageId: string | undefined;
    try {
      const sendResult = await h.outbound.sendCard({
        target: {
          chatId: inbound.chat_id,
          ...(event.messageId !== ''
            ? { replyToMessageId: event.messageId }
            : {}),
        },
        sender: CHANNEL_SENDER,
        card,
      });
      sentCardMessageId = sendResult.messages[0]?.messageId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log(h).error(
        {
          err: { message, stack },
          ...pairingTokenLogFields(pairAction.token),
          kind: pairAction.kind,
          chat_id: inbound.chat_id,
        },
        '[feishu-pair] failed to send pairing prompt, NOT saving pending entry',
      );
      return;
    }
    await h.access.recordPairingPrompt(inbound, pairAction, sentCardMessageId);
    return;
  }

  // deliver
  const command = detectFeishuSlashCommand({
    messageType: event.messageType,
    rawContent: event.rawContent,
    mentions: event.mentions,
    chatType: classification.chatType,
    botMentioned,
    senderKind: classification.senderKind,
  });
  await deliverAcceptedMessage(h, event, command);
}

async function deliverAcceptedMessage(
  h: FeishuInboundHandle,
  acceptedEvent: FeishuInboundEvent,
  command: FeishuSlashCommandInvocation | null,
): Promise<void> {
  const work = createFeishuInboundWork(h.lifecycle);
  try {
    work.assertSessionActive();
    const route = await runFeishuInboundWork(work, () =>
      h.targetRouter.projectInbound(acceptedEvent, work.signal),
    );
    work.assertSessionActive();
    await h.delivery.learnTopicRoot({
      target: route.target,
      messageId: acceptedEvent.messageId,
      rootId: acceptedEvent.rootId,
    });
    work.assertSessionActive();
    if (command !== null) {
      const reply = await h.delivery.command({
        command,
        target: route.target,
        containerChatId: route.containerChatId,
        messageId: acceptedEvent.messageId,
      });
      work.assertSessionActive();
      // Switch rather than an `else`: a reply kind this does not name must
      // fail to compile, not fall into whichever branch happens to be last.
      switch (reply.kind) {
        case 'text':
          await h.outbound.sendText({
            chatId: acceptedEvent.chatId,
            text: reply.text,
            messageId: acceptedEvent.messageId,
            sender: CHANNEL_SENDER,
          });
          break;
        case 'card':
          await h.outbound.sendCard({
            target: {
              chatId: acceptedEvent.chatId,
              replyToMessageId: acceptedEvent.messageId,
            },
            sender: CHANNEL_SENDER,
            card: reply.card,
            signal: work.signal,
          });
          break;
        case 'silent':
          break;
      }
      return;
    }
    const built = await buildSubmission(h, acceptedEvent, work, route.target);
    work.assertSessionActive();
    const outcome = await h.delivery.deliver({
      target: route.target,
      containerChatId: route.containerChatId,
      submission: built.submission,
    });

    if (!work.isSessionActive()) return;
    reportDelivery(h, acceptedEvent, outcome);
    if (outcome.status === 'unsubmitted' || outcome.status === 'rejected') {
      // A Collaboration Space run that never produced a Team, or a submission
      // the just-provisioned Team refused. No Dispatcher fallback: answer the
      // triggering message in place. The notice names no reason — the raw
      // failure text can carry this host's absolute state path, and the reason
      // is already on reportDelivery's log line.
      await h.outbound.sendText({
        chatId: acceptedEvent.chatId,
        text:
          'Could not start a Team for this conversation. ' +
          'The reason is in the Dreamux log.',
        messageId: acceptedEvent.messageId,
        sender: CHANNEL_SENDER,
      });
      return;
    }
    if (outcome.status === 'submitted' && built.clearBaseline !== null) {
      await built.clearBaseline();
    }
  } catch (error) {
    if (!isFeishuOperationError(error, 'aborted')) throw error;
  } finally {
    work.dispose();
  }
}

/**
 * Turn one accepted Feishu message into what Core is handed.
 *
 * Everything expensive lives here — sender lookup, attachment download,
 * group-bot baseline — and none of it decides anything: the pieces are
 * structured, never pre-rendered XML, because Core owns the provenance
 * envelope and renders the standing reminder as its final sibling.
 */
async function buildSubmission(
  h: FeishuInboundHandle,
  acceptedEvent: FeishuInboundEvent,
  work: FeishuInboundWorkContext,
  target: FeishuTarget,
): Promise<{
  submission: FeishuChatSubmission;
  clearBaseline: (() => Promise<void>) | null;
}> {
  const namedEvent = await enrichSenderName(h, acceptedEvent, work);
  const event = await enrichFeishuInbound(namedEvent, h.bot, work, log(h));
  work.assertSessionActive();
  const pending =
    event.chatType === 'group'
      ? await pendingBaseline(h.chatBotsStore, event.chatId)
      : null;
  const injectBots =
    pending !== null && pending.needsBaseline && pending.trusted.length > 0;
  const formatted = await formatFeishuMessageForRuntime(event, {
    cacheDir: h.attachmentCacheDir,
    resourceFetcher: h.bot,
    work,
    ...(injectBots ? { trustedBots: pending.trusted } : {}),
  });
  work.assertSessionActive();
  const clearBaseline =
    injectBots && pending !== null && formatted.groupBotsRendered
      ? async (): Promise<void> =>
          clearBaselineIfCurrent(
            h.chatBotsStore,
            event.chatId,
            pending.generation,
          )
      : null;
  return {
    submission: chatSubmission({
      attrs: Object.fromEntries(formatted.attrs),
      text: formatted.body,
      sourceId: event.messageId,
      anchor: {
        chatId: event.chatId,
        messageId: event.messageId,
        target,
      },
    }),
    clearBaseline,
  };
}

/**
 * What this Channel says about a message it accepted.
 *
 * Every non-provisioning plan is delivered to someone — a bound Team's
 * TeamLeader, or the Dispatcher Agent — so what is reported here is only how
 * Core answered, never whether the message found a recipient. A provisioning
 * run that produced no recipient is reported here with its reason; the caller
 * posts the fixed failure notice separately, without echoing that reason.
 */
function reportDelivery(
  h: FeishuInboundHandle,
  event: FeishuInboundEvent,
  outcome: FeishuSubmitOutcome,
): void {
  const scope = {
    dispatcher_id: h.dispatcherId,
    chat_id: event.chatId,
    sender_id: event.senderId,
    message_id: event.messageId,
  };
  const report = describeSubmitOutcome(outcome);
  log(h)[report.level](
    { ...scope, ...report.fields },
    INBOUND_DELIVERY_MESSAGES[report.kind],
  );
}

/** The chat path's words for each outcome. The classification is shared. */
const INBOUND_DELIVERY_MESSAGES: SubmitOutcomeMessages = {
  submitted: 'feishu inbound submitted',
  not_admitted: 'feishu inbound not admitted',
  rejected: 'feishu inbound was rejected before admission',
  ambiguous: 'feishu inbound admission was ambiguous; not replaying',
  failed: 'failed to submit feishu inbound',
};

async function enrichSenderName(
  h: FeishuInboundHandle,
  event: FeishuInboundEvent,
  work: FeishuInboundWorkContext,
): Promise<FeishuInboundEvent> {
  work.assertSessionActive();
  if (event.senderName !== '') return event;

  if (isBotSenderType(event.senderType)) {
    const listing = await listChatBots(h.chatBotsStore, event.chatId);
    work.assertSessionActive();
    const known = [...listing.trusted, ...listing.known].find(
      (bot) => bot.openId === event.senderId && bot.name !== undefined,
    );
    return known?.name === undefined
      ? event
      : { ...event, senderName: known.name };
  }

  if (event.senderId === '' || h.bot.resolveUserName === undefined)
    return event;
  const remaining = work.remainingTimeMs();
  if (remaining === 0) return event;
  try {
    const name = await runFeishuInboundWork(
      work,
      () =>
        h.bot.resolveUserName?.(event.senderId) ?? Promise.resolve(undefined),
      Date.now() + Math.min(FEISHU_USER_NAME_LOOKUP_TIMEOUT_MS, remaining),
    );
    return name === undefined || name === ''
      ? event
      : { ...event, senderName: name };
  } catch (error) {
    if (isFeishuOperationError(error, 'aborted')) throw error;
    return event;
  }
}
