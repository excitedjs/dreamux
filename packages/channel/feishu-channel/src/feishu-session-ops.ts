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
import { FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER } from '@excitedjs/feishu-transport';
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
import {
  PAIRING_TOKEN_REGEX,
  loadDispatcherAccess,
  saveDispatcherAccess,
  type DispatcherAccessState,
} from './feishu-gate.js';
import { AsyncMutex } from './lib/mutex.js';
import type { FeishuChannelSessionOptions } from './feishu-channel.js';
import type { PeerBot } from './chat-bots-store.js';
import type { FeishuTargetRouter } from './feishu-target-router.js';
import {
  FeishuOperationError,
  runFeishuBoundedOperation,
} from './feishu-bounded-operation.js';
import {
  alwaysActiveSessionFence,
  type FeishuInboundWorkContext,
  type FeishuSessionFence,
} from './feishu-inbound-work.js';

// ─────────────────────────────────────────────────────────────────────────
// In-memory state & constants (mirror the class fields)
// ─────────────────────────────────────────────────────────────────────────

export const MAX_PENDING_RECEIVED_REACTION_CLEARS = 1024;
const FEISHU_REACTION_OPERATION_TIMEOUT_MS = 2_000;

/**
 * Appended to every delivered inbound's content as a standing guardrail: a
 * channel message must be answered with the channel reply tool, not a plain
 * assistant message. A separate acknowledgement is required only when work is
 * needed before the substantive answer, so immediately answerable requests get
 * one direct visible reply. Placed at the very end of the body the runtime
 * wraps into its `<channel>` block.
 */
export const CHANNEL_REMINDER =
  '<channel-reminder>Reply through the channel reply tool, never as plain assistant text. Answer now if ready; otherwise acknowledge, then report back.</channel-reminder>';

export type InboundReactionState = 'received' | 'in_progress';

export interface InboundReactionLedgerEntry {
  chatId: string;
  reactionId: string;
  state: InboundReactionState;
}

export interface FeishuChannelState {
  inboundReactions: Map<string, InboundReactionLedgerEntry>;
  pendingReceivedReactionClears: Set<string>;
}

