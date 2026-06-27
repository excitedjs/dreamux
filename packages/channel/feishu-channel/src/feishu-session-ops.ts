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
import type { FeishuBot, FeishuInboundEvent } from './bot.js';
import { channelOutboundToFeishuTarget } from './bot.js';
import { introduceAckText } from './introduce.js';
import {
  loadDispatcherAccess,
  saveDispatcherAccess,
  type DispatcherAccessState,
} from './feishu-gate.js';
import { AsyncMutex } from './lib/mutex.js';
import type { FeishuToolResultEnvelope } from './feishu-mcp-tools.js';
import type { FeishuChannelSessionOptions } from './feishu-channel.js';
import type { PeerBot } from './chat-bots-store.js';

// ─────────────────────────────────────────────────────────────────────────
// In-memory state & constants (mirror the class fields)
// ─────────────────────────────────────────────────────────────────────────

export const MAX_PENDING_RECEIVED_REACTION_CLEARS = 1024;

/**
 * Appended to every delivered inbound's content as a standing guardrail: a
 * channel message must be answered with the channel reply tool, not a plain
 * assistant message. English to match the other model-facing strings in this
 * layer (`FEISHU_SKILL_FALLBACK_NOTE`, the `<group_bots>` note). Placed at the
 * very end of the body the runtime wraps into its `<channel>` block.
 */
export const CHANNEL_REMINDER =
  '<channel-reminder>A message from this channel must be answered with the channel reply tool, not a plain assistant message. Acknowledge it with a brief reply through that tool first, then start the work.</channel-reminder>';

export type InboundReactionState = 'received' | 'in_progress';

export interface InboundReactionLedgerEntry {
  chatId: string;
  reactionId: string;
  state: InboundReactionState;
}

export interface FeishuChannelState {
  inboundReactions: Map<string, InboundReactionLedgerEntry>;
  pendingReceivedReactionClears: Set<string>;
  messageChats: Map<string, string>;
}

/** Opaque resource bundle a session builds for each helper call. */
export interface SessionHandle {
  opts: FeishuChannelSessionOptions;
  state: FeishuChannelState;
  bot: FeishuBot;
  accessMutex: AsyncMutex;
  botDisplayName: string;
}

