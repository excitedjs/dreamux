/**
 * Feishu channel session — the inbound message handler extracted from the
 * session class so sibling helper files stay under the max-lines lint rule.
 *
 * Owns the full onMessage flow: introduce/trusted-bot injection, the
 * two-lock access gate (LOCK-1 gate compute + LOCK-2 pair merge after send),
 * and the delivery path. Access policy decides whether a message may be
 * interpreted at all; routing then decides where the interpreted message goes,
 * and the two stay separate — an allowed message with no route is not
 * delivered anywhere. Primitive operations (reply, token approval, introduce
 * ack) live in `feishu-session-ops.ts`.
 */

import {
  isBotMentioned,
  isBotSenderType,
} from '@excitedjs/feishu-transport';
import type { FeishuInboundEvent } from './bot.js';
import { formatFeishuMessageForRuntime } from './feishu-message.js';
import { isFeishuOperationError } from './feishu-bounded-operation.js';
import { enrichFeishuInbound } from './feishu-inbound-enrichment.js';
import {
  createFeishuInboundWork,
  runFeishuInboundWork,
  type FeishuInboundWorkContext,
} from './feishu-inbound-work.js';
import {
  clearBaselineIfCurrent,
  listChatBots,
  observeKnownBot,
  pendingBaseline,
  trustIntroducedBots,
  trustedBotIds,
  type PeerBot,
} from './chat-bots-store.js';
import {
  detectIntroduce,
  introduceDenyReason,
  introducedPeers,
} from './introduce.js';
import {
  detectFeishuSlashCommand,
  type FeishuSlashCommand,
} from './feishu-slash-commands.js';
import {
  PAIRING_TTL_MS,
  PAIRING_TOKEN_REGEX,
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
  type GateInbound,
  type PendingPairingEntry,
} from './feishu-gate.js';
import { buildPairingApprovalCard } from './feishu-pairing-card.js';
import {
  sendIntroduceAck,
  sendCard,
  sendReply,
  type SessionHandle,
} from './feishu-session-ops.js';
import {
  CHANNEL_REMINDER,
  type FeishuSubmitOutcome,
  type FeishuSubmission,
} from './feishu-submit.js';
import type { FeishuTarget } from './routing/target.js';

const log = (h: SessionHandle) => h.opts.log;
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
  return { pairing_token_len: PAIRING_TOKEN_REGEX.test(token) ? 6 : token.length };
}

