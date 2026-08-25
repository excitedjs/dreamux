/**
 * Feishu channel session — the inbound message handler extracted from the
 * session class so sibling helper files stay under the max-lines lint rule.
 *
 * Owns the full onMessage flow: introduce/trusted-bot injection, the
 * two-lock access gate (LOCK-1 gate compute + LOCK-2 pair merge after send),
 * and the submitTurn delivery path. Primitive operations (reply, token
 * approval, introduce ack) live in `feishu-session-ops.ts`.
 */

import {
  isBotMentioned,
  isBotSenderType,
} from '@excitedjs/feishu-transport';
import type {
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
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
  PAIRING_TTL_MS,
  PAIRING_TOKEN_REGEX,
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
  type GateInbound,
  type PendingPairingEntry,
} from './feishu-gate.js';
import { buildPairingApprovalCard } from './feishu-pairing-card.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';
import {
  CHANNEL_REMINDER,
  sendIntroduceAck,
  sendCard,
  sendReply,
  type SessionHandle,
} from './feishu-session-ops.js';
import type {
  FeishuInboundEnvelope,
  FeishuInboundSubmitter,
} from './feishu-channel.js';

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
  submitter: FeishuInboundSubmitter,
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
  await deliverAcceptedMessage(h, event, submitter);
}

async function deliverAcceptedMessage(
  h: SessionHandle,
  acceptedEvent: FeishuInboundEvent,
  submitter: FeishuInboundSubmitter,
): Promise<void> {
  const work = createFeishuInboundWork(h.sessionFence);
  try {
    work.assertSessionActive();
    const route = await runFeishuInboundWork(
      work,
      () => h.targetRouter.projectInbound(acceptedEvent, work.signal),
    );
    work.assertSessionActive();
    const namedEvent = await enrichSenderName(h, acceptedEvent, work);
    const event = await enrichFeishuInbound(
      namedEvent,
      h.bot,
      work,
      log(h),
    );
    work.assertSessionActive();

    const baseline =
      event.chatType === 'group'
        ? await pendingBaseline(h.opts.stateDir, event.chatId)
        : null;
    const injectBots =
      baseline !== null && baseline.needsBaseline && baseline.trusted.length > 0;
    const formatted = await formatFeishuMessageForRuntime(
      event,
      {
        cacheDir: h.opts.attachmentCacheDir,
        resourceFetcher: h.bot,
        work,
        ...(injectBots ? { trustedBots: baseline.trusted } : {}),
      },
    );
    // Hand the runtime structured pieces, not pre-rendered XML. Append the
    // standing channel-reminder on its own line at the very end — goes into
    // `body` (rendered into the `<channel>` block) AND the neutral `text`
    // fallback so the reminder always reaches the model.
    const body = `${formatted.body}\n\n${CHANNEL_REMINDER}`;
    const input: InboundTurnInput = {
      sourceId: event.messageId,
      source: 'feishu',
      text: body,
      attrs: formatted.attrs,
      body,
      attachments: formatted.attachments.map((attachment) => ({
        kind: attachment.type,
        ...(attachment.name !== undefined ? { name: attachment.name } : {}),
        ...(attachment.path !== undefined ? { localPath: attachment.path } : {}),
      })),
    };
    const envelope: FeishuInboundEnvelope = {
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      chatId: event.chatId,
      chatType: event.chatType === 'group' ? 'group' : 'p2p',
      target: route.target,
      ...(route.container !== undefined ? { container: route.container } : {}),
      messageId: event.messageId,
    };
    work.assertSessionActive();
    let delivery: InboundDeliveryResult;
    try {
      delivery = await submitter.submitTurn(input, envelope);
    } catch (err) {
      // A rejected provider call cannot prove whether the native admission
      // boundary was crossed. Record terminal ambiguity; webhook replay must
      // never duplicate a possibly accepted input.
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log(h).error(
        {
          chat_id: event.chatId,
          sender_id: event.senderId,
          message_id: event.messageId,
          err: { message, stack },
        },
        'feishu inbound admission was ambiguous; not replaying',
      );
      return;
    }
    if (!work.isSessionActive()) {
      return;
    }
    if (delivery.status === 'submitted') {
      log(h).info(
        {
          chat_id: event.chatId,
          sender_id: event.senderId,
          message_id: event.messageId,
        },
        'feishu inbound submitted',
      );
      if (injectBots && baseline !== null && formatted.groupBotsRendered) {
        await clearBaselineIfCurrent(
          h.opts.stateDir,
          event.chatId,
          baseline.generation,
        );
      }
      return;
    }
    if (delivery.status === 'failed' || delivery.status === 'ambiguous') {
      const message =
        delivery.error instanceof Error
          ? delivery.error.message
          : String(delivery.error);
      const stack =
        delivery.error instanceof Error ? delivery.error.stack : undefined;
      log(h).error(
        {
          chat_id: event.chatId,
          message_id: event.messageId,
          err: { message, stack },
        },
        delivery.status === 'ambiguous'
          ? 'feishu inbound admission was ambiguous; not replaying'
          : 'failed to submit feishu inbound',
      );
    }
  } catch (error) {
    if (!isFeishuOperationError(error, 'aborted')) throw error;
  } finally {
    work.dispose();
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