/** Build a package-private handle from a session's internal fields. */
export function sessionHandle(
  opts: FeishuChannelSessionOptions,
  state: FeishuChannelState,
  bot: FeishuBot,
  accessMutex: AsyncMutex,
  botDisplayName: string,
): SessionHandle {
  return { opts, state, bot, accessMutex, botDisplayName };
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

// ─────────────────────────────────────────────────────────────────────────
// Reply + reaction primitives (were `private sendReply` / `addReaction`)
// ─────────────────────────────────────────────────────────────────────────

export async function sendReply(
  h: SessionHandle,
  input: { chatId: string; text: string; messageId?: string; mentionUserIds?: string[] },
): Promise<{ messageIds: string[] }> {
  let result: { messageIds: string[] };
  try {
    result = await h.bot.send(
      channelOutboundToFeishuTarget({
        conversationId: input.chatId,
        ...(input.messageId !== undefined ? { replyTo: input.messageId } : {}),
        ...(input.mentionUserIds !== undefined
          ? { mentionUsers: input.mentionUserIds }
          : {}),
      }),
      input.text,
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
      mention_count: input.mentionUserIds?.length ?? 0,
      message_ids: result.messageIds,
    },
    'feishu message sent',
  );
  if (input.messageId !== undefined) {
    await clearInboundReaction(h, input.messageId);
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

// ─────────────────────────────────────────────────────────────────────────
// Inbound reaction ledger (were `private setInboundReaction` etc.)
// ─────────────────────────────────────────────────────────────────────────

export async function setInboundReaction(
  h: SessionHandle,
  messageId: string,
  chatId: string,
  emoji: string,
  state: InboundReactionState,
): Promise<void> {
  if (messageId === '') return;
  if (h.state.pendingReceivedReactionClears.has(messageId)) return;

  const previous = h.state.inboundReactions.get(messageId);
  let reactionId: string;
  try {
    reactionId = await h.bot.addReaction(messageId, emoji);
  } catch (err) {
    log(h).warn(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: messageId,
        err: errInfo(err),
      },
      `failed to add the ${state} reaction`,
    );
    return;
  }
  if (reactionId === '') {
    log(h).warn(
      { dispatcher_id: h.opts.dispatcherId, message_id: messageId },
      `Feishu returned no reaction_id for the ${state} reaction`,
    );
    return;
  }

  if (h.state.pendingReceivedReactionClears.has(messageId)) {
    try {
      await h.bot.removeReaction(messageId, reactionId);
    } catch (err) {
      log(h).warn(
        {
          dispatcher_id: h.opts.dispatcherId,
          message_id: messageId,
          err: errInfo(err),
        },
        `failed to clear the late ${state} reaction`,
      );
    }
    return;
  }

  h.state.inboundReactions.set(messageId, { chatId, reactionId, state });

  if (previous !== undefined) {
    try {
      await h.bot.removeReaction(messageId, previous.reactionId);
    } catch (err) {
      log(h).warn(
        {
          dispatcher_id: h.opts.dispatcherId,
          message_id: messageId,
          err: errInfo(err),
        },
        `failed to replace the ${previous.state} reaction`,
      );
    }
  }
}

export async function clearInboundReaction(
  h: SessionHandle,
  messageId: string,
): Promise<void> {
  rememberPendingReceivedReactionClear(h, messageId);
  const reaction = h.state.inboundReactions.get(messageId);
  if (reaction === undefined) return;
  try {
    await h.bot.removeReaction(messageId, reaction.reactionId);
    h.state.inboundReactions.delete(messageId);
  } catch (err) {
    log(h).warn(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: messageId,
        err: errInfo(err),
      },
      `failed to clear the ${reaction.state} reaction`,
    );
  }
}

export function rememberPendingReceivedReactionClear(
  h: SessionHandle,
  messageId: string,
): void {
  h.state.pendingReceivedReactionClears.add(messageId);
  while (
    h.state.pendingReceivedReactionClears.size > MAX_PENDING_RECEIVED_REACTION_CLEARS
  ) {
    const oldest = h.state.pendingReceivedReactionClears.values().next().value;
    if (typeof oldest !== 'string') return;
    h.state.pendingReceivedReactionClears.delete(oldest);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Approve pairing by code (was the class method of the same name)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Approve a pending pairing by its 6-hex code.
 *
 * Behavior:
 *   - Normalizes `code` to lowercase (the gate stores lowercased codes).
 *   - Returns `not_found` when the code is unknown or expired (we reject
 *     expired entries explicitly, not just "not found", so the operator
 *     gets the right diagnostic).
 *   - Adds the DM sender / group chat to the allowlists. Idempotent on
 *     allowlist membership (we detect duplicates via allowlist presence,
 *     not by whether the pending entry still has the slot), and always
 *     removes the pending key after a successful approval — the
 *     allowlist IS the source of truth, a pending entry is just a
 *     temporary token.
 *   - Details include `duplicate` flag, `ttl_left_ms`, `sender_id`,
 *     `chat_id`, `kind` for audit logging.
 */
export async function approvePairingByCode(
  h: SessionHandle,
  code: string,
): Promise<FeishuToolResultEnvelope> {
  if (!/^[0-9a-fA-F]{6}$/.test(code)) {
    return {
      status: 'error',
      message: 'code 必须是 6 位十六进制字符串 (0-9, a-f)',
    };
  }
  const lowerCode = code.toLowerCase();
  return h.accessMutex.lock(async () => {
    const state = await loadDispatcherAccess(h.opts.stateDir);
    const entry = state.pending[lowerCode];
    const now = Date.now();
    if (entry === undefined || entry.expires_at <= now) {
      return {
        status: 'not_found',
        message: '配对码不存在或已过期',
        details: { code: lowerCode },
      };
    }

    // Clone so we can mutate
    let next: DispatcherAccessState = {
      ...state,
      pending: { ...state.pending },
      group: { ...state.group, allow_chats: [...state.group.allow_chats] },
      allow_users: [...state.allow_users],
    };
    let duplicate = false;

    if (entry.kind === 'dm') {
      if (next.allow_users.includes(entry.sender_id)) {
        duplicate = true;
      } else {
        next.allow_users = [...next.allow_users, entry.sender_id];
      }
    } else {
      if (next.group.allow_chats.includes(entry.chat_id)) {
        duplicate = true;
      } else {
        next.group = {
          ...next.group,
          allow_chats: [...next.group.allow_chats, entry.chat_id],
        };
      }
    }

    // Always remove the pending entry (allowlist membership is the
    // durable approval; a re-approved duplicate code still consumes
    // its single-use slot — no stale tokens leaking).
    delete next.pending[lowerCode];

    await saveDispatcherAccess(h.opts.stateDir, next);

    const ttlLeftMs = Math.max(0, entry.expires_at - now);
    const who =
      entry.kind === 'dm'
        ? `用户 ${entry.sender_id}`
        : `群 ${entry.chat_id}`;
    return {
      status: 'ok',
      message: duplicate
        ? `${who} 已在允许列表，配对码已清除`
        : `已批准 ${who} 访问`,
      details: {
        duplicate,
        kind: entry.kind,
        ttl_left_ms: ttlLeftMs,
        sender_id: entry.sender_id,
        chat_id: entry.chat_id,
      },
    };
  });
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