export async function onMessage(
  h: SessionHandle,
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

  const access = await h.accessMutex.lock(async () =>
    loadDispatcherAccess(h.opts.stateDir),
  );

  if (
    classification.chatType === 'group' &&
    classification.senderKind === 'bot' &&
    access.group.allow_chats.includes(event.chatId)
  ) {
    await observeKnownBot(h.opts.stateDir, event.chatId, {
      openId: event.senderId,
      ...(event.senderName !== '' ? { name: event.senderName } : {}),
    });
  }
  if (detectIntroduce(event.messageType, event.rawContent, event.mentions)) {
    const denyReason = introduceDenyReason(access, {
      chatType: classification.chatType,
      chatId: event.chatId,
      senderId: event.senderId,
    });
    if (denyReason === null) {
      const peers: PeerBot[] = introducedPeers(event.mentions, h.bot.botOpenId);
      if (peers.length > 0) {
        await trustIntroducedBots(h.opts.stateDir, event.chatId, peers);
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
      ? await trustedBotIds(h.opts.stateDir, event.chatId)
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
        ? trustedBots?.has(event.senderId) ?? false
        : false,
    bot_mentioned: botMentioned,
  };

  // LOCK-1: compute gate; save for deliver/drop; for pair we do send-before-save.
  const lock1 = await h.accessMutex.lock(async () => {
    const fresh = await loadDispatcherAccess(h.opts.stateDir);
    const result = dreamuxFeishuGate(fresh, inbound);
    if (result.action.action !== 'pair') {
      await saveDispatcherAccess(h.opts.stateDir, result.nextState);
    }
    return result;
  });

  const action = lock1.action;
  for (const l of lock1.logs) {
    if (l.level === 'error') {
      log(h).error(l.ctx ?? {}, `[feishu-gate] ${l.msg}`);
    } else if (l.level === 'warn') {
      log(h).warn(l.ctx ?? {}, `[feishu-gate] ${l.msg}`);
    } else {
      log(h).debug(l.ctx ?? {}, `[feishu-gate] ${l.msg}`);
    }
  }

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
        ...(action.context !== undefined ? { context: action.context } : {}),
      },
      'feishu inbound dropped',
    );
    return;
  }

  if (action.action === 'pair') {
    if (action.is_resend && action.prompt_message_id !== undefined) {
      try {
        await sendReply(h, {
          chatId: inbound.chat_id,
          text:
            '已有授权卡，请点击已发出的授权卡完成授权。\n' +
            'An approval card already exists. Please use the existing card to authorize access.',
          messageId: action.prompt_message_id,
          mentionUserIds: [inbound.sender_id],
        });
      } catch (err) {
        log(h).error(
          {
            err: err instanceof Error
              ? { message: err.message, stack: err.stack }
              : { message: String(err) },
            ...pairingTokenLogFields(action.token),
            prompt_message_id: action.prompt_message_id,
            kind: action.kind,
            chat_id: inbound.chat_id,
          },
          '[feishu-pair] failed to reference existing pairing prompt',
        );
        return;
      }
      await h.accessMutex.lock(async () => {
        const latest = await loadDispatcherAccess(h.opts.stateDir);
        const existing = latest.pending[action.token];
        if (existing === undefined) return;
        await saveDispatcherAccess(h.opts.stateDir, {
          ...latest,
          pending: {
            ...latest.pending,
            [action.token]: {
              ...existing,
              expires_at: Date.now() + PAIRING_TTL_MS,
              prompt_message_id: existing.prompt_message_id ?? action.prompt_message_id,
            },
          },
        });
      });
      return;
    }

    const card = buildPairingApprovalCard({
      token: action.token,
      botDisplayName: h.botDisplayName,
      requesterOpenId: inbound.sender_id,
    });
    let sentCardMessageId: string | undefined;
    try {
      const sendResult = await sendCard(h, {
        target: {
          conversationId: inbound.chat_id,
          ...(event.messageId !== '' ? { replyTo: event.messageId } : {}),
        },
        card,
      });
      sentCardMessageId = sendResult.messageIds[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log(h).error(
        {
          err: { message, stack },
          ...pairingTokenLogFields(action.token),
          kind: action.kind,
          chat_id: inbound.chat_id,
        },
        '[feishu-pair] failed to send pairing prompt, NOT saving pending entry',
      );
      return;
    }
    // LOCK-2: merge against latest state (concurrent approval / resend window)
    await h.accessMutex.lock(async () => {
      const latest = await loadDispatcherAccess(h.opts.stateDir);
      // Approved mid-window? Skip entirely.
      if (action.kind === 'dm' && latest.allow_users.includes(inbound.sender_id)) {
        return;
      }
      if (
        action.kind === 'group' &&
        latest.group.allow_chats.includes(inbound.chat_id)
      ) {
        return;
      }
      // Another same-key pending entry exists? For a resend from an older
      // entry without a prompt message id, attach the newly-sent card id and
      // refresh the TTL. Otherwise do not clobber a concurrent sender's
      // already-recorded token.
      const existingKey = Object.entries(latest.pending).find(([, e]) => {
        if (action.kind === 'dm') {
          return e.kind === 'dm' && e.sender_id === inbound.sender_id;
        }
        return e.kind === 'group' && e.chat_id === inbound.chat_id;
      });
      if (existingKey !== undefined) {
        if (!action.is_resend) return;
        const [token, existing] = existingKey;
        const bumped: PendingPairingEntry = {
          ...existing,
          expires_at: Date.now() + PAIRING_TTL_MS,
          ...(existing.prompt_message_id !== undefined || sentCardMessageId !== undefined
            ? { prompt_message_id: existing.prompt_message_id ?? sentCardMessageId }
            : {}),
        };
        await saveDispatcherAccess(h.opts.stateDir, {
          ...latest,
          pending: { ...latest.pending, [token]: bumped },
        });
        return;
      }
      // Merge with fresh TTL (send succeeded right now).
      const entry: PendingPairingEntry = {
        kind: action.kind,
        sender_id: inbound.sender_id,
        chat_id: inbound.chat_id,
        created_at: Date.now(),
        expires_at: Date.now() + PAIRING_TTL_MS,
        replies: 1,
        ...(sentCardMessageId !== undefined
          ? { prompt_message_id: sentCardMessageId }
          : {}),
      };
      const merged = {
        ...latest,
        pending: { ...latest.pending, [action.token]: entry },
      };
      await saveDispatcherAccess(h.opts.stateDir, merged);
    });
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
  h: SessionHandle,
  acceptedEvent: FeishuInboundEvent,
  command: FeishuSlashCommand | null,
): Promise<void> {
  const work = createFeishuInboundWork(h.sessionFence);
  try {
    work.assertSessionActive();
    const route = await runFeishuInboundWork(
      work,
      () => h.targetRouter.projectInbound(acceptedEvent, work.signal),
    );
    work.assertSessionActive();
    if (command !== null) {
      const reply = await h.delivery.command({
        command,
        target: route.target,
        containerChatId: route.containerChatId,
      });
      work.assertSessionActive();
      if (reply.kind === 'text') {
        await sendReply(h, {
          chatId: acceptedEvent.chatId,
          text: reply.text,
          messageId: acceptedEvent.messageId,
        });
      } else {
        await sendCard(h, {
          target: {
            conversationId: acceptedEvent.chatId,
            replyTo: acceptedEvent.messageId,
          },
          card: reply.card,
          signal: work.signal,
        });
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
  h: SessionHandle,
  acceptedEvent: FeishuInboundEvent,
  work: FeishuInboundWorkContext,
  target: FeishuTarget,
): Promise<{
  submission: FeishuSubmission;
  clearBaseline: (() => Promise<void>) | null;
}> {
  const namedEvent = await enrichSenderName(h, acceptedEvent, work);
  const event = await enrichFeishuInbound(namedEvent, h.bot, work, log(h));
  work.assertSessionActive();
  const pending = event.chatType === 'group'
    ? await pendingBaseline(h.opts.stateDir, event.chatId)
    : null;
  const injectBots = pending !== null &&
    pending.needsBaseline &&
    pending.trusted.length > 0;
  const formatted = await formatFeishuMessageForRuntime(event, {
    cacheDir: h.opts.attachmentCacheDir,
    resourceFetcher: h.bot,
    work,
    ...(injectBots ? { trustedBots: pending.trusted } : {}),
  });
  work.assertSessionActive();
  const clearBaseline =
    injectBots && pending !== null && formatted.groupBotsRendered
      ? async (): Promise<void> => clearBaselineIfCurrent(
          h.opts.stateDir,
          event.chatId,
          pending.generation,
        )
      : null;
  return {
    submission: {
      attrs: Object.fromEntries(formatted.attrs),
      text: formatted.body,
      reminder: CHANNEL_REMINDER,
      sourceId: event.messageId,
      anchor: {
        chatId: event.chatId,
        messageId: event.messageId,
        target,
      },
    },
    clearBaseline,
  };
}

/**
 * What this Channel says about a message it accepted.
 *
 * Every accepted message is delivered to someone — a bound Team's TeamLeader,
 * or the Dispatcher Agent — so what is reported here is only how Core
 * answered, never whether the message found a recipient.
 */
function reportDelivery(
  h: SessionHandle,
  event: FeishuInboundEvent,
  outcome: FeishuSubmitOutcome,
): void {
  const scope = {
    dispatcher_id: h.opts.dispatcherId,
    chat_id: event.chatId,
    sender_id: event.senderId,
    message_id: event.messageId,
  };
  switch (outcome.status) {
    case 'submitted':
      log(h).info(
        { ...scope, turn_id: outcome.turnId },
        'feishu inbound submitted',
      );
      return;
    case 'duplicate':
    case 'stopped':
      log(h).info(
        { ...scope, status: outcome.status },
        'feishu inbound not admitted',
      );
      return;
    case 'rejected':
      log(h).warn(
        { ...scope, code: outcome.code, err: { message: outcome.message } },
        'feishu inbound was rejected before admission',
      );
      return;
    case 'ambiguous':
      log(h).error(
        { ...scope, err: { message: outcome.error?.message ?? 'unknown' } },
        'feishu inbound admission was ambiguous; not replaying',
      );
      return;
    case 'failed':
      log(h).error(
        { ...scope, err: { message: outcome.error?.message ?? 'unknown' } },
        'failed to submit feishu inbound',
      );
      return;
    default:
      log(h).error(
        { ...scope, err: { message: outcome.message } },
        'failed to submit feishu inbound',
      );
  }
}

async function enrichSenderName(
  h: SessionHandle,
  event: FeishuInboundEvent,
  work: FeishuInboundWorkContext,
): Promise<FeishuInboundEvent> {
  work.assertSessionActive();
  if (event.senderName !== '') return event;

  if (isBotSenderType(event.senderType)) {
    const listing = await listChatBots(h.opts.stateDir, event.chatId);
    work.assertSessionActive();
    const known = [...listing.trusted, ...listing.known].find(
      (bot) => bot.openId === event.senderId && bot.name !== undefined,
    );
    return known?.name === undefined ? event : { ...event, senderName: known.name };
  }

  if (event.senderId === '' || h.bot.resolveUserName === undefined) return event;
  const remaining = work.remainingTimeMs();
  if (remaining === 0) return event;
  try {
    const name = await runFeishuInboundWork(
      work,
      () => h.bot.resolveUserName?.(event.senderId) ?? Promise.resolve(undefined),
      Date.now() + Math.min(FEISHU_USER_NAME_LOOKUP_TIMEOUT_MS, remaining),
    );
    return name === undefined || name === '' ? event : { ...event, senderName: name };
  } catch (error) {
    if (isFeishuOperationError(error, 'aborted')) throw error;
    return event;
  }
}
