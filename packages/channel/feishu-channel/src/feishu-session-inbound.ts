/**
 * Feishu channel session — the inbound message handler extracted from the
 * session class so sibling helper files stay under the max-lines lint rule.
 *
 * Owns the full onMessage flow: introduce/trusted-bot injection, the
 * two-lock access gate (LOCK-1 gate compute + LOCK-2 pair merge after send),
 * and the submitTurn delivery path. Primitive operations (reply/reaction
 * ledger, approve-by-code, introduce ack) live in `feishu-session-ops.ts`.
 */

import { isBotMentioned, isBotSenderType } from '@excitedjs/feishu-transport';
import type {
  AgentRuntimeTurnResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import type { FeishuInboundEvent } from './bot.js';
import { formatFeishuMessageForRuntime } from './feishu-message.js';
import {
  clearBaselineIfCurrent,
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
  dreamuxFeishuGate,
  loadDispatcherAccess,
  renderPairingPrompt,
  saveDispatcherAccess,
  type GateInbound,
  type PendingPairingEntry,
} from './feishu-gate.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';
import {
  CHANNEL_REMINDER,
  sendIntroduceAck,
  sendReply,
  setInboundReaction,
  type SessionHandle,
} from './feishu-session-ops.js';
import {
  IN_PROGRESS_REACTION_EMOJI,
  RECEIVED_REACTION_EMOJI,
  type FeishuInboundEnvelope,
  type FeishuInboundSubmitter,
} from './feishu-channel.js';

const log = (h: SessionHandle) => h.opts.log;

export async function onMessage(
  h: SessionHandle,
  event: FeishuInboundEvent,
  submitter: FeishuInboundSubmitter,
): Promise<void> {
  const access = await h.accessMutex.lock(async () =>
    loadDispatcherAccess(h.opts.stateDir),
  );

  if (
    event.chatType === 'group' &&
    isBotSenderType(event.senderType) &&
    access.group.allow_chats.includes(event.chatId)
  ) {
    await observeKnownBot(h.opts.stateDir, event.chatId, {
      openId: event.senderId,
      ...(event.senderName !== '' ? { name: event.senderName } : {}),
    });
  }
  if (detectIntroduce(event.messageType, event.rawContent, event.mentions)) {
    const denyReason = introduceDenyReason(access, {
      chatType: event.chatType,
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
    event.chatType === 'group'
      ? await trustedBotIds(h.opts.stateDir, event.chatId)
      : undefined;

  const senderIsBot = isBotSenderType(event.senderType);
  const botMentioned = isBotMentioned(event.mentions, h.bot.botOpenId);
  const chatType: 'p2p' | 'group' = event.chatType === 'p2p' ? 'p2p' : 'group';
  const inbound: GateInbound = {
    chat_type: chatType,
    sender_id: event.senderId,
    chat_id: event.chatId,
    is_bot_sender: senderIsBot,
    trusted_bot:
      senderIsBot && event.chatType === 'group'
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
    const text = renderPairingPrompt(
      action.kind,
      action.code,
      action.is_resend,
      h.botDisplayName,
    );
    try {
      await sendReply(h, {
        chatId: inbound.chat_id,
        text,
        ...(event.messageId !== '' ? { messageId: event.messageId } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log(h).error(
        {
          err: { message, stack },
          code: action.code,
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
      // Another same-key pending entry exists? Don't clobber.
      const existingKey = Object.entries(latest.pending).find(([, e]) => {
        if (action.kind === 'dm') {
          return e.kind === 'dm' && e.sender_id === inbound.sender_id;
        }
        return e.kind === 'group' && e.chat_id === inbound.chat_id;
      });
      if (existingKey !== undefined) return;
      // Merge with fresh TTL (send succeeded right now).
      const entry: PendingPairingEntry = {
        kind: action.kind,
        sender_id: inbound.sender_id,
        chat_id: inbound.chat_id,
        created_at: Date.now(),
        expires_at: Date.now() + PAIRING_TTL_MS,
        replies: action.is_resend ? 2 : 1,
      };
      const merged = {
        ...latest,
        pending: { ...latest.pending, [action.code]: entry },
      };
      await saveDispatcherAccess(h.opts.stateDir, merged);
    });
    return;
  }

  // deliver
  h.state.messageChats.set(event.messageId, event.chatId);

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
    messageId: event.messageId,
  };
  const delivery: AgentRuntimeTurnResult = await submitter.submitTurn(
    input,
    envelope,
    {
      onAccepted: async () => {
        await setInboundReaction(
          h,
          event.messageId,
          event.chatId,
          RECEIVED_REACTION_EMOJI,
          'received',
        );
      },
    },
  );
  if (delivery.status === 'submitted') {
    log(h).info(
      {
        chat_id: event.chatId,
        sender_id: event.senderId,
        message_id: event.messageId,
      },
      'feishu inbound submitted',
    );
    if (injectBots && baseline !== null) {
      await clearBaselineIfCurrent(
        h.opts.stateDir,
        event.chatId,
        baseline.generation,
      );
    }
    await setInboundReaction(
      h,
      event.messageId,
      event.chatId,
      IN_PROGRESS_REACTION_EMOJI,
      'in_progress',
    );
  } else if (delivery.status === 'failed') {
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
      'failed to submit feishu inbound',
    );
  }
}