export interface PairingApprovalResult {
  status: 'ok' | 'not_found' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

/** Opaque resource bundle a session builds for each helper call. */
export interface SessionHandle {
  opts: FeishuChannelSessionOptions;
  state: FeishuChannelState;
  bot: FeishuBot;
  accessMutex: AsyncMutex;
  botDisplayName: string;
  targetRouter: FeishuTargetRouter;
  sessionFence: FeishuSessionFence;
}

/** Build a package-private handle from a session's internal fields. */
export function sessionHandle(
  opts: FeishuChannelSessionOptions,
  state: FeishuChannelState,
  bot: FeishuBot,
  accessMutex: AsyncMutex,
  botDisplayName: string,
  targetRouter: FeishuTargetRouter,
  sessionFence: FeishuSessionFence = alwaysActiveSessionFence(),
): SessionHandle {
  return {
    opts,
    state,
    bot,
    accessMutex,
    botDisplayName,
    targetRouter,
    sessionFence,
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

function pairingTokenLogFields(token: string): Record<string, unknown> {
  return { pairing_token_len: token.length };
}

function openIdLogFields(name: string, openId: string): Record<string, unknown> {
  return { [`${name}_len`]: openId.length };
}

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
  if (
    input.mode !== 'background' &&
    input.target.replyTo !== undefined
  ) {
    await clearInboundReaction(h, input.target.replyTo);
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
  work?: FeishuInboundWorkContext,
): Promise<boolean> {
  if (messageId === '') return false;
  if (h.state.pendingReceivedReactionClears.has(messageId)) return false;
  if (!h.sessionFence.isCurrent()) return false;

  const previous = h.state.inboundReactions.get(messageId);
  let reactionId: string;
  try {
    reactionId = await runReactionOperation(
      () => h.bot.addReaction(messageId, emoji),
      work,
      (lateReactionId) =>
        removeReactionWithinTimeout(h, messageId, lateReactionId),
    );
  } catch (err) {
    log(h).warn(
      {
        dispatcher_id: h.opts.dispatcherId,
        message_id: messageId,
        err: errInfo(err),
      },
      `failed to add the ${state} reaction`,
    );
    return false;
  }
  if (reactionId === '') {
    log(h).warn(
      { dispatcher_id: h.opts.dispatcherId, message_id: messageId },
      `Feishu returned no reaction_id for the ${state} reaction`,
    );
    return false;
  }

  if (!h.sessionFence.isCurrent()) {
    try {
      await removeReactionWithinTimeout(h, messageId, reactionId);
    } catch (err) {
      log(h).warn(
        {
          dispatcher_id: h.opts.dispatcherId,
          message_id: messageId,
          err: errInfo(err),
        },
        `failed to clear the revoked ${state} reaction`,
      );
    }
    return false;
  }

  if (h.state.pendingReceivedReactionClears.has(messageId)) {
    try {
      await removeReactionWithinTimeout(h, messageId, reactionId);
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
    return false;
  }

  h.state.inboundReactions.set(messageId, { chatId, reactionId, state });

  if (previous !== undefined) {
    try {
      await removeReactionWithinTimeout(
        h,
        messageId,
        previous.reactionId,
      );
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
  return true;
}

export async function clearInboundReaction(
  h: SessionHandle,
  messageId: string,
): Promise<void> {
  rememberPendingReceivedReactionClear(h, messageId);
  const reaction = h.state.inboundReactions.get(messageId);
  if (reaction === undefined) return;
  try {
    await removeReactionWithinTimeout(h, messageId, reaction.reactionId);
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

function runReactionOperation<T>(
  operation: () => Promise<T>,
  work: FeishuInboundWorkContext | undefined,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  const deadlineAt = Math.min(
    Date.now() + FEISHU_REACTION_OPERATION_TIMEOUT_MS,
    work?.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  return runFeishuBoundedOperation({
    operation,
    deadlineAt,
    ...(work !== undefined
      ? {
          signal: work.signal,
          beforeStart: work.assertEnrichmentActive,
        }
      : {}),
    ...(onLateValue !== undefined ? { onLateValue } : {}),
  });
}

function removeReactionWithinTimeout(
  h: SessionHandle,
  messageId: string,
  reactionId: string,
): Promise<void> {
  return runFeishuBoundedOperation({
    operation: () => h.bot.removeReaction(messageId, reactionId),
    deadlineAt: Date.now() + FEISHU_REACTION_OPERATION_TIMEOUT_MS,
  });
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
// Approve pairing by token
// ─────────────────────────────────────────────────────────────────────────

/**
 * Approve a pending pairing by its internal 6-hex token.
 *
 * Behavior:
 *   - Normalizes `token` to lowercase (the gate stores lowercased tokens).
 *   - Returns `not_found` when the token is unknown or expired (we reject
 *     expired entries explicitly, not just "not found", so the operator
 *     gets the right diagnostic).
 *   - Adds the DM sender to `allow_users`. Idempotent on allowlist
 *     membership (we detect duplicates via allowlist presence, not by
 *     whether the pending entry still has the slot), and always removes
 *     the pending key after a successful approval — the
 *     allowlist IS the source of truth, a pending entry is just a
 *     temporary token.
 *   - Details include `duplicate` flag, `ttl_left_ms`, `sender_id`,
 *     `chat_id`, `kind` for audit logging.
 */
export async function approvePairingByToken(
  h: SessionHandle,
  token: string,
): Promise<PairingApprovalResult> {
  if (!PAIRING_TOKEN_REGEX.test(token)) {
    return {
      status: 'error',
      message: '授权请求格式错误',
    };
  }
  const lowerToken = token.toLowerCase();
  return h.accessMutex.lock(async () => {
    const state = await loadDispatcherAccess(h.opts.stateDir);
    const entry = state.pending[lowerToken];
    const now = Date.now();
    if (entry === undefined || entry.expires_at <= now) {
      return {
        status: 'not_found',
        message: '授权请求不存在或已过期',
        details: { token: lowerToken },
      };
    }

    if (entry.kind !== 'dm') {
      return {
        status: 'error',
        message: '授权请求类型已不再支持',
        details: { token: lowerToken, kind: entry.kind },
      };
    }

    // Clone so we can mutate
    const next: DispatcherAccessState = {
      ...state,
      pending: { ...state.pending },
      allow_users: [...state.allow_users],
    };
    let duplicate = false;

    if (next.allow_users.includes(entry.sender_id)) {
      duplicate = true;
    } else {
      next.allow_users = [...next.allow_users, entry.sender_id];
    }

    // Always remove the pending entry (allowlist membership is the
    // durable approval; a re-approved duplicate token still consumes
    // its single-use slot).
    delete next.pending[lowerToken];

    try {
      await saveDispatcherAccess(h.opts.stateDir, next);
    } catch (err) {
      log(h).error(
        {
          dispatcher_id: h.opts.dispatcherId,
          ...pairingTokenLogFields(lowerToken),
          sender_id: entry.sender_id,
          chat_id: entry.chat_id,
          err: errInfo(err),
        },
        '[card-action] failed to persist pairing approval',
      );
      return {
        status: 'error',
        message: '授权写入失败，请重试',
        details: { token: lowerToken },
      };
    }

    const ttlLeftMs = Math.max(0, entry.expires_at - now);
    const who = `用户 ${entry.sender_id}`;
    return {
      status: 'ok',
      message: duplicate
        ? `${who} 已在允许列表，授权请求已关闭`
        : `已批准 ${who} 访问`,
      details: {
        duplicate,
        kind: 'dm',
        ttl_left_ms: ttlLeftMs,
        sender_id: entry.sender_id,
        chat_id: entry.chat_id,
      },
    };
  });
}

export async function handleCardAction(
  h: SessionHandle,
  event: FeishuCardActionEvent,
): Promise<FeishuCardActionResponse | Record<string, never>> {
  const action = String(event.actionValue[DREAMUX_ACTION_KEY] ?? '');
  if (action !== DREAMUX_PAIRING_CARD_ACTION) return {};

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

  const result = await approvePairingByToken(h, token);
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
